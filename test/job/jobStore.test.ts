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

    const result = await createJob("account-1", "job-1", {
      rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
      pageIds: ["1", "2", "3"],
    });
    const job = result._unsafeUnwrap();

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

  it("returns Err with a ProblemDetails when the write fails", async () => {
    const { createJob } = await import("../../src/job/jobStore");
    mockSet.mockRejectedValueOnce(new Error("kvs unavailable"));

    const result = await createJob("account-1", "job-1", {
      rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
      pageIds: ["1"],
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });
});

describe("getJob", () => {
  it("reads a job record by account and job id", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    const stored = { jobId: "job-1", accountId: "account-1" };
    mockGet.mockResolvedValueOnce(stored);

    const result = await getJob("account-1", "job-1");

    expect(result._unsafeUnwrap()).toBe(stored);
    expect(mockGet).toHaveBeenCalledWith("export-job:account-1:job-1");
  });

  it("returns Ok(undefined) when the job does not exist", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    const result = await getJob("account-1", "missing");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("returns Err with a ProblemDetails when the read fails", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    mockGet.mockRejectedValueOnce(new Error("kvs unavailable"));

    const result = await getJob("account-1", "job-1");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
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

    const result = await patchJob("account-1", "job-1", { status: "running" });
    const updated = result._unsafeUnwrap();

    expect(updated).toMatchObject({ jobId: "job-1", status: "running" });
    expect(updated?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(mockSet).toHaveBeenCalledWith("export-job:account-1:job-1", updated);
  });

  it("returns Ok(null) and does not write when the job does not exist", async () => {
    const { patchJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    const result = await patchJob("account-1", "missing", {
      status: "running",
    });

    expect(result._unsafeUnwrap()).toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("requestCancellation", () => {
  it("sets cancelRequested on the job", async () => {
    const { requestCancellation } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce({ jobId: "job-1", cancelRequested: false });
    mockSet.mockResolvedValueOnce(undefined);

    const result = await requestCancellation("account-1", "job-1");

    expect(result._unsafeUnwrap()?.cancelRequested).toBe(true);
  });
});

describe("isCancellationRequested", () => {
  it("reflects the job's cancelRequested flag", async () => {
    const { isCancellationRequested } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce({ jobId: "job-1", cancelRequested: true });

    const result = await isCancellationRequested("account-1", "job-1");

    expect(result._unsafeUnwrap()).toBe(true);
  });

  it("is false when the job does not exist", async () => {
    const { isCancellationRequested } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    const result = await isCancellationRequested("account-1", "missing");

    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe("latest job pointer", () => {
  it("setLatestJobId stores the job id under an account-scoped key", async () => {
    const { setLatestJobId } = await import("../../src/job/jobStore");
    mockSet.mockResolvedValueOnce(undefined);

    const result = await setLatestJobId("account-1", "job-1");

    expect(result.isOk()).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      "export-latest-job:account-1",
      "job-1",
    );
  });

  it("getLatestJobId reads the job id back", async () => {
    const { getLatestJobId } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce("job-1");

    const result = await getLatestJobId("account-1");

    expect(result._unsafeUnwrap()).toBe("job-1");
    expect(mockGet).toHaveBeenCalledWith("export-latest-job:account-1");
  });

  it("getLatestJobId returns Ok(undefined) when nothing is pointed to", async () => {
    const { getLatestJobId } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(undefined);

    const result = await getLatestJobId("account-1");

    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("clearLatestJobId deletes the pointer", async () => {
    const { clearLatestJobId } = await import("../../src/job/jobStore");
    mockDelete.mockResolvedValueOnce(undefined);

    const result = await clearLatestJobId("account-1");

    expect(result.isOk()).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith("export-latest-job:account-1");
  });
});
