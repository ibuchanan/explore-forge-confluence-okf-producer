import {
  assignPaths,
  buildTree,
  buildZipBuffer,
  renderConceptDocument,
  renderDirIndex,
  renderLog,
  renderRootIndex,
} from "./bundle";
import { getDescendantIds, getPage, getSpaceKey } from "./confluenceClient";
import { convertPageHtml } from "./convert";
import { ExportCancelled, ExportFailed } from "./errors";
import type {
  BundlePage,
  BundlePageMap,
  ExportJob,
  SkippedPage,
} from "./types";

export interface PipelineInput {
  rootId: string;
  depth: number;
  bundleSlug: string;
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
  { rootId, depth, bundleSlug }: PipelineInput,
  { onProgress, isCancelled }: PipelineHooks,
): Promise<PipelineResult> {
  onProgress({ stage: "resolving-root" });
  let rootPage: BundlePage;
  try {
    const page = await getPage(rootId);
    rootPage = { ...page, children: [], slug: "", conceptPath: "" };
  } catch (exc) {
    throw new ExportFailed(`Root page read failed: ${(exc as Error).message}`);
  }

  const pages: BundlePageMap = new Map([[rootPage.id, rootPage]]);

  onProgress({ stage: "listing-descendants" });
  const skipped: SkippedPage[] = [];
  let descendantIds: string[];
  try {
    descendantIds = await getDescendantIds(rootId, depth, {
      isCancelled,
      onSkippedBranch: (pageId, exc) => {
        skipped.push({
          id: pageId,
          title: null,
          reason: (exc as Error).message,
        });
      },
    });
  } catch (exc) {
    if (exc instanceof ExportCancelled) {
      throw exc;
    }
    throw new ExportFailed(
      `Descendant listing failed: ${(exc as Error).message}`,
    );
  }

  onProgress({ stage: "fetching-pages", exportedCount: 1 });
  for (let i = 0; i < descendantIds.length; i += 1) {
    if (await isCancelled()) {
      throw new ExportCancelled();
    }
    const descendantId = descendantIds[i];
    if (!descendantId) {
      continue;
    }
    try {
      const page = await getPage(descendantId);
      pages.set(page.id, { ...page, children: [], slug: "", conceptPath: "" });
    } catch (exc) {
      skipped.push({
        id: descendantId,
        title: null,
        reason: (exc as Error).message,
      });
    }
    const isLast = i === descendantIds.length - 1;
    if (isLast || (i + 1) % PROGRESS_REPORT_INTERVAL === 0) {
      onProgress({ exportedCount: pages.size, warnings: [...skipped] });
    }
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
        spaceKeyMap.set(page.spaceId, await getSpaceKey(page.spaceId));
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
