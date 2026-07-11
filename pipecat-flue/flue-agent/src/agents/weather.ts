import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { buildInstructions } from '../instructions.ts';
import { getWeather, WEATHER_INSTRUCTIONS } from '../weather.ts';
import { getTime, TIME_INSTRUCTIONS } from '../time.ts';

export const description = 'Spoken voice assistant — the flue harness in the voice pipeline.';

// Exposes the agent over HTTP: POST /agents/weather/:id  (?wait=result to block for the reply).
export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => ({
  model: 'azure/gpt-5.4',
  // Low reasoning effort keeps voice latency down; the tools supply the facts.
  thinkingLevel: 'low',
  // Long, stable instructions FIRST = the cached prefix (see instructions.ts).
  instructions: buildInstructions([WEATHER_INSTRUCTIONS, TIME_INSTRUCTIONS]),
  tools: [getWeather, getTime],
}));
