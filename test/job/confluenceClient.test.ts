import { beforeEach, describe, expect, it, vi } from "vitest";

const requestConfluenceAsUser = vi.fn();
const requestConfluenceAsApp = vi.fn();

vi.mock("@forge/api", () => ({
  default: {
    asUser: () => ({ requestConfluence: requestConfluenceAsUser }),
    asApp: () => ({ requestConfluence: requestConfluenceAsApp }),
  },
  route: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => `${acc}${part}${values[i] ?? ""}`, ""),
  assumeTrustedRoute: (path: string) => path,
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  requestConfluenceAsUser.mockReset();
  requestConfluenceAsApp.mockReset();
});

describe("getPage", () => {
  it("extracts page fields from a v2 page response, reading as the user", async () => {
    const { getPage } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser.mockResolvedValueOnce(
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

    const result = await getPage("user", "123");

    expect(result._unsafeUnwrap()).toEqual({
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
    expect(requestConfluenceAsUser).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/123?body-format=export_view&include-labels=true",
      { headers: { Accept: "application/json" } },
    );
  });

  it("reads as the app when called with auth 'app'", async () => {
    const { getPage } = await import("../../src/job/confluenceClient");
    requestConfluenceAsApp.mockResolvedValueOnce(
      jsonResponse({
        id: "123",
        title: "APEX Hub",
        parentId: null,
        spaceId: "20",
        body: { export_view: { value: "<p>Hi</p>" } },
        labels: { results: [] },
        _links: {},
      }),
    );

    await getPage("app", "123");

    expect(requestConfluenceAsApp).toHaveBeenCalledWith(
      "/wiki/api/v2/pages/123?body-format=export_view&include-labels=true",
      { headers: { Accept: "application/json" } },
    );
    expect(requestConfluenceAsUser).not.toHaveBeenCalled();
  });

  it("produces a ProblemDetails carrying Confluence's status when the request fails", async () => {
    const { getPage } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const result = await getPage("user", "123");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 404 });
  });
});

describe("getChildIds", () => {
  it("paginates through _links.next and keeps only current-status children", async () => {
    const { getChildIds } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser
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

    const result = await getChildIds("1");

    expect(result._unsafeUnwrap()).toEqual(["2", "4"]);
    expect(requestConfluenceAsUser).toHaveBeenNthCalledWith(
      1,
      "/wiki/api/v2/pages/1/children?limit=100",
      { headers: { Accept: "application/json" } },
    );
    expect(requestConfluenceAsUser).toHaveBeenNthCalledWith(
      2,
      "/wiki/api/v2/pages/1/children?cursor=abc",
      { headers: { Accept: "application/json" } },
    );
  });

  it("returns Err when the listing request fails", async () => {
    const { getChildIds } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });

    const result = await getChildIds("1");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });
});

describe("getDescendantIds", () => {
  it("walks children level-by-level up to depth, skipping branches that fail", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser
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
    const result = await getDescendantIds("1", 2, {
      onSkippedBranch: (pageId, problem) =>
        skipped.push({ id: pageId, reason: problem.detail }),
    });

    expect(result._unsafeUnwrap().sort()).toEqual(["2", "3", "4"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.id).toBe("3");
  });

  it("fails the whole walk when the root's own children listing fails", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });

    const result = await getDescendantIds("1", 2, {});

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({ status: 500 });
  });

  it("returns a cancelled ProblemDetails and stops fetching when isCancelled becomes true", async () => {
    const { getDescendantIds } = await import("../../src/job/confluenceClient");
    const { isCancelled } = await import("../../src/job/errors");

    const result = await getDescendantIds("1", 2, { isCancelled: () => true });

    expect(result.isErr()).toBe(true);
    expect(isCancelled(result._unsafeUnwrapErr())).toBe(true);
    expect(requestConfluenceAsUser).not.toHaveBeenCalled();
  });
});

describe("getSpaceKey", () => {
  it("returns the space key for a space id, reading as the user", async () => {
    const { getSpaceKey } = await import("../../src/job/confluenceClient");
    requestConfluenceAsUser.mockResolvedValueOnce(jsonResponse({ key: "KEY" }));

    const result = await getSpaceKey("user", "20");

    expect(result._unsafeUnwrap()).toBe("KEY");
    expect(requestConfluenceAsUser).toHaveBeenCalledWith(
      "/wiki/api/v2/spaces/20",
      {
        headers: { Accept: "application/json" },
      },
    );
  });

  it("reads as the app when called with auth 'app'", async () => {
    const { getSpaceKey } = await import("../../src/job/confluenceClient");
    requestConfluenceAsApp.mockResolvedValueOnce(jsonResponse({ key: "KEY" }));

    const result = await getSpaceKey("app", "20");

    expect(result._unsafeUnwrap()).toBe("KEY");
    expect(requestConfluenceAsApp).toHaveBeenCalledWith(
      "/wiki/api/v2/spaces/20",
      {
        headers: { Accept: "application/json" },
      },
    );
    expect(requestConfluenceAsUser).not.toHaveBeenCalled();
  });
});

describe("resolvePersonalSpaceHomepage", () => {
  it("resolves the current user's personal space homepage URL", async () => {
    const { resolvePersonalSpaceHomepage } = await import(
      "../../src/job/confluenceClient"
    );
    requestConfluenceAsUser
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
    requestConfluenceAsUser.mockRejectedValueOnce(new Error("network down"));

    expect(await resolvePersonalSpaceHomepage("1234")).toBeNull();
  });
});
