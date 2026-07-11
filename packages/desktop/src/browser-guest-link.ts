export const BROWSER_GUEST_LINK_CHANNEL = "codeshell:browser-link";

export type GuestLinkDisposition = "internal-tab" | "external";

export interface GuestLinkRequest {
  url: string;
  disposition: GuestLinkDisposition;
}

interface LinkClickLike {
  isTrusted?: boolean;
  target?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  button?: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

function normalizeGuestLinkRequest(value: unknown): GuestLinkRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as { url?: unknown; disposition?: unknown };
  if (typeof request.url !== "string") return null;
  if (request.disposition !== "internal-tab" && request.disposition !== "external") return null;
  try {
    const url = new URL(request.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { url: url.href, disposition: request.disposition };
  } catch {
    return null;
  }
}

/** Classify a real guest click. Synthetic page events fail closed on isTrusted. */
export function guestLinkRequestFromClick(event: LinkClickLike): GuestLinkRequest | null {
  if (!event.isTrusted) return null;
  const target = event.target as
    | { closest?: (selector: string) => { href?: unknown; target?: unknown } | null }
    | null
    | undefined;
  const anchor = target?.closest?.("a[href]");
  if (!anchor || typeof anchor.href !== "string") return null;
  const disposition: GuestLinkDisposition | null =
    event.metaKey || event.ctrlKey
      ? "external"
      : (typeof anchor.target === "string" && anchor.target.toLowerCase() === "_blank") ||
          event.button === 1
        ? "internal-tab"
        : null;
  if (!disposition) return null;
  const request = normalizeGuestLinkRequest({ url: anchor.href, disposition });
  if (!request) return null;
  event.preventDefault?.();
  event.stopPropagation?.();
  return request;
}

/** Parse Electron's host-side `ipc-message` event; page-world console/DOM data is ignored. */
export function parseBrowserGuestLinkIpcMessage(event: {
  channel?: unknown;
  args?: unknown;
}): GuestLinkRequest | null {
  if (event.channel !== BROWSER_GUEST_LINK_CHANNEL || !Array.isArray(event.args)) return null;
  return normalizeGuestLinkRequest(event.args[0]);
}
