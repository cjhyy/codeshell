import type { HostedMimiProjection } from "./mimi-projection.js";
import type { BusinessMethods } from "./business-calls.js";
import { MimiAttentionTracker } from "./mimi-attention-tracker.js";
import type {
  AttentionReceiptWrite,
  MimiAttentionOperations,
  PetAttentionEvent,
} from "../../shared/mimi-attention.js";

export function hostedMimiAttention(
  projection: Pick<HostedMimiProjection, "state" | "start">,
  write: (call: AttentionReceiptWrite, permit: Int32Array) => Promise<string[]>,
  emit: (event: PetAttentionEvent) => void,
  report: (error: unknown) => void,
) {
  let revision = -1;
  const background = new Set<Int32Array>();
  const tracker = new MimiAttentionTracker({
    source: projection.state,
    report,
    async claim(rows) {
      const permit = new Int32Array(new SharedArrayBuffer(4));
      background.add(permit);
      try {
        return await write({ type: "claim", rows }, permit);
      } finally {
        background.delete(permit);
      }
    },
  });
  const off = tracker.subscribe(emit);
  function setActive({ active, revision: next }: { active: string | null; revision: number }) {
    if (
      (active !== null && (typeof active !== "string" || active.length > 4_096)) ||
      !Number.isSafeInteger(next) ||
      next < 0
    )
      throw Error("Invalid Mimi active session");
    if (next < revision) return;
    revision = next;
    tracker.setActiveSession(active);
  }
  const methods = {
    "mimi/attentionStart": async (input, grant) => {
      await projection.start();
      grant.assertCurrent();
      setActive(input);
      tracker.start();
      return tracker.getSnapshot();
    },
    "mimi/attentionSnapshot": async (_input, grant) => {
      await projection.start();
      grant.assertCurrent();
      return tracker.getSnapshot();
    },
    "mimi/attentionActive": (input, grant) => {
      grant.assertCurrent();
      setActive(input);
    },
    "mimi/attentionMark": async ({ keys, state }, grant) => {
      if (
        !Array.isArray(keys) ||
        keys.length > 1_000 ||
        (state !== "seen" && state !== "dismissed")
      )
        throw Error("Invalid Mimi attention receipts");
      await write({ type: "mark", rows: keys.map((key) => ({ key, state })) }, grant.permit);
      tracker.markAcknowledged(keys);
    },
  } satisfies Pick<BusinessMethods, keyof MimiAttentionOperations>;
  return {
    methods,
    close() {
      off();
      tracker.stop();
      for (const permit of background) Atomics.compareExchange(permit, 0, 0, -1);
    },
  };
}
