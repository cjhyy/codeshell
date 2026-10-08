/** Frozen instruction resolution and derived-context persistence, independent of Engine run slots. */
import { realpathSync } from "node:fs";
import { Transcript } from "../session/transcript.js";
import type { SessionBundle, SessionManager } from "../session/session-manager.js";
import type {
  InstructionBindingProvider,
  InstructionSnapshot,
} from "../skills/instruction-bindings.js";

/** Returns true only when the current owner's derived context was cleared. */
export function clearSessionInstructionContext({
  session,
  sessionManager,
  expectedRunId,
  bindings,
  retainedSnapshots,
}: {
  session: SessionBundle;
  sessionManager: SessionManager;
  expectedRunId: string | undefined;
  bindings: readonly InstructionBindingProvider[];
  retainedSnapshots?: InstructionSnapshot[];
}): boolean {
  const latest = sessionManager.readSessionState(session.state.sessionId);
  if (!latest) throw new Error("Could not read instruction context owner");
  // A former Engine's idle watch must not clear a newer run's accepted configuration.
  if (latest.runId !== expectedRunId) return false;
  retainedSnapshots ??= (session.state.instructionSnapshots ?? []).filter((snapshot) =>
    bindings.some((provider) => provider.isCurrent(snapshot)),
  );
  const hadInstructionContext = session.state.instructionContextStartEventId !== undefined;
  // A frozen but currently disabled revision has no derived context to discard.
  // Preserve the ordinary replies produced after its earlier context was cleared.
  if (hadInstructionContext) {
    const events = session.transcript.getEvents();
    const start = events.findIndex(
      (event) => event.id === session.state.instructionContextStartEventId,
    );
    const retainedEvents = events.filter(
      (event, index) =>
        (start >= 0 && index < start) ||
        (event.type === "message" &&
          event.data.role === "user" &&
          event.data.injected !== true &&
          event.data.authority !== "agent"),
    );
    const retained = Transcript.fromMemoryEvents(
      "instruction-revocation",
      retainedEvents,
    ).toMessagesWithIndex();
    const through = events.at(-1);
    if (through) {
      const note = session.transcript.appendContextNote(
        "Instruction revision revoked; prior effective context cleared.",
        through.id,
      );
      if (
        !note ||
        !session.transcript.appendContextCheckpoint({
          version: 1,
          noteId: note.id,
          coveredThroughEventId: through.id,
          messages: retained.messages.length
            ? retained.messages
            : [
                {
                  role: "user",
                  content: "Instruction revision revoked; continue only from new user input.",
                },
              ],
          clientMessageIds: [...retained.liveIndexByClientMessageId],
        })
      )
        throw new Error("Could not clear revoked instruction context");
    }
  }
  session.state.instructionContextStartEventId = undefined;
  session.state.instructionContextRevisions = [];
  session.state.instructionSnapshots = retainedSnapshots;
  if (hadInstructionContext) {
    session.state.invokedSkills = [];
    session.state.contextUsageAnchor = undefined;
  }
  if (
    !sessionManager.saveStateOrUpdateFields(
      session.state,
      {
        instructionSnapshots: retainedSnapshots,
        instructionContextStartEventId: undefined,
        instructionContextRevisions: [],
        ...(hadInstructionContext ? { invokedSkills: [], contextUsageAnchor: undefined } : {}),
      },
      expectedRunId,
    )
  )
    throw new Error("Could not persist cleared instruction context");
  return hadInstructionContext;
}

