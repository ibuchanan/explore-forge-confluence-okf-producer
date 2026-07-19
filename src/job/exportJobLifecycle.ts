import { ok, type ProblemDetails, type ResultAsync } from "@forge-ahead/errors";
import { getJob, saveJob } from "./jobStore";
import type {
  ExportJob,
  ExportJobInput,
  ExportJobProgress,
  JobStatus,
  SkippedPage,
} from "./types";

interface ReadyArchive {
  archiveKey: string;
  exportedCount: number;
  skipped: SkippedPage[];
}

type ExportJobTransition =
  | { type: "attach-queue-job"; queueJobId: string }
  | { type: "record-skipped-branches"; skipped: SkippedPage[] }
  | { type: "mark-running" }
  | { type: "record-progress"; progress: ExportJobProgress }
  | { type: "request-cancellation" }
  | ({ type: "mark-ready" } & ReadyArchive)
  | { type: "mark-failed"; errorMessage: string }
  | { type: "mark-cancelled" };

const TERMINAL_STATUSES = new Set<JobStatus>(["ready", "failed", "cancelled"]);

function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled export job transition: ${JSON.stringify(value)}`);
}

function createQueuedJob(
  accountId: string,
  jobId: string,
  input: ExportJobInput,
  now: string,
): ExportJob {
  return {
    jobId,
    accountId,
    status: "queued",
    stage: "fetching-pages",
    rootUrl: input.rootUrl,
    rootId: input.rootId,
    depth: input.depth,
    bundleSlug: input.bundleSlug,
    pageIds: input.pageIds,
    exportedCount: 0,
    skipped: [],
    warnings: [],
    errorMessage: null,
    archiveKey: null,
    queueJobId: null,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
  };
}

function transitionExportJob(
  job: ExportJob,
  transition: ExportJobTransition,
  now: string,
): ExportJob {
  if (isTerminal(job.status)) {
    return job;
  }

  return transitionActiveExportJob(job, transition, now);
}

function transitionActiveExportJob(
  job: ExportJob,
  transition: ExportJobTransition,
  now: string,
): ExportJob {
  switch (transition.type) {
    case "attach-queue-job":
      return attachQueueJobToActiveJob(job, transition.queueJobId, now);
    case "record-skipped-branches":
      return { ...job, skipped: transition.skipped, updatedAt: now };
    case "mark-running":
      return markActiveJobRunning(job, now);
    case "record-progress":
      return { ...job, ...transition.progress, updatedAt: now };
    case "request-cancellation":
      return requestActiveJobCancellation(job, now);
    case "mark-ready":
      return markActiveJobReady(job, transition, now);
    case "mark-failed":
      return markActiveJobFailed(job, transition.errorMessage, now);
    case "mark-cancelled":
      return markActiveJobCancelled(job, now);
    default:
      return assertNever(transition);
  }
}

function attachQueueJobToActiveJob(
  job: ExportJob,
  queueJobId: string,
  now: string,
): ExportJob {
  if (job.queueJobId === queueJobId) {
    return job;
  }
  return { ...job, queueJobId, updatedAt: now };
}

function markActiveJobRunning(job: ExportJob, now: string): ExportJob {
  if (job.status === "running") {
    return job;
  }
  return { ...job, status: "running", updatedAt: now };
}

function requestActiveJobCancellation(job: ExportJob, now: string): ExportJob {
  if (job.cancelRequested) {
    return job;
  }
  return { ...job, cancelRequested: true, updatedAt: now };
}

function markActiveJobReady(
  job: ExportJob,
  archive: ReadyArchive,
  now: string,
): ExportJob {
  return {
    ...job,
    status: "ready",
    stage: "ready",
    archiveKey: archive.archiveKey,
    exportedCount: archive.exportedCount,
    skipped: archive.skipped,
    errorMessage: null,
    updatedAt: now,
  };
}

function markActiveJobFailed(
  job: ExportJob,
  errorMessage: string,
  now: string,
): ExportJob {
  return {
    ...job,
    status: "failed",
    stage: "failed",
    errorMessage,
    updatedAt: now,
  };
}

function markActiveJobCancelled(job: ExportJob, now: string): ExportJob {
  return {
    ...job,
    status: "cancelled",
    stage: "cancelled",
    updatedAt: now,
  };
}

function applyExistingJobTransition(
  accountId: string,
  jobId: string,
  transition: ExportJobTransition,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return getJob(accountId, jobId).andThen((job) => {
    if (!job) {
      return ok(null);
    }

    const updated = transitionExportJob(
      job,
      transition,
      new Date().toISOString(),
    );
    if (updated === job) {
      return ok(job);
    }
    return saveJob(updated);
  });
}

export function createQueuedExportJob(
  accountId: string,
  jobId: string,
  input: ExportJobInput,
): ResultAsync<ExportJob, ProblemDetails> {
  return saveJob(
    createQueuedJob(accountId, jobId, input, new Date().toISOString()),
  );
}

export function recordSkippedBranches(
  accountId: string,
  jobId: string,
  skipped: SkippedPage[],
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "record-skipped-branches",
    skipped,
  });
}

export function attachQueueJob(
  accountId: string,
  jobId: string,
  queueJobId: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "attach-queue-job",
    queueJobId,
  });
}

export function markRunning(
  accountId: string,
  jobId: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "mark-running",
  });
}

export function recordProgress(
  accountId: string,
  jobId: string,
  progress: ExportJobProgress,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "record-progress",
    progress,
  });
}

export function requestCancellation(
  accountId: string,
  jobId: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "request-cancellation",
  });
}

export function isCancellationRequested(
  accountId: string,
  jobId: string,
): ResultAsync<boolean, ProblemDetails> {
  return getJob(accountId, jobId).map((job) => Boolean(job?.cancelRequested));
}

export function markReady(
  accountId: string,
  jobId: string,
  archive: ReadyArchive,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "mark-ready",
    ...archive,
  });
}

export function markFailed(
  accountId: string,
  jobId: string,
  errorMessage: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "mark-failed",
    errorMessage,
  });
}

export function markCancelled(
  accountId: string,
  jobId: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return applyExistingJobTransition(accountId, jobId, {
    type: "mark-cancelled",
  });
}
