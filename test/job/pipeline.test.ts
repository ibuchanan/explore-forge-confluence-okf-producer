import { ok } from "@forge-ahead/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignPaths,
  buildTree,
  buildZipBuffer,
  renderConceptDocument,
  renderDirIndex,
  renderLog,
  renderRootIndex,
} from "../../src/job/bundle";
import { getPage, getSpaceKey } from "../../src/job/confluenceClient";
import { convertPageHtml } from "../../src/job/convert";

vi.mock("../../src/job/confluenceClient", () => ({
  getPage: vi.fn(),
  getSpaceKey: vi.fn(),
}));
vi.mock("../../src/job/convert", () => ({ convertPageHtml: vi.fn() }));
vi.mock("../../src/job/bundle", () => ({
  buildTree: vi.fn(),
  assignPaths: vi.fn(),
  renderConceptDocument: vi.fn(),
  renderDirIndex: vi.fn(),
  renderRootIndex: vi.fn(),
  renderLog: vi.fn(),
  buildZipBuffer: vi.fn(),
}));

const rootPage = {
  id: "1",
  title: "Root",
  parentId: null,
  spaceId: "10",
  version: 1,
  status: "current",
  webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Root",
  html: "<p>Body</p>",
  labels: [],
};

const FAKE_BUFFER = Buffer.from("zip");

beforeEach(() => {
  vi.mocked(getPage).mockReset().mockResolvedValue(ok(rootPage));
  vi.mocked(getSpaceKey).mockReset().mockResolvedValue(ok("KEY"));
  vi.mocked(convertPageHtml).mockReset().mockReturnValue(ok("Converted body."));
  vi.mocked(buildTree).mockReset();
  vi.mocked(assignPaths).mockReset();
  vi.mocked(renderConceptDocument).mockReset().mockReturnValue("DOC");
  vi.mocked(renderDirIndex).mockReset().mockReturnValue("DIR_INDEX");
  vi.mocked(renderRootIndex).mockReset().mockReturnValue("ROOT_INDEX");
  vi.mocked(renderLog).mockReset().mockReturnValue("LOG");
  vi.mocked(buildZipBuffer).mockReset().mockResolvedValue(ok(FAKE_BUFFER));
});

describe("run", () => {
  it("reports stage progression, fetches each pageId as the app, and returns the archive", async () => {
    const { run } = await import("../../src/job/pipeline");
    const onProgress = vi.fn();

    const outcome = await run(
      {
        pageIds: ["1"],
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        initialSkipped: [],
      },
      { onProgress, isCancelled: () => false },
    );
    const result = outcome._unsafeUnwrap();

    const stages = onProgress.mock.calls
      .map(([patch]) => patch.stage)
      .filter(Boolean);
    expect(stages).toEqual([
      "fetching-pages",
      "converting-markdown",
      "building-archive",
    ]);
    expect(getPage).toHaveBeenCalledWith("app", "1");
    expect(getSpaceKey).toHaveBeenCalledWith("app", "10");
    expect(result.zipBuffer).toBe(FAKE_BUFFER);
    expect(result.exportedCount).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(buildZipBuffer).toHaveBeenCalledWith("root", expect.any(Map));
  });

  it("carries forward enumeration-time skips passed in as initialSkipped", async () => {
    const { run } = await import("../../src/job/pipeline");

    const outcome = await run(
      {
        pageIds: ["1"],
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        initialSkipped: [{ id: "9", title: null, reason: "403 Forbidden" }],
      },
      { onProgress: vi.fn(), isCancelled: () => false },
    );

    expect(outcome._unsafeUnwrap().skipped).toEqual([
      { id: "9", title: null, reason: "403 Forbidden" },
    ]);
  });

  it("returns Err with the real fetch-failure reason when the root page is missing from the fetched set", async () => {
    const { run } = await import("../../src/job/pipeline");
    const { exportFailed } = await import("../../src/job/errors");
    vi.mocked(getPage)
      .mockReset()
      .mockResolvedValue(exportFailed("403 Forbidden", 403));

    const outcome = await run(
      {
        pageIds: ["1"],
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        initialSkipped: [],
      },
      { onProgress: vi.fn(), isCancelled: () => false },
    );

    expect(outcome.isErr()).toBe(true);
    expect(outcome._unsafeUnwrapErr().detail).toBe(
      "Root page 1 could not be read while building the archive: 403 Forbidden.",
    );
  });

  it("skips individual page fetch failures and records them", async () => {
    const { run } = await import("../../src/job/pipeline");
    const { exportFailed } = await import("../../src/job/errors");
    vi.mocked(getPage)
      .mockReset()
      .mockImplementation(async (_auth: string, pageId: string) => {
        if (pageId === "2") {
          return exportFailed("410 Gone", 410);
        }
        return ok({ ...rootPage, id: pageId });
      });

    const outcome = await run(
      {
        pageIds: ["1", "2", "3"],
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        initialSkipped: [],
      },
      { onProgress: vi.fn(), isCancelled: () => false },
    );
    const result = outcome._unsafeUnwrap();

    expect(result.skipped).toEqual([
      { id: "2", title: null, reason: "410 Gone" },
    ]);
    expect(result.exportedCount).toBe(2);
  });

  it("returns a cancelled ProblemDetails and stops fetching remaining pages when cancelled mid-loop", async () => {
    const { run } = await import("../../src/job/pipeline");
    const { isCancelled } = await import("../../src/job/errors");

    const outcome = await run(
      {
        pageIds: ["1", "2", "3"],
        rootId: "1",
        depth: 5,
        bundleSlug: "root",
        initialSkipped: [],
      },
      { onProgress: vi.fn(), isCancelled: () => true },
    );

    expect(outcome.isErr()).toBe(true);
    expect(isCancelled(outcome._unsafeUnwrapErr())).toBe(true);
    expect(getPage).not.toHaveBeenCalled();
  });
});
