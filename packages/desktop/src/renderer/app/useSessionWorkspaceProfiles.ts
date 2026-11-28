import { useEffect, useState } from "react";
import type { RendererConfigurationTarget } from "../../preload/types";

export interface SessionWorkspaceProfile {
  name: string;
  label: string;
  description?: string;
  active?: boolean;
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
  const [snapshot, setSnapshot] = useState<{
    target: RendererConfigurationTarget;
    profiles: SessionWorkspaceProfile[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!configurationAvailable) {
      setSnapshot(null);
      return;
    }
    const listProfiles = window.codeshell.listProfiles;
    if (typeof listProfiles !== "function") {
      setSnapshot(null);
      return;
    }
    void listProfiles(configurationTarget)
      .then((entries) => {
        if (cancelled) return;
        setSnapshot({
          target: configurationTarget,
          profiles: entries.map((profile) => ({
            name: profile.name,
            label: profile.label,
            description: profile.description,
            ...(profile.active ? { active: true } : {}),
          })),
        });
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [configurationAvailable, configurationTarget, refreshKey]);

  return configurationAvailable && snapshot?.target === configurationTarget
    ? snapshot.profiles
    : EMPTY_PROFILES;
}

const EMPTY_PROFILES: SessionWorkspaceProfile[] = [];
