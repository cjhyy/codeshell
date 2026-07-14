import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelMessageHandler, WebhookChannelAdapter } from "./channel.js";

export interface WebhookIngressConfig {
  host: string;
  port: number;
  maxBodyBytes: number;
  healthPath?: string;
  readyPath?: string;
  requestTimeoutMs?: number;
}

export interface WebhookRegistration {
  adapter: WebhookChannelAdapter;
  handler: ChannelMessageHandler;
}

export class WebhookIngressServer {
  private server?: Server;

  constructor(
    private readonly config: WebhookIngressConfig,
    private readonly registrations: WebhookRegistration[],
    private readonly health: () => Record<string, unknown> = () => ({ status: "ready" }),
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const routes = new Map(
      this.registrations.map((registration) => [registration.adapter.webhookPath, registration]),
    );
    this.server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === (this.config.healthPath ?? "/healthz")) {
        request.resume();
        sendJson(response, 200, { status: "ok", ...this.health() });
        return;
      }
      if (request.method === "GET" && pathname === (this.config.readyPath ?? "/readyz")) {
        request.resume();
        const body = this.health();
        sendJson(response, body.status === "ready" ? 200 : 503, body);
        return;
      }
      const registration = routes.get(pathname);
      if (!registration) {
        sendResponse(response, 404, "Not found");
        return;
      }
      void registration.adapter
        .handleWebhook(request, response, registration.handler, this.config.maxBodyBytes)
        .catch((error) => {
          if (response.headersSent) {
            response.end();
            return;
          }
          sendResponse(
            response,
            error instanceof WebhookBodyTooLargeError ? 413 : 500,
            error instanceof WebhookBodyTooLargeError ? "Payload too large" : "Webhook error",
          );
        });
    });
    this.server.requestTimeout = this.config.requestTimeoutMs ?? 15_000;
    await listen(this.server, this.config.host, this.config.port);
    const address = this.server.address() as AddressInfo;
    console.log(`[chat] webhook ingress：http://${address.address}:${address.port}`);
    if (signal.aborted) await close(this.server);
    else {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await close(this.server);
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendResponse(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

export class WebhookBodyTooLargeError extends Error {}

export async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      request.resume();
      throw new WebhookBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function sendResponse(
  response: ServerResponse,
  status: number,
  body = "",
  contentType = "text/plain; charset=utf-8",
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(body);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
