import { kvs } from "@forge/kvs";
import type { ExportJob, ExportJobInput } from "./types";

function jobKey(accountId: string, jobId: string): string {
  return `export-job:${accountId}:${jobId}`;
}

function latestJobKey(accountId: string): string {
  return `export-latest-job:${accountId}`;
}

export async function createJob(
  accountId: string,
  jobId: string,
  input: ExportJobInput,
): Promise<ExportJob> {
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
  await kvs.set(jobKey(accountId, jobId), job);
  return job;
}

export async function getJob(
  accountId: string,
  jobId: string,
): Promise<ExportJob | undefined> {
  return (await kvs.get(jobKey(accountId, jobId))) as ExportJob | undefined;
}

export async function patchJob(
  accountId: string,
  jobId: string,
  patch: Partial<ExportJob>,
): Promise<ExportJob | null> {
  const existing = await getJob(accountId, jobId);
  if (!existing) {
    return null;
  }
  const updated: ExportJob = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await kvs.set(jobKey(accountId, jobId), updated);
  return updated;
}

export async function requestCancellation(
  accountId: string,
  jobId: string,
): Promise<ExportJob | null> {
  return patchJob(accountId, jobId, { cancelRequested: true });
}

export async function isCancellationRequested(
  accountId: string,
  jobId: string,
): Promise<boolean> {
  const job = await getJob(accountId, jobId);
  return Boolean(job?.cancelRequested);
}

// Points at the account's most recent export job so the Execution UI can
// resume showing it after a navigation/remount. Not export history -- just
// one pointer, overwritten by each new job (see spec: no durable history).
export async function setLatestJobId(
  accountId: string,
  jobId: string,
): Promise<void> {
  await kvs.set(latestJobKey(accountId), jobId);
}

export async function getLatestJobId(
  accountId: string,
): Promise<string | undefined> {
  return (await kvs.get(latestJobKey(accountId))) as string | undefined;
}

export async function clearLatestJobId(accountId: string): Promise<void> {
  await kvs.delete(latestJobKey(accountId));
}
