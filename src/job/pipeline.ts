import {
  assignPaths,
  buildTree,
  buildZipBuffer,
  renderConceptDocument,
  renderDirIndex,
  renderLog,
  renderRootIndex,
} from "./bundle";
import { getPage, getSpaceKey } from "./confluenceClient";
import { convertPageHtml } from "./convert";
import { ExportCancelled, ExportFailed } from "./errors";
import type { BundlePageMap, ExportJob, SkippedPage } from "./types";

// Root-page validation and descendant enumeration already happened as the
// user, synchronously, in the resolver (see resolvers/export.ts) before this
// job existed -- `pageIds` is that pre-vetted set. Everything here runs
// asApp() in an async queue consumer, which is the only way to get a longer
// execution budget than a resolver's 25-second cap, at the cost of losing
// asUser() auth (Forge has no invocation mode with both).
export interface PipelineInput {
  pageIds: string[];
  rootId: string;
  depth: number;
  bundleSlug: string;
  initialSkipped: SkippedPage[];
}

export interface PipelineHooks {
  onProgress: (patch: Partial<ExportJob>) => void;
  isCancelled: () => boolean | Promise<boolean>;
}

export interface PipelineResult {
  zipBuffer: Buffer;
  exportedCount: number;
  skipped: SkippedPage[];
}

const PROGRESS_REPORT_INTERVAL = 5;

export async function run(
  { pageIds, rootId, depth, bundleSlug, initialSkipped }: PipelineInput,
  { onProgress, isCancelled }: PipelineHooks,
): Promise<PipelineResult> {
  const skipped: SkippedPage[] = [...initialSkipped];
  const pages: BundlePageMap = new Map();

  onProgress({ stage: "fetching-pages", exportedCount: 0 });
  for (let i = 0; i < pageIds.length; i += 1) {
    if (await isCancelled()) {
      throw new ExportCancelled();
    }
    const pageId = pageIds[i];
    if (!pageId) {
      continue;
    }
    try {
      const page = await getPage("app", pageId);
      pages.set(page.id, { ...page, children: [], slug: "", conceptPath: "" });
    } catch (exc) {
      skipped.push({ id: pageId, title: null, reason: (exc as Error).message });
    }
    const isLast = i === pageIds.length - 1;
    if (isLast || (i + 1) % PROGRESS_REPORT_INTERVAL === 0) {
      onProgress({ exportedCount: pages.size, warnings: [...skipped] });
    }
  }

  const rootPage = pages.get(rootId);
  if (!rootPage) {
    const reason = skipped.find((entry) => entry.id === rootId)?.reason;
    throw new ExportFailed(
      `Root page ${rootId} could not be read while building the archive${
        reason ? `: ${reason}` : ""
      }.`,
    );
  }

  buildTree(pages);
  assignPaths(pages, rootId);

  const idToPath = new Map<string, string>();
  for (const [id, page] of pages) {
    idToPath.set(id, page.conceptPath);
  }

  onProgress({ stage: "converting-markdown" });
  const spaceKeyMap = new Map<string, string>();
  for (const page of pages.values()) {
    if (!spaceKeyMap.has(page.spaceId)) {
      try {
        spaceKeyMap.set(page.spaceId, await getSpaceKey("app", page.spaceId));
      } catch {
        spaceKeyMap.set(page.spaceId, "");
      }
    }
  }

  const exportedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const files = new Map<string, string>();

  for (const page of pages.values()) {
    let markdown: string | null = null;
    let conversionError: string | null = null;
    if (page.html) {
      try {
        markdown = convertPageHtml(page.html, page.conceptPath, idToPath);
      } catch (exc) {
        conversionError = (exc as Error).message;
      }
    } else {
      conversionError = "export_view HTML was not available for this page.";
    }

    files.set(
      page.conceptPath,
      renderConceptDocument(
        page,
        markdown,
        conversionError,
        pages,
        spaceKeyMap,
        exportedAt,
      ),
    );

    if (page.children.length > 0) {
      const indexDir = page.conceptPath.slice(0, -".md".length);
      files.set(`${indexDir}/index.md`, renderDirIndex(page, pages));
    }
  }

  files.set("index.md", renderRootIndex(rootPage, rootPage.title));
  files.set(
    "log.md",
    renderLog(rootPage, depth, pages.size, skipped, exportedAt.slice(0, 10)),
  );

  onProgress({ stage: "building-archive" });
  const zipBuffer = await buildZipBuffer(bundleSlug, files);

  return { zipBuffer, exportedCount: pages.size, skipped };
}
