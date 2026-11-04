/** Print the CLI result and let Node drain stdout/stderr before natural exit. */
export function cliError(msg?: string): void {
  if (msg) console.error(msg);
  process.exitCode = 1;
}

export function cliOk(msg?: string): void {
  if (msg) process.stdout.write(msg + "\n");
  process.exitCode = 0;
}
