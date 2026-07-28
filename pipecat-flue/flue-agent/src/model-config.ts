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

export function resolveModel(env: Record<string, string | undefined> = process.env): string {
  return resolveTrimmedEnv(env.FLUE_MODEL, DEFAULT_MODEL);
}

export function resolveThinkingLevel(env: Record<string, string | undefined> = process.env): string {
  const level = resolveTrimmedEnv(env.FLUE_THINKING_LEVEL, DEFAULT_THINKING_LEVEL).toLowerCase();
  if (!THINKING_LEVELS.has(level)) {
    console.warn(
      `FLUE_THINKING_LEVEL=${level} is not a recognized thinking level (${[...THINKING_LEVELS].join(', ')}); falling back to ${DEFAULT_THINKING_LEVEL}`,
    );
    return DEFAULT_THINKING_LEVEL;
  }
  return level;
}

// Port flue dev binds to (default 3583). A set-but-non-numeric PORT/FLUE_PORT (e.g. an operator
// typo) would otherwise silently resolve to NaN, pointing the `azure` provider's loopback proxy
// at a nonexistent host with no error until the first request fails.
export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PORT?.trim() || env.FLUE_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(`PORT/FLUE_PORT=${raw} is not a valid port number; falling back to ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

// The `azure` provider calls back into this same process's /az proxy over loopback.
export function resolveProxyBase(env: Record<string, string | undefined> = process.env): string {
  return resolveTrimmedEnv(env.AZURE_PROXY_BASE, `http://127.0.0.1:${resolvePort(env)}/az/v1`);
}
