import { expect, test } from "bun:test";
import { createCloudWorkbenchDisplayCapture } from "./cloud-workbench-capture.js";

function fixture() {
  let revision = 1,
    trusted = true,
    chosen = 1;
  let resolveChoice: ((choice: number) => void) | undefined;
  let pending = false,
    sources = 0,
    prompts = 0;
  const frame = { url: "https://cloud.test/p/A/", parent: null };
  const replies: unknown[] = [];
  const capture = createCloudWorkbenchDisplayCapture({
    revision: () => revision,
    isTrusted: () => trusted,
    getSources: async () => {
      sources++;
      return [{ id: "display:1", name: "Screen" }];
    },
    choose: async () => {
      prompts++;
      return pending
        ? new Promise<number>((resolve) => {
            resolveChoice = resolve;
          })
        : chosen;
    },
    systemAudio: true,
  });
  const request = {
    frame,
    securityOrigin: "https://cloud.test",
    userGesture: true,
    videoRequested: true,
    audioRequested: true,
  };
  return {
    request,
    replies,
    capture: () =>
      capture(request, (value) => {
        replies.push(value);
      }),
    navigate: () => {
      revision++;
    },
    revoke: () => {
      trusted = false;
    },
    pending: () => {
      pending = true;
    },
    finish: () => resolveChoice!(1),
    cancel: () => {
      chosen = 0;
    },
    sources: () => sources,
    prompts: () => prompts,
  };
}
test("trusted top-level activated request receives only the explicitly selected source", async () => {
  const f = fixture();
  await f.capture();
  expect(f.replies).toEqual([{ video: { id: "display:1", name: "Screen" }, audio: "loopback" }]);
});
test("iframes, missing activation, audio-only requests and untrusted windows never open a picker", async () => {
  for (const reason of ["frame", "gesture", "video", "trust"]) {
    const f = fixture();
    if (reason === "frame") (f.request.frame as any).parent = {};
    if (reason === "gesture") f.request.userGesture = false;
    if (reason === "video") f.request.videoRequested = false;
    if (reason === "trust") f.revoke();
    await f.capture();
    expect(f.replies).toEqual([{}]);
    expect(f.sources()).toBe(0);
    expect(f.prompts()).toBe(0);
  }
});
test("A to B to A navigation while choosing invalidates the original capture", async () => {
  const f = fixture();
  f.pending();
  const operation = f.capture();
  await Promise.resolve();
  await Promise.resolve();
  f.navigate();
  f.navigate();
  f.finish();
  await operation;
  expect(f.replies).toEqual([{}]);
});
test("cancellation and revocation while selecting return no display", async () => {
  const cancelled = fixture();
  cancelled.cancel();
  await cancelled.capture();
  expect(cancelled.replies).toEqual([{}]);
  const revoked = fixture();
  revoked.pending();
  const operation = revoked.capture();
  await Promise.resolve();
  await Promise.resolve();
  revoked.revoke();
  revoked.finish();
  await operation;
  expect(revoked.replies).toEqual([{}]);
});
