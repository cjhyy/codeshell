import type { GitPanelAppSourceInput } from "./installer.js";
import { PanelAppInstallError } from "./paths.js";
import { withPanelSourceAbort } from "./github-request.js";
import { normalizeGitPanelAppSource } from "./source.js";

const REF_TIMEOUT_MS = 15_000;
const MAX_REF_BYTES = 4 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/i;
const ADVERTISEMENT_TYPE = "application/x-git-upload-pack-advertisement";

type RefFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function advertisedCommit(bytes: Buffer, ref: string): string {
  let offset = 0;
  function packet(): Buffer | null {
    if (offset + 4 > bytes.length) throw new Error("truncated packet");
    const header = bytes.subarray(offset, offset + 4).toString("latin1");
    if (!/^[a-f0-9]{4}$/i.test(header)) throw new Error("invalid packet length");
    const length = parseInt(header, 16);
    offset += 4;
    if (length === 0) return null;
    if (length < 4 || length > 65_520 || offset + length - 4 > bytes.length)
      throw new Error("invalid packet length");
    const payload = bytes.subarray(offset, offset + length - 4);
    offset += length - 4;
    return payload;
  }

  const refs = new Map<string, string>();
  try {
    if (packet()?.toString("utf8") !== "# service=git-upload-pack\n" || packet() !== null)
      throw new Error("invalid service header");
    for (;;) {
      const payload = packet();
      if (payload === null) break;
      const match = /^([a-f0-9]{40}) ([^\0\r\n ]+)(?:\0[^\0\r\n]*)?\n$/i.exec(
        payload.toString("utf8"),
      );
      if (!match || (refs.size > 0 && payload.includes(0)) || refs.has(match[2]))
        throw new Error("invalid ref record");
      refs.set(match[2], match[1].toLowerCase());
    }
    if (offset !== bytes.length) throw new Error("trailing packets");
  } catch {
    throw new PanelAppInstallError("GitHub source returned an invalid Git ref advertisement");
  }

  // Git gives branch names precedence over tags with the same short name.
  const candidates =
    ref === "HEAD" || ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const commit = refs.get(`${candidate}^{}`) ?? refs.get(candidate);
    if (commit && !/^0+$/.test(commit)) return commit;
  }
  throw new PanelAppInstallError("GitHub repository or ref was not found");
}

/** Resolve public Git refs without GitHub API rate limits or a local Git executable. */
export async function resolveGitHubPanelAppCommit(
  input: GitPanelAppSourceInput,
  options: { fetch?: RefFetch; timeoutMs?: number } = {},
): Promise<string> {
  const source = normalizeGitPanelAppSource(input);
  const ref = source.ref ?? "HEAD";
  if (SHA.test(ref)) return ref.toLowerCase();
  const url = new URL(`${source.url}/info/refs?service=git-upload-pack`);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("GitHub source ref lookup timed out")),
    options.timeoutMs ?? REF_TIMEOUT_MS,
  );
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await withPanelSourceAbort(
      (options.fetch ?? globalThis.fetch)(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        headers: {
          Accept: ADVERTISEMENT_TYPE,
          "Accept-Encoding": "identity",
          "User-Agent": "CodeShell-panel-app-ref-check/1",
        },
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (response.status === 404)
      throw new PanelAppInstallError("GitHub repository or ref was not found");
    if (!response.ok)
      throw new PanelAppInstallError(`GitHub source ref lookup returned HTTP ${response.status}`);
    if (response.headers.get("content-type")?.split(";")[0].trim() !== ADVERTISEMENT_TYPE)
      throw new PanelAppInstallError("GitHub source returned an invalid Git ref advertisement");
    const declaredText = response.headers.get("content-length");
    const declared = declaredText === null ? undefined : Number(declaredText);
    if (
      declaredText !== null &&
      (!/^[0-9]+$/.test(declaredText) ||
        !Number.isSafeInteger(declared) ||
        declared! > MAX_REF_BYTES)
    )
      throw new PanelAppInstallError(
        "GitHub source refs exceed the 4 MiB limit; use a full commit SHA",
      );
    if (!response.body)
      throw new PanelAppInstallError("GitHub source returned an empty Git ref advertisement");
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await withPanelSourceAbort(reader.read(), controller.signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REF_BYTES)
        throw new PanelAppInstallError(
          "GitHub source refs exceed the 4 MiB limit; use a full commit SHA",
        );
      chunks.push(Buffer.from(value));
    }
    if (declared !== undefined && total !== declared)
      throw new PanelAppInstallError("GitHub source ref length does not match Content-Length");
    return advertisedCommit(Buffer.concat(chunks, total), ref);
  } catch (error) {
    if (error instanceof PanelAppInstallError) throw error;
    throw new PanelAppInstallError(
      `GitHub source ref lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    // A peer that stops transmitting must not delay the deadline while being cancelled.
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined);
  }
}
