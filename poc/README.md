# OKF Producer v0 Proof of Concept (Python)

A standalone script that validates the core export pipeline from
`specs/okf-producer-v1.md` — Confluence read, HTML-to-Markdown conversion,
link rewriting, and OKF bundle packaging — without the Forge app scaffold.
It reads real Confluence content over the REST API v2, authenticated with a
personal API token (standing in for Forge's `asUser()` reads).

## Setup

1. Create a **scoped API token**: https://id.atlassian.com/manage-profile/security/api-tokens
   → "Create API token with scopes" → choose the Confluence app → select:

   - `read:page:confluence` — read the root page and each descendant page.
   - `read:hierarchical-content:confluence` — list descendants
     (`GET /pages/{id}/descendants` requires this scope specifically, not
     `read:page:confluence` — confirmed against
     `specs/references/confluence-cloud-v2.swagger.v3.json`).
   - `read:space:confluence` — resolve each page's space key.

   Scoped tokens only work against the Atlassian API gateway
   (`https://api.atlassian.com/ex/confluence/{cloudId}/...`), not the site
   domain directly. This script handles that automatically: it resolves the
   site's `cloudId` from `https://<site>.atlassian.net/_edge/tenant_info`
   (unauthenticated) and routes all Confluence API calls through the
   gateway. You still pass a normal site page URL on the command line.

2. Export credentials:

   ```sh
   export CONFLUENCE_EMAIL=you@example.com
   export CONFLUENCE_API_TOKEN=...
   ```

## Run

```sh
uv run poc/okf_producer_poc.py "https://hello.atlassian.net/wiki/spaces/GDAY/pages/2895398596/APEX+Hub"
```

Options:

- `--depth N` — descendant depth cap, default and max `5`.
- `--bundle-slug NAME` — override the slug derived from the root page title.
- `--out PATH` — output zip path, default `./<bundle-slug>.zip`.

`uv` manages the script's dependencies itself via inline PEP 723 metadata at
the top of `okf_producer_poc.py` — no separate install step needed.

## Known v0 simplifications

These are deliberate gaps versus the full spec, acceptable for validating
the pipeline shape but not sufficient for the real Forge app:

- No attachment metadata — the `# Attachments` section is never emitted.
- Internal link rewriting only recognizes `/pages/{id}`-style hrefs, not
  Confluence's short `/wiki/x/...` links.
- Labels are best-effort via `include-labels` on the page GET; no fallback
  to the separate labels endpoint.
- Auth is a personal API token, not a true analog of Forge's per-user
  `asUser()` authorization model.
- `cloudId` resolution uses `/_edge/tenant_info`, an unauthenticated but
  undocumented/unofficial endpoint. It's the common workaround developers
  use for this; the officially supported alternative
  (`GET https://api.atlassian.com/oauth/token/accessible-resources`)
  requires an OAuth bearer token, not a basic-auth API token.
- Runs synchronously with no job/polling model.
