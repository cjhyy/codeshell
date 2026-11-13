import type { ContentBlock, Message } from "../types.js";
import { collectBase64Images, downgradeImagePayloadsInHistory } from "./compaction.js";

/**
 * Limits apply to retained history; fresh input always gets its first request.
 *
 * `modelResponses` is a soft limit: an image past it is only *eligible* for a
 * placeholder, and the replacement waits for the rewrite gate
 * (context/rewrite-gate.ts) because it rewrites an earlier message and so
 * breaks the provider's cached prefix from there. `maxImages` and
 * `maxEncodedBytes` are hard limits that keep requests within provider
 * bounds: exceeding them applies the whole pending batch immediately.
 */
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

/** Placeholder batch over a history; see ImageHistoryWindow.planBatch(). */
export interface ImageHistoryBatch {
  /** The history with every out-of-window image replaced. */
  messages: Message[];
  replacedCount: number;
  /** A hard bound is exceeded: the batch must be applied before the next request. */
  forced: boolean;
  /** Stop tracking the replaced images; call once the batch is adopted. */
  commit(): void;
}

function encodedBytes(block: ContentBlock): number {
  const openAI = block as unknown as { image_url?: { url?: string } };
  return block.source?.data?.length ?? openAI.image_url?.url?.length ?? 0;
}

/** Run-local pixel retention. Transcript bytes remain available for explicit reload. */
export class ImageHistoryWindow {
  private readonly images = new Map<ContentBlock, RetainedImage>();
  /**
   * Images already replaced in a request. They stay replaced even if a later
   * list (a compaction, a transcript replay) carries their bytes again.
   */
  private readonly dropped = new WeakSet<ContentBlock>();

  track(message: Message): void {
    for (const { block } of collectBase64Images([message])) {
      if (this.images.has(block)) continue;
      this.images.set(block, {
        remaining: IMAGE_HISTORY_WINDOW.modelResponses,
        fresh: true,
        bytes: encodedBytes(block),
      });
    }
  }

  get hasFreshImages(): boolean {
    return [...this.images.values()].some((entry) => entry.fresh);
  }

  /**
   * Plan the placeholder batch. An image is out of the window when it aged
   * past `modelResponses`, when it is not tracked by this run (it came from
   * earlier history the model has already seen), or when it no longer fits
   * the count/byte caps. Fresh images are never replaced.
   */
  planBatch(messages: Message[]): ImageHistoryBatch {
    const live = new Map<ContentBlock, number>();
    for (const { block } of collectBase64Images(messages)) {
      live.set(block, (live.get(block) ?? 0) + 1);
    }
    for (const block of this.images.keys()) {
      if (!live.has(block)) {
        this.images.delete(block);
        this.dropped.add(block);
      }
    }

    const preserve = new Set<ContentBlock>();
    let imageCount = 0;
    let bytes = 0;
    let forced = false;
    const fits = (block: ContentBlock): boolean => {
      const occurrences = live.get(block)!;
      const size = (this.images.get(block)?.bytes ?? encodedBytes(block)) * occurrences;
      if (
        imageCount + occurrences > IMAGE_HISTORY_WINDOW.maxImages ||
        bytes + size > IMAGE_HISTORY_WINDOW.maxEncodedBytes
      ) {
        return false;
      }
      imageCount += occurrences;
      bytes += size;
      return true;
    };

    // Never silently discard an unseen attachment, even when a fresh batch
    // exceeds the history cap. It competes for retention after its first response.
    const newestFirst = [...live.keys()].reverse();
    const inWindow: ContentBlock[] = [];
    const expired: ContentBlock[] = [];
    for (const block of newestFirst) {
      if (this.dropped.has(block)) continue;
      const entry = this.images.get(block);
      if (entry?.fresh) preserve.add(block);
      else if (entry && entry.remaining > 0) inWindow.push(block);
      else expired.push(block);
    }
    // Fresh images count against the caps even when they alone exceed them.
    for (const block of preserve) {
      const occurrences = live.get(block)!;
      imageCount += occurrences;
      bytes += (this.images.get(block)?.bytes ?? encodedBytes(block)) * occurrences;
    }
    for (const block of inWindow) {
      if (fits(block)) preserve.add(block);
      else forced = true;
    }
    // Expired images ride along until the batch is applied, but only while
    // they fit: a request must never exceed the caps to keep a cache warm.
    for (const block of expired) {
      if (!fits(block)) forced = true;
    }

    const result = downgradeImagePayloadsInHistory(messages, { preserveImages: preserve });
    const replaced = [...live.keys()].filter((block) => !preserve.has(block));
    return {
      messages: result.messages,
      replacedCount: result.replacedCount,
      forced,
      commit: () => {
        for (const block of replaced) {
          this.images.delete(block);
          this.dropped.add(block);
        }
      },
    };
  }

  /**
   * The history as the next request may carry it without consulting the
   * rewrite gate: images already replaced stay replaced, and a batch over a
   * hard cap is applied now. Deferrable replacements are left in place.
   */
  prepare(messages: Message[]): { messages: Message[]; replacedCount: number; forced: boolean } {
    const batch = this.planBatch(messages);
    if (batch.forced) {
      batch.commit();
      return { messages: batch.messages, replacedCount: batch.replacedCount, forced: true };
    }
    const required = downgradeImagePayloadsInHistory(messages, {
      preserveImages: new Set(
        collectBase64Images(messages)
          .map(({ block }) => block)
          .filter((block) => !this.dropped.has(block)),
      ),
    });
    return { messages: required.messages, replacedCount: required.replacedCount, forced: false };
  }

  /**
   * Age the images a successful response consumed. Only successful responses
   * consume a window slot; retries do not age pixels. Returns the history with
   * any batch the new ages force (see prepare()).
   */
  consume(messages: Message[]): { messages: Message[]; replacedCount: number; forced: boolean } {
    const sent = new Set(collectBase64Images(messages).map(({ block }) => block));
    for (const block of sent) {
      const entry = this.images.get(block);
      if (!entry) continue;
      entry.fresh = false;
      entry.remaining--;
    }
    return this.prepare(messages);
  }
}
