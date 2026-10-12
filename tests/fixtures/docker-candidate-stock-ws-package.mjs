// Test preparation only: Bun may hardlink its dependency cache on Linux.
// Copy bytes without loading ws; the unchanged production pin verifies the copy.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pinCandidateStockWebSocket } from "../../scripts/docker-candidate-stock-ws.mjs";

const files = [
  "package.json",
  "index.js",
  "wrapper.mjs",
  "browser.js",
  ...[
    "buffer-util",
    "constants",
    "event-target",
    "extension",
    "limiter",
    "permessage-deflate",
    "receiver",
    "sender",
    "stream",
    "subprotocol",
    "validation",
    "websocket-server",
    "websocket",
  ].map((name) => `lib/${name}.js`),
];
const refused = () => {
  throw new Error("Private ws test source copy refused");
};
function sourceBytes(path) {
  if (realpathSync(path) !== path) refused();
  const before = lstatSync(path);
  if (!before.isFile() || before.size > 1024 * 1024 || before.mode & 0o022) refused();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) refused();
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    for (const current of [fstatSync(fd), lstatSync(path)])
      if (
        !current.isFile() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs ||
        current.mode & 0o022
      )
        refused();
    if (used !== before.size || realpathSync(path) !== path) refused();
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}

export function createTestStockWebSocketPackage(sourceAnchor) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "candidate-private-ws-")));
  chmodSync(root, 0o700);
  try {
    const sourceRoot = dirname(
      realpathSync(createRequire(sourceAnchor).resolve("ws/package.json")),
    );
    const packageRoot = join(root, "node_modules/ws");
    mkdirSync(join(root, "node_modules"), { mode: 0o700 });
    mkdirSync(packageRoot, { mode: 0o700 });
    mkdirSync(join(packageRoot, "lib"), { mode: 0o700 });
    for (const file of files)
      writeFileSync(join(packageRoot, file), sourceBytes(join(sourceRoot, file)), {
        flag: "wx",
        mode: 0o600,
      });
    const anchor = join(root, "package.json");
    writeFileSync(anchor, '{"private":true}\n', { flag: "wx", mode: 0o600 });
    const pin = pinCandidateStockWebSocket(anchor);
    return { root, anchor, pin, dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    const cleanupErrors = [];
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (cleanup) {
      cleanupErrors.push(cleanup);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "Private ws test copy cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}
