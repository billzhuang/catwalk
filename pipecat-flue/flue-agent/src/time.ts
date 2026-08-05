import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { CITY_INPUT, placeLabel, withGeocode } from './weather.ts';
import { resolveTimeoutSignal, withSpanAndLookupError } from './tool-net.ts';

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

/** Live local time via the same Open-Meteo geocoding lookup weather.ts uses. Resolves the timeout
 *  signal up front like lookupWeather does — geocodePlace's own resolveTimeoutSignal(undefined)
 *  default only engages when handed `undefined`, so forwarding the flue runtime's turn-scoped
 *  signal (defined, never self-aborting) straight through would leave the request unbounded. */
export async function lookupTime(city: string, signal?: AbortSignal): Promise<TimeResult> {
  return withSpanAndLookupError<TimeResult>('tool.get_time', { city }, 'Time lookup', async (span) => {
    const effective = resolveTimeoutSignal(signal);
    return withGeocode<TimeResult>(city, effective, (g) => {
      if (!g.timezone) return { error: `No timezone information for '${city}'.` };
      const result = { location: placeLabel(g), timezone: g.timezone, time: formatTimeInZone(g.timezone, new Date()) };
      span.setAttributes({ 'time.location': result.location, 'time.timezone': result.timezone });
      return result;
    });
  });
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
    city: CITY_INPUT,
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
