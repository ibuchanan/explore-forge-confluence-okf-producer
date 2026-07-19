import { ok } from "@forge-ahead/errors";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import yauzl from "yauzl";
import {
  buildOkfBundleArchive,
  type OkfBundleBuilderAdapters,
} from "../../src/job/bundle";
import { exportFailed } from "../../src/job/errors";
import type { ConfluencePage, SkippedPage } from "../../src/job/types";

function readZipEntries(buffer: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip buffer"));
        return;
      }

      const entries = new Map<string, string>();
      zipfile.on("entry", (entry) => {
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(streamErr ?? new Error(`Failed to read ${entry.fileName}`));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zipfile.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

function splitFrontmatter(document: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = document.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Document has no frontmatter block:\n${document}`);
  }
  const [, frontmatterYaml, body] = match;
  return {
    frontmatter: parseYaml(frontmatterYaml ?? "") as Record<string, unknown>,
    body: body ?? "",
  };
}

function requireEntry(entries: Map<string, string>, path: string): string {
  const entry = entries.get(path);
  if (entry === undefined) {
    throw new Error(`Missing zip entry: ${path}`);
  }
  return entry;
}

function makePage(overrides: Partial<ConfluencePage>): ConfluencePage {
  return {
    id: "1",
    title: "Untitled",
    parentId: null,
    spaceId: "10",
    version: 1,
    status: "current",
    webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/Untitled",
    html: "<p>Body</p>",
    labels: [],
    ...overrides,
  };
}

function createAdapters(
  overrides: Partial<OkfBundleBuilderAdapters> = {},
): OkfBundleBuilderAdapters {
  return {
    convertPageHtml: vi.fn((_html, currentPath) =>
      ok(
        currentPath === "pages/apex-hub-1.md"
          ? "# APEX Hub\n\nSome converted body text."
          : `Converted body for ${currentPath}.`,
      ),
    ),
    getSpaceKey: vi.fn(async () => ok("KEY")),
    onProgress: vi.fn(),
    ...overrides,
  };
}

const rootPage = makePage({
  id: "1",
  title: "APEX Hub",
  spaceId: "10",
  version: 4,
  webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/APEX+Hub",
  labels: ["how-to"],
});

const initialSkipped: SkippedPage[] = [
  { id: "99", title: "Draft page", reason: "403 Forbidden" },
];

function sourcePages(): ConfluencePage[] {
  return [
    rootPage,
    makePage({
      id: "2",
      title: "Zebra",
      parentId: "1",
      webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/2/Zebra",
    }),
    makePage({
      id: "3",
      title: "Alpha",
      parentId: "1",
      webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/3/Alpha",
    }),
  ];
}

async function buildArchiveFixture(adapters = createAdapters()): Promise<{
  adapters: OkfBundleBuilderAdapters;
  entries: Map<string, string>;
  exportedCount: number;
  skipped: SkippedPage[];
}> {
  const result = await buildOkfBundleArchive(
    {
      pages: sourcePages(),
      rootId: "1",
      depth: 5,
      bundleSlug: "apex-hub-export",
      initialSkipped,
    },
    adapters,
  );
  const archive = result._unsafeUnwrap();
  return {
    adapters,
    entries: await readZipEntries(archive.zipBuffer),
    exportedCount: archive.exportedCount,
    skipped: archive.skipped,
  };
}

describe("buildOkfBundleArchive archive layout", () => {
  it("packages Concept Documents, indexes, and the update log under one bundle root", async () => {
    const { entries, exportedCount, skipped } = await buildArchiveFixture();

    expect(exportedCount).toBe(3);
    expect(skipped).toEqual(initialSkipped);
    expect([...entries.keys()].sort()).toEqual([
      "apex-hub-export/index.md",
      "apex-hub-export/log.md",
      "apex-hub-export/pages/apex-hub-1.md",
      "apex-hub-export/pages/apex-hub-1/alpha-3.md",
      "apex-hub-export/pages/apex-hub-1/index.md",
      "apex-hub-export/pages/apex-hub-1/zebra-2.md",
    ]);
  });
});

describe("buildOkfBundleArchive Concept Documents", () => {
  it("renders Concept Document frontmatter, body, children, and citation", async () => {
    const { entries } = await buildArchiveFixture();
    const rootDoc = requireEntry(
      entries,
      "apex-hub-export/pages/apex-hub-1.md",
    );
    const { frontmatter, body } = splitFrontmatter(rootDoc);

    expect(frontmatter).toMatchObject({
      type: "Confluence Page",
      title: "APEX Hub",
      description: "APEX Hub",
      resource: rootPage.webUrl,
      tags: ["how-to"],
      confluence: {
        page_id: "1",
        space_id: "10",
        space_key: "KEY",
        parent_id: null,
        version: 4,
        status: "current",
      },
    });
    expect(body.match(/^# APEX Hub$/gm)).toHaveLength(1);
    expect(body).toContain("Some converted body text.");
    expect(body).toContain("* [Alpha](apex-hub-1/alpha-3.md)");
    expect(body).toContain("* [Zebra](apex-hub-1/zebra-2.md)");
    expect(body).toContain(
      `# Citations\n\n[1] [Original Confluence page](${rootPage.webUrl})`,
    );
  });
});

