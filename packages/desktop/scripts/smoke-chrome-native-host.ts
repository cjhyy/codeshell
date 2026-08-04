import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ChromeNativeBridgeServer } from "../src/main/browser-runtime/chrome-native-server.js";
import {
  ChromeNativeMessageDecoder,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
  encodeChromeNativeMessage,
} from "../src/main/browser-runtime/chrome-native-protocol.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainEntry = path.join(root, "out", "main", "index.mjs");
if (!existsSync(mainEntry)) throw new Error("build:main must run before this smoke test");

const temporary = mkdtempSync(path.join(os.tmpdir(), "codeshell-native-host-smoke-"));
const statePath = path.join(temporary, "state.json");
const server = new ChromeNativeBridgeServer({
  statePath,
  onMessage: (message) => ({ echoedType: message.type, value: message.value }),
});
await server.start();

const packagedExecutable = process.env.CODESHELL_PACKAGED_EXECUTABLE?.trim();
const electron = packagedExecutable || (require("electron") as string);
const childArgs = packagedExecutable
  ? ["--codeshell-native-messaging-host", CODESHELL_CHROME_EXTENSION_ORIGIN]
  : [root, "--codeshell-native-messaging-host", CODESHELL_CHROME_EXTENSION_ORIGIN];
const child = spawn(
  electron,
  childArgs,
  {
    cwd: root,
    env: { ...process.env, CODESHELL_CHROME_NATIVE_STATE_PATH: statePath },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const decoder = new ChromeNativeMessageDecoder();
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`native host timed out: ${stderr}`)), 15_000);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`native host exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        const value = message as Record<string, unknown>;
        if (value.replyTo !== "smoke-1") continue;
        clearTimeout(timer);
        resolve(value);
      }
    });
    child.stdin.write(
      encodeChromeNativeMessage({ id: "smoke-1", type: "smoke.echo", value: "登录态" }),
    );
  });
  if (
    response.ok !== true ||
    (response.result as { echoedType?: unknown })?.echoedType !== "smoke.echo"
  ) {
    throw new Error(`unexpected native host response: ${JSON.stringify(response)}`);
  }
  process.stdout.write("Chrome native host smoke test passed\n");
} finally {
  child.kill();
  await server.stop();
  rmSync(temporary, { recursive: true, force: true });
}
