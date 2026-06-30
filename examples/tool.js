'use strict';

// Manual example: register a local `get_weather` tool and let the agent call it.
//
// The agent runs in the cloud, but `get_weather` runs HERE on your machine.
// When the agent decides it needs weather, the cloud sends a `tool_request`; the
// client runs your function locally and POSTs the result back, then the run
// continues.
//
//   export DRIVER_API_KEY=dr_xxxxxxxx
//   node examples/tool.js "what should I wear in Barcelona today?"
//
// Optional:
//   export DRIVER_BASE_URL=https://driver.tors.app
//   export DRIVER_DEBUG=1   # dump raw events

const { Driver, defineTool } = require('..');

// A fake weather source. Swap the body for a real API call (fetch, axios, …);
// it runs locally, so it can use your network, keys, and secrets.
const FORECAST = {
  barcelona: [24, 'sunny'],
  london: [14, 'rainy'],
  oslo: [3, 'snowy'],
};

// Runs locally on tool_request. Positional args are spread in.
function getWeather(city = '', units = 'celsius') {
  const [tempC, sky] = FORECAST[city.trim().toLowerCase()] || [20, 'clear'];
  const temp = units === 'celsius' ? tempC : Math.round((tempC * 9) / 5 + 32);
  return { city, temp, units, conditions: sky };
}

async function main() {
  if (!process.env.DRIVER_API_KEY) {
    console.error('set DRIVER_API_KEY (dr_...) — get one from the dashboard');
    process.exit(2);
  }

  const prompt = process.argv.slice(2).join(' ') || 'what should I wear in Barcelona today?';

  const weather = defineTool({
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    params: [
      { name: 'city', description: "city name, e.g. 'Barcelona'" },
      { name: 'units', type: 'string', description: "'celsius' or 'fahrenheit'" },
    ],
    call: getWeather,
  });

  const driver = new Driver({ tools: [weather] }); // reads DRIVER_API_KEY / DRIVER_BASE_URL

  if (process.env.DRIVER_DEBUG) {
    driver.on('event', (ev) => console.error('RAW', JSON.stringify(ev)));
  }
  driver.on('plan', (ev) => {
    console.log('\n[plan]');
    (ev.items || []).forEach((it, i) => console.log(`  ${i + 1}. ${it}`));
  });
  driver.on('plan_item_start', (ev) => console.log(`\n[->] ${ev.num + 1}. ${ev.def}`));
  driver.on('action', (ev) => console.log(`  . ${ev.tool}${ev.is_network ? ' [net]' : ''}`));

  console.log(`prompt: ${prompt}`);

  try {
    const done = await driver.run(prompt);
    console.log(`\n[done] steps=${done.steps} errors=${done.errors}`);
    console.log('RESULT:', done.result);
  } catch (e) {
    console.error(`\nfatal: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nfailed:', e.message);
  process.exit(1);
});
