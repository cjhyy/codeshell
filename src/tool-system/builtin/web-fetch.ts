/**
 * Built-in WebFetch tool — fetch a URL and extract readable text content.
 */

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
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

export async function webFetchTool(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string;
  if (!url) return "Error: url is required";

  // Validate URL and protocol
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: invalid URL "${url}"`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Error: only http(s) URLs are allowed, got "${parsed.protocol}"`;
  }
  if (isBlockedHost(parsed.hostname)) {
    return `Error: refusing to fetch internal/loopback host "${parsed.hostname}"`;
  }

  const maxLength = Math.min((args.max_length as number) || DEFAULT_MAX, MAX_OUTPUT);
  const rawHeaders = (args.headers as Record<string, string>) ?? {};
  const customHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (!BLOCKED_REQUEST_HEADERS.has(k.toLowerCase())) {
      customHeaders[k] = v;
    }
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; code-shell/0.1; +https://github.com/nicepkg/code-shell)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        ...customHeaders,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText}`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const body = await res.text();

    let text: string;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      text = extractTextFromHTML(body);
    } else {
      // Plain text, JSON, XML, etc. — return as-is
      text = body;
    }

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + `\n\n... content truncated (${text.length} chars total)`;
    }

    return text || "(page returned empty content)";
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("abort") || msg.includes("timeout")) {
      return "Error: request timed out after 30s";
    }
    return `Fetch error: ${msg}`;
  }
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
