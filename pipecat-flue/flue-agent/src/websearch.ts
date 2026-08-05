import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { boundedText, buildQueryUrl, decodeEntities, fetchAndInterpret, resolveTimeoutSignal, withSpanAndLookupError } from './tool-net.ts';
import { readEnvLines } from './paths.ts';
import { createLazyCache, resolveTrimmedEnv } from './model-config.ts';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchResult {
  results?: WebSearchHit[];
  error?: string;
}

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
/** Bounds a model-supplied `query` the same way animation.ts bounds its own free-text fields, so
 *  an over-filled arg can't reach the Brave API unbounded. Search queries run longer than a place
 *  name (weather.ts's CITY_INPUT), hence the higher cap. */
const QUERY_MAX_LENGTH = 500;
const MAX_RESULTS = 5;
// Request more raw hits than MAX_RESULTS (Brave's web-search count cap is 20): interpretBraveResponse
// filters invalid entries before applying the MAX_RESULTS cap, but that only has spare hits to
// recover with if the raw response actually contains more than MAX_RESULTS to begin with.
const FETCH_COUNT = 20;

const braveKeyCache = createLazyCache<string | undefined>(() => {
  const envKey = process.env.BRAVE_API_KEY?.trim();
  if (envKey) return envKey;
  const path = resolveTrimmedEnv(process.env.BRAVE_ENV, '~/env/brave.sh');
  try {
    for (const line of readEnvLines(path)) {
      if (line.kind !== 'pair') continue;
      if (['apikey', 'brave_api_key', 'brave_key', 'key'].includes(line.key)) {
        const val = line.value || undefined;
        if (val) return val;
        // an empty value (e.g. `apikey=`) isn't a real key — keep scanning later aliases
      }
    }
  } catch {
    /* file missing -> treated as not configured */
  }
  return undefined;
});

/** Test-only: clear the memoized Brave API key so tests can exercise loadBraveKey's
 *  file-parsing path independently instead of relying on test execution order. */
export function _resetBraveKeyCacheForTests(): void {
  braveKeyCache.resetForTests();
}

/** Read the Brave API key. Prefers $BRAVE_API_KEY, else the `apikey=` line in ~/env/brave.sh
 *  (same runtime-secret convention as ~/env/aifoundry.sh — never committed). Memoized once a key
 *  is found, so we don't readFileSync on every search; keeps retrying until a key exists. */
export function loadBraveKey(): string | undefined {
  return braveKeyCache.get();
}

/** Build a Brave Search API request URL. Pure, unit-testable. */
export function buildBraveUrl(query: string, count = MAX_RESULTS): string {
  return buildQueryUrl(BRAVE_URL, { q: query, count: String(count) });
}

/** Strip Brave's <strong> highlight tags and decode entities from a snippet/title. Accepts
 *  `unknown`, not just `string | undefined`: Brave's JSON is parsed with no schema validation,
 *  so a title/description field can come back as a number/object/etc at runtime despite the
 *  call site's type annotation — same untrusted-shape hazard `url` below is already guarded
 *  against with its own `typeof` check. Without this guard a non-string value throws inside
 *  `.replace`, which `withSpanAndLookupError` surfaces as a `Web search failed: ...` error the
 *  agent can end up reading aloud verbatim. */
function cleanBraveText(s: unknown): string {
  const str = typeof s === 'string' ? s : '';
  return decodeEntities(str.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Turn a Brave web/search HTTP response into a WebSearchResult. Pure, unit-testable. */
export function interpretBraveResponse(status: number, body: string): WebSearchResult {
  if (status === 401 || status === 403) return { error: 'Web search is not authorized (check the Brave API key).' };
  if (status === 429) return { error: 'Web search hit its rate limit; try again in a moment.' };
  if (status !== 200) return { error: `Web search failed (HTTP ${status}).` };
  let data: { web?: { results?: unknown } };
  try {
    data = JSON.parse(body);
  } catch {
    return { error: 'Web search returned an unreadable response.' };
  }
  const raw = data?.web?.results;
  if (!Array.isArray(raw) || raw.length === 0) return { results: [] };
  const results = raw
    .map((r: unknown) => {
      // Same untrusted-JSON hazard as cleanBraveText() above, one level up: Brave's `results`
      // array can itself contain a non-object entry (null was observed in the wild), and
      // destructuring straight off it would throw reading `.title` before cleanBraveText() runs.
      const hit = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      return {
        title: cleanBraveText(hit.title),
        url: typeof hit.url === 'string' ? hit.url : '',
        snippet: cleanBraveText(hit.description),
      };
    })
    // Filter before slicing: invalid entries (dropped here) must not consume a slot in the
    // MAX_RESULTS cap, or a few bad entries near the front of `raw` can starve out valid hits
    // further back — returning fewer (or zero) results even though good ones exist.
    .filter((r) => r.url)
    .slice(0, MAX_RESULTS);
  return { results };
}

/** Live web search via the Brave Search API (free tier: a key from api-dashboard.search.brave.com). */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
  return withSpanAndLookupError<WebSearchResult>('tool.web_search', { query }, 'Web search', async (span) => {
    const key = loadBraveKey();
    if (!key) return { error: 'Web search is not configured (no Brave API key in ~/env/brave.sh).' };
    const result = await fetchAndInterpret(
      buildBraveUrl(query, FETCH_COUNT),
      { signal: resolveTimeoutSignal(signal), headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
      interpretBraveResponse,
    );
    span.setAttributes({ 'websearch.ok': !result.error, 'websearch.count': result.results?.length ?? 0 });
    return result;
  });
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const WEBSEARCH_INSTRUCTIONS = `
## Tool: web_search
- You have a tool called web_search that looks up current information on the web and returns the
  top results (title, URL, and a short snippet).
- Use it for things you can't know reliably from memory: recent events, current facts, prices,
  schedules, "what is X", or when the user asks you to look something up or find a page. For live
  weather use get_weather, and for math or unit conversions use ask_wolfram — those are better.
- After searching, answer conversationally and briefly from the snippets. If you need the full
  detail of one result, follow up with web_fetch on its URL. Don't read URLs aloud unless asked.
- If the tool returns an error — including when it is not configured — tell the user plainly that
  you can't search the web right now, rather than inventing an answer.
`.trim();

/** Flue tool the model can call. Kept thin — real logic lives in searchWeb(). */
export const webSearch = defineTool({
  name: 'web_search',
  description: 'Search the web for current information and return the top results (title, URL, snippet).',
  input: v.object({
    query: boundedText(QUERY_MAX_LENGTH, 'What to search for, in plain language'),
  }),
  output: v.object({
    results: v.optional(
      v.array(v.object({ title: v.string(), url: v.string(), snippet: v.string() })),
    ),
    error: v.optional(v.string()),
  }),
  async run({ input, signal }) {
    return searchWeb(input.query, signal ?? undefined);
  },
});
