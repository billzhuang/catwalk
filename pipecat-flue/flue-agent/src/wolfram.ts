import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { boundedText, buildQueryUrl, fetchAndInterpret, resolveTimeoutSignal, withSpanAndLookupError } from './tool-net.ts';

export interface WolframResult {
  answer?: string;
  error?: string;
}

const SHORT_ANSWER_URL = 'https://api.wolframalpha.com/v1/result';
/** Bounds a model-supplied `query` the same way animation.ts bounds its own free-text fields, so
 *  an over-filled arg can't reach the Wolfram Alpha API unbounded. Same cap as web_search's query
 *  (websearch.ts) — both take a comparable natural-language question. */
const QUERY_MAX_LENGTH = 500;

/** Build a Short Answers API request URL. Free tier: an AppID from a Wolfram|Alpha developer
 *  account (no cost), ~2000 calls/month. Pure, unit-testable. */
export function buildWolframUrl(query: string, appId: string): string {
  return buildQueryUrl(SHORT_ANSWER_URL, { appid: appId, i: query });
}

/** Turn a Short Answers API HTTP response into a WolframResult. Pure, unit-testable.
 *  The API replies with a plain-text answer on 200, and 501 when it can't interpret the input. */
export function interpretWolframResponse(status: number, body: string): WolframResult {
  const text = body.trim();
  if (status === 200 && text) return { answer: text };
  if (status === 501) return { error: `Wolfram Alpha could not interpret that: ${text || 'no answer available'}.` };
  return { error: `Wolfram Alpha lookup failed (HTTP ${status}): ${text || 'no details'}.` };
}

/** Short factual/computed answer via Wolfram Alpha's free Short Answers API. */
export async function queryWolfram(query: string, signal?: AbortSignal): Promise<WolframResult> {
  return withSpanAndLookupError<WolframResult>('tool.ask_wolfram', { query }, 'Wolfram Alpha lookup', async (span) => {
    const appId = process.env.WOLFRAM_APP_ID?.trim();
    if (!appId) return { error: 'Wolfram Alpha is not configured (missing WOLFRAM_APP_ID).' };
    const result = await fetchAndInterpret(
      buildWolframUrl(query, appId),
      { signal: resolveTimeoutSignal(signal) },
      interpretWolframResponse,
    );
    span.setAttributes({ 'wolfram.ok': !result.error });
    return result;
  });
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const WOLFRAM_INSTRUCTIONS = `
## Tool: ask_wolfram
- You have a tool called ask_wolfram for math, unit conversions, and short factual or
  computed answers (arithmetic, equations, conversions, dates, general knowledge facts).
  Always call it rather than computing math yourself or guessing a fact it could answer.
- Pass the user's question in plain language, close to how they asked it — the tool
  understands natural phrasing, not just formulas.
- Speak the result naturally and briefly. If the tool returns an error — including when it
  is not configured — tell the user plainly that you can't look that up right now, rather
  than guessing an answer.
`.trim();

/** Flue tool the model can call. Kept thin — real logic lives in queryWolfram(). */
export const askWolfram = defineTool({
  name: 'ask_wolfram',
  description: 'Get a short factual or computed answer (math, conversions, general knowledge) from Wolfram Alpha.',
  input: v.object({
    query: boundedText(QUERY_MAX_LENGTH, "A question or expression, e.g. '15% of 80' or 'distance from Paris to Tokyo'"),
  }),
  output: v.object({
    answer: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  async run({ input, signal }) {
    return queryWolfram(input.query, signal ?? undefined);
  },
});
