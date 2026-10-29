import { randomUUID } from "node:crypto";
import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type {
  DispatchMobileChatTurnInput,
  MobileClientEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import type {
  ExternalApprovalDecision,
  ExternalApprovalEvent,
  ExternalRuntimeApprovals,
} from "../external-runtime-approvals.js";

/** Persisted provider identity survives a missing/invalid model key. */
export function isPersistedExternalRuntime(
  state: { provider?: string; model?: string } | undefined,
): boolean {
  return (
    state?.provider === "codex" ||
    state?.provider === "claude-code" ||
    !!parseExternalRuntimeModelKey(state?.model)
  );
}

export function persistedExternalRuntimeModelKey(
  state: { provider?: string; model?: string } | undefined,
): string | undefined {
  if (parseExternalRuntimeModelKey(state?.model)) return state?.model;
  if (state?.provider === "codex" || state?.provider === "claude-code")
    return `${state.provider}/${state.model ?? ""}`;
  return undefined;
}

type Authority = {
  stamp: string;
  cwd: string;
  mainRoot?: string;
  projectId?: string | null;
  rootId?: string | null;
  assertCurrent: () => void;
};
type Selection = {
  token: string;
  sessionId: string;
  deviceId: string;
  external: boolean;
  authority?: Authority;
  owner?: number;
  fresh?: boolean;
};
export interface MobileRuntimeStart {
  sessionId: string;
  cwd: string;
  mainRoot?: string;
  modelKey: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  owner?: number;
  assertCurrent: () => void;
}
export interface MobileExternalRuntimeCommandsDeps {
  authenticated: (viewer: string, device: string) => boolean;
  authority: (sessionId: string) => Promise<Authority>;
  owner: (sessionId: string) => number | undefined;
  service: () => ExternalRuntimeService | null;
  isExternal: (sessionId: string) => boolean;
  exists: (sessionId: string) => boolean;
  attachmentPath: (path: string, cwd: string) => Promise<string>;
  modelKey?: (sessionId: string) => string | undefined;
  startRuntime?: (request: MobileRuntimeStart) => Promise<void>;
  approvals?: () => ExternalRuntimeApprovals | null;
  approvalEvent?: (viewer: string, event: ExternalApprovalEvent) => void;
}

/** Independent command authority from the paired socket, never a recovery/read grant. */
export class MobileExternalRuntimeCommands {
  private readonly selections = new Map<string, Selection>();
  // A retired external selection cannot become a native producer merely
  // because its state disappeared or was recreated under the same ID.
  private readonly externalRoutes = new Map<string, string>();
  private readonly preparing = new Set<string>();
  constructor(private readonly deps: MobileExternalRuntimeCommandsDeps) {}

  /** Only the Host's successful session.create path may grant a fresh, unpersisted ID. */
  created(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
    authority: Authority,
  ): void {
    if (!viewer || !device || !this.deps.authenticated(viewer, device)) return;
    if (this.selections.size >= 128 && !this.selections.has(viewer)) return;
    authority.assertCurrent();
    this.revoke(viewer, true);
    this.selections.set(viewer, {
      token: randomUUID(),
      sessionId,
      deviceId: device,
      external: false,
      fresh: true,
      authority,
    });
  }

  private assertSelection(viewer: string, device: string, selection: Selection): void {
    if (this.selections.get(viewer) !== selection || !this.deps.authenticated(viewer, device))
      throw new Error("External command selection changed");
    selection.authority?.assertCurrent();
  }

  private async ensureRuntime(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
    options?: { modelKey?: string; permissionMode?: MobileRuntimeStart["permissionMode"] },
  ): Promise<void> {
    const selection = viewer ? this.selections.get(viewer) : undefined;
    if (
      !viewer ||
      !device ||
      !selection?.authority ||
      selection.deviceId !== device ||
      selection.sessionId !== sessionId
    )
      throw new Error("External command selection unavailable");
    this.assertSelection(viewer, device, selection);
    const service = this.deps.service();
    if (!this.deps.startRuntime) return;
    if (!service?.isEnabled()) throw new Error("请先在桌面端启用外部 Agent 运行时。");
    const persisted = this.deps.modelKey?.(sessionId);
    const modelKey = options?.modelKey ?? persisted;
    if (!modelKey || !parseExternalRuntimeModelKey(modelKey))
      throw new Error("Select a Claude Code or Codex model before starting this session");
    // Do not replace an active provider merely because another client sends a different model.
    if (
      service?.get(sessionId) &&
      selection.owner !== undefined &&
      service.captureActiveRun(sessionId, selection.owner)
    ) {
      if (options?.modelKey && options.modelKey !== persisted)
        throw new Error("Stop the running task before changing its runtime model");
      return;
    }
    if (this.preparing.has(sessionId)) throw new Error("External runtime is already starting");
    this.preparing.add(sessionId);
    try {
      if (selection.fresh && this.deps.exists(sessionId))
        throw new Error("New mobile Session was replaced before startup");
      if (!selection.fresh) {
        const current = await this.deps.authority(sessionId);
        this.assertSelection(viewer, device, selection);
        if (current.stamp !== selection.authority.stamp)
          throw new Error("External command authority changed");
      }
      if (!this.externalRoutes.has(viewer) && this.externalRoutes.size >= 128)
        throw new Error("Too many external runtime selections");
      this.externalRoutes.set(viewer, sessionId);
      selection.external = true;
      const assertCurrent = () => {
        this.assertSelection(viewer, device, selection);
        if (this.deps.service() !== service || this.deps.owner(sessionId) !== selection.owner)
          throw new Error("External runtime owner changed while starting");
      };
      // startRuntime establishes an owner once. Subsequent checks use the returned owner;
      // its own start fence validates the captured BrowserWindow across every await.
      const oldOwner = selection.owner;
      await this.deps.startRuntime({
        sessionId,
        cwd: selection.authority.cwd,
        mainRoot: selection.authority.mainRoot,
        modelKey,
        permissionMode: options?.permissionMode,
        owner: oldOwner,
        assertCurrent: () => {
          this.assertSelection(viewer, device, selection);
          if (
            this.deps.service() !== service ||
            (oldOwner !== undefined &&
              this.deps.owner(sessionId) !== undefined &&
              this.deps.owner(sessionId) !== oldOwner)
          )
            throw new Error("External runtime owner changed while starting");
        },
      });
      this.assertSelection(viewer, device, selection);
      if (this.deps.service() !== service) throw new Error("External runtime service changed");
      const authority = await this.deps.authority(sessionId);
      this.assertSelection(viewer, device, selection);
      selection.authority = authority;
      selection.owner = this.deps.owner(sessionId);
      selection.fresh = false;
      assertCurrent();
    } finally {
      this.preparing.delete(sessionId);
      // Startup can persist the canonical Session before a CLI launch fails. Keep
      // that exact authorized root retryable without inventing a new native route.
      if (
        selection.fresh &&
        this.deps.exists(sessionId) &&
        this.deps.modelKey?.(sessionId) === modelKey
      ) {
        try {
          this.assertSelection(viewer, device, selection);
          const authority = await this.deps.authority(sessionId);
          this.assertSelection(viewer, device, selection);
          if (authority.cwd === selection.authority.cwd) {
            selection.authority = authority;
            selection.owner = this.deps.owner(sessionId);
            selection.fresh = false;
          }
        } catch {
          /* A revoked or replaced workspace stays rejected. */
        }
      }
    }
  }

  revoke(viewer: string, releaseRoute = false): void {
    this.selections.delete(viewer);
    if (releaseRoute) this.externalRoutes.delete(viewer);
  }

  /** A checkpoint retires every tab's prior command route for this Session. */
  revokeSession(sessionId: string): void {
    for (const [viewer, selection] of this.selections) {
      if (selection.sessionId === sessionId) this.revoke(viewer, true);
    }
    for (const [viewer, routed] of this.externalRoutes) {
      if (routed === sessionId) this.externalRoutes.delete(viewer);
    }
  }

  /** Capture a selected tab without starting a runtime or granting a new producer. */
  captureSelectedAuthority(viewer: string, device: string, sessionId: string) {
    const selection = this.selections.get(viewer);
    if (
      !selection ||
      selection.deviceId !== device ||
      selection.sessionId !== sessionId ||
      !selection.authority
    )
      throw new Error("Session selection unavailable");
    const authority = selection.authority;
    const owner = this.deps.owner(sessionId);
    const assertCurrent = () => {
      this.assertSelection(viewer, device, selection);
      if (selection.authority !== authority || this.deps.owner(sessionId) !== owner)
        throw new Error("Session selection authority changed");
    };
    assertCurrent();
    return { key: selection.token, stamp: authority.stamp, owner, assertCurrent };
  }
  isExternal(sessionId: string, viewer?: string, newlyMintedNative = false): boolean {
    const selection = viewer ? this.selections.get(viewer) : undefined;
    const exists = this.deps.exists(sessionId);
    const freshNative = newlyMintedNative && !exists;
    return (
      (!freshNative && !exists) ||
      this.deps.isExternal(sessionId) ||
      (!!viewer && this.externalRoutes.get(viewer) === sessionId) ||
      // An evicted/refused/unselected viewer has no proof that an explicit
      // Session still uses its native producer. Never fall through to Core.
      (!!viewer &&
        !freshNative &&
        (!selection || selection.sessionId !== sessionId || selection.external))
    );
  }

  async observe(
    event: MobileClientEvent & { viewerId?: string; deviceId?: string },
  ): Promise<void> {
    const viewer = event.viewerId,
      device = event.deviceId;
    if (!viewer || !device) return;
    if (event.type !== "session.select") {
      if (
        event.type === "session.create" ||
        event.type === "session.recovery.cancel" ||
        ["room.open", "room.create", "room.send", "ccRoom.openSession"].includes(event.type)
      )
        this.revoke(viewer, event.type === "session.create");
      return;
    }
    this.revoke(viewer);
    if (!this.deps.authenticated(viewer, device)) return;
    // Match the bounded recovery subscriptions; no unbounded per-socket state.
    if (this.selections.size >= 128) return;
    // Initial classification uses persisted producer identity. The command
    // routing guard above separately requires a current accepted selection.
    const external =
      this.deps.isExternal(event.sessionId) ||
      this.externalRoutes.get(viewer) === event.sessionId ||
      !this.deps.exists(event.sessionId);
    if (external) {
      if (!this.externalRoutes.has(viewer) && this.externalRoutes.size >= 128) return;
      this.externalRoutes.set(viewer, event.sessionId);
    }
    const selection: Selection = {
      token: randomUUID(),
      sessionId: event.sessionId,
      deviceId: device,
      external,
    };
    this.selections.set(viewer, selection);
    try {
      const authority = await this.deps.authority(event.sessionId);
      if (this.selections.get(viewer) !== selection || !this.deps.authenticated(viewer, device))
        return;
      if (!external) this.externalRoutes.delete(viewer);
      selection.authority = authority;
      selection.owner = this.deps.owner(event.sessionId);
    } catch {
      if (this.selections.get(viewer) === selection) this.revoke(viewer);
    }
  }

  private async authorize(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
  ) {
    const selection = viewer ? this.selections.get(viewer) : undefined;
    if (
      !viewer ||
      !device ||
      !selection?.authority ||
      selection.sessionId !== sessionId ||
      selection.deviceId !== device ||
      !this.deps.authenticated(viewer, device) ||
      selection.owner === undefined
    )
      throw new Error("External command selection unavailable");
    const service = this.deps.service();
    const runtime = service?.get(sessionId);
    if (!service || !runtime)
      throw new Error("Start this external runtime in its Desktop owner first");
    const current = await this.deps.authority(sessionId);
    if (
      this.selections.get(viewer) !== selection ||
      !this.deps.authenticated(viewer, device) ||
      current.stamp !== selection.authority.stamp ||
      this.deps.owner(sessionId) !== selection.owner ||
      this.deps.service() !== service ||
      service.get(sessionId) !== runtime ||
      service.getCwd(sessionId, selection.owner) !== current.cwd
    )
      throw new Error("External command authority changed");
    return { selection, service, runtime, owner: selection.owner, authority: current };
  }

  async prepare(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
    options?: { modelKey?: string; permissionMode?: MobileRuntimeStart["permissionMode"] },
  ) {
    if (this.deps.startRuntime) await this.ensureRuntime(viewer, device, sessionId, options);
    const captured = await this.authorize(viewer, device, sessionId);
    const submit: NonNullable<DispatchMobileChatTurnInput["submit"]> = async (request) => {
      // Server staging supplies trusted metadata, never client-specified absolute paths.
      const metas = (request.params.attachments ?? []) as InputAttachmentMeta[];
      const attachments = await Promise.all(
        metas.map(async (meta) => ({
          path: await this.deps.attachmentPath(meta.absPath, captured.authority.cwd),
          kind: "image" as const,
          mime: meta.mime,
        })),
      );
      let expired = false;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: { ok: true } | { ok: false; message: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          expired = true;
          finish({
            ok: false,
            message: "External input was not accepted before the queue deadline",
          });
        }, 5_000);
        const task = captured.service.send(
          sessionId,
          {
            text: String(request.params.task ?? ""),
            ...(typeof request.params.modelTraceSource === "string" &&
            /^panel:[a-z][a-z0-9-]{0,63}$/.test(request.params.modelTraceSource)
              ? { modelTraceSource: request.params.modelTraceSource }
              : {}),
            // The actual canonical input is published with its journal cursor, including attachments-only.
            displayText: String(request.params.task ?? "") || "图片",
            clientMessageId: String(request.params.clientMessageId),
            attachments,
            ...(attachments.length
              ? {
                  transcriptContent: `${String(request.params.task ?? "")}\n\n<attached-image-paths>\n${attachments.map((item) => item.path).join("\n")}\n</attached-image-paths>`,
                }
              : {}),
          },
          captured.owner,
          undefined,
          {
            beforeInput: async () => {
              const current = await this.authorize(viewer, device, sessionId);
              if (
                expired ||
                current.service !== captured.service ||
                current.runtime !== captured.runtime ||
                current.owner !== captured.owner ||
                current.selection !== captured.selection
              )
                throw new Error("External queued submission was revoked");
              for (const attachment of attachments)
                if (
                  (await this.deps.attachmentPath(attachment.path, current.authority.cwd)) !==
                  attachment.path
                )
                  throw new Error("External attachment changed before input");
              // Path validation awaits; check the socket/selection/runtime again before returning to send.
              const final = await this.authorize(viewer, device, sessionId);
              if (
                expired ||
                final.selection !== captured.selection ||
                final.runtime !== captured.runtime
              )
                throw new Error("External queued submission was revoked");
            },
            assertInputOwner: () => {
              captured.authority.assertCurrent();
              if (
                expired ||
                !viewer ||
                !device ||
                this.selections.get(viewer) !== captured.selection ||
                !this.deps.authenticated(viewer, device) ||
                this.deps.owner(sessionId) !== captured.owner ||
                this.deps.service() !== captured.service ||
                captured.service.get(sessionId) !== captured.runtime
              )
                throw new Error("External queued submission was revoked");
            },
            accepted: () => finish({ ok: true }),
          },
        );
        void task.then(
          () => finish({ ok: false, message: "External input was not accepted" }),
          () =>
            finish({
              ok: false,
              message: "External submission rejected; recover history before retrying",
            }),
        );
      });
    };
    return { ...captured.authority, submit, modelKey: this.deps.modelKey?.(sessionId) };
  }

  async replayApprovals(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
  ): Promise<void> {
    try {
      const current = await this.authorize(viewer, device, sessionId);
      current.authority.assertCurrent();
      for (const pending of this.deps.approvals?.()?.pendingForSession(sessionId, current.owner) ??
        [])
        this.deps.approvalEvent?.(viewer!, {
          type: "requested",
          ...pending,
          ownerWebContentsId: current.owner,
        });
    } catch {
      /* A read selection may have no running runtime; it grants no approval authority. */
    }
  }

  async mirrorApproval(event: ExternalApprovalEvent): Promise<void> {
    await Promise.allSettled(
      [...this.selections]
        .filter(([, selection]) => selection.sessionId === event.sessionId)
        .map(async ([viewer, selection]) => {
          if (event.type === "resolved") {
            // Stop tears down the runtime before asynchronous mirroring finishes.
            // Retiring a card needs the original selected viewer, not a live CLI.
            this.assertSelection(viewer, selection.deviceId, selection);
            if (selection.owner === event.ownerWebContentsId)
              this.deps.approvalEvent?.(viewer, event);
            return;
          }
          const current = await this.authorize(viewer, selection.deviceId, event.sessionId);
          current.authority.assertCurrent();
          if (current.owner !== event.ownerWebContentsId) return;
          if (
            !this.deps
              .approvals?.()
              ?.pendingForSession(event.sessionId, current.owner)
              .some((item) => item.requestId === event.requestId)
          )
            return;
          this.deps.approvalEvent?.(viewer, event);
        }),
    );
  }

  async respondApproval(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
    requestId: string,
    decision: ExternalApprovalDecision,
  ): Promise<boolean> {
    const current = await this.authorize(viewer, device, sessionId);
    current.authority.assertCurrent();
    return (
      this.deps.approvals?.()?.settleForSession(sessionId, requestId, decision, current.owner) ??
      false
    );
  }

  async stop(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
  ): Promise<void> {
    const captured = await this.authorize(viewer, device, sessionId);
    const run = captured.service.captureActiveRun(sessionId, captured.owner);
    if (!run) return;
    const final = await this.authorize(viewer, device, sessionId);
    if (final.selection !== captured.selection || final.runtime !== captured.runtime)
      throw new Error("External cancel authority changed");
    final.authority.assertCurrent();
    await captured.service.interrupt(sessionId, captured.owner, run);
  }
}
