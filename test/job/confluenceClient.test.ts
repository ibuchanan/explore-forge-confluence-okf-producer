import { beforeEach, describe, expect, it, vi } from "vitest";

const requestConfluence = vi.fn();

vi.mock("@forge/api", () => ({
  default: { asUser: () => ({ requestConfluence }) },
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
  assumeTrustedRoute: (path: string) => path,
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  requestConfluence.mockReset();
});

describe("getPage", () => {
  it("extracts page fields from a v2 page response", async () => {
    const { getPage } = await import("../../src/job/confluenceClient");
    requestConfluence.mockResolvedValueOnce(
      jsonResponse({
        id: "123",
        title: "APEX Hub",
        parentId: "10",
        spaceId: "20",
        version: { number: 4 },
        status: "current",
        body: { export_view: { value: "<p>Hi</p>" } },
        labels: { results: [{ name: "how-to" }] },
        _links: {
          base: "https://example.atlassian.net/wiki",
          webui: "/spaces/KEY/pages/123/APEX+Hub",
        },
      }),
    );

    const page = await getPage("123");

    expect(page).toEqual({
      id: "123",
      title: "APEX Hub",
      parentId: "10",
      spaceId: "20",
      version: 4,
      status: "current",
      webUrl:
        "https://example.atlassian.net/wiki/spaces/KEY/pages/123/APEX+Hub",
      html: "<p>Hi</p>",
      labels: ["how-to"],
    });
    expect(requestConfluence).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/123?body-format=export_view&include-labels=true",
      { headers: { Accept: "application/json" } },
    );
  });
});

describe("getChildIds", () => {
  it("paginates through _links.next and keeps only current-status children", async () => {
    const { getChildIds } = await import("../../src/job/confluenceClient");
    requestConfluence
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { id: "2", status: "current" },
            { id: "3", status: "archived" },
          ],
          _links: { next: "/wiki/api/v2/pages/1/children?cursor=abc" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "4", status: "current" }],
          _links: {},
        }),
      );

    const ids = await getChildIds("1");

    expect(ids).toEqual(["2", "4"]);
    expect(requestConfluence).toHaveBeenNthCalledWith(
      1,
      "/wiki/api/v2/pages/1/children?limit=100",
      { headers: { Accept: "application/json" } },
    );
    expect(requestConfluence).toHaveBeenNthCalledWith(
      2,
      "/wiki/api/v2/pages/1/children?cursor=abc",
      { headers: { Accept: "application/json" } },
    );
  });
});

describe("getDescendantIds", () => {
  it("walks children level-by-level up to depth, skipping branches that fail", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    requestConfluence
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { id: "2", status: "current" },
            { id: "3", status: "current" },
          ],
          _links: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: "4", status: "current" }], _links: {} }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
      });

    const skipped: Array<{ id: string; reason: string }> = [];
    const ids = await getDescendantIds("1", 2, {
      onSkippedBranch: (pageId, exc) =>
        skipped.push({ id: pageId, reason: (exc as Error).message }),
    });

    expect(ids.sort()).toEqual(["2", "3", "4"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.id).toBe("3");
  });

  it("fails the whole walk when the root's own children listing fails", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    requestConfluence.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });

    await expect(getDescendantIds("1", 2, {})).rejects.toThrow();
  });

  it("throws ExportCancelled and stops fetching when isCancelled becomes true", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    const { ExportCancelled } = await import("../../src/job/errors");

    await expect(
      getDescendantIds("1", 2, { isCancelled: () => true }),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(requestConfluence).not.toHaveBeenCalled();
  });
});

describe("getSpaceKey", () => {
  it("returns the space key for a space id", async () => {
    const { getSpaceKey } = await import("../../src/job/confluenceClient");
    requestConfluence.mockResolvedValueOnce(jsonResponse({ key: "KEY" }));

    expect(await getSpaceKey("20")).toBe("KEY");
    expect(requestConfluence).toHaveBeenCalledWith("/wiki/api/v2/spaces/20", {
      headers: { Accept: "application/json" },
    });
  });
});

describe("resolvePersonalSpaceHomepage", () => {
  it("resolves the current user's personal space homepage URL", async () => {
    const { resolvePersonalSpaceHomepage } = await import(
      "../../src/job/confluenceClient"
    );
    requestConfluence
      .mockResolvedValueOnce(jsonResponse({ results: [{ homepageId: "555" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "555",
          title: "My Home",
          parentId: null,
          spaceId: "30",
          version: { number: 1 },
          status: "current",
          body: {},
          labels: { results: [] },
          _links: {
            base: "https://example.atlassian.net/wiki",
            webui: "/spaces/~1234/overview",
          },
        }),
      );

    const url = await resolvePersonalSpaceHomepage("1234");

    expect(url).toBe(
      "https://example.atlassian.net/wiki/spaces/~1234/overview",
    );
  });

  it("returns null instead of throwing when the lookup fails", async () => {
    const { resolvePersonalSpaceHomepage } = await import(
      "../../src/job/confluenceClient"
    );
    requestConfluence.mockRejectedValueOnce(new Error("network down"));

    expect(await resolvePersonalSpaceHomepage("1234")).toBeNull();
  });
});
