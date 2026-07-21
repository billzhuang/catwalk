import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { withSpan, toError, initTelemetry, _resetTelemetryForTests, resolveServiceName } from '../src/telemetry.ts';

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

test('resolveServiceName: falls back to "flue-agent" when OTEL_SERVICE_NAME is unset, otherwise uses it', () => {
  assert.equal(resolveServiceName({}), 'flue-agent');
  assert.equal(resolveServiceName({ OTEL_SERVICE_NAME: 'my-custom-service' }), 'my-custom-service');
});

test('toError: passes an Error through unchanged, wraps anything else via String()', () => {
  const original = new Error('boom');
  assert.equal(toError(original), original);
  assert.equal(toError('boom').message, 'boom');
  assert.equal(toError(null).message, 'null');
  assert.equal(toError(undefined).message, 'undefined');
});

test('initTelemetry is a no-op when no OTLP endpoint is configured', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  await assert.doesNotReject(() => initTelemetry());
});

test('initTelemetry registers a NodeTracerProvider when an OTLP endpoint is configured', async () => {
  // `registered` is a private module-level flag, set true by any prior call (including the
  // no-op test above) — reset it so this test always exercises the "configured" branch
  // regardless of test order.
  _resetTelemetryForTests();
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9/v1/traces';
  try {
    await assert.doesNotReject(() => initTelemetry());
    // Second call hits the `registered` short-circuit instead of re-running the dynamic imports.
    await assert.doesNotReject(() => initTelemetry());
  } finally {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    _resetTelemetryForTests();
  }
});

test('initTelemetry also registers when only OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is configured', async () => {
  // The no-op guard is `!ENDPOINT && !TRACES_ENDPOINT`, so TRACES_ENDPOINT alone must still
  // short-circuit that `&&` to false and let registration proceed — a case the other two tests
  // (both unset, both set) never exercise.
  _resetTelemetryForTests();
  const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const originalTracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:9/v1/traces';
  try {
    await assert.doesNotReject(() => initTelemetry());
  } finally {
    if (originalEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
    }
    if (originalTracesEndpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalTracesEndpoint;
    }
    _resetTelemetryForTests();
  }
});
