import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudProjectBinding } from "../../shared/project-runtime";

/** Main owns project/runtime identity; a missing or failed read must not select local implicitly. */
export function useProjectRuntimeSelection(localProjectId: string | null) {
  const version = useRef(0);
  const activeProject = useRef(localProjectId);
  activeProject.current = localProjectId;
  const [snapshot, setSnapshot] = useState<{
    projectId: string | null;
    bindings: CloudProjectBinding[];
    bindingId: string | null;
    ready: boolean;
    error: string | null;
  }>({ projectId: null, bindings: [], bindingId: null, ready: false, error: null });

  const refresh = useCallback(async () => {
    const projectId = localProjectId;
    if (activeProject.current !== projectId) return;
    const request = ++version.current;
    if (!projectId) {
      setSnapshot({ projectId, bindings: [], bindingId: null, ready: true, error: null });
      return;
    }
    setSnapshot((old) => ({ ...old, ready: false, error: null }));
    try {
      const [bindings, selection] = await Promise.all([
        window.codeshell.cloudEnvironment.listBindings(projectId),
        window.codeshell.cloudEnvironment.getSelection(projectId),
      ]);
      if (request !== version.current || activeProject.current !== projectId) return;
      if (selection.bindingId && !bindings.some((binding) => binding.id === selection.bindingId)) {
        throw new Error("The selected cloud project binding is unavailable.");
      }
      setSnapshot({
        projectId,
        bindings,
        bindingId: selection.bindingId,
        ready: true,
        error: null,
      });
    } catch (cause) {
      if (request !== version.current || activeProject.current !== projectId) return;
      setSnapshot((old) => ({
        ...(old.projectId === projectId ? old : { bindings: [], bindingId: null }),
        projectId,
        ready: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }, [localProjectId]);

  useEffect(() => {
    void refresh();
    return () => {
      version.current += 1;
    };
  }, [refresh]);

  const select = useCallback(
    async (bindingId: string | null) => {
      const projectId = localProjectId;
      if (!projectId || activeProject.current !== projectId) return;
      ++version.current;
      setSnapshot((old) => ({ ...old, ready: false, error: null }));
      try {
        await window.codeshell.cloudEnvironment.select({ localProjectId: projectId, bindingId });
        if (activeProject.current === projectId) await refresh();
      } catch (cause) {
        if (activeProject.current === projectId) {
          setSnapshot((old) => ({ ...old, ready: false, error: String(cause) }));
        }
        throw cause;
      }
    },
    [localProjectId, refresh],
  );

  const current = snapshot.projectId === localProjectId;
  const bindings = current ? snapshot.bindings : [];
  const bindingId = current ? snapshot.bindingId : null;
  return {
    bindings,
    bindingId,
    selectedBinding: bindings.find((binding) => binding.id === bindingId) ?? null,
    ready: localProjectId === null || (current && snapshot.ready),
    error: current ? snapshot.error : null,
    refresh,
    select,
  };
}
