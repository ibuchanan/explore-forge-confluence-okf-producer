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

export type JobStage =
  | "validating"
  | "resolving-root"
  | "listing-descendants"
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
