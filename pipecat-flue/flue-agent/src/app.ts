import { registerProvider, observe, type FlueObservation } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createAzureProxy, metrics, cacheRate } from './azure-proxy.ts';
import {
  applyAnimationControl,
  findByAnyKey,
  nextRevision,
  storeWithEviction,
  parseShowMathAnimationArgs,
  parseControlAction,
} from './animation.ts';
import { resolveModel } from './model-config.ts';
import { initTelemetry } from './telemetry.ts';

// No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set; awaited so the exporter is registered
// before the first request can start a span.
await initTelemetry();

// Port flue dev binds (default 3583). The `azure` provider calls back into this
// same process's /az proxy over loopback.
const PORT = Number(process.env.PORT ?? process.env.FLUE_PORT ?? 3583);
const PROXY_BASE = process.env.AZURE_PROXY_BASE ?? `http://127.0.0.1:${PORT}/az/v1`;

// gpt-5.4 on Azure via an OpenAI-compatible custom provider. The proxy injects the
// real api-key, so the key never lives in flue config or the repo.
registerProvider('azure', {
  api: 'openai-completions',
  baseUrl: PROXY_BASE,
  apiKey: 'via-proxy', // ignored; the proxy sets the real Azure api-key header
  contextWindow: 272_000,
  maxTokens: 8_192,
});

const app = new Hono();

// show_math_animation/control_math_animation are UI side-effects: flue's turn result only
// carries text, so we observe the tool calls here and keep the latest animation state (topic,
// title/steps for an on-the-fly topic, and its current step index) keyed by the conversation id
// (the `:id` in POST /agents/weather/:id). The pipecat bot polls GET /animation/:id and pushes
// state to the browser. Unlike the original one-shot design, state is NOT cleared after a read
// — voice pacing (control_math_animation) needs it to persist across polls — so the client
// instead tracks `revision` itself and only re-renders when it changes.
interface AnimationState {
  topic: string;
  title?: string;
  steps?: string[];
  stepIndex: number;
  revision: number;
  keys: string[];
}
const animationState = new Map<string, AnimationState>();
// Bounds otherwise-unbounded growth (a new browser tab mints a fresh conversation id, and
// entries are never cleared by a read anymore) by evicting the least-recently-touched
// conversation once the map would grow past this many entries.
const MAX_ANIMATION_ENTRIES = 1000;

function storeAnimationState(state: AnimationState) {
  storeWithEviction(animationState, state, MAX_ANIMATION_ENTRIES);
}

/** The observe() subscriber below, pulled out as a named export so it can be driven directly
 *  in tests — `observe()` only fires on live tool calls during a real agent turn, which a unit
 *  test can't cheaply produce. */
export function handleFlueEvent(event: FlueObservation): void {
  if (event.type !== 'tool_start') return;
  // Direct agent activity is keyed by instanceId; conversationId may also be set. Store/look up
  // under both aliases so a lookup by the URL id hits regardless of which one the runtime
  // populated.
  const keys = [event.conversationId, event.instanceId].filter((k): k is string => !!k);
  if (!keys.length) return;

  if (event.toolName === 'show_math_animation') {
    const parsed = parseShowMathAnimationArgs(event.args);
    if (!parsed) return;
    storeAnimationState({
      ...parsed,
      stepIndex: 0,
      revision: nextRevision(animationState, keys),
      keys,
    });
    return;
  }

  if (event.toolName === 'control_math_animation') {
    const action = parseControlAction(event.args);
    const current = findByAnyKey(animationState, keys);
    if (!action || !current || !current.steps?.length) return; // nothing to control
    storeAnimationState({
      ...current,
      stepIndex: applyAnimationControl(current.stepIndex, current.steps.length, action),
      revision: current.revision + 1,
    });
  }
}

observe(handleFlueEvent);

app.get('/health', (c) => c.json({ ok: true, model: resolveModel(), proxyBase: PROXY_BASE }));

// Live prompt-cache metrics (proof the caching rate is good).
app.get('/metrics', (c) =>
  c.json({ ...metrics, cacheRate: Number(cacheRate().toFixed(4)) }),
);

// Current math-animation state for this conversation, if any. `revision` increments on every
// new topic or step change so the polling client can tell whether there's anything new since
// its last poll without the server needing to clear anything.
app.get('/animation/:id', (c) => {
  const id = c.req.param('id');
  const entry = animationState.get(id);
  return c.json({
    topic: entry?.topic ?? null,
    title: entry?.title,
    steps: entry?.steps,
    stepIndex: entry?.stepIndex ?? 0,
    revision: entry?.revision ?? 0,
  });
});

// flue -> Azure proxy (auth + gpt-5 normalization + cache measurement).
app.route('/az', createAzureProxy());

// flue's public API: POST /agents/weather/:id?wait=result etc.
app.route('/', flue());

export default app;
