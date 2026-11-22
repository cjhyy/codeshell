import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import type { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import type { ProfileLibraryChanges, ProfileLibraryReads } from "../../shared/profile-library.js";
import type { BusinessGrant, BusinessMethods } from "./business-calls.js";
import {
  businessArguments,
  businessRead,
  noBusinessArguments,
  scopedBusinessRead,
  textArgument,
} from "../../main/desktop-host/business-read.js";
import { parseConfigurationTarget } from "../../main/desktop-host/scoped-configuration-reads.js";
import type { ListSessions } from "../../shared/disk-session-query.js";

function optionalTarget(value: unknown) {
  return value === null ? null : parseConfigurationTarget(value);
}
export function hostedProfileLibrary(
  storage: Promise<StateStorage>,
  worker: ActivityHistoryWorker,
  list: ListSessions,
) {
  const empty = <K extends "profiles/catalog" | "profiles/repos" | "profiles/teams">(key: K) =>
    businessRead(key, noBusinessArguments, () => worker.view(key, {}));
  const view =
    <K extends keyof ProfileLibraryReads>(key: K) =>
    (input: ProfileLibraryReads[K]["params"]) =>
      worker.view(key, input);
  function change<K extends keyof ProfileLibraryChanges>(key: K) {
    return async (input: ProfileLibraryChanges[K]["input"], grant: BusinessGrant) => {
      const db = await storage;
      grant.assertCurrent();
      const result = await db.request<ProfileLibraryChanges[K]["result"]>(key, {
        input,
        permit: grant.permit,
      });
      if (result === null) throw new Error("Profile library storage unavailable");
      return result;
    };
  }
  return {
    reads: [
      empty("profiles/catalog"),
      empty("profiles/repos"),
      empty("profiles/teams"),
      scopedBusinessRead(
        "profiles/list",
        list,
        (args) => ({ target: optionalTarget(businessArguments(args, ["target"]).target) }),
        ({ target }) => (target && "sessionId" in target ? target.sessionId : undefined),
        view("profiles/list"),
      ),
      scopedBusinessRead(
        "profiles/previewDeletion",
        list,
        (args) => {
          const { target, name } = businessArguments(args, ["target", "name"]);
          return { target: optionalTarget(target), name: textArgument(name) };
        },
        ({ target }) => (target && "sessionId" in target ? target.sessionId : undefined),
        view("profiles/previewDeletion"),
      ),
    ],
    operations: {
      "profiles/catalog": view("profiles/catalog"),
      "profiles/repos": view("profiles/repos"),
      "profiles/teams": view("profiles/teams"),
      "profiles/list": view("profiles/list"),
      "profiles/previewDeletion": view("profiles/previewDeletion"),
      "profiles/activate": change("profiles/activate"),
      "profiles/deactivate": change("profiles/deactivate"),
      "profiles/setSession": change("profiles/setSession"),
      "profiles/forceDelete": change("profiles/forceDelete"),
      "profiles/delete": change("profiles/delete"),
      "profiles/removeRepo": change("profiles/removeRepo"),
      "profiles/exportRepo": change("profiles/exportRepo"),
      "profiles/saveTeam": change("profiles/saveTeam"),
      "profiles/deleteTeam": change("profiles/deleteTeam"),
      "profiles/save": change("profiles/save"),
      "profiles/install": change("profiles/install"),
      "profiles/pickedDefinition": change("profiles/pickedDefinition"),
      "profiles/importDefinition": change("profiles/importDefinition"),
      "profiles/exportDefinition": change("profiles/exportDefinition"),
    } satisfies Pick<BusinessMethods, keyof ProfileLibraryReads | keyof ProfileLibraryChanges>,
  };
}
