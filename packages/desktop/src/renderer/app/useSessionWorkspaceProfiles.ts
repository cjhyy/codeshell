import { useEffect, useState } from "react";
import type { RendererConfigurationTarget } from "../../preload/types";

export interface SessionWorkspaceProfile {
  name: string;
  label: string;
  description?: string;
}

interface Options {
  configurationAvailable: boolean;
  configurationTarget: RendererConfigurationTarget;
  refreshKey: string;
}

/** Load identity choices for the current configuration target and visible page. */
export function useSessionWorkspaceProfiles({
  configurationAvailable,
  configurationTarget,
  refreshKey,
}: Options): SessionWorkspaceProfile[] {
  const [profiles, setProfiles] = useState<SessionWorkspaceProfile[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!configurationAvailable) {
      setProfiles([]);
      return;
    }
    const listProfiles = window.codeshell.listProfiles;
    if (typeof listProfiles !== "function") {
      setProfiles([]);
      return;
    }
    void listProfiles(configurationTarget)
      .then((entries) => {
        if (cancelled) return;
        setProfiles(
          entries.map((profile) => ({
            name: profile.name,
            label: profile.label,
            description: profile.description,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [configurationAvailable, configurationTarget, refreshKey]);

  return profiles;
}
