import { describe, expect, test } from "bun:test";
import { renderWebhookIngress } from "./ingress.js";

describe("fixed webhook ingress", () => {
  test("renders a TLS Caddy route for webhook paths only", () => {
    const config = renderWebhookIngress({
      format: "caddy",
      publicHost: "chat.example.com",
    });
    expect(config).toContain("chat.example.com");
    expect(config).toContain("/webhooks/line");
    expect(config).toContain("/webhooks/whatsapp");
    expect(config).toContain("/webhooks/teams");
    expect(config).toContain("reverse_proxy @chat_webhooks 127.0.0.1:8787");
    expect(config).toContain("respond /healthz 404");
  });

  test("refuses public or credential-bearing upstreams", () => {
    expect(() =>
      renderWebhookIngress({
        format: "nginx",
        publicHost: "chat.example.com",
        upstream: "example.com:8787",
      }),
    ).toThrow("loopback");
    expect(() => renderWebhookIngress({ format: "caddy", publicHost: "not a host" })).toThrow(
      "DNS",
    );
  });
});
