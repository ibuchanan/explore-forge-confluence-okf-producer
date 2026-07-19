import { ok } from "@forge-ahead/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCancellationRequested,
  markCancelled,
  markFailed,
  markReady,
  markRunning,
  recordProgress,
} from "../../src/job/exportJobLifecycle";
import { getJob } from "../../src/job/jobStore";
import { run } from "../../src/job/pipeline";
import type { ExportJob } from "../../src/job/types";

const createUploadUrl = vi.fn();
const forgeFetch = vi.fn();

vi.mock("@forge/api", () => ({
  fetch: forgeFetch,
}));
vi.mock("../../src/job/jobStore", () => ({
  getJob: vi.fn(),
}));
vi.mock("../../src/job/exportJobLifecycle", () => ({
  markRunning: vi.fn(),
  recordProgress: vi.fn(),
  isCancellationRequested: vi.fn(),
  markReady: vi.fn(),
  markCancelled: vi.fn(),
  markFailed: vi.fn(),
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
  pageIds: ["1", "2"],
  status: "queued",
  stage: "fetching-pages",
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
  vi.mocked(getJob).mockReset().mockResolvedValue(ok(baseJob));
  vi.mocked(markRunning).mockReset().mockResolvedValue(ok(baseJob));
  vi.mocked(recordProgress).mockReset().mockResolvedValue(ok(baseJob));
  vi.mocked(run).mockReset();
  vi.mocked(isCancellationRequested).mockReset().mockResolvedValue(ok(false));
  vi.mocked(markReady).mockReset().mockResolvedValue(ok(baseJob));
  vi.mocked(markCancelled).mockReset().mockResolvedValue(ok(baseJob));
  vi.mocked(markFailed).mockReset().mockResolvedValue(ok(baseJob));
  createUploadUrl
    .mockReset()
    .mockResolvedValue({ url: "https://upload.example.com/presigned" });
  forgeFetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportConsumer", () => {
  it("uploads the archive and marks the job ready on success", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    vi.mocked(run).mockResolvedValue(
      ok({
        zipBuffer: Buffer.from("zip-bytes"),
        exportedCount: 3,
        skipped: [],
      }),
    );

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(markRunning).toHaveBeenCalledWith("account-1", "job-1");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        pageIds: baseJob.pageIds,
        initialSkipped: baseJob.skipped,
      }),
      expect.anything(),
    );
    expect(forgeFetch).toHaveBeenCalledWith(
      "https://upload.example.com/presigned",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(markReady).toHaveBeenCalledWith("account-1", "job-1", {
      archiveKey: "exports/account-1/job-1/root.zip",
      exportedCount: 3,
      skipped: [],
    });
  });

  it("records lifecycle progress reported by the pipeline", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    vi.mocked(run).mockImplementation(async (_input, hooks) => {
      await hooks.onProgress({
        stage: "converting-markdown",
        exportedCount: 2,
        warnings: [{ id: "3", title: null, reason: "410 Gone" }],
      });
      return ok({
        zipBuffer: Buffer.from("zip-bytes"),
        exportedCount: 2,
        skipped: [],
      });
    });

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(recordProgress).toHaveBeenCalledWith("account-1", "job-1", {
      stage: "converting-markdown",
      exportedCount: 2,
      warnings: [{ id: "3", title: null, reason: "410 Gone" }],
    });
  });

  it("marks the job cancelled without uploading when the pipeline is cancelled", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    const { exportCancelled } = await import("../../src/job/errors");
    vi.mocked(run).mockResolvedValue(exportCancelled());

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(markCancelled).toHaveBeenCalledWith("account-1", "job-1");
    expect(forgeFetch).not.toHaveBeenCalled();
  });

  it("marks the job failed with the error message when the pipeline fails", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    const { exportFailed } = await import("../../src/job/errors");
    vi.mocked(run).mockResolvedValue(
      exportFailed("Root page read failed: 403 Forbidden"),
    );

    await exportConsumer({ body: { accountId: "account-1", jobId: "job-1" } });

    expect(markFailed).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      "Root page read failed: 403 Forbidden",
    );
  });

  it("does nothing when the job record is missing", async () => {
    const { exportConsumer } = await import("../../src/job/consumer");
    vi.mocked(getJob).mockResolvedValue(ok(undefined));

    await exportConsumer({
      body: { accountId: "account-1", jobId: "missing" },
    });

    expect(markRunning).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
