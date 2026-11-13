import { createHash } from "node:crypto";
import type { Message } from "../types.js";
import { hasPromptPrefixObserver, notePromptPrefixRewrite } from "../utils/prompt-prefix-events.js";

/** Bounded, opt-in diagnostics; never retain instruction bodies. */
export class PromptPrefixHeads {
  private readonly hashes = new Map<string, string>();

  note(sessionId: string, message: Message | null): void {
    if (!hasPromptPrefixObserver()) {
      this.hashes.clear();
      return;
    }
    const hash = createHash("sha256")
      .update(message ? JSON.stringify(message.content) : "")
      .digest("hex");
    const previous = this.hashes.get(sessionId);
    if (previous !== undefined && previous !== hash) {
      notePromptPrefixRewrite(sessionId, "user_context_head");
    }
    this.hashes.delete(sessionId);
    this.hashes.set(sessionId, hash);
    if (this.hashes.size > 128) this.hashes.delete(this.hashes.keys().next().value!);
  }
}
