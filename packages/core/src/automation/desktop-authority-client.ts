import type { RpcMessage } from "../protocol/types.js";
import type { Transport } from "../protocol/transport.js";
import type { CronCreateAuthority, CronCreateAuthorityInput } from "../tool-system/builtin/cron.js";
import type { CronJob } from "./scheduler.js";

const DESKTOP_AUTOMATION_CREATE_METHOD = "desktop/automationCreate";

/**
 * Worker-side request client. Desktop uses it to keep CronCreate out of the
 * shared store until Main has resolved project/root and resume authority.
 */
export function createDesktopAutomationAuthorityClient(
  transport: Pick<Transport, "send" | "onMessage">,
): CronCreateAuthority {
  let nextId = 1;
  const pending = new Map<
    string,
    {
      resolve: (job: CronJob) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  transport.onMessage((message: RpcMessage) => {
    if (!message || typeof message !== "object" || !("id" in message) || "method" in message) {
      return;
    }
    const id = String(message.id);
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    if ("error" in message && message.error) {
      waiter.reject(new Error(message.error.message));
      return;
    }
    const job = message.result as CronJob | undefined;
    if (!job || typeof job.id !== "string" || typeof job.name !== "string") {
      waiter.reject(new Error("Desktop Main returned an invalid automation job"));
      return;
    }
    waiter.resolve(job);
  });

  return (input: CronCreateAuthorityInput) => {
    const id = `automation-authority-${nextId++}`;
    return new Promise<CronJob>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Desktop Main automation authority timed out"));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      transport.send({
        jsonrpc: "2.0",
        id,
        method: DESKTOP_AUTOMATION_CREATE_METHOD,
        params: input as unknown as Record<string, unknown>,
      });
    });
  };
}

export { DESKTOP_AUTOMATION_CREATE_METHOD };
