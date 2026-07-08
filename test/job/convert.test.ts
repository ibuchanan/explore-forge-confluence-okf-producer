import { afterEach, describe, expect, it, vi } from "vitest";

describe("rewriteInternalLinks", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node-html-parser");
  });

  it("rewrites a link to an exported page to a relative Markdown path", async () => {
    const { rewriteInternalLinks } = await import("../../src/job/convert");
    const html =
      '<a href="https://example.atlassian.net/wiki/spaces/KEY/pages/2/Child">Child</a>';
    const idToPath = new Map([["2", "pages/root-1/child-2.md"]]);

    const result = rewriteInternalLinks(html, "pages/root-1.md", idToPath);

    expect(result._unsafeUnwrap()).toContain('href="root-1/child-2.md"');
  });

  it("leaves external links unchanged", async () => {
    const { rewriteInternalLinks } = await import("../../src/job/convert");
    const html = '<a href="https://other-site.example.com/docs">Docs</a>';

    const result = rewriteInternalLinks(html, "pages/root-1.md", new Map());

    expect(result._unsafeUnwrap()).toContain(
      'href="https://other-site.example.com/docs"',
    );
  });

  it("leaves links to pages outside the export unchanged", async () => {
    const { rewriteInternalLinks } = await import("../../src/job/convert");
    const html =
      '<a href="https://example.atlassian.net/wiki/spaces/KEY/pages/99/Elsewhere">Elsewhere</a>';

    const result = rewriteInternalLinks(html, "pages/root-1.md", new Map());

    expect(result._unsafeUnwrap()).toContain(
      'href="https://example.atlassian.net/wiki/spaces/KEY/pages/99/Elsewhere"',
    );
  });

  it("returns Err with a ProblemDetails when parsing throws", async () => {
    vi.doMock("node-html-parser", () => ({
      parse: () => {
        throw new Error("boom");
      },
    }));
    const { rewriteInternalLinks } = await import("../../src/job/convert");

    const result = rewriteInternalLinks(
      "<p>hi</p>",
      "pages/root-1.md",
      new Map(),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });
});

describe("convertPageHtml", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node-html-markdown");
  });

  it("returns Ok(null) when there is no html", async () => {
    const { convertPageHtml } = await import("../../src/job/convert");

    const result = convertPageHtml(null, "pages/root-1.md", new Map());

    expect(result._unsafeUnwrap()).toBeNull();
  });

  it("converts html to markdown with internal links already rewritten", async () => {
    const { convertPageHtml } = await import("../../src/job/convert");
    const html =
      '<p>See <a href="https://example.atlassian.net/wiki/spaces/KEY/pages/2/Child">Child</a>.</p>';
    const idToPath = new Map([["2", "pages/root-1/child-2.md"]]);

    const result = convertPageHtml(html, "pages/root-1.md", idToPath);

    expect(result._unsafeUnwrap()).toBe("See [Child](root-1/child-2.md).");
  });

  it("returns Err with a ProblemDetails when Markdown translation throws", async () => {
    vi.doMock("node-html-markdown", () => ({
      NodeHtmlMarkdown: {
        translate: () => {
          throw new Error("boom");
        },
      },
    }));
    const { convertPageHtml } = await import("../../src/job/convert");

    const result = convertPageHtml("<p>hi</p>", "pages/root-1.md", new Map());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });
});
