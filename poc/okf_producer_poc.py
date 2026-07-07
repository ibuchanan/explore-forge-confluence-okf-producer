# /// script
# requires-python = ">=3.14"
# dependencies = [
#     "beautifulsoup4>=4.15.0",
#     "markdownify>=1.2.3",
#     "pyyaml>=6.0.3",
#     "requests>=2.34.2",
# ]
# ///

"""
v0 proof-of-concept for the OKF producer.

Reads a Confluence page tree via REST API v2 (as the authenticated user via
a scoped API token, standing in for Forge's asUser() reads) and writes an
OKF bundle zip, following specs/okf-producer-v1.md. Not a Forge app -- this
is a standalone script to validate the fetch -> convert -> bundle pipeline
before building the Forge UI/resolver/object-store layer.

Requests go through the Atlassian API gateway
(https://api.atlassian.com/ex/confluence/{cloudId}/...) rather than the
site domain, since scoped API tokens are only valid against the gateway.
The cloudId is resolved automatically from the site's /_edge/tenant_info
endpoint.

Usage:
    export CONFLUENCE_EMAIL=you@example.com
    export CONFLUENCE_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
    uv run poc/okf_producer_poc.py "https://your-site.atlassian.net/wiki/spaces/KEY/pages/123456/Title"

Known v0 simplifications vs. the full spec:
    - No attachment metadata (the "# Attachments" section is never emitted).
    - Internal link rewriting only recognizes /pages/{id} style hrefs, not
      short "/wiki/x/..." links.
    - Labels are best-effort via include-labels on the page GET; no fallback
      to the separate labels endpoint if that's not honored.
    - Descendants are listed by walking GET /pages/{id}/children level by
      level (one call per page per level) instead of the single paginated
      GET /pages/{id}/descendants call the spec describes. The descendants
      endpoint needs read:hierarchical-content:confluence, which is an
      OAuth2/Forge-only scope not grantable to a basic-auth API token.
"""

import argparse
import os
import posixpath
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
import yaml
from bs4 import BeautifulSoup
from markdownify import markdownify as html_to_markdown


class ExportFailed(Exception):
    pass


@dataclass
class PageRecord:
    id: str
    title: str
    parent_id: str | None
    space_id: str
    version: int
    status: str
    web_url: str
    html: str | None
    labels: list[str]
    conversion_error: str | None = None
    slug: str | None = None
    concept_path: str | None = None
    children: list[str] = field(default_factory=list)


def resolve_cloud_id(site_base_url: str) -> str:
    resp = requests.get(f"{site_base_url}/_edge/tenant_info", timeout=15)
    resp.raise_for_status()
    return resp.json()["cloudId"]


