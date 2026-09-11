import { browserPartitionForBucket } from "../shared/browser-profile.js";
import { QUICK_CHAT_BUCKET_PREFIX } from "../shared/browser-partition.js";
import type { PreparedAgentRunMetadata } from "./agent-run-metadata.js";
import { externalRuntimeBrowserBucket } from "./external-runtime-browser-bucket.js";

export interface AgentRunBrowserRegistration {
  sessionId: string;
  bucket: string;
  partition: string;
}

export interface AgentRunBrowserRegistrationContext {
  existingBucket?: string | null;
  existingPartition?: string | null;
  externalRuntime?: boolean;
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

  // External runtimes use their own cookie jar even when the Session belongs
  // to a project. A cold continuation must restore that isolation.
  const params = prepared.parsed.params as Record<string, unknown> | undefined;
  const projectId = params?.projectId;
  const bucket = sessionId.startsWith("qchat-")
    ? `${QUICK_CHAT_BUCKET_PREFIX}${sessionId}`
    : context.externalRuntime
      ? externalRuntimeBrowserBucket(sessionId)
      : `${typeof projectId === "string" && projectId ? projectId : "__no_repo__"}::${sessionId}`;
  return { sessionId, bucket, partition: browserPartitionForBucket(bucket) };
}