/** Resolve frozen bodies and the current run's effective set before any model request. */
export function prepareInstructionContext({
  session,
  sessionManager,
  runId,
  cwd,
  provider,
  model,
  bindings,
  trustedSnapshots,
  resumedFromDisk,
  disableInstructions,
  disabledSkills,
  disabledPlugins,
  skillAllowlist,
  clearContext,
}: {
  session: SessionBundle;
  sessionManager: SessionManager;
  runId: string;
  cwd: string;
  provider: string;
  model: string;
  bindings: readonly InstructionBindingProvider[];
  trustedSnapshots?: readonly InstructionSnapshot[];
  resumedFromDisk: boolean;
  disableInstructions?: boolean;
  disabledSkills?: readonly string[];
  disabledPlugins?: readonly string[];
  skillAllowlist?: readonly string[];
  clearContext: (retained?: InstructionSnapshot[]) => void;
}): { snapshots: InstructionSnapshot[]; contextCleared: boolean } {
  let contextCleared = false;
  const isInstructionCurrent = (snapshot: InstructionSnapshot) =>
    snapshot.cwd === realpathSync(cwd) &&
    (!snapshot.sessionId || snapshot.sessionId === session.state.sessionId) &&
    bindings.some((binding) => binding.isCurrent(snapshot));
  if (
    session.state.instructionSnapshots?.some((snapshot) => !isInstructionCurrent(snapshot)) &&
    !trustedSnapshots
  ) {
    clearContext(session.state.instructionSnapshots.filter(isInstructionCurrent));
    contextCleared = true;
  }
  if (session.state.instructionSnapshots === undefined) {
    session.state.instructionSnapshots = trustedSnapshots
      ? structuredClone([...trustedSnapshots])
      : !resumedFromDisk && !disableInstructions
        ? bindings.flatMap((binding) =>
            binding.resolve({
              cwd,
              provider,
              model,
              sessionId: session.state.sessionId,
            }),
          )
        : [];
  }
  if (!disableInstructions && resumedFromDisk) {
    const targeted = bindings.flatMap((binding) =>
      binding.resolve(
        {
          cwd,
          provider,
          model,
          sessionId: session.state.sessionId,
        },
        true,
      ),
    );
    if (
      targeted.some(
        (snapshot) =>
          !session.state.instructionSnapshots?.some((old) => old.bindingId === snapshot.bindingId),
      )
    ) {
      const previous = session.state.instructionSnapshots;
      if (previous.length) {
        clearContext();
        contextCleared = true;
      }
      session.state.instructionSnapshots = [
        ...previous.filter((old) => !targeted.some((snapshot) => snapshot.name === old.name)),
        ...targeted,
      ];
    }
  }
  const effectiveSnapshots = session.state.instructionSnapshots.filter((snapshot) => {
    if (snapshot.provider !== provider || snapshot.model !== model) return false;
    // Only the trusted isolated Host config overrides the ordinary Skill visibility rules.
    if (trustedSnapshots) return true;
    const pluginName = snapshot.name.includes(":")
      ? snapshot.name.slice(0, snapshot.name.indexOf(":"))
      : undefined;
    return (
      !disableInstructions &&
      !disabledSkills?.includes(snapshot.name) &&
      !(pluginName && disabledPlugins?.includes(pluginName)) &&
      (skillAllowlist === undefined || skillAllowlist.includes(snapshot.name))
    );
  });
  const effectiveRevisions = effectiveSnapshots
    .map((snapshot) => `${snapshot.bindingId}:${snapshot.revision}`)
    .sort();
  const priorRevisions =
    session.state.instructionContextRevisions ??
    session.state.instructionSnapshots
      .map((snapshot) => `${snapshot.bindingId}:${snapshot.revision}`)
      .sort();
  if (
    JSON.stringify(effectiveRevisions) !== JSON.stringify(priorRevisions) &&
    session.state.instructionContextStartEventId
  ) {
    clearContext(session.state.instructionSnapshots);
    contextCleared = true;
  }
  if (effectiveSnapshots.length && !session.state.instructionContextStartEventId)
    session.state.instructionContextStartEventId = runId;
  session.state.instructionContextRevisions = effectiveRevisions;
  if (
    !sessionManager.saveStateOrUpdateFields(
      session.state,
      {
        instructionSnapshots: session.state.instructionSnapshots,
        instructionContextStartEventId: session.state.instructionContextStartEventId,
        instructionContextRevisions: effectiveRevisions,
      },
      runId,
    )
  )
    throw new Error("Could not persist fixed instruction context");
  return { snapshots: effectiveSnapshots, contextCleared };
}
