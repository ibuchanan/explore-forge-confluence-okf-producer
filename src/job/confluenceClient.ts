import type { Route } from "@forge/api";
import api, { assumeTrustedRoute, route } from "@forge/api";
import {
  err,
  errAsync,
  ok,
  type ProblemDetails,
  type Result,
  ResultAsync,
} from "@forge-ahead/errors";
import { exportCancelled, exportFailed } from "./errors";
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

// exportFailed() always returns Err (its Ok type is `never`), so
// `._unsafeUnwrapErr()` just extracts the ProblemDetails -- there's no other
// case it could be in.
function fetchConfluenceJson<T>(
  auth: AuthMode,
  routeOrPath: string | Route,
  description: string,
): ResultAsync<T, ProblemDetails> {
  const target =
    typeof routeOrPath === "string"
      ? assumeTrustedRoute(routeOrPath)
      : routeOrPath;
  const init = { headers: { Accept: "application/json" } };
  // Two literal call sites (rather than a shared client variable) so the
  // api.asUser()/api.asApp() authorization is visible at each call site.
  const request =
    auth === "user"
      ? api.asUser().requestConfluence(target, init)
      : api.asApp().requestConfluence(target, init);

  return ResultAsync.fromPromise(request, (exc) =>
    exportFailed(
      `${description} failed: ${(exc as Error).message}`,
      502,
    )._unsafeUnwrapErr(),
  ).andThen((response) => {
    if (!response.ok) {
      return errAsync(
        exportFailed(
          `${description} failed: ${response.status} ${response.statusText}`,
          response.status,
        )._unsafeUnwrapErr(),
      );
    }
    return ResultAsync.fromPromise(response.json() as Promise<T>, (exc) =>
      exportFailed(
        `${description}: invalid JSON response (${(exc as Error).message})`,
        502,
      )._unsafeUnwrapErr(),
    );
  });
}

export function getPage(
  auth: AuthMode,
  pageId: string,
): ResultAsync<ConfluencePage, ProblemDetails> {
  return fetchConfluenceJson<ConfluencePageResponse>(
    auth,
    route`/wiki/api/v2/pages/${pageId}?body-format=export_view&include-labels=true`,
    `Reading page ${pageId}`,
  ).map((data) => {
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
  });
}

export async function getChildIds(
  pageId: string,
): Promise<Result<string[], ProblemDetails>> {
  const ids: string[] = [];
  let next: string | Route | null =
    route`/wiki/api/v2/pages/${pageId}/children?limit=100`;
  while (next) {
    const result: Result<ConfluenceChildrenResponse, ProblemDetails> =
      await fetchConfluenceJson<ConfluenceChildrenResponse>(
        "user",
        next,
        `Listing children of ${pageId}`,
      );
    if (result.isErr()) {
      return err(result.error);
    }
    const data: ConfluenceChildrenResponse = result.value;
    for (const item of data.results ?? []) {
      if ((item.status ?? CURRENT_STATUS) === CURRENT_STATUS) {
        ids.push(String(item.id));
      }
    }
    const nextLink: string | undefined = data._links?.next;
    next = nextLink ? assumeTrustedRoute(nextLink) : null;
  }
  return ok(ids);
}

export interface DescendantWalkHooks {
  onSkippedBranch?: (pageId: string, problem: ProblemDetails) => void;
  isCancelled?: () => boolean | Promise<boolean>;
}

export async function getDescendantIds(
  rootId: string,
  depth: number,
  { onSkippedBranch, isCancelled }: DescendantWalkHooks = {},
): Promise<Result<string[], ProblemDetails>> {
  const ids: string[] = [];
  let frontier = [rootId];
  for (let level = 0; level < depth; level += 1) {
    const nextFrontier: string[] = [];
    for (const pageId of frontier) {
      if (isCancelled && (await isCancelled())) {
        return exportCancelled();
      }
      const result = await getChildIds(pageId);
      if (result.isErr()) {
        if (pageId === rootId) {
          return err(result.error);
        }
        onSkippedBranch?.(pageId, result.error);
        continue;
      }
      ids.push(...result.value);
      nextFrontier.push(...result.value);
    }
    frontier = nextFrontier;
    if (frontier.length === 0) {
      break;
    }
  }
  return ok(ids);
}

export function getSpaceKey(
  auth: AuthMode,
  spaceId: string,
): ResultAsync<string, ProblemDetails> {
  return fetchConfluenceJson<{ key?: string }>(
    auth,
    route`/wiki/api/v2/spaces/${spaceId}`,
    `Reading space ${spaceId}`,
  ).map((data) => data.key ?? "");
}

// Best-effort: callers treat "no default available" the same as "couldn't
// resolve it", so this keeps its plain Promise<string | null> contract
// (never rejects) rather than exposing Result to a resolver that only ever
// wants a value, not a failure to react to.
export async function resolvePersonalSpaceHomepage(
  accountId: string,
): Promise<string | null> {
  const spacesResult = await fetchConfluenceJson<{
    results?: Array<{ homepageId?: string }>;
  }>(
    "user",
    route`/wiki/api/v2/spaces?keys=${`~${accountId}`}&limit=1`,
    "Resolving personal space",
  );
  if (spacesResult.isErr()) {
    return null;
  }
  const homepageId = spacesResult.value.results?.[0]?.homepageId;
  if (!homepageId) {
    return null;
  }
  const homepageResult = await getPage("user", homepageId);
  return homepageResult.match(
    (page) => page.webUrl || null,
    () => null,
  );
}
