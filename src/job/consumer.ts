import { createHash } from "node:crypto";
import objectStore from "@forge/object-store";
import { ExportCancelled, ExportFailed } from "./errors";
import { getJob, isCancellationRequested, patchJob } from "./jobStore";
import { run } from "./pipeline";

const ARCHIVE_TTL_SECONDS = 24 * 60 * 60;

export interface ExportQueueEvent {
  body: { accountId: string; jobId: string };
}

export async function exportConsumer(event: ExportQueueEvent): Promise<void> {
  const { accountId, jobId } = event.body;

  const job = await getJob(accountId, jobId);
  if (!job) {
    console.warn(`Export job ${jobId} for ${accountId} not found; skipping.`);
    return;
  }

  await patchJob(accountId, jobId, { status: "running" });

  try {
    const { zipBuffer, exportedCount, skipped } = await run(
      { rootId: job.rootId, depth: job.depth, bundleSlug: job.bundleSlug },
      {
        onProgress: (patch) => {
          patchJob(accountId, jobId, patch);
        },
        isCancelled: () => isCancellationRequested(accountId, jobId),
      },
    );

    const checksum = createHash("sha256").update(zipBuffer).digest("base64");
    const archiveKey = `exports/${accountId}/${jobId}/${job.bundleSlug}.zip`;
    const uploadUrl = await objectStore.createUploadUrl({
      key: archiveKey,
      length: zipBuffer.length,
      checksum,
      checksumType: "SHA256",
      ttlSeconds: ARCHIVE_TTL_SECONDS,
      overwrite: true,
    });
    if (!uploadUrl) {
      throw new ExportFailed("Could not create an archive upload URL.");
    }

    const uploadResponse = await fetch(uploadUrl.url, {
      method: "PUT",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(zipBuffer),
    });
    if (!uploadResponse.ok) {
      throw new ExportFailed(
        `Archive upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
      );
    }

    await patchJob(accountId, jobId, {
      status: "ready",
      stage: "ready",
      archiveKey,
      exportedCount,
      skipped,
    });
  } catch (exc) {
    if (exc instanceof ExportCancelled) {
      await patchJob(accountId, jobId, {
        status: "cancelled",
        stage: "cancelled",
      });
      return;
    }
    const message =
      exc instanceof ExportFailed
        ? exc.message
        : `Unexpected error: ${(exc as Error).message}`;
    console.error(`Export job ${jobId} for ${accountId} failed:`, exc);
    await patchJob(accountId, jobId, {
      status: "failed",
      stage: "failed",
      errorMessage: message,
    });
  }
}
