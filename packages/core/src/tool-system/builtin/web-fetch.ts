/**
 * Built-in WebFetch tool — fetch a URL and extract readable text content.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";
import type { ToolDefinition } from "../../types.js";

export const webFetchToolDef: ToolDefinition = {
  name: "WebFetch",
  description:
    "Fetch a web page and return its text content. Strips HTML tags to return readable text. " +
    "Use this to read articles, documentation, or any web page.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      max_length: {
        type: "number",
        description: "Maximum characters to return (default: 50000)",
      },
      headers: {
        type: "object",
        description: "Optional HTTP headers to send",
      },
    },
    required: ["url"],
  },
};

const MAX_OUTPUT = 100_000;
const DEFAULT_MAX = 50_000;

// Header names that must not be overridable via args.headers (SSRF / auth injection)
const BLOCKED_REQUEST_HEADERS = new Set([
  "host", "authorization", "cookie", "proxy-authorization",
  "x-forwarded-for", "x-real-ip", "x-forwarded-host",
]);

// Hostname patterns that block SSRF to internal/metadata services
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^169\.254\./,         // link-local + AWS/GCP metadata (169.254.169.254)
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
  /^::1$/,
  /^fc00:/i, /^fd00:/i,  // IPv6 ULA
  /^fe80:/i,             // IPv6 link-local
];

function isBlockedHost(hostname: string): boolean {
  // `new URL("http://[::1]/").hostname` returns "[::1]" (with brackets);
  // strip them so IPv6 patterns match.
  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(stripped));
}

// A3 hardening: per-IP block list. Used after DNS resolution to catch
// public-looking hostnames that resolve to private/loopback addresses
// (DNS rebinding, AWS metadata via DNS, etc.). See spec
// docs/superpowers/specs/2026-05-26-a3-webfetch-ssrf-design.md.
function isBlockedIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) so the IPv4
  // checks below catch it.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isBlockedIpv4(mapped[1]);

  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  // Unknown format — refuse rather than allow.
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 (current network), 10.0.0.0/8, 127.0.0.0/8
  if (a === 0 || a === 10 || a === 127) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 169.254.0.0/16 — link-local + cloud metadata
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved/broadcast
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback ::1
  if (lower === "::1") return true;
  // Unique-local fc00::/7 (covers fc00: and fd00:)
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  // Documentation 2001:db8::/32
  if (/^2001:0?db8:/.test(lower)) return true;
  // Discard prefix 100::/64
  if (/^100:0{0,4}(:|$)/.test(lower)) return true;
  return false;
}

// Hop limit for redirect chains.
const MAX_REDIRECTS = 5;

// Headers that must be stripped when a redirect crosses origins.
// Same policy fetch(... redirect: "follow") applies internally; we
// re-implement it here because we drive redirects manually.
const CROSS_ORIGIN_STRIP_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

interface HopCheckResult {
  ok: true;
  ips: string[];
}
interface HopCheckRefused {
  ok: false;
  reason: string;
}

// Allow tests to inject a fake resolver. Production uses node:dns.
type DnsLookup = (hostname: string) => Promise<string[]>;

async function defaultDnsLookup(hostname: string): Promise<string[]> {
  // For literal IPs, lookup returns the IP itself (Node behavior),
  // which still flows through the block-list check above.
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

let dnsLookupImpl: DnsLookup = defaultDnsLookup;

/** Test hook: replace the DNS resolver. Pass `null` to restore default. */
export function __setDnsLookupForTests(impl: DnsLookup | null): void {
  dnsLookupImpl = impl ?? defaultDnsLookup;
}

