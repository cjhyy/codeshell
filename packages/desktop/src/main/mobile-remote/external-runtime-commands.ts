import { parseExternalRuntimeModelKey } from "../../shared/external-runtime-models.js";
import type { ExternalRuntimeService } from "../external-runtime-service.js";
import type {
  DispatchMobileChatTurnInput,
  MobileClientEvent,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";

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

type Authority = {
  stamp: string;
  cwd: string;
  projectId?: string | null;
  rootId?: string | null;
  assertCurrent: () => void;
};
type Selection = {
  sessionId: string;
  deviceId: string;
  external: boolean;
  authority?: Authority;
  owner?: number;
};
export interface MobileExternalRuntimeCommandsDeps {
  authenticated: (viewer: string, device: string) => boolean;
  authority: (sessionId: string) => Promise<Authority>;
  owner: (sessionId: string) => number | undefined;
  service: () => ExternalRuntimeService | null;
  isExternal: (sessionId: string) => boolean;
  exists: (sessionId: string) => boolean;
  attachmentPath: (path: string, cwd: string) => Promise<string>;
}

/** Independent command authority from the paired socket, never a recovery/read grant. */
export class MobileExternalRuntimeCommands {
  private readonly selections = new Map<string, Selection>();
  // A retired external selection cannot become a native producer merely
  // because its state disappeared or was recreated under the same ID.
  private readonly externalRoutes = new Map<string, string>();
  constructor(private readonly deps: MobileExternalRuntimeCommandsDeps) {}

  revoke(viewer: string, releaseRoute = false): void {
    this.selections.delete(viewer);
    if (releaseRoute) this.externalRoutes.delete(viewer);
  }
  isExternal(sessionId: string, viewer?: string, newlyMintedNative = false): boolean {
    const selection = viewer ? this.selections.get(viewer) : undefined;
    return (
      (!newlyMintedNative && !this.deps.exists(sessionId)) ||
      this.deps.isExternal(sessionId) ||
      (!!viewer && this.externalRoutes.get(viewer) === sessionId) ||
      // An evicted/refused/unselected viewer has no proof that an explicit
      // Session still uses its native producer. Never fall through to Core.
      (!!viewer &&
        !newlyMintedNative &&
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
    const selection: Selection = { sessionId: event.sessionId, deviceId: device, external };
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

  async prepare(viewer: string | undefined, device: string | undefined, sessionId: string) {
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
    return { ...captured.authority, submit };
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
