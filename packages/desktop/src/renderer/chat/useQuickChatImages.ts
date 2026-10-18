import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { QuickChatSessionRef } from "../quickChatSession";
import { ATTACHMENT_LIMITS, type ImageAttachment } from "./attachments";

type ImageOwner = Pick<QuickChatSessionRef, "bucket" | "sessionId" | "creationNonce">;
interface ImageState extends ImageOwner {
  attachments: ImageAttachment[];
  attachmentError: string | null;
  generation: number;
}
type ImageStates = Record<string, ImageState>;

export interface QuickChatImageSelection {
  isCurrent(): boolean;
  setAttachmentError(next: SetStateAction<string | null>): void;
  appendImages(
    images: ImageAttachment[],
    overflowMessage: string,
    validationMessages: string[],
  ): void;
}

/** Images and their visible error share the same QuickChat owner and state update. */
export interface QuickChatImageComposer {
  attachments: ImageAttachment[];
  attachmentError: string | null;
  setAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  setAttachmentError: Dispatch<SetStateAction<string | null>>;
  beginSelection(): QuickChatImageSelection | null;
}

const EMPTY_IMAGES: ImageAttachment[] = [];
const sameOwner = (left: ImageOwner, right: ImageOwner) =>
  left.bucket === right.bucket &&
  left.sessionId === right.sessionId &&
  left.creationNonce === right.creationNonce;
const emptyState = (owner: ImageOwner): ImageState => ({
  bucket: owner.bucket,
  sessionId: owner.sessionId,
  creationNonce: owner.creationNonce,
  attachments: EMPTY_IMAGES,
  attachmentError: null,
  generation: 0,
});

export function useQuickChatImages(
  liveSessions: MutableRefObject<Record<string, QuickChatSessionRef>>,
) {
  const [states, setStates] = useState<ImageStates>({});
  const isLive = (owner: ImageOwner) =>
    Object.values(liveSessions.current).some(
      (session) => session.status === "ready" && sameOwner(session, owner),
    );

  // Preserve the existing image-map interface used to retire closed/restarted
  // panel buckets. The actual composer uses the identity-bound methods below.
  const attachments = Object.fromEntries(
    Object.entries(states).map(([bucket, state]) => [bucket, state.attachments]),
  );
  const setAttachments: Dispatch<SetStateAction<Record<string, ImageAttachment[]>>> = (next) => {
    setStates((previous) => {
      const current = Object.fromEntries(
        Object.entries(previous).map(([bucket, state]) => [bucket, state.attachments]),
      );
      const updated = typeof next === "function" ? next(current) : next;
      if (updated === current) return previous;
      let changed = Object.keys(updated).length !== Object.keys(previous).length;
      const result: ImageStates = {};
      for (const [bucket, images] of Object.entries(updated)) {
        const before = previous[bucket];
        if (before && before.attachments === images) result[bucket] = before;
        else {
          const owner = Object.values(liveSessions.current).find(
            (session) => session.bucket === bucket && session.status === "ready",
          );
          if (!owner) {
            changed = true;
            continue;
          }
          const state = before && sameOwner(before, owner) ? before : emptyState(owner);
          result[bucket] = {
            ...state,
            attachments: images,
            attachmentError: null,
            generation: state.generation + 1,
          };
          changed = true;
        }
      }
      return changed ? result : previous;
    });
  };

  function forSession(session: ImageOwner): QuickChatImageComposer {
    const owner: ImageOwner = {
      bucket: session.bucket,
      sessionId: session.sessionId,
      creationNonce: session.creationNonce,
    };
    const observed = states[owner.bucket];
    const state = observed && sameOwner(observed, owner) ? observed : emptyState(owner);
    const generation = state.generation;
    const update = (change: (current: ImageState) => ImageState) => {
      if (!isLive(owner)) return;
      setStates((previous) => {
        if (!isLive(owner)) return previous;
        const entry = previous[owner.bucket];
        const current = entry && sameOwner(entry, owner) ? entry : emptyState(owner);
        if (current.generation !== generation) return previous;
        const result = change(current);
        return result === current ? previous : { ...previous, [owner.bucket]: result };
      });
    };
    const setAttachmentError: Dispatch<SetStateAction<string | null>> = (next) => {
      update((current) => {
        const attachmentError = typeof next === "function" ? next(current.attachmentError) : next;
        return attachmentError === current.attachmentError
          ? current
          : { ...current, attachmentError };
      });
    };
    return {
      attachments: state.attachments,
      attachmentError: state.attachmentError,
      setAttachments(next) {
        update((current) => {
          const images = typeof next === "function" ? next(current.attachments) : next;
          // Explicit clear/send invalidates work captured for the old draft,
          // including a pending first image when the composer is already empty.
          const reset = typeof next !== "function";
          if (!reset && images === current.attachments) return current;
          return {
            ...current,
            attachments: images,
            attachmentError: reset ? null : current.attachmentError,
            generation: current.generation + (reset ? 1 : 0),
          };
        });
      },
      setAttachmentError,
      beginSelection() {
        if (!isLive(owner)) return null;
        return {
          // Generation is checked against latest state when an error/result is
          // committed; this passive owner check grants no staging authority.
          isCurrent: () => isLive(owner),
          setAttachmentError,
          appendImages(images, overflowMessage, validationMessages) {
            update((current) => {
              const available = Math.max(
                0,
                ATTACHMENT_LIMITS.maxImagesPerMessage - current.attachments.length,
              );
              const accepted = images.slice(0, available);
              const messages = [...validationMessages];
              if (accepted.length < images.length) messages.push(overflowMessage);
              const attachmentError = messages.length
                ? messages.join("；")
                : current.attachmentError;
              if (!accepted.length && attachmentError === current.attachmentError) return current;
              return {
                ...current,
                attachments: accepted.length
                  ? [...current.attachments, ...accepted]
                  : current.attachments,
                attachmentError,
              };
            });
          },
        };
      },
    };
  }

  return { attachments, setAttachments, forSession };
}
