/**
 * Lets an operator switch which model/reasoning-effort flue uses without editing
 * code — e.g. pointing at an existing DeepSeek deployment on the same Azure AI
 * Foundry resource, or dialing thinking level for latency vs. quality. Defaults
 * reproduce today's hardcoded azure/gpt-5.4 @ low.
 */
const DEFAULT_MODEL = 'azure/gpt-5.4';
const DEFAULT_THINKING_LEVEL = 'low';
const DEFAULT_PORT = 3583;

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Blank/missing env vars are treated the same as unset, falling back to a default.
export function resolveTrimmedEnv(raw: string | undefined, fallback: string): string {
  return raw?.trim() || fallback;
}

// Shared by resolveThinkingLevel/resolvePort below: both parse an override, validate it, and on
// failure warn with a message describing what was rejected before falling back to a default.
function validatedOrWarn<T>(value: T, isValid: (v: T) => boolean, warnMessage: (v: T) => string, fallback: T): T {
  if (isValid(value)) return value;
  console.warn(warnMessage(value));
  return fallback;
}

/** A value lazily computed by `compute()` and cached after the first call that returns something
 *  truthy — so a caller whose resource isn't available yet (e.g. a key file not yet created, an
 *  env var not yet set) keeps retrying `compute()` on every call, but once resolved never runs it
 *  again. `resetForTests()` clears the cache so tests can exercise `compute()`'s path more than
 *  once instead of relying on test execution order. Shared by config.ts's chatBlock and
 *  websearch.ts's loadBraveKey, which both need exactly this shape. */
export function createLazyCache<T>(compute: () => T): { get(): T; resetForTests(): void } {
  let cached: T | undefined;
  return {
    get: () => cached ?? (cached = compute()),
    resetForTests: () => {
      cached = undefined;
    },
  };
}

export function resolveModel(env: Record<string, string | undefined> = process.env): string {
  return resolveTrimmedEnv(env.FLUE_MODEL, DEFAULT_MODEL);
}

export function resolveThinkingLevel(env: Record<string, string | undefined> = process.env): string {
  const level = resolveTrimmedEnv(env.FLUE_THINKING_LEVEL, DEFAULT_THINKING_LEVEL).toLowerCase();
  return validatedOrWarn(
    level,
    (l) => THINKING_LEVELS.has(l),
    (l) => `FLUE_THINKING_LEVEL=${l} is not a recognized thinking level (${[...THINKING_LEVELS].join(', ')}); falling back to ${DEFAULT_THINKING_LEVEL}`,
    DEFAULT_THINKING_LEVEL,
  );
}

// Port flue dev binds to (default 3583). A set-but-non-numeric PORT/FLUE_PORT (e.g. an operator
// typo) would otherwise silently resolve to NaN, pointing the `azure` provider's loopback proxy
// at a nonexistent host with no error until the first request fails.
export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PORT?.trim() || env.FLUE_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  return validatedOrWarn(
    port,
    (p) => Number.isInteger(p) && p > 0 && p <= 65535,
    () => `PORT/FLUE_PORT=${raw} is not a valid port number; falling back to ${DEFAULT_PORT}`,
    DEFAULT_PORT,
  );
}

// The `azure` provider calls back into this same process's /az proxy over loopback.
export function resolveProxyBase(env: Record<string, string | undefined> = process.env): string {
  return resolveTrimmedEnv(env.AZURE_PROXY_BASE, `http://127.0.0.1:${resolvePort(env)}/az/v1`);
}
