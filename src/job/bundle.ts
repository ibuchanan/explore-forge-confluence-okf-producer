import { type ProblemDetails, ResultAsync } from "@forge-ahead/errors";
import { stringify } from "yaml";
import { ZipFile } from "yazl";
import { slugify } from "../util/pageUrl";
import { exportFailed } from "./errors";
import type {
  BundlePage,
  BundlePageMap,
  OkfConceptFrontmatter,
  SkippedPage,
} from "./types";

export function buildTree(pages: BundlePageMap): void {
  for (const page of pages.values()) {
    if (page.parentId && pages.has(page.parentId)) {
      pages.get(page.parentId)?.children.push(page.id);
    }
  }
  for (const page of pages.values()) {
    page.children.sort((a, b) => {
      const titleA = pages.get(a)?.title ?? "";
      const titleB = pages.get(b)?.title ?? "";
      return titleA.localeCompare(titleB);
    });
  }
}

export function assignPaths(pages: BundlePageMap, rootId: string): void {
  const root = pages.get(rootId);
  if (!root) {
    return;
  }
  root.slug = `${slugify(root.title)}-${root.id}`;
  root.conceptPath = `pages/${root.slug}.md`;

  const queue = [rootId];
  while (queue.length > 0) {
    const pageId = queue.shift();
    if (!pageId) {
      continue;
    }
    const page = pages.get(pageId);
    if (!page) {
      continue;
    }
    const childrenDir = page.conceptPath.slice(0, -".md".length);
    for (const childId of page.children) {
      const child = pages.get(childId);
      if (!child) {
        continue;
      }
      child.slug = `${slugify(child.title)}-${child.id}`;
      child.conceptPath = `${childrenDir}/${child.slug}.md`;
      queue.push(childId);
    }
  }
}

function renderFrontmatter(data: object): string {
  const dumped = stringify(data, { sortMapEntries: false });
  return `---\n${dumped}---\n`;
}

function dedupeLeadingH1(markdown: string, title: string): string {
  const text = markdown.replace(/^\n+/, "");
  if (!text) {
    return `# ${title}\n`;
  }
  const firstLine = (text.split("\n", 1)[0] ?? "").trim();
  const heading = firstLine.match(/^#\s+(.*)$/);
  if (
    heading &&
    (heading[1] ?? "").trim().toLowerCase() === title.trim().toLowerCase()
  ) {
    return text;
  }
  return `# ${title}\n\n${text}`;
}

function extractDescription(markdown: string | null, limit = 280): string {
  if (!markdown) {
    return "Content unavailable.";
  }
  for (const rawLine of markdown.split("\n")) {
    let text = rawLine.trim();
    if (!text) {
      continue;
    }
    text = text
      .replace(/^#+\s*/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`>]/g, "")
      .trim();
    if (!text) {
      continue;
    }
    if (text.length > limit) {
      const truncated = text.slice(0, limit);
      const lastSpace = truncated.lastIndexOf(" ");
      text = `${lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated}…`;
    }
    return text;
  }
  return "No content.";
}

function relativeChildPath(
  parentConceptPath: string,
  childConceptPath: string,
): string {
  const parentDir = parentConceptPath.split("/").slice(0, -1).join("/");
  return parentDir
    ? childConceptPath.slice(parentDir.length + 1)
    : childConceptPath;
}

export function renderConceptDocument(
  page: BundlePage,
  markdown: string | null,
  conversionError: string | null,
  pages: BundlePageMap,
  spaceKeyMap: Map<string, string>,
  exportedAt: string,
): string {
  const frontmatter: OkfConceptFrontmatter = {
    type: "Confluence Page",
    title: page.title,
    description: extractDescription(markdown),
    resource: page.webUrl,
    timestamp: exportedAt,
    confluence: {
      page_id: page.id,
      space_id: page.spaceId,
      space_key: spaceKeyMap.get(page.spaceId) ?? "",
      parent_id: page.parentId,
      version: page.version,
      status: page.status,
      exported_at: exportedAt,
    },
  };
  if (page.labels.length > 0) {
    frontmatter.tags = page.labels;
  }

  const bodyCore = conversionError
    ? `# ${page.title}\n\n> **Warning:** Markdown conversion failed for this page (${conversionError}).`
    : dedupeLeadingH1(markdown ?? "", page.title);

  const sections = [bodyCore];

  if (page.children.length > 0) {
    const lines = ["# Child pages", ""];
    for (const childId of page.children) {
      const child = pages.get(childId);
      if (!child) {
        continue;
      }
      lines.push(
        `* [${child.title}](${relativeChildPath(page.conceptPath, child.conceptPath)})`,
      );
    }
    sections.push(lines.join("\n"));
  }

  sections.push(
    `# Citations\n\n[1] [Original Confluence page](${page.webUrl})`,
  );

  return `${renderFrontmatter(frontmatter)}\n${sections.join("\n\n")}\n`;
}

export function renderDirIndex(page: BundlePage, pages: BundlePageMap): string {
  const overviewName = page.conceptPath.split("/").pop();
  const lines = [
    `# ${page.title} — Contents`,
    "",
    `* [${page.title} (overview)](../${overviewName})`,
    "",
  ];
  for (const childId of page.children) {
    const child = pages.get(childId);
    if (!child) {
      continue;
    }
    lines.push(`* [${child.title}](${child.conceptPath.split("/").pop()})`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRootIndex(
  rootPage: BundlePage,
  bundleTitle: string,
): string {
  const frontmatter = { okf_version: "0.1" };
  const body = `# ${bundleTitle}\n\n* [${rootPage.title}](${rootPage.conceptPath})\n`;
  return `${renderFrontmatter(frontmatter)}\n${body}`;
}

export function renderLog(
  rootPage: BundlePage,
  depth: number,
  exportedCount: number,
  skipped: SkippedPage[],
  dateStr: string,
): string {
  const lines = [
    "# Bundle Update Log",
    "",
    `## ${dateStr}`,
    `* **Export**: Created from Confluence page tree rooted at [${rootPage.title}](${rootPage.webUrl}).`,
    `* **Scope**: Included pages up to depth ${depth}.`,
    `* **Result**: Exported ${exportedCount} pages, skipped ${skipped.length} pages.`,
  ];
  for (const entry of skipped) {
    lines.push(
      `  * Skipped: ${entry.id} - ${entry.title ?? "unknown"} (${entry.reason})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildZipBuffer(
  bundleSlug: string,
  files: Map<string, string>,
): ResultAsync<Buffer, ProblemDetails> {
  const promise = new Promise<Buffer>((resolve, reject) => {
    const zipFile = new ZipFile();
    for (const [relativePath, content] of files) {
      zipFile.addBuffer(
        Buffer.from(content, "utf-8"),
        `${bundleSlug}/${relativePath}`,
      );
    }

    const chunks: Buffer[] = [];
    zipFile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipFile.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zipFile.outputStream.on("error", reject);
    zipFile.end();
  });

  return ResultAsync.fromPromise(promise, (exc) =>
    exportFailed(
      `Failed to build archive: ${(exc as Error).message}`,
    )._unsafeUnwrapErr(),
  );
}
