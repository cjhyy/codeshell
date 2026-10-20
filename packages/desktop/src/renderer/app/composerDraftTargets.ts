import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { resolveAttachmentSessionId } from "../attachmentSession";
import { ATTACHMENT_LIMITS, type ImageAttachment } from "../chat/attachments";
import { emptyComposerMetadata, type ComposerMetadata } from "../chat/composerMetadata";
import type { AttachmentSelection } from "../ChatView";
import { loadProjects } from "../projects";
import type { SessionUiAuthority } from "../sessionUiAuthority";
import { loadSessionIndex, type SessionSummary } from "../transcripts";
import { EMPTY_ATTACHMENTS, parsePanelBucket, type ComposerDraftsMap } from "./appUtils";

/** Root captured when this App materialized a draft into a pre-send UI Session. */
export type PendingAttachmentRoot =
  | { kind: "project"; projectId: string; rootId: string; cwd: string }
  | { kind: "noRepo"; cwd: string };

export interface AttachmentContext {
  cwd: string;
  sessionId: string;
}

/** Pin the root of a draft materialized while Main's authority for it is settled. */
export function pinPendingAttachmentRoot(
  projectId: string | null,
  cwd: string,
  noRepoCwd: string | null,
  authority: SessionUiAuthority,
): PendingAttachmentRoot | undefined {
  const registered = loadProjects().find((candidate) => candidate.id === projectId);
  const root = registered?.roots.find((candidate) => candidate.id === registered.primaryRootId);
  if (
    registered &&
    root &&
    root.path === cwd &&
    registered.path === cwd &&
    authority.configurationAvailable &&
    "projectId" in authority.configurationTarget &&
    authority.configurationTarget.projectId === projectId &&
    authority.rootStatus === "ok" &&
    authority.mainRootId === root.id &&
    authority.mainRoot === cwd &&
    authority.workspaceRoot === cwd
  ) {
    return { kind: "project", projectId: registered.id, rootId: root.id, cwd };
  }
  if (
    projectId === null &&
    noRepoCwd === cwd &&
    authority.configurationAvailable &&
    "noRepo" in authority.configurationTarget &&
    authority.configurationTarget.noRepo === true &&
    authority.projectId === null &&
    authority.rootStatus === "ok" &&
    authority.mainRootId === null &&
    authority.mainRoot === cwd &&
    authority.workspaceRoot === cwd
  ) {
    // Main supplies this cwd; the token only continues this UI's own draft
    // staging. It neither creates a Core Session nor proves its absence.
    return { kind: "noRepo", cwd };
  }
  return undefined;
}

/**
 * Only this App's own attachment prepare can continue a pre-send UI Session.
 * Staging has not created a Core Session or its authority.
 */
export function resumePendingAttachmentRoot(input: {
  pin: PendingAttachmentRoot | undefined;
  projectId: string | null;
  sessionId: string;
  summary: SessionSummary | undefined;
  locallyCreated: boolean;
  noRepoCwd: string | null;
  authority: SessionUiAuthority;
}): AttachmentContext | null {
  const { pin, projectId, sessionId, summary, authority } = input;
  const pending =
    summary?.pendingFirstRun === true &&
    summary.engineSessionId === undefined &&
    !summary.archived &&
    input.locallyCreated;
  if (pin?.kind === "noRepo") {
    return pending &&
      projectId === null &&
      input.noRepoCwd === pin.cwd &&
      authority.configurationAvailable &&
      "noRepo" in authority.configurationTarget &&
      authority.configurationTarget.noRepo === true &&
      authority.projectId === null &&
      authority.rootStatus === "loading" &&
      authority.mainRootId === null &&
      authority.mainRoot === pin.cwd &&
      authority.workspaceRoot === pin.cwd
      ? { cwd: pin.cwd, sessionId }
      : null;
  }
  const project = loadProjects().find((candidate) => candidate.id === projectId);
  const root = project?.roots.find((candidate) => candidate.id === project.primaryRootId);
  return pin &&
    project &&
    root &&
    pending &&
    pin.projectId === projectId &&
    pin.rootId === project.primaryRootId &&
    root.path === project.path &&
    project.path === pin.cwd &&
    authority.configurationAvailable &&
    "projectId" in authority.configurationTarget &&
    authority.configurationTarget.projectId === projectId &&
    authority.rootStatus === "loading" &&
    authority.mainRootId === pin.rootId &&
    authority.mainRoot === pin.cwd &&
    authority.workspaceRoot === pin.cwd
    ? { cwd: pin.cwd, sessionId }
    : null;
}

