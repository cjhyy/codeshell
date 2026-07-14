import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { bgCompletionText, type ApprovalState, type AskUserOption } from "../types";
import type { TranscriptsAction, TranscriptsMap } from "../transcriptsReducer";
import {
  bindEngineSession,
  bucketKey,
  loadSessionIndex,
  NO_REPO_KEY,
  projectBucketSegment as projectBucketSegmentFor,
  renameSessionLocal,
  touchSession,
  updateSessionRunStatus,
  upsertImportedSession,
  type SessionIndex,
} from "../transcripts";
import { findAskUserOrigin, resolveBucket } from "../streamRouting";
import { removeQueuedInputById, type QueuedInputState } from "../queuedInput";
import { createEventCoalescer } from "../streamCoalescer";
import type { PermissionMode } from "../chat/PermissionPill";
import {
  isQuickChatBucket,
  isQuickChatSessionId,
  type QuickChatSessionRef,
} from "../quickChatSession";
import { makeCreateProjectForCwd, loadProjects, type TrackedProject } from "../projects";
import { placeLiveAutomationSession } from "../automation/liveSession";
import { planDiskRebuild } from "../automation/rebuildFromDisk";
import { isCaseInsensitivePlatform } from "../automation/pathMatch";
import { resolveProjectCwd } from "./useAutomationSessionImport";
import { fromMobilePermissionMode, stablePromptHash } from "./appUtils";
import { titleFromWire } from "../chat/attachments";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import type {
  AgentLifecycleEvent,
  ApprovalRequestEnvelope,
  ApprovalResolvedEnvelope,
  MobilePermissionModeEnvelope,
  StreamEventEnvelope,
} from "../../preload/types";

interface Params {
  services: {
    toast: ReturnType<typeof useToast>;
    t: ReturnType<typeof useT>["t"];
    dispatch: Dispatch<TranscriptsAction>;
  };
  routing: {
    coalescersRef: MutableRefObject<Map<string, ReturnType<typeof createEventCoalescer>>>;
    coalescerSeqRef: MutableRefObject<Map<string, number>>;
    appliedSeqRef: MutableRefObject<Map<string, number>>;
    engineToBucketRef: MutableRefObject<Map<string, string>>;
    sessionIndicesRef: MutableRefObject<Record<string, SessionIndex>>;
    runningBucketRef: MutableRefObject<string | null>;
    injectedSteerIdsRef: MutableRefObject<Set<string>>;
    steeredIdsRef: MutableRefObject<Set<string>>;
    activeBucketRef: MutableRefObject<string>;
    quickChatSessionsRef: MutableRefObject<Record<string, QuickChatSessionRef>>;
    transcriptsRef: MutableRefObject<TranscriptsMap>;
  };
  permissions: {
    approvalBucketsRef: MutableRefObject<Map<string, string>>;
    permissionForBucketRef: MutableRefObject<(bucket: string) => PermissionMode | null>;
    defaultPermissionModeRef: MutableRefObject<PermissionMode | null>;
    setApprovalQueue: Dispatch<SetStateAction<ApprovalRequestEnvelope[]>>;
    setApproval: Dispatch<SetStateAction<ApprovalState>>;
    setPermissionOverrides: Dispatch<SetStateAction<Record<string, PermissionMode>>>;
  };
  sessions: {
    setQueuedInputs: Dispatch<SetStateAction<QueuedInputState>>;
    setUnreadBuckets: Dispatch<SetStateAction<Set<string>>>;
    setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
    setProjects: Dispatch<SetStateAction<TrackedProject[]>>;
  };
  activity: {
    mobileAnnounceSeqRef: MutableRefObject<number>;
    setBusyForKey: (key: string, value: boolean) => void;
    setLifecycle: Dispatch<SetStateAction<string | null>>;
    setBusyKeys: Dispatch<SetStateAction<Set<string>>>;
  };
}

