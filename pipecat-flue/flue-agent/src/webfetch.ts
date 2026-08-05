import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';
import { decodeEntities, describeFetchError, resolveTimeoutSignal, truncateSafely, truncateWithEllipsis } from './tool-net.ts';

export interface WebFetchResult {
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

const MAX_CHARS = 6000; // enough for the model to summarize aloud; keeps the turn small
const MAX_BYTES = 2_000_000; // don't slurp huge pages
const MAX_REDIRECTS = 5;

/** Extract the <title>, if any. Pure. */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) || undefined : undefined;
}

/** Reduce an HTML document to readable plain text. Pure and unit-testable: drop
 *  script/style/noscript/head-ish noise, map block boundaries to newlines, strip tags, decode
 *  entities, collapse whitespace, and truncate to `maxChars` (without splitting a surrogate
 *  pair). Not a full DOM parser — good enough to read a page aloud. The closing tag is optional
 *  in the match (falls back to end-of-string) because readBounded's MAX_BYTES cap can truncate a
 *  real page mid-tag, and an unterminated <script>/<style> would otherwise leak its raw contents
 *  into the "readable text" the model reads aloud. The `(?=[\s>])` lookahead after the tag name
 *  requires a real tag-name boundary, so a custom element like <svg-icon> or <template-card>
 *  isn't mistaken for an unterminated <svg>/<template> and doesn't drag the end-of-input fallback
 *  through the rest of the document. */
export function htmlToText(html: string, maxChars = MAX_CHARS): string {
  const stripped = html
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)(?=[\s>])[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateWithEllipsis(text, maxChars);
}

/** Expand a colon-hex IPv6 literal (already lowercased) into its 8 16-bit groups, honoring "::"
 *  compression. Returns undefined for a dotted-quad address, an already-mixed `::ffff:a.b.c.d`
 *  form (handled separately, before this runs), or a malformed string. Used to recognize an
 *  embedded IPv4 address regardless of how far RFC 5952 canonical serialization compressed it
 *  into the "::" run — e.g. `::0.0.1.1` serializes to `::101` (one trailing hex group, not the
 *  two a fixed-arity form would expect), and `64:ff9b::0.0.0.0` serializes to the bare `64:ff9b::`
 *  (zero trailing groups). */
function expandIPv6Groups(addr: string): number[] | undefined {
  const halves = addr.split('::');
  if (halves.length > 2) return undefined;
  const side = (s: string): number[] | undefined => {
    if (s === '') return [];
    const nums = s.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
    return nums.some(Number.isNaN) ? undefined : nums;
  };
  const left = side(halves[0]);
  const right = halves.length === 2 ? side(halves[1]) : [];
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  return [...left, ...Array(halves.length === 2 ? missing : 0).fill(0), ...right];
}

const eqGroups = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** If `groups` (8 IPv6 hextets) is one of the fixed IPv4-embedding prefixes, return the embedded
 *  address as a dotted-decimal string; otherwise undefined. Covers IPv4-mapped (`::ffff:0:0/96`),
 *  the deprecated IPv4-compatible range (`::/96`), the NAT64 well-known prefix (`64:ff9b::/96`,
 *  RFC 6052), and the NAT64 local-use prefix (`64:ff9b:1::/48`, RFC 8215) — the one fixed,
 *  standardized local-use prefix; an operator-chosen local-use prefix from RFC 6052's other
 *  lengths (/32/40/56/64) is, by design, not a fixed value this check could ever enumerate. The
 *  /48 form interleaves an 8-bit reserved "u" octet between the embedded IPv4 address's two
 *  16-bit halves per RFC 6052 §2.2's layout table, unlike the /96 forms where the IPv4 address is
 *  simply the last 32 bits.
 *
 *  Also covers the two transition mechanisms that tunnel IPv6 over an IPv4 network by embedding
 *  the tunnel endpoint's IPv4 address directly in the address, so a host reachable at a private
 *  IPv4 address is reachable the same way over a 6to4/Teredo literal if the runtime's OS has the
 *  matching tunneling adapter enabled: 6to4 (`2002::/16`, RFC 3056 — the address is bits 16-47
 *  verbatim) and Teredo (`2001:0000::/32`, RFC 4380 — the client's address is bits 96-127,
 *  obfuscated by XORing every bit with 1, i.e. XOR each hextet with 0xffff). */
