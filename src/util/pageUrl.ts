const PAGE_ID_PATTERN = /\/pages\/(\d+)(?:\/([^/?#]+))?/;

export function parsePageId(url: string): string | null {
  const match = url.match(PAGE_ID_PATTERN);
  return match?.[1] ?? null;
}

export function isSameSite(url: string, siteUrl: string): boolean {
  try {
    return new URL(url).hostname === new URL(siteUrl).hostname;
  } catch {
    return false;
  }
}

export function slugify(text: string): string {
  const lowered = text.trim().toLowerCase();
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  return trimmed || "page";
}

export function deriveSlugFromUrl(url: string): string {
  const match = url.match(PAGE_ID_PATTERN);
  if (!match) {
    return "";
  }
  const [, pageId, titleSegment] = match;
  if (titleSegment) {
    try {
      const decoded = decodeURIComponent(titleSegment).replace(/\+/g, " ");
      const slug = slugify(decoded);
      if (slug !== "page") {
        return slug;
      }
    } catch {
      // fall through to the page-id fallback below
    }
  }
  return pageId ? `page-${pageId}` : "";
}
