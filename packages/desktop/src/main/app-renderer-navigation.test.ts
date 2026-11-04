import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { AppRendererNavigation, checkedExternalUrl } from "./app-renderer-navigation";

function fixture(url = "file:///app/renderer/index.html?popout=browser") {
  const opened: string[] = [];
  const guard = new AppRendererNavigation("file:///app/renderer/index.html", async (url) => {
    opened.push(url);
  });
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    getURL: () => url,
    isDestroyed: () => false,
    setWindowOpenHandler(handler: any) {
      this.open = handler;
    },
    open: undefined as any,
  });
  guard.bind(contents as unknown as WebContents);
  return {
    guard,
    contents,
    opened,
    event: { sender: contents as unknown as WebContents, senderFrame: contents.mainFrame as any },
  };
}
test("app popouts block remote navigation, redirects and new windows while retaining legitimate links", () => {
  const { contents, opened } = fixture();
  let prevented = 0;
  contents.emit("will-navigate", { preventDefault: () => prevented++ }, "https://example.test/");
  contents.emit(
    "will-redirect",
    { preventDefault: () => prevented++ },
    "https://example.test/redirect",
  );
  expect(prevented).toBe(2);
  expect(contents.open({ url: "file:///tmp/executable" })).toEqual({ action: "deny" });
  expect(contents.open({ url: "https://example.test/link" })).toEqual({ action: "deny" });
  expect(opened).toEqual(["https://example.test/", "https://example.test/link"]);
  contents.emit(
    "will-navigate",
    { preventDefault: () => prevented++ },
    "file:///app/renderer/index.html?popout=browser#view",
  );
  expect(prevented).toBe(2);
});
test("external link IPC accepts only registered application top frames and HTTP URLs", () => {
  const { guard, event, contents } = fixture();
  expect(() => guard.assertSender(event)).not.toThrow();
  expect(() => guard.assertSender({ ...event, senderFrame: {} as any })).toThrow(
    "application window",
  );
  expect(() => guard.assertSender(fixture().event)).toThrow("application window");
  contents.getURL = () => "file://remote-host/app/renderer/index.html";
  expect(() => guard.assertSender(event)).toThrow();
  contents.getURL = () => "https://example.test/";
  expect(() => guard.assertSender(event)).toThrow();
  for (const value of [
    "file:///tmp/file",
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:a@b",
    "not a URL",
  ])
    expect(() => checkedExternalUrl(value)).toThrow();
  expect(checkedExternalUrl("https://example.test/path")).toBe("https://example.test/path");
});
test("development renderer matching uses URL origin and document rather than a prefix", () => {
  const { contents, event } = fixture("http://localhost:3000/?popout=browser");
  const guard = new AppRendererNavigation("http://localhost:3000", async () => {});
  guard.bind(event.sender);
  expect(() => guard.assertSender(event)).not.toThrow();
  for (const url of [
    "http://localhost:3000.evil.test/",
    "http://localhost:3000/other.html",
    "http://localhost:3001/",
  ]) {
    contents.getURL = () => url;
    expect(() => guard.assertSender(event)).toThrow();
  }
});
