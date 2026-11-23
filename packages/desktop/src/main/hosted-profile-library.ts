import type { ProfileLibraryChanges, ProfileWorkerReads } from "../shared/profile-library.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
  saveDigitalHumanTeam,
} from "./digital-human-team-service.js";
import {
  activateProfile,
  deactivateProfile,
  setSessionWorkspaceProfile,
  deleteProfile,
  forceDeleteProfile,
  exportProfileDefinition,
  exportProfileRepo,
  removeProfileRepo,
  importReviewedProfileDefinition,
  installCatalogProfile,
  listProfileCatalog,
  listProfileRepos,
  listProfiles,
  previewProfileDefinitionImport,
  previewProfileDeletion,
  saveProfile,
} from "./profiles-service.js";
import { adoptProfileSwitch, previewProfileSwitch } from "./profile-switch-service.js";
import { profileCredentialQuestions, ProfileSourceChanged } from "./profile-switch-authority.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";
import type { ProfileSwitchTarget } from "../shared/profile-switch-authority.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
const cwd = (target: RendererConfigurationTarget | null) =>
  target === null ? undefined : rendererConfigurationCwd(target);

type Views = {
  [K in keyof ProfileWorkerReads]: (
    input: ProfileWorkerReads[K]["params"],
  ) => ProfileWorkerReads[K]["result"] | Promise<ProfileWorkerReads[K]["result"]>;
};
const views: Views = {
  "profiles/switchSourceQuestions": async ({ target }) => {
    if (!(await targetStillCurrent(target))) throw Error("Profile target changed during review");
    return profileCredentialQuestions(target.cwd);
  },
  "profiles/previewSwitch": async ({ target, name, answers }) => {
    if (!(await targetStillCurrent(target))) return { status: "changed" };
    try {
      return { status: "ready", preview: previewProfileSwitch(target, name, answers) };
    } catch (error) {
      if (error instanceof ProfileSourceChanged) return { status: "changed" };
      throw error;
    }
  },

  "profiles/list": async ({ target }) => listProfiles(await cwd(target)),
  "profiles/catalog": listProfileCatalog,
  "profiles/repos": listProfileRepos,
  "profiles/teams": () =>
    listDigitalHumanTeams({
      onInvalidTeam: (issue) =>
        console.warn("[Desktop Host] Invalid digital-human team", issue.id, issue.error),
    }),
  "profiles/previewDeletion": async ({ name, target }) =>
    previewProfileDeletion(name, await cwd(target)),
};
export function readProfileLibrary<K extends keyof Views>(
  method: K,
  input: ProfileWorkerReads[K]["params"],
) {
  return views[method](input);
}

type Mutations = {
  [K in keyof ProfileLibraryChanges]: (
    input: ProfileLibraryChanges[K]["input"],
    claim: () => void,
  ) => ProfileLibraryChanges[K]["result"] | Promise<ProfileLibraryChanges[K]["result"]>;
};
async function targetStillCurrent(target: ProfileSwitchTarget) {
  const fresh = await resolveRendererConfigurationTarget(
    target.kind === "project" ? { projectId: target.projectId } : { sessionId: target.sessionId },
  );
  return JSON.stringify(fresh) === JSON.stringify(target);
}
const mutations: Mutations = {
  "profiles/adoptSwitch": async ({ target, name, answers, expectedRevision }, claim) => {
    if (!(await targetStillCurrent(target))) return { status: "stale" };
    return adoptProfileSwitch(target, name, expectedRevision, answers, claim);
  },
  "profiles/activate": async ({ target, name }, claim) =>
    activateProfile(await rendererConfigurationCwd(target), name, claim),
  "profiles/deactivate": async ({ target }, claim) =>
    deactivateProfile(await rendererConfigurationCwd(target), claim),
  "profiles/setSession": ({ sessionId, profileName }, claim) =>
    setSessionWorkspaceProfile(sessionId, profileName, claim),
  "profiles/delete": async ({ name, target, clearActiveProject }, claim) =>
    deleteProfile(name, { cwd: await cwd(target), clearActiveProject }, claim),
  "profiles/forceDelete": async ({ name, target }, claim) =>
    forceDeleteProfile(name, { cwd: await cwd(target) }, claim),
  "profiles/removeRepo": ({ repo }, claim) => removeProfileRepo(repo, claim),
  "profiles/exportRepo": ({ names, path }, claim) => exportProfileRepo(names, path, claim),
  "profiles/saveTeam": ({ team }, claim) => saveDigitalHumanTeam(team, claim),
  "profiles/deleteTeam": ({ id }, claim) => deleteDigitalHumanTeam(id, claim),
  "profiles/save": async ({ profile, target }, claim) =>
    saveProfile(profile, await cwd(target), claim),
  "profiles/install": ({ name }, claim) => installCatalogProfile(name, claim),
  "profiles/pickedDefinition": ({ path, owner }) => previewProfileDefinitionImport(path, owner),
  "profiles/importDefinition": async ({ target, owner, ...input }, claim) =>
    importReviewedProfileDefinition(input, await cwd(target), claim, owner),
  "profiles/exportDefinition": ({ name, path }, claim) =>
    exportProfileDefinition(name, path, claim),
};
export function changeProfileLibrary<K extends keyof Mutations>(
  method: K,
  { input, permit }: { input: ProfileLibraryChanges[K]["input"]; permit: Int32Array },
) {
  // A confirmed cascade owns its subsequent cleanups as soon as its first durable
  // change wins the document permit. A stale document can never start a cascade.
  let claimed = false;
  return mutations[method](input, () => {
    if (!claimed) {
      claimBusinessCommit(permit);
      claimed = true;
    }
  });
}
