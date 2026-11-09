/**
 * Credential handoff for Panel Apps: configured connections and saved Cookie
 * logins (`credentials.*`). Cookie values and sealed files never cross into the
 * guest; it receives only account labels and opaque process file handles, after
 * the same trust, domain-match and consent checks as before.
 */
import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import {
  materializePanelConnections,
  panelConnectionIds,
  PanelBridgeError,
  taskCookieSelection,
} from "@cjhyy/code-shell-server/panels";
import type { PanelAppCookieCredential } from "../shared/panel-apps.js";
import type { GuestBinding, PanelAppBridgeInternals } from "./panel-app-bridge-types.js";

export async function panelAuthorizeConnections(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
) {
  bridge.requirePermission(binding, "credentials.connections");
  bridge.requirePermission(binding, "process");
  const input = params as {
    connectionIds?: unknown;
    executableHandle?: unknown;
    argumentName?: unknown;
  };
  const ids = panelConnectionIds(input?.connectionIds);
  const cwd = await bridge.trustedWorkspaceRoot(binding);
  if (typeof input.executableHandle !== "string" || typeof input.argumentName !== "string")
    throw new PanelBridgeError(
      "INVALID_ARGUMENT",
      "Connection handoff requires an executable and argument",
    );
  const sealed = await materializePanelConnections(
    join(app.getPath("userData"), "panel-app-sealed"),
    cwd,
    ids,
  );
  try {
    bridge.assertProjectBinding(binding);
    return await bridge.processService.grantFileArgument(bridge.processOwner(binding), {
      executableHandle: input.executableHandle,
      argumentName: input.argumentName,
      path: sealed.path,
      cleanup: sealed.cleanup,
    });
  } catch (error) {
    sealed.cleanup();
    throw error;
  }
}

export function cookieCredentialUrl(params: unknown): URL {
  const rawUrl = (params as { url?: unknown } | null)?.url;
  let url: URL;
  try {
    url = new URL(typeof rawUrl === "string" ? rawUrl : "");
  } catch {
    throw new Error("Cookie login requires a valid https URL");
  }
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length > 2_048 ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("Cookie login requires a valid https URL");
  }
  return url;
}

/**
 * Match a login URL against a saved credential's domain, one direction only:
 * the requested host must BE the credential domain or sit beneath it.
 *
 * The reverse test (credential domain ends with the requested host) must not
 * be reintroduced — it let a short host claim every longer credential, so
 * `https://com` matched `evil.com` and `zhipin.com` matched
 * `mail.zhipin.com`. Since only `credential.label` (often a phone number or
 * email) crosses back to the guest, a bad match silently leaks accounts.
 *
 * Requiring a dot in the credential domain keeps a bare eTLD entry (`com`,
 * `cn`) from matching an entire suffix.
 */
function cookieCredentialDomainMatches(url: URL, credential: PanelAppCookieCredential): boolean {
  const target = url.hostname.toLowerCase().replace(/^www\./, "");
  const domain = String(credential.domain || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
  if (!domain || !domain.includes(".") || !target) return false;
  return target === domain || target.endsWith(`.${domain}`);
}

/**
 * Reading real credentials is at least as sensitive as writing workspace
 * files, so it takes the same trust gate those paths use
 * (`trustedWorkspaceRoot`) rather than only checking that a cwd is bound.
 */
function cookieCredentialHost(bridge: PanelAppBridgeInternals, binding: GuestBinding) {
  const host = bridge.options.cookieCredentials;
  if (!host) throw new Error("Cookie login is unavailable in this CodeShell host");
  if (!binding.cwd) throw new Error("Cookie login requires an active project-bound task");
  if (!bridge.options.isWorkspaceTrusted(binding.cwd)) {
    throw new Error("Cookie login requires a trusted workspace");
  }
  return host;
}

export async function panelListCookieCredentials(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
): Promise<{ accounts: PanelAppCookieCredential[] }> {
  const url = cookieCredentialUrl(params);
  const host = cookieCredentialHost(bridge, binding);
  const accounts = (await host.list(binding.cwd)).filter((credential) =>
    cookieCredentialDomainMatches(url, credential),
  );
  return { accounts };
}

export async function panelLoginAndSaveCookieCredential(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const input = params as {
    providerId?: unknown;
    providerLabel?: unknown;
    url?: unknown;
  } | null;
  const providerId = typeof input?.providerId === "string" ? input.providerId.trim() : "";
  const providerLabel = typeof input?.providerLabel === "string" ? input.providerLabel.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(providerId)) {
    throw new Error("Cookie login requires a valid provider id");
  }
  if (!providerLabel || providerLabel.length > 80) {
    throw new Error("Cookie login requires a provider label up to 80 characters");
  }
  const url = cookieCredentialUrl(params);
  const host = cookieCredentialHost(bridge, binding);
  return host.loginAndSave({
    appId: binding.resource.descriptor.appId,
    providerId,
    providerLabel,
    url: url.toString(),
    cwd: binding.cwd,
    bucket: binding.bucket,
  });
}

