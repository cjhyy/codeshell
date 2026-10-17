import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { installPackagedChromiumGuard } from "./packaged-chromium-guard.mjs";

test("each Chromium session allows registered local assets and only the owned HTTP origin", () => {
  const app = new EventEmitter();
  const origin = "http://127.0.0.1:12345";
  installPackagedChromiumGuard(app, origin);
  for (let index = 0; index < 3; index++) {
    let registrations = 0;
    let beforeRequest;
    const session = {
      webRequest: {
        onBeforeRequest(filter, callback) {
          expect(filter).toEqual({ urls: ["<all_urls>"] });
          registrations++;
          beforeRequest = callback;
        },
      },
    };
    app.emit("web-contents-created", {}, { session });
    app.emit("web-contents-created", {}, { session });
    expect(registrations).toBe(1);
    for (const url of [
      "file:///owned/app.asar/out/renderer/index.html",
      "data:image/png;base64,AA==",
      "blob:null/owned",
      "devtools://devtools/bundled/inspector.html",
      "cspanel://owned-host/app/index.html",
      "csmedia://owned-session/owned-resource",
      "cstheme://owned-theme/assets/background.png",
      `${origin}/v1/messages`,
    ]) {
      const results = [];
      beforeRequest({ url }, (result) => results.push(result));
      expect(results).toEqual([{ cancel: false }]);
    }
    // Transport and lookalike probes stay denied after enabling local assets.
    for (const url of [
      "https://packaged-pet-negative.invalid/",
      "http://packaged-pet-negative.invalid/",
      "http://127.0.0.1:12346/",
      "https://127.0.0.1:12345/",
      "ws://127.0.0.1:12345/",
      "http://127.0.0.1:12345@packaged-pet-negative.invalid/",
      "codeshell-panel://owned-host/app/index.html",
      "cspanel-remote://owned-host/app/index.html",
      "cstheme-remote://owned-theme/assets/background.png",
      "csmedia-remote://owned-session/owned-resource",
      "not a URL",
    ]) {
      const results = [];
      beforeRequest({ url }, (result) => results.push(result));
      expect(results).toEqual([{ cancel: true }]);
    }
  }
});
