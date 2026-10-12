import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountProfileUrl, CloudAccountControls } from "./CloudAccountControls.js";

test("Cloud account profile navigation derives only a fixed Account-origin portal", () => {
  for (const origin of [
    "https://accounts.example",
    "https://accounts.example:8443",
    "http://127.0.0.1:4103",
    "http://[::1]:4103",
  ])
    expect(accountProfileUrl(origin)).toBe(`${origin}/api/v1/account/manage`);
  for (const origin of [
    undefined,
    "",
    "http://accounts.example",
    "https://accounts.example/",
    "https://accounts.example/other",
    "https://user:secret@accounts.example",
    "https://accounts.example?token=private",
    "https://accounts.example#ticket=private",
    "javascript:alert(1)",
  ])
    expect(accountProfileUrl(origin)).toBeUndefined();
});

test("Cloud account controls use independent blank-tab navigation without authority in the URL", () => {
  const markup = renderToStaticMarkup(
    <CloudAccountControls
      pending={false}
      error=""
      onLogout={() => {}}
      accountOrigin="https://accounts.example"
    />,
  );
  expect(markup).toContain('href="https://accounts.example/api/v1/account/manage"');
  expect(markup).toContain('target="_blank"');
  expect(markup).toContain('rel="noopener noreferrer"');
  expect(markup).toContain("账号资料");
  expect(markup).toContain("退出此 Cloud 工作台");
  const unavailable = renderToStaticMarkup(
    <CloudAccountControls pending={false} error="" onLogout={() => {}} />,
  );
  expect(unavailable).not.toContain("href=");
  expect(unavailable).toContain("disabled");
  expect(unavailable).toContain("尚未提供账号服务地址");
});
