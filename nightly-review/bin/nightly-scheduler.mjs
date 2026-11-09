#!/usr/bin/env node
import { createScheduler, parseSchedulerArgs } from '../lib/scheduler.mjs';

try {
  const options = parseSchedulerArgs(process.argv.slice(2));
  const result = createScheduler()(options);
  if (options.json) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`nightly-scheduler: ${error.message}`);
  process.exitCode = 2;
}
