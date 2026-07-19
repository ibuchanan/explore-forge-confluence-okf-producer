/**
 * `@forge/resolver` types a resolver's `context` argument as
 * `{ [key: string]: any }` (see its `shared/index.d.ts`), discarding the
 * shape Atlassian documents at
 * https://developer.atlassian.com/platform/forge/runtime-reference/forge-resolver.
 * This mirrors that documented shape for the fields this app reads.
 *
 * The docs mark `accountId` and `siteUrl` optional (e.g. anonymous users or
 * Forge Remote invocations never see them), but every resolver in this app
 * is invoked by an authenticated user viewing a Confluence macro, so callers
 * here can rely on both being present.
 */
export interface ForgeResolverContext {
  accountId: string;
  siteUrl: string;
}

export function asForgeResolverContext(context: unknown): ForgeResolverContext {
  return context as ForgeResolverContext;
}
