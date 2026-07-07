import Resolver from "@forge/resolver";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonalSpaceHomepage } from "../../src/job/confluenceClient";
import {
  createJob,
  getJob,
  patchJob,
  requestCancellation,
} from "../../src/job/jobStore";

const queuePush = vi.fn();
const queueGetJob = vi.fn();
const createDownloadUrl = vi.fn();

vi.mock("../../src/job/confluenceClient", () => ({
  resolvePersonalSpaceHomepage: vi.fn(),
}));
vi.mock("../../src/job/jobStore", () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  patchJob: vi.fn(),
  requestCancellation: vi.fn(),
}));
vi.mock("@forge/events", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return { push: queuePush, getJob: queueGetJob };
  }),
}));
vi.mock("@forge/object-store", () => ({
  default: { createDownloadUrl },
}));

function callResolver(
  resolver: Resolver,
  functionKey: string,
  payload: unknown,
  accountId: string,
  context: Record<string, unknown> = {},
) {
  const handler = resolver.getDefinitions();
  return handler(
    { call: { functionKey, payload }, context },
    { principal: { accountId } },
  );
}

let resolver: Resolver;

beforeEach(async () => {
  const { registerExportResolvers } = await import(
    "../../src/resolvers/export"
  );
  resolver = new Resolver();
  registerExportResolvers(resolver);
  vi.mocked(resolvePersonalSpaceHomepage).mockReset();
  vi.mocked(createJob).mockReset();
  vi.mocked(getJob).mockReset();
  vi.mocked(patchJob).mockReset();
  vi.mocked(requestCancellation).mockReset();
  queuePush.mockReset();
  queueGetJob.mockReset();
  createDownloadUrl.mockReset();
});

describe("getDefaultSource", () => {
  it("returns the best-effort personal space homepage for the current user", async () => {
    vi.mocked(resolvePersonalSpaceHomepage).mockResolvedValue(
      "https://example.atlassian.net/wiki/spaces/~account-1/overview",
    );

    const result = await callResolver(
      resolver,
      "getDefaultSource",
      {},
      "account-1",
    );

    expect(result).toEqual({
      rootUrl: "https://example.atlassian.net/wiki/spaces/~account-1/overview",
    });
    expect(resolvePersonalSpaceHomepage).toHaveBeenCalledWith("account-1");
  });
});

describe("startExportJob", () => {
  const context = { siteUrl: "https://example.atlassian.net" };

  it("requires a root page URL", async () => {
    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "" },
      "account-1",
      context,
    );

    expect(result).toEqual({ error: "A root page URL is required." });
  });

  it("rejects a root page URL from another site", async () => {
    const result = await callResolver(
      resolver,
      "startExportJob",
      {
        rootUrl:
          "https://other-site.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      },
      "account-1",
      context,
    );

    expect(result).toEqual({
      error: "The root page URL must be on this site.",
    });
  });

  it("creates the job, pushes to the queue, and persists the queue's own job id", async () => {
    vi.mocked(createJob).mockResolvedValue({} as never);
    queuePush.mockResolvedValue({ jobId: "queue-job-99" });

    const result = await callResolver(
      resolver,
      "startExportJob",
      {
        rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
        depth: 5,
      },
      "account-1",
      context,
    );

    expect(result).toHaveProperty("jobId");
    const appJobId = (result as { jobId: string }).jobId;
    expect(createJob).toHaveBeenCalledWith("account-1", appJobId, {
      rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
    });
    expect(queuePush).toHaveBeenCalledWith({
      body: { accountId: "account-1", jobId: appJobId },
    });
    // The bug this guards against: cancellation must use the queue's own job
    // id (returned from push()), not our application-level job id -- they
    // are different id spaces.
    expect(patchJob).toHaveBeenCalledWith("account-1", appJobId, {
      queueJobId: "queue-job-99",
    });
  });
});

describe("getExportJob", () => {
  it("returns the job record", async () => {
    const job = { jobId: "job-1", status: "running" };
    vi.mocked(getJob).mockResolvedValue(job as never);

    const result = await callResolver(
      resolver,
      "getExportJob",
      { jobId: "job-1" },
      "account-1",
    );

    expect(result).toEqual(job);
  });

  it("returns an error when the job does not exist", async () => {
    vi.mocked(getJob).mockResolvedValue(undefined);

    const result = await callResolver(
      resolver,
      "getExportJob",
      { jobId: "missing" },
      "account-1",
    );

    expect(result).toEqual({ error: "Job not found." });
  });
});

describe("cancelExportJob", () => {
  it("requests cancellation and cancels the queue job using the queue's own job id", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    queueGetJob.mockReturnValue({ cancel });
    vi.mocked(requestCancellation).mockResolvedValue({
      jobId: "job-1",
      queueJobId: "queue-job-99",
      cancelRequested: true,
    } as never);

    const result = await callResolver(
      resolver,
      "cancelExportJob",
      { jobId: "job-1" },
      "account-1",
    );

    expect(requestCancellation).toHaveBeenCalledWith("account-1", "job-1");
    expect(queueGetJob).toHaveBeenCalledWith("queue-job-99");
    expect(cancel).toHaveBeenCalled();
    expect(result).toMatchObject({ jobId: "job-1" });
  });

  it("returns an error when the job does not exist", async () => {
    vi.mocked(requestCancellation).mockResolvedValue(null);

    const result = await callResolver(
      resolver,
      "cancelExportJob",
      { jobId: "missing" },
      "account-1",
    );

    expect(result).toEqual({ error: "Job not found." });
  });
});

describe("createArchiveDownloadUrl", () => {
  it("returns a download url when the archive is ready", async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1",
      status: "ready",
      archiveKey: "exports/account-1/job-1/root.zip",
    } as never);
    createDownloadUrl.mockResolvedValue({
      url: "https://download.example.com/presigned",
    });

    const result = await callResolver(
      resolver,
      "createArchiveDownloadUrl",
      { jobId: "job-1" },
      "account-1",
    );

    expect(createDownloadUrl).toHaveBeenCalledWith(
      "exports/account-1/job-1/root.zip",
    );
    expect(result).toEqual({ url: "https://download.example.com/presigned" });
  });

  it("returns an error when the archive is not ready", async () => {
    vi.mocked(getJob).mockResolvedValue({
      jobId: "job-1",
      status: "running",
    } as never);

    const result = await callResolver(
      resolver,
      "createArchiveDownloadUrl",
      { jobId: "job-1" },
      "account-1",
    );

    expect(result).toEqual({ error: "Archive is not ready." });
  });
});
