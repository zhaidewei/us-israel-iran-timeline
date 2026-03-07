'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

// ── Mock fetchPolymarketData before loading server.js ──────────────────────────
const polymarketPath = require.resolve('../lib/polymarket');
const MOCK_RESPONSE = { markets: [{ id: 'test', question: 'test?' }], lastUpdated: new Date().toISOString() };

require.cache[polymarketPath] = {
  id: polymarketPath,
  filename: polymarketPath,
  loaded: true,
  exports: { fetchPolymarketData: async () => MOCK_RESPONSE },
};

const { app, _resetPolymarketCooldown } = require('../server');

// ── Helpers ────────────────────────────────────────────────────────────────────

let server;

function getUrl(p) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}${p}`;
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get(getUrl(p), (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', resolve);
}));

after(() => new Promise((resolve) => {
  server.close(resolve);
}));

beforeEach(() => {
  _resetPolymarketCooldown();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

test('GET /api/polymarket returns cached data without external calls', async () => {
  const { status, body } = await httpGet('/api/polymarket');
  assert.equal(status, 200);
  assert.ok('markets' in body || 'lastUpdated' in body);
});

test('GET /api/polymarket/refresh first call succeeds with mock data', async () => {
  const { status, body } = await httpGet('/api/polymarket/refresh');
  assert.equal(status, 200);
  assert.deepEqual(body, MOCK_RESPONSE);
});

test('GET /api/polymarket/refresh second call within cooldown returns 429', async () => {
  await httpGet('/api/polymarket/refresh'); // burn the first call
  const { status, body } = await httpGet('/api/polymarket/refresh');
  assert.equal(status, 429);
  assert.ok(typeof body.error === 'string');
  assert.ok(body.error.includes('秒'));
});

test('GET /api/polymarket/refresh 429 response includes retry-after seconds', async () => {
  await httpGet('/api/polymarket/refresh');
  const { body } = await httpGet('/api/polymarket/refresh');
  // error message should mention a positive number of seconds
  const match = body.error.match(/(\d+)\s*秒/);
  assert.ok(match, `expected seconds in error message, got: ${body.error}`);
  const seconds = parseInt(match[1], 10);
  assert.ok(seconds > 0 && seconds <= 60);
});

test('GET /api/polymarket/refresh succeeds again after cooldown reset', async () => {
  await httpGet('/api/polymarket/refresh'); // first call
  _resetPolymarketCooldown();              // simulate cooldown expiry
  const { status } = await httpGet('/api/polymarket/refresh');
  assert.equal(status, 200);
});
