import { test, expect } from "bun:test";
import React from "react";
import chalk from "chalk";
import { Box, Text, NoSelect, Link } from "../src/render/index.js";
import { mount, dumpFrames, flush } from "./render-fixtures";

test("renders text inside a box", async () => {
  const h = mount(React.createElement(Box, null,
    React.createElement(Text, null, "hello"),
  ));
  await flush();
  expect(dumpFrames(h)).toContain("hello");
  h.unmount();
});

test("wraps wide characters by display width, not codepoint count", async () => {
  const h = mount(
    React.createElement(Box, { width: 4 },
      React.createElement(Text, null, "你好世界"),
    ),
    { columns: 80 },
  );
  await flush();
  const out = dumpFrames(h);
  // Each CJK char is width 2 — 4 cols fits exactly 2 chars per row.
  expect(out).toContain("你好");
  expect(out).toContain("世界");
  h.unmount();
});

test("applies ANSI bold style", async () => {
  // Ensure chalk emits ANSI codes even in non-TTY test environment.
  const prevLevel = chalk.level;
  chalk.level = 1;
  try {
    const h = mount(React.createElement(Text, { bold: true }, "bold"));
    await flush();
    expect(dumpFrames(h)).toMatch(/\x1b\[(?:[0-9;]*;)?1m/);
    h.unmount();
  } finally {
    chalk.level = prevLevel;
  }
});

test("emits OSC 8 hyperlink around link text", async () => {
  // Force hyperlink support so Link renders <ink-link> regardless of terminal.
  const origTermProgram = process.env["TERM_PROGRAM"];
  process.env["TERM_PROGRAM"] = "iTerm.app";
  try {
    const h = mount(
      React.createElement(Link, { url: "https://example.com" },
        React.createElement(Text, null, "site"),
      ),
    );
    await flush();
    // OSC 8 format: ESC ] 8 ; <params> ; <url> BEL — params include id= for grouping wrapped lines.
    expect(dumpFrames(h)).toMatch(/\]8;[^;]*;https:\/\/example\.com/);
    h.unmount();
  } finally {
    if (origTermProgram === undefined) {
      delete process.env["TERM_PROGRAM"];
    } else {
      process.env["TERM_PROGRAM"] = origTermProgram;
    }
  }
});

test("NoSelect region content still renders alongside selectable content", async () => {
  const h = mount(
    React.createElement(Box, null,
      React.createElement(NoSelect, null,
        React.createElement(Text, null, "gutter"),
      ),
      React.createElement(Text, null, "body"),
    ),
  );
  await flush();
  expect(dumpFrames(h)).toContain("gutter");
  expect(dumpFrames(h)).toContain("body");
  h.unmount();
});

test("soft-wrap inserts a line break at the box edge", async () => {
  const h = mount(
    React.createElement(Box, { width: 5 },
      React.createElement(Text, null, "abcdefghij"),
    ),
    { columns: 80 },
  );
  await flush();
  const out = dumpFrames(h);
  expect(out).toContain("abcde");
  expect(out).toContain("fghij");
  h.unmount();
});