function embeddedIPv4(groups: number[]): string | undefined {
  const dotted = (hi: number, lo: number) => `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  const prefix96 = groups.slice(0, 6);
  if (
    eqGroups(prefix96, [0, 0, 0, 0, 0, 0xffff]) || // IPv4-mapped
    eqGroups(prefix96, [0, 0, 0, 0, 0, 0]) || // deprecated IPv4-compatible
    eqGroups(prefix96, [0x64, 0xff9b, 0, 0, 0, 0]) // NAT64 well-known prefix
  ) {
    return dotted(groups[6], groups[7]);
  }
  if (eqGroups(groups.slice(0, 3), [0x64, 0xff9b, 1])) {
    const hi = groups[3];
    const lo = ((groups[4] & 0xff) << 8) | ((groups[5] >> 8) & 0xff);
    return dotted(hi, lo);
  }
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]); // 6to4
  if (groups[0] === 0x2001 && groups[1] === 0) return dotted(groups[6] ^ 0xffff, groups[7] ^ 0xffff); // Teredo
  return undefined;
}

/** True if an IP literal is loopback / private / link-local / CGNAT / IPv6-ULA / unspecified.
 *  Pure and unit-testable — the SSRF classifier. Handles IPv4 addresses embedded in IPv6: the
 *  dotted `::ffff:a.b.c.d` form directly, and every hex form (IPv4-mapped, deprecated
 *  IPv4-compatible, the NAT64 well-known and local-use prefixes, and the 6to4/Teredo tunneling
 *  prefixes) via embeddedIPv4 / expandIPv6Groups above — including whatever degree of "::"
 *  compression RFC 5952 canonical serialization applied, since the WHATWG URL parser used by
 *  fetchUrl's `new URL(url)` always normalizes a bracketed IPv6-literal hostname into one of these
 *  forms. A private embedded address (e.g. the `169.254.169.254` cloud-metadata address) must
 *  classify the same as its plain IPv4 form regardless of which embedding smuggled it past a
 *  literal-hostname check. */
export function isPrivateAddress(ip: string): boolean {
  const addr0 = (ip || '').trim().toLowerCase();
  // Checked before any IPv4-embedding reinterpretation below: `::1` and `::` both have an
  // all-zero top 96 bits, so embeddedIPv4 would otherwise unconditionally claim them first (as
  // the deprecated IPv4-compatible form, rewriting to "0.0.0.1"/"0.0.0.0") and this native-IPv6
  // special case would never actually run — silently correct today only because 0.0.0.0/8 also
  // happens to be caught below, not because this check does anything. Handling it here instead
  // means a future change to the IPv4-embedding or 0.0.0.0/8 logic can't quietly stop these two
  // literal addresses from being classified as private.
  if (addr0 === '::1' || addr0 === '::') return true; // loopback / unspecified
  let addr = addr0;
  const dotted = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    addr = dotted[1];
  } else {
    const groups = expandIPv6Groups(addr);
    const embedded = groups && embeddedIPv4(groups);
    if (embedded) addr = embedded;
  }
  const kind = isIP(addr);
  if (kind === 4) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 0 || // 0.0.0.0/8 (unspecified)
      a === 127 || // loopback
      a === 10 || // RFC1918
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 169 && b === 254) || // link-local
      (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
    );
  }
  if (kind === 6) {
    if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(addr)) return true; // unique-local fc00::/7
    return false;
  }
  return false;
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata']);

/** Fast SSRF pre-check on the URL host: reject internal hostnames and literal private IPs.
 *  Hostnames that must be resolved are validated at CONNECT time by `ssrfAgent` (below), which
 *  closes the resolve-then-connect (DNS-rebinding) window a pre-resolve check would leave open. */
function guardHost(hostname: string): string | undefined {
  // No empty-host check: callers only ever pass `URL#hostname` for an http(s) URL, and the
  // WHATWG URL parser requires a non-empty host for those "special" schemes — an input that
  // would produce one throws during `new URL()` construction before guardHost ever runs.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) return 'that host is not allowed';
  if (isIP(host)) return isPrivateAddress(host) ? 'that address is private or internal' : undefined;
  return undefined; // resolved + re-checked at connect time
}

/** True if any address in a dns.lookup result is private/internal — the result is a single
 *  string normally, or a `LookupAddress[]` when the caller passed `{ all: true }`. Pure and
 *  unit-testable: the actual SSRF check applied to a resolved address. */