/** Owns long-lived worker/mobile IPC subscriptions and stream coalescing. */
export function useHostSubscriptions({
  services,
  routing,
  permissions,
  sessions,
  activity,
}: Params): void {
  const { toast, t, dispatch } = services;
  const {
    coalescersRef,
    coalescerSeqRef,
    appliedSeqRef,
    engineToBucketRef,
    sessionIndicesRef,
    runningBucketRef,
    injectedSteerIdsRef,
    steeredIdsRef,
    activeBucketRef,
    quickChatSessionsRef,
    transcriptsRef,
  } = routing;
  const {
    approvalBucketsRef,
    permissionForBucketRef,
    defaultPermissionModeRef,
    setApprovalQueue,
    setApproval,
    setPermissionOverrides,
  } = permissions;
  const { setQueuedInputs, setUnreadBuckets, setSessionIndices, setProjects } = sessions;
  const { mobileAnnounceSeqRef, setBusyForKey, setLifecycle, setBusyKeys } = activity;
  useEffect(() => {
    const coalescers = coalescersRef.current;
    return () => {
      for (const c of coalescers.values()) c.dispose();
      coalescers.clear();
      coalescerSeqRef.current.clear();
    };
  }, []);

  function getCoalescer(bucket: string) {
    let c = coalescersRef.current.get(bucket);
    if (!c) {
      c = createEventCoalescer((events) => {
        const maxSeq = coalescerSeqRef.current.get(bucket);
        coalescerSeqRef.current.delete(bucket);
        if (maxSeq !== undefined) {
          const prev = appliedSeqRef.current.get(bucket) ?? 0;
          appliedSeqRef.current.set(bucket, Math.max(prev, maxSeq));
        }
        dispatch({ type: "stream_batch", bucket, events, maxSeq });
      });
      coalescersRef.current.set(bucket, c);
    }
    return c;
  }

  useEffect(() => {
    window.codeshell.log("app.mount", { codeshellKeys: Object.keys(window.codeshell ?? {}) });

    const offStream = window.codeshell.onStreamEvent((env: StreamEventEnvelope) => {
      const event = env.event;
      if (event.type === "background_agent_completed") {
        toast({
          message: bgCompletionText(event),
          variant:
            event.status === "completed"
              ? "success"
              : event.status === "cancelled"
                ? undefined
                : "error",
        });
        // fall through: the reducer still appends the system message below.
      }
      // Multi-session routing: every envelope carries the engine sessionId.
      // We mirror engineSessionId → bucket in a ref so stream events route to
      // the right tab even when several runs are in flight at once. Fallback
      // to the single runningBucketRef only for legacy / pre-bind events
      // (engineSessionId empty or not yet in the table).
      // Route the event to its UI bucket. On a route-table miss (e.g. after a
      // renderer remount wiped the in-memory table while a worker kept resuming
      // the same engine session), resolveBucket reverse-looks-up the engine
      // sessionId in the on-disk indices instead of dropping the event.
      const target = resolveBucket(
        env.sessionId ?? "",
        engineToBucketRef.current,
        sessionIndicesRef.current,
        runningBucketRef.current,
      );
      if (!target) {
        if ((event.type === "turn_complete" || event.type === "error") && !event.agentId) {
          const runningBucket = runningBucketRef.current;
          if (runningBucket) {
            setBusyForKey(runningBucket, false);
            runningBucketRef.current = null;
          }
        }
        return;
      }
      // Backfill the route table so subsequent events for this session take the
      // fast path (and so turn_complete/error below can clear the right bucket).
      if (env.sessionId && !engineToBucketRef.current.has(env.sessionId)) {
        engineToBucketRef.current.set(env.sessionId, target);
      }

      // steer_injected: the engine just spliced a queued draft into the running
      // turn. Now (and only now) remove it from the panel — the coalescer will
      // also feed this event to the reducer, which renders it as a user bubble.
      // This is the insert-time ↔ display-time decoupling: the item was visible
      // and revocable until this confirmation arrived.
      if (event.type === "steer_injected" && event.id) {
        const id = event.id;
        injectedSteerIdsRef.current.add(id);
        steeredIdsRef.current.delete(id);
        setQueuedInputs((prev) => removeQueuedInputById(prev, target, id));
      }

      const noisy =
        event.type === "text_delta" ||
        event.type === "tool_use_args_delta" ||
        event.type === "usage_update" ||
        event.type === "thinking_delta";
      if (!noisy) {
        window.codeshell.log("stream.event", {
          type: event.type,
          bucket: target,
          engineSessionId: env.sessionId || null,
        });
      }
      if (typeof env.seq === "number") {
        const prev = coalescerSeqRef.current.get(target) ?? 0;
        coalescerSeqRef.current.set(target, Math.max(prev, env.seq));
      }
      getCoalescer(target).push(event);

      // session_started carries the authoritative engine sessionId. Persist
      // the binding (engineSessionId == uiSessionId is the new normal, but
      // older sessions on disk may differ) and seed the routing table.
      if (event.type === "session_started") {
        // session_started fires once at the start of every run() — including a
        // run the renderer DIDN'T initiate, e.g. core waking an idle session
        // when a background shell (download) finishes. The send() path already
        // set busy (idempotent here); but a core-initiated wakeup never went
        // through send(), so this is the only point the composer learns "a turn
        // is now running" and shows the working spinner. turn_complete (below)
        // clears it. (session_started carries no agentId, so it's always the
        // top-level run, never a sub-agent.)
        setBusyForKey(target, true);
        if (isQuickChatBucket(target)) {
          engineToBucketRef.current.set(event.sessionId, target);
          return;
        }
        const sep = target.indexOf("::");
        if (sep > 0) {
          const projectBucketSegment = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const projectId = projectBucketSegment === NO_REPO_KEY ? null : projectBucketSegment;
          if (uiSessionId && uiSessionId !== "_none_") {
            engineToBucketRef.current.set(event.sessionId, target);
            const nextIdx = bindEngineSession(projectId, uiSessionId, event.sessionId);
            setSessionIndices((prev) => ({ ...prev, [projectBucketSegment]: nextIdx }));
          }
        }
      }

      // session_title: LLM-generated sidebar title (first turn only).
      // Reuse the session_started bucket-parse pattern. Never clobber a
      // manual rename (titleManual flag set by handleRenameSession).
      if (event.type === "session_title") {
        if (isQuickChatBucket(target)) return;
        const sep = target.indexOf("::");
        if (sep > 0) {
          const projectBucketSegment = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const projectId = projectBucketSegment === NO_REPO_KEY ? null : projectBucketSegment;
          if (uiSessionId && uiSessionId !== "_none_") {
            setSessionIndices((prev) => {
              const cur = prev[projectBucketSegment]?.sessions.find((s) => s.id === uiSessionId);
              if (!cur || cur.titleManual) return prev; // never clobber manual rename
              const next = renameSessionLocal(projectId, uiSessionId, event.title);
              return { ...prev, [projectBucketSegment]: next };
            });
          }
        }
      }

      // A *sub-agent's* turn_complete / error carries an agentId (engine.ts
      // injects it into every child stream event). It must NOT clear the main
      // bucket's busy flag, mark it unread, or terminate the automation run —
      // the parent turn is still running and will emit its own (agentId-less)
      // turn_complete when it actually finishes. Treating the child's
      // turn_complete as the parent's flipped the top-bar/sidebar to "完成"
      // (idle) mid-run while the agent kept working. The per-agent card's own
      // done state is handled separately in the reducer via `agent_end`.
      if ((event.type === "turn_complete" || event.type === "error") && !event.agentId) {
        setBusyForKey(target, false);
        // A turn just finished → its file edits have landed on disk. Nudge the
        // Files panel to re-read the file it's previewing (and refresh its
        // tree): the panel reads a file once on select and otherwise never sees
        // external writes, so an AI edit to the open file would show stale until
        // re-selected. Fire-and-forget DOM event (same channel style as
        // codeshell:open-file); FilesPanel decides whether it's viewing an
        // affected path.
        window.dispatchEvent(new CustomEvent("codeshell:files-changed"));
        // A turn finished in a bucket the user is NOT looking at → mark unread
        // so the sidebar shows a dot. Read the active bucket from the ref (not
        // a captured `activeBucket`): this onStreamEvent callback is registered
        // once and would otherwise close over a stale value.
        if (target !== activeBucketRef.current) {
          setUnreadBuckets((prev) => {
            if (prev.has(target)) return prev;
            const next = new Set(prev);
            next.add(target);
            return next;
          });
        }
        // Don't null runningBucketRef here — another concurrent send may
        // still be using it as a fallback. The ref is only a soft hint;
        // engineToBucketRef is the authoritative routing for in-flight runs.

        // Flip a live automation session's runStatus from its frozen "running"
        // to a terminal state. Without this it stays "running" forever, which
        // (a) makes delete treat a long-finished run as in-flight, and (b)
        // keeps it out of the backfill dedup skip-set. Find the owning session
        // by engineSessionId (== local id for automation imports) and update it.
        if (env.sessionId) {
          const eid = env.sessionId;
          const projectsNow = loadProjects();
          for (const rid of [null as string | null, ...projectsNow.map((project) => project.id)]) {
            const owner = loadSessionIndex(rid).sessions.find(
              (s) => s.source === "automation" && s.engineSessionId === eid,
            );
            if (owner) {
              const nextIdx = updateSessionRunStatus(
                rid,
                owner.id,
                event.type === "error" ? "failed" : "completed",
              );
              setSessionIndices((prev) => ({ ...prev, [projectBucketSegmentFor(rid)]: nextIdx }));
              break;
            }
          }
        }
      }
    });
    // Live automation session: main announces {sessionId, cwd, title} once when
    // an in-main automation run emits session_started. Stream events carry no
    // cwd, so without this the run can't be attributed to a project until the
    // next startup disk-backfill. We create the sidebar session immediately
    // (reusing the source:"automation" import machinery) and register the route
    // so this run's subsequent stream events land in the right bucket.
    const offAutomationSession = window.codeshell.onAutomationSession((meta) => {
      window.codeshell.log("automation.session.announce", {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
      });
      // Idempotency: if any repo already has this engine session (a prior
      // announce, or a disk-backfilled import), don't duplicate.
      const projectsNow = loadProjects();
      const alreadyKnown = [
        null as string | null,
        ...projectsNow.map((project) => project.id),
      ].some((rid) =>
        loadSessionIndex(rid).sessions.some((s) => s.engineSessionId === meta.sessionId),
      );
      if (alreadyKnown) {
        // Still (re)register the route in case the table was wiped by a remount.
        const knownProjectId =
          [null as string | null, ...projectsNow.map((project) => project.id)].find((rid) =>
            loadSessionIndex(rid).sessions.some((s) => s.engineSessionId === meta.sessionId),
          ) ?? null;
        engineToBucketRef.current.set(meta.sessionId, bucketKey(knownProjectId, meta.sessionId));
        return;
      }
      void (async () => {
        const resolvedMeta = {
          ...meta,
          cwd: await resolveProjectCwd(meta.cwd),
        };
        const projectsAfterResolve = loadProjects();
        const existingProjectId = [
          null as string | null,
          ...projectsAfterResolve.map((project) => project.id),
        ].find((rid) =>
          loadSessionIndex(rid).sessions.some((s) => s.engineSessionId === meta.sessionId),
        );
        if (existingProjectId !== undefined) {
          engineToBucketRef.current.set(
            meta.sessionId,
            bucketKey(existingProjectId, meta.sessionId),
          );
          return;
        }
        const projectFactory = makeCreateProjectForCwd(projectsAfterResolve);
        const placement = placeLiveAutomationSession(resolvedMeta, projectsAfterResolve, {
          caseInsensitive: isCaseInsensitivePlatform(),
          createProjectForCwd: projectFactory.createProjectForCwd,
        });
        if (!placement) return;
        const { projectId, summary } = placement;
        const nextIdx = upsertImportedSession(projectId, summary);
        const bucket = bucketKey(projectId, summary.id);
        // Register the route so this run's stream events (already arriving) bucket
        // correctly. The session_started handler's reverse-lookup would also find
        // it now that it's on disk, but setting the fast path is cheap.
        engineToBucketRef.current.set(meta.sessionId, bucket);
        // Mark the bucket busy NOW so the sidebar shows the running spinner
        // immediately. Automation never goes through send() (it runs headless in
        // main), so without this the run-now session would sit with no status
        // indicator until — and only ever — turn_complete, which then clears busy
        // and (if off-screen) flips it to the unread dot. The announce arrives
        // before this run's session_started stream event (automation-host emits
        // onSession() then emit() on the same ordered channel), so no turn_complete
        // can clear this before we set it. asking>running>unread precedence then
        // matches interactive chat.
        setBusyForKey(bucket, true);
        // Show the triggering prompt as the opening user message. Automation never
        // goes through send() (it runs in main), so without this the live UI would
        // open straight into the assistant's reply with no visible question. Only
        // on first placement (re-announce hits the alreadyKnown early-return above),
        // so the bubble isn't duplicated.
        if (meta.prompt.trim()) {
          const clientMessageId =
            meta.clientMessageId ??
            `automation:${meta.sessionId}:${stablePromptHash(meta.prompt.trim())}`;
          dispatch({ type: "user_message", bucket, text: meta.prompt, clientMessageId });
        }
        if (projectFactory.changed()) setProjects(projectsAfterResolve.slice());
        setSessionIndices((prev) => ({ ...prev, [projectBucketSegmentFor(projectId)]: nextIdx }));
      })();
    });
    const offMobileSession = window.codeshell.onMobileSession((meta) => {
      window.codeshell.log("mobile.session.announce", {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
      });
      const projectsNow = loadProjects();
      const knownProjectId =
        [null as string | null, ...projectsNow.map((project) => project.id)].find((rid) =>
          loadSessionIndex(rid).sessions.some(
            (s) => s.engineSessionId === meta.sessionId || s.id === meta.sessionId,
          ),
        ) ?? undefined;
      const known =
        knownProjectId !== undefined
          ? loadSessionIndex(knownProjectId).sessions.find(
              (s) => s.engineSessionId === meta.sessionId || s.id === meta.sessionId,
            )
          : undefined;

      let projectId: string | null;
      let sessionId: string;
      let nextIdx: SessionIndex;
      const title = titleFromWire(meta.prompt || meta.title || meta.sessionId);

      if (known) {
        projectId = knownProjectId ?? null;
        sessionId = known.id;
        nextIdx = touchSession(projectId, sessionId, title);
      } else {
        const projectFactory = makeCreateProjectForCwd(projectsNow);
        const now = Date.now();
        const [placement] = planDiskRebuild(
          [
            {
              id: meta.sessionId,
              engineSessionId: meta.sessionId,
              cwd: meta.cwd,
              title,
              updatedAt: now,
              origin: "desktop",
            },
          ],
          projectsNow,
          {
            caseInsensitive: isCaseInsensitivePlatform(),
            createProjectForCwd: projectFactory.createProjectForCwd,
          },
        );
        if (!placement) return;
        projectId = placement.projectId;
        sessionId = placement.summary.id;
        nextIdx = upsertImportedSession(projectId, {
          ...placement.summary,
          title,
          createdAt: now,
          updatedAt: now,
        });
        if (projectFactory.changed()) setProjects(projectsNow.slice());
      }

      const bucket = bucketKey(projectId, sessionId);
      engineToBucketRef.current.set(meta.sessionId, bucket);
      setBusyForKey(bucket, true);
      if (meta.prompt.trim()) {
        let clientMessageId = meta.clientMessageId;
        if (!clientMessageId) {
          mobileAnnounceSeqRef.current += 1;
          const fallbackTurnId = `${Date.now().toString(36)}-${mobileAnnounceSeqRef.current.toString(36)}`;
          clientMessageId = `mobile:${meta.sessionId}:fallback-${fallbackTurnId}:${stablePromptHash(
            meta.prompt.trim(),
          )}`;
        }
        dispatch({ type: "user_message", bucket, text: meta.prompt, clientMessageId });
      }
      setSessionIndices((prev) => ({ ...prev, [projectBucketSegmentFor(projectId)]: nextIdx }));
    });
    const offApproval = window.codeshell.onApprovalRequest((env: ApprovalRequestEnvelope) => {
      window.codeshell.log("approval.request", {
        requestId: env.requestId,
        toolName: env.request.toolName,
        engineSessionId: env.sessionId ?? null,
      });
      let resolved = resolveBucket(
        env.sessionId ?? "",
        engineToBucketRef.current,
        sessionIndicesRef.current,
        runningBucketRef.current,
      );
      if (!resolved && env.sessionId && isQuickChatSessionId(env.sessionId)) {
        resolved =
          Object.values(quickChatSessionsRef.current).find(
            (session) => session.sessionId === env.sessionId,
          )?.bucket ?? null;
        if (!resolved) {
          // The quick-chat claim/generation is gone (closed or replaced).
          // Never project its late approval into the active parent/child UI.
          // Best-effort deny also releases a still-pending core request.
          const reason = "quick chat is no longer active";
          void window.codeshell
            .approve(env.sessionId, env.requestId, "deny", reason)
            .catch((error) =>
              window.codeshell.log("quick_chat.late_approval_deny_failed", {
                sessionId: env.sessionId,
                requestId: env.requestId,
                error: String(error),
              }),
            );
          void window.codeshell.mobileRemote.notifyApprovalResolved({
            requestId: env.requestId,
            sessionId: env.sessionId,
            approved: false,
          });
          return;
        }
      }
      // AskUserQuestion is delivered through the same channel as tool
      // approvals (toolName === "__ask_user__"). Route it into the chat
      // stream as an inline AskUserMessage instead of the approval modal
      // so the user picks an answer inline — much less disruptive than
      // a blocking dialog.
      if (env.request.toolName === "__ask_user__") {
        const args = (env.request.args ?? {}) as Record<string, unknown>;
        const question =
          (typeof args.question === "string" && args.question) || env.request.description || "";
        const header = typeof args.header === "string" ? args.header : undefined;
        const multiSelect = args.multiSelect === true;
        const optionsOnly = args.optionsOnly === true;
        const options = Array.isArray(args.options)
          ? (args.options as unknown[])
              .filter(
                (o): o is { label: string; description: string; tone?: unknown } =>
                  !!o &&
                  typeof o === "object" &&
                  typeof (o as Record<string, unknown>).label === "string" &&
                  typeof (o as Record<string, unknown>).description === "string",
              )
              .map((o): AskUserOption => {
                const tone: AskUserOption["tone"] =
                  o.tone === "ok" || o.tone === "danger" || o.tone === "neutral"
                    ? o.tone
                    : undefined;
                return { label: o.label, description: o.description, ...(tone ? { tone } : {}) };
              })
          : undefined;
        // Resolve the ORIGINATING session's bucket via the shared resolver
        // (live table → on-disk index reverse lookup → runningBucket only when
        // there's no sessionId). When a sessionId is present but unresolvable
        // (cold table + not yet in the index), a normal persisted session keeps
        // the legacy active-bucket fallback so the user still sees the prompt.
        // Unknown quick-chat ids were already rejected above. Either way carry
        // env.sessionId so the answer routes back to the originating session.
        if (env.sessionId && !resolved) {
          console.warn(
            "[ask_user] could not resolve bucket for session; rendering in active bucket",
            env.sessionId,
          );
        }
        const bucket = resolved ?? activeBucketRef.current;
        dispatch({
          type: "ask_user",
          bucket,
          requestId: env.requestId,
          engineSessionId: env.sessionId,
          question,
          header,
          options,
          multiSelect,
          optionsOnly,
        });
        return;
      }
      // 完全访问权限 (bypass): auto-approve any request that reaches the
      // renderer for this bucket. The engine's bypassPermissions backend
      // already approves everything, so requests rarely surface here; this
      // is belt-and-braces so "full access" never silently blocks on a
      // modal. Resolve the request's OWN bucket (not the active one) —
      // concurrent runs may target a different tab.
      if (env.sessionId && !resolved) {
        console.warn(
          "[approval] could not resolve bucket for session; rendering in active bucket",
          env.sessionId,
        );
      }
      const targetBucket = resolved ?? activeBucketRef.current;
      if (permissionForBucketRef.current(targetBucket) === "bypass") {
        if (env.sessionId) {
          void window.codeshell.approve(env.sessionId, env.requestId, "approve");
        } else {
          void window.codeshell.approve(env.requestId, "approve");
        }
        void window.codeshell.mobileRemote.notifyApprovalResolved({
          requestId: env.requestId,
          sessionId: env.sessionId,
          approved: true,
        });
        return;
      }
      approvalBucketsRef.current.set(env.requestId, targetBucket);
      setApprovalQueue((q) => [...q, env]);
      setApproval((cur) => cur ?? env);
    });
    const offApprovalResolved = window.codeshell.onApprovalResolved(
      (env: ApprovalResolvedEnvelope) => {
        if (!env.requestId) return;
        // A server-initiated resolve (e.g. a goal-mode AskUserQuestion that timed
        // out with nobody answering) must also retire the inline ask_user card,
        // which lives in the transcript — not just the approval modal queue below.
        // A user-driven answer already marks it via handleAskUserAnswer, so only
        // touch a card that's still unanswered here.
        const origin = findAskUserOrigin(transcriptsRef.current, env.requestId);
        if (origin && origin.answer === undefined) {
          dispatch({
            type: "ask_user_answered",
            bucket: origin.bucket,
            requestId: env.requestId,
            answer: t("msg.ask.timedOut"),
          });
        }
        approvalBucketsRef.current.delete(env.requestId);
        setApprovalQueue((prev) => {
          const remaining = prev.filter((e) => e.requestId !== env.requestId);
          setApproval((cur) => {
            if (!cur || cur.requestId === env.requestId) return remaining[0] ?? null;
            return cur;
          });
          return remaining;
        });
      },
    );
    const offMobilePermissionMode = window.codeshell.onMobilePermissionMode(
      (env: MobilePermissionModeEnvelope) => {
        if (!env.sessionId) return;
        const bucketFromRoute =
          engineToBucketRef.current.get(env.sessionId) ||
          resolveBucket(
            env.sessionId,
            engineToBucketRef.current,
            sessionIndicesRef.current,
            runningBucketRef.current,
          );
        let bucket = bucketFromRoute;
        if (!bucket) {
          for (const [projectBucketSegment, index] of Object.entries(sessionIndicesRef.current)) {
            const summary = index.sessions.find((s) => s.id === env.sessionId);
            if (summary) {
              bucket = bucketKey(
                projectBucketSegment === NO_REPO_KEY ? null : projectBucketSegment,
                summary.id,
              );
              break;
            }
          }
        }
        if (!bucket) return;
        const mode = fromMobilePermissionMode(env.mode);
        setPermissionOverrides((prev) => {
          if (mode === defaultPermissionModeRef.current) {
            const { [bucket]: _removed, ...rest } = prev;
            return rest;
          }
          return { ...prev, [bucket]: mode };
        });
      },
    );
    const offStatus = window.codeshell.onStatus((evt) => {
      window.codeshell.log("status", evt as Record<string, unknown>);
    });
    const offLifecycle = window.codeshell.onAgentLifecycle((evt: AgentLifecycleEvent) => {
      window.codeshell.log("lifecycle", evt as Record<string, unknown>);
      if (evt.type === "restarted") setLifecycle("Agent restarted.");
      else if (evt.type === "gave_up")
        setLifecycle("Agent crashed too many times. Quit and reopen.");
      else if (evt.type === "exited") {
        if (evt.code === 0) setLifecycle(null);
        else setLifecycle(`Agent exited (code ${evt.code}).`);
        // Worker died — every in-flight run is dead with it. Clear busy
        // for *all* buckets we have routes for, not just the latest ref.
        const inflight = Array.from(engineToBucketRef.current.values());
        if (inflight.length > 0) {
          setBusyKeys((prev) => {
            const next = new Set(prev);
            for (const b of inflight) next.delete(b);
            return next;
          });
        }
        runningBucketRef.current = null;
        // Do NOT clear engineToBucketRef here. The worker exits cleanly after
        // every run (and may later respawn + resume the same engine session),
        // so wiping the route table on exit is exactly what made resumed-
        // session events miss their bucket and get dropped (blank UI). The
        // bucket↔session bindings belong to the session, not the worker
        // lifecycle, and are safe to keep — resolveBucket reconciles against
        // on-disk indices anyway.
      }
    });
    return () => {
      offStream();
      offAutomationSession();
      offMobileSession();
      offApproval();
      offApprovalResolved();
      offMobilePermissionMode();
      offStatus();
      offLifecycle();
    };
    // `toast` from useToast is a stable reference (memoized in ToastProvider),
    // so listing it here does not re-register these long-lived IPC listeners.
  }, [toast]);

  useEffect(() => {
    const off = window.codeshell.onWorktreeCleanupSkipped((event) => {
      const count = Array.isArray(event.skipped) ? event.skipped.length : 0;
      if (count <= 0) return;
      toast({
        message: t("misc.worktree.cleanupSkipped", { count }),
        variant: "error",
      });
    });
    return off;
  }, [toast, t]);
}
