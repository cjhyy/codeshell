import { describe, expect, test } from "bun:test";
import { HookRegistry, ToolRegistry } from "@cjhyy/code-shell-core";
import {
  assertExternalToolReviewSnapshot,
  createExternalToolReviewSnapshot,
  createSessionToolHost,
  deriveExternalToolExposure,
  FIRST_PHASE_EXPOSURE,
  REVIEWED_EXTERNAL_TOOL_EXPOSURE,
  type ToolContext,
  type ToolVisibilityContext,
} from "@cjhyy/code-shell-core/extension";
import { createPetModule, PET_MANAGER_TOOL_CATALOG } from "./index.capability.js";
import { delegateWorkTool } from "./delegate-work.js";
import { gatewayReplyTool, isPetHostActionRequest } from "./host-actions.js";
import { PET_ALLOWED_TOOL_NAMES, PET_BEHAVIOR_PROFILE } from "./profile.js";

const MANAGER_NAMES = [
  "BindConversationSession",
  "ControlLongTask",
  "CurrentTime",
  "DelegateWork",
  "FollowUps",
  "Gateway",
  "GatewayReply",
  "ManageFollowUp",
  "ManageSessions",
  "Memory",
  "MobileRemote",
  "SendMessage",
  "Sessions",
  "WatchSession",
];

const PROFILE_PARAMS = {
  workspaces: [{ id: "workspace-owned", name: "Authorized Workspace" }],
  reusableSessions: [],
  hostActions: ["gatewayReply"],
  gatewayReply: {
    button: "link",
    attachments: [],
    maxTextLength: 80,
    maxAttachments: 4,
    maxAttachmentBytes: 10 * 1024 * 1024,
  },
};

function createHost(
  options: { manager?: boolean; services?: boolean; hostActions?: string[] } = {},
) {
  const registry = new ToolRegistry({ toolCatalog: PET_MANAGER_TOOL_CATALOG });
  const reported: Record<string, unknown> = {};
  const profileParams = {
    ...PROFILE_PARAMS,
    ...(options.hostActions ? { hostActions: options.hostActions } : {}),
  };
  const services = PET_BEHAVIOR_PROFILE.createRunServices!({
    profileParams,
    reportResult: (key, value) => {
      reported[key] = value;
    },
  });
  let hostEnabled = true;
  const exposure = () => deriveExternalToolExposure(registry, { mimiHost: hostEnabled });
  const cwd = process.cwd();
  const host = createSessionToolHost({
    businessSessionId: "external-manager-catalog",
    cwd,
    registry,
    permissionMode: "default",
    presetRules: PET_MANAGER_TOOL_CATALOG.flatMap(
      (tool) => tool.exposure.defaultPermissionRules ?? [],
    ),
    projectTrusted: true,
    planMode: false,
    exposure: exposure(),
    getExposure: exposure,
    visibility: {
      cwd,
      hasGoal: false,
      host: "desktop",
      isSubAgent: false,
      ...(options.manager === false
        ? {}
        : {
            behaviorProfile: "pet",
            profileMeta: PET_BEHAVIOR_PROFILE.buildVisibilityMeta!(profileParams),
          }),
    },
    hooks: new HookRegistry(),
    contextOverrides: options.services === false ? {} : { runScopedServices: services },
  });
  return { host, reported, setEnabled: (enabled: boolean) => (hostEnabled = enabled) };
}

