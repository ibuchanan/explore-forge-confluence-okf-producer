import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportJob } from "../../src/job/types";

const mockGet = vi.fn();
const mockSet = vi.fn();

vi.mock("@forge/kvs", () => ({
  kvs: { get: mockGet, set: mockSet },
}));

const baseJob = {
  jobId: "job-1",
  accountId: "account-1",
  status: "queued",
  stage: "fetching-pages",
  rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
  rootId: "1",
  depth: 5,
  bundleSlug: "root",
  pageIds: ["1", "2"],
  exportedCount: 0,
  skipped: [],
  warnings: [],
  errorMessage: null,
  archiveKey: null,
  queueJobId: null,
  cancelRequested: false,
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
} satisfies ExportJob;

function job(overrides: Partial<ExportJob> = {}): ExportJob {
  return { ...baseJob, ...overrides };
}

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset().mockResolvedValue(undefined);
});

describe("createQueuedExportJob", () => {
  it("creates a queued Export Job with lifecycle-owned defaults", async () => {
    const { createQueuedExportJob } = await import(
      "../../src/job/exportJobLifecycle"
    );

    const result = await createQueuedExportJob("account-1", "job-1", {
      rootUrl: baseJob.rootUrl,
      rootId: baseJob.rootId,
      depth: baseJob.depth,
      bundleSlug: baseJob.bundleSlug,
      pageIds: baseJob.pageIds,
    });
    const created = result._unsafeUnwrap();

    expect(created).toMatchObject({
      jobId: "job-1",
      accountId: "account-1",
      status: "queued",
      stage: "fetching-pages",
      exportedCount: 0,
      skipped: [],
      warnings: [],
      errorMessage: null,
      archiveKey: null,
      queueJobId: null,
      cancelRequested: false,
    });
    expect(mockSet).toHaveBeenCalledWith("export-job:account-1:job-1", created);
  });
});

describe("queue setup lifecycle transitions", () => {
  it("attaches queue work and records intake-time skipped branches", async () => {
    const { attachQueueJob, recordSkippedBranches } = await import(
      "../../src/job/exportJobLifecycle"
    );
    mockGet
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(job({ queueJobId: "queue-job-99" }));

    const attached = await attachQueueJob("account-1", "job-1", "queue-job-99");
    const skipped = await recordSkippedBranches("account-1", "job-1", [
      { id: "9", title: null, reason: "403 Forbidden" },
    ]);

    expect(attached._unsafeUnwrap()).toMatchObject({
      queueJobId: "queue-job-99",
    });
    expect(skipped._unsafeUnwrap()).toMatchObject({
      skipped: [{ id: "9", title: null, reason: "403 Forbidden" }],
    });
    expect(mockSet).toHaveBeenCalledTimes(2);
  });
});

describe("runtime lifecycle transitions", () => {
  it("marks the job running and records narrow pipeline progress", async () => {
    const { markRunning, recordProgress } = await import(
      "../../src/job/exportJobLifecycle"
    );
    mockGet
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(job({ status: "running" }));

    const running = await markRunning("account-1", "job-1");
    const progressed = await recordProgress("account-1", "job-1", {
      stage: "converting-markdown",
      exportedCount: 2,
      warnings: [{ id: "3", title: null, reason: "410 Gone" }],
    });

    expect(running._unsafeUnwrap()).toMatchObject({ status: "running" });
    expect(progressed._unsafeUnwrap()).toMatchObject({
      stage: "converting-markdown",
      exportedCount: 2,
      warnings: [{ id: "3", title: null, reason: "410 Gone" }],
    });
    expect(mockSet).toHaveBeenCalledTimes(2);
  });

  it("requests cancellation and exposes the cancellation flag", async () => {
    const { isCancellationRequested, requestCancellation } = await import(
      "../../src/job/exportJobLifecycle"
    );
    mockGet
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(job({ cancelRequested: true }));

    const cancelled = await requestCancellation("account-1", "job-1");
    const isCancelled = await isCancellationRequested("account-1", "job-1");

    expect(cancelled._unsafeUnwrap()).toMatchObject({ cancelRequested: true });
    expect(isCancelled._unsafeUnwrap()).toBe(true);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });
});

describe("terminal lifecycle transitions", () => {
  it("marks successful, failed, and cancelled terminal states with matching stages", async () => {
    const { markCancelled, markFailed, markReady } = await import(
      "../../src/job/exportJobLifecycle"
    );
    mockGet
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(baseJob);

    const ready = await markReady("account-1", "job-1", {
      archiveKey: "exports/account-1/job-1/root.zip",
      exportedCount: 2,
      skipped: [{ id: "3", title: null, reason: "410 Gone" }],
    });
    const failed = await markFailed("account-1", "job-1", "Root read failed.");
    const cancelled = await markCancelled("account-1", "job-1");

    expect(ready._unsafeUnwrap()).toMatchObject({
      status: "ready",
      stage: "ready",
      archiveKey: "exports/account-1/job-1/root.zip",
      exportedCount: 2,
      skipped: [{ id: "3", title: null, reason: "410 Gone" }],
      errorMessage: null,
    });
    expect(failed._unsafeUnwrap()).toMatchObject({
      status: "failed",
      stage: "failed",
      errorMessage: "Root read failed.",
    });
    expect(cancelled._unsafeUnwrap()).toMatchObject({
      status: "cancelled",
      stage: "cancelled",
    });
    expect(mockSet).toHaveBeenCalledTimes(3);
  });
});

describe("idempotent lifecycle guards", () => {
  it("returns null without writing when the job is missing", async () => {
    const { markRunning } = await import("../../src/job/exportJobLifecycle");
    mockGet.mockResolvedValueOnce(undefined);

    const result = await markRunning("account-1", "missing");

    expect(result._unsafeUnwrap()).toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("ignores later transitions once the job is terminal", async () => {
    const { markFailed, recordProgress, requestCancellation } = await import(
      "../../src/job/exportJobLifecycle"
    );
    const terminal = job({
      status: "ready",
      stage: "ready",
      archiveKey: "exports/account-1/job-1/root.zip",
    });
    mockGet
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce(terminal);

    const progressed = await recordProgress("account-1", "job-1", {
      exportedCount: 99,
    });
    const requested = await requestCancellation("account-1", "job-1");
    const failed = await markFailed("account-1", "job-1", "Too late.");

    expect(progressed._unsafeUnwrap()).toBe(terminal);
    expect(requested._unsafeUnwrap()).toBe(terminal);
    expect(failed._unsafeUnwrap()).toBe(terminal);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
