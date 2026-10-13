interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Decode a body from its BYTES, choosing the charset in a stated order and
 * saying which rule chose it.
 *
 * Why this exists (fleet #2742, #2729): the egress relay read an ISO-8859-1
 * page with `Response.text()`, which assumes UTF-8 when the header carries no
 * charset, and re-wrapped the result. Every 0xA7 byte -- the section sign in a
 * statute index -- became EF BF BD (U+FFFD), and the output still read as
 * plausible text. The bytes were gone before anything could notice. The rule
 * that follows from it: read bytes, hash bytes, THEN decode, and never let the
 * decoder guess silently.
 *
 * Resolution order (reported as `charset_source`):
 *   1. `bom`           a byte-order mark (UTF-8, UTF-16LE, UTF-16BE)
 *   2. `content-type`  `charset=` on the Content-Type header
 *   3. `html-meta`     `<meta charset>` or `http-equiv` Content-Type in the
 *                      first 1,024 bytes
 *   4. `xml-decl`      `<?xml ... encoding="...">` at the start of the body
 *   5. `utf8-valid`    the bytes decode as UTF-8 with `fatal: true`
 *   6. `fallback`      windows-1252, which is what WHATWG decodes `iso-8859-1`
 *                      as anyway, and which maps every byte to a character
 *
 * A label the runtime's TextDecoder does not know is skipped and the next rule
 * is tried; `ignored_labels` names it so a caller can see the page lied.
 *
 * `decode_replacements` counts U+FFFD characters that DECODING introduced --
 * the ones already present in the source as UTF-8 EF BF BD are subtracted.
 * Non-zero means the text is lossy; the bytes (and any hash over them) are not.
 */

type CharsetSource = 'bom' | 'content-type' | 'html-meta' | 'xml-decl' | 'utf8-valid' | 'fallback';

interface CharsetChoice {
  /** The WHATWG encoding name TextDecoder resolved the label to. */
  charset: string;
  charset_source: CharsetSource;
  /** Labels found in the header/meta/decl that TextDecoder rejected. */
  ignored_labels: string[];
  /** BOM bytes to skip (TextDecoder strips a matching BOM itself; kept for callers that slice). */
  bom_length: number;
}

interface DecodedText extends CharsetChoice {
  text: string;
  decode_replacements: number;
}

const META_SCAN_BYTES = 1024;

/** Normalize a label through TextDecoder; null when the runtime does not know it. */
function resolveLabel(label: string): string | null {
  const l = label.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!l) return null;
  try {
    return new TextDecoder(l).encoding;
  } catch {
    return null;
  }
}

/** The `charset=` parameter of a Content-Type header value, or null. */
function contentTypeCharset(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const m = /;\s*charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

function bomOf(b: Uint8Array): { charset: string; length: number } | null {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { charset: 'utf-8', length: 3 };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { charset: 'utf-16be', length: 2 };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { charset: 'utf-16le', length: 2 };
  return null;
}

/** ASCII view of the first `n` bytes. Bytes > 0x7F become '?' so regexes stay ASCII-only. */
function asciiHead(b: Uint8Array, n: number): string {
  const end = Math.min(b.length, n);
  let s = '';
  for (let i = 0; i < end; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : '?';
  return s;
}

function metaCharset(head: string): string | null {
  // <meta charset="x"> and <meta http-equiv="Content-Type" content="text/html; charset=x">
  // both reduce to "charset=" inside a <meta ...> tag.
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(head))) {
    const c = /charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(m[0]);
    if (c) return c[1];
  }
  return null;
}

