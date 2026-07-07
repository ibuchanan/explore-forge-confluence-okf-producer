import { randomUUID } from "node:crypto";
import { Queue } from "@forge/events";
import objectStore from "@forge/object-store";
import type Resolver from "@forge/resolver";
import { resolvePersonalSpaceHomepage } from "../job/confluenceClient";
import {
  createJob,
  getJob,
  patchJob,
  requestCancellation,
} from "../job/jobStore";
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

      const jobId = randomUUID();
      await createJob(context.accountId, jobId, {
        rootUrl,
        rootId,
        depth,
        bundleSlug,
      });
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
      const job = await getJob(context.accountId, payload?.jobId ?? "");
      if (!job) {
        return { error: "Job not found." };
      }
      return job;
    },
  );

  resolver.define<JobIdPayload>(
    "cancelExportJob",
    async ({ payload, context }) => {
      const job = await requestCancellation(
        context.accountId,
        payload?.jobId ?? "",
      );
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
      const job = await getJob(context.accountId, payload?.jobId ?? "");
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
}
