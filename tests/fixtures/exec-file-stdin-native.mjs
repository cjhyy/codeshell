import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileNoThrow } from "../../packages/core/src/utils/execFileNoThrow.ts";

// Report only after EOF, and hash every received byte so closing the pipe early
// cannot make the empty-input regression pass while truncating nonempty input.
const reader = `
  const { createHash } = require('node:crypto');
  const digest = createHash('sha256');
  let bytes = 0;
  process.stdin.on('data', chunk => { bytes += chunk.length; digest.update(chunk); });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ bytes, sha256: digest.digest('hex') }));
  });
`;

for (const input of ["", "stdin 中文 😀\n".repeat(64 * 1024)]) {
  const result = await execFileNoThrow(process.execPath, ["-e", reader], {
    input,
    timeout: 2000,
  });
  assert.deepEqual(result, {
    code: 0,
    stdout: JSON.stringify({
      bytes: Buffer.byteLength(input),
      sha256: createHash("sha256").update(input).digest("hex"),
    }),
    stderr: "",
  });
}
console.log(JSON.stringify({ ok: true, inputs: 2 }));
