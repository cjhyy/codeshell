import type { ServerResponse } from "node:http";

/** Response lifetimes are session-owned; accepted background work is not. */
export function createSessionHttpResponses() {
  const owners = new Map<string, Map<ServerResponse, () => void>>();

  function cancelOwner(sessionId: string): void {
    const responses = owners.get(sessionId);
    if (!responses) return;
    for (const [response, release] of responses) {
      release();
      response.destroy();
    }
  }

  return {
    track(sessionId: string, response: ServerResponse): void {
      if (response.destroyed || response.writableFinished) return;
      let responses = owners.get(sessionId);
      if (!responses) owners.set(sessionId, (responses = new Map()));
      const owned = responses;
      const release = () => {
        response.off("finish", release);
        response.off("close", release);
        owned.delete(response);
        if (owned.size === 0) owners.delete(sessionId);
      };
      owned.set(response, release);
      // A handler may return before its stream finishes. Follow the actual
      // response, so revocation still aborts the upstream pipeline and its files.
      response.once("finish", release);
      response.once("close", release);
    },
    cancelOwner,
    clear(): void {
      for (const sessionId of owners.keys()) cancelOwner(sessionId);
    },
  };
}
