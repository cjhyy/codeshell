/**
 * Package-owned result types. Deliberately NOT imported from core — this package
 * stays zero-dependency so any runtime can use it. The shapes mirror core's
 * Browser* types by structure; the desktop glue layer maps between them (they
 * are structurally compatible, so the mapping is usually identity).
 */

/** Outcome of an action (click/type/navigate/…). */
export interface CdpActionResult {
  ok: boolean;
  /** Human-readable detail (error reason, or short success note). */
  detail?: string;
  /** True when a ref no longer resolves (DOM changed) → caller should re-snapshot. */
  staleRef?: boolean;
}

/**
 * Minimal shape of a CDP Accessibility.getFullAXTree node. The package returns
 * the RAW nodes from snapshot(); semantic flattening (which roles are
 * interactive, ref assignment, sensitive-field masking) is the host's job — it
 * carries product/security policy that does not belong in a transport package.
 */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** Raw observation: the page's URL/title + the raw AX node list. The host
 *  flattens `nodes` into its own ref-tagged element list. */
export interface RawSnapshot {
  url: string;
  title?: string;
  nodes: AXNode[];
}

/** Result of reading the page's main textual content. */
export interface CdpContentResult {
  ok: boolean;
  url: string;
  title?: string;
  text: string;
  truncated?: boolean;
  detail?: string;
}

export interface CdpLink {
  text: string;
  url: string;
}

export interface CdpImage {
  url: string;
  alt?: string;
  /** Per-snapshot ref (img1, img2, …) so the agent can point at one to fetch. */
  ref?: string;
}

export interface CdpVideo {
  /** Absolute video/source URL (src resolved against the page). */
  url: string;
}

export interface CdpExtractResult {
  ok: boolean;
  url: string;
  title?: string;
  links: CdpLink[];
  images: CdpImage[];
  videos: CdpVideo[];
  truncated?: boolean;
  detail?: string;
}
