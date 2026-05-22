/**
 * Dev-only synthetic transcript seeder. Active when
 * `CODESHELL_DEV_SEED_TRANSCRIPT=<count>` is set. No-op otherwise.
 *
 * Called once during UI boot (src/ui/index.tsx) before the first render.
 */
import { chatStore, createEntry, type ChatEntry } from "./store.js";

export function applyDevSeed(): void {
  const raw = process.env.CODESHELL_DEV_SEED_TRANSCRIPT;
  if (!raw) return;
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return;

  const entries: ChatEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      entries.push(createEntry({ type: "user", text: `[seed ${i}] ${"lorem ipsum ".repeat(((i * 7) % 5) + 1)}` }));
    } else {
      entries.push(createEntry({
        type: "assistant_text",
        text: `[seed ${i}] ${"lorem ipsum ".repeat(((i * 7) % 5) + 1)}`,
        streaming: false,
      }));
    }
  }
  chatStore.setEntries(entries);
}
