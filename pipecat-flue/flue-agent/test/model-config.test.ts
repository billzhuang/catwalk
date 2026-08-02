import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, resolveThinkingLevel, resolvePort, resolveProxyBase, azureProviderConfig } from '../src/model-config.ts';

test('resolveModel: defaults to azure/gpt-5.4 when unset', () => {
  assert.equal(resolveModel({}), 'azure/gpt-5.4');
});

test('resolveModel: honors FLUE_MODEL override (e.g. an existing DeepSeek deployment)', () => {
  assert.equal(resolveModel({ FLUE_MODEL: 'azure/DeepSeek-R1' }), 'azure/DeepSeek-R1');
});

test('resolveModel: blank override falls back to the default', () => {
  assert.equal(resolveModel({ FLUE_MODEL: '  ' }), 'azure/gpt-5.4');
});

test('resolveThinkingLevel: defaults to low when unset', () => {
  assert.equal(resolveThinkingLevel({}), 'low');
});

test('resolveThinkingLevel: honors a valid override, case-insensitively', () => {
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'HIGH' }), 'high');
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'off' }), 'off');
});

test('resolveThinkingLevel: falls back to the default on an unrecognized value', () => {
  assert.equal(resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'ludicrous' }), 'low');
});

test('resolveThinkingLevel: warns with the bad value, valid options, and fallback on an unrecognized value', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'ludicrous' });
  assert.equal(warnMock.mock.callCount(), 1);
  const [message] = warnMock.mock.calls[0].arguments;
  assert.match(message, /FLUE_THINKING_LEVEL=ludicrous is not a recognized thinking level/);
  assert.match(message, /off, minimal, low, medium, high, xhigh, max/);
  assert.match(message, /falling back to low/);
});

test('resolveThinkingLevel: does not warn on a valid override', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolveThinkingLevel({ FLUE_THINKING_LEVEL: 'high' });
  assert.equal(warnMock.mock.callCount(), 0);
});

test('resolvePort: defaults to 3583 when unset', () => {
  assert.equal(resolvePort({}), 3583);
});

test('resolvePort: honors PORT', () => {
  assert.equal(resolvePort({ PORT: '4000' }), 4000);
});

test('resolvePort: falls back to FLUE_PORT when PORT is unset', () => {
  assert.equal(resolvePort({ FLUE_PORT: '5000' }), 5000);
});

test('resolvePort: PORT takes precedence over FLUE_PORT', () => {
  assert.equal(resolvePort({ PORT: '4000', FLUE_PORT: '5000' }), 4000);
});

test('resolvePort: a blank PORT does not shadow a set FLUE_PORT', () => {
  assert.equal(resolvePort({ PORT: '', FLUE_PORT: '5000' }), 5000);
  assert.equal(resolvePort({ PORT: '   ', FLUE_PORT: '5000' }), 5000);
});

test('resolvePort: falls back to the default when both PORT and FLUE_PORT are blank', () => {
  assert.equal(resolvePort({ PORT: '', FLUE_PORT: '' }), 3583);
  assert.equal(resolvePort({ PORT: '   ', FLUE_PORT: '   ' }), 3583);
  assert.equal(resolvePort({ FLUE_PORT: '   ' }), 3583);
});

test('resolvePort: falls back to the default on a non-numeric value instead of NaN', () => {
  assert.equal(resolvePort({ PORT: 'not-a-number' }), 3583);
});

test('resolvePort: falls back to the default on zero or a negative value', () => {
  assert.equal(resolvePort({ PORT: '0' }), 3583);
  assert.equal(resolvePort({ PORT: '-1' }), 3583);
});

test('resolvePort: falls back to the default on a value above the valid TCP port range', () => {
  assert.equal(resolvePort({ PORT: '65536' }), 3583);
  assert.equal(resolvePort({ PORT: '99999' }), 3583);
});

test('resolvePort: honors the maximum valid TCP port', () => {
  assert.equal(resolvePort({ PORT: '65535' }), 65535);
});

test('resolvePort: warns with the bad value and fallback on an invalid value', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolvePort({ PORT: 'not-a-number' });
  assert.equal(warnMock.mock.callCount(), 1);
  const [message] = warnMock.mock.calls[0].arguments;
  assert.match(message, /PORT\/FLUE_PORT=not-a-number is not a valid port number/);
  assert.match(message, /falling back to 3583/);
});

test('resolvePort: does not warn on a valid override', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  resolvePort({ PORT: '4000' });
  assert.equal(warnMock.mock.callCount(), 0);
});

test('resolveProxyBase: defaults to loopback with the resolved port', () => {
  assert.equal(resolveProxyBase({}), 'http://127.0.0.1:3583/az/v1');
  assert.equal(resolveProxyBase({ PORT: '4000' }), 'http://127.0.0.1:4000/az/v1');
});

test('resolveProxyBase: honors AZURE_PROXY_BASE override', () => {
  assert.equal(
    resolveProxyBase({ AZURE_PROXY_BASE: 'http://example.internal/az/v1' }),
    'http://example.internal/az/v1',
  );
});

test('resolveProxyBase: falls back to the default port, not NaN, when PORT is invalid', () => {
  assert.equal(resolveProxyBase({ PORT: 'not-a-number' }), 'http://127.0.0.1:3583/az/v1');
});

test('resolveProxyBase: treats a blank AZURE_PROXY_BASE as unset', () => {
  assert.equal(resolveProxyBase({ AZURE_PROXY_BASE: '' }), 'http://127.0.0.1:3583/az/v1');
  assert.equal(resolveProxyBase({ AZURE_PROXY_BASE: '   ' }), 'http://127.0.0.1:3583/az/v1');
});

test('resolveProxyBase: trims whitespace around a real override', () => {
  assert.equal(
    resolveProxyBase({ AZURE_PROXY_BASE: '  http://example.internal/az/v1  ' }),
    'http://example.internal/az/v1',
  );
});

test('resolveProxyBase: does not warn about an irrelevant invalid PORT when AZURE_PROXY_BASE overrides it', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  assert.equal(
    resolveProxyBase({ AZURE_PROXY_BASE: 'http://example.internal/az/v1', PORT: 'not-a-number' }),
    'http://example.internal/az/v1',
  );
  assert.equal(warnMock.mock.callCount(), 0);
});

test('azureProviderConfig: scopes gpt-5.4 specs to that model, not the whole provider', () => {
  const config = azureProviderConfig('http://127.0.0.1:3583/az/v1');
  // A provider-wide default here would silently apply gpt-5.4's window/output-cap to any other
  // model FLUE_MODEL resolves through this same 'azure' registration (e.g. a DeepSeek deployment).
  assert.equal(config.contextWindow, undefined);
  assert.equal(config.maxTokens, undefined);
  assert.deepEqual(config.models, { 'gpt-5.4': { contextWindow: 272_000, maxTokens: 8_192 } });
});

test('azureProviderConfig: still wires baseUrl/api/apiKey unchanged', () => {
  const config = azureProviderConfig('http://example.internal/az/v1');
  assert.equal(config.baseUrl, 'http://example.internal/az/v1');
  assert.equal(config.api, 'openai-completions');
  assert.equal(config.apiKey, 'via-proxy');
});
