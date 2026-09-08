import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent, ToolMessage, safeMessageLink, messageFilePath } from "./MessageContent.js";

function render(text: string, streaming = false) {
  return renderToStaticMarkup(<MessageContent text={text} streaming={streaming} />);
}

describe("Hub message rendering", () => {
  test("completed messages render headings, lists, tables and labeled copyable code blocks", () => {
    const html = render(
      "# 结果\n\n- 一\n- 二\n\n| 项目 | 状态 |\n| --- | --- |\n| 部署 | 完成 |\n\n```typescript\nconst answer = 42;\n```",
    );
    expect(html).toContain("<h1>结果</h1>");
    expect(html).toContain("<li>一</li>");
    expect(html).toContain("<table>");
    expect(html).toContain('aria-label="表格"');
    expect(html).toContain("typescript");
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain("const answer = 42;");
  });

  test("streaming keeps plain text until the message settles", () => {
    const html = render("**正在写**\n```ts\nconst x =", true);
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("message-code-block");
    expect(html).toContain("**正在写**");
    expect(html).toContain("cursor");
  });

  test("reasoning is expandable and separate from the final response", () => {
    const html = renderToStaticMarkup(<MessageContent text="完成" reasoning="检查了两个方案。" />);
    expect(html).toContain('<details class="message-reasoning">');
    expect(html).not.toContain("<details open");
    expect(html).toContain("思考过程");
    expect(html).toContain("检查了两个方案。");
    expect(html).toContain("<p>完成</p>");
  });

  test("raw HTML and active URL schemes cannot create script, iframe or event handlers", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<iframe src="https://tracker.example"></iframe>\n\n[点击](javascript:alert%281%29) [数据](data:text/html,bad) [本地](file:///etc/passwd) [编码](java&#x73;cript:alert%281%29)',
    );
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(html).not.toContain("onerror=");
    expect(html).not.toMatch(/href="(?:javascript|data|file):/);
  });

  test("rendering a remote Markdown image creates only an explicit external link, no image or preload request", () => {
    const html = render("![示意图](https://tracker.example/image.png?user=123)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).toContain('href="https://tracker.example/image.png?user=123"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("打开图片");
  });

  test("workspace paths stay copyable without navigating to a nonexistent SPA route", () => {
    const html = render("[结果文件](./reports/result.md)");
    expect(html).not.toContain('href="./reports/result.md"');
    expect(html).toContain('title="./reports/result.md"');
    expect(html).toContain("复制路径");
  });

  test("URL checking rejects whitespace-obfuscated schemes and allows ordinary external links", () => {
    expect(safeMessageLink("https://example.com/report?q=1")).toBe(
      "https://example.com/report?q=1",
    );
    expect(safeMessageLink("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    for (const unsafe of [
      "javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,x",
      "file:///tmp/report.html",
      "//example.com",
      "/api/v1/auth/logout",
    ])
      expect(safeMessageLink(unsafe)).toBeUndefined();
  });

  test("tool cards preserve parameters/results and escape untrusted output", () => {
    const html = renderToStaticMarkup(
      <ToolMessage
        running={false}
        item={{
          kind: "tool",
          id: "t1",
          name: "Bash",
          args: { command: "printf hello" },
          result: "<script>alert(1)</script>",
          error: true,
          done: true,
        }}
      />,
    );
    expect(html).toContain("printf hello");
    expect(html).toContain("失败");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("复制结果");
  });
});

test("workspace Markdown paths decode Unicode and reserved filename characters exactly once", () => {
  expect(messageFilePath("./%E6%8A%A5%E5%91%8A%20%2520%23%3F.txt#L12")).toBe("./报告 %20#?.txt");
  expect(messageFilePath("./source.ts?preview=1#L7")).toBe("./source.ts");
  for (const invalid of [
    "#heading",
    "?query",
    "%00file",
    "%2F%2Fevil.example",
    "file%3A%2Ftmp",
    "%E0%A4",
  ])
    expect(messageFilePath(invalid)).toBeUndefined();
  const html = render("[报告](<./报告 文件%25.txt>)");
  expect(html).toContain('title="./报告 文件%.txt"');
});

test("local Markdown images open the authenticated workspace preview only on user action", () => {
  const html = renderToStaticMarkup(
    <MessageContent text="![任务图片](./%E5%9B%BE%E7%89%87%20%231.png)" onOpenFile={() => {}} />,
  );
  expect(html).toContain('<button class="message-image-reference"');
  expect(html).toContain('title="./图片 #1.png"');
  expect(html).toContain("查看图片");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<link");
});
