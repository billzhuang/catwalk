import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { resolveTimeoutSignal, withSpanAndLookupError } from './webfetch.ts';

/** WMO weather interpretation codes -> plain-language conditions. */
export const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'moderate drizzle',
  55: 'dense drizzle', 56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain', 71: 'slight snow',
  73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains', 80: 'slight rain showers',
  81: 'moderate rain showers', 82: 'violent rain showers', 85: 'slight snow showers',
  86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

export function describeCode(code: number | undefined): string {
  return code == null ? 'unknown' : (WMO[code] ?? `code ${code}`);
}

export interface WeatherResult {
  location?: string;
  temperature_c?: number;
  feels_like_c?: number;
  humidity_pct?: number;
  wind_kmh?: number;
  conditions?: string;
  error?: string;
}

/** Applies the same bounded-default-timeout convention as webfetch.ts/websearch.ts, so a
 *  geocode/forecast call can't hang indefinitely when the caller (e.g. flue's tool-call
 *  runtime) doesn't supply its own abort signal. */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal: resolveTimeoutSignal(signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** Open-Meteo geocoding result for a place name — shared by any tool that needs a place. */
export interface GeocodeResult {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

/** Open-Meteo's geocoding response shape — only the fields we read. */
interface OpenMeteoGeocodeResponse {
  results?: GeocodeResult[];
}

/** Resolve a place name via Open-Meteo (free, no key). Shared with other place-based tools. */
export async function geocodePlace(city: string, signal?: AbortSignal): Promise<GeocodeResult | undefined> {
  const geo = await getJson<OpenMeteoGeocodeResponse>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
    signal,
  );
  return geo.results?.[0];
}

export function placeLabel(g: GeocodeResult): string {
  return [g.name, g.admin1, g.country].filter(Boolean).join(', ');
}

/** Shared "no such place" message for any tool built on geocodePlace(). */
export function placeNotFoundError(city: string): string {
  return `Could not find a place called '${city}'.`;
}

/** geocodePlace() plus its "no such place" error mapping, shared by every place-based tool
 *  (get_weather, get_time) so each doesn't repeat the same not-found check. */
export async function resolveGeocode(city: string, signal?: AbortSignal): Promise<GeocodeResult | { error: string }> {
  const g = await geocodePlace(city, signal);
  return g ?? { error: placeNotFoundError(city) };
}

/** Open-Meteo's forecast response shape — only the `current` fields we read. */
interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
}

/** Live weather via Open-Meteo (free, no key). Pure function, unit-testable. */
export async function lookupWeather(city: string, signal?: AbortSignal): Promise<WeatherResult> {
  return withSpanAndLookupError<WeatherResult>('tool.get_weather', { city }, 'Weather lookup', async (span) => {
    const g = await resolveGeocode(city, signal);
    if ('error' in g) return g;
    const label = placeLabel(g);
    const w = await getJson<OpenMeteoForecastResponse>(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code`,
      signal,
    );
    const c = w.current ?? {};
    const conditions = describeCode(c.weather_code);
    span.setAttributes({ 'weather.location': label, 'weather.conditions': conditions });
    return {
      location: label,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      conditions,
    };
  });
}

/** Instruction section for this tool — composed into the agent prompt by buildInstructions(). */
export const WEATHER_INSTRUCTIONS = `
## Tool: get_weather
- One of the things you're great at is the weather and the everyday decisions around it:
  what to wear, whether to carry an umbrella, if it is a good evening for a walk, travel
  conditions, and so on.
- You have a tool called get_weather that returns the real, current conditions for any
  place. Always call it before stating specific conditions; never invent a temperature,
  a sky condition, wind, or humidity from memory. If the tool returns an error, tell the
  user plainly that you could not find that place and ask them to try another name.
- After you get weather data, deliver it conversationally. Lead with the thing a person
  cares about most — is it hot or cold, wet or dry — then add a detail or two. For example:
  "It's about eighteen degrees and partly cloudy in Paris right now, so a light jacket
  would be perfect." Mention "feels like" only when it differs noticeably from the actual
  temperature.
- Default to Celsius and kilometers per hour, which is what the tool returns. If the user
  clearly prefers Fahrenheit or miles, convert for them and keep using their preference
  for the rest of the conversation.
- If someone asks about a place without saying which one, or the name is ambiguous, ask a
  short clarifying question rather than guessing the wrong city.
- Resolve indirect references before calling the tool. If the user says "there", "that city",
  "the same place", or "how about this evening", substitute the specific place name from
  earlier in the conversation when you call get_weather. Never pass a word like "there" or
  "here" to the tool as if it were a city — the tool only understands real place names.
`.trim();

/** Flue tool the model can call. Kept thin — real logic lives in lookupWeather(). */
export const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current, real weather for a city or place name.',
  input: v.object({
    city: v.pipe(v.string(), v.description("City or place, e.g. 'Tokyo' or 'Paris, France'")),
  }),
  output: v.object({
    location: v.optional(v.string()),
    temperature_c: v.optional(v.number()),
    feels_like_c: v.optional(v.number()),
    humidity_pct: v.optional(v.number()),
    wind_kmh: v.optional(v.number()),
    conditions: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  async run({ input, signal }) {
    return lookupWeather(input.city, signal ?? undefined);
  },
});
