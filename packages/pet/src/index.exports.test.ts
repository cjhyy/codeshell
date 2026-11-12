import { describe, expect, it } from "bun:test";
import * as capabilityApi from "./index.capability.js";
import * as protocolApi from "./index.protocol.js";
import * as teamApi from "./index.team.js";
import type {
  BoundChannel as _BoundChannel,
  NoticeAttention as _NoticeAttention,
  NoticeChannel as _NoticeChannel,
  NoticeEvent as _NoticeEvent,
  NoticeRuleUpsert as _NoticeRuleUpsert,
  NoticeRuleUpsertReply as _NoticeRuleUpsertReply,
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
    expect(Object.keys(capabilityApi).sort()).toEqual([
      "PET_MANAGER_TOOL_CATALOG",
      "createPetModule",
    ]);
    expect(Object.keys(protocolApi).sort()).toEqual([
      "GET_PET_PROJECTION_SNAPSHOT_METHOD",
      "LOCAL_PET_OWNER",
      "NOTICE_CHANNEL_MAX_LENGTH",
      "NOTICE_EVENTS",
      "NOTICE_NOTE_MAX_LENGTH",
      "NOTICE_RULE_CREATORS",
      "PET_NOTICES_QUERY_ACTION",
      "PET_NOTICE_KINDS",
      "PET_NOTICE_TEXT_MAX",
      "PET_NOTIFICATION_SETTINGS_QUERY_ACTION",
      "PET_PROJECTION_DELTA_METHOD",
      "PET_REPORT_TO_MIMI_METHOD",
      "PET_RULE_UPSERT_ACTION",
      "PET_SNOOZE_MAX_MINUTES",
      "PET_TRIGGERS_QUERY_ACTION",
      "PET_TRIGGER_CHANGES_MAX",
      "isPetNotificationSettingsMutation",
      "isPetTriggerMutation",
      "isPetTriggerMutationRequest",
      "parseNoticeEvents",
      "parseNoticeRuleUpsert",
      "parsePetNoticesQuery",
      "petTriggerChanges",
    ]);
    expect(Object.keys(teamApi).sort()).toEqual([
      "DIGITAL_HUMAN_ID_RE",
      "DIGITAL_HUMAN_TEAM_ID_RE",
      "parseDigitalHumanTeam",
    ]);

    expect(capabilityApi.createPetModule).toBe(rootApi.createPetModule);
    expect(capabilityApi.PET_MANAGER_TOOL_CATALOG).toBe(rootApi.PET_MANAGER_TOOL_CATALOG);
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
    expect(teamApi).not.toHaveProperty("createPetModule");
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
      "./disclosure": {
        types: "./dist/index.disclosure.d.ts",
        import: "./dist/index.disclosure.js",
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
    expect(rootTsconfig.compilerOptions.paths["@cjhyy/code-shell-pet/disclosure"]).toEqual([
      "packages/pet/src/index.disclosure.ts",
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
  | _PetSessionProjection
  | _NoticeRuleUpsert
  | _NoticeRuleUpsertReply
  | _BoundChannel
  | { event: _NoticeEvent; attention: _NoticeAttention; channel: _NoticeChannel };
type _TeamContract = _DigitalHumanTeam | { mode: _DigitalHumanTeamMode };
