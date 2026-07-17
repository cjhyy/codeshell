import { describe, expect, test } from "bun:test";
import type { PetAttentionEvent, PetProjectionEvent } from "../../preload/types";
import {
  bufferPetAttentionEvent,
  bufferPetProjectionEvent,
  PET_ATTENTION_BUFFER_LIMIT,
  PET_PROJECTION_BUFFER_LIMIT,
  petSnapshotRetryDelay,
} from "./petReliability";

describe("Pet renderer reliability policy", () => {
  test("uses capped exponential snapshot retry delays", () => {
    expect([0, 1, 2, 3, 4, 20].map(petSnapshotRetryDelay)).toEqual([
      250, 500, 1_000, 2_000, 2_000, 2_000,
    ]);
  });

  test("keeps only the newest bounded projection events", () => {
    const buffer: PetProjectionEvent[] = [];
    for (let version = 1; version <= PET_PROJECTION_BUFFER_LIMIT + 10; version += 1) {
      bufferPetProjectionEvent(buffer, {
        kind: "reset",
        version,
        generation: 1,
        observedAt: version,
      });
    }

    expect(buffer).toHaveLength(PET_PROJECTION_BUFFER_LIMIT);
    expect(buffer[0]?.version).toBe(11);
    expect(buffer.at(-1)?.version).toBe(PET_PROJECTION_BUFFER_LIMIT + 10);
  });

  test("coalesces attention counts while bounding ordered peeks", () => {
    const buffer: PetAttentionEvent[] = [];
    for (let index = 0; index < PET_ATTENTION_BUFFER_LIMIT + 20; index += 1) {
      bufferPetAttentionEvent(buffer, {
        kind: "peek",
        peek: {
          id: `peek-${index}`,
          title: "Pending",
          detail: "Needs attention",
          receiptKeys: [`receipt-${index}`],
          action: { type: "open_pet_pending", count: 1 },
        },
      });
      bufferPetAttentionEvent(buffer, {
        kind: "count",
        surfaceablePendingCount: index,
      });
    }

    expect(buffer).toHaveLength(PET_ATTENTION_BUFFER_LIMIT);
    expect(buffer.filter((event) => event.kind === "count")).toEqual([
      { kind: "count", surfaceablePendingCount: PET_ATTENTION_BUFFER_LIMIT + 19 },
    ]);
    expect(buffer.at(-1)?.kind).toBe("count");
  });
});
