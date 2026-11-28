import { useCallback, useRef, useSyncExternalStore } from "react";
import { asyncAgentRegistry, type AsyncAgentEntry } from "@cjhyy/code-shell-core/internal";

/** Coalescing window for transcript-only registry changes while a sub-agent
 *  transcript is on screen. Matches the main feed's 50 ms text flush. */
export const AGENT_TRANSCRIPT_THROTTLE_MS = 50;

export interface AgentRegistrySource {
  subscribe(cb: () => void): () => void;
  getSnapshot(): AsyncAgentEntry[];
}

export interface GatedAgentSubscriptionOptions {
  /** When false, changes that leave every dock-visible row field unchanged
   *  (i.e. transcript appends/patches) are ignored entirely. */
  watchTranscripts: boolean;
  throttleMs?: number;
}

/**
 * Row-level identity of the registry: the fields the dock, view-mode guard
 * and keyboard clamp read. Transcript content is deliberately excluded —
 * the core translator touches the registry once per sub-agent token, and
 * those notifications must not re-render the whole App.
 */
export function agentRowSignature(agents: readonly AsyncAgentEntry[]): string {
  let sig = "";
  for (const a of agents) {
    sig += `${a.agentId}\u0000${a.status}\u0000${a.name ?? ""}\u0000${a.agentType ?? ""}\u0000${
      a.description
    }\u0000${a.startedAt}\u0000${a.finishedAt ?? ""}\u0000${a.finishedFadeAt ?? ""}\u0001`;
  }
  return sig;
}

/**
 * Subscribe to the agent registry, forwarding row-level changes immediately
 * and transcript-only changes (when watched) at most once per `throttleMs`.
 * `onChange` receives the registry snapshot that should be rendered.
 */
export function subscribeAgentRegistryGated(
  source: AgentRegistrySource,
  options: GatedAgentSubscriptionOptions,
  onChange: (snapshot: AsyncAgentEntry[]) => void,
  initialSignature: string = agentRowSignature(source.getSnapshot()),
): () => void {
  const throttleMs = options.throttleMs ?? AGENT_TRANSCRIPT_THROTTLE_MS;
  let lastSignature = initialSignature;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const snapshot = source.getSnapshot();
    lastSignature = agentRowSignature(snapshot);
    onChange(snapshot);
  };
  const unsubscribe = source.subscribe(() => {
    if (agentRowSignature(source.getSnapshot()) !== lastSignature) {
      emit();
      return;
    }
    if (!options.watchTranscripts || timer) return;
    timer = setTimeout(emit, throttleMs);
  });
  // A change may have landed between the caller's render and this subscribe.
  if (agentRowSignature(source.getSnapshot()) !== lastSignature) emit();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Registry snapshot for React consumers that re-renders on row changes
 * immediately and, when `watchTranscripts` is set, on transcript changes at
 * most every {@link AGENT_TRANSCRIPT_THROTTLE_MS}. Entries are the live
 * registry objects, so a render always reads the latest transcript.
 */
export function useAgentRegistrySnapshot(
  watchTranscripts = false,
  source: AgentRegistrySource = asyncAgentRegistry,
): AsyncAgentEntry[] {
  const cacheRef = useRef<AsyncAgentEntry[] | null>(null);
  if (cacheRef.current === null) cacheRef.current = source.getSnapshot();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeAgentRegistryGated(
        source,
        { watchTranscripts },
        (snapshot) => {
          cacheRef.current = snapshot;
          onStoreChange();
        },
        agentRowSignature(cacheRef.current ?? []),
      ),
    [source, watchTranscripts],
  );
  const getSnapshot = useCallback(() => cacheRef.current!, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}
