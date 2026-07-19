import Resolver from "@forge/resolver";
import { ok } from "@forge-ahead/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonalSpaceHomepage } from "../../src/job/confluenceClient";
import { exportFailed } from "../../src/job/errors";
import {
  attachQueueJob,
  createQueuedExportJob,
  recordSkippedBranches,
  requestCancellation,
} from "../../src/job/exportJobLifecycle";
import { startExportJobIntake } from "../../src/job/exportJobIntake";
import {
  clearLatestJobId,
  getJob,
  getLatestJobId,
  setLatestJobId,
} from "../../src/job/jobStore";

const queuePush = vi.fn();
const queueGetJob = vi.fn();
const createDownloadUrl = vi.fn();

vi.mock("../../src/job/confluenceClient", () => ({
  resolvePersonalSpaceHomepage: vi.fn(),
  getPage: vi.fn(),
  getDescendantIds: vi.fn(),
}));
vi.mock("../../src/job/exportJobIntake", () => ({
  startExportJobIntake: vi.fn(),
}));
vi.mock("../../src/job/exportJobLifecycle", () => ({
  createQueuedExportJob: vi.fn(),
  recordSkippedBranches: vi.fn(),
  attachQueueJob: vi.fn(),
  requestCancellation: vi.fn(),
}));
vi.mock("../../src/job/jobStore", () => ({
  getJob: vi.fn(),
  setLatestJobId: vi.fn(),
  getLatestJobId: vi.fn(),
  clearLatestJobId: vi.fn(),
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
  vi.mocked(startExportJobIntake).mockReset();
  vi.mocked(createQueuedExportJob).mockReset();
  vi.mocked(recordSkippedBranches).mockReset();
  vi.mocked(attachQueueJob).mockReset();
  vi.mocked(requestCancellation).mockReset();
  vi.mocked(getJob).mockReset();
  vi.mocked(setLatestJobId).mockReset();
  vi.mocked(getLatestJobId).mockReset();
  vi.mocked(clearLatestJobId).mockReset();
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

  it("passes Forge context and Execution UI payload into Export Job Intake", async () => {
    vi.mocked(startExportJobIntake).mockResolvedValue(ok({ jobId: "job-1" }));

    const result = await callResolver(
      resolver,
      "startExportJob",
      {
        rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
        depth: 5,
        bundleSlug: "bundle",
      },
      "account-1",
      context,
    );

    expect(result).toEqual({ jobId: "job-1" });
    expect(startExportJobIntake).toHaveBeenCalledWith(
      {
        accountId: "account-1",
        siteUrl: "https://example.atlassian.net",
        rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
        depth: 5,
        bundleSlug: "bundle",
      },
      expect.any(Object),
    );
  });

  it("adapts an Export Job Intake failure to the resolver error shape", async () => {
    vi.mocked(startExportJobIntake).mockResolvedValue(
      exportFailed("A root page URL is required.", 400),
    );

    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "" },
      "account-1",
      context,
    );

    expect(result).toEqual({ error: "A root page URL is required." });
  });
});

describe("getExportJob", () => {
  it("returns the job record", async () => {
    const job = { jobId: "job-1", status: "running" };
    vi.mocked(getJob).mockResolvedValue(ok(job as never));

    const result = await callResolver(
      resolver,
      "getExportJob",
      { jobId: "job-1" },
      "account-1",
    );

    expect(result).toEqual(job);
  });

  it("returns an error when the job does not exist", async () => {
    vi.mocked(getJob).mockResolvedValue(ok(undefined));

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
    vi.mocked(requestCancellation).mockResolvedValue(
      ok({
        jobId: "job-1",
        queueJobId: "queue-job-99",
        status: "running",
        cancelRequested: true,
      } as never),
    );

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
    vi.mocked(requestCancellation).mockResolvedValue(ok(null));

    const result = await callResolver(
      resolver,
      "cancelExportJob",
      { jobId: "missing" },
      "account-1",
    );

    expect(result).toEqual({ error: "Job not found." });
  });

  it("does not cancel queued work when lifecycle ignored a terminal job", async () => {
    vi.mocked(requestCancellation).mockResolvedValue(
      ok({
        jobId: "job-1",
        queueJobId: "queue-job-99",
        status: "ready",
        cancelRequested: false,
      } as never),
    );

    const result = await callResolver(
      resolver,
      "cancelExportJob",
      { jobId: "job-1" },
      "account-1",
    );

    expect(queueGetJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({ jobId: "job-1", status: "ready" });
  });
});

describe("createArchiveDownloadUrl", () => {
  it("returns a download url when the archive is ready", async () => {
    vi.mocked(getJob).mockResolvedValue(
      ok({
        jobId: "job-1",
        status: "ready",
        archiveKey: "exports/account-1/job-1/root.zip",
      } as never),
    );
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
    vi.mocked(getJob).mockResolvedValue(
      ok({
        jobId: "job-1",
        status: "running",
      } as never),
    );

    const result = await callResolver(
      resolver,
      "createArchiveDownloadUrl",
      { jobId: "job-1" },
      "account-1",
    );

    expect(result).toEqual({ error: "Archive is not ready." });
  });
});

describe("getActiveExportJob", () => {
  it("returns the account's most recent job when one is pointed to", async () => {
    vi.mocked(getLatestJobId).mockResolvedValue(ok("job-1"));
    const job = { jobId: "job-1", status: "running" };
    vi.mocked(getJob).mockResolvedValue(ok(job as never));

    const result = await callResolver(
      resolver,
      "getActiveExportJob",
      {},
      "account-1",
    );

    expect(getLatestJobId).toHaveBeenCalledWith("account-1");
    expect(getJob).toHaveBeenCalledWith("account-1", "job-1");
    expect(result).toEqual({ job });
  });

  it("returns a null job when nothing is pointed to", async () => {
    vi.mocked(getLatestJobId).mockResolvedValue(ok(undefined));

    const result = await callResolver(
      resolver,
      "getActiveExportJob",
      {},
      "account-1",
    );

    expect(result).toEqual({ job: null });
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns a null job when the pointer is stale and the job record is gone", async () => {
    vi.mocked(getLatestJobId).mockResolvedValue(ok("job-1"));
    vi.mocked(getJob).mockResolvedValue(ok(undefined));

    const result = await callResolver(
      resolver,
      "getActiveExportJob",
      {},
      "account-1",
    );

    expect(result).toEqual({ job: null });
  });
});

describe("clearActiveExportJob", () => {
  it("clears the account's latest-job pointer", async () => {
    const result = await callResolver(
      resolver,
      "clearActiveExportJob",
      {},
      "account-1",
    );

    expect(clearLatestJobId).toHaveBeenCalledWith("account-1");
    expect(result).toEqual({ ok: true });
  });
});
