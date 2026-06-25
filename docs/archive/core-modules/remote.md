# remote

**One-line role.** A client-side bridge that opens an SSH connection to a remote host, launches `code-shell` there in NDJSON stdio mode, and streams JSON messages in/out over the SSH pipe.

## 职责 / Responsibility

This module lets a local process drive a `code-shell` session running on a *different* machine. It spawns `ssh` (no PTY) to start the remote CLI in `--output stream-json` mode, then frames the conversation as newline-delimited JSON (NDJSON) over the SSH stdio channel: `send()` writes one JSON object per line, and `messages()` yields parsed JSON objects line-by-line. Its boundary is narrow — it owns only the SSH process lifecycle and the NDJSON framing. It does **not** know what the messages mean, manage auth beyond passing an identity file to `ssh`, or persist anything.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `bridge.ts` | The entire module: `BridgeConfig`/`SpawnFn` types, `buildSSHArgs()`, and the `RemoteBridge` class (connect / send / messages / disconnect). |
| `bridge.test.ts` | `bun:test` unit tests — argv-construction (no shell injection) and the `connect()` settle-once lifecycle (resolve on first stdout, no double-reject on later exit). |

## 公开接口 / Public API

```ts
export interface BridgeConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  remoteCommand?: string; // default: "code-shell run --output stream-json"
}

/** Injectable spawn (for tests). Defaults to child_process.spawn with piped stdio. */
export type SpawnFn = (command: string, args: string[]) => ChildProcess;

/** Builds the ssh argv: ["-T", "-p", port?, "-i", identityFile?, "user@host" | "host"]. */
export function buildSSHArgs(config: BridgeConfig): string[];

export class RemoteBridge {
  constructor(config: BridgeConfig, spawnFn?: SpawnFn);

  /** Spawn ssh + remote code-shell; resolves on first stdout byte (30s timeout). */
  connect(): Promise<void>;

  /** Write one JSON message + "\n" to the remote stdin. Throws "Not connected" if down. */
  send(message: Record<string, unknown>): void;

  /** Async iterator over parsed JSON lines from remote stdout (malformed lines skipped). */
  messages(): AsyncGenerator<Record<string, unknown>>;

  /** Kill the ssh process and mark disconnected. */
  disconnect(): void;

  get isConnected(): boolean;
}
```

## 怎么用 / How to use

Basic connect → stream → send loop (the real public surface exercised in `bridge.test.ts`):

```ts
import { RemoteBridge } from "./remote/bridge.js";

const bridge = new RemoteBridge({
  host: "build-box.internal",
  user: "ci",
  port: 2222,
  identityFile: "/home/me/.ssh/id_ed25519",
});

await bridge.connect(); // resolves on the remote's first stdout byte

// Consume remote events as parsed JSON objects.
(async () => {
  for await (const msg of bridge.messages()) {
    console.log("remote:", msg);
  }
})();

// Drive the remote session.
bridge.send({ type: "user", text: "run the tests" });

// ... when done
bridge.disconnect();
```

Injecting a fake `SpawnFn` for tests (no real `ssh` process), per `bridge.test.ts`:

```ts
import { RemoteBridge } from "./remote/bridge.js";

// child is an EventEmitter with PassThrough stdout/stdin/stderr + a kill() stub.
const bridge = new RemoteBridge({ host: "h" }, () => child as never);
const p = bridge.connect();
child.stdout.write("hello\n"); // first stdout byte -> connect() resolves
await p;
expect(bridge.isConnected).toBe(true);
```

## 注意 / Gotchas

- **ESM imports use the `.js` suffix.** Import `./bridge.js` (not `./bridge`) — the package is ESM and tests/consumers reference the compiled path.
- **Not wired into the core barrel yet.** As of this writing nothing re-exports `RemoteBridge` from `packages/core/src/index.ts` and there are no in-repo callers besides the test. Import it directly from `remote/bridge.js`; if you expose it to hosts, add the re-export yourself.
- **`connect()` settles exactly once.** It resolves on the *first* stdout byte, rejects on early `error`/`exit`, and rejects after a 30s timeout. Events after settlement are deliberately ignored — do not reintroduce a `if (!this.connected)` guard or re-reject on `exit` (that was the bug fixed in review-2026-05-30).
- **No PTY.** ssh is launched with `-T`; the remote command must work without an interactive terminal. The remote `code-shell` must understand `run --output stream-json`.
- **`send()` is fire-and-forget framing.** It throws only if not connected; a failed write (broken pipe) silently flips `isConnected` to `false` instead of throwing — poll `isConnected` if you need to detect remote death between sends.
- **`messages()` skips malformed lines and uses `crlfDelay: Infinity`.** Non-JSON / blank lines are dropped silently, so partial or noisy remote output won't crash the iterator. Breaking out of the `for await` closes the readline interface (no listener leak), but the ssh process stays alive until you call `disconnect()`.
- **No local command-injection surface.** `buildSSHArgs` returns discrete argv tokens and ssh is spawned without a shell, so `identityFile`/`port`/`host` (even with spaces) are never shell-interpreted. Keep it that way — don't join args into a shell string.
