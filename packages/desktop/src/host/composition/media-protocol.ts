import type { MediaProtocolOperations } from "../../shared/media-protocol-operations.js";
import { resolveMediaPreviewAuthority } from "../../main/media-preview-authority.js";
import { MediaPreviewService } from "../../main/media-preview-service.js";
import type { BusinessMethods } from "./business-calls.js";

export function hostedMediaProtocol() {
  // Only Main registers live native documents here, and explicitly releases the
  // owner on navigation/destruction. The workspace/file authority is resolved
  // again by this process for each open/seek and periodically during playback.
  const owners = new Set<number>();
  const service = new MediaPreviewService({
    isOwnerAlive: (id) => owners.has(id),
    resolveAuthority: resolveMediaPreviewAuthority,
  });
  const streams = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
  function cancel(stream: string) {
    const opened = streams.get(stream);
    streams.delete(stream);
    return opened?.cancel().catch(() => {});
  }
  const methods = {
    async "media/create"({ ownerId, request }, grant) {
      grant.assertCurrent();
      owners.add(ownerId);
      const preview = await service.create(ownerId, request);
      if (preview && grant.signal.aborted) service.release(ownerId, preview.url);
      return preview;
    },
    "media/release"({ ownerId, url }) {
      service.release(ownerId, url);
    },
    "media/releaseOwner"(ownerId) {
      owners.delete(ownerId);
      service.releaseOwner(ownerId);
    },
    "media/releaseSession"(sessionId) {
      service.releaseSession(sessionId);
    },
    async "media/open"({ stream, url, method, range }, grant) {
      if (streams.size >= 512 || streams.has(stream)) throw Error("Too many active media reads");
      const response = await service.respond(
        new Request(url, {
          method,
          headers: range === null ? undefined : { range },
          signal: grant.signal,
        }),
      );
      const reader = response.body?.getReader();
      if (reader) {
        if (grant.signal.aborted || streams.size >= 512 || streams.has(stream)) {
          await reader.cancel().catch(() => {});
          throw Error("Media read is no longer available");
        }
        streams.set(stream, reader);
        // A released grant errors every associated reader even while paused.
        void reader.closed.catch(() => streams.delete(stream));
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: !!reader,
      };
    },
    async "media/pull"(stream, grant) {
      const opened = streams.get(stream);
      if (!opened) throw Error("Media read closed");
      const { done, value } = await opened.read();
      grant.assertCurrent();
      if (done) {
        streams.delete(stream);
        return null;
      }
      return value;
    },
    async "media/cancel"(stream) {
      await cancel(stream);
    },
  } satisfies Pick<BusinessMethods, keyof MediaProtocolOperations>;
  return { methods, close: () => Promise.all([...streams.keys()].map(cancel)) };
}
