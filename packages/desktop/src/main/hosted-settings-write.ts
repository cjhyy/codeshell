import { claimBusinessCommit } from "../host/composition/business-calls.js";
import type { ShellBusinessOperations } from "../shared/shell-business-contracts.js";
import { rendererConfigurationCwd } from "./renderer-configuration-helpers.js";
import { settingsChange, validateRendererSettingsPatch } from "./renderer-settings-edits.js";
import { writeSettings } from "./settings-service.js";

export async function writeHostedSettings({
  input,
  permit,
}: {
  input: ShellBusinessOperations["settings/patch"]["input"];
  permit: Int32Array;
}) {
  if (!input || (input.scope !== "user" && input.scope !== "project"))
    throw new Error("Invalid settings scope");
  validateRendererSettingsPatch(input.patch);
  const cwd = input.scope === "project" ? await rendererConfigurationCwd(input.target) : undefined;
  await writeSettings(input.scope, input.patch, cwd, () => claimBusinessCommit(permit));
  return settingsChange(input.scope, input.patch);
}
