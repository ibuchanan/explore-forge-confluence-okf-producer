import Resolver from "@forge/resolver";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDescendantIds,
  getPage,
  resolvePersonalSpaceHomepage,
} from "../../src/job/confluenceClient";
import {
  clearLatestJobId,
  createJob,
  getJob,
  getLatestJobId,
  patchJob,
  requestCancellation,
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
vi.mock("../../src/job/jobStore", () => ({
  createJob: vi.fn(),
  getJob: vi.fn(),
  patchJob: vi.fn(),
  requestCancellation: vi.fn(),
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
  vi.mocked(getPage)
    .mockReset()
    .mockResolvedValue({ id: "1" } as never);
  vi.mocked(getDescendantIds).mockReset().mockResolvedValue([]);
  vi.mocked(createJob).mockReset();
  vi.mocked(getJob).mockReset();
  vi.mocked(patchJob).mockReset();
  vi.mocked(requestCancellation).mockReset();
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

  it("validates the root page and enumerates descendants as the user before creating the job", async () => {
    vi.mocked(getDescendantIds).mockResolvedValue(["2", "3"]);
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
    expect(getPage).toHaveBeenCalledWith("user", "1");
    expect(getPage).toHaveBeenCalledWith("app", "1");
    expect(getDescendantIds).toHaveBeenCalledWith(
      "1",
      5,
      expect.objectContaining({ onSkippedBranch: expect.any(Function) }),
    );
    expect(createJob).toHaveBeenCalledWith("account-1", appJobId, {
      rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
      rootId: "1",
      depth: 5,
      bundleSlug: "root",
      pageIds: ["1", "2", "3"],
    });
    expect(queuePush).toHaveBeenCalledWith({
      body: { accountId: "account-1", jobId: appJobId },
    });
    // The bug this guards against: cancellation must use the queue's own job
    // id (returned from push()), not our application-level job id -- they
    // are different id spaces.
    // So the Execution UI can find this job again after a navigation/remount.
    expect(setLatestJobId).toHaveBeenCalledWith("account-1", appJobId);
    expect(patchJob).toHaveBeenCalledWith("account-1", appJobId, {
      queueJobId: "queue-job-99",
    });
  });

  it("fails fast without creating a job when the root page cannot be read", async () => {
    vi.mocked(getPage).mockRejectedValue(new Error("403 Forbidden"));

    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root" },
      "account-1",
      context,
    );

    expect(result).toEqual({
      error: "Root page read failed: 403 Forbidden",
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(queuePush).not.toHaveBeenCalled();
  });

  it("fails fast without creating a job when the root page is readable as the user but not as the app", async () => {
    vi.mocked(getPage).mockImplementation(async (auth) => {
      if (auth === "app") {
        throw new Error("403 Forbidden");
      }
      return { id: "1" } as never;
    });

    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root" },
      "account-1",
      context,
    );

    expect(result).toEqual({
      error:
        "This page's space likely has view restrictions that don't include this app. " +
        "Ask a site or space admin to grant the app access, or choose a root page from " +
        "a space without view restrictions. (Root page read as the app failed: 403 Forbidden)",
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(queuePush).not.toHaveBeenCalled();
  });

  it("fails fast without creating a job when descendant listing fails entirely", async () => {
    vi.mocked(getDescendantIds).mockRejectedValue(
      new Error("500 Server Error"),
    );

    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root" },
      "account-1",
      context,
    );

    expect(result).toEqual({
      error: "Descendant listing failed: 500 Server Error",
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  it("seeds the job's skipped list from branches skipped during enumeration", async () => {
    vi.mocked(getDescendantIds).mockImplementation(
      async (_rootId, _depth, hooks) => {
        hooks?.onSkippedBranch?.("9", new Error("403 Forbidden"));
        return ["2"];
      },
    );
    vi.mocked(createJob).mockResolvedValue({} as never);
    queuePush.mockResolvedValue({ jobId: "queue-job-99" });

    const result = await callResolver(
      resolver,
      "startExportJob",
      { rootUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root" },
      "account-1",
      context,
    );

    const appJobId = (result as { jobId: string }).jobId;
    expect(patchJob).toHaveBeenCalledWith("account-1", appJobId, {
      skipped: [{ id: "9", title: null, reason: "403 Forbidden" }],
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

describe("getActiveExportJob", () => {
  it("returns the account's most recent job when one is pointed to", async () => {
    vi.mocked(getLatestJobId).mockResolvedValue("job-1");
    const job = { jobId: "job-1", status: "running" };
    vi.mocked(getJob).mockResolvedValue(job as never);

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
    vi.mocked(getLatestJobId).mockResolvedValue(undefined);

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
    vi.mocked(getLatestJobId).mockResolvedValue("job-1");
    vi.mocked(getJob).mockResolvedValue(undefined);

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
