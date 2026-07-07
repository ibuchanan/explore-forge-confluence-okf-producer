import { describe, expect, it } from "vitest";
import { convertPageHtml, rewriteInternalLinks } from "../../src/job/convert";

describe("rewriteInternalLinks", () => {
  it("rewrites a link to an exported page to a relative Markdown path", () => {
    const html =
      '<a href="https://example.atlassian.net/wiki/spaces/KEY/pages/2/Child">Child</a>';
    const idToPath = new Map([["2", "pages/root-1/child-2.md"]]);

    const rewritten = rewriteInternalLinks(html, "pages/root-1.md", idToPath);

    expect(rewritten).toContain('href="root-1/child-2.md"');
  });

  it("leaves external links unchanged", () => {
    const html = '<a href="https://other-site.example.com/docs">Docs</a>';

    const rewritten = rewriteInternalLinks(html, "pages/root-1.md", new Map());

    expect(rewritten).toContain('href="https://other-site.example.com/docs"');
  });

  it("leaves links to pages outside the export unchanged", () => {
    const html =
      '<a href="https://example.atlassian.net/wiki/spaces/KEY/pages/99/Elsewhere">Elsewhere</a>';

    const rewritten = rewriteInternalLinks(html, "pages/root-1.md", new Map());

    expect(rewritten).toContain(
      'href="https://example.atlassian.net/wiki/spaces/KEY/pages/99/Elsewhere"',
    );
  });
});

describe("convertPageHtml", () => {
  it("returns null when there is no html", () => {
    expect(convertPageHtml(null, "pages/root-1.md", new Map())).toBeNull();
  });

  it("converts html to markdown with internal links already rewritten", () => {
    const html =
      '<p>See <a href="https://example.atlassian.net/wiki/spaces/KEY/pages/2/Child">Child</a>.</p>';
    const idToPath = new Map([["2", "pages/root-1/child-2.md"]]);

    const markdown = convertPageHtml(html, "pages/root-1.md", idToPath);

    expect(markdown).toBe("See [Child](root-1/child-2.md).");
  });
});
