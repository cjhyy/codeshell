import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { StreamEvent } from "@cjhyy/code-shell-core";

import {
  compactOutcomeMessage,
  compactPromptTokensWithBaseline,
  compactWasNoop,
} from "../chat/compactFeedback";
import { titleFromWire } from "../chat/attachments";
import { toCorePermissionMode, type PermissionMode } from "../chat/PermissionPill";
import {
  bindEngineSession,
  bucketKey,
  loadSessionIndex,
  migrateBucketOverride,
  projectBucketSegment as projectBucketSegmentFor,
  touchSession,
  type SessionIndex,
} from "../transcripts";
import {
  canSteerQueuedItem,
  clearQueuedInput,
  dequeueQueuedInput,
  drainQueuedInput,
  enqueueQueuedInput,
  enqueueSerialTask,
  removeQueuedInputById,
  type QueuedInputState,
  type SerialTaskQueue,
} from "../queuedInput";
import { resolveStopBucket } from "../stopRouting";
import { runAfterModelSwitch } from "../modelSwitchRun";
import { quickChatSessionIdFromBucket, type QuickChatSessionRef } from "../quickChatSession";
import { browserPartitionForBucket, parsePanelBucket, type ApprovalHistoryEntry } from "./appUtils";
import type { TranscriptsAction } from "../transcriptsReducer";
import type { ApprovalState, MessagesReducerState } from "../types";
import { timePhase } from "../perf";
import type { TrackedProject } from "../projects";
import type { ViewMode, ViewState } from "../view";
import type { ApproveChoice, ApprovePathScope } from "../approvals/approvalDecision";
import type { ApprovalRequestEnvelope, InputAttachmentMeta } from "../../preload/types";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { NO_REPO_KEY } from "../transcripts";

interface Params {
  shell: {
    t: ReturnType<typeof useT>["t"];
    lang: ReturnType<typeof useT>["lang"];
    toast: ReturnType<typeof useToast>;
    setView: Dispatch<SetStateAction<ViewState>>;
  };
  session: {
    activeProjectId: string | null;
    activeSessionId: string | null;
    activeBucket: string;
    projects: TrackedProject[];
    sessionIndices: Record<string, SessionIndex>;
    setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
    ensureActiveSession: (projectId: string | null) => string;
  };
  preferences: {
    permissionOverrides: Record<string, PermissionMode>;
    setPermissionOverrides: Dispatch<SetStateAction<Record<string, PermissionMode>>>;
    defaultPermissionMode: PermissionMode | null;
    goalOverrides: Record<string, boolean>;
    setGoalOverrides: Dispatch<SetStateAction<Record<string, boolean>>>;
    modelOverrides: Record<string, string>;
    setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>;
    defaultActiveModelKey: string | null;
  };
  runtime: {
    setBusyForKey: (key: string, value: boolean) => void;
    runningBucketRef: MutableRefObject<string | null>;
    engineToBucketRef: MutableRefObject<Map<string, string>>;
    noRepoCwdRef: MutableRefObject<string | null>;
    quickChatSessionsRef: MutableRefObject<Record<string, QuickChatSessionRef>>;
    queuedInputs: QueuedInputState;
    setQueuedInputs: Dispatch<SetStateAction<QueuedInputState>>;
    busy: boolean;
    busyKeys: Set<string>;
    relayingBuckets: Set<string>;
    setRelayingBuckets: Dispatch<SetStateAction<Set<string>>>;
    steeredIdsRef: MutableRefObject<Set<string>>;
    injectedSteerIdsRef: MutableRefObject<Set<string>>;
    downgradeRunQueueRef: MutableRefObject<SerialTaskQueue>;
    queuedSeqRef: MutableRefObject<number>;
    busySinceRef: MutableRefObject<Map<string, number>>;
    compactingBucketsRef: MutableRefObject<Set<string>>;
    setCompactingBuckets: Dispatch<SetStateAction<Set<string>>>;
  };
  transcript: { dispatch: Dispatch<TranscriptsAction>; state: MessagesReducerState };
  approvals: {
    approval: ApprovalState;
    approvalQueue: ApprovalRequestEnvelope[];
    setApprovalQueue: Dispatch<SetStateAction<ApprovalRequestEnvelope[]>>;
    setApproval: Dispatch<SetStateAction<ApprovalState>>;
    setApprovalHistory: Dispatch<SetStateAction<ApprovalHistoryEntry[]>>;
    approvalBucketsRef: MutableRefObject<Map<string, string>>;
  };
}

