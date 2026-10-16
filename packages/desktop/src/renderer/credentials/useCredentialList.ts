import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MaskedCredentialView } from "./types";

/** A list response belongs to one mounted scope and its latest refresh only. */
export function useCredentialList(cwd: string, type: "cookie" | "token") {
  const scope = useMemo(() => ({ cwd, type }), [cwd, type]);
  const authority = useRef<{ scope: typeof scope; request: number } | null>(null);
  const [state, setState] = useState({
    scope,
    items: [] as MaskedCredentialView[],
    loading: true,
    error: "",
  });

  const reload = useCallback(async () => {
    const owner = authority.current;
    // Mutations started in a previous scope may finish after navigation.
    if (!owner || owner.scope !== scope) return false;
    const request = ++owner.request;
    const current = () => authority.current === owner && owner.request === request;
    setState((previous) => ({
      scope,
      items: previous.scope === scope ? previous.items : [],
      loading: true,
      error: previous.scope === scope ? previous.error : "",
    }));
    try {
      const all = await window.codeshell.credentials.list(cwd);
      if (!current()) return false;
      setState({
        scope,
        items: all.filter((item) => item.type === type),
        loading: false,
        error: "",
      });
      return true;
    } catch (cause) {
      if (!current()) return false;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
      return false;
    }
  }, [scope, cwd, type]);

  useLayoutEffect(() => {
    const owner = { scope, request: 0 };
    authority.current = owner;
    void reload();
    return () => {
      if (authority.current === owner) authority.current = null;
    };
  }, [scope, reload]);

  return {
    ...(state.scope === scope ? state : { items: [], loading: true, error: "" }),
    reload,
  };
}
