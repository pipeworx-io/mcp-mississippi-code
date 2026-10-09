# @pipeworx/mississippi-code

Mississippi Code of 1972 (Annotated) — section lookup by citation, chapter
browsing by title, and topic/keyword search over official catchlines.
Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1763+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ms_code_section(citation)` — the text of a section by citation
  (`"97-3-19"`, `"Miss. Code Ann. § 89-8-19"`, `"Section 97-3-19"`). Returns
  the catchline, the operative statutory text, the `HISTORY:` line, and
  Joint Legislative Committee / Amendment / Cross-Reference notes when
  present. Case-law (`JUDICIAL DECISIONS`) annotations are deliberately
  excluded — they can run to hundreds of citations per section and are not
  what a caller asking "what does this statute say" wants back.
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

## Refreshing the search index

`ms_code_search` reads a baked catchline index
(`src/ms-index-data.ts`, 27,688 rows, one per section across the 49 titles
whose markup supports it — see "Title 79" above), injected from KV via
`workers/gateway/src/pack-baked-indexes.json` rather than bundled (fleet
#2754: a value-imported multi-MB table loads into every gateway isolate
whether or not it ever serves this pack). Rebuild it with:

```bash
node scripts/bake-index.mjs > src/ms-index-data.ts
```

Re-run only if `unicourt.github.io/cic-code-ms` publishes a release newer
than 78 — every release from 72 through 78 observed on 2026-10-09 is a
**complete** re-publication of the whole Code, not an incremental diff, so
there is nothing to refresh until a new one appears.

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

Both URLs reach the same gateway and the same 1763+ data sources. The
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
