/** Local document extraction never evaluates embedded code or fetches links. */
export const DOCUMENT_PARSER_VERSION = "1";
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_DOCUMENT_CHUNKS = 512;
export const DOCUMENT_PARSE_TIMEOUT_MS = 15_000;

export interface DocumentPart {
  label: string;
  text: string;
}

export interface ParsedDocument {
  format: "text" | "docx" | "pptx" | "xlsx" | "pdf";
  parts: DocumentPart[];
  truncated: boolean;
}

export interface DocumentChunk {
  id: string;
  part: string;
  start: number;
  end: number;
  text: string;
}

export interface DocumentIndex {
  version: string;
  resourceId: string;
  sourceHash: string;
  inputBytes: number;
  format: ParsedDocument["format"];
  truncated: boolean;
  chunks: DocumentChunk[];
}
