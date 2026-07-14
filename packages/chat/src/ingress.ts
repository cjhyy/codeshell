export const CHAT_WEBHOOK_PATHS = [
  "/webhooks/line",
  "/webhooks/whatsapp",
  "/webhooks/teams",
] as const;

export type IngressFormat = "caddy" | "nginx";

export function renderWebhookIngress(input: {
  format: IngressFormat;
  publicHost: string;
  upstream?: string;
  maxBodyBytes?: number;
}): string {
  const host = validateHost(input.publicHost);
  const upstream = validateUpstream(input.upstream ?? "127.0.0.1:8787");
  const maxBodyBytes = input.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer");
  }
  if (input.format === "caddy") {
    return `${host} {
  request_body {
    max_size ${maxBodyBytes}
  }
  @chat_webhooks path ${CHAT_WEBHOOK_PATHS.join(" ")}
  reverse_proxy @chat_webhooks ${upstream}
  respond /healthz 404
  respond 404
}
`;
  }
  return `server {
  listen 443 ssl http2;
  server_name ${host};
  client_max_body_size ${maxBodyBytes};

  # Configure ssl_certificate and ssl_certificate_key using your ACME client.
  location ~ ^/webhooks/(line|whatsapp|teams)$ {
    proxy_pass http://${upstream};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering on;
  }

  location / { return 404; }
}
`;
}

function validateHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error("public host must be a DNS hostname");
  }
  return host;
}

function validateUpstream(value: string): string {
  const url = new URL(`http://${value}`);
  if (
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("webhook upstream must be a loopback host:port");
  }
  return value;
}