async function validateHopHost(u: URL): Promise<HopCheckResult | HopCheckRefused> {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `protocol "${u.protocol}" is not allowed` };
  }
  if (isBlockedHost(u.hostname)) {
    return { ok: false, reason: `host "${u.hostname}" is on the block list` };
  }
  let ips: string[];
  try {
    ips = await dnsLookupImpl(u.hostname);
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed for "${u.hostname}": ${(err as Error).message}` };
  }
  if (ips.length === 0) {
    return { ok: false, reason: `DNS returned no addresses for "${u.hostname}"` };
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return {
        ok: false,
        reason: `"${u.hostname}" resolves to blocked IP ${ip}`,
      };
    }
  }
  return { ok: true, ips };
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

export async function webFetchTool(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url) return "Error: url is required";

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: invalid URL "${url}"`;
  }

  const maxLength = Math.min((args.max_length as number) || DEFAULT_MAX, MAX_OUTPUT);
  const rawHeaders = (args.headers as Record<string, string>) ?? {};
  const baseHeaders: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; code-shell/0.1; +https://github.com/nicepkg/code-shell)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  };
  // Strip dangerous user-supplied headers up-front.
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (!BLOCKED_REQUEST_HEADERS.has(k.toLowerCase())) {
      baseHeaders[k] = v;
    }
  }

  // A3 hardening: manual redirect loop. Each hop revalidates the URL,
  // host, and DNS-resolved IPs against the block lists. fetch() runs
  // with redirect: "manual" so the runtime cannot silently follow a
  // redirect into private/loopback/metadata space.
  const timeoutSignal = AbortSignal.timeout(30_000);
  let currentUrl = parsed;
  let currentHeaders = { ...baseHeaders };
  const originalOrigin = parsed;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = await validateHopHost(currentUrl);
      if (!check.ok) {
        const verb = hop === 0 ? "fetch" : `follow redirect to`;
        return `Error: refusing to ${verb} ${currentUrl.href} — ${check.reason}`;
      }

      const res = await fetch(currentUrl, {
        headers: currentHeaders,
        redirect: "manual",
        signal: timeoutSignal,
      });

      // Not a redirect: return body (or HTTP error).
      if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) {
        if (!res.ok) {
          return `Error: HTTP ${res.status} ${res.statusText}`;
        }
        return await readAndTruncateBody(res, maxLength);
      }

      // Redirect: resolve target, drop credentials on cross-origin,
      // and loop.
      const location = res.headers.get("location")!;
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return `Error: redirect target "${location}" is not a valid URL`;
      }
      if (!sameOrigin(nextUrl, originalOrigin)) {
        currentHeaders = stripCrossOriginHeaders(currentHeaders);
      }
      currentUrl = nextUrl;
    }
    return `Error: too many redirects (max ${MAX_REDIRECTS})`;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("abort") || msg.includes("timeout")) {
      return "Error: request timed out after 30s";
    }
    return `Fetch error: ${msg}`;
  }
}

async function readAndTruncateBody(res: Response, maxLength: number): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();

  let text: string;
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    text = extractTextFromHTML(body);
  } else {
    text = body;
  }

  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + `\n\n... content truncated (${text.length} chars total)`;
  }
  return text || "(page returned empty content)";
}

function stripCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_STRIP_HEADERS.has(k.toLowerCase())) {
      stripped[k] = v;
    }
  }
  return stripped;
}

/**
 * Simple HTML → text extraction.
 * Strips tags, decodes common entities, collapses whitespace.
 * Not perfect, but good enough for most web pages.
 */
function extractTextFromHTML(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Extract title
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";

  // Try to extract main content area
  const mainMatch =
    text.match(/<main[\s\S]*?<\/main>/i) ??
    text.match(/<article[\s\S]*?<\/article>/i) ??
    text.match(/<div[^>]*(?:role="main"|id="content"|class="[^"]*content[^"]*")[^>]*>[\s\S]*?<\/div>/i);

  if (mainMatch) {
    text = mainMatch[0];
  } else {
    // Fall back to body
    const bodyMatch = text.match(/<body[\s\S]*?<\/body>/i);
    if (bodyMatch) text = bodyMatch[0];
  }

  // Remove nav, header, footer, aside
  text = text.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, "");

  // Convert block elements to newlines
  text = text.replace(/<(p|div|h[1-6]|li|br|tr|blockquote)[^>]*>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = decodeEntities(text);

  // Collapse whitespace
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Remove excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  if (title) {
    text = `# ${title}\n\n${text}`;
  }

  return text.trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
