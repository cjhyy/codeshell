import { describe, expect, test } from "bun:test";
import { renderWebhookIngress, CHAT_WEBHOOK_PATHS } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/chat/src/ingress.ts";

describe("round17 pure ingress ordinary loopback endpoints", () => {
  test("default upstream and ordinary host normalization generate both formats", () => {
    const caddy = renderWebhookIngress({ format: "caddy", publicHost: " Chat.Example.Com " });
    const nginx = renderWebhookIngress({ format: "nginx", publicHost: "chat.example.com", maxBodyBytes: 2048 });
    expect(caddy).toContain("chat.example.com {");
    expect(caddy).toContain("reverse_proxy @chat_webhooks 127.0.0.1:8787");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:8787;");
    expect(nginx).toContain("client_max_body_size 2048;");
    for (const path of CHAT_WEBHOOK_PATHS) expect(caddy).toContain(path);
  });

  test("all supported loopback host spellings retain a non-default explicit port", () => {
    for (const upstream of ["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]) {
      expect(renderWebhookIngress({ format: "caddy", publicHost: "chat.example.com", upstream }))
        .toContain(`reverse_proxy @chat_webhooks ${upstream}`);
      expect(renderWebhookIngress({ format: "nginx", publicHost: "chat.example.com", upstream }))
        .toContain(`proxy_pass http://${upstream};`);
    }
  });

  test("characterization: explicit HTTP default port is rejected after URL normalization", () => {
    for (const upstream of ["127.0.0.1:80", "localhost:80", "[::1]:80"]) {
      // This is a valid, explicitly ported loopback endpoint. No listener or network request is used.
      expect(new URL(`http://${upstream}`).port).toBe("");
      for (const format of ["caddy", "nginx"] as const) {
        expect(() => renderWebhookIngress({ format, publicHost: "chat.example.com", upstream }))
          .toThrow("webhook upstream must be a loopback host:port");
      }
    }
  });
});
