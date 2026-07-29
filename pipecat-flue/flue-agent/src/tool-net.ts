import type { Span } from '@opentelemetry/api';
import { withSpan } from './telemetry.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

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

const ENTITY_RE = /&(nbsp|lt|gt|quot|apos|amp);|&#(\d+);|&#x([0-9a-fA-F]+);/g;

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
