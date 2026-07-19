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

// Producer-defined extension to the concept frontmatter (OKF spec §4.1
// "Extensions"), carrying the Confluence-specific provenance this app adds
// to every exported concept document. See specs/references/knowledge-catalog/okf/SPEC.md.
export interface ConfluenceFrontmatterExtension {
  page_id: string;
  space_id: string;
  space_key: string;
  parent_id: string | null;
  version: number;
  status: string;
  exported_at: string;
}

// Concept document frontmatter per OKF spec §4.1. `type` is the only field
// the spec requires; `title`, `description`, `resource`, and `timestamp` are
// recommended and always populated here. `tags` stays optional -- omitted
// entirely when a page has no labels, rather than serialized as `tags: []`.
export interface OkfConceptFrontmatter {
  type: string;
  title: string;
  description: string;
  resource: string;
  tags?: string[];
  timestamp: string;
  confluence: ConfluenceFrontmatterExtension;
}

// Root-page validation and descendant enumeration happen synchronously during
// Export Job Intake (as the user) before a job is ever created. By the time a
// job exists, its page set is already known, so job stages only cover the
// async, asApp() content-fetch phase.
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