export function anyAddressPrivate(address: string | LookupAddress[]): boolean {
  const list = Array.isArray(address) ? address : [{ address }];
  return list.some((e) => isPrivateAddress(e.address));
}

/** A dns.lookup that rejects private/internal resolved addresses. undici uses it for the actual
 *  socket connect, so the vetted IP is the one we connect to — no TOCTOU. `lookup` defaults to the
 *  real dns.lookup; overridable so tests can drive both branches without touching real DNS. */
export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  lookup: typeof dnsLookup = dnsLookup,
): void {
  lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err, address, family);
    if (anyAddressPrivate(address)) {
      return cb(new Error('host resolves to a private or internal address'), address, family);
    }
    cb(null, address, family);
  });
}
const ssrfAgent = new Agent({ connect: { lookup: guardedLookup } });

/** Cancel a stream/reader, swallowing a "cancel on an already-closed source" error — shared by
 *  readBounded's reader.cancel() and cancelBody's body.cancel() below. */
async function cancelQuietly(cancel: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await cancel();
  } catch {
    /* already closed */
  }
}

/** Result of a bounded body read: the text actually read, and whether the real body may extend
 *  beyond it. `capped` is the signal fetchHop needs to decide on an ellipsis — `text.length`
 *  alone isn't enough, since trailing whitespace in a byte-capped read can trim back down to (or
 *  under) MAX_CHARS even though real content past the MAX_BYTES cutoff was never read at all. */
interface BoundedRead {
  text: string;
  capped: boolean;
}

/** Read at most MAX_BYTES of a response body (so a huge page can't OOM the process). */
async function readBounded(r: Response): Promise<BoundedRead> {
  // Capped to MAX_BYTES here, not the smaller MAX_CHARS: fetchHop applies the final
  // MAX_CHARS-with-ellipsis truncation itself, and a caller-visible "was this truncated" signal
  // (the ellipsis) requires that fetchHop actually see a body longer than MAX_CHARS when the
  // underlying page is — pre-truncating to exactly MAX_CHARS here would make every body arrive
  // already within bounds, silently discarding that signal before fetchHop can add it.
  if (!r.body) {
    const full = await r.text();
    return { text: truncateSafely(full, MAX_BYTES), capped: full.length > MAX_BYTES };
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let bytes = 0;
  let sawEnd = false;
  try {
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        sawEnd = true;
        break;
      }
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await cancelQuietly(() => reader.cancel());
  }
  return { text: out + decoder.decode(), capped: !sawEnd };
}

/** Outcome of a single fetch hop: either a redirect to follow, or a terminal result (success
 *  or error) to hand back to the caller. `bytes`/`isHtml` ride along on success only, for the
 *  caller's telemetry span. Never throws — network and parsing failures become `result.error`. */
type HopOutcome = { redirect: URL } | { result: WebFetchResult; bytes?: number; isHtml?: boolean };

/** Cancel a response body without reading it — for the redirect and non-OK branches below, which
 *  (unlike the success path's readBounded()) never consume the stream. Left uncancelled, the
 *  underlying socket is never released back to ssrfAgent's undici connection pool, and fetchUrl
 *  can hit this on every one of MAX_REDIRECTS hops per call. */
async function cancelBody(r: Response): Promise<void> {
  return cancelQuietly(() => r.body?.cancel());
}

/** Shaped body of a successful hop: title (HTML only), final text, and whether it was HTML.
 *  Pure and unit-testable — the content-type sniffing / text-extraction / ellipsis logic that a
 *  fetched body goes through once headers are in and the bytes are read. */
interface ShapedBody {
  title?: string;
  text: string;
  isHtml: boolean;
}

/** Sniff `ctype`/`body` as HTML or plain text, extract the readable text (+title, if HTML), and
 *  force a trailing ellipsis when `capped` says real content may extend past what was read — even
 *  if `text.length` alone wouldn't have triggered one (see readBounded's doc comment on `capped`). */
function shapeBody(ctype: string, body: string, capped: boolean): ShapedBody {
  const isHtml = ctype.includes('html') || /<html[\s>]/i.test(body);
  const shaped = isHtml ? htmlToText(body) : truncateWithEllipsis(body.trim(), MAX_CHARS);
  const text = capped && !shaped.endsWith('…') ? shaped + '…' : shaped;
  const title = isHtml ? extractTitle(body) : undefined;
  return { title, text, isHtml };
}

