import { installDefaultLinkProviders } from "@cjhyy/code-shell-server/links";
import { SettingsManager, type SourceDefinition } from "@cjhyy/code-shell-core";
import {
  listBindings,
  listSourceDefinitions,
  sourceCredentialQuestion,
} from "@cjhyy/code-shell-core/internal";
import type {
  ProfileCredentialQuestion,
  ProfileCredentialAnswers,
} from "../shared/profile-switch-authority.js";

export function profileCredentialQuestions(cwd: string): ProfileCredentialQuestion[] {
  const questions = new Map<string, ProfileCredentialQuestion>();
  const bindings = listBindings(new SettingsManager(cwd, "full"), cwd);
  if (!bindings.length) return [];
  installDefaultLinkProviders();
  const definitions = new Map(listSourceDefinitions().map((s) => [s.id, s]));
  for (const binding of bindings) {
    const definition = definitions.get(binding.sourceId);
    const q = definition && sourceCredentialQuestion(definition);
    if (q) questions.set(JSON.stringify(q), q);
  }
  return [...questions.values()];
}
export class ProfileSourceChanged extends Error {
  constructor() {
    super("Profile source bindings changed during review");
  }
}
export function profileSourceDecisions(answers: ProfileCredentialAnswers) {
  installDefaultLinkProviders();
  const byKey = new Map(answers.decisions.map((row) => [row.key, row]));
  return (definition: SourceDefinition) => {
    const row = byKey.get(JSON.stringify(sourceCredentialQuestion(definition)));
    if (!row) throw new ProfileSourceChanged();
    return row;
  };
}
