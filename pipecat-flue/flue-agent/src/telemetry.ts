import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * OpenTelemetry tracing, off by default. Set the standard OTEL_EXPORTER_OTLP_ENDPOINT env var
 * to export spans (traces/tools calls, Azure chat completions) to a collector; otherwise
 * tracer() below resolves to the @opentelemetry/api no-op tracer and withSpan() below costs
 * nothing beyond a couple of function calls.
 */
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'flue-agent';

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
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}
