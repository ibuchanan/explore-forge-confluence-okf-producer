import { describe, expect, it } from "vitest";
import {
  deriveSlugFromUrl,
  isSameSite,
  parsePageId,
  slugify,
} from "../../src/util/pageUrl";

describe("parsePageId", () => {
  it("extracts the numeric page id from a Confluence page URL", () => {
    const url =
      "https://example.atlassian.net/wiki/spaces/KEY/pages/2895398596/Some+Title";

    expect(parsePageId(url)).toBe("2895398596");
  });

  it("returns null when the URL has no page id", () => {
    expect(
      parsePageId("https://example.atlassian.net/wiki/spaces/KEY/overview"),
    ).toBeNull();
  });
});

describe("isSameSite", () => {
  it("is true when the page URL host matches the site URL host", () => {
    expect(
      isSameSite(
        "https://example.atlassian.net/wiki/spaces/KEY/pages/123/Title",
        "https://example.atlassian.net",
      ),
    ).toBe(true);
  });

  it("is false when the page URL host differs from the site URL host", () => {
    expect(
      isSameSite(
        "https://other.atlassian.net/wiki/spaces/KEY/pages/123/Title",
        "https://example.atlassian.net",
      ),
    ).toBe(false);
  });

  it("is false when the page URL is malformed", () => {
    expect(isSameSite("not a url", "https://example.atlassian.net")).toBe(
      false,
    );
  });
});

describe("slugify", () => {
  it("lowercases and dashes non-alphanumeric runs", () => {
    expect(slugify("APEX Hub: Overview!")).toBe("apex-hub-overview");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("  --Weird Title--  ")).toBe("weird-title");
  });

  it("falls back to 'page' for empty or non-alphanumeric input", () => {
    expect(slugify("")).toBe("page");
    expect(slugify("!!!")).toBe("page");
  });
});

describe("deriveSlugFromUrl", () => {
  it("slugifies the decoded title segment of the URL", () => {
    expect(
      deriveSlugFromUrl(
        "https://example.atlassian.net/wiki/spaces/KEY/pages/123/APEX+Hub",
      ),
    ).toBe("apex-hub");
  });

  it("falls back to a page-id slug when there is no title segment", () => {
    expect(
      deriveSlugFromUrl(
        "https://example.atlassian.net/wiki/spaces/KEY/pages/123",
      ),
    ).toBe("page-123");
  });

  it("falls back to a page-id slug when the title segment decodes to nothing useful", () => {
    expect(
      deriveSlugFromUrl(
        "https://example.atlassian.net/wiki/spaces/KEY/pages/123/%21%21%21",
      ),
    ).toBe("page-123");
  });

  it("returns an empty string when the URL has no page id", () => {
    expect(
      deriveSlugFromUrl(
        "https://example.atlassian.net/wiki/spaces/KEY/overview",
      ),
    ).toBe("");
  });
});
