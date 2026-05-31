/**
 * Read a piped prompt from stdin for headless `run`.
 *
 * Mirrors codex's `RequiredIfPiped`: when the user omits the positional
 * <task> AND stdin is not a TTY (i.e. something is piped in), the prompt is
 * read from stdin. On an interactive terminal with no task we must NOT block
 * waiting on stdin — the caller surfaces a usage error instead.
 */

import type { Readable } from "node:stream";

/** Read all of `stream` as a UTF-8 string. */
export async function readAllStdin(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Resolve the task prompt: prefer the positional arg; otherwise, if stdin is
 * piped, read it. Returns undefined when there is no task and stdin is a TTY
 * (interactive) so the caller can show a usage error rather than hang.
 */
export async function resolveTaskFromArgOrStdin(
  taskArg: string | undefined,
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<string | undefined> {
  if (taskArg && taskArg.trim().length > 0) return taskArg;
  if (stdin.isTTY) return undefined;
  const piped = (await readAllStdin(stdin)).trim();
  return piped.length > 0 ? piped : undefined;
}
