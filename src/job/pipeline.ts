import type { ProblemDetails, Result } from "@forge-ahead/errors";
import { buildOkfBundleArchive } from "./bundle";
import { getPage, getSpaceKey } from "./confluenceClient";
import { convertPageHtml } from "./convert";
import { exportCancelled, exportFailed } from "./errors";
import type { ConfluencePage, ExportJobProgress, SkippedPage } from "./types";

// Root-page validation and descendant enumeration already happened as the
// user, synchronously, during Export Job Intake before this job existed --
// `pageIds` is that pre-vetted set. Everything here runs asApp() in an async
// queue consumer, which is the only way to get a longer execution budget than
// a resolver's 25-second cap, at the cost of losing asUser() auth (Forge has
// no invocation mode with both).
export interface PipelineInput {
  pageIds: string[];
  rootId: string;
  depth: number;
  bundleSlug: string;
  initialSkipped: SkippedPage[];
}

export interface PipelineHooks {
  onProgress: (progress: ExportJobProgress) => void | Promise<void>;
  isCancelled: () => boolean | Promise<boolean>;
}

export interface PipelineResult {
  zipBuffer: Buffer;
  exportedCount: number;
  skipped: SkippedPage[];
}

const PROGRESS_REPORT_INTERVAL = 5;

// Per-page fetch/conversion failures are recorded in `skipped` and the
// export continues -- only cancellation and a missing root page (after the
// fetch loop) fail the whole run.
export async function run(
  { pageIds, rootId, depth, bundleSlug, initialSkipped }: PipelineInput,
  { onProgress, isCancelled }: PipelineHooks,
): Promise<Result<PipelineResult, ProblemDetails>> {
  const skipped: SkippedPage[] = [...initialSkipped];
  const pages = new Map<string, ConfluencePage>();

  await onProgress({ stage: "fetching-pages", exportedCount: 0 });
  for (let i = 0; i < pageIds.length; i += 1) {
    if (await isCancelled()) {
      return exportCancelled();
    }
    const pageId = pageIds[i];
    if (!pageId) {
      continue;
    }
    const pageResult: Result<ConfluencePage, ProblemDetails> = await getPage(
      "app",
      pageId,
    );
    if (pageResult.isOk()) {
      const page = pageResult.value;
      pages.set(page.id, page);
    } else {
      skipped.push({
        id: pageId,
        title: null,
        reason: pageResult.error.detail,
      });
    }
    const isLast = i === pageIds.length - 1;
    if (isLast || (i + 1) % PROGRESS_REPORT_INTERVAL === 0) {
      await onProgress({ exportedCount: pages.size, warnings: [...skipped] });
    }
  }

  const rootPage = pages.get(rootId);
  if (!rootPage) {
    const reason = skipped.find((entry) => entry.id === rootId)?.reason;
    return exportFailed(
      `Root page ${rootId} could not be read while building the archive${
        reason ? `: ${reason}` : ""
      }.`,
    );
  }

  const archiveResult = await buildOkfBundleArchive(
    {
      pages: [...pages.values()],
      rootId,
      depth,
      bundleSlug,
      initialSkipped: skipped,
    },
    {
      convertPageHtml,
      getSpaceKey: async (spaceId) => await getSpaceKey("app", spaceId),
      onProgress,
    },
  );
  return archiveResult;
}
