import { randomUUID } from "node:crypto";
import { Queue } from "@forge/events";
import objectStore from "@forge/object-store";
import type Resolver from "@forge/resolver";
import { createForgeLogger } from "@forge-ahead/logging";
import {
  getDescendantIds,
  getPage,
  resolvePersonalSpaceHomepage,
} from "../job/confluenceClient";
import {
  startExportJobIntake,
  type ExportJobIntakeAdapters,
} from "../job/exportJobIntake";
import {
  clearLatestJobId,
  createJob,
  getJob,
  getLatestJobId,
  patchJob,
  requestCancellation,
  setLatestJobId,
} from "../job/jobStore";
import type { ExportJob } from "../job/types";
import { asForgeResolverContext } from "../util/forgeContext";

const exportQueue = new Queue({ key: "okf-export" });
const logger = createForgeLogger({ name: "resolvers/export" });

const exportJobIntakeAdapters: ExportJobIntakeAdapters = {
  createJobId: randomUUID,
  readSourcePageAsUser: async (pageId) => await getPage("user", pageId),
  readSourcePageAsApp: async (pageId) => await getPage("app", pageId),
  enumerateDescendantSourcePages: async (rootId, depth, hooks) =>
    await getDescendantIds(rootId, depth, hooks),
  createExportJob: async (accountId, jobId, input) =>
    await createJob(accountId, jobId, input),
  recordSkippedBranches: async (accountId, jobId, skipped) =>
    await patchJob(accountId, jobId, { skipped }),
  recordLatestExportJob: async (accountId, jobId) =>
    await setLatestJobId(accountId, jobId),
  scheduleExportJob: async (accountId, jobId) => {
    const { jobId: queueJobId } = await exportQueue.push({
      body: { accountId, jobId },
    });
    return { queueJobId };
  },
  attachQueueJob: async (accountId, jobId, queueJobId) =>
    await patchJob(accountId, jobId, { queueJobId }),
};

interface StartExportJobPayload {
  rootUrl?: string;
  depth?: number;
  bundleSlug?: string;
}

interface JobIdPayload {
  jobId?: string;
}

type ResolverError = { error: string };

type JobLookupResult =
  | { ok: true; job: ExportJob | undefined }
  | { ok: false; error: string };

async function loadJobForResolver({
  payload,
  context,
}: {
  payload: JobIdPayload | undefined;
  context: unknown;
}): Promise<JobLookupResult> {
  const { accountId } = asForgeResolverContext(context);
  const jobResult = await getJob(accountId, payload?.jobId ?? "");
  if (jobResult.isErr()) {
    return { ok: false, error: jobResult.error.detail };
  }
  return { ok: true, job: jobResult.value };
}

function defineJobResolver<Result>(
  handleJob: (job: ExportJob | undefined) => Result | Promise<Result>,
): (args: {
  payload: JobIdPayload | undefined;
  context: unknown;
}) => Promise<Result | ResolverError> {
  return async ({ payload, context }) => {
    const lookup = await loadJobForResolver({ payload, context });
    if (!lookup.ok) {
      return { error: lookup.error };
    }
    return handleJob(lookup.job);
  };
}

export function registerExportResolvers(resolver: Resolver): void {
  resolver.define("getDefaultSource", async ({ context }) => {
    const { accountId } = asForgeResolverContext(context);
    const rootUrl = await resolvePersonalSpaceHomepage(accountId);
    return { rootUrl };
  });

  resolver.define<StartExportJobPayload>(
    "startExportJob",
    async ({ payload, context }) => {
      const { accountId, siteUrl } = asForgeResolverContext(context);
      const result = await startExportJobIntake(
        {
          accountId,
          siteUrl,
          rootUrl: payload?.rootUrl,
          depth: payload?.depth,
          bundleSlug: payload?.bundleSlug,
        },
        exportJobIntakeAdapters,
      );
      if (result.isErr()) {
        return {
          error: result.error.detail,
        };
      }
      return {
        jobId: result.value.jobId,
      };
    },
  );

  resolver.define<JobIdPayload>(
    "getExportJob",
    defineJobResolver((job) => {
      if (!job) {
        return { error: "Job not found." };
      }
      return job;
    }),
  );

  resolver.define<JobIdPayload>(
    "cancelExportJob",
    async ({ payload, context }) => {
      const { accountId } = asForgeResolverContext(context);
      const cancelResult = await requestCancellation(
        accountId,
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
          logger.child({ queueJobId: job.queueJobId }).errorResult(exc, {
            message: "Could not cancel queue job.",
            level: "warn",
          });
        }
      }
      return job;
    },
  );

  resolver.define<JobIdPayload>(
    "createArchiveDownloadUrl",
    defineJobResolver(async (job) => {
      if (job?.status !== "ready" || !job.archiveKey) {
        return { error: "Archive is not ready." };
      }
      const result = await objectStore.createDownloadUrl(job.archiveKey);
      if (!result) {
        return { error: "Could not create a download URL." };
      }
      return { url: result.url };
    }),
  );

  // Lets the Execution UI rediscover an in-flight or recently-finished job
  // after a navigation/remount, instead of always starting from a blank
  // form. Not export history -- just the one most recent job per account.
  resolver.define("getActiveExportJob", async ({ context }) => {
    const { accountId } = asForgeResolverContext(context);
    const latestIdResult = await getLatestJobId(accountId);
    const latestJobId = latestIdResult.isOk()
      ? latestIdResult.value
      : undefined;
    if (!latestJobId) {
      return { job: null };
    }
    const jobResult = await getJob(accountId, latestJobId);
    const job = jobResult.isOk() ? jobResult.value : undefined;
    return { job: job ?? null };
  });

  resolver.define("clearActiveExportJob", async ({ context }) => {
    const { accountId } = asForgeResolverContext(context);
    await clearLatestJobId(accountId);
    return { ok: true };
  });
}
