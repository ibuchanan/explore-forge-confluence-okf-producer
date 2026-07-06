# OKF Producer v1 Specification

## Purpose

Build a Confluence Forge app that exports a selected Confluence page tree from the installed site into an Open Knowledge Format (OKF) bundle. The exported bundle is downloaded as a zip file and is intended for local tooling that creates agent skills.

The app is an OKF producer, not an OKF publisher. It does not upload generated OKF content back into Confluence.

## Goals

- Export Confluence content from the site where the Forge app is installed.
- Start from one root Confluence page and include descendant pages up to depth 5.
- Produce one OKF concept document per exported Confluence page.
- Preserve source claims through deterministic export; do not use LLM rewriting or summarization.
- Convert Confluence rendered export HTML into Markdown using an off-the-shelf HTML-to-Markdown converter.
- Download the result as a zip archive containing one OKF bundle.
- Run reads as the current user so exports respect the runner's Confluence permissions.

## Non-goals

- Publishing OKF bundles into Confluence.
- Cross-site export from a Confluence site where the app is not installed.
- Content action entry points. A page-level `confluence:contentAction` can be considered for v2.
- LLM enrichment, summaries, topic synthesis, or inferred claims.
- Binary attachment export.
- Incremental regeneration, durable cache manifests, or export history.
- Fallback conversion through the v1 async content body conversion API.

## Forge Surface

Use an admin-only Confluence global settings UI as the v1 execution surface.

The screen is an Execution UI, not durable configuration. It lets an admin choose export inputs and start an export job.

Initial fields:

- Root page URL
- Depth cap, default `5`, maximum `5`
- Bundle slug, derived from the root page title when possible and editable before export

Default source behavior:

- On load, best-effort resolve the current user's personal space homepage and prefill it as the root page.
- If no personal space homepage can be resolved, leave the root page URL empty.
- The user can paste any page URL from the installed site.
- URLs from other Atlassian sites must be rejected with a clear validation error.

## Source Scope

An export starts from a single root Confluence page.

For v1, include:

- The root page.
- Descendant pages up to depth 5.
- Only content visible to the current user.

If the root page cannot be read, fail the export. If descendant listing fails entirely, fail the export. If individual descendant pages fail, continue and report skipped pages.

The concrete motivating example is the APEX Hub page tree on `hello.atlassian.net`, but the app cannot export that content unless installed on that site and run by a user with access.

## Authorization Model

Confluence reads must run as the current user, not as the app.

This keeps the export aligned with user expectations: the archive contains only content the user running the export can view. Do not use `asApp()` for page reads in v1.

## Required Forge Permissions

Baseline manifest scopes:

```yaml
permissions:
  scopes:
    - read:page:confluence
    - read:space:confluence
    - storage:app
```

Add only if implementation proves they are needed:

- `read:confluence-user` if the current user account ID cannot be obtained from Forge context and is needed to resolve the personal space default.
- `read:attachment:confluence` only if attachment metadata cannot be obtained from page export content and is still required.

Do not add Confluence write scopes in v1.

## Confluence API Usage

Use Confluence REST API v2 where possible.

Expected read path:

1. Resolve root page ID from the pasted page URL.
2. Read the root page with `GET /wiki/api/v2/pages/{id}` using `body-format=export_view`.
3. Read descendants with `GET /wiki/api/v2/pages/{id}/descendants`, with `depth=5` and pagination.
4. Read each descendant page with `GET /wiki/api/v2/pages/{id}` using `body-format=export_view`.
5. Include labels where available through page read include options or label endpoints if the required scope remains acceptable.

V1 is intentionally presumptive about `body-format=export_view` on v2 page reads. If the API does not return usable export-view HTML, fail the affected page with a conversion warning rather than implementing a storage-to-export fallback.

## Export Job Model

Model export generation as an async job with polling.

Initial resolver contract:

- `getDefaultSource`: returns the best-effort personal-space homepage default.
- `startExportJob`: validates input, creates an export job, and starts generation.
- `getExportJob`: returns job status, stage, counts, warnings, errors, and archive object key when ready.
- `createArchiveDownloadUrl` or object-store bridge filter resolver: authorizes download of the generated archive key.

Job stages:

- `validating`
- `resolving-root`
- `listing-descendants`
- `fetching-pages`
- `converting-markdown`
- `building-archive`
- `ready`
- `failed`

It is acceptable for v1 to run generation in one resolver invocation if Forge runtime limits allow it, but the UI contract should still be job-based so a queue/background implementation can replace it later.

## Archive Delivery

The export result is a zip file stored in Forge Object Store with a short TTL.

Object keys should include the requesting account and job ID, for example:

```text
exports/{accountId}/{jobId}/{bundleSlug}.zip
```

Use the Forge object store bridge for download. Do not expose a public web trigger for archive download in v1.

Suggested archive TTL: 24 hours.

Do not persist durable export history. The downloaded `log.md` is the durable audit record.

## Bundle Layout

The zip contains exactly one OKF bundle directory.

Use a page tree layout under `pages/`. Include the page ID in filenames to avoid collisions.

Example:

```text
<bundle-slug>/
  index.md
  log.md
  pages/
    root-page-title-2895398596.md
    root-page-title-2895398596/
      child-page-title-1234567890.md
      child-page-title-1234567890/
        grandchild-title-2345678901.md
```

Rules:

