import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { withSpan, initTelemetry } from '../src/telemetry.ts';

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

test('initTelemetry is a no-op when no OTLP endpoint is configured', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  await assert.doesNotReject(() => initTelemetry());
});
