export interface FrozenRoomPage {
  snapshotId: string;
  throughSeq: number;
  messages: unknown[];
  nextCursor?: string;
  complete: boolean;
}

/** Validate the whole frozen range before committing it to the conversation. */
export class RoomHistoryAccumulator {
  private snapshotId?: string;
  private throughSeq?: number;
  private nextSeq: number;
  private readonly cursors = new Set<string>();
  readonly messages: unknown[] = [];

  constructor(sinceSeq: number) {
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new Error("invalid room sequence");
    this.nextSeq = sinceSeq + 1;
  }

  accept(page: FrozenRoomPage): string | undefined {
    if (
      !page ||
      typeof page.snapshotId !== "string" ||
      !page.snapshotId ||
      !Number.isSafeInteger(page.throughSeq) ||
      page.throughSeq < this.nextSeq - 1 ||
      typeof page.complete !== "boolean" ||
      !Array.isArray(page.messages) ||
      (this.snapshotId !== undefined &&
        (this.snapshotId !== page.snapshotId || this.throughSeq !== page.throughSeq))
    ) {
      throw new Error("room history snapshot boundary changed");
    }
    this.snapshotId = page.snapshotId;
    this.throughSeq = page.throughSeq;
    for (const message of page.messages) {
      const seq = (message as { seq?: unknown } | null)?.seq;
      if (seq !== this.nextSeq || this.nextSeq > page.throughSeq)
        throw new Error("room history has a sequence gap");
      this.nextSeq++;
      this.messages.push(message);
      // The server can paginate larger archives. This view must fail visibly
      // instead of silently rendering only a tail or allocating without bound.
      if (this.messages.length > 50_000)
        throw new Error("room history exceeds the conversation view limit");
    }
    if (page.complete) {
      if (page.nextCursor !== undefined || this.nextSeq - 1 !== page.throughSeq)
        throw new Error("room history is incomplete");
      return undefined;
    }
    if (!page.messages.length || !page.nextCursor || this.cursors.has(page.nextCursor))
      throw new Error("room history pagination did not advance");
    this.cursors.add(page.nextCursor);
    return page.nextCursor;
  }
}

export async function collectRoomHistory(
  fetchPage: (request: {
    sinceSeq?: number;
    cursor?: string;
    limit?: number;
  }) => Promise<FrozenRoomPage>,
  sinceSeq: number,
): Promise<unknown[]> {
  const accumulator = new RoomHistoryAccumulator(sinceSeq);
  let request: { sinceSeq?: number; cursor?: string; limit?: number } = { sinceSeq, limit: 200 };
  for (;;) {
    const cursor = accumulator.accept(await fetchPage(request));
    if (!cursor) return accumulator.messages;
    request = { cursor, limit: 200 };
  }
}
