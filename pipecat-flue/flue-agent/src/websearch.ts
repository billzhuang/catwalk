import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { withSpan } from './telemetry.ts';
import { decodeEntities } from './webfetch.ts';

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
const MAX_RESULTS = 5;

let cachedBraveKey: string | undefined;

/** Read the Brave API key. Prefers $BRAVE_API_KEY, else the `apikey=` line in ~/env/brave.sh
 *  (same runtime-secret convention as ~/env/aifoundry.sh — never committed). Memoized once a key
 *  is found, so we don't readFileSync on every search; keeps retrying until a key exists. */
export function loadBraveKey(): string | undefined {
  if (cachedBraveKey) return cachedBraveKey;
  if (process.env.BRAVE_API_KEY) return (cachedBraveKey = process.env.BRAVE_API_KEY);
  const path = process.env.BRAVE_ENV ?? '~/env/brave.sh';
  const file = path.startsWith('~') ? resolve(homedir(), path.slice(2)) : path;
  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const s = raw.trim().replace(/^export\s+/, '');
      if (!s || s.startsWith('#') || !s.includes('=')) continue;
      const [k, ...rest] = s.split('=');
      if (['apikey', 'brave_api_key', 'brave_key', 'key'].includes(k.trim().toLowerCase())) {
        const val = rest.join('=').trim().replace(/^["']|["']$/g, '') || undefined;
        if (val) cachedBraveKey = val;
        return val;
      }
    }
  } catch {
    /* file missing -> treated as not configured */
  }
  return undefined;
}

/** Build a Brave Search API request URL. Pure, unit-testable. */
export function buildBraveUrl(query: string, count = MAX_RESULTS): string {
  const url = new URL(BRAVE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  return url.toString();
}

/** Strip Brave's <strong> highlight tags and decode entities from a snippet/title. */
function clean(s: string | undefined): string {
  return decodeEntities((s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
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
    .slice(0, MAX_RESULTS)
    .map((r: { title?: string; url?: unknown; description?: string }) => ({
      title: clean(r.title),
      url: typeof r.url === 'string' ? r.url : '',
      snippet: clean(r.description),
    }))
    .filter((r) => r.url);
  return { results };
}

/** Live web search via the Brave Search API (free tier: a key from api-dashboard.search.brave.com). */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
  return withSpan('tool.web_search', { query }, async (span) => {
    const key = loadBraveKey();
    if (!key) return { error: 'Web search is not configured (no Brave API key in ~/env/brave.sh).' };
    try {
      const r = await fetch(buildBraveUrl(query), {
        signal: signal ?? AbortSignal.timeout(15_000),
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      });
      const result = interpretBraveResponse(r.status, await r.text());
      span.setAttributes({ 'websearch.ok': !result.error, 'websearch.count': result.results?.length ?? 0 });
      return result;
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'the request timed out' : (e as Error).message;
      return { error: `Web search failed: ${msg}.` };
    }
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
    query: v.pipe(v.string(), v.description('What to search for, in plain language')),
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
