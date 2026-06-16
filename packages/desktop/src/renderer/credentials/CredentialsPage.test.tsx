import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialsPage } from "./CredentialsPage";

describe("CredentialsPage", () => {
  test("renders three tab labels and the Cookie tab by default", () => {
    // renderToStaticMarkup runs no effects (no IPC), so window.codeshell is not
    // touched during the initial render — the default tab is "cookie".
    const html = renderToStaticMarkup(<CredentialsPage activeRepoPath={null} />);
    expect(html).toContain("Cookie");
    expect(html).toContain("Permission Token");
    expect(html).toContain("Link");
    // Cookie tab's intro copy proves it's the default-rendered tab.
    expect(html).toContain("在浏览器打开登陆");
  });
});
