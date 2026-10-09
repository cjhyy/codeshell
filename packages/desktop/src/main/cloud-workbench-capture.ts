/** A cloud workbench gets a user-selected display source, never a local preload. */
export interface CloudCaptureSource {
  id: string;
  name: string;
}
export interface CloudCaptureFrame {
  url: string;
  parent: unknown;
}
export function createCloudWorkbenchDisplayCapture(options: {
  isTrusted: (frame: CloudCaptureFrame, securityOrigin: string) => boolean;
  revision: () => number;
  getSources: () => Promise<CloudCaptureSource[]>;
  choose: (sources: CloudCaptureSource[], more: boolean) => Promise<number>;
  systemAudio: boolean;
}) {
  return async (
    request: {
      frame: CloudCaptureFrame | null;
      securityOrigin: string;
      userGesture: boolean;
      videoRequested: boolean;
      audioRequested: boolean;
    },
    callback: (streams: { video?: CloudCaptureSource; audio?: "loopback" }) => void,
  ) => {
    let settled = false;
    const finish = (streams: { video?: CloudCaptureSource; audio?: "loopback" } = {}) => {
      if (settled) return;
      settled = true;
      try {
        callback(streams);
      } catch {
        /* The originating frame may already be destroyed. */
      }
    };
    const frame = request.frame;
    const revision = options.revision();
    const url = frame?.url;
    const active = () =>
      !!frame &&
      request.frame === frame &&
      frame.url === url &&
      !frame.parent &&
      revision === options.revision() &&
      options.isTrusted(frame, request.securityOrigin);
    try {
      if (!request.userGesture || !request.videoRequested || !active()) return finish();
      const sources = await options.getSources();
      if (!active()) return finish();
      for (let offset = 0; offset < sources.length; offset += 12) {
        const page = sources.slice(offset, offset + 12);
        const more = offset + page.length < sources.length;
        const response = await options.choose(page, more);
        if (!active() || response === 0) return finish();
        if (more && response === page.length + 1) continue;
        const selected = page[response - 1];
        if (!selected) return finish();
        return finish({
          video: selected,
          ...(request.audioRequested && options.systemAudio ? { audio: "loopback" as const } : {}),
        });
      }
      finish();
    } catch {
      finish();
    }
  };
}
