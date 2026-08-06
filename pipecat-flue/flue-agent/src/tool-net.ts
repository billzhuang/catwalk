import type { Span } from '@opentelemetry/api';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Length cap for a model-supplied natural-language query string — a question or search phrase,
 *  as opposed to a short place name (weather.ts's own, smaller CITY_INPUT cap). Shared by
 *  websearch.ts's web_search and wolfram.ts's ask_wolfram, whose query inputs are the same shape
 *  and previously duplicated this same value in two places. */
export const QUERY_MAX_LENGTH = 500;

/** Resolve the effective abort signal for an outbound request: the caller's `signal` combined
 *  with a default timeout, so neither can starve the other. The flue runtime always hands tools
 *  a turn-scoped abort signal (aborted only on user interruption, never on its own), so treating
 *  it as a substitute for the timeout — rather than combining the two — would leave a hung
 *  upstream call with no ceiling until the user interrupts. Shared by every network tool
 *  (web_fetch, weather, time, wolfram, web search) so each doesn't repeat the same default. */
export function resolveTimeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Turn a numeric HTML character reference into a char, or return `fallback` (the original
 *  entity text) when the code point is out of range for String.fromCodePoint, or is a lone
 *  UTF-16 surrogate (0xd800-0xdfff) — a value String.fromCodePoint happily accepts but which
 *  isn't a valid standalone Unicode scalar value, and silently corrupts to U+FFFD once the
 *  resulting string is later encoded as UTF-8. */
function codePoint(n: number, fallback: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return fallback;
  return String.fromCodePoint(n);
}

const ENTITY_RE = /&(nbsp|lt|gt|quot|apos|amp);|&#(\d+);|&#[xX]([0-9a-fA-F]+);/g;

/** Decode the handful of HTML entities that survive tag-stripping. Pure. A single scan over the
 *  original string, so a decoded entity's own text can never be re-matched as a different entity
 *  in a later pass — e.g. a sequential "&#38;" -> "&", then "&amp;" -> "&" pipeline would turn
 *  "&#38;amp;" (a numeric-escaped "&" followed by literal "amp;") into a bare "&", silently
 *  eating the "amp;" text. Shared by webfetch.ts (page titles/body text) and websearch.ts
 *  (Brave's highlighted snippets). */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, named, dec, hex) => {
    if (dec !== undefined) return codePoint(Number(dec), m);
    if (hex !== undefined) return codePoint(parseInt(hex, 16), m);
    switch (named) {
      case 'nbsp':
        return ' ';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'amp':
        return '&';
      default:
        return m;
    }
  });
}

/** Truncate `text` to at most `maxChars` chars without splitting a UTF-16 surrogate pair (which
 *  would leave a lone, invalid surrogate at the cut point). Pure and unit-testable. Shared by
 *  every truncation site in webfetch.ts — htmlToText's ellipsis-suffixed cut and the two plain
 *  (non-HTML) body caps in readBounded/fetchHop — so they can't drift out of sync the way the
 *  non-HTML paths once did. */
export function truncateSafely(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = maxChars;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/** truncateSafely() plus an ellipsis suffix when a cut actually happened — the "was this
 *  truncated" signal the model relies on to know whether it's seeing a whole page or a partial
 *  one. Shared by webfetch.ts's htmlToText (HTML path) and fetchHop (plain-text path) so only
 *  one of the two can't silently drop that signal while the other keeps it. */
export function truncateWithEllipsis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return truncateSafely(text, maxChars) + '…';
}

/** Turn a caught fetch error into a plain, user-facing message. `AbortSignal.timeout()`
 *  rejects with a DOMException named 'TimeoutError', which reads better as "timed out"
 *  than its raw message. Pure, unit-testable. Shared (directly and via withLookupError
 *  below) by every network tool, so every one reports a timeout the same way. */
export function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.name === 'TimeoutError' ? 'the request timed out' : e.message;
}

/** Run a lookup and turn a thrown error into `{ error: "<label> failed: <message>" }`. Shared
 *  by every lookup-style tool (weather, time, wolfram, web search) so each doesn't re-derive
 *  the same try/catch around its network call. Lives alongside describeFetchError (which it
 *  uses) rather than in any one tool module, since it's generic to all of them. */
export async function withLookupError<R extends { error?: string }>(
  label: string,
  fn: () => Promise<R>,
): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    return { error: `${label} failed: ${describeFetchError(e)}` } as R;
  }
}

/** withSpan(name, attrs, ...) wrapping withLookupError(label, ...) — every lookup-style tool
 *  (weather, time, wolfram, web search) composes these identically, so each doesn't repeat the
 *  same two-layer wrapping around its network call. */
export async function withSpanAndLookupError<R extends { error?: string }>(
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  label: string,
  fn: (span: Span) => Promise<R>,
): Promise<R> {
  return withSpan(spanName, attributes, (span) => withLookupError<R>(label, () => fn(span)));
}

/** Trimmed, non-empty, length-capped free-text schema for a model-supplied tool input — the same
 *  defense animation.ts's topic/title/step schemas apply to their own model-supplied text (trim,
 *  reject blank, cap length). Shared by every tool whose input string feeds an external API
 *  (weather's CITY_INPUT, web_search's query, ask_wolfram's query) so a model that over-fills one
 *  of these loosely-typed string args can't send unbounded or blank text into a downstream call. */
export function boundedText(maxLength: number, description: string) {
  return v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maxLength), v.description(description));
}

/** Build a request URL from a base and a set of query params. Shared by wolfram.ts's
 *  buildWolframUrl and websearch.ts's buildBraveUrl, which otherwise each repeat the same
 *  "new URL(base), set N searchParams, toString()" shape around a different base/param set. */
export function buildQueryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Wraps the repeated stream-decode-then-flush idiom: `decode()` buffers a multi-byte codepoint
 *  split across chunk boundaries (matching `TextDecoder.decode(chunk, { stream: true })`), and
 *  `flush()` must be called exactly once after the last chunk to emit any codepoint the final
 *  chunk left buffered — otherwise it's silently dropped instead of appearing in the decoded
 *  text. Shared by webfetch.ts's readBounded and azure-proxy.ts's respondStreaming, which each
 *  used to roll this by hand around their own TextDecoder instance. */
export function createStreamDecoder(): { decode(chunk: Uint8Array): string; flush(): string } {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return {
    decode: (chunk) => decoder.decode(chunk, { stream: true }),
    flush: () => decoder.decode(),
  };
}

/** Fetch `url` and hand the response's status and body text to `interpret` — the
 *  fetch-then-interpret(status, body) shape wolfram.ts's queryWolfram and websearch.ts's
 *  searchWeb each repeat around their one network call, differing only in the request `init`
 *  and which pure interpret function reads the result. */
export async function fetchAndInterpret<R>(
  url: string,
  init: RequestInit,
  interpret: (status: number, body: string) => R,
): Promise<R> {
  const r = await fetch(url, init);
  return interpret(r.status, await r.text());
}
