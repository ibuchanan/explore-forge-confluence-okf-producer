import { createHash } from "node:crypto";
import objectStore from "@forge/object-store";
import { ok, type ProblemDetails, ResultAsync } from "@forge-ahead/errors";
import { exportFailed, isCancelled } from "./errors";
import { getJob, isCancellationRequested, patchJob } from "./jobStore";
import type { PipelineResult } from "./pipeline";
import { run } from "./pipeline";
import type { ExportJob, SkippedPage } from "./types";

const ARCHIVE_TTL_SECONDS = 24 * 60 * 60;

export interface ExportQueueEvent {
  body: { accountId: string; jobId: string };
}

interface UploadedArchive {
  archiveKey: string;
  exportedCount: number;
  skipped: SkippedPage[];
}

function uploadArchive(
  accountId: string,
  jobId: string,
  job: ExportJob,
  pipeline: PipelineResult,
): ResultAsync<UploadedArchive, ProblemDetails> {
  const { zipBuffer, exportedCount, skipped } = pipeline;
  const checksum = createHash("sha256").update(zipBuffer).digest("base64");
  const archiveKey = `exports/${accountId}/${jobId}/${job.bundleSlug}.zip`;

  return ResultAsync.fromPromise(
    objectStore.createUploadUrl({
      key: archiveKey,
      length: zipBuffer.length,
      checksum,
      checksumType: "SHA256",
      ttlSeconds: ARCHIVE_TTL_SECONDS,
      overwrite: true,
    }),
    (exc) =>
      exportFailed(
        `Could not create an archive upload URL: ${(exc as Error).message}`,
      )._unsafeUnwrapErr(),
  ).andThen((uploadUrl) => {
    if (!uploadUrl) {
      return exportFailed("Could not create an archive upload URL.");
    }
    return ResultAsync.fromPromise(
      fetch(uploadUrl.url, {
        method: "PUT",
        headers: { "content-type": "application/zip" },
        body: new Uint8Array(zipBuffer),
      }),
      (exc) =>
        exportFailed(
          `Archive upload failed: ${(exc as Error).message}`,
        )._unsafeUnwrapErr(),
    ).andThen((uploadResponse) => {
      if (!uploadResponse.ok) {
        return exportFailed(
          `Archive upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
        );
      }
      return ok({ archiveKey, exportedCount, skipped });
    });
  });
}

export async function exportConsumer(event: ExportQueueEvent): Promise<void> {
  const { accountId, jobId } = event.body;

  const jobResult = await getJob(accountId, jobId);
  const job = jobResult.isOk() ? jobResult.value : undefined;
  if (!job) {
    console.warn(`Export job ${jobId} for ${accountId} not found; skipping.`);
    return;
  }

  await patchJob(accountId, jobId, { status: "running" });

  const pipelineResult = await run(
    {
      pageIds: job.pageIds,
      rootId: job.rootId,
      depth: job.depth,
      bundleSlug: job.bundleSlug,
      initialSkipped: job.skipped,
    },
    {
      onProgress: (patch) => {
        patchJob(accountId, jobId, patch);
      },
      isCancelled: async () => {
        const cancelResult = await isCancellationRequested(accountId, jobId);
        return cancelResult.isOk() ? cancelResult.value : false;
      },
    },
  );

  const outcome = await pipelineResult.asyncAndThen((pipeline) =>
    uploadArchive(accountId, jobId, job, pipeline),
  );

  await outcome.match(
    async (uploaded) => {
      await patchJob(accountId, jobId, {
        status: "ready",
        stage: "ready",
        ...uploaded,
      });
    },
    async (problem) => {
      if (isCancelled(problem)) {
        await patchJob(accountId, jobId, {
          status: "cancelled",
          stage: "cancelled",
        });
        return;
      }
      console.error(`Export job ${jobId} for ${accountId} failed:`, problem);
      await patchJob(accountId, jobId, {
        status: "failed",
        stage: "failed",
        errorMessage: problem.detail,
      });
    },
  );
}
