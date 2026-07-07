import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getJob,
  isCancellationRequested,
  patchJob,
} from "../../src/job/jobStore";
import { run } from "../../src/job/pipeline";
import type { ExportJob } from "../../src/job/types";

const createUploadUrl = vi.fn();

vi.mock("../../src/job/jobStore", () => ({
  getJob: vi.fn(),
  patchJob: vi.fn(),
  isCancellationRequested: vi.fn(),
}));
vi.mock("../../src/job/pipeline", () => ({ run: vi.fn() }));
vi.mock("@forge/object-store", () => ({
  default: { createUploadUrl },
}));

const baseJob: ExportJob = {
  jobId: "job-1",
  accountId: "account-1",
  bundleSlug: "root",
  rootId: "1",
  rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
  depth: 5,
  status: "queued",
  stage: "validating",
  exportedCount: 0,
  skipped: [],
  warnings: [],
  errorMessage: null,
  archiveKey: null,
  queueJobId: null,
  cancelRequested: false,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(getJob).mockReset().mockResolvedValue(baseJob);
  vi.mocked(patchJob).mockReset().mockResolvedValue(baseJob);
  vi.mocked(run).mockReset();
  vi.mocked(isCancellationRequested).mockReset().mockResolvedValue(false);
  createUploadUrl
    .mockReset()
    .mockResolvedValue({ url: "https://upload.example.com/presigned" });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportConsumer", () => {
  it("uploads the archive and marks the job ready on success", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    vi.mocked(run).mockResolvedValue({
      zipBuffer: Buffer.from("zip-bytes"),
      exportedCount: 3,
      skipped: [],
    });

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(patchJob).toHaveBeenCalledWith("account-1", "job-1", {
      status: "running",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://upload.example.com/presigned",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(patchJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      expect.objectContaining({
        status: "ready",
        stage: "ready",
        exportedCount: 3,
      }),
    );
  });

  it("marks the job cancelled without uploading when the pipeline is cancelled", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    const { ExportCancelled } = await import("../../src/job/errors");
    vi.mocked(run).mockRejectedValue(new ExportCancelled());

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(patchJob).toHaveBeenCalledWith("account-1", "job-1", {
      status: "cancelled",
      stage: "cancelled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks the job failed with the error message when the pipeline throws", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    const { ExportFailed } = await import("../../src/job/errors");
    vi.mocked(run).mockRejectedValue(
      new ExportFailed("Root page read failed: 403 Forbidden"),
    );

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(patchJob).toHaveBeenCalledWith("account-1", "job-1", {
      status: "failed",
      stage: "failed",
      errorMessage: "Root page read failed: 403 Forbidden",
    });
  });

  it("does nothing when the job record is missing", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    vi.mocked(getJob).mockResolvedValue(undefined);

    await exportConsumer({
      body: { accountId: "account-1", jobId: "missing" },
    });

    expect(patchJob).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
