import { createRequire } from "node:module";
import { extname } from "node:path";
import { SaxesParser } from "saxes";
import type { Entry, ZipFile } from "yauzl";
import { truncateUtf8Text } from "../truncate-utf8.js";
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  type DocumentPart,
  type ParsedDocument,
} from "./types.js";

const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_XML_ELEMENTS = 200_000;
const MAX_PARTS = 500;
const require = createRequire(import.meta.url);

class TextBudget {
  bytes = 0;
  truncated = false;
  parts: DocumentPart[] = [];

  add(label: string, text: string): void {
    if (!text.trim()) return;
    if (this.parts.length >= MAX_PARTS) {
      this.truncated = true;
      return;
    }
    const remaining = Math.max(0, MAX_DOCUMENT_TEXT_BYTES - this.bytes);
    const value = truncateUtf8Text(text, remaining);
    this.truncated ||= value.truncated;
    if (!value.text) return;
    this.bytes += Buffer.byteLength(value.text, "utf8");
    this.parts.push({ label, text: value.text });
  }
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw new Error("Uploaded file is not supported UTF-8 text");
  return text;
}

/** SAX accepts only XML's predefined/numeric entities; no DTD resolver exists. */
function parseXml(
  xml: string,
  handlers: {
    open?: (name: string, attrs: Record<string, string>) => void;
    close?: (name: string) => void;
    text?: (text: string) => void;
  },
): void {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let elements = 0;
  parser.on("doctype", () => {
    throw new Error("Document XML must not contain a DOCTYPE");
  });
  parser.on("opentag", (tag) => {
    if (++depth > 128 || ++elements > MAX_XML_ELEMENTS)
      throw new Error("Document XML exceeds structural limits");
    const attrs: Record<string, string> = {};
    for (const attr of Object.values(tag.attributes)) attrs[attr.name] = attr.value;
    handlers.open?.(tag.local, attrs);
  });
  parser.on("closetag", (tag) => {
    handlers.close?.(tag.local);
    depth--;
  });
  parser.on("text", (text) => handlers.text?.(text));
  parser.on("cdata", (text) => handlers.text?.(text));
  parser.write(xml).close();
}

function officeText(xml: string): string {
  const pieces: string[] = [];
  let inText = 0;
  let bytes = 0;
  const add = (text: string) => {
    const bounded = truncateUtf8Text(text, Math.max(0, MAX_XML_BYTES - bytes));
    pieces.push(bounded.text);
    bytes += Buffer.byteLength(bounded.text, "utf8");
  };
  parseXml(xml, {
    open: (name) => {
      if (name === "t") inText++;
      if (name === "tab") add("\t");
      if (name === "br") add("\n");
    },
    close: (name) => {
      if (name === "t") inText--;
      if (name === "p" || name === "tr") add("\n");
      if (name === "tc") add("\t");
    },
    text: (text) => {
      if (inText) add(text);
    },
  });
  return pieces.join("");
}

function wantedXml(name: string, format: string): boolean {
  if (format === "docx")
    return /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name);
  if (format === "pptx")
    return (
      /^ppt\/(?:slides\/slide\d+|presentation|_rels\/presentation\.xml\.rels)\.xml$/.test(name) ||
      name === "ppt/_rels/presentation.xml.rels"
    );
  return (
    name === "xl/sharedStrings.xml" ||
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );
}

/** Read selected XML only, without extracting archive paths or following relationships. */
async function officeEntries(bytes: Uint8Array, format: string): Promise<Map<string, string>> {
  const yauzl = require("yauzl") as typeof import("yauzl");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true },
      (err, value) => {
        if (err || !value) reject(err ?? new Error("Invalid Office document"));
        else resolve(value);
      },
    );
  });
  return new Promise((resolve, reject) => {
    const entries = new Map<string, string>();
    let count = 0;
    let declaredBytes = 0;
    let selectedBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve(entries);
    });
    zip.on("entry", (entry: Entry) => {
      if (settled) return;
      declaredBytes += entry.uncompressedSize;
      if (++count > MAX_ZIP_ENTRIES || declaredBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
        fail(new Error("Office archive exceeds entry or decompression limits"));
        return;
      }
      if (!wantedXml(entry.fileName, format)) {
        zip.readEntry();
        return;
      }
      if (
        entries.has(entry.fileName) ||
        entry.uncompressedSize > MAX_XML_BYTES ||
        entries.size >= MAX_PARTS
      ) {
        fail(new Error("Office document has duplicate or oversized XML parts"));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error("Cannot read Office XML"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("error", fail);
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          selectedBytes += chunk.length;
          if (size > MAX_XML_BYTES || selectedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
            stream.destroy(new Error("Office XML exceeds decompression limits"));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          if (settled) return;
          try {
            entries.set(entry.fileName, decodeText(Buffer.concat(chunks)));
            zip.readEntry();
          } catch (error) {
            fail(error);
          }
        });
      });
    });
    zip.readEntry();
  });
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  let text = "";
  let inText = false;
  parseXml(xml, {
    open: (name) => {
      if (name === "si") text = "";
      if (name === "t") inText = true;
    },
    close: (name) => {
      if (name === "t") inText = false;
      if (name === "si") {
        if (strings.length >= 100_000) throw new Error("Too many shared spreadsheet strings");
        strings.push(text);
      }
    },
    text: (value) => {
      if (inText) text += value;
    },
  });
  return strings;
}

