import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';

export interface WebFetchResult {
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

const MAX_CHARS = 6000; // enough for the model to summarize aloud; keeps the turn small
const MAX_BYTES = 2_000_000; // don't slurp huge pages
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Resolve the effective abort signal for an outbound request: the caller's `signal` if given,
 *  else a shared default timeout. Exported so websearch.ts's Brave Search call shares the same
 *  default instead of repeating the literal. */
export function resolveTimeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
}

/** Turn a numeric HTML character reference into a char, or return `fallback` (the original
 *  entity text) when the code point is out of range — String.fromCodePoint throws otherwise. */
function codePoint(n: number, fallback: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

/** Decode the handful of HTML entities that survive tag-stripping. Pure. `&amp;` is decoded
 *  LAST so already-escaped sequences (e.g. `&amp;lt;`) aren't double-decoded. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&amp;/g, '&');
}

/** Extract the <title>, if any. Pure. */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) || undefined : undefined;
}

/** Reduce an HTML document to readable plain text. Pure and unit-testable: drop
 *  script/style/noscript/head-ish noise, map block boundaries to newlines, strip tags, decode
 *  entities, collapse whitespace, and truncate to `maxChars` (without splitting a surrogate
 *  pair). Not a full DOM parser — good enough to read a page aloud. */
export function htmlToText(html: string, maxChars = MAX_CHARS): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxChars) return text;
  // Don't cut between a UTF-16 surrogate pair (would leave a lone surrogate).
  let cut = maxChars;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + '…';
}

/** True if an IP literal is loopback / private / link-local / CGNAT / IPv6-ULA / unspecified.
 *  Pure and unit-testable — the SSRF classifier. Handles IPv4-mapped IPv6 in both dotted
 *  (`::ffff:a.b.c.d`) and hex (`::ffff:7f00:1`) forms. */
export function isPrivateAddress(ip: string): boolean {
  let addr = (ip || '').trim().toLowerCase();
  const dotted = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    addr = dotted[1];
  } else {
    const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      addr = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
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
    if (addr === '::1' || addr === '::') return true; // loopback / unspecified
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

/** Read at most MAX_BYTES of a response body (so a huge page can't OOM the process). */
async function readBounded(r: Response): Promise<string> {
  if (!r.body) return (await r.text()).slice(0, MAX_CHARS);
  const reader = r.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let bytes = 0;
  try {
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return out + decoder.decode();
}

/** Turn a caught fetch error into a plain, user-facing message. `AbortSignal.timeout()`
 *  rejects with a DOMException named 'TimeoutError', which reads better as "timed out"
 *  than its raw message. Pure, unit-testable. Shared with websearch.ts. */
export function describeFetchError(e: unknown): string {
  return (e as Error).name === 'TimeoutError' ? 'the request timed out' : (e as Error).message;
}

/** Outcome of a single fetch hop: either a redirect to follow, or a terminal result (success
 *  or error) to hand back to the caller. `bytes`/`isHtml` ride along on success only, for the
 *  caller's telemetry span. Never throws — network and parsing failures become `result.error`. */
type HopOutcome = { redirect: URL } | { result: WebFetchResult; bytes?: number; isHtml?: boolean };

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
      try {
        return { redirect: new URL(location, target) };
      } catch {
        return { result: { url: target.toString(), error: 'That page redirected to an invalid URL.' } };
      }
    }
    if (!r.ok) return { result: { url: target.toString(), error: `The page returned HTTP ${r.status}.` } };
    const ctype = r.headers.get('Content-Type') ?? '';
    const body = await readBounded(r);
    const isHtml = ctype.includes('html') || /<html[\s>]/i.test(body);
    const text = isHtml ? htmlToText(body) : body.slice(0, MAX_CHARS).trim();
    const title = isHtml ? extractTitle(body) : undefined;
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
