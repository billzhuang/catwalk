import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { geocodePlace, placeLabel } from './weather.ts';

export interface TimeResult {
  location?: string;
  timezone?: string;
  time?: string;
  error?: string;
}

/** Format a moment in an IANA time zone as a spoken-friendly string. Pure, unit-testable. */
export function formatTimeInZone(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

/** Live local time via the same Open-Meteo geocoding lookup weather.ts uses. */
export async function lookupTime(city: string, signal?: AbortSignal): Promise<TimeResult> {
  try {
    const g = await geocodePlace(city, signal);
    if (!g) return { error: `Could not find a place called '${city}'.` };
    if (!g.timezone) return { error: `No timezone information for '${city}'.` };
    return { location: placeLabel(g), timezone: g.timezone, time: formatTimeInZone(g.timezone, new Date()) };
  } catch (e) {
    return { error: `Time lookup failed: ${(e as Error).message}` };
  }
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const TIME_INSTRUCTIONS = `
## Tool: get_time
- You also have a tool called get_time that returns the current local date and time for
  any place. Use it whenever someone asks what time it is somewhere, or whether it would
  be a reasonable hour to call or visit — never guess or compute it yourself.
- Speak the result naturally, for example "it's about ten fifteen on a Tuesday morning in
  Tokyo right now." If the tool returns an error, tell the user plainly that you could not
  find that place and ask them to try another name.
`.trim();

/** Flue tool the model can call. Kept thin — real logic lives in lookupTime(). */
export const getTime = defineTool({
  name: 'get_time',
  description: 'Get the current local date and time for a city or place name.',
  input: v.object({
    city: v.pipe(v.string(), v.description("City or place, e.g. 'Tokyo' or 'Paris, France'")),
  }),
  output: v.object({
    location: v.optional(v.string()),
    timezone: v.optional(v.string()),
    time: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  async run({ input, signal }) {
    return lookupTime(input.city, signal ?? undefined);
  },
});
