import { describe, expect, it } from "bun:test";
import * as capabilityApi from "./index.capability.js";
import * as protocolApi from "./index.protocol.js";
import * as teamApi from "./index.team.js";
import type {
  PendingDecisionProjection as _PendingDecisionProjection,
  PetProjectionDelta as _PetProjectionDelta,
  PetProjectionSnapshotResult as _PetProjectionSnapshotResult,
  PetSessionProjection as _PetSessionProjection,
} from "./index.protocol.js";
import type {
  DigitalHumanTeam as _DigitalHumanTeam,
  DigitalHumanTeamMode as _DigitalHumanTeamMode,
} from "./index.team.js";
import * as rootApi from "./index.js";

describe("Pet package public entry contracts", () => {
  it("keeps focused runtime surfaces with root-entry identity", () => {
    expect(Object.keys(capabilityApi).sort()).toEqual(["createPetCapability"]);
    expect(Object.keys(protocolApi).sort()).toEqual([
      "GET_PET_PROJECTION_SNAPSHOT_METHOD",
      "LOCAL_PET_OWNER",
      "PET_PROJECTION_DELTA_METHOD",
      "PET_REPORT_TO_MIMI_METHOD",
    ]);
    expect(Object.keys(teamApi).sort()).toEqual([
      "DIGITAL_HUMAN_ID_RE",
      "DIGITAL_HUMAN_TEAM_ID_RE",
      "parseDigitalHumanTeam",
    ]);

    expect(capabilityApi.createPetCapability).toBe(rootApi.createPetCapability);
    expect(protocolApi.PET_PROJECTION_DELTA_METHOD).toBe(rootApi.PET_PROJECTION_DELTA_METHOD);
    expect(protocolApi.PET_REPORT_TO_MIMI_METHOD).toBe(rootApi.PET_REPORT_TO_MIMI_METHOD);
    expect(protocolApi.GET_PET_PROJECTION_SNAPSHOT_METHOD).toBe(
      rootApi.GET_PET_PROJECTION_SNAPSHOT_METHOD,
    );
    expect(protocolApi.LOCAL_PET_OWNER).toBe(rootApi.LOCAL_PET_OWNER);
    expect(teamApi.parseDigitalHumanTeam).toBe(rootApi.parseDigitalHumanTeam);
  });

  it("does not expose implementation state machines through focused entries", () => {
    expect(capabilityApi).not.toHaveProperty("PET_SYSTEM_PROMPT");
    expect(capabilityApi).not.toHaveProperty("delegateWorkTool");
    expect(protocolApi).not.toHaveProperty("SessionIndex");
    expect(protocolApi).not.toHaveProperty("PendingDecisionIndex");
    expect(protocolApi).not.toHaveProperty("createPetProjectionObserver");
    expect(teamApi).not.toHaveProperty("createPetCapability");
  });

  it("declares exact package exports and source aliases without a deep-import wildcard", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const rootTsconfig = await Bun.file(new URL("../../../tsconfig.json", import.meta.url)).json();

    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./capability": {
        types: "./dist/index.capability.d.ts",
        import: "./dist/index.capability.js",
      },
      "./protocol": {
        types: "./dist/index.protocol.d.ts",
        import: "./dist/index.protocol.js",
      },
      "./team": {
        types: "./dist/index.team.d.ts",
        import: "./dist/index.team.js",
      },
    });
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-pet/capability"]).toEqual([
      "packages/pet/src/index.capability.ts",
    ]);
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-pet/protocol"]).toEqual([
      "packages/pet/src/index.protocol.ts",
    ]);
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-pet/team"]).toEqual([
      "packages/pet/src/index.team.ts",
    ]);
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-pet/*"]).toBeUndefined();
  });
});

// Compile-time consumers: keep these named type exports available without
// widening the runtime entry objects above.
type _ProtocolContract =
  | _PendingDecisionProjection
  | _PetProjectionDelta
  | _PetProjectionSnapshotResult
  | _PetSessionProjection;
type _TeamContract = _DigitalHumanTeam | { mode: _DigitalHumanTeamMode };
