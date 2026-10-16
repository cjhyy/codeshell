import React from "react";
import type { CloudAccountStatus } from "../../shared/cloud-account";

/** Observe public, local account state. A late initial read cannot undo a newer account event. */
export function useCloudAccountStatus() {
  const api = window.codeshell.cloudAccount;
  const [result, setResult] = React.useState<{
    status?: CloudAccountStatus;
    loading: boolean;
    unavailable: boolean;
  }>({ loading: true, unavailable: false });
  React.useEffect(() => {
    let active = true;
    let receivedStatus = false;
    let unsubscribe: (() => void) | undefined;
    setResult({ loading: true, unavailable: false });
    const failed = () => {
      if (active && !receivedStatus) setResult({ loading: false, unavailable: true });
    };
    try {
      if (!api) {
        failed();
      } else {
        unsubscribe = api.onStatus((status) => {
          if (!active) return;
          receivedStatus = true;
          setResult({ status, loading: false, unavailable: false });
        });
        void api.status().then((status) => {
          if (active && !receivedStatus) setResult({ status, loading: false, unavailable: false });
        }, failed);
      }
    } catch {
      failed();
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api]);
  return result;
}
