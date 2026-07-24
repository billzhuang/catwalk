/**
 * Lets an operator switch which model/reasoning-effort flue uses without editing
 * code — e.g. pointing at an existing DeepSeek deployment on the same Azure AI
 * Foundry resource, or dialing thinking level for latency vs. quality. Defaults
 * reproduce today's hardcoded azure/gpt-5.4 @ low.
 */
const DEFAULT_MODEL = 'azure/gpt-5.4';
const DEFAULT_THINKING_LEVEL = 'low';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Blank/missing env vars are treated the same as unset, falling back to a default.
function resolveTrimmedEnv(raw: string | undefined, fallback: string): string {
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
