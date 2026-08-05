import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  withSpan,
  toError,
  initTelemetry,
  _resetTelemetryForTests,
  resolveServiceName,
  recordSpanException,
  hasOtlpEndpointConfigured,
} from '../src/telemetry.ts';
import { withEnvVars, withFreshState } from './test-helpers.ts';

// SimpleSpanProcessor exports synchronously on span.end(), so spans are visible immediately.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

test('withSpan records a span with the given name, attributes, and OK status', async () => {
  exporter.reset();
  const result = await withSpan('test.op', { city: 'Tokyo' }, async () => 'ok');
  assert.equal(result, 'ok');
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, 'test.op');
  assert.equal(spans[0].attributes.city, 'Tokyo');
});

test('withSpan records the exception, sets ERROR status, and still rejects', async () => {
  exporter.reset();
  await assert.rejects(
    () => withSpan('test.fail', {}, async () => { throw new Error('boom'); }),
    /boom/,
  );
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
  assert.ok(spans[0].events.some((e) => e.name === 'exception'));
});

test('withSpan: a non-Error throw (e.g. `throw null`) is still recorded and status-set, not a crash on .message', async () => {
  exporter.reset();
  await assert.rejects(
    () => withSpan('test.non-error-throw', {}, async () => { throw null; }),
    (err) => err === null,
  );
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
  assert.equal(spans[0].status.message, 'null', 'status message comes from the wrapped Error, not a crash');
  assert.ok(spans[0].events.some((e) => e.name === 'exception'));
});

test('resolveServiceName: falls back to "flue-agent" when OTEL_SERVICE_NAME is unset, blank, or whitespace-only, otherwise uses it trimmed', () => {
  assert.equal(resolveServiceName({}), 'flue-agent');
  assert.equal(resolveServiceName({ OTEL_SERVICE_NAME: '' }), 'flue-agent');
  assert.equal(resolveServiceName({ OTEL_SERVICE_NAME: '   ' }), 'flue-agent');
  assert.equal(resolveServiceName({ OTEL_SERVICE_NAME: 'my-custom-service' }), 'my-custom-service');
  assert.equal(resolveServiceName({ OTEL_SERVICE_NAME: '  my-custom-service  ' }), 'my-custom-service');
});

test('hasOtlpEndpointConfigured: false when both endpoints are unset, blank, or whitespace-only; true when either is set to a real value', () => {
  assert.equal(hasOtlpEndpointConfigured({}), false);
  assert.equal(hasOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }), false);
  assert.equal(hasOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }), false);
  assert.equal(hasOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '   ' }), false);
  assert.equal(hasOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }), true);
  assert.equal(hasOtlpEndpointConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }), true);
});

test('toError: passes an Error through unchanged, wraps anything else via String()', () => {
  const original = new Error('boom');
  assert.equal(toError(original), original);
  assert.equal(toError('boom').message, 'boom');
  assert.equal(toError(null).message, 'null');
  assert.equal(toError(undefined).message, 'undefined');
});

// recordSpanException is exercised indirectly via withSpan's "records the exception" tests
// above (which only assert on the span's resulting event/status), and via azure-proxy.ts's
// endSpanWithError (which discards the return value entirely). Neither pins this function's
// own two-part contract directly: that it records the *toError-wrapped* value on the span
// (not the raw thrown value), and that it hands that same wrapped Error back to the caller —
// the part withSpan's own ERROR-status message relies on.
function fakeSpanForExceptionRecording() {
  const recorded: unknown[] = [];
  return { recorded, span: { recordException: (e: unknown) => recorded.push(e) } as unknown as Span };
}

test('recordSpanException: records an Error unchanged and returns that same instance', () => {
  const { recorded, span } = fakeSpanForExceptionRecording();
  const original = new Error('boom');
  const returned = recordSpanException(span, original);
  assert.equal(returned, original);
  assert.deepEqual(recorded, [original]);
});

test('recordSpanException: wraps a non-Error throw via toError, and records the wrapped value (not the raw one)', () => {
  const { recorded, span } = fakeSpanForExceptionRecording();
  const returned = recordSpanException(span, 'boom');
  assert.ok(returned instanceof Error);
  assert.equal(returned.message, 'boom');
  assert.deepEqual(recorded, [returned], 'the span sees the wrapped Error, never the raw non-Error value');
});

test('initTelemetry is a no-op when no OTLP endpoint is configured', async () =>
  withFreshState(_resetTelemetryForTests, () =>
    withEnvVars(
      { OTEL_EXPORTER_OTLP_ENDPOINT: undefined, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined },
      async () => {
        await assert.doesNotReject(() => initTelemetry());
      },
    ),
  ));

test('initTelemetry is a no-op when both OTLP endpoints are whitespace-only', async () =>
  withFreshState(_resetTelemetryForTests, () =>
    withEnvVars(
      { OTEL_EXPORTER_OTLP_ENDPOINT: '   ', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '   ' },
      async () => {
        await assert.doesNotReject(() => initTelemetry());
      },
    ),
  ));

test('initTelemetry registers a NodeTracerProvider when an OTLP endpoint is configured', async () =>
  // `registered` is a private module-level flag, set true by any prior call (including the
  // no-op test above) — reset it so this test always exercises the "configured" branch
  // regardless of test order.
  withFreshState(_resetTelemetryForTests, () =>
    withEnvVars({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces' }, async () => {
      await assert.doesNotReject(() => initTelemetry());
      // Second call hits the `registered` short-circuit instead of re-running the dynamic imports.
      await assert.doesNotReject(() => initTelemetry());
    }),
  ));

test('initTelemetry also registers when only OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is configured', async () =>
  // The no-op guard is `!ENDPOINT && !TRACES_ENDPOINT`, so TRACES_ENDPOINT alone must still
  // short-circuit that `&&` to false and let registration proceed — a case the other two tests
  // (both unset, both set) never exercise.
  withFreshState(_resetTelemetryForTests, () =>
    withEnvVars(
      { OTEL_EXPORTER_OTLP_ENDPOINT: undefined, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:9/v1/traces' },
      async () => {
        await assert.doesNotReject(() => initTelemetry());
      },
    ),
  ));
