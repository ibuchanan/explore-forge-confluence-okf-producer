import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();

vi.mock("@forge/kvs", () => ({
  kvs: { get: mockGet, set: mockSet, delete: mockDelete },
}));

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockReset();
  mockDelete.mockReset();
});

describe("createJob", () => {
  it("seeds a queued job record and stores it under an account+job key", async () => {
    const { createJob } = await import("../../src/job/jobStore");
    mockSet.mockResolvedValueOnce(undefined);

    const job = await createJob("account-1", "job-1", {
      rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
      pageIds: ["1", "2", "3"],
    });

    expect(job).toMatchObject({
      jobId: "job-1",
      accountId: "account-1",
      status: "queued",
      stage: "fetching-pages",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
      pageIds: ["1", "2", "3"],
      exportedCount: 0,
      skipped: [],
      warnings: [],
      errorMessage: null,
      archiveKey: null,
      queueJobId: null,
      cancelRequested: false,
    });
    expect(mockSet).toHaveBeenCalledWith("export-job:account-1:job-1", job);
  });
});

describe("getJob", () => {
  it("reads a job record by account and job id", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    const stored = { jobId: "job-1", accountId: "account-1" };
    mockGet.mockResolvedValueOnce(stored);

    const job = await getJob("account-1", "job-1");

    expect(job).toBe(stored);
    expect(mockGet).toHaveBeenCalledWith("export-job:account-1:job-1");
  });

  it("returns undefined when the job does not exist", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    expect(await getJob("account-1", "missing")).toBeUndefined();
  });
});

describe("patchJob", () => {
  it("merges the patch into the existing job and bumps updatedAt", async () => {
    const { patchJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce({
      jobId: "job-1",
      accountId: "account-1",
      status: "queued",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    mockSet.mockResolvedValueOnce(undefined);

    const updated = await patchJob("account-1", "job-1", { status: "running" });

    expect(updated).toMatchObject({ jobId: "job-1", status: "running" });
    expect(updated?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(mockSet).toHaveBeenCalledWith("export-job:account-1:job-1", updated);
  });

  it("returns null and does not write when the job does not exist", async () => {
    const { patchJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    const updated = await patchJob("account-1", "missing", {
      status: "running",
    });

    expect(updated).toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("requestCancellation", () => {
  it("sets cancelRequested on the job", async () => {
    const { requestCancellation } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce({ jobId: "job-1", cancelRequested: false });
    mockSet.mockResolvedValueOnce(undefined);

    const updated = await requestCancellation("account-1", "job-1");

    expect(updated?.cancelRequested).toBe(true);
  });
});

describe("isCancellationRequested", () => {
  it("reflects the job's cancelRequested flag", async () => {
    const { isCancellationRequested } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce({ jobId: "job-1", cancelRequested: true });

    expect(await isCancellationRequested("account-1", "job-1")).toBe(true);
  });

  it("is false when the job does not exist", async () => {
    const { isCancellationRequested } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    expect(await isCancellationRequested("account-1", "missing")).toBe(false);
  });
});

describe("latest job pointer", () => {
  it("setLatestJobId stores the job id under an account-scoped key", async () => {
    const { setLatestJobId } = await import("../../src/job/jobStore");
    mockSet.mockResolvedValueOnce(undefined);

    await setLatestJobId("account-1", "job-1");

    expect(mockSet).toHaveBeenCalledWith(
      "export-latest-job:account-1",
      "job-1",
    );
  });

  it("getLatestJobId reads the job id back", async () => {
    const { getLatestJobId } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce("job-1");

    expect(await getLatestJobId("account-1")).toBe("job-1");
    expect(mockGet).toHaveBeenCalledWith("export-latest-job:account-1");
  });

  it("getLatestJobId returns undefined when nothing is pointed to", async () => {
    const { getLatestJobId } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    expect(await getLatestJobId("account-1")).toBeUndefined();
  });

  it("clearLatestJobId deletes the pointer", async () => {
    const { clearLatestJobId } = await import("../../src/job/jobStore");
    mockDelete.mockResolvedValueOnce(undefined);

    await clearLatestJobId("account-1");

    expect(mockDelete).toHaveBeenCalledWith("export-latest-job:account-1");
  });
});
