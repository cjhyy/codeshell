import { useEffect, useState } from "react";

import type { PermissionMode } from "../chat/PermissionPill";
import { loadOverrideMap, saveOverrideMap } from "../transcripts";
import { normalizeExternalRuntimeModelKey } from "../../shared/external-runtime-models";

function loadModelOverrides(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(loadOverrideMap<string>("model")).map(([bucket, key]) => [
      bucket,
      normalizeExternalRuntimeModelKey(key),
    ]),
  );
}

/** Bucket-scoped renderer preferences with their localStorage projection. */
export function useBucketOverrides(): {
  permissionOverrides: Record<string, PermissionMode>;
  setPermissionOverrides: React.Dispatch<
    React.SetStateAction<Record<string, PermissionMode>>
  >;
  modelOverrides: Record<string, string>;
  setModelOverrides: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  goalOverrides: Record<string, boolean>;
  setGoalOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
} {
  const [permissionOverrides, setPermissionOverrides] = useState<
    Record<string, PermissionMode>
  >(() => loadOverrideMap<PermissionMode>("permission"));
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>(loadModelOverrides);
  const [goalOverrides, setGoalOverrides] = useState<Record<string, boolean>>(() =>
    loadOverrideMap<boolean>("goal"),
  );

  useEffect(() => saveOverrideMap("permission", permissionOverrides), [permissionOverrides]);
  useEffect(() => saveOverrideMap("model", modelOverrides), [modelOverrides]);
  useEffect(() => saveOverrideMap("goal", goalOverrides), [goalOverrides]);

  return {
    permissionOverrides,
    setPermissionOverrides,
    modelOverrides,
    setModelOverrides,
    goalOverrides,
    setGoalOverrides,
  };
}
