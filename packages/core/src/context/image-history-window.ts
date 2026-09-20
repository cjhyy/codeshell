import type { ContentBlock, Message } from "../types.js";
import { collectBase64Images, downgradeImagePayloadsInHistory } from "./compaction.js";

/** Limits apply to retained history; fresh input always gets its first request. */
export const IMAGE_HISTORY_WINDOW = {
  modelResponses: 6,
  maxImages: 4,
  maxEncodedBytes: 8 * 1024 * 1024,
} as const;

interface RetainedImage {
  remaining: number;
  fresh: boolean;
  bytes: number;
}

/** Run-local pixel retention. Transcript bytes remain available for explicit reload. */
export class ImageHistoryWindow {
  private readonly images = new Map<ContentBlock, RetainedImage>();

  track(message: Message): void {
    for (const { block } of collectBase64Images([message])) {
      if (this.images.has(block)) continue;
      const openAI = block as unknown as { image_url?: { url?: string } };
      this.images.set(block, {
        remaining: IMAGE_HISTORY_WINDOW.modelResponses,
        fresh: true,
        bytes: block.source?.data?.length ?? openAI.image_url?.url?.length ?? 0,
      });
    }
  }

  get hasFreshImages(): boolean {
    return [...this.images.values()].some((entry) => entry.fresh);
  }

  prepare(messages: Message[]): ReturnType<typeof downgradeImagePayloadsInHistory> {
    const live = new Map<ContentBlock, number>();
    for (const { block } of collectBase64Images(messages)) {
      live.set(block, (live.get(block) ?? 0) + 1);
    }
    for (const [block, entry] of this.images) {
      if (!live.has(block) || entry.remaining <= 0) this.images.delete(block);
    }

    const preserveImages = new Set<ContentBlock>();
    let imageCount = 0;
    let bytes = 0;
    // Never silently discard an unseen attachment, even when a fresh batch
    // exceeds the history cap. It competes for retention after its first response.
    for (const [block, entry] of this.images) {
      if (!entry.fresh) continue;
      preserveImages.add(block);
      imageCount += live.get(block)!;
      bytes += entry.bytes * live.get(block)!;
    }
    for (const [block, entry] of [...this.images].reverse()) {
      if (entry.fresh) continue;
      const occurrences = live.get(block)!;
      const encodedBytes = entry.bytes * occurrences;
      if (
        imageCount + occurrences <= IMAGE_HISTORY_WINDOW.maxImages &&
        bytes + encodedBytes <= IMAGE_HISTORY_WINDOW.maxEncodedBytes
      ) {
        preserveImages.add(block);
        imageCount += occurrences;
        bytes += encodedBytes;
      } else {
        this.images.delete(block);
      }
    }
    return downgradeImagePayloadsInHistory(messages, { preserveImages });
  }

  /** Only successful responses consume a window slot; retries do not age pixels. */
  consume(messages: Message[]): Message[] {
    const sent = new Set(collectBase64Images(messages).map(({ block }) => block));
    for (const block of sent) {
      const entry = this.images.get(block);
      if (!entry) continue;
      entry.fresh = false;
      entry.remaining--;
    }
    return this.prepare(messages).messages;
  }
}
