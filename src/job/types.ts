export interface ConfluencePage {
  id: string;
  title: string;
  parentId: string | null;
  spaceId: string;
  version: number;
  status: string;
  webUrl: string;
  html: string | null;
  labels: string[];
}

export interface BundlePage extends ConfluencePage {
  children: string[];
  slug: string;
  conceptPath: string;
}

export type BundlePageMap = Map<string, BundlePage>;

export interface SkippedPage {
  id: string;
  title: string | null;
  reason: string;
}

// Root-page validation and descendant enumeration now happen synchronously
// in the resolver (as the user) before a job is ever created -- see
// resolvers/export.ts. By the time a job exists, its page set is already
// known, so job stages only cover the async, asApp() content-fetch phase.
export type JobStage =
  | "fetching-pages"
  | "converting-markdown"
  | "building-archive"
  | "ready"
  | "failed"
  | "cancelled";

export type JobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface ExportJobInput {
  rootUrl: string;
  rootId: string;
  depth: number;
  bundleSlug: string;
  /** Pre-vetted page IDs (root + descendants) enumerated as the user. */
  pageIds: string[];
}

export interface ExportJob extends ExportJobInput {
  jobId: string;
  accountId: string;
  status: JobStatus;
  stage: JobStage;
  exportedCount: number;
  skipped: SkippedPage[];
  warnings: SkippedPage[];
  errorMessage: string | null;
  archiveKey: string | null;
  queueJobId: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
}