- One Confluence source page produces exactly one OKF concept document.
- Concept IDs are derived from relative paths without `.md`.
- Slugs must be filesystem-safe and stable for a given title and page ID.
- Generated `index.md` files should be created at the bundle root and inside directories with child content.
- Do not include a separate `manifest.json` in v1.

## Concept Frontmatter

Each page concept document uses OKF frontmatter plus Confluence provenance.

Example:

```yaml
---
type: Confluence Page
title: Atlassian Performance Experience APEX Hub
description: First meaningful text excerpt from the page.
resource: https://example.atlassian.net/wiki/spaces/GDAY/pages/2895398596/...
tags:
  - label-one
timestamp: "2026-07-06T12:34:56Z"
confluence:
  page_id: "2895398596"
  space_id: "12345"
  space_key: GDAY
  parent_id: null
  version: 12
  status: current
  exported_at: "2026-07-06T12:40:00Z"
---
```

Description must be deterministic. Use the first meaningful text excerpt after HTML-to-Markdown conversion. Do not ask an LLM to summarize it.

## Concept Body

Each concept body preserves source content first, then appends generated navigation and provenance sections.

Shape:

```markdown
# <Confluence page title>

<Markdown converted from Confluence export_view HTML>

# Child pages

* [Child title](child-title-1234567890.md)

# Attachments

* [filename.pdf](https://example.atlassian.net/wiki/...) - application/pdf

# Citations

[1] [Original Confluence page](https://example.atlassian.net/wiki/...)
```

Rules:

- Do not rewrite, summarize, or enrich page text.
- If converted page content already starts with the same H1, do not duplicate it.
- Generate `# Child pages` only when exported child pages exist.
- Generate `# Attachments` only when attachment metadata is available.
- Always include `# Citations` with the original Confluence page URL.
- Citations must remain source links and must not be rewritten to local bundle paths.

## Link Rewriting

Rewrite internal links in normal page body content when the target page is included in the same export.

Rules:

- Build a map from Confluence page ID to generated concept path before conversion cleanup.
- Rewrite body links to exported pages as relative Markdown links.
- Keep external links unchanged.
- Keep links to Confluence pages outside the export as Confluence URLs.
- Do not rewrite links inside the generated `# Citations` section.
- If a link cannot be resolved confidently, keep the original URL.

## Attachments

Do not export binary attachments in v1.

If attachment metadata is available without broadening scopes materially, include it as text:

- filename
- media type
- source/download link

If attachment metadata requires additional complexity or `read:attachment:confluence`, it may be omitted from v1.

## Root Index

The root `index.md` is the bundle navigation entry point.

It may include frontmatter:

```yaml
---
okf_version: "0.1"
type: Confluence Export
title: <bundle title>
description: Deterministic OKF export from a Confluence page tree.
timestamp: "2026-07-06T12:40:00Z"
---
```

Then include links to top-level directories and/or the root concept document. Follow the OKF index format where practical.

## Log File

Include a minimal `log.md`.

Example:

```markdown
# Bundle Update Log

## 2026-07-06
* **Export**: Created from Confluence page tree rooted at [Page Title](https://example.atlassian.net/wiki/...).
* **Scope**: Included pages up to depth 5.
* **Result**: Exported 42 pages, skipped 2 pages.
```

If pages are skipped, record page IDs and titles when known.

## Failure Handling

Partial export rules:

- Root page read failure fails the job.
- Descendant listing failure fails the job.
- Individual descendant page failures are skipped and reported.
- Markdown conversion failure for a page should still produce a concept document with frontmatter, provenance, source citation, and a body warning that conversion failed.
- Archive creation failure fails the job.
- Object Store upload failure fails the job.

The UI must show exported page count, skipped page count, conversion warnings, and the final download action when ready.

## Dependencies

Likely runtime dependencies:

- HTML-to-Markdown conversion library, such as `turndown`.
- Zip creation library, such as `jszip`.
- YAML frontmatter serializer, such as `yaml`, or a small local serializer if the data shape remains simple.
- Forge Object Store APIs/bridge.

After adding dependencies, install them with the project package manager and commit the lockfile changes.

## Acceptance Criteria

- The app renders an admin-only Confluence global settings Execution UI.
- The UI best-effort prefills the current user's personal-space homepage.
- The user can paste a same-site Confluence page URL.
- Cross-site Confluence page URLs are rejected.
- Depth defaults to 5 and cannot exceed 5.
- Export runs as the current user.
- Export produces a downloadable zip from Forge Object Store.
- Zip contains exactly one OKF bundle directory.
- Bundle contains root `index.md`, `log.md`, and one concept document per exported page.
- Concept documents have valid YAML frontmatter and `type: Confluence Page`.
- Concept documents include Confluence provenance.
- Concept bodies are deterministic Markdown converted from export-view HTML.
- Source citations link back to original Confluence pages.
- Internal body links to exported pages are rewritten to relative Markdown links.
- Citation links are not rewritten.
- Binary attachments are not included.
- No Confluence write scopes are requested.
- No separate `manifest.json` is generated.

## Deferred v2 Ideas

- Add `confluence:contentAction` to start an export from the current page.
- Add fallback conversion through v1 async content body conversion if v2 export-view reads are insufficient.
- Export attachment binaries into an `assets/` directory.
- Add durable export history.
- Add incremental regeneration and a cache manifest if local tooling benefits from it.
- Add LLM-assisted enrichment as a separate local post-processing workflow, not as part of deterministic export.
