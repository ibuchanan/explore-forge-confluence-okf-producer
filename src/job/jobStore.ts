import { kvs } from "@forge/kvs";
import { type ProblemDetails, ResultAsync } from "@forge-ahead/errors";
import { exportFailed } from "./errors";
import type { ExportJob } from "./types";

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

export function saveJob(
  job: ExportJob,
): ResultAsync<ExportJob, ProblemDetails> {
  return kvsSet(jobKey(job.accountId, job.jobId), job).map(() => job);
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
