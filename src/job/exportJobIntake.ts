import { err, ok, type ProblemDetails, type Result } from "@forge-ahead/errors";
import { exportFailed } from "./errors";
import type {
  ConfluencePage,
  ExportJob,
  ExportJobInput,
  SkippedPage,
} from "./types";
import { deriveSlugFromUrl, isSameSite, parsePageId } from "../util/pageUrl";

const MAX_DEPTH = 5;

export interface ExportJobIntakeRequest {
  accountId: string;
  siteUrl: string;
  rootUrl?: string | undefined;
  depth?: number | undefined;
  bundleSlug?: string | undefined;
}

export interface DescendantEnumerationHooks {
  onSkippedBranch?: (pageId: string, problem: ProblemDetails) => void;
}

export interface ExportJobIntakeAdapters {
  createJobId: () => string;
  readSourcePageAsUser: (
    pageId: string,
  ) => Promise<Result<ConfluencePage, ProblemDetails>>;
  readSourcePageAsApp: (
    pageId: string,
  ) => Promise<Result<ConfluencePage, ProblemDetails>>;
  enumerateDescendantSourcePages: (
    rootId: string,
    depth: number,
    hooks: DescendantEnumerationHooks,
  ) => Promise<Result<string[], ProblemDetails>>;
  createExportJob: (
    accountId: string,
    jobId: string,
    input: ExportJobInput,
  ) => Promise<Result<ExportJob, ProblemDetails>>;
  recordSkippedBranches: (
    accountId: string,
    jobId: string,
    skipped: SkippedPage[],
  ) => Promise<Result<ExportJob | null, ProblemDetails>>;
  recordLatestExportJob: (
    accountId: string,
    jobId: string,
  ) => Promise<Result<void, ProblemDetails>>;
  scheduleExportJob: (
    accountId: string,
    jobId: string,
  ) => Promise<{ queueJobId: string }>;
  attachQueueJob: (
    accountId: string,
    jobId: string,
    queueJobId: string,
  ) => Promise<Result<ExportJob | null, ProblemDetails>>;
}

export interface ExportJobIntakeStarted {
  jobId: string;
}

interface PreparedExportJobIntake {
  rootUrl: string;
  rootId: string;
  depth: number;
  bundleSlug: string;
}

interface EnumeratedSourcePages {
  pageIds: string[];
  skipped: SkippedPage[];
}

export async function startExportJobIntake(
  request: ExportJobIntakeRequest,
  adapters: ExportJobIntakeAdapters,
): Promise<Result<ExportJobIntakeStarted, ProblemDetails>> {
  const preparedResult = prepareExportJobIntake(request);
  if (preparedResult.isErr()) {
    return err(preparedResult.error);
  }
  const prepared = preparedResult.value;

  const rootReadResult = await ensureRootSourcePageReadable(
    prepared.rootId,
    adapters,
  );
  if (rootReadResult.isErr()) {
    return err(rootReadResult.error);
  }

  const enumerationResult = await enumerateSourcePages(prepared, adapters);
  if (enumerationResult.isErr()) {
    return err(enumerationResult.error);
  }

  return createAndScheduleExportJob(
    request.accountId,
    prepared,
    enumerationResult.value,
    adapters,
  );
}

function prepareExportJobIntake(
  request: ExportJobIntakeRequest,
): Result<PreparedExportJobIntake, ProblemDetails> {
  const rootUrl = String(request.rootUrl ?? "").trim();
  if (!rootUrl) {
    return exportFailed("A root page URL is required.", 400);
  }
  if (!isSameSite(rootUrl, request.siteUrl)) {
    return exportFailed("The root page URL must be on this site.", 400);
  }
  const rootId = parsePageId(rootUrl);
  if (!rootId) {
    return exportFailed("Could not find a page ID in that URL.", 400);
  }

  const requestedDepth = Number(request.depth);
  const depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(requestedDepth, 1), MAX_DEPTH)
    : MAX_DEPTH;

  const bundleSlug =
    String(request.bundleSlug ?? "").trim() || deriveSlugFromUrl(rootUrl);

  return ok({ rootUrl, rootId, depth, bundleSlug });
}

async function ensureRootSourcePageReadable(
  rootId: string,
  adapters: ExportJobIntakeAdapters,
): Promise<Result<void, ProblemDetails>> {
  // Export Job Intake is the last user-authenticated seam before archive
  // production moves to the async asApp() queue consumer.
  const userReadResult = await adapters.readSourcePageAsUser(rootId);
  if (userReadResult.isErr()) {
    return exportFailed(
      `Root page read failed: ${userReadResult.error.detail}`,
      userReadResult.error.status,
    );
  }

  const appReadResult = await adapters.readSourcePageAsApp(rootId);
  if (appReadResult.isErr()) {
    return exportFailed(
      "This page's space likely has view restrictions that don't include this app. " +
        "Ask a site or space admin to grant the app access, or choose a root page from " +
        `a space without view restrictions. (Root page read as the app failed: ${appReadResult.error.detail})`,
      appReadResult.error.status,
    );
  }

  return ok(undefined);
}

async function enumerateSourcePages(
  prepared: PreparedExportJobIntake,
  adapters: ExportJobIntakeAdapters,
): Promise<Result<EnumeratedSourcePages, ProblemDetails>> {
  const enumerationSkipped: SkippedPage[] = [];
  const descendantsResult = await adapters.enumerateDescendantSourcePages(
    prepared.rootId,
    prepared.depth,
    {
      onSkippedBranch: (pageId, problem) => {
        enumerationSkipped.push({
          id: pageId,
          title: null,
          reason: problem.detail,
        });
      },
    },
  );
  if (descendantsResult.isErr()) {
    return exportFailed(
      `Descendant listing failed: ${descendantsResult.error.detail}`,
      descendantsResult.error.status,
    );
  }

  return ok({
    pageIds: [prepared.rootId, ...descendantsResult.value],
    skipped: enumerationSkipped,
  });
}

async function createAndScheduleExportJob(
  accountId: string,
  prepared: PreparedExportJobIntake,
  enumerated: EnumeratedSourcePages,
  adapters: ExportJobIntakeAdapters,
): Promise<Result<ExportJobIntakeStarted, ProblemDetails>> {
  const jobId = adapters.createJobId();
  const jobInput: ExportJobInput = {
    rootUrl: prepared.rootUrl,
    rootId: prepared.rootId,
    depth: prepared.depth,
    bundleSlug: prepared.bundleSlug,
    pageIds: enumerated.pageIds,
  };
  const jobResult = await adapters.createExportJob(accountId, jobId, jobInput);
  if (jobResult.isErr()) {
    return exportFailed(
      `Could not create the export job: ${jobResult.error.detail}`,
      jobResult.error.status,
    );
  }

  if (enumerated.skipped.length > 0) {
    await adapters.recordSkippedBranches(accountId, jobId, enumerated.skipped);
  }
  await adapters.recordLatestExportJob(accountId, jobId);
  const { queueJobId } = await adapters.scheduleExportJob(accountId, jobId);
  await adapters.attachQueueJob(accountId, jobId, queueJobId);

  return ok({ jobId });
}
