import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * OpenTelemetry tracing, off by default. Set the standard OTEL_EXPORTER_OTLP_ENDPOINT env var
 * to export spans (traces/tools calls, Azure chat completions) to a collector; otherwise
 * tracer() below resolves to the @opentelemetry/api no-op tracer and withSpan() below costs
 * nothing beyond a couple of function calls.
 */
export function resolveServiceName(env: Record<string, string | undefined> = process.env): string {
  return env.OTEL_SERVICE_NAME ?? 'flue-agent';
}

const SERVICE_NAME = resolveServiceName();

let registered = false;

/** Test-only: clear the registration guard so a test can exercise initTelemetry's
 *  registration branch more than once in the same module instance. Mirrors
 *  websearch.ts's _resetBraveKeyCacheForTests. */
export function _resetTelemetryForTests(): void {
  registered = false;
}

/** Registers a global NodeTracerProvider exporting via OTLP/HTTP, only if configured. Idempotent. */
export async function initTelemetry(): Promise<void> {
  if (registered) return;
  registered = true;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;

  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME }] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
}

export const tracer = trace.getTracer(SERVICE_NAME);

/** Normalize any thrown value to an Error, so span recording never has to guess at its shape
 *  (a rejection isn't guaranteed to be an Error — e.g. `throw null` or `throw 'boom'`). */
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Run `fn` inside a span named `name`; records exceptions and sets ERROR status on throw. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      const err = toError(e);
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw e;
    } finally {
      span.end();
    }
  });
}
