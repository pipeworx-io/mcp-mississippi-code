# @pipeworx/mississippi-code

Mississippi Code of 1972 (Annotated) — section lookup by citation, chapter
browsing by title, and topic/keyword search over official catchlines.
Fleet #2883. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1882+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ms_code_section(citation)` — the text of a section by citation
  (`"97-3-19"`, `"Miss. Code Ann. § 89-8-19"`, `"Section 97-3-19"`). Returns
  the catchline, the operative statutory text, the `HISTORY:` line, and
  Joint Legislative Committee / Amendment / Cross-Reference notes when
  present, AND a `later_acts` overlay — every act this pack's own crawl of
  Mississippi's signed-bill text shows touching this exact citation since
  the 2020-07-08 snapshot (fleet #2915, see "The overlay" below). Case-law
  (`JUDICIAL DECISIONS`) annotations are deliberately excluded — they can
  run to hundreds of citations per section and are not what a caller asking
  "what does this statute say" wants back.
- `ms_code_chapters(title)` — every chapter heading and number within a
  title (`97` is Crimes, `89` is Real and Personal Property), for browsing
  when you don't have an exact citation.
- `ms_code_search(query, limit?)` — topic/keyword search over every
  section's official CATCHLINE (not full statutory body text — see "Why no
  full-text search" below). Matches like North Dakota's `nd_search`: IDF-
  weighted word overlap over a baked index, not a live upstream call.

## Auth

Keyless. No signup, no login, on either side of the call.

## Why no full-text search

The official LexisNexis-hosted Code (`lexisnexis.com/hottopics/mscode`,
linked from the Secretary of State's own site) sits behind a Cloudflare
managed challenge — confirmed live: every direct request gets a "Just a
moment..." interstitial page, HTTP 403, no statute text. The two common free
third-party renderings, `law.justia.com` and `codes.findlaw.com`, sit behind
the **exact same** Cloudflare challenge (confirmed live, identical
"Just a moment..." body) — this is not a Lexis-specific wall, it's a
Cloudflare bot-check in front of three different vendors' copies of the same
text, so there is no "try a different mirror of the search UI" move here.

## Data source

- <https://unicourt.github.io/cic-code-ms/> — a GitHub Pages copy of the
  Mississippi Code, built by UniCourt on behalf of Public.Resource.Org from
  the Code's own officially-released RTF volumes
  (`archive.org/download/gov.ms.code.ann.2018`), "in the public domain, NO
  RIGHTS RESERVED" per that repo's own README. One title per HTML page
  (`gov.ms.code.title.{NN}.html`, title zero-padded to 2 digits — Mississippi
  titles are odd numbers 1-99), fetched LIVE per `ms_code_section` /
  `ms_code_chapters` call — this pack proxies it, it does not ship a copy of
  the Code in the repo (`mirror-needs-grant-proxy-does-not` in the Pipeworx
  CLAUDE.md licence section).

  The underlying statutory TEXT is public law regardless of what any
  publisher's licence says about its own rendering — enacted law carries no
  copyright (*Banks v. Manchester*, 128 U.S. 244 (1888); *Veeck v. SBCCI*,
  293 F.3d 791 (5th Cir. 2002) (en banc)).

**THE HONEST LIMIT.** This source is **Release 78, released 2020-07-08**,
generated from the Code's 2018 printed RTF volumes. It is a static snapshot,
not a continuously updated feed — amendments enacted in the 2021 through
2026 Regular Sessions are **not reflected**. Every response carries
`current_through` and `data_as_of: "2020-07-08"` rather than defaulting to
"now", which would misrepresent six-year-old text as current law. For
anything enacted after mid-2020, verify against the official LexisNexis-
hosted Code or contact the Joint Legislative Committee on Compilation,
Revision and Publication of Legislation (Miss. Code Ann. §§ 1-1-101 to
1-1-111).

**Title 79 (Corporations, Associations, and Partnerships) cannot be looked
up section-by-section.** Checked live across all 50 titles (2026-10-09):
every other title's section-heading tag (`h3`, id attribute formatted
`t{title}c{chapter}s{citation}`) carries that id — 27,688 sections total —
but Title 79's ~700 section headings are all bare `h3` tags with no id at
all (reused instead for
unrelated asides like editor's notes), and the internal citation anchor it
links to (e.g. `href="#t79c01s79-1-1"`) is **dangling** — no element in that
title's document carries that id. `ms_code_section` names this explicitly
(`reason: "title_markup_unsupported"`) rather than returning an
indistinguishable `citation_not_found`. `ms_code_chapters` still works for
Title 79 (its chapter table of contents is intact); only section-level text
extraction is blocked.

## The overlay: later acts, never merged (fleet #2915)

Bruce kept `ms_code_section` on the frozen 2020-07-08 snapshot ("we'll need
to figure something out") rather than chase a fully reconciled current code
— the same ruling `arkansas-code`'s overlay (fleet #2906) shipped under.
This overlay is the cheapest honest improvement on top of that decision —
design and measurements in `docs/current-statute-routes.md` (#2902).

**Unlike Arkansas, Mississippi's legislature publishes no ready-made
citation-to-act index.** `billstatus.ls.state.ms.us` has bill-status pages
and signed-bill text, not a "sections amended" lookup — so this overlay is
**home-built**: crawl every enacted bill's own signed text and parse the
boilerplate every Mississippi amending bill uses, "SECTION N. Section
`<cite>`, Mississippi Code of 1972, is amended as follows:" (also "is
created"/"shall be codified as Section `<cite>`, Mississippi Code of
1972"/"is repealed"/"is brought forward as follows"/"is reenacted as
follows" — a sunset-renewal verb folded into the "amended" bucket since it
touches the citation the same way).

**The rule: never rewrite the snapshot `text`. Only ever ADD a dated, linked
list beside it, explicitly labelled as not merged.** `ms_code_section`'s
response carries:

- `later_acts` — one entry per act that touched this exact citation since
  the snapshot date: `chapter` (the Session Laws chapter number, from the
  bill's own history record — `null` if not yet assigned), `session`
  (human-readable, e.g. "2025 Regular Session"), `verb`
  (`amended`/`created`/`repealed`/`brought_forward`), `range_to` (non-null
  only when the act touched a `Sections X through Y` RANGE rather than one
  citation — see "Ranges" below), `link` (the bill's own signed-text page),
  `bill` (the measure number), `source: "billstatus"`, and `merged: false`.
  Empty (`[]`) means the overlay shows no later act for this citation across
  every session checked — not that the overlay failed to load (a
  missing/malformed KV index throws loudly instead, same as `ms_code_search`'s
  catchline index).
- `sessions_checked` — every session the overlay covers, named even when
  `later_acts` is empty, so a caller can tell "nothing changed" from "we
  didn't check."
- `later_acts_data_as_of` — when the overlay was last baked.

**Ranges.** A clause like "Sections 75-15-1 through 75-15-35, Mississippi
Code of 1972, ... is hereby repealed" is kept as ONE row carrying both
endpoints rather than this pack fabricating every citation in between (some
of which may not exist — Mississippi section numbering is not always
contiguous, confirmed live: one 2025 bill reenacted only the ODD-numbered
sections of a chapter). `ms_code_section` matches a queried citation against
a range by numeric containment on the trailing segment, with the same
title-chapter prefix — not by this script guessing which numbers the range
actually contains.

**What is deliberately NOT indexed** (measured on a 100-bill live sample,
see "Measured coverage" below): a clause amending an uncodified SESSION LAW
("Section 7, Chapter 467, Laws of 2019, ... is amended") never mentions "the
Mississippi Code of 1972" and is correctly excluded — it never touches a
Code citation. A clause creating a brand-new section that has not yet been
assigned a final citation ("Section N of this act shall be codified in
Chapter X, Title Y, Mississippi Code of 1972") is excluded too — there is
nothing to key a row on until the compiler assigns the number, which this
source does not do.

**A section not found in the Release-78 snapshot but present in the
overlay** is flagged specially: `ms_code_section`'s `found: false` response
carries `later_acts_if_created` — if this pack's own crawl shows acts
against a citation that does not exist in the 2020 snapshot, that is a
signal the section may have been CREATED after the snapshot date, not
necessarily a bad citation.

**Measured coverage (2026-10-10, 100 real enacted bills sampled evenly
across the 2021-2025 Regular Sessions):** 208 "SECTION N." clauses named
"Mississippi Code of 1972" near their start; 207 parsed into a verb (99.5%).
The one miss ("...Section 25-11-415, Mississippi Code of 1972, which
provides that...") is a descriptive cross-reference inside an appropriations
bill, not an amending clause — genuinely unparseable because it never uses
one of the five recognized verbs, reported to stderr by
`scripts/bake-later-acts.mjs` (`--report-unparsed` also emits it as a
`// UNPARSED_REPORT:` comment in the generated file) rather than silently
dropped. The **full production run** (every session discovered since
2021, not just the 100-bill sample) is the number actually baked into
`MS_LATER_ACTS` below.

**Source**: `billstatus.ls.state.ms.us` — keyless, no bot wall, confirmed
live 2026-10-10 (HTTP 200, plain HTML/XML, no JS rendering required). We are
proxying the Legislature's own public bill-status site per request during
the bake, not redistributing a copyrighted rendering — the statutory text
itself carries no copyright (*Banks v. Manchester*; *Veeck v. SBCCI*, both
cited above), and the bill text is the Legislature's own public record.

**For Tennessee (next): reuse, don't re-derive.** What carries over
directly from this build (same shape Arkansas handed to this one): the
response shape (`later_acts`/`sessions_checked`/
`later_acts_merged_into_text: false`/the "never rewrite text" rule), the
baked-index + KV injection pattern (append new exports to the SAME
`src/<xx>-index-data.ts` file the catchline index already uses), the
session-discovery-over-hardcoding trick (read the live session list rather
than a fixed one), and the `scripts/bake-later-acts.mjs` ->
`scripts/<xx>-later-acts-refresh.yml` shape for the refresh workflow.
Tennessee, like Mississippi, has no official citation index either (per
`docs/current-statute-routes.md`) — its bill text is PDF (`capitol.tn.gov`),
not HTML, so its boilerplate parser will need `pdftotext` rather than this
pack's HTML-stripping, but the regex shape of the boilerplate itself is the
same "SECTION N. Tennessee Code Annotated, Section X, is amended..." pattern.

## Refreshing the baked indexes

`src/ms-index-data.ts` carries TWO independently-baked tables, both injected
from KV via `workers/gateway/src/pack-baked-indexes.json` as one combined
`_bakedIndex` object rather than bundled (fleet #2754: a value-imported
multi-MB table loads into every gateway isolate whether or not it ever
serves this pack):

- `MS_SECTIONS` — `ms_code_search`'s catchline index, 27,688 rows across the
  49 titles whose markup supports it (see "Title 79" above). Rebuild with
  `node scripts/bake-index.mjs > src/ms-index-data.ts` (OVERWRITES the
  file — see below). Re-run only if `unicourt.github.io/cic-code-ms`
  publishes a release newer than 78.
- `MS_LATER_ACTS`/`MS_LATER_ACTS_SESSIONS_CHECKED` — `ms_code_section`'s
  overlay index (fleet #2915), built by crawling and parsing
  `billstatus.ls.state.ms.us`'s own signed-bill text (no official index
  exists). Rebuild with `node scripts/bake-later-acts.mjs >>
  src/ms-index-data.ts` (APPENDS). Re-run after every Mississippi
  legislative session adjourns and Acts are signed — see
  `.github/workflows/mississippi-later-acts-refresh.yml` for the scheduled
  version. Session discovery is automatic (reads the live session list on
  `billstatus.ls.state.ms.us/sessions.htm`), so a new session shows up with
  no code change.

**Full regen (both tables)**:

```bash
node scripts/bake-index.mjs > src/ms-index-data.ts
node scripts/bake-later-acts.mjs >> src/ms-index-data.ts
```

Run `node ../../scripts/check-baked-indexes.mjs` after either (from the repo
root) — it dynamically imports the regenerated file the same way the KV
uploader does, and refuses an empty exported array before it ever reaches
deploy.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mississippi-code": {
      "url": "https://gateway.pipeworx.io/mississippi-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mississippi-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1882+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ms_code_section \
  -H 'Content-Type: application/json' \
  -d '{"citation":"97-3-19"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ms_code_section`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "mississippi-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-mississippi-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-mississippi-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mississippi Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
