export type Eol = "\r\n" | "\n";

export function detectEol(content: string): Eol {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function toLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function applyEol(content: string, eol: Eol): string {
  return eol === "\n" ? content : content.replace(/\n/g, "\r\n");
}