/** Owns send/quick-chat/queue/steer/stop/compact and approval decisions. */
export function useRunController({
  shell,
  session,
  preferences,
  runtime,
  transcript,
  approvals,
}: Params) {
  const { t, lang, toast, setView } = shell;
  const {
    activeProjectId,
    activeSessionId,
    activeBucket,
    projects,
    sessionIndices,
    setSessionIndices,
    ensureActiveSession,
  } = session;
  const {
    permissionOverrides,
    setPermissionOverrides,
    defaultPermissionMode,
    goalOverrides,
    setGoalOverrides,
    modelOverrides,
    setModelOverrides,
    defaultActiveModelKey,
  } = preferences;
  const { dispatch, state } = transcript;
  const {
    setBusyForKey,
    runningBucketRef,
    engineToBucketRef,
    noRepoCwdRef,
    quickChatSessionsRef,
    queuedInputs,
    setQueuedInputs,
    busy,
    busyKeys,
    relayingBuckets,
    setRelayingBuckets,
    steeredIdsRef,
    injectedSteerIdsRef,
    downgradeRunQueueRef,
    queuedSeqRef,
    busySinceRef,
    compactingBucketsRef,
    setCompactingBuckets,
  } = runtime;
  const {
    approval,
    approvalQueue,
    setApprovalQueue,
    setApproval,
    setApprovalHistory,
    approvalBucketsRef,
  } = approvals;
  const send = (
    text: string,
    sendOpts: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      workspaceProfile?: string;
      displayText?: string;
    } = {},
  ): Promise<void> => {
    // createSession persists to localStorage synchronously, so reading
    // it back via touchSession() right after sees the new entry.
    const parsedBucket = sendOpts.bucket ? parsePanelBucket(sendOpts.bucket) : null;
    const targetProjectId = parsedBucket ? parsedBucket.projectId : activeProjectId;
    const targetSessionId = parsedBucket ? parsedBucket.sessionId : activeSessionId;
    const wasDraft = targetSessionId === null;
    const sid = targetSessionId ?? ensureActiveSession(targetProjectId);
    const bucket = bucketKey(targetProjectId, sid);
    const projectBucketSegment = projectBucketSegmentFor(targetProjectId);
    const targetProject = projects.find((project) => project.id === targetProjectId) ?? null;
    // A draft's pre-send toggles (permission/goal/model) were keyed under the
    // SHARED draft bucket (<repo>::_none_), NOT the freshly-created real session
    // bucket that `ensureActiveSession` just produced above. Read them from the
    // draft bucket on first send, else the draft's Goal toggle is silently
    // dropped (composer icon stays lit — it reads activeBucket = draft — while
    // the send reads the empty real bucket → goal never set). The migration
    // below then moves the override onto the real bucket for follow-ups.
    const overrideBucket = wasDraft ? (sendOpts.bucket ?? activeBucket) : bucket;
    const sendPermissionMode = permissionOverrides[overrideBucket] ?? defaultPermissionMode;
    const sendGoalEnabled = goalOverrides[overrideBucket] ?? false;
    const sendModelKey = modelOverrides[overrideBucket] ?? defaultActiveModelKey;
    const clientMessageId = sendOpts.clientMessageId ?? newQueuedId();
    const displayText = sendOpts.displayText ?? text;

    // A draft has no sessionId, so its permission/goal overrides were keyed
    // under the SHARED per-repo "_none_" bucket (bucketKey collapses every
    // draft to <repo>::_none_). On the first send the draft solidifies into a
    // real session — migrate the override onto the real bucket so the choice
    // FOLLOWS this session, then clear the shared draft slot so it doesn't
    // "粘连" onto the next 新对话 / other drafts in this project (#11 per-session
    // permission stickiness).
    if (wasDraft && bucket !== (sendOpts.bucket ?? activeBucket)) {
      const draftBucket = sendOpts.bucket ?? activeBucket;
      setPermissionOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setGoalOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
      setModelOverrides((prev) => migrateBucketOverride(prev, draftBucket, bucket));
    }
    // Pin this session's model on its first send. Capturing the model in
    // effect right now means a LATER change to the global default won't drag
    // this (now-existing) session onto a different model. Only seed if the
    // bucket has no explicit override yet — never clobber a deliberate switch.
    if (sendModelKey && modelOverrides[bucket] === undefined) {
      const pinned = sendModelKey;
      setModelOverrides((prev) =>
        prev[bucket] === undefined ? { ...prev, [bucket]: pinned } : prev,
      );
    }

    // Look up any previously-bound engine sessionId for this UI session.
    // Pre-multi-session sessions on disk may have an engineSessionId that
    // differs from the UI sessionId (the old auto-bound flow). For brand
    // new sessions we use the UI sessionId directly as the engine
    // sessionId so the engineToBucket route is populated synchronously.
    const summary =
      sessionIndices[projectBucketSegment]?.sessions.find((s) => s.id === sid) ??
      loadSessionIndex(targetProjectId).sessions.find((s) => s.id === sid);
    const engineSessionId = summary?.engineSessionId ?? sid;

    window.codeshell.log("send", {
      textLen: text.length,
      repo: targetProject?.name ?? null,
      bucket,
      engineSessionId,
      clientMessageId,
    });
    dispatch({
      type: "user_message",
      bucket,
      text: displayText,
      isGoal: sendGoalEnabled && !!text.trim(),
      clientMessageId,
    });
    setBusyForKey(bucket, true);
    runningBucketRef.current = bucket;
    // Register the route NOW so concurrent sends can each find their own
    // bucket. session_started will reinforce this with the same value (or
    // overwrite with the engine-generated id for legacy sessions).
    engineToBucketRef.current.set(engineSessionId, bucket);

    // Touch session: bump updatedAt + adopt first user prompt as title,
    // and persist engineSessionId so future sends in this UI session
    // pass the same value (and the engine resumes the right convo).
    setSessionIndices((prev) => {
      const touched = touchSession(targetProjectId, sid, titleFromWire(displayText));
      const next = summary?.engineSessionId
        ? touched
        : bindEngineSession(targetProjectId, sid, engineSessionId);
      return { ...prev, [projectBucketSegment]: next };
    });

    const opts: {
      cwd?: string;
      sessionId?: string;
      bucket?: string;
      browserPartition?: string;
      permissionMode?: ReturnType<typeof toCorePermissionMode>;
      goal?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      workspaceProfile?: string;
      sessionMessageTargets?: Array<{
        sessionId: string;
        title: string;
        workspaceRoot: string;
        workspaceProfile?: string;
      }>;
    } = {
      sessionId: engineSessionId,
      bucket,
      browserPartition: browserPartitionForBucket(bucket),
      clientMessageId,
      ...(summary?.workspaceProfile ? { workspaceProfile: summary.workspaceProfile } : {}),
    };
    if (targetProject) {
      const projectSessions =
        sessionIndices[projectBucketSegment]?.sessions ??
        loadSessionIndex(targetProjectId).sessions;
      const sessionMessageTargets = projectSessions
        .filter((candidate) => !candidate.archived)
        .map((candidate) => ({
          sessionId: candidate.engineSessionId ?? candidate.id,
          title: candidate.title,
          workspaceRoot: targetProject.path,
          ...(candidate.workspaceProfile ? { workspaceProfile: candidate.workspaceProfile } : {}),
        }));
      // A newly-solidified draft may not be present in the React snapshot yet.
      // Include it so a target Session can immediately message the source back.
      if (!sessionMessageTargets.some((candidate) => candidate.sessionId === engineSessionId)) {
        sessionMessageTargets.push({
          sessionId: engineSessionId,
          title: summary?.title || titleFromWire(displayText),
          workspaceRoot: targetProject.path,
          ...(summary?.workspaceProfile ? { workspaceProfile: summary.workspaceProfile } : {}),
        });
      }
      if (sessionMessageTargets.length > 0) {
        opts.sessionMessageTargets = sessionMessageTargets;
      }
    }
    window.codeshell.registerBrowserSessionBucket({
      sessionId: engineSessionId,
      bucket,
      partition: browserPartitionForBucket(bucket),
    });
    if (sendOpts.attachments && sendOpts.attachments.length > 0) {
      opts.attachments = sendOpts.attachments;
    }
    if (sendPermissionMode !== null) {
      opts.permissionMode = toCorePermissionMode(sendPermissionMode);
    }
    // Pass cwd explicitly in BOTH cases: a real project → its path; no-repo chat →
    // the no-repo sandbox. Never leave cwd undefined — the long-lived worker
    // would otherwise default to a stale project (see noRepoCwdRef). Falls back
    // to undefined only if the one-time fetch hasn't resolved yet, in which case
    // the core-side stdio worker still defaults to noRepoDir() (defense #2).
    if (targetProject) opts.cwd = targetProject.path;
    else if (noRepoCwdRef.current) opts.cwd = noRepoCwdRef.current;
    // Goal mode: this send's prompt IS the goal — the engine runs
    // loop-until-done. Goal text == prompt text (reuses the composer input).
    // Persistent goal (CC /goal): the toggle means "make THIS message a goal".
    // Once sent, core persists it on the session and later bare sends inherit it
    // — so we auto-disable the toggle after establishing the goal. Otherwise a
    // toggle left on would make every follow-up REPLACE the goal with its own
    // text (one active goal per session), which is never what the user wants.
    // The active goal stays visible in the TopBar popover; clear it there.
    if (sendGoalEnabled && text.trim()) {
      opts.goal = text;
      setGoalOverrides((prev) => ({ ...prev, [bucket]: false }));
    }
    if (opts.cwd && opts.attachments && opts.attachments.length > 0) {
      void window.codeshell
        .markAttachmentsSent({
          cwd: opts.cwd,
          sessionId: engineSessionId,
          attachments: opts.attachments,
        })
        .catch((err) => {
          window.codeshell.log("attachments.mark_sent_failed", {
            bucket,
            error: String((err as Error)?.message ?? err),
          });
        });
    }

    // Pin this session's engine to its per-bucket model before the turn. The
    // engine session may have just been created fresh (resume / first send /
    // draft where the user picked a non-default model) on the worker's current
    // model — without this, a session pinned to model A would silently run on
    // the worker default. configure({sessionId,model}) → requestModelSwitch
    // applies immediately when idle, so it lands before the turn starts. Skip
    // when the bucket has no override (it follows the default — no switch needed).
    // Final fallback to `activeModelKey` (= the model the UI currently shows
    // for this session, itself defaulting to the global default). The engine
    // session may have been created on a DIFFERENT model than the UI shows —
    // e.g. the user changed the model from the Settings page (which only
    // updates disk activeKey, not this renderer's per-bucket override) or the
    // worker started on a stale pin. Without this fallback, `bucketModel`
    // could be undefined while the engine quietly runs on its old model — the
    // deepseek-vision rejection bug, where a "switched to gpt-5" session still
    // ran on deepseek-v4-flash and refused the image. Always pin before the
    // turn so the engine matches what the UI claims.
    const bucketModel = modelOverrides[bucket] ?? sendModelKey;
    return runAfterModelSwitch({
      sessionId: engineSessionId,
      model: bucketModel,
      text,
      opts,
      run: window.codeshell.run,
    })
      .then((r) => {
        // Belt-and-braces: clear busy for THIS run's bucket even if the
        // stream never delivered turn_complete (e.g. error in setup, or
        // the worker shutdown before flushing the event). Use the closed-
        // over `bucket`, not runningBucketRef — concurrent sends may have
        // moved the ref by the time we resolve.
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("run.resolved", {
          bucket,
          result: r as unknown as Record<string, unknown>,
        });
        // Surface early-return failures that never produced a stream. Some
        // RunResult reasons (image_error, model_error, prompt_too_long) are
        // returned by the engine BEFORE any turn starts — no turn_start, no
        // assistant_message, no turn_complete reaches the stream. Without
        // this branch the only trace is `r.text` in the log: busy clears,
        // nothing renders, and it reads as "卡住 / 没反应" (the deepseek-
        // vision rejection bug). Render the engine's human-readable message
        // as a turn_end(error) line in the stream + an error toast.
        const result = r as { reason?: string; text?: string } | null;
        const reason = result?.reason;
        if (reason === "image_error" || reason === "model_error" || reason === "prompt_too_long") {
          const detail = result?.text?.replace(/^ERROR:\s*/, "") || t("misc.app.requestRejected");
          dispatch({ type: "turn_end", bucket, reason: "error", detail });
          toast({ message: detail, variant: "error" });
        }
      })
      .catch((err) => {
        // Server crashed / RPC rejected / non-abort error. Without this
        // the run promise silently rejects, busy never clears, and the
        // composer stays disabled until the user reloads. Cancellation
        // is now reported via a successful RunResult with reason
        // "aborted_streaming" (see protocol/server.ts), so anything
        // reaching here is a real failure worth logging.
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("run.rejected", {
          bucket,
          error: String((err as Error)?.message ?? err),
        });
      });
  };

  const sendQuickChat = (
    session: QuickChatSessionRef,
    text: string,
    sendOpts: { attachments?: InputAttachmentMeta[]; displayText?: string } = {},
  ): void => {
    const prompt = text.trim();
    const attachments = sendOpts.attachments ?? [];
    if ((!prompt && attachments.length === 0) || session.status !== "ready") return;

    const bucket = session.bucket;
    const engineSessionId = session.sessionId;
    const clientMessageId = newQueuedId();
    const sendPermissionMode =
      permissionOverrides[bucket] ??
      permissionOverrides[session.ownerBucket] ??
      defaultPermissionMode ??
      "default";
    const sendModelKey = modelOverrides[bucket] ?? defaultActiveModelKey;
    const cwd = session.cwd ?? noRepoCwdRef.current ?? undefined;
    const opts: {
      cwd?: string;
      sessionId: string;
      bucket: string;
      browserPartition: string;
      permissionMode?: ReturnType<typeof toCorePermissionMode>;
      behaviorMode?: "quickChatRestricted";
      clientMessageId: string;
      attachments?: InputAttachmentMeta[];
    } = {
      sessionId: engineSessionId,
      bucket,
      browserPartition: browserPartitionForBucket(bucket),
      clientMessageId,
      behaviorMode: "quickChatRestricted",
    };
    if (cwd) opts.cwd = cwd;
    if (attachments.length > 0) opts.attachments = attachments;
    if (sendPermissionMode !== null) {
      opts.permissionMode = toCorePermissionMode(sendPermissionMode);
    }

    dispatch({
      type: "user_message",
      bucket,
      text: sendOpts.displayText ?? prompt,
      clientMessageId,
    });
    setBusyForKey(bucket, true);
    runningBucketRef.current = bucket;
    engineToBucketRef.current.set(engineSessionId, bucket);
    window.codeshell.registerBrowserSessionBucket({
      sessionId: engineSessionId,
      bucket,
      partition: browserPartitionForBucket(bucket),
    });
    if (cwd && attachments.length > 0) {
      void window.codeshell
        .markAttachmentsSent({
          cwd,
          sessionId: engineSessionId,
          attachments,
          quickChatClaimId: session.creationNonce,
        })
        .catch((err) => {
          window.codeshell.log("quick_chat.attachments.mark_sent_failed", {
            bucket,
            error: String((err as Error)?.message ?? err),
          });
        });
    }

    void runAfterModelSwitch({
      sessionId: engineSessionId,
      model: sendModelKey,
      text: prompt,
      opts,
      run: window.codeshell.run,
    })
      .then((r) => {
        if (
          !Object.values(quickChatSessionsRef.current).some(
            (liveSession) => liveSession.sessionId === engineSessionId,
          )
        ) {
          return;
        }
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("quick_chat.run.resolved", {
          bucket,
          sessionId: engineSessionId,
          result: r as unknown as Record<string, unknown>,
        });
        const result = r as { reason?: string; text?: string } | null;
        const reason = result?.reason;
        if (reason === "image_error" || reason === "model_error" || reason === "prompt_too_long") {
          const detail = result?.text?.replace(/^ERROR:\s*/, "") || t("misc.app.requestRejected");
          dispatch({ type: "turn_end", bucket, reason: "error", detail });
          toast({ message: detail, variant: "error" });
        }
      })
      .catch((err) => {
        setBusyForKey(bucket, false);
        if (runningBucketRef.current === bucket) {
          runningBucketRef.current = null;
        }
        window.codeshell.log("quick_chat.run.rejected", {
          bucket,
          sessionId: engineSessionId,
          error: String((err as Error)?.message ?? err),
        });
      });
  };

  useEffect(() => {
    if (!activeSessionId) return;
    const queued = queuedInputs[activeBucket];
    if (!queued || queued.length === 0) return;

    if (busy) {
      // A relay (打断重发) was requested for this bucket: don't steer — the abort
      // is in flight and the !busy branch will drain+re-send once it lands.
      if (relayingBuckets.has(activeBucket)) return;
      // Step-gap steering (默认, 不打断): hand each not-yet-sent queued draft to
      // the engine, which splices it into the running turn at its NEXT step
      // boundary. The item STAYS in the panel (visible + revocable) — it's only
      // removed when the engine's steer_injected event confirms it, at which
      // point it renders as a user bubble. Send each id exactly once.
      //
      // Resolve the engine session from activeBucket (the bucket this effect
      // operates on), NOT resolveActiveEngineSessionId() — the latter prefers
      // runningBucketRef, which points at the LAST-started run. With two busy
      // sessions (B started after A, user switches back to A and queues), that
      // would steer A's text into B's engine session (cross-session串投).
      const engineSessionId = resolveEngineSessionIdForBucket(activeBucket);
      if (!engineSessionId) return; // run starting up; re-fires once it resolves
      const bucket = activeBucket;
      for (const item of queued) {
        if (injectedSteerIdsRef.current.has(item.id) || steeredIdsRef.current.has(item.id)) {
          continue;
        }
        if (!canSteerQueuedItem(item)) {
          break;
        }
        steeredIdsRef.current.add(item.id);
        void window.codeshell
          .steer(engineSessionId, item.text, item.id, item.clientMessageId, item.attachments)
          .then((res) => {
            const accepted = (res as { result?: { accepted?: boolean } })?.result?.accepted;
            if (accepted !== false) return;
            if (!steeredIdsRef.current.has(item.id)) return;
            void enqueueSerialTask(downgradeRunQueueRef.current, async () => {
              if (!steeredIdsRef.current.has(item.id)) return;
              steeredIdsRef.current.delete(item.id);
              injectedSteerIdsRef.current.delete(item.id);
              setQueuedInputs((prev) => removeQueuedInputById(prev, bucket, item.id));
              dispatch({ type: "remove_pending_steers", bucket, steerIds: [item.id] });
              window.codeshell.log("steer.idle_downgrade.run_started", {
                bucket,
                engineSessionId,
                steerId: item.id,
                clientMessageId: item.clientMessageId,
              });
              await send(item.text, {
                bucket,
                clientMessageId: item.clientMessageId,
                attachments: item.attachments,
                displayText: item.displayText,
              });
            });
          })
          .catch((err) => {
            steeredIdsRef.current.delete(item.id);
            window.codeshell.log("steer.enqueue_failed", {
              bucket,
              engineSessionId,
              steerId: item.id,
              clientMessageId: item.clientMessageId,
              error: String((err as Error)?.message ?? err),
            });
          });
      }
      return;
    }

    // !busy: no live run. Either a 引导打断 relay handoff (drain the WHOLE queue
    // as one merged re-send) or a leftover queue typed while idle (take the next
    // item). Clear the relay marker once we fire.
    const isRelay = relayingBuckets.has(activeBucket);
    if (isRelay) {
      const {
        text,
        displayText,
        attachments,
        ids,
        state: next,
      } = drainQueuedInput(queuedInputs, activeBucket);
      ids.forEach((id) => {
        steeredIdsRef.current.delete(id);
        injectedSteerIdsRef.current.delete(id);
      });
      dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: ids });
      setQueuedInputs(next);
      setRelayingBuckets((prev) => {
        if (!prev.has(activeBucket)) return prev;
        const n = new Set(prev);
        n.delete(activeBucket);
        return n;
      });
      if (text !== null) send(text, { bucket: activeBucket, attachments, displayText });
      return;
    }
    const { item, state: next } = dequeueQueuedInput(queuedInputs, activeBucket);
    if (!item) {
      setQueuedInputs(next);
      return;
    }
    // The turn ended (busy→false). If this entry was already auto-steered into
    // the engine but the turn finished BEFORE consuming it (no steer_injected),
    // the entry is stranded in steerQueueBySid and would be eaten by the next
    // run — re-sending it here as a fresh run would then double (one send +
    // one leftover steer_injected). Revoke the stale steer first, so this
    // send() is the single source. (cancel/turn-end does NOT clear the steer
    // queue — same seam as the relay path's revokeSteeredForRelay.)
    if (steeredIdsRef.current.has(item.id)) {
      // Same as the steer path above: resolve from activeBucket so we revoke the
      // stale steer on THIS session's engine, not runningBucketRef's.
      const engineSessionId = resolveEngineSessionIdForBucket(activeBucket);
      if (engineSessionId) void window.codeshell.unsteer(engineSessionId, item.id);
      steeredIdsRef.current.delete(item.id);
    }
    injectedSteerIdsRef.current.delete(item.id);
    dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: [item.id] });
    setQueuedInputs(next);
    if (item.text || (item.attachments?.length ?? 0) > 0) {
      send(item.text, {
        bucket: activeBucket,
        clientMessageId: item.clientMessageId,
        attachments: item.attachments,
        displayText: item.displayText,
      });
    }
  }, [busy, activeBucket, activeSessionId, queuedInputs, relayingBuckets]);

  const newQueuedId = (): string =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `q-${queuedSeqRef.current++}`;

  const queueInput = (
    text: string,
    queueOpts: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      displayText?: string;
    } = {},
  ): void => {
    const id = newQueuedId();
    const clientMessageId = queueOpts.clientMessageId ?? newQueuedId();
    const trimmed = text.trim();
    const displayText = queueOpts.displayText?.trim();
    const attachments = queueOpts.attachments?.filter(Boolean) ?? [];
    if (!trimmed && !displayText && attachments.length === 0) return;
    const bucket = queueOpts.bucket ?? activeBucket;
    // No optimistic right-side bubble here. A queued draft lives ONLY in the
    // left waiting panel (enqueueQueuedInput) until the engine consumes it and
    // echoes steer_injected — the reducer then appends the real user bubble
    // (types.ts steer_injected fallback). This matches Codex (queued = not
    // shown in the feed; shown only once actually injected). The optimistic
    // bubble was a workaround for TurnProcessGroupCard's missing user branch,
    // now fixed, so it's no longer needed.
    if (attachments.length > 0) {
      toast({ message: t("chat.queue.attachmentsDeferred") });
    }
    setQueuedInputs((prev) =>
      enqueueQueuedInput(prev, bucket, id, trimmed, clientMessageId, {
        attachments,
        displayText,
      }),
    );
  };

  // Before a relay (打断重发) aborts + re-sends the queue as a fresh run, revoke
  // every queued draft that was ALREADY auto-steered into the engine. Otherwise
  // the leftover steer entries survive the abort and get consumed by the new
  // run → the same text lands twice (one relay re-send + one steer_injected).
  // This is the queue↔relay seam: cancel() does not clear steerQueueBySid.
  const revokeSteeredForRelay = (bucket: string = activeBucket): void => {
    const engineSessionId = resolveEngineSessionIdForBucket(bucket);
    if (!engineSessionId) return;
    for (const item of queuedInputs[bucket] ?? []) {
      if (!steeredIdsRef.current.has(item.id)) continue;
      void window.codeshell.unsteer(engineSessionId, item.id);
      steeredIdsRef.current.delete(item.id);
    }
  };

  const forceSend = (
    text: string,
    forceOpts: {
      bucket?: string;
      clientMessageId?: string;
      attachments?: InputAttachmentMeta[];
      displayText?: string;
    } = {},
  ): void => {
    const bucket = forceOpts.bucket ?? activeBucket;
    revokeSteeredForRelay(bucket);
    setQueuedInputs((prev) =>
      enqueueQueuedInput(prev, bucket, newQueuedId(), text, forceOpts.clientMessageId, {
        attachments: forceOpts.attachments,
        displayText: forceOpts.displayText,
      }),
    );
    setRelayingBuckets((prev) => new Set(prev).add(bucket));
    stop(bucket, { relay: true });
  };

  const clearActiveQueuedInput = (): void => {
    const ids = (queuedInputs[activeBucket] ?? []).map((i) => i.id);
    setQueuedInputs((prev) => clearQueuedInput(prev, activeBucket));
    const engineSessionId = resolveEngineSessionIdForBucket(activeBucket);
    ids.forEach((id) => {
      steeredIdsRef.current.delete(id);
      injectedSteerIdsRef.current.delete(id);
      // Best-effort revoke any that were already steered; consumed ones are a
      // no-op (removed=false) and will still arrive as bubbles.
      if (engineSessionId) void window.codeshell.unsteer(engineSessionId, id);
    });
    dispatch({ type: "remove_pending_steers", bucket: activeBucket, steerIds: ids });
  };

  const removeActiveQueuedInputAt = (index: number): void => {
    const item = (queuedInputs[activeBucket] ?? [])[index];
    if (!item) return;
    const bucket = activeBucket;
    // Drop BY ID, not index — the queue may shift between click and the async
    // unsteer reply (another item could inject/remove meanwhile).
    const drop = (): void => {
      steeredIdsRef.current.delete(item.id);
      injectedSteerIdsRef.current.delete(item.id);
      dispatch({ type: "remove_pending_steers", bucket, steerIds: [item.id] });
      setQueuedInputs((prev) => removeQueuedInputById(prev, bucket, item.id));
    };
    const engineSessionId = resolveEngineSessionIdForBucket(bucket);
    if (!engineSessionId || !steeredIdsRef.current.has(item.id)) {
      // Never steered (idle queue) — safe to drop immediately.
      drop();
      return;
    }
    // Already steered: ask the engine to revoke. If it was already consumed
    // (removed === false) leave the panel entry — its steer_injected event will
    // turn it into a bubble shortly (静默, no error). rpc() resolves the whole
    // {id, result} envelope, so the flag is at .result.removed.
    void window.codeshell.unsteer(engineSessionId, item.id).then((res) => {
      const removed = (res as { result?: { removed?: boolean } })?.result?.removed;
      if (removed !== false) drop();
    });
  };

  // 全部引导(打断重发): abort the current turn and re-send the WHOLE queued draft
  // merged into one message. Same relay-abort semantics as forceSend — the
  // queue stays put; the !busy auto-send effect drains it as a relay re-send
  // once the abort lands. (Non-interrupting step-boundary injection is now the
  // QUEUE's default — see the auto-send effect — so this button is the explicit
  // INTERRUPT entry, matching the composer 引导 button.)
  const guideActiveQueuedInput = (): void => {
    const queued = queuedInputs[activeBucket];
    if (!queued || queued.length === 0) return;
    revokeSteeredForRelay();
    setRelayingBuckets((prev) => new Set(prev).add(activeBucket));
    stop(activeBucket, { relay: true });
  };

  const stop = (bucketOverride?: string, opts?: { relay?: boolean }): void => {
    // Guard: when wired as a click handler (onClick={stop}) React passes the
    // MouseEvent as the first arg. Only honor a real string override; anything
    // else falls through to the running/active bucket. Without this the event
    // object reaches `bucket.indexOf` and throws — silently breaking Stop.
    const override = typeof bucketOverride === "string" ? bucketOverride : undefined;
    // opts.relay = 引导打断 (handoff to a queued re-send). We still draw the
    // "你在 Ns 后停止了" marker for it now (gives elapsed + keeps the killed turn's
    // content un-collapsed); the relayingBuckets marker set by the caller keeps
    // liveTurnActive lit across the cancel→re-send gap. (relay no longer changes
    // the turn_end dispatch — kept in the signature for call-site clarity.)
    void opts;
    // The composer Stop button belongs to the VIEWED conversation (its
    // visibility is busy=busyKeys.has(activeBucket)), so default to activeBucket
    // — NOT the global runningBucket ref, which points at whichever conversation
    // sent last and would abort the wrong one when two run concurrently.
    const bucket = resolveStopBucket(override, activeBucket, runningBucketRef.current);
    if (!bucket) return;
    const sep = bucket.indexOf("::");
    const uiSessionId = sep > 0 ? bucket.slice(sep + 2) : null;
    const projectBucketSegment = sep > 0 ? bucket.slice(0, sep) : null;
    const projectId =
      projectBucketSegment === NO_REPO_KEY || projectBucketSegment === null
        ? null
        : projectBucketSegment;
    const summary =
      uiSessionId && uiSessionId !== "_none_"
        ? (sessionIndices[projectBucketSegment ?? NO_REPO_KEY]?.sessions.find(
            (s) => s.id === uiSessionId,
          ) ?? loadSessionIndex(projectId).sessions.find((s) => s.id === uiSessionId))
        : undefined;
    const engineSessionId = summary?.engineSessionId ?? uiSessionId ?? undefined;
    window.codeshell.log("stop.click", { bucket, engineSessionId });
    // Fire the cancel IPC, but don't wait for the round-trip — the
    // user pressed Stop and expects the UI to reflect that NOW. Clear
    // busy + routing optimistically; any stream events that arrive
    // after this point are tail-end noise we can drop (the engine has
    // already been told to abort).
    // Manual-stop marker (TODO 2.8): a thin "你在 Ns 后停止了" line, using the
    // turn-start time captured when busy went true. Read BEFORE setBusyForKey
    // clears it.
    const startedAt = busySinceRef.current.get(bucket);
    const elapsedMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
    setBusyForKey(bucket, false);
    if (runningBucketRef.current === bucket) runningBucketRef.current = null;
    // Always mark the interrupted turn — even on the relay (引导接力) path. The
    // "你在 Ns 后停止了" line gives the elapsed time AND tags the turn as stopped,
    // which makes its TurnProcessGroup show its produced content flat (stopped →
    // itemsVisible) instead of collapsing behind the fold header. relay still
    // re-sends the queued input on the next busy=false tick; the turn_end just
    // closes out the killed turn (and clears the streaming pointers, which the
    // relay handoff needs anyway — see appendTurnEndMessage).
    dispatch({ type: "turn_end", bucket, reason: "stopped", elapsedMs });
    void window.codeshell.cancel(engineSessionId);
  };

  const resolveEngineSessionIdForBucket = useCallback(
    (bucket: string): string | undefined => {
      const quickChatSessionId = quickChatSessionIdFromBucket(bucket);
      if (quickChatSessionId) return quickChatSessionId;
      const { projectBucketSegment, projectId, sessionId: uiSessionId } = parsePanelBucket(bucket);
      const summary = uiSessionId
        ? (sessionIndices[projectBucketSegment]?.sessions.find((s) => s.id === uiSessionId) ??
          loadSessionIndex(projectId).sessions.find((s) => s.id === uiSessionId))
        : undefined;
      return summary?.engineSessionId ?? uiSessionId ?? undefined;
    },
    [sessionIndices],
  );

  // Resolve the engine sessionId for the currently-running bucket (same logic
  // stop() uses). Returns undefined when nothing maps.
  const resolveActiveEngineSessionId = (): string | undefined =>
    resolveEngineSessionIdForBucket(runningBucketRef.current ?? activeBucket);

  const setCompactingForKey = (key: string, val: boolean): void => {
    const had = compactingBucketsRef.current.has(key);
    if (had === val) return;
    const next = new Set(compactingBucketsRef.current);
    if (val) next.add(key);
    else next.delete(key);
    compactingBucketsRef.current = next;
    setCompactingBuckets(next);
  };

  const compactActiveSession = (): void => {
    if (busyKeys.has(activeBucket)) {
      toast({ message: t("chat.compact.running"), variant: "error" });
      return;
    }
    if (compactingBucketsRef.current.has(activeBucket)) {
      toast({ message: t("chat.compact.inProgress") });
      return;
    }
    const bucket = activeBucket;
    const engineSessionId = resolveEngineSessionIdForBucket(bucket);
    if (!engineSessionId) {
      toast({ message: t("chat.compact.noSession"), variant: "error" });
      return;
    }
    const promptTokensBefore = state.promptTokens;
    setCompactingForKey(bucket, true);
    void window.codeshell
      .compactSession(engineSessionId)
      .then((result) => {
        const data = result.data;
        if (compactWasNoop(data)) {
          toast({
            message: compactOutcomeMessage(data, t, lang),
            variant: "success",
          });
          return;
        }
        dispatch({
          type: "stream",
          bucket,
          event: {
            type: "usage_update",
            promptTokens: compactPromptTokensWithBaseline(data, promptTokensBefore),
          } as StreamEvent,
        });
      })
      .catch((e) => {
        toast({
          message: t("chat.compact.failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
          variant: "error",
        });
      })
      .finally(() => setCompactingForKey(bucket, false));
  };

  // Extend the running goal (TODO 3.1). Fired by the "approaching limit" extend
  // button; opts target whichever ceiling is closest (turns or stop-blocks).
  const extendGoal = (opts: {
    addTurns?: number;
    addStopBlocks?: number;
    addTokenBudget?: number;
    addTimeBudgetMs?: number;
  }): void => {
    const engineSessionId = resolveEngineSessionIdForBucket(activeBucket);
    if (!engineSessionId) return;
    void window.codeshell
      .goalExtend(engineSessionId, opts)
      .catch((e) => window.codeshell.log("goal.extend.failed", { error: String(e) }));
  };

  const decideEnvelope = (
    env: ApprovalRequestEnvelope,
    decision: "approve" | "deny",
    reason?: string,
    scope?: ApproveChoice,
    pathScope?: ApprovePathScope,
  ): void => {
    // Multi-session: thread engine sessionId so the worker routes the
    // decision back to the right session's pendingApprovals map. `scope`
    // (once/session/project) + `pathScope` (file/dir/tool, file tools) only
    // ride along on approve; deny ignores them.
    const approveScope = decision === "approve" ? scope : undefined;
    const approvePathScope = decision === "approve" ? pathScope : undefined;
    if (env.sessionId) {
      // (sessionId, requestId, decision, reason, answer, scope, pathScope)
      void window.codeshell.approve(
        env.sessionId,
        env.requestId,
        decision,
        reason,
        undefined,
        approveScope,
        approvePathScope,
      );
    } else {
      // Legacy (requestId, decision, reason, answer, scope, pathScope)
      void window.codeshell.approve(
        env.requestId,
        decision,
        reason,
        undefined,
        approveScope,
        approvePathScope,
      );
    }
    void window.codeshell.mobileRemote.notifyApprovalResolved({
      requestId: env.requestId,
      sessionId: env.sessionId,
      approved: decision === "approve",
    });
    approvalBucketsRef.current.delete(env.requestId);
    // The card itself gives instant optimistic feedback via its own local
    // state (ApprovalCard `decided`), so the user never waits on this root-App
    // re-render. Time the synchronous state churn anyway: if a future large
    // session makes the App re-render janky on click, perf.approval.decide will
    // surface it (no-op when perf logging is off). See the 2026-06-07 approval-
    // scope spec / debugging note: IPC is fire-and-forget and the stream build
    // is memoized, so this state update is the only synchronous work on click.
    timePhase("approval.decide", () => {
      // Compute the post-decision queue ONCE here. Reading `approvalQueue` from
      // render scope inside the setApproval updater would see the STALE pre-filter
      // value (the setApprovalQueue update above is batched and not yet committed),
      // so with multiple queued approvals the "next" lookup could surface an
      // already-decided one or skip the next. Derive both updates from this single
      // filtered list instead.
      const remaining = approvalQueue.filter((e) => e.requestId !== env.requestId);
      setApprovalQueue(remaining);
      setApprovalHistory((h) => [...h, { decision, envelope: env, reason, at: Date.now() }]);
      setApproval((cur) => {
        if (!cur || cur.requestId === env.requestId) {
          return remaining[0] ?? null;
        }
        return cur;
      });
    });
  };

  const showWelcome = state.messages.length === 0;
  const visibleApproval =
    approval && approvalBucketsRef.current.get(approval.requestId) === activeBucket
      ? approval
      : null;
  const approvalForBucket = (bucket: string): ApprovalRequestEnvelope | null =>
    approvalQueue.find((env) => approvalBucketsRef.current.get(env.requestId) === bucket) ?? null;

  const setViewMode = (v: ViewMode): void => setView((prev) => ({ ...prev, viewMode: v }));

  return {
    send,
    sendQuickChat,
    queueInput,
    forceSend,
    clearActiveQueuedInput,
    removeActiveQueuedInputAt,
    guideActiveQueuedInput,
    stop,
    resolveEngineSessionIdForBucket,
    resolveActiveEngineSessionId,
    compactActiveSession,
    extendGoal,
    decideEnvelope,
    showWelcome,
    visibleApproval,
    approvalForBucket,
    setViewMode,
  };
}
