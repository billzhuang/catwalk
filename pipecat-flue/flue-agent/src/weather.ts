import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/** WMO weather interpretation codes -> plain-language conditions. */
export const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'moderate drizzle',
  55: 'dense drizzle', 61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
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

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Live weather via Open-Meteo (free, no key). Pure function, unit-testable. */
export async function lookupWeather(city: string, signal?: AbortSignal): Promise<WeatherResult> {
  try {
    const geo = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      signal,
    );
    const g = geo.results?.[0];
    if (!g) return { error: `Could not find a place called '${city}'.` };
    const label = [g.name, g.admin1, g.country].filter(Boolean).join(', ');
    const w = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code`,
      signal,
    );
    const c = w.current ?? {};
    return {
      location: label,
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kmh: c.wind_speed_10m,
      conditions: describeCode(c.weather_code),
    };
  } catch (e) {
    return { error: `Weather lookup failed: ${(e as Error).message}` };
  }
}

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