export async function panelRestoreCookieCredential(
  bridge: PanelAppBridgeInternals,
  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const input = params as { credentialId?: unknown; providerLabel?: unknown } | null;
  const credentialId = typeof input?.credentialId === "string" ? input.credentialId.trim() : "";
  const providerLabel =
    typeof input?.providerLabel === "string" ? input.providerLabel.trim() : "招聘渠道";
  if (!credentialId || credentialId.length > 160) {
    throw new Error("Cookie restore requires a saved credential id");
  }
  const host = cookieCredentialHost(bridge, binding);
  const owner = BrowserWindow.fromId(binding.ownerWindowId);
  if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
  const decision = await dialog.showMessageBox(owner, {
    type: "question",
    buttons: ["Restore login", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: binding.resource.descriptor.title,
    message: `Restore the saved login for ${providerLabel || "this channel"}?`,
    detail:
      "CodeShell will inject the selected Cookie credential into this task's browser. The Panel App cannot read the Cookie value.",
    noLink: true,
  });
  if (decision.response !== 0) return { restored: false, cancelled: true };
  const result = await host.restore({
    credentialId,
    cwd: binding.cwd,
    bucket: binding.bucket,
  });
  if ("invalid" in result) return { restored: false, invalid: true };
  return { restored: true, count: result.count };
}

export async function panelAuthorizeCookieCredentialForProcess(
  bridge: PanelAppBridgeInternals,

  binding: GuestBinding,
  params: unknown,
): Promise<unknown> {
  const input = params as {
    credentialId?: unknown;
    url?: unknown;
    executableHandle?: unknown;
    revision?: unknown;
  } | null;
  if (input?.revision !== undefined) {
    bridge.requirePermission(binding, "process");
    bridge.requirePermission(binding, "resources");
    const selection = taskCookieSelection({
      credentialId: input.credentialId,
      url: input.url,
      revision: input.revision,
    });
    const owner = bridge.processOwner(binding);
    const executable = bridge.processService.executableName(owner, input.executableHandle);
    const scope = {
      appId: binding.resource.descriptor.appId,
      projectPath: binding.projectPath,
      revision: binding.resource.descriptor.revision,
    };
    const cwd = binding.cwd;
    const host = bridge.getTaskCookieHost();
    await bridge.confirmTaskCookie(
      binding,
      { cookieArgument: { ...selection, argumentName: "--cookies" } },
      executable,
      false,
    );
    const validate = async () => {
      await host.check(scope, selection);
      if (
        bridge.guests.get(binding.guest.id) !== binding ||
        binding.guest.isDestroyed() ||
        binding.cwd !== cwd ||
        binding.resource.descriptor.revision !== scope.revision ||
        !bridge.options.isWorkspaceTrusted(cwd ?? scope.projectPath)
      )
        throw new PanelBridgeError("REVOKED", "Panel scope changed during Cookie access");
      bridge.assertProjectBinding(binding);
    };
    const lease = await host.materialize(scope, selection);
    try {
      await validate();
      const sealed = await bridge.processService.grantFileArgument(owner, {
        executableHandle: input.executableHandle,
        argumentName: "--cookies",
        path: lease.path,
        validate,
        cleanup: () => {
          void lease.cleanup().catch(() => {});
        },
      });
      return { authorized: true, fileArgumentHandle: sealed.handle, count: lease.count };
    } catch (cause) {
      await lease.cleanup();
      throw cause;
    }
  }
  const credentialId = typeof input?.credentialId === "string" ? input.credentialId.trim() : "";
  if (!credentialId || credentialId.length > 160) {
    throw new Error("Cookie process authorization requires a saved credential id");
  }
  const url = cookieCredentialUrl(params);
  const host = cookieCredentialHost(bridge, binding);
  if (!host.materialize) {
    throw new Error("Cookie process authorization is unavailable in this CodeShell host");
  }
  const account = (await host.list(binding.cwd)).find(
    (credential) =>
      credential.id === credentialId && cookieCredentialDomainMatches(url, credential),
  );
  if (!account) throw new Error("The selected Cookie login does not match this site");
  if (account.health === "corrupted") {
    throw new Error("The selected Cookie login is corrupted; sign in and save it again");
  }
  const owner = bridge.processOwner(binding);
  const executable = bridge.processService.executableName(owner, input?.executableHandle);
  if (account.autoUseByAI !== true) {
    const window = BrowserWindow.fromId(binding.ownerWindowId);
    if (!window || window.isDestroyed()) throw new Error("owner window is unavailable");
    const decision = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Use saved login", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: binding.resource.descriptor.title,
      message: `Use “${account.label}” with ${executable}?`,
      detail:
        "CodeShell will create a temporary owner-only Cookie file and pass it directly to the selected local program. The Panel App receives only an opaque handle, never the Cookie contents or file path. The file is removed when the Panel closes.",
      noLink: true,
    });
    if (decision.response !== 0) return { authorized: false, cancelled: true };
  }

  const materialized = await host.materialize({ credentialId, cwd: binding.cwd });
  if ("invalid" in materialized) {
    return { authorized: false, invalid: true };
  }
  try {
    const grant = await bridge.processService.grantFileArgument(owner, {
      executableHandle: input?.executableHandle,
      argumentName: "--cookies",
      path: materialized.filePath,
      cleanup: materialized.cleanup,
    });
    return { authorized: true, fileArgumentHandle: grant.handle, count: materialized.count };
  } catch (error) {
    materialized.cleanup();
    throw error;
  }
}
