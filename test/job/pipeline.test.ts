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
import {
  getDescendantIds,
  getPage,
  getSpaceKey,
} from "../../src/job/confluenceClient";
import { convertPageHtml } from "../../src/job/convert";

vi.mock("../../src/job/confluenceClient", () => ({
  getPage: vi.fn(),
  getDescendantIds: vi.fn(),
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
  vi.mocked(getPage).mockReset().mockResolvedValue(rootPage);
  vi.mocked(getDescendantIds).mockReset().mockResolvedValue([]);
  vi.mocked(getSpaceKey).mockReset().mockResolvedValue("KEY");
  vi.mocked(convertPageHtml).mockReset().mockReturnValue("Converted body.");
  vi.mocked(buildTree).mockReset();
  vi.mocked(assignPaths).mockReset();
  vi.mocked(renderConceptDocument).mockReset().mockReturnValue("DOC");
  vi.mocked(renderDirIndex).mockReset().mockReturnValue("DIR_INDEX");
  vi.mocked(renderRootIndex).mockReset().mockReturnValue("ROOT_INDEX");
  vi.mocked(renderLog).mockReset().mockReturnValue("LOG");
  vi.mocked(buildZipBuffer).mockReset().mockResolvedValue(FAKE_BUFFER);
});

describe("run", () => {
  it("reports stage progression and returns the archive on the happy path", async () => {
    const { run } = await import("../../src/job/pipeline");
    const onProgress = vi.fn();

    const result = await run(
      { rootId: "1", depth: 5, bundleSlug: "root" },
      { onProgress, isCancelled: () => false },
    );

    const stages = onProgress.mock.calls
      .map(([patch]) => patch.stage)
      .filter(Boolean);
    expect(stages).toEqual([
      "resolving-root",
      "listing-descendants",
      "fetching-pages",
      "converting-markdown",
      "building-archive",
    ]);
    expect(result.zipBuffer).toBe(FAKE_BUFFER);
    expect(result.exportedCount).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(buildZipBuffer).toHaveBeenCalledWith("root", expect.any(Map));
  });

  it("throws ExportFailed when the root page read fails", async () => {
    const { run } = await import("../../src/job/pipeline");
    const { ExportFailed } = await import("../../src/job/errors");
    vi.mocked(getPage)
      .mockReset()
      .mockRejectedValue(new Error("403 Forbidden"));

    await expect(
      run(
        { rootId: "1", depth: 5, bundleSlug: "root" },
        { onProgress: vi.fn(), isCancelled: () => false },
      ),
    ).rejects.toBeInstanceOf(ExportFailed);
  });

  it("skips individual page fetch failures and records them", async () => {
    const { run } = await import("../../src/job/pipeline");
    vi.mocked(getDescendantIds).mockReset().mockResolvedValue(["2", "3"]);
    vi.mocked(getPage)
      .mockReset()
      .mockImplementation(async (pageId: string) => {
        if (pageId === "2") {
          throw new Error("410 Gone");
        }
        return { ...rootPage, id: pageId };
      });

    const result = await run(
      { rootId: "1", depth: 5, bundleSlug: "root" },
      { onProgress: vi.fn(), isCancelled: () => false },
    );

    expect(result.skipped).toEqual([
      { id: "2", title: null, reason: "410 Gone" },
    ]);
    expect(result.exportedCount).toBe(2);
  });

  it("throws ExportCancelled and stops fetching remaining pages when cancelled mid-loop", async () => {
    const { run } = await import("../../src/job/pipeline");
    const { ExportCancelled } = await import("../../src/job/errors");
    vi.mocked(getDescendantIds).mockReset().mockResolvedValue(["2", "3"]);

    await expect(
      run(
        { rootId: "1", depth: 5, bundleSlug: "root" },
        { onProgress: vi.fn(), isCancelled: () => true },
      ),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(getPage).toHaveBeenCalledTimes(1);
  });
});
