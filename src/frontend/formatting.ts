const STAGE_LABELS: Record<string, string> = {
  validating: "Validating",
  "resolving-root": "Resolving root page",
  "listing-descendants": "Listing descendant pages",
  "fetching-pages": "Fetching pages",
  "converting-markdown": "Converting to Markdown",
  "building-archive": "Building archive",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export type LozengeAppearance = "success" | "danger" | "moved" | "inprogress";

export function lozengeAppearanceFor(status: string): LozengeAppearance {
  if (status === "ready") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "cancelled") {
    return "moved";
  }
  return "inprogress";
}
