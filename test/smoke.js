'use strict';

// Smoke test: API surface + SSE parsing against a mock fetch (no network).

const assert = require('assert');
const { Driver } = require('..');

// 1. API surface.
assert.strictEqual(typeof Driver, 'function', 'Driver should be a class');
// Isolate env so an exported DRIVER_API_KEY doesn't mask the check.
delete process.env.DRIVER_API_KEY;
assert.throws(() => new Driver({}), /missing apiKey/, 'should require an apiKey');

// 2. SSE streaming against a mock fetch.
function mockBody(chunks) {
  const enc = new TextEncoder();
  return (async function* () {
    for (const c of chunks) yield enc.encode(c);
  })();
}

async function main() {
  const driver = new Driver({
    apiKey: 'dr_test',
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/api/driver/run'), 'should POST to /api/driver/run');
      assert.strictEqual(init.headers.Authorization, 'Bearer dr_test');
      assert.deepStrictEqual(JSON.parse(init.body), { prompt: 'hi' });
      return {
        ok: true,
        status: 200,
        body: mockBody([
          'data: {"kind":"plan","items":["a","b"]}\n\n',
          'data: {"kind":"step","def":"internal leak"}\n\n', // hidden kind: must be dropped
          'data: not-json should be dropped\n\n', // non-JSON: must be dropped
          'data: {"kind":"action",', // split mid-event across chunks
          '"tool":"http fetching","is_network":true}\n\ndata: {"kind":"done","result":"ok","steps":2,"errors":0}\n\n',
        ]),
      };
    },
  });

  const kinds = [];
  driver.on('event', (ev) => kinds.push(ev.kind));

  const done = await driver.run('hi');
  assert.deepStrictEqual(
    kinds,
    ['plan', 'action', 'done'],
    'only allowlisted kinds surface — hidden + non-JSON dropped',
  );
  assert.strictEqual(done.result, 'ok');
  assert.strictEqual(done.steps, 2);

  console.log('ok — @crtrs/driver smoke test passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