function xmlDeclCharset(head: string): string | null {
  const m = /^\s*<\?xml\b[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/i.exec(head);
  return m ? m[1] : null;
}

function isValidUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Choose a charset for `bytes` without decoding the whole body. */
function chooseCharset(bytes: Uint8Array, contentType?: string | null): CharsetChoice {
  const ignored: string[] = [];
  const bom = bomOf(bytes);
  if (bom) return { charset: bom.charset, charset_source: 'bom', ignored_labels: ignored, bom_length: bom.length };

  const header = contentTypeCharset(contentType);
  if (header) {
    const r = resolveLabel(header);
    if (r) return { charset: r, charset_source: 'content-type', ignored_labels: ignored, bom_length: 0 };
    ignored.push(header);
  }

  const head = asciiHead(bytes, META_SCAN_BYTES);
  const meta = metaCharset(head);
  if (meta) {
    let r = resolveLabel(meta);
    // HTML spec: a meta declaring UTF-16 is a lie (the meta itself was readable
    // as ASCII), so it means UTF-8.
    if (r === 'utf-16le' || r === 'utf-16be') r = 'utf-8';
    if (r) return { charset: r, charset_source: 'html-meta', ignored_labels: ignored, bom_length: 0 };
    ignored.push(meta);
  }

  const decl = xmlDeclCharset(head);
  if (decl) {
    const r = resolveLabel(decl);
    if (r) return { charset: r, charset_source: 'xml-decl', ignored_labels: ignored, bom_length: 0 };
    ignored.push(decl);
  }

  if (isValidUtf8(bytes)) return { charset: 'utf-8', charset_source: 'utf8-valid', ignored_labels: ignored, bom_length: 0 };
  return { charset: 'windows-1252', charset_source: 'fallback', ignored_labels: ignored, bom_length: 0 };
}

function countFffdInText(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\uFFFD'); i !== -1; i = s.indexOf('\uFFFD', i + 1)) n++;
  return n;
}

function countEfBfBd(b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

/**
 * Decode `bytes` with an already-chosen charset (e.g. one chosen over a whole
 * body, applied to a window of it). Counts only the U+FFFD that decoding
 * introduced.
 */
function decodeWithCharset(bytes: Uint8Array, charset: string): { text: string; decode_replacements: number } {
  // TextDecoder strips a BOM that matches its own encoding; ignoreBOM:false is the default.
  const text = new TextDecoder(charset).decode(bytes);
  const present = charset === 'utf-8' ? countEfBfBd(bytes) : 0;
  return { text, decode_replacements: Math.max(0, countFffdInText(text) - present) };
}

/**
 * Decode `bytes` to text. `bytes` is never modified; hash it before or after,
 * the answer is the same.
 */
function decodeBytes(bytes: Uint8Array, contentType?: string | null): DecodedText {
  const choice = chooseCharset(bytes, contentType);
  return { ...choice, ...decodeWithCharset(bytes, choice.charset) };
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Mississippi Code of 1972 (Annotated) — state statutes by citation, and a
 * chapter list by title. Fleet #2883 (50-state gap: Mississippi was one of
 * four states with no <state>-code pack).
 *
 * SOURCE AND WHY THIS ISN'T A LEXIS CALL. The Joint Legislative Committee on
 * Compilation, Revision and Publication of Legislation (Miss. Code Ann.
 * §§ 1-1-101 to 1-1-111) contracts the Code's online search tool out to
 * LexisNexis (lexisnexis.com/hottopics/mscode) — a JS-rendered, Cloudflare-
 * challenge-walled surface (confirmed live: every direct HTTP request gets a
 * "Just a moment..." interstitial, HTTP 403, no statute text in the
 * response). codes.findlaw.com and law.justia.com's Mississippi pages are
 * ALSO behind the exact same Cloudflare challenge (confirmed live, same 403 +
 * "Just a moment..." body) — this is not a Lexis-specific wall, it's a
 * Cloudflare bot-check in front of three different vendors' renderings of
 * the same text, so no amount of retrying a different mirror of the search
 * UI gets around it.
 *
 * The actual statute TEXT underneath all three is not anyone's copyright —
 * enacted law is never copyrightable (Banks v. Manchester, 128 U.S. 244
 * (1888); Veeck v. S. Bldg. Code Congress Int'l, 293 F.3d 791 (5th Cir.
 * 2002) (en banc)) — and Public.Resource.Org has a public-domain,
 * keyless, no-signup static mirror of the Code's own RTF releases,
 * transformed to HTML by UniCourt and hosted on GitHub Pages
 * (unicourt.github.io/cic-code-ms, "all this work is in the public domain
 * and there are NO RIGHTS RESERVED" per that repo's own README). This pack
 * fetches that mirror LIVE, per request — a proxy of a keyless public-domain
 * source, not a mirror we ship (see the Pipeworx CLAUDE.md licence section,
 * `mirror-needs-grant-proxy-does-not`, for why that distinction matters).
 *
 * THE HONEST LIMIT, STATED UP FRONT: this source is Release 78, released
 * 2020-07-08, generated from the Code's 2018 printed RTF volumes
 * (archive.org/download/gov.ms.code.ann.2018). It is NOT a live, continuously
 * updated source — Mississippi amendments enacted in the 2021 through 2026
 * Regular Sessions are NOT reflected. Every response here says so in
 * `current_through` and `data_as_of` rather than defaulting those fields to
 * "now", which would misrepresent a six-year-old static snapshot as current
 * law. This is worse currency than the Kentucky/Georgia/North Dakota sibling
 * packs (which call a source the STATE itself keeps current) and callers
 * relying on anything enacted after mid-2020 must be told to verify against
 * the official LexisNexis-hosted Code.
 *
 * SHAPE. Each title file (`gov.ms.code.title.{NN}.html`, title number
 * zero-padded to 2 digits — Mississippi titles are odd numbers only, 1
 * through 99) is the WHOLE title in one document (Title 97 "Crimes" alone is
 * ~7 MB) with a predictable anchor scheme generated by the same rtf-parser
 * across every title: a chapter's TOC entry carries id="t{title}c{chapter}"
 * and a section's heading carries id="t{title}c{chapter}s{citation}" (e.g.
 * id="t97c03s97-3-19" for § 97-3-19). The citation's own leading number IS
 * the title number, so no title/chapter lookup table is needed to resolve a
 * citation to a URL — only to its FILE (one GET per lookup; title number is
 * read straight off the citation).
 *
 * SLICING A SECTION. A section's content runs from its own <h3 id="t..c..s
 * CITATION"> to the next section's <h3 id="t..c..s..">, or to that section's
 * own "JUDICIAL DECISIONS" block if one exists first — case-citation
 * annotations can run to hundreds of KB per section (§ 97-3-19 alone has over
 * a hundred) and are deliberately NOT returned in `text`; only the operative
 * statutory text, the "HISTORY:" line, and the Joint Legislative Committee /
 * Amendment / Cross-Reference notes are.
 *
 * THREE CAPABILITIES:
 *   - citation lookup        -> ms_code_section
 *   - chapter list (by title) -> ms_code_chapters, for browsing without an
 *     exact citation
 *   - topic/keyword search   -> ms_code_search, over official section
 *     CATCHLINES baked ONCE from all 50 titles into ms-index-data.ts
 *     (27,688 rows; see scripts/bake-index.mjs) — NOT full statutory-body
 *     text. There is no full-text search anywhere in this source chain (the
 *     official LexisNexis tool, Justia, and FindLaw all sit behind the same
 *     Cloudflare bot-check described above), and fetching all 50 multi-MB
 *     title pages per query is not viable, so this is the same
 *     catchline-over-a-baked-index shape mcps/north-dakota-code's nd_search
 *     uses for the identical reason — see that pack for the precedent.
 *
 * LATER-ACTS OVERLAY (fleet #2915, second of the AR/MS/TN overlay builds —
 * docs/current-statute-routes.md, #2902, after arkansas-code's #2906).
 * `ms_code_section` carries a `later_acts` field alongside the frozen
 * snapshot text: every act billstatus.ls.state.ms.us's OWN signed-bill text
 * shows touching this exact citation since the 2020-07-08 snapshot, dated by
 * session, linked to the bill, NEVER merged into `text`. Unlike Arkansas,
 * Mississippi's legislature publishes no ready-made citation->act index, so
 * this index is home-built by crawling and parsing the signed-bill
 * boilerplate — see scripts/bake-later-acts.mjs's header for the full
 * sourcing story, the measured parse rate, and exactly what is and is not
 * indexed.
 *
 * Keyless, no signup, no login on either side of the call.
 */
import type { MsSectionRow, MsLaterActRow } from './ms-index-data.js';

// fleet #2754 pattern (see mcps/north-dakota-code/src/index.ts's own comment
// for the live incident this guards against): NEVER value-import
// ms-index-data.ts here. The gateway loads it from KV (registered in
// workers/gateway/src/pack-baked-indexes.json) and injects it as
// args._bakedIndex on the first call into this pack; a value import would put
// the whole ~27.7k-row catchline table back into every gateway isolate.
let MS_SECTIONS: MsSectionRow[] = [];
let MS_INDEX_CAPTURED_AT = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (MS_SECTIONS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const sections = idx?.MS_SECTIONS;
  const capturedAt = idx?.MS_INDEX_CAPTURED_AT;
  if (!Array.isArray(sections) || sections.length === 0 || typeof capturedAt !== 'string') {
    // Loud on purpose: ms_code_search only. ms_code_section and
    // ms_code_chapters fetch live and never touch this table, so a missing
    // index must not block them.
    throw new Error(
      'mississippi-code: the baked section-catchline index is unavailable ' +
        `(${idx == null ? 'not injected' : 'malformed'}). The gateway loads it from KV on the first call into ` +
        'this pack; this is a server-side fault, not a bad query — retry shortly, or use ms_code_section/ms_code_chapters directly.',
    );
  }
  MS_SECTIONS = sections as MsSectionRow[];
  MS_INDEX_CAPTURED_AT = capturedAt;
}

// LATER-ACTS OVERLAY (fleet #2915, after arkansas-code's fleet #2906 —
// docs/current-statute-routes.md, #2902). Baked from billstatus.ls.state.
// ms.us's own signed-bill text by scripts/bake-later-acts.mjs — Mississippi
// publishes no ready-made citation->act index (unlike Arkansas), so this
// table is home-built by crawling and regex-parsing the "SECTION N. Section
// <cite>, Mississippi Code of 1972, is amended/created/repealed/brought
// forward" boilerplate — see that script's header for the full sourcing
// story. This is an OVERLAY, never a merge: ms_code_section's `text` field
// stays the frozen Release 78 (2020-07-08) snapshot; this table only adds a
// dated, linked list of later acts beside it, explicitly labelled as not
// merged into that text.
let MS_LATER_ACTS: MsLaterActRow[] = [];
let MS_LATER_ACTS_CAPTURED_AT = '';
let MS_LATER_ACTS_SESSIONS_CHECKED: string[] = [];
let MS_LATER_ACTS_LOADED = false;

function ensureLaterActs(args: Record<string, unknown>): void {
  if (MS_LATER_ACTS_LOADED) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.MS_LATER_ACTS;
  const capturedAt = idx?.MS_LATER_ACTS_CAPTURED_AT;
  const sessionsChecked = idx?.MS_LATER_ACTS_SESSIONS_CHECKED;
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    typeof capturedAt !== 'string' ||
    !Array.isArray(sessionsChecked) ||
    sessionsChecked.length === 0
  ) {
    // Loud, same shape as ensureIndex() above: a missing/malformed overlay
    // index is a server-side KV fault, not evidence the section has no later
    // acts. ms_code_section must not silently claim later_acts: [] when the
    // real answer is "the index did not load" — those are different
    // failures and collapsing them would be exactly the silent-empty-array
    // trap this fleet holds every pack to (docs/silent-zero-policy.md).
    throw new Error(
      `mississippi-code: the baked later-acts overlay index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not "no later acts" — retry shortly.',
    );
  }
  MS_LATER_ACTS = rows as MsLaterActRow[];
  MS_LATER_ACTS_CAPTURED_AT = capturedAt;
  MS_LATER_ACTS_SESSIONS_CHECKED = sessionsChecked as string[];
  MS_LATER_ACTS_LOADED = true;
}

interface MsLaterAct {
  chapter: number | null;
  session: string;
  verb: string;
  range_to: string | null;
  link: string;
  bill: string;
  source: 'billstatus';
  merged: false;
}

/** Numeric containment check for a "through" range row: same dash-separated prefix, last segment numerically between the two endpoints. Used only when a row's `to` is non-null. */
function citationInRange(citation: string, from: string, to: string): boolean {
  const cParts = citation.split('-');
  const fParts = from.split('-');
  const tParts = to.split('-');
  if (cParts.length !== fParts.length || fParts.length !== tParts.length) return false;
  for (let i = 0; i < fParts.length - 1; i++) {
    if (cParts[i] !== fParts[i] || fParts[i] !== tParts[i]) return false;
  }
  const lastC = Number(cParts[cParts.length - 1]);
  const lastF = Number(fParts[fParts.length - 1]);
  const lastT = Number(tParts[tParts.length - 1]);
  if (!Number.isFinite(lastC) || !Number.isFinite(lastF) || !Number.isFinite(lastT)) return false;
  return lastC >= lastF && lastC <= lastT;
}

function laterActsFor(citation: string): MsLaterAct[] {
  return MS_LATER_ACTS.filter(([from, to]) => from === citation || (to != null && citationInRange(citation, from, to))).map(
    ([from, to, verb, , sessionLabel, chapter, bill, link]) => ({
      chapter,
      session: sessionLabel,
      verb,
      // A row keyed on a "Sections X through Y, ... repealed" clause is kept
      // as ONE range rather than this script fabricating every citation
      // between X and Y (some of which may not exist in the real Code) —
      // range_to names the other end so a caller knows this citation was
      // swept in by a range, not named individually.
      range_to: to,
      link,
      bill,
      source: 'billstatus',
      merged: false,
    }),
  );
}

const UA = 'pipeworx-mcp-mississippi-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Public.Resource.Org / UniCourt mirror of the Mississippi Code of 1972 Annotated (unicourt.github.io/cic-code-ms)';
const RELEASE = 'r78';
const RELEASE_LABEL = 'Release 78 (released 2020-07-08, from the Code\'s 2018 printed RTF volumes)';
const CURRENT_THROUGH =
  'Release 78 (2020-07-08) — does NOT reflect amendments enacted in the 2021 through 2026 Regular Sessions. ' +
  'For anything enacted after mid-2020, verify against the official LexisNexis-hosted Mississippi Code ' +
  '(lexisnexis.com/hottopics/mscode) or contact the Joint Legislative Committee on Compilation, Revision ' +
  'and Publication of Legislation.';
const SOURCE_LABEL =
  `Mississippi Code of 1972 Annotated — public law, text not copyrightable (Banks v. Manchester, 128 U.S. 244 ` +
  `(1888); Veeck v. SBCCI, 293 F.3d 791 (5th Cir. 2002)), served via the Public.Resource.Org / UniCourt static ` +
  `mirror (unicourt.github.io/cic-code-ms), public domain, NOT the State of Mississippi or LexisNexis.`;

// Mississippi Code titles are ODD numbers only (1-99); this is the complete
// set, scraped from unicourt.github.io/cic-code-ms's own release index
// 2026-10-09. Trivial (50 entries, hand-maintained — unlike the ~27.7k-row
// section-catchline table in ms-index-data.ts, this does not need the KV
// baked-index treatment fleet #2754 requires).
const TITLES: Record<number, string> = {
  1: 'Laws and Statutes',
  3: 'State sovereignty, jurisdiction and holidays',
  5: 'Legislative Department',
  7: 'Executive Department',
  9: 'Courts',
  11: 'Civil Practice and Procedure',
  13: 'Evidence, Process and Juries',
  15: 'Limitations of Actions and Prevention of Frauds',
  17: 'Local Government; Provisions Common to Counties and Municipalities',
  19: 'Counties and County Officers',
  21: 'Municipalities',
  23: 'Elections',
  25: 'Public Officers and Employees; Public Records',
  27: 'Taxation and Finance',
  29: 'Public Lands, Buildings and Property',
  31: 'Public Business, Bonds and Obligations',
  33: 'Military Affairs',
  35: 'War Veterans and Pensions',
  37: 'Education',
  39: 'Libraries, Arts, Archives and History',
  41: 'Public Health',
  43: 'Public Welfare',
  45: 'Public Safety and Good Order',
  47: 'Prisons and Prisoners; Probation and Parole',
  49: 'Conservation and Ecology',
  51: 'Waters, Water Resources, Water Districts, Drainage, and Flood Control',
  53: 'Oil, Gas, and Other Minerals',
  55: 'Parks and Recreation',
  57: 'Planning, Research and Development',
  59: 'Ports, Harbors, Landings and Watercraft',
  61: 'Aviation',
  63: 'Motor Vehicles and Traffic Regulations',
  65: 'Highways, Bridges and Ferries',
  67: 'Alcoholic Beverages',
  69: 'Agriculture, Horticulture, and Animals',
  71: 'Labor and Industry',
  73: 'Professions and Vocations',
  75: 'Regulation of Trade, Commerce and Investments',
  77: 'Public Utilities and Carriers',
  79: 'Corporations, Associations, and Partnerships',
  81: 'Banks and Financial Institutions',
  83: 'Insurance',
  85: 'Debtor-Creditor Relationship',
  87: 'Contracts and Contractual Relations',
  89: 'Real and Personal Property',
  91: 'Trusts and Estates',
  93: 'Domestic Relations',
  95: 'Torts',
  97: 'Crimes',
  99: 'Criminal Procedure',
};

function titleUrl(title: number): string {
  const padded = String(title).padStart(2, '0');
  return `https://unicourt.github.io/cic-code-ms/transforms/ms/ocms/${RELEASE}/gov.ms.code.title.${padded}.html`;
}

// Confirmed live, 2026-10-09: Title 79 (Corporations, Associations, and
// Partnerships) is the ONLY one of the 50 titles whose per-section <h3> never
// carries an id. Checked every title's `<h3 id="t{title}c{chapter}s...">`
// count directly: all 49 others carry one per section (46-2,364 each,
// 27,688 total); Title 79 carries ZERO — its ~700 bare <h3> tags are reused
// for unrelated asides (editor's notes, amendment summaries), and the
// citation anchor it links to internally (e.g. href="#t79c01s79-1-1") is
// DANGLING: no element in that title's document carries that id at all. This
// is a defect in how the RTF->HTML conversion handled Title 79 specifically,
// not a gap in this pack's parser — ms_code_section says so by name rather
// than returning an indistinguishable citation_not_found.
const UNSUPPORTED_SECTION_TITLES: ReadonlySet<number> = new Set([79]);

async function fetchDecodedHtml(url: string): Promise<{ res: Response; html: string }> {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, UPSTREAM, 20_000);
  if (!res.ok) throw await httpError(res, UPSTREAM);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const decoded = decodeBytes(bytes, res.headers.get('content-type'));
  return { res, html: decoded.text };
}

function normalizeCitation(raw: string): string {
  return raw
    .trim()
    .replace(/^(Miss\.?\s*Code\s*Ann\.?|MS\s*Code|Mississippi\s*Code(?:\s*Ann(?:otated)?)?|Section)\s*/i, '')
    .replace(/^§+\s*/, '')
    .trim();
}

function titleOfCitation(citation: string): number | null {
  const m = /^(\d+)-/.exec(citation);
  if (!m) return null;
  const t = Number(m[1]);
  return Number.isFinite(t) ? t : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
    .replace(/&nbsp;/g, ' ');
}

/** Strip tags, turn block/item boundaries into newlines, decode entities, collapse whitespace per line. */
function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\/(li|p|h[1-6]|div)\s*>/gi, '\n')
    .replace(/<(li|p|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  const decoded = decodeEntities(stripped);
  return decoded
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1]!.length > 0))
    .join('\n')
    .trim();
}

