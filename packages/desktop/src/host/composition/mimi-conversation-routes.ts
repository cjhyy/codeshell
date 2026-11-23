import { AsyncLocalStorage } from "node:async_hooks";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { ConversationSessionRouteStore } from "../../main/pet/conversation-session-route-store.js";
import {
  mimiRouteMethods,
  type MimiRouteCall,
  type MimiRouteReply,
} from "../../shared/mimi-conversation-routes.js";
import { claimBusinessCommit } from "./business-calls.js";

/** The storage worker serializes every read or change to one route file for this installation. */
export class StoredMimiConversationRoutes {
  private readonly current = new AsyncLocalStorage<Int32Array>();
  private readonly routes: ConversationSessionRouteStore;
  constructor(petDir: string) {
    this.routes = new ConversationSessionRouteStore(
      join(petDir, "conversation-session-routes.json"),
      Date.now,
      async (from, to) => {
        const permit = this.current.getStore();
        if (!permit) throw Error("Missing Mimi route grant");
        claimBusinessCommit(permit);
        renameSync(from, to);
      },
    );
  }
  async run({
    call,
    permit,
  }: {
    call: MimiRouteCall;
    permit: Int32Array;
  }): Promise<MimiRouteReply> {
    if (
      !call ||
      !mimiRouteMethods.includes(call.method) ||
      !Array.isArray(call.args) ||
      !(permit instanceof Int32Array)
    )
      throw Error("Invalid Mimi route operation");
    if (Atomics.load(permit, 0) < 0) throw Error("Mimi route authority expired");
    return this.current.run(permit, async () => ({
      value: await Reflect.apply(this.routes[call.method], this.routes, call.args),
    }));
  }
}
