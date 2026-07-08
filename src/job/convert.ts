import { ok, type ProblemDetails, type Result } from "@forge-ahead/errors";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { parse } from "node-html-parser";
import { exportFailed } from "./errors";

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
): Result<string, ProblemDetails> {
  try {
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
    return ok(root.toString());
  } catch (exc) {
    return exportFailed(
      `Failed to rewrite internal links: ${(exc as Error).message}`,
    );
  }
}

export function convertPageHtml(
  html: string | null,
  currentPath: string,
  idToPath: Map<string, string>,
): Result<string | null, ProblemDetails> {
  if (!html) {
    return ok(null);
  }
  return rewriteInternalLinks(html, currentPath, idToPath).andThen(
    (rewritten) => {
      try {
        return ok(NodeHtmlMarkdown.translate(rewritten).trim());
      } catch (exc) {
        return exportFailed(
          `Markdown conversion failed: ${(exc as Error).message}`,
        );
      }
    },
  );
}
