import { randomBytes } from "node:crypto";
import type { ChannelAdapter } from "./channel.js";
import { ChatGateway, createAllowlistMiddleware, type ChatAllowlistRule } from "./chat-gateway.js";

export interface PlatformCanaryOptions {
  adapters: ChannelAdapter[];
  allowlists: Readonly<Record<string, ChatAllowlistRule>>;
  webhook?: ConstructorParameters<typeof ChatGateway>[0]["webhook"];
  delivery?: ConstructorParameters<typeof ChatGateway>[0]["delivery"];
  timeoutMs?: number;
  nonce?: string;
  onReady?: (instruction: string) => void;
}

export interface PlatformCanaryResult {
  nonce: string;
  channels: string[];
  completedAt: number;
}

/**
 * Credential-backed canary: starts the real adapters and ingress, then waits
 * for one allowlisted inbound `/canary <nonce>` per configured channel and
 * replies through that same platform. Nothing is sent to users unprompted.
 */
export async function runPlatformCanary(
  options: PlatformCanaryOptions,
): Promise<PlatformCanaryResult> {
  if (options.adapters.length === 0) throw new Error("canary requires at least one adapter");
  const expected = new Set(options.adapters.map(({ channel }) => channel));
  const completed = new Set<string>();
  const nonce = options.nonce ?? randomBytes(6).toString("hex");
  const command = `/canary ${nonce}`;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const abort = new AbortController();
  let resolveComplete!: () => void;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const gateway = new ChatGateway({
    adapters: options.adapters,
    webhook: options.webhook,
    delivery: options.delivery,
  });
  gateway.use(createAllowlistMiddleware(options.allowlists));
  gateway.use(async ({ message, reply }) => {
    if (message.text.trim() !== command) return;
    await reply({ text: `✅ CodeShell ${message.channel} canary passed (${nonce})` });
    completed.add(message.channel);
    if ([...expected].every((channel) => completed.has(channel))) resolveComplete();
  });

  options.onReady?.(
    `请在以下 channel 的白名单会话中各发送一次：${command}\n${[...expected].join(", ")}`,
  );
  const gatewayTask = gateway.run(abort.signal);
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    await Promise.race([
      complete,
      gatewayTask.then(() => {
        throw new Error("platform canary gateway exited before completion");
      }),
      new Promise<never>((_resolve, reject) =>
        abort.signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error(
                `platform canary timed out; missing: ${[...expected]
                  .filter((channel) => !completed.has(channel))
                  .join(", ")}`,
              ),
            ),
          { once: true },
        ),
      ),
    ]);
    return { nonce, channels: [...completed].sort(), completedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    abort.abort();
    await gatewayTask.catch(() => undefined);
  }
}
