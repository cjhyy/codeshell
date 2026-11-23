import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_SEGMENT_IDLE_MS } from "@cjhyy/code-shell-pet";
import { PetWorkMemoryStore } from "../../main/pet/pet-work-memory-store.js";
import { PetSegmentController } from "../../main/pet/pet-segment-controller.js";
import type { MimiWorkCommand, MimiWorkSnapshot } from "../../shared/mimi-work-memory.js";

export class StoredMimiWorkMemory {
  private readonly epoch = randomUUID();
  private readonly store: PetWorkMemoryStore;
  private controller?: { id: string; value: PetSegmentController };
  private tail: Promise<unknown>;
  private revision = 0;

  constructor(directory: string) {
    this.store = new PetWorkMemoryStore(join(directory, "work-memory.json"));
    this.tail = this.store.load();
  }

  run(command: MimiWorkCommand): Promise<MimiWorkSnapshot> {
    const result = this.tail.then(async () => {
      let turn: MimiWorkSnapshot["turn"];
      if (command.type !== "snapshot") {
        if (!this.controller) {
          this.controller = {
            id: command.sessionId,
            value: new PetSegmentController({
              store: this.store,
              petSessionId: command.sessionId,
              now: Date.now,
              idleMs: DEFAULT_SEGMENT_IDLE_MS,
              archiveRange: async () => {
                throw Error("Mimi transcript archival requires the native session adapter");
              },
            }),
          };
        }
        if (this.controller.id !== command.sessionId)
          throw Error("Mimi work-memory session changed");
        switch (command.type) {
          case "begin":
            turn = await this.controller.value.beginTurn(command.clientMessageId);
            break;
          case "clear":
            await this.controller.value.requestContextClear();
            break;
          case "delegation":
            await this.controller.value.onDelegationClosed(command.closure);
            break;
          default:
            throw Error("Unknown Mimi work-memory operation");
        }
        this.revision++;
      }
      return {
        epoch: this.epoch,
        revision: this.revision,
        segments: this.store.allSegments(),
        ...(turn && { turn }),
      };
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