/** Fetch one hop of `target` and classify the response. Isolates the per-hop response handling
 *  (redirect vs. HTTP error vs. content-type sniffing vs. text extraction) from the redirect-loop
 *  and SSRF-guarding that fetchUrl drives around it. */
async function fetchHop(target: URL, timeout: AbortSignal): Promise<HopOutcome> {
  try {
    const r = await fetch(target, {
      signal: timeout,
      redirect: 'manual', // re-validate each hop ourselves; never auto-follow to an internal host
      dispatcher: ssrfAgent, // reject private addresses at connect (DNS-rebinding safe)
      headers: { 'User-Agent': 'voice-chain-flue/1.0', Accept: 'text/html,text/plain,*/*' },
    } as RequestInit & { dispatcher: Agent });
    const location = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && location) {
      await cancelBody(r);
      try {
        return { redirect: new URL(location, target) };
      } catch {
        return { result: { url: target.toString(), error: 'That page redirected to an invalid URL.' } };
      }
    }
    if (!r.ok) {
      await cancelBody(r);
      return { result: { url: target.toString(), error: `The page returned HTTP ${r.status}.` } };
    }
    const ctype = r.headers.get('Content-Type') ?? '';
    const { text: body, capped } = await readBounded(r);
    const { title, text, isHtml } = shapeBody(ctype, body, capped);
    if (!text) return { result: { url: target.toString(), title, error: 'That page had no readable text.' } };
    return { result: { url: target.toString(), title, text }, bytes: body.length, isHtml };
  } catch (e) {
    return { result: { url: target.toString(), error: `Could not fetch that page: ${describeFetchError(e)}.` } };
  }
}

/** Fetch a URL and return its readable text. Only public http(s) destinations are allowed:
 *  redirects are followed by hand so every hop is SSRF-checked, hosts that resolve to a private
 *  address are rejected at connect time, and the body is read with a byte cap. */
export async function fetchUrl(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
  return withSpan('tool.web_fetch', { url }, async (span) => {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return { error: `That doesn't look like a valid URL: ${url}` };
    }
    const timeout = resolveTimeoutSignal(signal);
    // <= , not <: MAX_REDIRECTS is the number of redirects to follow, not the number of fetches.
    // Each loop iteration is one fetch, and only a redirect outcome consumes a "redirect" — so
    // this must allow one more fetch than MAX_REDIRECTS for the final (non-redirect) hop to land.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return { error: 'Only http and https URLs can be fetched.' };
      }
      const bad = guardHost(current.hostname);
      if (bad) return { url: current.toString(), error: `Can't fetch that page: ${bad}.` };
      const outcome = await fetchHop(current, timeout);
      if ('redirect' in outcome) {
        current = outcome.redirect;
        continue;
      }
      if (outcome.bytes !== undefined) {
        span.setAttributes({ 'webfetch.bytes': outcome.bytes, 'webfetch.html': outcome.isHtml });
      }
      return outcome.result;
    }
    return { url: current.toString(), error: 'That page redirected too many times.' };
  });
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const WEBFETCH_INSTRUCTIONS = `
## Tool: web_fetch
- You have a tool called web_fetch that retrieves the readable text of a web page from a URL.
- Use it when the user gives you a link, or asks what a specific page or article says. Pass the
  full URL (including https://). Only http/https pages can be fetched.
- The tool returns the page's title and text (possibly truncated). Read it, then answer the
  user's question about it conversationally and briefly — summarize, don't read the whole page
  aloud. If the tool returns an error, tell the user plainly that you couldn't open that page.
- Do not guess a URL. If the user refers to a page without giving a link, ask for the URL (or
  use web_search, if available, to find it first).
`.trim();

/** Flue tool the model can call. Kept thin — real logic lives in fetchUrl(). */
export const webFetch = defineTool({
  name: 'web_fetch',
  description: 'Fetch a web page by URL and return its readable text (title + body).',
  input: v.object({
    url: v.pipe(v.string(), v.description('The full URL to fetch, e.g. https://example.com/article')),
  }),
  output: v.object({
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    text: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  async run({ input, signal }) {
    return fetchUrl(input.url, signal ?? undefined);
  },
});
