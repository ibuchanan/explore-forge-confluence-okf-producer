import { ok } from "@forge-ahead/errors";
import { describe, expect, it, vi } from "vitest";
import { exportFailed } from "../../src/job/errors";
import {
  startExportJobIntake,
  type ExportJobIntakeAdapters,
  type ExportJobIntakeRequest,
} from "../../src/job/exportJobIntake";
import type { ConfluencePage, ExportJob } from "../../src/job/types";

const ROOT_URL = "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root";
const BASE_REQUEST = {
  accountId: "account-1",
  siteUrl: "https://example.atlassian.net",
  rootUrl: ROOT_URL,
  depth: 5,
} satisfies ExportJobIntakeRequest;

const sourcePage = {
  id: "1",
  title: "Root",
  parentId: null,
  spaceId: "SPACE",
  version: 1,
  status: "current",
  webUrl: ROOT_URL,
  html: "<p>Root</p>",
  labels: [],
} satisfies ConfluencePage;

function createAdapters(
  overrides: Partial<ExportJobIntakeAdapters> = {},
): ExportJobIntakeAdapters {
  return {
    createJobId: vi.fn(() => "job-1"),
    readSourcePageAsUser: vi.fn(async () => ok(sourcePage)),
    readSourcePageAsApp: vi.fn(async () => ok(sourcePage)),
    enumerateDescendantSourcePages: vi.fn(async () => ok([])),
    createExportJob: vi.fn(async () => ok({} as ExportJob)),
    recordSkippedBranches: vi.fn(async () => ok({} as ExportJob)),
    recordLatestExportJob: vi.fn(async () => ok(undefined)),
    scheduleExportJob: vi.fn(async () => ({ queueJobId: "queue-job-99" })),
    attachQueueJob: vi.fn(async () => ok({} as ExportJob)),
    ...overrides,
  };
}

describe("startExportJobIntake validation", () => {
  it("rejects an empty root page URL before touching adapters", async () => {
    const adapters = createAdapters();

    const result = await startExportJobIntake(
      { ...BASE_REQUEST, rootUrl: "" },
      adapters,
    );

    expect(result._unsafeUnwrapErr().detail).toBe(
      "A root page URL is required.",
    );
    expect(adapters.readSourcePageAsUser).not.toHaveBeenCalled();
    expect(adapters.createExportJob).not.toHaveBeenCalled();
  });

  it("rejects a Source Page outside the Installed Site", async () => {
    const adapters = createAdapters();

    const result = await startExportJobIntake(
      {
        ...BASE_REQUEST,
        rootUrl: "https://other-site.atlassian.net/wiki/spaces/KEY/pages/1",
      },
      adapters,
    );

    expect(result._unsafeUnwrapErr().detail).toBe(
      "The root page URL must be on this site.",
    );
    expect(adapters.readSourcePageAsUser).not.toHaveBeenCalled();
  });
});

describe("startExportJobIntake success", () => {
  it("creates, tracks, schedules, and attaches a queued Export Job", async () => {
    const adapters = createAdapters({
      enumerateDescendantSourcePages: vi.fn(async () => ok(["2", "3"])),
    });

    const result = await startExportJobIntake(BASE_REQUEST, adapters);

    expect(result._unsafeUnwrap()).toEqual({ jobId: "job-1" });
    expect(adapters.readSourcePageAsUser).toHaveBeenCalledWith("1");
    expect(adapters.readSourcePageAsApp).toHaveBeenCalledWith("1");
    expect(adapters.enumerateDescendantSourcePages).toHaveBeenCalledWith(
      "1",
      5,
      expect.objectContaining({ onSkippedBranch: expect.any(Function) }),
    );
    expect(adapters.createExportJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      {
        rootUrl: ROOT_URL,
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        pageIds: ["1", "2", "3"],
      },
    );
    expect(adapters.recordLatestExportJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
    );
    expect(adapters.scheduleExportJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
    );
    expect(adapters.attachQueueJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      "queue-job-99",
    );
  });

  it("normalizes depth and a custom bundle slug", async () => {
    const adapters = createAdapters();

    const result = await startExportJobIntake(
      {
        ...BASE_REQUEST,
        depth: 999,
        bundleSlug: "  custom-bundle  ",
      },
      adapters,
    );

    expect(result.isOk()).toBe(true);
    expect(adapters.createExportJob).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      expect.objectContaining({
        depth: 5,
        bundleSlug: "custom-bundle",
      }),
    );
  });
});

describe("startExportJobIntake root access", () => {
  it("fails fast when the root Source Page cannot be read as the user", async () => {
    const adapters = createAdapters({
      readSourcePageAsUser: vi.fn(async () => exportFailed("403 Forbidden")),
    });

    const result = await startExportJobIntake(BASE_REQUEST, adapters);

    expect(result._unsafeUnwrapErr().detail).toBe(
      "Root page read failed: 403 Forbidden",
    );
    expect(adapters.readSourcePageAsApp).not.toHaveBeenCalled();
    expect(adapters.createExportJob).not.toHaveBeenCalled();
  });

  it("fails fast when the root Source Page is readable as the user but not as the app", async () => {
    const adapters = createAdapters({
      readSourcePageAsApp: vi.fn(async () => exportFailed("403 Forbidden")),
    });

    const result = await startExportJobIntake(BASE_REQUEST, adapters);

    expect(result._unsafeUnwrapErr().detail).toBe(
      "This page's space likely has view restrictions that don't include this app. " +
        "Ask a site or space admin to grant the app access, or choose a root page from " +
        "a space without view restrictions. (Root page read as the app failed: 403 Forbidden)",
    );
    expect(adapters.createExportJob).not.toHaveBeenCalled();
  });
});

describe("startExportJobIntake enumeration", () => {
  it("fails fast when descendant Source Page enumeration fails entirely", async () => {
    const adapters = createAdapters({
      enumerateDescendantSourcePages: vi.fn(async () =>
        exportFailed("500 Server Error"),
      ),
    });

    const result = await startExportJobIntake(BASE_REQUEST, adapters);

    expect(result._unsafeUnwrapErr().detail).toBe(
      "Descendant listing failed: 500 Server Error",
    );
    expect(adapters.createExportJob).not.toHaveBeenCalled();
  });

  it("seeds skipped branches from Source Page enumeration", async () => {
    const adapters = createAdapters({
      enumerateDescendantSourcePages: vi.fn(async (_rootId, _depth, hooks) => {
        hooks.onSkippedBranch?.(
          "9",
          exportFailed("403 Forbidden")._unsafeUnwrapErr(),
        );
        return ok(["2"]);
      }),
    });

    const result = await startExportJobIntake(BASE_REQUEST, adapters);

    expect(result.isOk()).toBe(true);
    expect(adapters.recordSkippedBranches).toHaveBeenCalledWith(
      "account-1",
      "job-1",
      [{ id: "9", title: null, reason: "403 Forbidden" }],
    );
  });
});