class ConfluenceClient:
    def __init__(self, site_base_url: str, email: str, api_token: str):
        self.site_base_url = site_base_url.rstrip("/")
        cloud_id = resolve_cloud_id(self.site_base_url)
        self.base_url = f"https://api.atlassian.com/ex/confluence/{cloud_id}"
        self.session = requests.Session()
        self.session.auth = (email, api_token)
        self.session.headers.update({"Accept": "application/json"})
        self._space_key_cache: dict[str, str] = {}

    def get_page(self, page_id: str) -> PageRecord:
        url = f"{self.base_url}/wiki/api/v2/pages/{page_id}"
        params = {"body-format": "export_view", "include-labels": "true"}
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        body = data.get("body") or {}
        export_view = body.get("export_view") or body.get("exportView") or {}
        html = export_view.get("value")

        labels_obj = data.get("labels") or {}
        labels = [
            entry.get("name")
            for entry in labels_obj.get("results", [])
            if entry.get("name")
        ]

        parent_id = data.get("parentId")
        links = data.get("_links") or {}
        # `webui` is relative to `_links.base` (which may or may not include
        # the `/wiki` context path), not to the bare site root. Fall back to
        # the site domain, not the API gateway host, since this URL is for
        # humans to click.
        link_base = (links.get("base") or f"{self.site_base_url}/wiki").rstrip("/")
        web_url = link_base + links.get("webui", "")
        return PageRecord(
            id=str(data["id"]),
            title=data["title"],
            parent_id=str(parent_id) if parent_id else None,
            space_id=str(data["spaceId"]),
            version=(data.get("version") or {}).get("number", 0),
            status=data.get("status", "current"),
            web_url=web_url,
            html=html,
            labels=labels,
        )

    def get_child_ids(self, page_id: str) -> list[str]:
        url = f"{self.base_url}/wiki/api/v2/pages/{page_id}/children"
        params = {"limit": 100}
        ids = []
        while url:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("results", []):
                if item.get("status", "current") == "current":
                    ids.append(str(item["id"]))
            next_link = (data.get("_links") or {}).get("next")
            if next_link:
                # Concatenate rather than urljoin: next_link is an absolute
                # path like "/wiki/api/v2/pages/.../children?cursor=...",
                # and urljoin against an absolute path would drop the
                # "/ex/confluence/{cloudId}" gateway prefix from base_url.
                url = self.base_url + next_link
                params = None
            else:
                url = None
        return ids

    def get_descendant_ids(self, root_id: str, depth: int) -> list[str]:
        # GET /pages/{id}/descendants needs read:hierarchical-content:confluence,
        # which isn't grantable to a basic-auth API token (scoped or classic) --
        # it's OAuth2/Forge-only. Walk /children level by level instead, which
        # only needs read:page:confluence.
        ids = []
        frontier = [root_id]
        for _ in range(depth):
            next_frontier = []
            for page_id in frontier:
                try:
                    children = self.get_child_ids(page_id)
                except Exception as exc:
                    if page_id == root_id:
                        raise
                    print(
                        f"Warning: could not list children of {page_id}, "
                        f"treating it as a leaf: {exc}",
                        file=sys.stderr,
                    )
                    continue
                ids.extend(children)
                next_frontier.extend(children)
            frontier = next_frontier
            if not frontier:
                break
        return ids

    def get_space_key(self, space_id: str) -> str:
        if space_id not in self._space_key_cache:
            resp = self.session.get(
                f"{self.base_url}/wiki/api/v2/spaces/{space_id}", timeout=30
            )
            resp.raise_for_status()
            self._space_key_cache[space_id] = resp.json().get("key", "")
        return self._space_key_cache[space_id]


def parse_root_url(url: str) -> tuple[str, str]:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"Not a valid absolute URL: {url}")
    match = re.search(r"/pages/(\d+)", parsed.path)
    if not match:
        raise ValueError(f"Could not find a page ID in URL: {url}")
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    return base_url, match.group(1)


