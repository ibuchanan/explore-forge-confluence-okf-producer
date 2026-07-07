import type { Route } from "@forge/api";
import api, { assumeTrustedRoute, route } from "@forge/api";
import { ExportCancelled } from "./errors";
import type { ConfluencePage } from "./types";

const CURRENT_STATUS = "current";

interface ConfluenceLinks {
  base?: string;
  webui?: string;
  next?: string;
}

interface ConfluenceChildrenResponse {
  results?: Array<{ id: string | number; status?: string }>;
  _links?: ConfluenceLinks;
}

interface ConfluencePageResponse {
  id: string;
  title: string;
  parentId: string | null;
  spaceId: string;
  version?: { number: number };
  status?: string;
  body?: { export_view?: { value?: string }; exportView?: { value?: string } };
  labels?: { results?: Array<{ name?: string }> };
  _links?: ConfluenceLinks;
}

export type AuthMode = "user" | "app";

async function fetchConfluenceJson<T>(
  auth: AuthMode,
  routeOrPath: string | Route,
  description: string,
): Promise<T> {
  const target =
    typeof routeOrPath === "string"
      ? assumeTrustedRoute(routeOrPath)
      : routeOrPath;
  const init = { headers: { Accept: "application/json" } };
  // Two literal call sites (rather than a shared client variable) so the
  // api.asUser()/api.asApp() authorization is visible at each call site.
  const response =
    auth === "user"
      ? await api.asUser().requestConfluence(target, init)
      : await api.asApp().requestConfluence(target, init);
  if (!response.ok) {
    throw new Error(
      `${description} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

export async function getPage(
  auth: AuthMode,
  pageId: string,
): Promise<ConfluencePage> {
  const data = await fetchConfluenceJson<ConfluencePageResponse>(
    auth,
    route`/wiki/api/v2/pages/${pageId}?body-format=export_view&include-labels=true`,
    `Reading page ${pageId}`,
  );

  const body = data.body ?? {};
  const exportView = body.export_view ?? body.exportView ?? {};
  const html = exportView.value ?? null;

  const labels = (data.labels?.results ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name));

  const links = data._links ?? {};
  const base = (links.base ?? "").replace(/\/$/, "");
  const webUrl = `${base}${links.webui ?? ""}`;

  return {
    id: String(data.id),
    title: data.title,
    parentId: data.parentId ? String(data.parentId) : null,
    spaceId: String(data.spaceId),
    version: data.version?.number ?? 0,
    status: data.status ?? CURRENT_STATUS,
    webUrl,
    html,
    labels,
  };
}

export async function getChildIds(pageId: string): Promise<string[]> {
  const ids: string[] = [];
  let next: string | Route | null =
    route`/wiki/api/v2/pages/${pageId}/children?limit=100`;
  while (next) {
    const data: ConfluenceChildrenResponse =
      await fetchConfluenceJson<ConfluenceChildrenResponse>(
        "user",
        next,
        `Listing children of ${pageId}`,
      );
    for (const item of data.results ?? []) {
      if ((item.status ?? CURRENT_STATUS) === CURRENT_STATUS) {
        ids.push(String(item.id));
      }
    }
    const nextLink: string | undefined = data._links?.next;
    next = nextLink ? assumeTrustedRoute(nextLink) : null;
  }
  return ids;
}

export interface DescendantWalkHooks {
  onSkippedBranch?: (pageId: string, error: unknown) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

export async function getDescendantIds(
  rootId: string,
  depth: number,
  { onSkippedBranch, isCancelled }: DescendantWalkHooks = {},
): Promise<string[]> {
  const ids: string[] = [];
  let frontier = [rootId];
  for (let level = 0; level < depth; level += 1) {
    const nextFrontier: string[] = [];
    for (const pageId of frontier) {
      if (isCancelled && (await isCancelled())) {
        throw new ExportCancelled();
      }
      try {
        const children = await getChildIds(pageId);
        ids.push(...children);
        nextFrontier.push(...children);
      } catch (exc) {
        if (pageId === rootId) {
          throw exc;
        }
        onSkippedBranch?.(pageId, exc);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) {
      break;
    }
  }
  return ids;
}

export async function getSpaceKey(
  auth: AuthMode,
  spaceId: string,
): Promise<string> {
  const data = await fetchConfluenceJson<{ key?: string }>(
    auth,
    route`/wiki/api/v2/spaces/${spaceId}`,
    `Reading space ${spaceId}`,
  );
  return data.key ?? "";
}

export async function resolvePersonalSpaceHomepage(
  accountId: string,
): Promise<string | null> {
  try {
    const data = await fetchConfluenceJson<{
      results?: Array<{ homepageId?: string }>;
    }>(
      "user",
      route`/wiki/api/v2/spaces?keys=${`~${accountId}`}&limit=1`,
      "Resolving personal space",
    );
    const homepageId = data.results?.[0]?.homepageId;
    if (!homepageId) {
      return null;
    }
    const homepage = await getPage("user", homepageId);
    return homepage.webUrl || null;
  } catch {
    return null;
  }
}
