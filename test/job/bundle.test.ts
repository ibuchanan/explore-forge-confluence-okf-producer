import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import yauzl from "yauzl";
import {
  assignPaths,
  buildTree,
  buildZipBuffer,
  renderConceptDocument,
  renderDirIndex,
  renderLog,
  renderRootIndex,
} from "../../src/job/bundle";
import type { BundlePage, BundlePageMap } from "../../src/job/types";

function readZipEntryNames(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip buffer"));
        return;
      }
      const names: string[] = [];
      zipfile.on("entry", (entry) => names.push(entry.fileName));
      zipfile.on("end", () => resolve(names));
      zipfile.on("error", reject);
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

function makePage(overrides: Partial<BundlePage>): BundlePage {
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
    children: [],
    slug: "",
    conceptPath: "",
    ...overrides,
  };
}

describe("buildTree", () => {
  it("populates each page's children from parentId, sorted by title", () => {
    const pages: BundlePageMap = new Map([
      ["1", makePage({ id: "1", title: "Root" })],
      ["2", makePage({ id: "2", title: "Zebra", parentId: "1" })],
      ["3", makePage({ id: "3", title: "Alpha", parentId: "1" })],
    ]);

    buildTree(pages);

    expect(pages.get("1")?.children).toEqual(["3", "2"]);
  });
});

describe("assignPaths", () => {
  it("assigns the root a pages/<slug>-<id>.md path and nests children under it", () => {
    const pages: BundlePageMap = new Map([
      ["1", makePage({ id: "1", title: "APEX Hub" })],
      ["2", makePage({ id: "2", title: "Getting Started", parentId: "1" })],
    ]);

    buildTree(pages);
    assignPaths(pages, "1");

    expect(pages.get("1")?.conceptPath).toBe("pages/apex-hub-1.md");
    expect(pages.get("2")?.conceptPath).toBe(
      "pages/apex-hub-1/getting-started-2.md",
    );
  });
});

