import { defineAgent, type AgentRouteHandler, type ThinkingLevel } from '@flue/runtime';
import { buildInstructions } from '../instructions.ts';
import { getWeather, WEATHER_INSTRUCTIONS } from '../weather.ts';
import { getTime, TIME_INSTRUCTIONS } from '../time.ts';
import { askWolfram, WOLFRAM_INSTRUCTIONS } from '../wolfram.ts';
import { showMathAnimation, ANIMATION_INSTRUCTIONS } from '../animation.ts';
import { webFetch, WEBFETCH_INSTRUCTIONS } from '../webfetch.ts';
import { webSearch, WEBSEARCH_INSTRUCTIONS } from '../websearch.ts';
import { resolveModel, resolveThinkingLevel } from '../model-config.ts';

export const description = 'Spoken voice assistant — the flue harness in the voice pipeline.';

// Exposes the agent over HTTP: POST /agents/weather/:id  (?wait=result to block for the reply).
export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent((context) => ({
  // FLUE_MODEL / FLUE_THINKING_LEVEL let ops switch to another existing deployment
  // (e.g. a DeepSeek reasoning model) or dial effort without a code change.
  // Default low reasoning effort keeps voice latency down; the tools supply the facts.
  model: resolveModel(context.env),
  thinkingLevel: resolveThinkingLevel(context.env) as ThinkingLevel,
  // Long, stable instructions FIRST = the cached prefix (see instructions.ts).
  instructions: buildInstructions([
    WEATHER_INSTRUCTIONS,
    TIME_INSTRUCTIONS,
    WOLFRAM_INSTRUCTIONS,
    ANIMATION_INSTRUCTIONS,
    WEBSEARCH_INSTRUCTIONS,
    WEBFETCH_INSTRUCTIONS,
  ]),
  tools: [getWeather, getTime, askWolfram, showMathAnimation, webSearch, webFetch],
}));
