import {
  PET_PENDING_NOTICE_BODY_MAX,
  PET_PENDING_NOTICE_TITLE_MAX,
  PET_PENDING_NOTICES_MAX,
} from "@cjhyy/code-shell-pet";
import type { PetPendingNoticeSource } from "./pet-dispatch-service.js";
import type { PetNoticePowerEvents } from "./pet-notice-decision-hooks.js";
import type { PetNoticeRouter } from "./pet-notice-router.js";
import { textLine } from "./pet-notice-task-closure.js";
import { errorText } from "./pet-notice-types.js";

/** A queued notice as Mimi's runtime context carries it (`pendingNotices`): data only. */
export interface PetPendingNotice {
  kind: string;
  title?: string;
  body: string;
}

/** The owner's IM message that starts a Mimi turn. */
export interface PetInboundOrigin {
  channel: string;
  target: string;
  senderId?: string;
  isDirectMessage?: boolean;
}

/**
 * Notices for one inbound message, handed to the dispatcher. They are taken
 * from the ledger only when that message's own Mimi turn starts (`take`), and
 * settled for good the moment the turn starts with them (`started`), so a
 * message that waits in the chat queue never holds them and never hands them
 * out twice. `finish` (always call it after dispatch) releases notices that
 * were taken but whose turn never started.
 */
export interface PetInboundReplay extends PetPendingNoticeSource {
  finish(): void;
}

export interface PetNoticeReplayDeps {
  router: Pick<PetNoticeRouter, "replayPending" | "releaseReplay" | "markReplayed" | "flushDigest">;
  /** Stores loaded (the wiring's `ready`). */
  ready: Promise<void>;
  /** Electron `powerMonitor`: a digest that slept through its moment goes out on wake / unlock. */
  powerEvents?: PetNoticePowerEvents;
  log: (event: string, data: Record<string, unknown>) => void;
}

export interface PetNoticeReplayHandle {
  /** Queued notices for an owner's IM message; undefined without an IM origin. */
  inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined;
  dispose(): void;
}

/**
 * The owner coming back: their next IM message replays what was queued for
 * them, and waking, unlocking or writing sends a digest that came due.
 */
export function createNoticeReplay(deps: PetNoticeReplayDeps): PetNoticeReplayHandle {
  const { router, ready, log } = deps;
  let disposed = false;

  /** Send held notices that are due now (their timer may have slept through it). */
  const flushDueDigest = (): void => {
    if (disposed) return;
    void router
      .flushDigest()
      .catch((error) => log("pet.notice.digest_failed", { error: errorText(error) }));
  };
  deps.powerEvents?.on("resume", flushDueDigest);
  deps.powerEvents?.on("unlock-screen", flushDueDigest);

  function inboundReplay(origin: PetInboundOrigin | undefined): PetInboundReplay | undefined {
    if (!origin) return undefined;
    let ids: string[] = [];
    let state: "idle" | "taken" | "started" | "finished" = "idle";
    return {
      async take() {
        if (state !== "idle" || disposed) return [];
        state = "taken";
        // The owner is back: anything the digest was holding for this moment goes now.
        flushDueDigest();
        let replayed: Awaited<ReturnType<PetNoticeRouter["replayPending"]>>;
        try {
          await ready;
          replayed = await router.replayPending(origin.channel, {
            target: origin.target,
            ...(origin.senderId !== undefined ? { senderId: origin.senderId } : {}),
            ...(origin.isDirectMessage !== undefined
              ? { isDirectMessage: origin.isDirectMessage }
              : {}),
          });
        } catch (error) {
          log("pet.notice.replay_failed", { channel: origin.channel, error: errorText(error) });
          return [];
        }
        const kept = replayed.slice(0, PET_PENDING_NOTICES_MAX);
        // More than one turn can carry stays queued for the next message.
        router.releaseReplay(replayed.slice(PET_PENDING_NOTICES_MAX).map((notice) => notice.id));
        ids = kept.map((notice) => notice.id);
        // finish() may have run while the ledger was being read.
        if ((state as string) === "finished") {
          router.releaseReplay(ids);
          return [];
        }
        return kept.map((notice): PetPendingNotice => {
          const title = textLine(notice.title, PET_PENDING_NOTICE_TITLE_MAX);
          return {
            kind: notice.kind.slice(0, 64),
            ...(title ? { title } : {}),
            body: notice.body.slice(0, PET_PENDING_NOTICE_BODY_MAX) || "-",
          };
        });
      },
      started() {
        if (state !== "taken") return;
        state = "started";
        if (ids.length === 0) return;
        void router
          .markReplayed(ids)
          .catch((error) => log("pet.notice.replay_mark_failed", { error: errorText(error) }));
      },
      finish() {
        if (state === "taken") router.releaseReplay(ids);
        if (state !== "started") state = "finished";
      },
    };
  }

  return {
    inboundReplay,
    dispose() {
      disposed = true;
      deps.powerEvents?.removeListener("resume", flushDueDigest);
      deps.powerEvents?.removeListener("unlock-screen", flushDueDigest);
    },
  };
}
