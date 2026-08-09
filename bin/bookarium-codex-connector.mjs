#!/usr/bin/env node

import { runCli } from '../src/cli.mjs';

try {
  process.exitCode = await runCli();
} catch (error) {
  const message = error instanceof Error ? error.message : 'The connector failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