describe("buildOkfBundleArchive navigation files", () => {
  it("renders Page Tree Layout indexes and the bundle update log", async () => {
    const { entries } = await buildArchiveFixture();
    const dirIndex = requireEntry(
      entries,
      "apex-hub-export/pages/apex-hub-1/index.md",
    );
    expect(dirIndex.startsWith("---")).toBe(false);
    expect(dirIndex).toContain("* [APEX Hub (overview)](../apex-hub-1.md)");
    expect(dirIndex.indexOf("[Alpha]")).toBeLessThan(
      dirIndex.indexOf("[Zebra]"),
    );

    const rootIndex = requireEntry(entries, "apex-hub-export/index.md");
    expect(splitFrontmatter(rootIndex).frontmatter).toEqual({
      okf_version: "0.1",
    });
    expect(rootIndex).toContain("[APEX Hub](pages/apex-hub-1.md)");

    const log = requireEntry(entries, "apex-hub-export/log.md");
    expect(log).toContain("* **Scope**: Included pages up to depth 5.");
    expect(log).toContain("* **Result**: Exported 3 pages, skipped 1 pages.");
    expect(log).toContain("Skipped: 99 - Draft page (403 Forbidden)");
  });
});

describe("buildOkfBundleArchive adapters", () => {
  it("reports builder stages and gives conversion the assigned path map", async () => {
    const { adapters } = await buildArchiveFixture();
    expect(adapters.onProgress).toHaveBeenCalledWith({
      stage: "converting-markdown",
    });
    expect(adapters.onProgress).toHaveBeenCalledWith({
      stage: "building-archive",
    });
    expect(adapters.getSpaceKey).toHaveBeenCalledTimes(1);

    const convertCalls = vi.mocked(adapters.convertPageHtml).mock.calls;
    expect(convertCalls[0]?.[1]).toBe("pages/apex-hub-1.md");
    expect(convertCalls[0]?.[2].get("3")).toBe("pages/apex-hub-1/alpha-3.md");
  });
});

describe("buildOkfBundleArchive conversion resilience", () => {
  it("embeds conversion failures without marking the page skipped", async () => {
    const adapters = createAdapters({
      convertPageHtml: vi.fn(() => exportFailed("unexpected token")),
    });

    const result = await buildOkfBundleArchive(
      {
        pages: [rootPage],
        rootId: "1",
        depth: 1,
        bundleSlug: "apex-hub-export",
        initialSkipped: [],
      },
      adapters,
    );
    const archive = result._unsafeUnwrap();
    const entries = await readZipEntries(archive.zipBuffer);
    const { frontmatter, body } = splitFrontmatter(
      entries.get("apex-hub-export/pages/apex-hub-1.md") ?? "",
    );

    expect(archive.exportedCount).toBe(1);
    expect(archive.skipped).toEqual([]);
    expect(frontmatter.description).toBe("Content unavailable.");
    expect(body).toContain(
      "> **Warning:** Markdown conversion failed for this page (unexpected token).",
    );
  });

  it("embeds a missing Export View warning without invoking conversion", async () => {
    const adapters = createAdapters();
    const result = await buildOkfBundleArchive(
      {
        pages: [makePage({ ...rootPage, html: null })],
        rootId: "1",
        depth: 1,
        bundleSlug: "apex-hub-export",
        initialSkipped: [],
      },
      adapters,
    );
    const archive = result._unsafeUnwrap();
    const entries = await readZipEntries(archive.zipBuffer);
    const { body } = splitFrontmatter(
      entries.get("apex-hub-export/pages/apex-hub-1.md") ?? "",
    );

    expect(adapters.convertPageHtml).not.toHaveBeenCalled();
    expect(body).toContain(
      "> **Warning:** Markdown conversion failed for this page (export_view HTML was not available for this page.).",
    );
  });
});

describe("buildOkfBundleArchive provenance resilience", () => {
  it("keeps space key lookup best effort", async () => {
    const adapters = createAdapters({
      getSpaceKey: vi.fn(async () => exportFailed("403 Forbidden")),
    });

    const result = await buildOkfBundleArchive(
      {
        pages: [rootPage],
        rootId: "1",
        depth: 1,
        bundleSlug: "apex-hub-export",
        initialSkipped: [],
      },
      adapters,
    );
    const archive = result._unsafeUnwrap();
    const entries = await readZipEntries(archive.zipBuffer);
    const { frontmatter } = splitFrontmatter(
      entries.get("apex-hub-export/pages/apex-hub-1.md") ?? "",
    );

    expect(frontmatter).toMatchObject({
      confluence: { space_key: "" },
    });
  });
});

describe("buildOkfBundleArchive validation", () => {
  it("fails when the root Source Page is missing from the bundle input", async () => {
    const result = await buildOkfBundleArchive(
      {
        pages: [makePage({ id: "2" })],
        rootId: "1",
        depth: 1,
        bundleSlug: "apex-hub-export",
        initialSkipped: [],
      },
      createAdapters(),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().detail).toBe(
      "Root page 1 is missing from the bundle.",
    );
  });
});