function sheetText(xml: string, strings: string[]): string {
  const cells: string[] = [];
  let cell: { ref: string; type: string; text: string } | undefined;
  let inValue = false;
  parseXml(xml, {
    open: (name, attrs) => {
      if (name === "c") cell = { ref: attrs.r ?? "cell", type: attrs.t ?? "n", text: "" };
      if (name === "v" || name === "t") inValue = true;
    },
    close: (name) => {
      if (name === "v" || name === "t") inValue = false;
      if (name === "c" && cell) {
        if (cells.length >= 100_000) throw new Error("Spreadsheet exceeds cell limits");
        let text = cell.text;
        if (cell.type === "s") {
          if (
            !/^\d+$/.test(text) ||
            !Number.isSafeInteger(Number(text)) ||
            strings[Number(text)] === undefined
          )
            throw new Error("Spreadsheet shared string reference is invalid");
          text = strings[Number(text)];
        } else if (cell.type === "b") text = text === "1" ? "true" : "false";
        if (text) cells.push(`[${cell.ref}] ${text}`);
        cell = undefined;
      }
    },
    text: (value) => {
      if (cell && inValue) cell.text += value;
    },
  });
  return cells.join("\n");
}

function orderedParts(entries: Map<string, string>, format: "xlsx" | "pptx") {
  const root = format === "xlsx" ? "xl" : "ppt";
  const name = format === "xlsx" ? "workbook" : "presentation";
  const relationships = new Map<string, string>();
  const relXml = entries.get(`${root}/_rels/${name}.xml.rels`);
  if (relXml)
    parseXml(relXml, {
      open: (tag, attrs) => {
        if (tag !== "Relationship" || attrs.TargetMode === "External") return;
        const target = `${root}/${attrs.Target ?? ""}`;
        if (wantedXml(target, format) && entries.has(target)) relationships.set(attrs.Id, target);
      },
    });
  const result: { path: string; label: string }[] = [];
  const mainXml = entries.get(`${root}/${name}.xml`);
  if (mainXml)
    parseXml(mainXml, {
      open: (tag, attrs) => {
        if (tag !== (format === "xlsx" ? "sheet" : "sldId")) return;
        const path = relationships.get(attrs["r:id"]);
        if (path) result.push({ path, label: attrs.name ?? `slide ${result.length + 1}` });
      },
    });
  if (result.length) return result;
  const pattern =
    format === "xlsx" ? /^xl\/worksheets\/sheet\d+\.xml$/ : /^ppt\/slides\/slide\d+\.xml$/;
  return [...entries.keys()]
    .filter((path) => pattern.test(path))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((path) => ({ path, label: path }));
}

export async function parseDocument(bytes: Uint8Array, filename: string): Promise<ParsedDocument> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Uploaded document exceeds the 20 MiB parsing limit");
  const extension = extname(filename).toLowerCase().slice(1);
  const budget = new TextBudget();
  if (extension === "docx" || extension === "pptx" || extension === "xlsx") {
    const entries = await officeEntries(bytes, extension);
    if (extension === "docx") {
      const main = entries.get("word/document.xml");
      if (!main) throw new Error("DOCX is missing its document XML");
      budget.add("document", officeText(main));
      for (const [name, xml] of entries)
        if (name !== "word/document.xml") budget.add(name, officeText(xml));
    } else {
      const parts = orderedParts(entries, extension);
      if (!parts.length) throw new Error("Office document contains no readable slide or worksheet");
      const strings =
        extension === "xlsx" ? sharedStrings(entries.get("xl/sharedStrings.xml")) : [];
      for (const part of parts)
        budget.add(
          part.label,
          extension === "xlsx"
            ? sheetText(entries.get(part.path)!, strings)
            : officeText(entries.get(part.path)!),
        );
    }
    return { format: extension, parts: budget.parts, truncated: budget.truncated };
  }
  if (extension === "pdf") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13))
      throw new Error(
        "PDF text extraction requires Node.js 22.13 or newer; upgrade this Host or export the document as UTF-8 text. Other uploaded text and Office formats remain available.",
      );
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      const pages = Math.min(document.numPages, 200);
      budget.truncated ||= pages < document.numPages;
      for (let number = 1; number <= pages; number++) {
        const page = await document.getPage(number);
        try {
          const content = await page.getTextContent();
          const pieces: string[] = [];
          for (const item of content.items) {
            if ("str" in item) pieces.push(item.str + (item.hasEOL ? "\n" : " "));
          }
          budget.add(`page ${number}`, pieces.join(""));
          if (budget.bytes >= MAX_DOCUMENT_TEXT_BYTES) {
            budget.truncated ||= number < document.numPages;
            break;
          }
        } finally {
          page.cleanup();
        }
      }
    } finally {
      await task.destroy();
    }
    return { format: "pdf", parts: budget.parts, truncated: budget.truncated };
  }
  if (
    (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
    (bytes[0] === 0x25 && bytes[1] === 0x50) ||
    ["doc", "xls", "ppt", "png", "jpg", "jpeg", "gif", "webp", "mp3", "mp4", "zip"].includes(
      extension,
    )
  )
    throw new Error(`Unsupported uploaded document format: ${extension || "binary"}`);
  budget.add("text", decodeText(bytes));
  return { format: "text", parts: budget.parts, truncated: budget.truncated };
}
