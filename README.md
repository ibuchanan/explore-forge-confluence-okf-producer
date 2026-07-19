# Confluence OKF Producer

[![Listed on BundleDex](https://bundledex.net/badge.svg)](https://bundledex.net/bundles/explore-forge-confluence-okf-producer/)

[On June 12, 2026, Google announced](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing):
> [the Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf),
> an open specification that formalizes the
> [LLM-wiki][llm-wiki] pattern
> into a portable, interoperable format.
> This is a vendor-neutral, agent- and human-friendly standard
> for representing the metadata, context, and curated knowledge
> that modern AI systems need.

[llm-wiki]: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

This repo is an OKF Producer for Confluence
that exports a selected Confluence page tree
into a downloadable Open Knowledge Format (OKF) bundle
for local agent tooling.
It reads Confluence content from the site
where it is installed;
it does not write OKF content back to Confluence.

Does OKF replace RAG?
No.
OKF is best for stable, highly structured core business logic and documentation.
For example, OKF is a good way to encapsulate slow-changing policy,
procedures, and reference
to bundle into a skill.
Meanwhile, RAG is best for massive, messy, historical, or unpredictable data.
It off-loads some of the work of "sense making" to a pre-encoded search engine.
For example, Atlassian's [Teamwork Graph](https://www.atlassian.com/platform/teamwork-graph)
connects to the more dynamic world of goals, teams, and work,
That kind of context is best made available dynamically
when making a request to an agent.

## Status

The root implementation follows [the v1 specification](specs/okf-producer-v1.md),
and the standalone Python proof of concept remains in [poc/](poc/README.md).
At this time, version 0.1.0 of the OKF spec defines some useful front-matter metadata,
but otherwise leaves a lot of the format open for interpretation.
Even for a seemingly simple export of Confluence data,
exactly how an OKF bundle is produced and what is in it
depends on application to specific use cases.
Therefore this [Forge App](https://go.atlassian.com/forge)
is a simple and conservative reference implementation.
Join us in [the Atlassian developer community](https://community.developer.atlassian.com/c/confluence/confluence-cloud/9)
if you have questions or feedback.

## Prerequisites

- [Node.js 24][node-download] for local development. The repo includes
  `.nvmrc` and `.node-version`, and `package.json` constrains
  `engines.node` to `>=24 <25`.
- [npm][npm-install] for dependency installation and package scripts.
- [Atlassian Forge CLI][forge-getting-started], authenticated with an
  Atlassian account. The `forge:*` scripts assume `forge` is available on
  `PATH`.
- A Confluence Cloud site where the Forge app can be registered, deployed,
  and installed.

[node-download]: https://nodejs.org/en/download
[npm-install]: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm
[forge-getting-started]: https://developer.atlassian.com/platform/forge/getting-started/

## Quick Start

Clone the repository:

```sh
git clone https://github.com/ibuchanan/explore-forge-confluence-okf-producer.git
```

Install dependencies and run the local test suite:

```sh
npm install
npm test
```

Run the full project check when the Forge CLI is available on `PATH`:

```sh
npm run check
```

`npm run check` composes
Biome linting,
Biome formatting checks,
TypeScript checking,
Forge linting,
the bundle size check,
and a suite of unit tests.

## Forge Setup

The Forge scripts source `.env`. Start from the checked-in example:

```sh
cp .env.example .env
```

Set these values in `.env`:

| Variable | Purpose |
| --- | --- |
| `FORGE_SITE` | Atlassian site host, such as `example.atlassian.net`. |
| `FORGE_PRODUCT` | Product passed to `forge install`; use `confluence`. |
| `FORGE_ENVIRONMENT` | Forge target environment. |

`FORGE_ENVIRONMENT` is usually `development`, `staging`, or `production`.

Register, deploy, and install:

```sh
npm run forge:register
npm run forge:deploy
npm run forge:install
```

The Forge CLI must already be installed and authenticated.
The scripts assume a `forge` executable is available on `PATH`.

## Using the App

After installation,
open the `OKF Producer` Confluence global settings page for the installed app.

The Execution UI lets an admin:

- paste Confluence page URL from the current site
- choose a depth cap from `1` to `5`
- edit the output bundle slug
- start, monitor, cancel, and download an export job

When the job is ready,
the UI creates a Forge Object Store download URL for `<bundle-slug>.zip`.

## Export Behavior

An export starts from one root page
and includes descendant pages up to the selected depth cap.
The archive contains exactly one OKF bundle directory with:

- `index.md` as the bundle navigation entry point
- `log.md` as the export audit record
- one concept document per exported Confluence page under `pages/`

Each concept document includes
YAML front matter,
Confluence provenance,
converted Markdown from `export_view` HTML,
child-page links when available,
and a source citation back to the original Confluence page.
Internal links to pages included in the same export
are rewritten to relative Markdown links.

The resolver validates the root page
and enumerates descendants as the current user before creating a job.
The async queue consumer fetches page content as the app,
so restricted spaces must also allow the app to read the selected content.

## Limitations

- Binary attachments are not exported.
- The app does not publish OKF bundles into Confluence.
- Export history is not durable;
  the UI only remembers the latest job pointer for the current account.
- There is no fallback conversion path
  if Confluence `export_view` HTML is missing or unusable.
- Individual descendant page failures are skipped and reported,
  but root page read failures and descendant listing failures fail the job.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