interface SlicedSection {
  catchline: string;
  statuteText: string;
  historyText: string | null;
  notesText: string | null;
  truncatedForCaseLaw: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find all top-level section heading start indices (`<h3 id="t\d+c\d+s...">`) in document order. */
function findSectionHeadingStarts(html: string): Array<{ at: number; id: string }> {
  const re = /<h3[^>]*\sid="(t\d+c\d+s[^"]+)"/g;
  const out: Array<{ at: number; id: string }> = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    out.push({ at: m.index, id: m[1]! });
  }
  return out;
}

function sliceSection(html: string, citation: string): SlicedSection | null {
  const exactId = new RegExp(`<h3[^>]*\\sid="t\\d+c\\d+s${escapeRe(citation)}"`);
  const m = exactId.exec(html);
  if (!m) return null;
  const start = m.index;

  const headings = findSectionHeadingStarts(html);
  const nextHeading = headings.find((h) => h.at > start);
  let end = nextHeading ? nextHeading.at : html.length;

  let truncatedForCaseLaw = false;
  const jIdx = html.indexOf('class="jdecisions"', start);
  if (jIdx !== -1 && jIdx < end) {
    // Walk back to the start of that <h4 ...> tag.
    const h4Start = html.lastIndexOf('<h4', jIdx);
    if (h4Start !== -1 && h4Start > start) {
      end = h4Start;
      truncatedForCaseLaw = true;
    }
  }

  const sectionHtml = html.slice(start, end);

  // Catchline: inside the <h3>'s <b>...</b>, after "§ CITATION."
  const h3CloseIdx = sectionHtml.indexOf('</h3>');
  const headingHtml = h3CloseIdx !== -1 ? sectionHtml.slice(0, h3CloseIdx) : sectionHtml;
  const catchlineRaw = htmlToText(headingHtml);
  const catchline = catchlineRaw
    .replace(/^§\s*[\d.A-Za-z-]+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const bodyHtml = h3CloseIdx !== -1 ? sectionHtml.slice(h3CloseIdx + '</h3>'.length) : '';

  const histIdx = bodyHtml.search(/HISTORY\s*:/);
  const statuteHtml = histIdx !== -1 ? bodyHtml.slice(0, histIdx) : bodyHtml;
  const restHtml = histIdx !== -1 ? bodyHtml.slice(histIdx) : '';

  const h4Idx = restHtml.search(/<h4\b/);
  const historyHtml = h4Idx !== -1 ? restHtml.slice(0, h4Idx) : restHtml;
  const notesHtml = h4Idx !== -1 ? restHtml.slice(h4Idx) : '';

  const statuteText = htmlToText(statuteHtml);
  const historyText = histIdx !== -1 ? htmlToText(historyHtml).replace(/^HISTORY\s*:\s*/, '').trim() : null;
  const notesText = notesHtml.trim() ? htmlToText(notesHtml) : null;

  return {
    catchline,
    statuteText,
    historyText: historyText || null,
    notesText,
    truncatedForCaseLaw,
  };
}

/** Nearby citations in the same title, for a not-found hint — cheap: the title HTML is already fetched. */
function nearbyCitations(html: string, titlePrefix: number, limit: number): string[] {
  // Character class deliberately excludes letters: a TOC/nav list item for a
  // SECTION (as opposed to a chapter) carries an id like
  // "t97c03s97-3-19-snav11" — same prefix, different suffix shape — and an
  // id="...-snav11" immediately after the citation with no closing quote in
  // between would otherwise get swallowed into the capture group and read
  // back as a bogus "citation" ending in "-snav11". Real MS citations are
  // digits/dots/hyphens only.
  const re = new RegExp(`id="t\\d+c\\d+s(${titlePrefix}-[0-9.-]+)"`, 'g');
  const seen = new Set<string>();
  for (let m = re.exec(html); m; m = re.exec(html)) {
    seen.add(m[1]!);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ms_code_section',
    description:
      'Get the text of a section of the Mississippi Code of 1972 (Annotated) — Mississippi state law — by ' +
      'citation. "97-3-19" is homicide/murder; "89-8-19" is a landlord\'s duty to return a security deposit. ' +
      'Accepts natural forms: "97-3-19", "Miss. Code Ann. § 97-3-19", "Section 97-3-19", "§ 97-3-19". Returns ' +
      'the catchline, the operative statutory text, the legislative "HISTORY:" line, and amendment/cross-' +
      'reference notes when present — case-law annotations are deliberately excluded (can run to hundreds of ' +
      'entries per section). IMPORTANT: this source is a static public-domain copy current only through ' +
      'Release 78 (2020-07-08) — it will NOT reflect any amendment enacted 2021 or later; check ' +
      '`current_through` on every response. Also returns later_acts: a dated, linked overlay of every act this ' +
      'pack found in Mississippi\'s own signed-bill text touching this exact citation since the 2020-07-08 ' +
      'snapshot (chapter number, session, bill link) — NOT merged into the text, explicitly labelled so, with ' +
      'sessions_checked naming every session the overlay covers even when later_acts is empty. Use for "what ' +
      'does MS 97-3-19 say" or to check a Mississippi statute AND whether it has been amended since 2020-07-08. ' +
      'Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Section citation, e.g. "97-3-19" (homicide) or "89-8-19" (security deposits). Title-chapter-section, dot/hyphen separated.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'ms_code_chapters',
    description:
      'List the chapters within a title of the Mississippi Code of 1972, by title number ("97" is Crimes, "89" ' +
      'is Real and Personal Property, "27" is Taxation and Finance). Use this to browse a title when you do not ' +
      'have an exact section citation. Returns every chapter heading and number; call ms_code_section ' +
      'once you have a citation, or ms_code_search to find one by topic. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'number',
          description: 'Title number, e.g. 97 (Crimes) or 89 (Real and Personal Property). Mississippi titles are odd numbers 1-99.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'ms_code_search',
    description:
      'Search the Mississippi Code of 1972 BY TOPIC or keyword rather than citation — "security deposit", ' +
      '"concealed carry", "DUI per se limit", "homicide". Matches against every section\'s official CATCHLINE ' +
      'across the whole Code (not full statutory body text — there is no full-text search anywhere in this ' +
      'source chain; the official LexisNexis tool, Justia, and FindLaw all sit behind the same Cloudflare ' +
      'bot-check, confirmed live). Returns matching citations, titles, and catchlines; call ms_code_section with ' +
      'a citation for the full text. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "security deposit return".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

async function msCodeSection(args: Record<string, unknown>) {
  const raw = String(args.citation ?? '').trim();
  if (!raw) {
    return { found: false, reason: 'empty_citation', message: 'ms_code_section needs a citation, e.g. "97-3-19" or "Miss. Code Ann. § 89-8-19".' };
  }
  const citation = normalizeCitation(raw);
  ensureLaterActs(args);
  const title = titleOfCitation(citation);
  if (title === null || !(title in TITLES)) {
    return {
      found: false,
      reason: 'invalid_citation',
      citation: raw,
      message: `"${raw}" does not resolve to a known Mississippi Code title. A citation looks like "97-3-19" (title-chapter-section); Mississippi titles are odd numbers 1-99.`,
      source: SOURCE_LABEL,
    };
  }
  if (UNSUPPORTED_SECTION_TITLES.has(title)) {
    return {
      found: false,
      reason: 'title_markup_unsupported',
      citation: raw,
      title,
      title_name: TITLES[title],
      message: `Title ${title} (${TITLES[title]}) cannot be looked up section-by-section from this source: its own HTML never marks a section heading with an id, so this pack's parser has nothing to anchor on. This is a defect in the source document for Title ${title} specifically, not a sign the citation is wrong.`,
      hint: 'Call ms_code_chapters with this title to browse by chapter, or check the official LexisNexis-hosted Mississippi Code for the section text.',
      source: SOURCE_LABEL,
    };
  }

  const url = titleUrl(title);
  const { html } = await fetchDecodedHtml(url);

  const sliced = sliceSection(html, citation);
  if (!sliced) {
    const laterActsForMissing = laterActsFor(citation);
    return {
      found: false,
      reason: 'citation_not_found',
      citation: raw,
      title,
      title_name: TITLES[title],
      message: `No section matches "${raw}" in Title ${title} (${TITLES[title]}) of the Mississippi Code of 1972.`,
      near: nearbyCitations(html, title, 5),
      hint: laterActsForMissing.length
        ? `This citation does not appear in the Release 78 (2020-07-08) snapshot, but this pack's own overlay of signed-bill text shows ${laterActsForMissing.length} later act(s) touching it — it may be a section CREATED after the snapshot date. See later_acts_if_created below (not merged text, just the bill references).`
        : 'It may be a chapter heading rather than a section, be numbered differently than expected, or postdate Release 78 (2020-07-08) — this source cannot see anything enacted after that. Call ms_code_chapters with this title to browse.',
      later_acts_if_created: laterActsForMissing,
      sessions_checked: MS_LATER_ACTS_SESSIONS_CHECKED,
      source_url: url,
      source: SOURCE_LABEL,
      current_through: CURRENT_THROUGH,
    };
  }

  const laterActs = laterActsFor(citation);

  return {
    found: true,
    citation: `Miss. Code Ann. § ${citation}`,
    catchline: sliced.catchline,
    title,
    title_name: TITLES[title],
    text: sliced.statuteText,
    text_chars: sliced.statuteText.length,
    history: sliced.historyText,
    notes: sliced.notesText,
    case_law_annotations_omitted: sliced.truncatedForCaseLaw,
    historical_versions: 'not available — this source publishes only the Release 78 (2020-07-08) text; no prior-version archive is exposed by it.',
    // OVERLAY (fleet #2915): acts that touched this exact citation AFTER the
    // 2020-07-08 snapshot, per this pack's own crawl of billstatus.ls.state.
    // ms.us's signed-bill text (Mississippi publishes no official citation-
    // to-act index, unlike Arkansas). NOT MERGED into `text` above — the
    // snapshot text is unchanged by this list; it is only told alongside it.
    // Empty means the overlay shows no later act for this citation across
    // every session checked (named in sessions_checked below), not that the
    // overlay failed — ensureLaterActs() above throws loudly if the index
    // itself is missing.
    later_acts: laterActs,
    later_acts_merged_into_text: false,
    sessions_checked: MS_LATER_ACTS_SESSIONS_CHECKED,
    later_acts_data_as_of: MS_LATER_ACTS_CAPTURED_AT,
    later_acts_note: laterActs.length
      ? `${laterActs.length} later act(s) found via this pack's own crawl of signed-bill text. These are NOT merged into the text above — the text is still the frozen Release 78 (2020-07-08) snapshot. Open the bill link (link field) for the actual amending language.`
      : `No later act found for this citation across every session checked since the 2020-07-08 snapshot (${MS_LATER_ACTS_SESSIONS_CHECKED.join('; ')}). This does not guarantee the text is unchanged — only that this pack's own crawl, built from Mississippi's own signed-bill text, found no amending act against this exact citation.`,
    source_url: url,
    source: SOURCE_LABEL,
    current_through: CURRENT_THROUGH,
    data_as_of: '2020-07-08',
    attribution: 'Mississippi statutes are public record; this text is served from a third-party public-domain source, not the State of Mississippi.',
  };
}

async function msCodeChapters(args: Record<string, unknown>) {
  const titleArg = args.title;
  const title = typeof titleArg === 'number' ? titleArg : Number(titleArg);
  if (!Number.isFinite(title)) {
    return {
      found: false,
      reason: 'missing_title',
      message: 'ms_code_chapters needs a "title" number, e.g. 97 (Crimes).',
      available_titles: Object.entries(TITLES).map(([n, name]) => ({ title: Number(n), name })),
    };
  }
  if (!(title in TITLES)) {
    return {
      found: false,
      reason: 'invalid_title',
      title,
      message: `Title ${title} is not a Mississippi Code title. Titles are odd numbers 1-99.`,
      available_titles: Object.entries(TITLES).map(([n, name]) => ({ title: Number(n), name })),
    };
  }

  const url = titleUrl(title);
  const { html } = await fetchDecodedHtml(url);

  const navRe = /<li id="t\d+c(\d+)-cnav\d+">\s*<a[^>]*>\s*Chapter\s+([\w.-]+)\.\s*([^<]*)<\/a>/g;
  const chapters: Array<{ chapter: string; name: string }> = [];
  for (let m = navRe.exec(html); m; m = navRe.exec(html)) {
    chapters.push({ chapter: m[2]!.trim(), name: m[3]!.trim() });
  }

  if (!chapters.length) {
    return {
      found: false,
      reason: 'chapter_list_not_parsed',
      title,
      title_name: TITLES[title],
      message: `Title ${title} (${TITLES[title]}) was fetched but no chapter table of contents could be parsed from it — the source's page layout may have changed.`,
      source_url: url,
      source: SOURCE_LABEL,
    };
  }

  return {
    found: true,
    title,
    title_name: TITLES[title],
    chapter_count: chapters.length,
    chapters,
    hint: 'Call ms_code_section with a citation (title-chapter-section, e.g. "97-3-19") for the full text of a section.',
    source_url: url,
    source: SOURCE_LABEL,
    current_through: CURRENT_THROUGH,
    data_as_of: '2020-07-08',
  };
}

interface SearchHit { citation: string; catchline: string; title: number; chapter: number; score: number }

/** IDF-weighted word overlap over official catchlines — same scoring shape as
 *  mcps/north-dakota-code's nd_search (see that file's wordWeights). */
function wordWeights(words: string[], haystacks: string[]): Map<string, number> {
  const weight = new Map<string, number>();
  for (const w of words) {
    let df = 0;
    for (const h of haystacks) if (h.includes(w)) df++;
    weight.set(w, 1 / Math.max(1, df));
  }
  return weight;
}

async function msCodeSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'ms_code_search needs a "query" — a topic or a few keywords, e.g. "security deposit return" or "concealed carry permit".',
      hint: 'To look up a known citation directly, use ms_code_section instead.',
    };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) {
    return { found: false, reason: 'query_too_short', query: q, message: `"${q}" has no word of 3+ characters to match against section catchlines.` };
  }

  const haystacks = MS_SECTIONS.map((r) => r[1].toLowerCase());
  const weight = wordWeights(words, haystacks);

  const hits: SearchHit[] = [];
  for (let i = 0; i < MS_SECTIONS.length; i++) {
    const h = haystacks[i]!;
    let score = 0;
    for (const w of words) if (h.includes(w)) score += weight.get(w) ?? 1;
    if (score > 0) {
      const row = MS_SECTIONS[i]!;
      hits.push({ citation: row[0], catchline: row[1], title: row[2], chapter: row[3], score });
    }
  }
  hits.sort((a, b) => b.score - a.score);

  if (!hits.length) {
    return {
      found: false,
      query: q,
      message: `No section catchline in the Mississippi Code of 1972 matched "${q}".`,
      hint: 'This matches official CATCHLINES, not full statutory text — try shorter or more literal terms, or call ms_code_chapters to browse a title directly.',
      sections_indexed: MS_SECTIONS.length,
      current_through: CURRENT_THROUGH,
      data_as_of: '2020-07-08',
    };
  }

  const results = hits.slice(0, limit).map((h) => ({
    citation: `Miss. Code Ann. § ${h.citation}`,
    section: h.citation,
    catchline: h.catchline,
    title: h.title,
    title_name: TITLES[h.title],
    chapter: h.chapter,
  }));

  return {
    found: true,
    query: q,
    count: results.length,
    total_matched: hits.length,
    results,
    hint: 'Call ms_code_section with a citation above for the full text.',
    match_level: 'official_catchline',
    note: 'Title 79 (Corporations, Associations, and Partnerships) is not in this index — its source document carries no section-level catchline markup; see ms_code_section\'s own response for that title.',
    sections_indexed: MS_SECTIONS.length,
    source: SOURCE_LABEL,
    current_through: CURRENT_THROUGH,
    data_as_of: '2020-07-08',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ms_code_section':
      return msCodeSection(args);
    case 'ms_code_chapters':
      return msCodeChapters(args);
    case 'ms_code_search':
      ensureIndex(args);
      return msCodeSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
