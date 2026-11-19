import { browserPartitionForBucket } from "../shared/browser-profile.js";
import { QUICK_CHAT_BUCKET_PREFIX } from "../shared/browser-partition.js";
import type { PreparedAgentRunMetadata } from "./agent-run-metadata.js";

export interface AgentRunBrowserRegistration {
  sessionId: string;
  bucket: string;
  partition: string;
}

export interface AgentRunBrowserRegistrationContext {
  existingBucket?: string | null;
  existingPartition?: string | null;
}

/**
 * The bucket Main derives for a Session when no renderer supplied one. It is
 * byte-identical to the renderer's `bucketKey(projectId, sessionId)`, so the
 * Session's BrowserPanel tabs and its automation meet in one workspace, and
 * its partition is the project profile every Session of that project shares.
 *
 * Sessions driven by an external Agent Runtime use this too. Keeping
 * automation off the tab a user is looking at is the job of tab control (a
 * task-owned window by default, a BrowserPanel tab only after an explicit
 * grant), not of a separate cookie jar.
 */
export function defaultSessionBrowserBucket(sessionId: string, projectId?: unknown): string {
  if (sessionId.startsWith("qchat-")) return `${QUICK_CHAT_BUCKET_PREFIX}${sessionId}`;
  return `${typeof projectId === "string" && projectId ? projectId : "__no_repo__"}::${sessionId}`;
}

/**
 * Restore browser routing for authorized runs without a renderer-provided
 * bucket, such as a scheduled continuation after the app has restarted.
 * Call only after prepareAgentRunMetadata has resolved Session authority.
 */
export function resolveAgentRunBrowserRegistration(
  prepared: PreparedAgentRunMetadata,
  context: AgentRunBrowserRegistrationContext = {},
): AgentRunBrowserRegistration | undefined {
  const { sessionId } = prepared;
  if (prepared.parsed.method !== "agent/run" || !sessionId) return undefined;

  // Explicit renderer/host routing retains its existing validation path.
  if (prepared.bucket) {
    return {
      sessionId,
      bucket: prepared.bucket,
      partition: prepared.browserPartition ?? browserPartitionForBucket(prepared.bucket),
    };
  }

  // An absent cwd means there is no resolved run authority to derive from.
  if (!prepared.cwd) return undefined;

  if (context.existingBucket) {
    return {
      sessionId,
      bucket: context.existingBucket,
      partition: context.existingPartition ?? browserPartitionForBucket(context.existingBucket),
    };
  }

  const params = prepared.parsed.params as Record<string, unknown> | undefined;
  const bucket = defaultSessionBrowserBucket(sessionId, params?.projectId);
  return { sessionId, bucket, partition: browserPartitionForBucket(bucket) };
}
