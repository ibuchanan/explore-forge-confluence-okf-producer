import { kvs } from "@forge/kvs";
import { ok, type ProblemDetails, ResultAsync } from "@forge-ahead/errors";
import { exportFailed } from "./errors";
import type { ExportJob, ExportJobInput } from "./types";

function jobKey(accountId: string, jobId: string): string {
  return `export-job:${accountId}:${jobId}`;
}

function latestJobKey(accountId: string): string {
  return `export-latest-job:${accountId}`;
}

function kvsSet(
  key: string,
  value: unknown,
): ResultAsync<void, ProblemDetails> {
  return ResultAsync.fromPromise(kvs.set(key, value), (exc) =>
    exportFailed(
      `Failed to write ${key}: ${(exc as Error).message}`,
    )._unsafeUnwrapErr(),
  );
}

export function createJob(
  accountId: string,
  jobId: string,
  input: ExportJobInput,
): ResultAsync<ExportJob, ProblemDetails> {
  const now = new Date().toISOString();
  const job: ExportJob = {
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
  return kvsSet(jobKey(accountId, jobId), job).map(() => job);
}

export function getJob(
  accountId: string,
  jobId: string,
): ResultAsync<ExportJob | undefined, ProblemDetails> {
  const key = jobKey(accountId, jobId);
  return ResultAsync.fromPromise(
    kvs.get(key) as Promise<ExportJob | undefined>,
    (exc) =>
      exportFailed(
        `Failed to read ${key}: ${(exc as Error).message}`,
      )._unsafeUnwrapErr(),
  );
}

export function patchJob(
  accountId: string,
  jobId: string,
  patch: Partial<ExportJob>,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return getJob(accountId, jobId).andThen((existing) => {
    if (!existing) {
      return ok(null);
    }
    const updated: ExportJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return kvsSet(jobKey(accountId, jobId), updated).map(() => updated);
  });
}

export function requestCancellation(
  accountId: string,
  jobId: string,
): ResultAsync<ExportJob | null, ProblemDetails> {
  return patchJob(accountId, jobId, { cancelRequested: true });
}

export function isCancellationRequested(
  accountId: string,
  jobId: string,
): ResultAsync<boolean, ProblemDetails> {
  return getJob(accountId, jobId).map((job) => Boolean(job?.cancelRequested));
}

// Points at the account's most recent export job so the Execution UI can
// resume showing it after a navigation/remount. Not export history -- just
// one pointer, overwritten by each new job (see spec: no durable history).
export function setLatestJobId(
  accountId: string,
  jobId: string,
): ResultAsync<void, ProblemDetails> {
  return kvsSet(latestJobKey(accountId), jobId);
}

export function getLatestJobId(
  accountId: string,
): ResultAsync<string | undefined, ProblemDetails> {
  const key = latestJobKey(accountId);
  return ResultAsync.fromPromise(
    kvs.get(key) as Promise<string | undefined>,
    (exc) =>
      exportFailed(
        `Failed to read ${key}: ${(exc as Error).message}`,
      )._unsafeUnwrapErr(),
  );
}

export function clearLatestJobId(
  accountId: string,
): ResultAsync<void, ProblemDetails> {
  const key = latestJobKey(accountId);
  return ResultAsync.fromPromise(kvs.delete(key), (exc) =>
    exportFailed(
      `Failed to delete ${key}: ${(exc as Error).message}`,
    )._unsafeUnwrapErr(),
  );
}
