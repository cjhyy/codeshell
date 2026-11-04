import { parentPort, workerData } from "node:worker_threads";
import { countRelatedSessions, discoverRelatedSessions } from "./related-session-discovery.js";
import type { RelatedSessionDiscoveryOptions } from "./related-session-discovery.js";
import type { DiscoverOptions } from "./session-discovery.js";

const { cwd, opts, discovery, all } = workerData as {
  cwd: string;
  opts: DiscoverOptions;
  discovery: RelatedSessionDiscoveryOptions;
  all: boolean;
};
try {
  const sessions = discoverRelatedSessions("claude", cwd, opts, discovery);
  const total = all ? sessions.length : countRelatedSessions("claude", cwd, discovery);
  parentPort!.postMessage({ ok: true, value: { sessions, total } });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: String(error) });
}
parentPort!.close();
