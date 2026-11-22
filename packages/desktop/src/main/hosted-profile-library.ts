import type { ProfileLibraryChanges, ProfileLibraryReads } from "../shared/profile-library.js";
import { claimBusinessCommit } from "../host/composition/business-calls.js";
import {
  deleteDigitalHumanTeam,
  listDigitalHumanTeams,
  saveDigitalHumanTeam,
} from "./digital-human-team-service.js";
import {
  exportProfileDefinition,
  importReviewedProfileDefinition,
  installCatalogProfile,
  listProfileCatalog,
  listProfileRepos,
  listProfiles,
  previewProfileDefinitionImport,
  previewProfileDeletion,
  saveProfile,
} from "./profiles-service.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import type { RendererConfigurationTarget } from "../shared/renderer-configuration.js";
const cwd = (target: RendererConfigurationTarget | null) =>
  target === null ? undefined : rendererConfigurationCwd(target);

type Views = {
  [K in keyof ProfileLibraryReads]: (
    input: ProfileLibraryReads[K]["params"],
  ) => ProfileLibraryReads[K]["result"] | Promise<ProfileLibraryReads[K]["result"]>;
};
const views: Views = {
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
  input: ProfileLibraryReads[K]["params"],
) {
  return views[method](input);
}

type Mutations = {
  [K in keyof ProfileLibraryChanges]: (
    input: ProfileLibraryChanges[K]["input"],
    claim: () => void,
  ) => ProfileLibraryChanges[K]["result"] | Promise<ProfileLibraryChanges[K]["result"]>;
};
const mutations: Mutations = {
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
  return mutations[method](input, () => claimBusinessCommit(permit));
}
