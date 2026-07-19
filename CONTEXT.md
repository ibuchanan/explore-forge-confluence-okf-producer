# OKF Producer

This context describes a Confluence Forge app that exports Confluence knowledge into Open Knowledge Format artifacts for downstream local agent tooling.

## Language

**OKF Producer**:
A Forge app that creates exportable **OKF Bundles** from Confluence source content.
_Avoid_: OKF publisher, Confluence importer

**OKF Bundle**:
A portable directory of Markdown files with YAML frontmatter that represents a knowledge corpus.
_Avoid_: Confluence page set, generated wiki

**OKF Bundle Builder**:
The archive-construction boundary that turns fetched **Source Pages** into one packaged **OKF Bundle**.
_Avoid_: export job runner, helper collection

**Agent Skill**:
A downstream local artifact generated from an **OKF Bundle** for use by an agent runtime.
_Avoid_: Forge app feature, Confluence macro

**Source Content**:
Confluence content selected as input for an **OKF Bundle**.
_Avoid_: Uploaded bundle, destination content

**Source Page**:
A Confluence page selected directly or through a selected page tree as input for an **OKF Bundle**.
_Avoid_: OKF page, uploaded page

**Concept Document**:
A single Markdown file with YAML frontmatter inside an **OKF Bundle**.
_Avoid_: Confluence page, generated page

**Deterministic Export**:
An export that preserves source claims without model rewriting or inferred enrichment.
_Avoid_: LLM rewrite, generated interpretation

**Export Archive**:
A downloadable zip file containing one **OKF Bundle**.
_Avoid_: Confluence upload, hosted bundle

**Attachment Metadata**:
Textual facts about a Confluence attachment, such as its filename, media type, and source link, without the attachment binary.
_Avoid_: Bundled attachment, asset copy

**Export Job**:
A user-initiated run that creates one **Export Archive** from selected **Source Content**.
_Avoid_: Sync, import job

**Export Job Intake**:
The synchronous step where the **OKF Producer** validates an **Execution UI** request, confirms selected **Source Content** is readable in the **Installed Site**, enumerates **Source Pages**, records skipped branches, creates the **Export Job**, and schedules archive production.
_Avoid_: Export service, job controller

**Export Job Lifecycle**:
The state-transition boundary for one **Export Job**, from queued creation through async progress, cancellation request, and terminal ready, failed, or cancelled states.
_Avoid_: job patch, persistence update

**Execution UI**:
A non-durable screen where a user chooses export inputs and starts an **Export Job**.
_Avoid_: configuration page, settings page

**Installed Site**:
The Atlassian site where the Forge app is installed and from which it can read Confluence content.
_Avoid_: source tenant, arbitrary Confluence site

**Default Source Page**:
The best-effort root page preselected in the **Execution UI**, preferably the current user's personal space homepage.
_Avoid_: durable default, APEX Hub default

**Page Tree Layout**:
An **OKF Bundle** layout that mirrors Confluence parent-child page hierarchy under a `pages/` directory.
_Avoid_: flat page list, topic synthesis

**Confluence Provenance**:
Metadata in a **Concept Document** that identifies the original Confluence page, space, version, and export time.
_Avoid_: source rewrite, generated claim

**Source Citation**:
A citation link in a **Concept Document** that points back to original source material rather than to a local rewritten bundle path.
_Avoid_: rewritten citation, inferred citation

**Export View**:
The rendered Confluence HTML representation used as the source for Markdown conversion.
_Avoid_: ADF source, storage source

**Presumptive Export View**:
A first-version assumption that Confluence REST v2 page reads can provide usable **Export View** content without a fallback conversion pipeline.
_Avoid_: v1 conversion fallback, storage fallback

## Relationships

- An **OKF Producer** exports one or more **OKF Bundles**.
- An **Execution UI** starts an **Export Job** without making the chosen inputs durable configuration.
- **Export Job Intake** creates and schedules an **Export Job** only after selected **Source Content** has been validated and enumerated.
- **Export Job Lifecycle** controls state changes within one **Export Job**; the latest-job pointer only helps the **Execution UI** rediscover the most recent job.
- An **Export Archive** contains exactly one **OKF Bundle**.
- An **Export Job** creates exactly one **Export Archive**.
- The **OKF Bundle Builder** creates one **OKF Bundle** after an **Export Job** has fetched readable **Source Pages**.
- An **OKF Bundle** is created from **Source Content** in the **Installed Site**.
- A **Page Tree Layout** preserves **Source Page** hierarchy in the **OKF Bundle**.
- **Confluence Provenance** connects a **Concept Document** back to its **Source Page**.
- A **Source Citation** remains a link to source material even when body links are rewritten for local bundle navigation.
- A **Default Source Page** may seed the **Execution UI** but can be replaced before an **Export Job** starts.
- A **Source Page** produces exactly one **Concept Document**.
- **Attachment Metadata** may be included in a **Concept Document** without adding attachment binaries to the **Export Archive**.
- A **Deterministic Export** may transform representation formats but does not reinterpret **Source Content**.
- **Export View** is converted into Markdown for each **Concept Document**.
- **Presumptive Export View** limits the first version to the direct Confluence REST v2 body read path.
- An **Agent Skill** is generated locally from one **OKF Bundle**.

## Example dialogue

> **Dev:** "Should the **OKF Producer** create pages in Confluence?"
> **Domain expert:** "No. It reads **Source Content** from Confluence and exports an **OKF Bundle** that local tools can turn into an **Agent Skill**."
>
> **Dev:** "Can the app summarize a **Source Page** while exporting it?"
> **Domain expert:** "Not in the first version. It should run a **Deterministic Export** and leave enrichment to local tooling."

## Flagged ambiguities

- "Producer" previously risked meaning "publish OKF into Confluence"; resolved: the **OKF Producer** exports OKF out of Confluence for local tooling.
- "Export View fallback" was considered for storage-to-export conversion; resolved: first version uses **Presumptive Export View** and does not implement a fallback conversion pipeline.
- "Bundle manifest" was considered for machine-readable export metadata; resolved: first version does not include a separate manifest because regeneration caching is out of scope.
