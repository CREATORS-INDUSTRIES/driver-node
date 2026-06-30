# @crtrs/driver

Node client for Driver. 

```sh
npm i @crtrs/driver
```

```js
const { Driver } = require('@crtrs/driver');

const driver = new Driver({ apiKey: 'dr_...' }); // or DRIVER_API_KEY

driver.on('action', (ev) => console.log(ev.tool));

const done = await driver.run('what is https://creators.industries about?');
console.log(done.result);
```

Events: `plan`, `plan_item_start`, `action`, `done`, `fatal`. Types in [`index.d.ts`](index.d.ts).

## Tools

Register local tools the agent can call. The agent runs in the cloud, but the
tool runs on your machine — when the agent needs it, the client runs your
function locally and sends the result back, then the run continues.

```js
const { Driver, defineTool } = require('@crtrs/driver');

const weather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  params: [
    { name: 'city', description: "city name, e.g. 'Barcelona'" },
    { name: 'units', type: 'string', description: "'celsius' or 'fahrenheit'" }, // type inferred when omitted
  ],
  call: (city = '', units = 'celsius') => fetchWeather(city, units),
});

const driver = new Driver({ tools: [weather] });
const done = await driver.run('what should I wear in Barcelona today?');
```

`params` order is the positional arg order passed to `call`; `type` is inferred
from the `call` signature when omitted. Subclass `Tool` instead of `defineTool`
for full control. See [`examples/tool.js`](examples/tool.js).

MIT
