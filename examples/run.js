'use strict';

// Manual example: run a real prompt against Driver cloud and print events live.
//
//   export DRIVER_API_KEY=dr_xxxxxxxx
//   node examples/run.js "what is https://ycombinator.com about?"
//
// Optional:
//   export DRIVER_BASE_URL=https://driver.tors.app

const { Driver } = require('..');

async function main() {
  if (!process.env.DRIVER_API_KEY) {
    console.error('set DRIVER_API_KEY (dr_...) — get one from the dashboard');
    process.exit(2);
  }

  const prompt = process.argv.slice(2).join(' ') || 'what is https://ycombinator.com about?';
  const driver = new Driver(); // reads DRIVER_API_KEY / DRIVER_BASE_URL from env

  // DRIVER_DEBUG=1 dumps every raw event so we can see the real wire fields.
  if (process.env.DRIVER_DEBUG) {
    driver.on('event', (ev) => console.error('RAW', JSON.stringify(ev)));
  }

  driver.on('plan', (ev) => {
    console.log('\n[plan]');
    (ev.items || []).forEach((it, i) => console.log(`  ${i + 1}. ${it}`));
  });
  driver.on('plan_item_start', (ev) => console.log(`\n[->] ${ev.num + 1}. ${ev.def}`));
  driver.on('action', (ev) => {
    console.log(`  . ${ev.tool}${ev.is_network ? ' [net]' : ''}`);
  });

  console.log(`prompt: ${prompt}`);

  try {
    const done = await driver.run(prompt);
    console.log(`\n[done] steps=${done.steps} errors=${done.errors}`);
    console.log('RESULT:', done.result);
    if (done.data && done.data.length) {
      console.log('\n[data]');
      done.data.forEach((d) => console.log(`  ${d.var} (${d.label}): ${d.value.length} chars`));
    }
  } catch (e) {
    // `fatal` rejects run() with the error category as the message.
    console.error(`\nfatal: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nfailed:', e.message);
  process.exit(1);
});
