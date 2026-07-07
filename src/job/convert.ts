import { NodeHtmlMarkdown } from "node-html-markdown";
import { parse } from "node-html-parser";

const PAGE_ID_IN_HREF = /\/pages\/(\d+)/;

function relativePath(fromPath: string, toPath: string): string {
  const fromDir = fromPath.split("/").slice(0, -1);
  const toParts = toPath.split("/");
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length - 1 &&
    fromDir[common] === toParts[common]
  ) {
    common += 1;
  }
  const up = fromDir.slice(common).map(() => "..");
  const down = toParts.slice(common);
  const parts = [...up, ...down];
  return parts.join("/") || ".";
}

export function rewriteInternalLinks(
  html: string,
  currentPath: string,
  idToPath: Map<string, string>,
): string {
  const root = parse(html);
  for (const anchor of root.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    const match = href.match(PAGE_ID_IN_HREF);
    const pageId = match?.[1];
    if (!pageId) {
      continue;
    }
    const targetPath = idToPath.get(pageId);
    if (!targetPath) {
      continue;
    }
    anchor.setAttribute("href", relativePath(currentPath, targetPath));
  }
  return root.toString();
}

export function convertPageHtml(
  html: string | null,
  currentPath: string,
  idToPath: Map<string, string>,
): string | null {
  if (!html) {
    return null;
  }
  const rewritten = rewriteInternalLinks(html, currentPath, idToPath);
  return NodeHtmlMarkdown.translate(rewritten).trim();
}
