import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportJob } from "../../src/job/types";

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

const storedJob = {
  jobId: "job-1",
  accountId: "account-1",
  status: "queued",
  stage: "fetching-pages",
  rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
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
  createdAt: "2026-07-06T12:00:00.000Z",
  updatedAt: "2026-07-06T12:00:00.000Z",
} satisfies ExportJob;

describe("saveJob", () => {
  it("stores a job record under an account+job key", async () => {
    const { saveJob } = await import("../../src/job/jobStore");
    mockSet.mockResolvedValueOnce(undefined);

    const result = await saveJob(storedJob);

    expect(result._unsafeUnwrap()).toBe(storedJob);
    expect(mockSet).toHaveBeenCalledWith(
      "export-job:account-1:job-1",
      storedJob,
    );
  });

  it("returns Err with a ProblemDetails when the write fails", async () => {
    const { saveJob } = await import("../../src/job/jobStore");
    mockSet.mockRejectedValueOnce(new Error("kvs unavailable"));

    const result = await saveJob(storedJob);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });
});

describe("getJob", () => {
  it("reads a job record by account and job id", async () => {
    const { getJob } = await import("../../src/job/jobStore");
    mockGet.mockResolvedValueOnce(storedJob);

    const result = await getJob("account-1", "job-1");

    expect(result._unsafeUnwrap()).toBe(storedJob);
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
