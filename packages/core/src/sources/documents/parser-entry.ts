import { parseDocument } from "./parse.js";
import { MAX_DOCUMENT_BYTES } from "./types.js";

// Only byte input crosses the process boundary. No source paths or inherited
// credentials are needed. Parsers never resolve external document links.
globalThis.fetch = (() => {
  throw new Error("Document parsers cannot access the network");
}) as typeof fetch;
for (const method of ["log", "warn", "info", "error"] as const) console[method] = () => undefined;

try {
  const input: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_DOCUMENT_BYTES * 1.5 + 4096)
      throw new Error("Document input exceeds its size limit");
    input.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(input).toString("utf8"));
  const result = await parseDocument(Buffer.from(request.bytes, "base64"), request.filename);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ error: error instanceof Error ? error.message : "Document parsing failed" }),
  );
}