/** Composer draft writers addressed to one bucket, fenced to its owning Session. */
export function createComposerDraftTargets(
  activeBucketRef: MutableRefObject<string>,
  setComposerDrafts: Dispatch<SetStateAction<ComposerDraftsMap>>,
) {
  function isTargetCurrent(targetBucket: string, engineSessionId?: string): boolean {
    if (activeBucketRef.current !== targetBucket) return false;
    const target = parsePanelBucket(targetBucket);
    if (
      target.projectId !== null &&
      !loadProjects().some((project) => project.id === target.projectId)
    ) {
      return false;
    }
    if (!target.sessionId) return true;
    const owner = loadSessionIndex(target.projectId).sessions.find(
      (session) => session.id === target.sessionId,
    );
    return Boolean(
      owner &&
      !owner.archived &&
      (engineSessionId === undefined || (owner.engineSessionId ?? owner.id) === engineSessionId),
    );
  }
  function updateAttachments(
    targetBucket: string,
    next: SetStateAction<ImageAttachment[]>,
    isCurrent = () => isTargetCurrent(targetBucket),
  ): void {
    if (!isCurrent()) return;
    setComposerDrafts((prev) => {
      if (!isCurrent()) return prev;
      const current = prev[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const attachments = typeof next === "function" ? next(current.attachments) : next;
      if (attachments === current.attachments) return prev;
      return { ...prev, [targetBucket]: { ...current, attachments } };
    });
  }
  function appendImages(
    targetBucket: string,
    images: ImageAttachment[],
    overflowMessage: string,
    validationMessages: string[],
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    setComposerDrafts((prev) => {
      if (!isCurrent()) return prev;
      const current = prev[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const available = Math.max(
        0,
        ATTACHMENT_LIMITS.maxImagesPerMessage - current.attachments.length,
      );
      const accepted = images.slice(0, available);
      const messages =
        images.length > available ? [...validationMessages, overflowMessage] : validationMessages;
      if (accepted.length === 0 && messages.length === 0) return prev;
      return {
        ...prev,
        [targetBucket]: {
          ...current,
          attachments:
            accepted.length > 0 ? [...current.attachments, ...accepted] : current.attachments,
          ...(messages.length > 0
            ? {
                metadata: {
                  ...(current.metadata ?? emptyComposerMetadata(current.text)),
                  attachmentError: messages.join("；"),
                },
              }
            : {}),
        },
      };
    });
  }
  function updateMetadata(
    targetBucket: string,
    next: SetStateAction<ComposerMetadata>,
    isCurrent = () => isTargetCurrent(targetBucket),
  ): void {
    if (!isCurrent()) return;
    setComposerDrafts((prev) => {
      if (!isCurrent()) return prev;
      const current = prev[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      const metadata = current.metadata ?? emptyComposerMetadata(current.text);
      const updated = typeof next === "function" ? next(metadata) : next;
      if (updated === metadata) return prev;
      return { ...prev, [targetBucket]: { ...current, metadata: updated } };
    });
  }
  /** Fence one async selection to the bucket and Session that started it. */
  function beginSelection(
    startBucket: string,
    prepareSession: () => AttachmentContext | null,
  ): AttachmentSelection | null {
    let targetBucket = startBucket;
    const origin = parsePanelBucket(targetBucket);
    let engineSessionId = resolveAttachmentSessionId(
      origin.sessionId,
      loadSessionIndex(origin.projectId).sessions,
    );
    let invalidated = false;
    const isCurrent = (): boolean => {
      if (!isTargetCurrent(targetBucket, engineSessionId)) invalidated = true;
      return !invalidated;
    };
    if (!isCurrent()) return null;
    return {
      isCurrent,
      prepare: () => {
        if (!isCurrent()) return null;
        const context = prepareSession();
        if (!context) return null;
        if (!origin.sessionId) {
          // Only this synchronous prepare may move its own draft to a Session.
          const materialized = parsePanelBucket(activeBucketRef.current);
          if (
            materialized.projectId !== origin.projectId ||
            materialized.sessionId !== context.sessionId
          ) {
            invalidated = true;
            return null;
          }
          targetBucket = activeBucketRef.current;
        }
        engineSessionId = context.sessionId;
        return isCurrent() ? context : null;
      },
      updateAttachments: (next) => {
        if (isCurrent()) updateAttachments(targetBucket, next, isCurrent);
      },
      appendImages: (images, overflowMessage, validationMessages) => {
        appendImages(targetBucket, images, overflowMessage, validationMessages, isCurrent);
      },
      updateMetadata: (next) => {
        if (isCurrent()) updateMetadata(targetBucket, next, isCurrent);
      },
    };
  }
  /** Review drafts land in their originating bucket even after navigation. */
  function appendText(targetBucket: string, text: string): void {
    setComposerDrafts((previous) => {
      const current = previous[targetBucket] ?? { text: "", attachments: EMPTY_ATTACHMENTS };
      return {
        ...previous,
        [targetBucket]: {
          ...current,
          text: current.text.trim() ? `${current.text}\n\n${text}` : text,
        },
      };
    });
  }
  return { updateAttachments, updateMetadata, beginSelection, appendText };
}