describe("reviewed external Mimi manager catalog", () => {
  test("exports only the existing manager tools and preserves the native implementations", () => {
    expect(PET_MANAGER_TOOL_CATALOG.map((tool) => tool.definition.name).sort()).toEqual(
      MANAGER_NAMES,
    );
    const native = createPetModule().engine!.tools!.flatMap((contribution) =>
      contribution.kind === "preset-tags" ? [contribution.tool] : [],
    );
    for (const tool of PET_MANAGER_TOOL_CATALOG) {
      expect(PET_ALLOWED_TOOL_NAMES.has(tool.definition.name)).toBe(true);
      const original = native.find((entry) => entry.definition.name === tool.definition.name)!;
      expect(tool.definition).toEqual(original.definition);
      expect(tool.execute).toBe(original.execute);
      expect(tool.exposure).toEqual(original.exposure);
      expect(tool.exposure.external).toMatchObject({
        status: "exposed",
        requires: "mimi-host",
      });
      expect(FIRST_PHASE_EXPOSURE.toolNames.has(tool.definition.name)).toBe(false);
    }
    expect(
      PET_MANAGER_TOOL_CATALOG.find((tool) => tool.definition.name === "DelegateWork")!.execute,
    ).toBe(delegateWorkTool);
    expect(
      PET_MANAGER_TOOL_CATALOG.find((tool) => tool.definition.name === "GatewayReply")!.execute,
    ).toBe(gatewayReplyTool);
  });

  test("requires a matching independent review and explicit Host opt-in", () => {
    const names = new Set(MANAGER_NAMES);
    const review = REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter((entry) => names.has(entry.tool));
    expect(() =>
      assertExternalToolReviewSnapshot(
        createExternalToolReviewSnapshot(PET_MANAGER_TOOL_CATALOG),
        review,
      ),
    ).not.toThrow();
    const registry = new ToolRegistry({ toolCatalog: PET_MANAGER_TOOL_CATALOG });
    expect(deriveExternalToolExposure(registry).toolNames.size).toBe(0);
    expect([...deriveExternalToolExposure(registry, { mimiHost: true }).toolNames].sort()).toEqual(
      MANAGER_NAMES,
    );

    const delegate = PET_MANAGER_TOOL_CATALOG.find(
      (tool) => tool.definition.name === "DelegateWork",
    )!;
    const changed = new ToolRegistry({
      toolCatalog: [
        {
          ...delegate,
          definition: {
            ...delegate.definition,
            inputSchema: { ...delegate.definition.inputSchema, additionalProperties: true },
          },
        },
      ],
    });
    expect(deriveExternalToolExposure(changed, { mimiHost: true }).toolNames.size).toBe(0);
  });

  test("hides manager tools without Pet visibility and rejects direct calls", async () => {
    const { host, reported } = createHost({ manager: false });
    try {
      expect(host.listTools()).toEqual([]);
      const result = await host.execute({
        id: "unlisted-delegation",
        name: "DelegateWork",
        input: { workspace_id: "workspace-owned", objective: "Must not be accepted" },
      });
      expect(result.isError).toBe(true);
      expect(reported).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  test("the live Host gate revokes all manager tools without admitting general execution", async () => {
    const { host, reported, setEnabled } = createHost();
    try {
      const visible = host.listTools();
      expect(visible.map((tool) => tool.name)).toContain("GatewayReply");
      const delegation = visible.find((tool) => tool.name === "DelegateWork")!;
      expect(delegation.inputSchema.properties?.workspace_id).toMatchObject({
        enum: ["workspace-owned"],
      });
      for (const name of ["Bash", "Read", "DriveAgent", "NotifyMe", "ReportToMimi"]) {
        expect(visible.some((tool) => tool.name === name)).toBe(false);
        expect((await host.execute({ id: `general-${name}`, name, input: {} })).isError).toBe(true);
      }
      setEnabled(false);
      expect(host.listTools()).toEqual([]);
      expect(
        (
          await host.execute({
            id: "revoked-delegation",
            name: "DelegateWork",
            input: { workspace_id: "workspace-owned", objective: "Must remain unaccepted" },
          })
        ).isError,
      ).toBe(true);
      expect(reported).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  test("GatewayReply and DelegateWork require the actual current turn's profile services", async () => {
    const { host, reported } = createHost({ services: false });
    try {
      for (const [name, input] of [
        ["DelegateWork", { workspace_id: "workspace-owned", objective: "Do the task" }],
        ["GatewayReply", { text: "Hello" }],
      ] as const) {
        const result = await host.execute({ id: `missing-services-${name}`, name, input });
        expect(JSON.stringify(result)).toContain("available only");
      }
      expect(reported).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  test("real executors enforce per-turn bounds and report only deferred requests", async () => {
    const { host, reported } = createHost();
    try {
      await host.execute({
        id: "unknown-workspace",
        name: "DelegateWork",
        input: { workspace_id: "foreign-workspace", objective: "Must be rejected" },
      });
      await host.execute({
        id: "reply-too-long",
        name: "GatewayReply",
        input: { text: "x".repeat(81) },
      });
      expect(reported).toEqual({});
      const delegated = await host.execute({
        id: "bounded-workspace",
        name: "DelegateWork",
        input: { workspace_id: "workspace-owned", objective: "Inspect the selected project" },
      });
      expect(delegated.isError).not.toBe(true);
      expect(reported.workDelegation).toMatchObject({
        workspaceId: "workspace-owned",
        objective: "Inspect the selected project",
      });
      const first = reported.workDelegation;
      await host.execute({
        id: "second-delegation",
        name: "DelegateWork",
        input: { workspace_id: "workspace-owned", objective: "A second task" },
      });
      expect(reported.workDelegation).toBe(first);
      const reply = await host.execute({
        id: "bounded-reply",
        name: "GatewayReply",
        input: { text: "One authorized reply" },
      });
      expect(JSON.stringify(reply)).toContain("NOT SENT YET");
      expect(reported.hostActions).toEqual([
        { kind: "gatewayReply", payload: { text: "One authorized reply" } },
      ]);
    } finally {
      await host.dispose();
    }
  });

  test("recurring follow-ups require the current turn's explicit Host action grant", async () => {
    const { host, reported } = createHost();
    try {
      expect(host.listTools().some((tool) => tool.name === "ManageFollowUp")).toBe(false);
      const result = await host.execute({
        id: "ungranted-recurrence",
        name: "ManageFollowUp",
        input: {
          action: "register",
          title: "Weekly check",
          text: "Review the week's tasks",
          recurrence: "0 17 * * 5",
          schedule_label: "每周五 17:00",
          timezone: "Asia/Singapore",
        },
      });
      expect(result.isError).toBe(true);
      expect(reported).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  test("recurrence reaches the real external executor as one deferred Host-validated request", async () => {
    const { host, reported } = createHost({ hostActions: ["followUpMutation"] });
    try {
      const input = {
        action: "register",
        title: "Weekly check",
        text: "Review the week's tasks",
        recurrence: "0 17 * * 5",
        schedule_label: "每周五 17:00",
        timezone: "Asia/Singapore",
      };
      const result = await host.execute({
        id: "deferred-recurrence",
        name: "ManageFollowUp",
        input,
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).toContain("host will append the authoritative result");
      const expected = {
        kind: "followUpMutation",
        payload: {
          action: "register",
          title: input.title,
          text: input.text,
          intent: "remind",
          recurrence: input.recurrence,
          scheduleLabel: input.schedule_label,
          timezone: input.timezone,
        },
      };
      expect(reported.hostActions).toEqual([expected]);
      expect(isPetHostActionRequest(expected)).toBe(true);
      const accepted = reported.hostActions;
      await host.execute({
        id: "second-recurrence",
        name: "ManageFollowUp",
        input: { ...input, recurrence: "0 9 * * 1-5", schedule_label: "工作日 09:00" },
      });
      expect(reported.hostActions).toBe(accepted);
    } finally {
      await host.dispose();
    }
  });

  test.each([
    { recurrence: "*/15 * * * *" },
    { recurrence: "0,30 9 * * *" },
    { recurrence: "0 9 * *" },
    { recurrence: "60 9 * * *" },
    { recurrence: "0 9 * * *".repeat(8) },
    { wake_at: 5_000 },
    { catch_up_until: 5_000 },
    { schedule_label: "" },
    { schedule_label: "工作日\n09:00" },
    { schedule_label: "x".repeat(65) },
    { timezone: "Not/A_Timezone" },
    { source_session_id: "foreign-session" },
    { intent: "resume", task_id: "foreign-task" },
    { completionTarget: { channel: "wechat", target: "foreign-owner" } },
  ])("external recurrence rejects invalid bounds or forged authority: %j", async (invalid) => {
    const { host, reported } = createHost({ hostActions: ["followUpMutation"] });
    try {
      const result = await host.execute({
        id: "invalid-recurrence",
        name: "ManageFollowUp",
        input: {
          action: "register",
          title: "Weekly check",
          text: "Review the week's tasks",
          recurrence: "0 17 * * 5",
          schedule_label: "每周五 17:00",
          timezone: "Asia/Singapore",
          ...invalid,
        },
      });
      expect(result.isError === true || JSON.stringify(result).includes("Error:")).toBe(true);
      expect(reported).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  test("the replayed recurring Host envelope rejects extra authority and frequency changes", () => {
    const payload = {
      action: "register",
      title: "Weekly check",
      text: "Review the week's tasks",
      intent: "remind",
      recurrence: "0 17 * * 5",
      scheduleLabel: "每周五 17:00",
      timezone: "Asia/Singapore",
    };
    for (const extra of [
      { recurrence: "*/15 * * * *" },
      { wakeAt: 5_000 },
      { catchUpUntil: 5_000 },
      { scheduleLabel: "bad\nlabel" },
      { sourceSessionId: "foreign-session" },
      { completionTarget: { channel: "wechat", target: "foreign-owner" } },
    ]) {
      expect(
        isPetHostActionRequest({ kind: "followUpMutation", payload: { ...payload, ...extra } }),
      ).toBe(false);
    }
  });

  test("retains the owning tool guards and rewriters", async () => {
    const visibility = {
      behaviorProfile: "pet",
      profileMeta: PET_BEHAVIOR_PROFILE.buildVisibilityMeta!(PROFILE_PARAMS),
    } as ToolVisibilityContext;
    for (const name of ["DelegateWork", "GatewayReply", "SendMessage"]) {
      const tool = PET_MANAGER_TOOL_CATALOG.find((entry) => entry.definition.name === name)!;
      expect(typeof tool.exposure.availability).toBe("function");
      expect(typeof tool.exposure.rewriteDefinition).toBe("function");
      expect(tool.exposure.defaultPermissionRules).toContainEqual({
        tool: name,
        decision: "allow",
      });
    }
    const reply = PET_MANAGER_TOOL_CATALOG.find((tool) => tool.definition.name === "GatewayReply")!;
    expect(reply.exposure.availability!(visibility)).toBe(true);
    expect(reply.exposure.availability!({ behaviorProfile: "pet" } as ToolVisibilityContext)).toBe(
      false,
    );
    expect(PET_MANAGER_TOOL_CATALOG.every((tool) => tool.exposure.availability)).toBe(true);
    // The original executor still fails closed even without a visibility wrapper.
    const missing = {} as ToolContext;
    expect(await delegateWorkTool({}, missing)).toContain("available only");
  });
});
