import {
  type ProblemDetails,
  type Result,
  ResultAsync,
} from "@forge-ahead/errors";
import { stringify } from "yaml";
import { ZipFile } from "yazl";
import { slugify } from "../util/pageUrl";
import { exportFailed } from "./errors";
import type {
  BundlePage,
  BundlePageMap,
  ConfluencePage,
  OkfConceptFrontmatter,
  SkippedPage,
} from "./types";

export interface OkfBundleBuilderInput {
  pages: ConfluencePage[];
  rootId: string;
  depth: number;
  bundleSlug: string;
  initialSkipped: SkippedPage[];
}

export interface OkfBundleBuilderAdapters {
  convertPageHtml: (
    html: string | null,
    currentPath: string,
    idToPath: Map<string, string>,
  ) => Result<string | null, ProblemDetails>;
  getSpaceKey: (spaceId: string) => Promise<Result<string, ProblemDetails>>;
  onProgress?: (progress: OkfBundleBuildProgress) => void | Promise<void>;
}

export interface OkfBundleArchive {
  zipBuffer: Buffer;
  exportedCount: number;
  skipped: SkippedPage[];
}

export interface OkfBundleBuildProgress {
  stage: "converting-markdown" | "building-archive";
}

function toBundlePage(page: ConfluencePage): BundlePage {
  return { ...page, children: [], slug: "", conceptPath: "" };
}

function buildPageMap(pages: ConfluencePage[]): BundlePageMap {
  return new Map(pages.map((page) => [page.id, toBundlePage(page)]));
}

function buildTree(pages: BundlePageMap): void {
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

function assignPaths(pages: BundlePageMap, rootId: string): void {
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

async function buildSpaceKeyMap(
  pages: BundlePageMap,
  getSpaceKey: OkfBundleBuilderAdapters["getSpaceKey"],
): Promise<Map<string, string>> {
  const spaceKeyMap = new Map<string, string>();
  for (const page of pages.values()) {
    if (spaceKeyMap.has(page.spaceId)) {
      continue;
    }
    const spaceKeyResult = await getSpaceKey(page.spaceId);
    spaceKeyMap.set(
      page.spaceId,
      spaceKeyResult.isOk() ? spaceKeyResult.value : "",
    );
  }
  return spaceKeyMap;
}

function buildIdToPathMap(pages: BundlePageMap): Map<string, string> {
  const idToPath = new Map<string, string>();
  for (const [id, page] of pages) {
    idToPath.set(id, page.conceptPath);
  }
  return idToPath;
}

function renderConceptDocument(
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

function renderDirIndex(page: BundlePage, pages: BundlePageMap): string {
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

function renderRootIndex(rootPage: BundlePage, bundleTitle: string): string {
  const frontmatter = { okf_version: "0.1" };
  const body = `# ${bundleTitle}\n\n* [${rootPage.title}](${rootPage.conceptPath})\n`;
  return `${renderFrontmatter(frontmatter)}\n${body}`;
}

function renderLog(
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

function renderPageFile(
  page: BundlePage,
  pages: BundlePageMap,
  adapters: OkfBundleBuilderAdapters,
  spaceKeyMap: Map<string, string>,
  idToPath: Map<string, string>,
  exportedAt: string,
): string {
  let markdown: string | null = null;
  let conversionError: string | null = null;

  if (page.html) {
    const convertResult = adapters.convertPageHtml(
      page.html,
      page.conceptPath,
      idToPath,
    );
    markdown = convertResult.isOk() ? convertResult.value : null;
    conversionError = convertResult.isErr() ? convertResult.error.detail : null;
  } else {
    conversionError = "export_view HTML was not available for this page.";
  }

  return renderConceptDocument(
    page,
    markdown,
    conversionError,
    pages,
    spaceKeyMap,
    exportedAt,
  );
}

function addConceptFiles(
  files: Map<string, string>,
  pages: BundlePageMap,
  adapters: OkfBundleBuilderAdapters,
  spaceKeyMap: Map<string, string>,
  idToPath: Map<string, string>,
  exportedAt: string,
): void {
  for (const page of pages.values()) {
    files.set(
      page.conceptPath,
      renderPageFile(page, pages, adapters, spaceKeyMap, idToPath, exportedAt),
    );

    if (page.children.length > 0) {
      const indexDir = page.conceptPath.slice(0, -".md".length);
      files.set(`${indexDir}/index.md`, renderDirIndex(page, pages));
    }
  }
}

function renderBundleFiles(
  pages: BundlePageMap,
  rootPage: BundlePage,
  input: OkfBundleBuilderInput,
  adapters: OkfBundleBuilderAdapters,
  spaceKeyMap: Map<string, string>,
): Map<string, string> {
  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const idToPath = buildIdToPathMap(pages);
  const files = new Map<string, string>();
  addConceptFiles(files, pages, adapters, spaceKeyMap, idToPath, exportedAt);

  files.set("index.md", renderRootIndex(rootPage, rootPage.title));
  files.set(
    "log.md",
    renderLog(
      rootPage,
      input.depth,
      pages.size,
      input.initialSkipped,
      exportedAt.slice(0, 10),
    ),
  );
  return files;
}

function buildZipBuffer(
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

export async function buildOkfBundleArchive(
  input: OkfBundleBuilderInput,
  adapters: OkfBundleBuilderAdapters,
): Promise<Result<OkfBundleArchive, ProblemDetails>> {
  const pages = buildPageMap(input.pages);
  const rootPage = pages.get(input.rootId);
  if (!rootPage) {
    return exportFailed(
      `Root page ${input.rootId} is missing from the bundle.`,
    );
  }

  buildTree(pages);
  assignPaths(pages, input.rootId);

  await adapters.onProgress?.({ stage: "converting-markdown" });
  const spaceKeyMap = await buildSpaceKeyMap(pages, adapters.getSpaceKey);

  const files = renderBundleFiles(
    pages,
    rootPage,
    input,
    adapters,
    spaceKeyMap,
  );
  await adapters.onProgress?.({ stage: "building-archive" });
  const zipResult = await buildZipBuffer(input.bundleSlug, files);
  return zipResult.map((zipBuffer) => ({
    zipBuffer,
    exportedCount: pages.size,
    skipped: input.initialSkipped,
  }));
}
