'use strict';

// Smoke test: API surface + SSE parsing against a mock fetch (no network).

const assert = require('assert');
const { Driver, defineTool, Tool } = require('..');

// 1. API surface.
assert.strictEqual(typeof Driver, 'function', 'Driver should be a class');
assert.strictEqual(typeof defineTool, 'function', 'defineTool should be exported');
assert.strictEqual(typeof Tool, 'function', 'Tool should be exported');
// Isolate env so an exported DRIVER_API_KEY doesn't mask the check.
delete process.env.DRIVER_API_KEY;
assert.throws(() => new Driver({}), /missing apiKey/, 'should require an apiKey');

// defineTool: catalog shape + local execution.
const echo = defineTool({
  name: 'echo',
  description: 'Echo back.',
  params: [{ name: 'msg', description: 'text' }],
  call: (msg = '') => `echo:${msg}`,
});
assert.deepStrictEqual(
  echo.toJSON(),
  { name: 'echo', description: 'Echo back.', params: [['msg', 'string']] },
  'tool serializes to catalog shape with inferred type',
);

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

  // 3. tool_request loop: cloud asks us to run a local tool; we POST the result.
  const weather = defineTool({
    name: 'get_weather',
    description: 'weather',
    params: [{ name: 'city', description: 'city' }],
    call: (city = '') => ({ city, temp: 24 }),
  });

  const posted = [];
  const toolDriver = new Driver({
    apiKey: 'dr_test',
    tools: [weather],
    fetch: async (url, init) => {
      // The result POST hits /run/{runId}/result — capture and ack it.
      if (url.endsWith('/result')) {
        posted.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, body: mockBody(['']) };
      }
      // Tools serialize to catalog shape in the request body.
      assert.deepStrictEqual(JSON.parse(init.body).tools, [
        { name: 'get_weather', description: 'weather', params: [['city', 'string']] },
      ]);
      return {
        ok: true,
        status: 200,
        body: mockBody([
          'data: {"kind":"run","run_id":"r1"}\n\n',
          'data: {"kind":"tool_request","call_id":"c1","tool":"get_weather","args":["Barcelona"]}\n\n',
          'data: {"kind":"tool_request","call_id":"c2","tool":"nope","args":[]}\n\n',
          'data: {"kind":"done","result":"sunny","steps":1,"errors":0}\n\n',
        ]),
      };
    },
  });

  const toolKinds = [];
  toolDriver.on('event', (ev) => toolKinds.push(ev.kind));
  const toolDone = await toolDriver.run('weather?');

  assert.deepStrictEqual(toolKinds, ['done'], 'run/tool_request are internal — never surfaced');
  assert.strictEqual(toolDone.result, 'sunny');
  assert.strictEqual(posted.length, 2, 'one result POST per tool_request');
  assert.ok(posted[0].url.endsWith('/api/driver/run/r1/result'), 'POSTs to /run/{id}/result');
  assert.deepStrictEqual(posted[0].body, { call_id: 'c1', result: { city: 'Barcelona', temp: 24 } });
  assert.deepStrictEqual(posted[1].body, { call_id: 'c2', error: 'unknown tool: nope' });

  console.log('ok — @crtrs/driver smoke test passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
