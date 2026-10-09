/** Test-only custody adapter. Core is supplied after process confinement. */
export function installOperationReadFixture(core, origin, phase) {
  const state = { enabled: true, events: [] };
  const record = (event) => {
    state.events.push(event);
    if (state.events.length > 50) state.events.shift();
  };
  const credential = {
    id: "synthetic-read-link",
    type: "oauth",
    label: "Synthetic",
    hasSecret: true,
    oauthStatus: { state: "valid", hasRefreshToken: true, canRefresh: true },
    meta: {
      linkProvider: "github",
      linkAccountId: "synthetic-account",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteState: "connected",
      linkRemoteGrantId: "synthetic-grant",
      linkLastVerifiedAt: "2026-10-09T00:00:00Z",
      linkCapabilityIds: ["github.get_repository", "github.get_starred", "github.set_starred"],
    },
  };
  core.setDefaultCredentialAccess({
    listMasked: (_cwd, scope) => (state.enabled && scope === "full" ? [credential] : []),
    resolveMeta: (_cwd, id, scope) => {
      const selected = state.enabled && scope === "full" && id === credential.id;
      record({ kind: "resolveMeta", scope, selected });
      return selected ? credential : undefined;
    },
    envExposures: () => ({}),
    resolveValue: async () => {
      throw new Error("No raw token access");
    },
    executeRemoteLinkAction: async ({ action, params, scope }) => {
      record({ kind: "executeRemoteLinkAction", action, scope });
      if (scope !== "full") throw new Error("Synthetic global connection requires full custody");
      const write = action === "set_starred";
      if (phase !== "original" && write) throw new Error("Read acceptance refuses all writes");
      if (!["get_repository", "get_starred", "set_starred"].includes(action))
        throw new Error("Unexpected fixture action");
      const response = await fetch(
        `${origin}/${phase}/${action}${write ? "" : `?params=${encodeURIComponent(JSON.stringify(params))}`}`,
        {
          method: write ? "POST" : "GET",
          ...(write ? { body: JSON.stringify(params) } : {}),
        },
      );
      return response.json();
    },
  });
  return state;
}
