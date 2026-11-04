import { useEffect, useState } from "react";
import type { AccountFeatureId, AccountFeatureView } from "../../shared/account-features.js";

/** Main owns policy, account isolation and readiness; the renderer only subscribes. */
export function useAccountFeature(id: AccountFeatureId): AccountFeatureView {
  const api = window.codeshell?.accountFeatures;
  const [view, setView] = useState<AccountFeatureView>({ id, state: "hidden" });
  useEffect(() => {
    let active = true;
    let received = false;
    setView({ id, state: "hidden" });
    if (!api) return;
    const apply = (snapshot: Record<AccountFeatureId, AccountFeatureView>) => {
      if (!active) return;
      const next = snapshot[id];
      setView(next?.id === id ? next : { id, state: "hidden" });
    };
    const off = api.onChanged((snapshot) => {
      received = true;
      apply(snapshot);
    });
    void api.snapshot().then(
      (snapshot) => {
        if (!received) apply(snapshot);
      },
      () => {
        if (active && !received) setView({ id, state: "hidden" });
      },
    );
    return () => {
      active = false;
      off();
    };
  }, [api, id]);
  return view.id === id ? view : { id, state: "hidden" };
}

export function openAccountSettings() {
  window.dispatchEvent(new Event("codeshell:open-account-settings"));
}