describe("renderConceptDocument", () => {
  it("renders frontmatter, provenance, converted body, and a source citation", () => {
    const page = makePage({
      id: "1",
      title: "APEX Hub",
      spaceId: "10",
      version: 4,
      webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/APEX+Hub",
      conceptPath: "pages/apex-hub-1.md",
    });
    const pages: BundlePageMap = new Map([["1", page]]);
    const spaceKeyMap = new Map([["10", "KEY"]]);
    const exportedAt = "2026-07-06T12:40:00Z";

    const doc = renderConceptDocument(
      page,
      "Some converted body text.",
      null,
      pages,
      spaceKeyMap,
      exportedAt,
    );
    const { frontmatter, body } = splitFrontmatter(doc);

    expect(frontmatter).toMatchObject({
      type: "Confluence Page",
      title: "APEX Hub",
      description: "Some converted body text.",
      resource: page.webUrl,
      timestamp: exportedAt,
      confluence: {
        page_id: "1",
        space_id: "10",
        space_key: "KEY",
        parent_id: null,
        version: 4,
        status: "current",
        exported_at: exportedAt,
      },
    });
    expect(body).toContain("# APEX Hub");
    expect(body).toContain("Some converted body text.");
    expect(body).toContain(
      `# Citations\n\n[1] [Original Confluence page](${page.webUrl})`,
    );
    expect(body).not.toContain("# Child pages");
  });

  it("lists child pages as relative links when children exist", () => {
    const root = makePage({
      id: "1",
      title: "APEX Hub",
      children: ["2"],
      conceptPath: "pages/apex-hub-1.md",
    });
    const child = makePage({
      id: "2",
      title: "Getting Started",
      parentId: "1",
      conceptPath: "pages/apex-hub-1/getting-started-2.md",
    });
    const pages: BundlePageMap = new Map([
      ["1", root],
      ["2", child],
    ]);

    const doc = renderConceptDocument(
      root,
      "Body.",
      null,
      pages,
      new Map(),
      "2026-07-06T12:40:00Z",
    );
    const { body } = splitFrontmatter(doc);

    expect(body).toContain("# Child pages");
    expect(body).toContain(
      "* [Getting Started](apex-hub-1/getting-started-2.md)",
    );
  });

  it("includes tags in frontmatter only when labels are present", () => {
    const pages: BundlePageMap = new Map();
    const withLabels = makePage({ id: "1", labels: ["how-to", "gday"] });
    const withoutLabels = makePage({ id: "2", labels: [] });

    const { frontmatter: withTags } = splitFrontmatter(
      renderConceptDocument(
        withLabels,
        "Body.",
        null,
        pages,
        new Map(),
        "2026-07-06T12:40:00Z",
      ),
    );
    const { frontmatter: withoutTags } = splitFrontmatter(
      renderConceptDocument(
        withoutLabels,
        "Body.",
        null,
        pages,
        new Map(),
        "2026-07-06T12:40:00Z",
      ),
    );

    expect(withTags.tags).toEqual(["how-to", "gday"]);
    expect(withoutTags).not.toHaveProperty("tags");
  });

  it("renders a warning body instead of markdown when conversion failed", () => {
    const page = makePage({ id: "1", title: "APEX Hub" });
    const pages: BundlePageMap = new Map([["1", page]]);

    const doc = renderConceptDocument(
      page,
      null,
      "unexpected token",
      pages,
      new Map(),
      "2026-07-06T12:40:00Z",
    );
    const { body } = splitFrontmatter(doc);

    expect(body).toContain(
      "> **Warning:** Markdown conversion failed for this page (unexpected token).",
    );
  });

  it("does not duplicate a leading H1 that already matches the page title", () => {
    const page = makePage({ id: "1", title: "APEX Hub" });
    const pages: BundlePageMap = new Map([["1", page]]);

    const doc = renderConceptDocument(
      page,
      "# APEX Hub\n\nBody text.",
      null,
      pages,
      new Map(),
      "2026-07-06T12:40:00Z",
    );
    const { body } = splitFrontmatter(doc);

    expect(body.match(/^# APEX Hub$/gm)).toHaveLength(1);
  });

  it("extracts a plain-text description from the first meaningful markdown line", () => {
    const page = makePage({ id: "1", title: "APEX Hub" });
    const pages: BundlePageMap = new Map([["1", page]]);

    const doc = renderConceptDocument(
      page,
      "\n\n**Welcome** to the [APEX](https://example.com) hub.",
      null,
      pages,
      new Map(),
      "2026-07-06T12:40:00Z",
    );
    const { frontmatter } = splitFrontmatter(doc);

    expect(frontmatter.description).toBe("Welcome to the APEX hub.");
  });

  it("falls back to 'Content unavailable.' when there is no markdown", () => {
    const page = makePage({ id: "1", title: "APEX Hub" });
    const pages: BundlePageMap = new Map([["1", page]]);

    const doc = renderConceptDocument(
      page,
      null,
      "boom",
      pages,
      new Map(),
      "2026-07-06T12:40:00Z",
    );
    const { frontmatter } = splitFrontmatter(doc);

    expect(frontmatter.description).toBe("Content unavailable.");
  });
});

describe("renderRootIndex", () => {
  it("carries only okf_version frontmatter and links to the root concept document", () => {
    const root = makePage({
      id: "1",
      title: "APEX Hub",
      conceptPath: "pages/apex-hub-1.md",
    });

    const doc = renderRootIndex(root, "APEX Hub Export");
    const { frontmatter, body } = splitFrontmatter(doc);

    expect(frontmatter).toEqual({ okf_version: "0.1" });
    expect(body).toContain("# APEX Hub Export");
    expect(body).toContain("[APEX Hub](pages/apex-hub-1.md)");
  });
});

describe("renderDirIndex", () => {
  it("carries no frontmatter and links to the overview and children", () => {
    const root = makePage({
      id: "1",
      title: "APEX Hub",
      children: ["2"],
      conceptPath: "pages/apex-hub-1.md",
    });
    const child = makePage({
      id: "2",
      title: "Getting Started",
      parentId: "1",
      conceptPath: "pages/apex-hub-1/getting-started-2.md",
    });
    const pages: BundlePageMap = new Map([
      ["1", root],
      ["2", child],
    ]);

    const doc = renderDirIndex(root, pages);

    expect(doc.startsWith("---")).toBe(false);
    expect(doc).toContain("* [APEX Hub (overview)](../apex-hub-1.md)");
    expect(doc).toContain("* [Getting Started](getting-started-2.md)");
  });
});

describe("renderLog", () => {
  it("summarizes the export and lists skipped pages with their reasons", () => {
    const root = makePage({
      id: "1",
      title: "APEX Hub",
      webUrl: "https://example.atlassian.net/wiki/spaces/KEY/pages/1/APEX+Hub",
    });

    const log = renderLog(
      root,
      5,
      42,
      [{ id: "99", title: "Draft page", reason: "403 Forbidden" }],
      "2026-07-06",
    );

    expect(log).toContain("## 2026-07-06");
    expect(log).toContain(
      `* **Export**: Created from Confluence page tree rooted at [APEX Hub](${root.webUrl}).`,
    );
    expect(log).toContain("* **Scope**: Included pages up to depth 5.");
    expect(log).toContain("* **Result**: Exported 42 pages, skipped 1 pages.");
    expect(log).toContain("Skipped: 99 - Draft page (403 Forbidden)");
  });
});

describe("buildZipBuffer", () => {
  it("packages files under exactly one <bundleSlug>/ root directory", async () => {
    const files = new Map([
      ["index.md", "# Bundle\n"],
      ["pages/apex-hub-1.md", "# APEX Hub\n"],
    ]);

    const zipBuffer = await buildZipBuffer("apex-hub-export", files);
    const names = await readZipEntryNames(zipBuffer);

    expect(names.sort()).toEqual([
      "apex-hub-export/index.md",
      "apex-hub-export/pages/apex-hub-1.md",
    ]);
  });
});
