import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { INSTRUCTIONS } from '../instructions.ts';
import { getWeather } from '../weather.ts';

export const description = 'Spoken weather assistant — the flue harness in the voice pipeline.';

// Exposes the agent over HTTP: POST /agents/weather/:id  (?wait=result to block for the reply).
export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => ({
  model: 'azure/gpt-5.4',
  // Low reasoning effort keeps voice latency down; the tool supplies the facts.
  thinkingLevel: 'low',
  // Long, stable instructions FIRST = the cached prefix (see instructions.ts).
  instructions: INSTRUCTIONS,
  tools: [getWeather],
}));
