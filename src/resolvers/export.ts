import { randomUUID } from "node:crypto";
import { Queue } from "@forge/events";
import objectStore from "@forge/object-store";
import type Resolver from "@forge/resolver";
import {
  getDescendantIds,
  getPage,
  resolvePersonalSpaceHomepage,
} from "../job/confluenceClient";
import {
  clearLatestJobId,
  createJob,
  getJob,
  getLatestJobId,
  patchJob,
  requestCancellation,
  setLatestJobId,
} from "../job/jobStore";
import type { SkippedPage } from "../job/types";
import { deriveSlugFromUrl, isSameSite, parsePageId } from "../util/pageUrl";

const MAX_DEPTH = 5;
const exportQueue = new Queue({ key: "okf-export" });

interface StartExportJobPayload {
  rootUrl?: string;
  depth?: number;
  bundleSlug?: string;
}

interface JobIdPayload {
  jobId?: string;
}

export function registerExportResolvers(resolver: Resolver): void {
  resolver.define("getDefaultSource", async ({ context }) => {
    const rootUrl = await resolvePersonalSpaceHomepage(context.accountId);
    return { rootUrl };
  });

  resolver.define<StartExportJobPayload>(
    "startExportJob",
    async ({ payload, context }) => {
      const rootUrl = String(payload?.rootUrl ?? "").trim();
      if (!rootUrl) {
        return { error: "A root page URL is required." };
      }
      if (!isSameSite(rootUrl, context.siteUrl)) {
        return { error: "The root page URL must be on this site." };
      }
      const rootId = parsePageId(rootUrl);
      if (!rootId) {
        return { error: "Could not find a page ID in that URL." };
      }

      const requestedDepth = Number(payload?.depth);
      const depth = Number.isFinite(requestedDepth)
        ? Math.min(Math.max(requestedDepth, 1), MAX_DEPTH)
        : MAX_DEPTH;

      const bundleSlug =
        String(payload?.bundleSlug ?? "").trim() || deriveSlugFromUrl(rootUrl);

      // Root-page validation and descendant enumeration run as the user,
      // synchronously, here -- not in the async queue consumer, which has
      // no user auth context to read with. This is also the last point at
      // which the export's page set is scoped to what the current user can
      // see; the consumer only ever fetches content for this pre-vetted list.
      const userReadResult = await getPage("user", rootId);
      if (userReadResult.isErr()) {
        return {
          error: `Root page read failed: ${userReadResult.error.detail}`,
        };
      }
      // The async consumer fetches content asApp(), not asUser() (see
      // job/pipeline.ts) -- confirm the app can actually read the root page
      // now, synchronously, rather than letting the job fail deep in the
      // async phase for a permission gap between the two auth modes.
      const appReadResult = await getPage("app", rootId);
      if (appReadResult.isErr()) {
        // Confluence typically returns 404 rather than 403 for content a
        // requester can't see, to avoid revealing that it exists -- so a
        // read that succeeds asUser() but fails asApp() here almost always
        // means the page's space has view restrictions that don't extend to
        // the app's own service-account identity. No manifest scope closes
        // this gap; it needs a Confluence-side permission change.
        return {
          error:
            "This page's space likely has view restrictions that don't include this app. " +
            "Ask a site or space admin to grant the app access, or choose a root page from " +
            `a space without view restrictions. (Root page read as the app failed: ${appReadResult.error.detail})`,
        };
      }

      const enumerationSkipped: SkippedPage[] = [];
      const descendantsResult = await getDescendantIds(rootId, depth, {
        onSkippedBranch: (pageId, problem) => {
          enumerationSkipped.push({
            id: pageId,
            title: null,
            reason: problem.detail,
          });
        },
      });
      if (descendantsResult.isErr()) {
        return {
          error: `Descendant listing failed: ${descendantsResult.error.detail}`,
        };
      }
      const descendantIds = descendantsResult.value;

      const jobId = randomUUID();
      const jobResult = await createJob(context.accountId, jobId, {
        rootUrl,
        rootId,
        depth,
        bundleSlug,
        pageIds: [rootId, ...descendantIds],
      });
      if (jobResult.isErr()) {
        return {
          error: `Could not create the export job: ${jobResult.error.detail}`,
        };
      }
      if (enumerationSkipped.length > 0) {
        await patchJob(context.accountId, jobId, {
          skipped: enumerationSkipped,
        });
      }
      // So the Execution UI can find this job again after a navigation or
      // remount -- see getActiveExportJob below.
      await setLatestJobId(context.accountId, jobId);
      const { jobId: queueJobId } = await exportQueue.push({
        body: { accountId: context.accountId, jobId },
      });
      await patchJob(context.accountId, jobId, { queueJobId });

      return { jobId };
    },
  );

  resolver.define<JobIdPayload>(
    "getExportJob",
    async ({ payload, context }) => {
      const jobResult = await getJob(context.accountId, payload?.jobId ?? "");
      if (jobResult.isErr()) {
        return { error: jobResult.error.detail };
      }
      if (!jobResult.value) {
        return { error: "Job not found." };
      }
      return jobResult.value;
    },
  );

  resolver.define<JobIdPayload>(
    "cancelExportJob",
    async ({ payload, context }) => {
      const cancelResult = await requestCancellation(
        context.accountId,
        payload?.jobId ?? "",
      );
      if (cancelResult.isErr()) {
        return { error: cancelResult.error.detail };
      }
      const job = cancelResult.value;
      if (!job) {
        return { error: "Job not found." };
      }
      // Best-effort: stops the queue event if it hasn't started running yet. For a
      // job that's already executing in job/consumer.ts, the cancelRequested flag
      // set by requestCancellation above is what actually stops it.
      if (job.queueJobId) {
        try {
          await exportQueue.getJob(job.queueJobId).cancel();
        } catch (exc) {
          console.warn(`Could not cancel queue job ${job.queueJobId}:`, exc);
        }
      }
      return job;
    },
  );

  resolver.define<JobIdPayload>(
    "createArchiveDownloadUrl",
    async ({ payload, context }) => {
      const jobResult = await getJob(context.accountId, payload?.jobId ?? "");
      if (jobResult.isErr()) {
        return { error: jobResult.error.detail };
      }
      const job = jobResult.value;
      if (job?.status !== "ready" || !job.archiveKey) {
        return { error: "Archive is not ready." };
      }
      const result = await objectStore.createDownloadUrl(job.archiveKey);
      if (!result) {
        return { error: "Could not create a download URL." };
      }
      return { url: result.url };
    },
  );

  // Lets the Execution UI rediscover an in-flight or recently-finished job
  // after a navigation/remount, instead of always starting from a blank
  // form. Not export history -- just the one most recent job per account.
  resolver.define("getActiveExportJob", async ({ context }) => {
    const latestIdResult = await getLatestJobId(context.accountId);
    const latestJobId = latestIdResult.isOk()
      ? latestIdResult.value
      : undefined;
    if (!latestJobId) {
      return { job: null };
    }
    const jobResult = await getJob(context.accountId, latestJobId);
    const job = jobResult.isOk() ? jobResult.value : undefined;
    return { job: job ?? null };
  });

  resolver.define("clearActiveExportJob", async ({ context }) => {
    await clearLatestJobId(context.accountId);
    return { ok: true };
  });
}
