import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** A single physical send; no socket reuse, redirects, or automatic replay. */
export async function requestOnce(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Unsupported Link transport protocol");
  if (
    init.body !== undefined &&
    !(typeof init.body === "string" || init.body instanceof URLSearchParams)
  )
    throw new Error("Unsupported Link request body");
  return new Promise((resolve, reject) => {
    const operation = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
        // Do not reuse a stale socket for an authorization-code or refresh-token exchange.
        agent: false,
      },
      (response) => {
        try {
          const status = response.statusCode ?? 503;
          if (status >= 300 && status < 400) {
            response.resume();
            reject(new Error("Link redirects are not allowed"));
            return;
          }
          const body = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          if (!body) response.resume();
          resolve(new Response(body, { status, headers: { "Content-Type": "application/json" } }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    operation.on("error", reject);
    operation.end(init.body === undefined ? undefined : String(init.body));
  });
}
