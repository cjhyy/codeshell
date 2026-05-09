#!/usr/bin/env node
const REQUIRED_MAJOR = 20;
const REQUIRED_MINOR = 10;

const [major, minor] = process.versions.node.split('.').map(Number);

if (major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR)) {
  const red = (s) => `\x1b[31m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  console.error('');
  console.error(red(bold('✖ @cjhyy/code-shell requires Node.js >= 20.10')));
  console.error(`  current: ${process.versions.node}`);
  console.error('');
  console.error('  Some dependencies use ESM import attributes (`with { type: "json" }`),');
  console.error('  which Node 16/18 do not support.');
  console.error('');
  console.error('  Fix: install Node 20.10+ (or 22 LTS) via nvm:');
  console.error('    nvm install 22 && nvm use 22');
  console.error('');
  process.exit(1);
}