def slugify(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text or "page"


def fetch_all_pages(
    client: ConfluenceClient, root_id: str, depth: int
) -> tuple[dict[str, PageRecord], list[dict]]:
    try:
        root = client.get_page(root_id)
    except Exception as exc:
        raise ExportFailed(f"root page read failed: {exc}")

    pages = {root.id: root}

    try:
        descendant_ids = client.get_descendant_ids(root_id, depth)
    except Exception as exc:
        raise ExportFailed(f"descendant listing failed: {exc}")

    skipped = []
    for descendant_id in descendant_ids:
        try:
            page = client.get_page(descendant_id)
            pages[page.id] = page
        except Exception as exc:
            skipped.append({"id": descendant_id, "title": None, "reason": str(exc)})
    return pages, skipped


def build_tree(pages: dict[str, PageRecord]) -> None:
    for page in pages.values():
        if page.parent_id and page.parent_id in pages:
            pages[page.parent_id].children.append(page.id)
    for page in pages.values():
        page.children.sort(key=lambda cid: pages[cid].title.lower())


def assign_paths(pages: dict[str, PageRecord], root_id: str) -> None:
    root = pages[root_id]
    root.slug = f"{slugify(root.title)}-{root.id}"
    root.concept_path = f"pages/{root.slug}.md"

    queue = [root_id]
    while queue:
        pid = queue.pop(0)
        page = pages[pid]
        children_dir = page.concept_path[: -len(".md")]
        for cid in page.children:
            child = pages[cid]
            child.slug = f"{slugify(child.title)}-{child.id}"
            child.concept_path = f"{children_dir}/{child.slug}.md"
            queue.append(cid)


def rewrite_internal_links(html: str, current_path: str, id_to_path: dict[str, str]):
    soup = BeautifulSoup(html, "html.parser")
    for anchor in soup.find_all("a", href=True):
        match = re.search(r"/pages/(\d+)", anchor["href"])
        if not match:
            continue
        target_path = id_to_path.get(match.group(1))
        if not target_path:
            continue
        anchor["href"] = posixpath.relpath(
            target_path, start=posixpath.dirname(current_path)
        )
    return str(soup)


def convert_page_html(html: str | None, current_path: str, id_to_path: dict[str, str]):
    if not html:
        return None
    rewritten = rewrite_internal_links(html, current_path, id_to_path)
    return html_to_markdown(rewritten, heading_style="ATX").strip()


def dedupe_leading_h1(markdown_text: str, title: str) -> str:
    text = markdown_text.lstrip("\n")
    if not text:
        return f"# {title}\n"
    first_line = text.split("\n", 1)[0].strip()
    heading_match = re.match(r"^#\s+(.*)$", first_line)
    if heading_match and heading_match.group(1).strip().casefold() == title.strip().casefold():
        return text
    return f"# {title}\n\n{text}"


def extract_description(markdown_text: str | None, limit: int = 280) -> str:
    if not markdown_text:
        return "Content unavailable."
    for line in markdown_text.splitlines():
        text = line.strip()
        if not text:
            continue
        text = re.sub(r"^#+\s*", "", text)
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        text = re.sub(r"[*_`>]", "", text).strip()
        if not text:
            continue
        if len(text) > limit:
            text = text[:limit].rsplit(" ", 1)[0] + "…"
        return text
    return "No content."


def render_frontmatter(data: dict) -> str:
    dumped = yaml.safe_dump(data, sort_keys=False, default_flow_style=False, allow_unicode=True)
    return f"---\n{dumped}---\n"


def render_concept_document(
    page: PageRecord,
    pages: dict[str, PageRecord],
    id_to_path: dict[str, str],
    space_key_map: dict[str, str],
    exported_at: str,
) -> str:
    converted = None
    if page.html:
        try:
            converted = convert_page_html(page.html, page.concept_path, id_to_path)
        except Exception as exc:
            page.conversion_error = str(exc)
    else:
        page.conversion_error = "export_view HTML was not available for this page."

    citation_url = page.web_url

    frontmatter = {
        "type": "Confluence Page",
        "title": page.title,
        "description": extract_description(converted),
        "resource": citation_url,
    }
    if page.labels:
        frontmatter["tags"] = page.labels
    frontmatter["timestamp"] = exported_at
    frontmatter["confluence"] = {
        "page_id": page.id,
        "space_id": page.space_id,
        "space_key": space_key_map.get(page.space_id, ""),
        "parent_id": page.parent_id if page.parent_id in pages else None,
        "version": page.version,
        "status": page.status,
        "exported_at": exported_at,
    }

    if page.conversion_error:
        body_core = f"# {page.title}\n\n> **Warning:** Markdown conversion failed for this page ({page.conversion_error})."
    else:
        body_core = dedupe_leading_h1(converted, page.title)

    sections = [body_core]

    if page.children:
        lines = ["# Child pages", ""]
        for cid in page.children:
            child = pages[cid]
            rel = posixpath.relpath(
                child.concept_path, start=posixpath.dirname(page.concept_path)
            )
            lines.append(f"* [{child.title}]({rel})")
        sections.append("\n".join(lines))

    sections.append(f"# Citations\n\n[1] [Original Confluence page]({citation_url})")

    return render_frontmatter(frontmatter) + "\n" + "\n\n".join(sections) + "\n"


def render_dir_index(page: PageRecord, pages: dict[str, PageRecord], exported_at: str) -> str:
    frontmatter = {
        "okf_version": "0.1",
        "type": "Confluence Export",
        "title": f"{page.title} — Contents",
        "description": f"Navigation index for pages under {page.title}.",
        "timestamp": exported_at,
    }
    overview_name = posixpath.basename(page.concept_path)
    lines = [
        f"# {page.title} — Contents",
        "",
        f"* [{page.title} (overview)](../{overview_name})",
        "",
    ]
    for cid in page.children:
        child = pages[cid]
        lines.append(f"* [{child.title}]({posixpath.basename(child.concept_path)})")
    return render_frontmatter(frontmatter) + "\n" + "\n".join(lines) + "\n"


def render_root_index(root_page: PageRecord, bundle_title: str, exported_at: str) -> str:
    frontmatter = {
        "okf_version": "0.1",
        "type": "Confluence Export",
        "title": bundle_title,
        "description": "Deterministic OKF export from a Confluence page tree.",
        "timestamp": exported_at,
    }
    body = f"# {bundle_title}\n\n* [{root_page.title}]({root_page.concept_path})\n"
    return render_frontmatter(frontmatter) + "\n" + body


def render_log(
    root_page: PageRecord,
    depth: int,
    exported_count: int,
    skipped: list[dict],
    date_str: str,
) -> str:
    lines = [
        "# Bundle Update Log",
        "",
        f"## {date_str}",
        f"* **Export**: Created from Confluence page tree rooted at "
        f"[{root_page.title}]({root_page.web_url}).",
        f"* **Scope**: Included pages up to depth {depth}.",
        f"* **Result**: Exported {exported_count} pages, skipped {len(skipped)} pages.",
    ]
    for entry in skipped:
        lines.append(f"  * Skipped: {entry['id']} - {entry.get('title') or 'unknown'} ({entry['reason']})")
    return "\n".join(lines) + "\n"


def zip_bundle(bundle_dir: Path, out_zip: Path) -> None:
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(bundle_dir.rglob("*")):
            if file_path.is_file():
                zf.write(file_path, arcname=file_path.relative_to(bundle_dir.parent))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root_url", help="URL of the root Confluence page to export")
    parser.add_argument("--depth", type=int, default=5, help="Descendant depth cap (max 5)")
    parser.add_argument("--bundle-slug", help="Override the derived bundle slug")
    parser.add_argument("--out", help="Output zip path (default: ./<bundle-slug>.zip)")
    args = parser.parse_args()

    email = os.environ.get("CONFLUENCE_EMAIL")
    token = os.environ.get("CONFLUENCE_API_TOKEN")
    if not email or not token:
        print(
            "CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN must be set in the environment.",
            file=sys.stderr,
        )
        return 1

    depth = min(args.depth, 5)
    if args.depth > 5:
        print(f"Depth {args.depth} exceeds the maximum; clamping to 5.", file=sys.stderr)

    try:
        base_url, root_id = parse_root_url(args.root_url)
    except ValueError as exc:
        print(f"Invalid root URL: {exc}", file=sys.stderr)
        return 1

    try:
        client = ConfluenceClient(base_url, email, token)
    except Exception as exc:
        print(f"Could not resolve cloudId for {base_url}: {exc}", file=sys.stderr)
        return 1

    try:
        pages, skipped = fetch_all_pages(client, root_id, depth)
    except ExportFailed as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        return 1

    build_tree(pages)
    assign_paths(pages, root_id)

    id_to_path = {pid: page.concept_path for pid, page in pages.items()}

    space_key_map = {
        page.space_id: client.get_space_key(page.space_id) for page in pages.values()
    }

    root_page = pages[root_id]
    bundle_slug = args.bundle_slug or slugify(root_page.title)
    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    with tempfile.TemporaryDirectory() as tmp_str:
        bundle_dir = Path(tmp_str) / bundle_slug

        for page in pages.values():
            doc = render_concept_document(
                page, pages, id_to_path, space_key_map, exported_at
            )
            doc_path = bundle_dir / page.concept_path
            doc_path.parent.mkdir(parents=True, exist_ok=True)
            doc_path.write_text(doc, encoding="utf-8")

            if page.children:
                index_dir = bundle_dir / page.concept_path[: -len(".md")]
                index_dir.mkdir(parents=True, exist_ok=True)
                (index_dir / "index.md").write_text(
                    render_dir_index(page, pages, exported_at), encoding="utf-8"
                )

        (bundle_dir / "index.md").write_text(
            render_root_index(root_page, root_page.title, exported_at), encoding="utf-8"
        )
        (bundle_dir / "log.md").write_text(
            render_log(
                root_page,
                depth,
                len(pages),
                skipped,
                datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            ),
            encoding="utf-8",
        )

        out_path = Path(args.out) if args.out else Path(f"./{bundle_slug}.zip")
        zip_bundle(bundle_dir, out_path)

    print(f"Exported {len(pages)} pages, skipped {len(skipped)}.")
    for entry in skipped:
        print(f"  skipped {entry['id']}: {entry['reason']}")
    print(f"Bundle written to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
