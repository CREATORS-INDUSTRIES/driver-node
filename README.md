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

MIT
