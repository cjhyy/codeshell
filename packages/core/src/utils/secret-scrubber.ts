const SECRET_KEY_SOURCE =
  "(?:(?:access|refresh|auth|id|bearer|session)[_-]?token|token|api[_-]?key|password|passwd|client[_-]?secret|secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|authorization|bearer)";
const STRUCTURED_SECRET_RE = new RegExp(
  `(^|[{,\\[])([ \\t]*(?:-[ \\t]+)?)(["']?)(${SECRET_KEY_SOURCE})\\3([ \\t]*:[ \\t]*)`,
  "gimu",
);
const ARGV_SECRET_RE = new RegExp(
  `((?:"--${SECRET_KEY_SOURCE}"|'--${SECRET_KEY_SOURCE}')[ \\t\\r\\n]*,[ \\t\\r\\n]*)("(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*')`,
  "giu",
);
const CLI_SECRET_RE = new RegExp(
  `((?:^|[\\s"'\`])--${SECRET_KEY_SOURCE}(?:[ \\t]*=[ \\t]*|(?:[ \\t]+|\\\\\\r?\\n|\\r?\\n)+))` +
    `("(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*'|(?:\\\\[^\\r\\n]|[^\\s"'\`;|&])+)`,
  "gimu",
);

function lineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  if (newline < 0) return text.length;
  return newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
}

function quotedValueEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === quote) {
      return index + 1;
    }
  }
  return text.length;
}

function balancedValueEnd(text: string, start: number): number {
  const stack: string[] = [];
  let quote = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      stack.push(char === "[" ? "]" : "}");
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return text.length;
}

function blockScalarEnd(
  text: string,
  valueStart: number,
  keyLineStart: number,
): { end: number; replacement: string } | undefined {
  const keyLineEnd = lineEnd(text, valueStart);
  const indicator = text.slice(valueStart, keyLineEnd).trim();
  if (!/^[>|](?:[+-]?[1-9]?|[1-9]?[+-]?)[ \t]*(?:#.*)?$/u.test(indicator)) {
    return undefined;
  }

  const keyIndent = text.slice(keyLineStart).match(/^[ \t]*/u)?.[0].length ?? 0;
  const newlineStart =
    keyLineEnd < text.length && text[keyLineEnd] === "\r" ? keyLineEnd : keyLineEnd;
  const newlineEnd = text.indexOf("\n", newlineStart);
  if (newlineEnd < 0) return { end: text.length, replacement: "[REDACTED]" };

  let blockEnd = newlineEnd + 1;
  while (blockEnd < text.length) {
    const nextEnd = lineEnd(text, blockEnd);
    const line = text.slice(blockEnd, nextEnd);
    const indent = line.match(/^[ \t]*/u)?.[0].length ?? 0;
    if (line.trim() !== "" && indent <= keyIndent) break;
    const nextNewline = text.indexOf("\n", nextEnd);
    if (nextNewline < 0) return { end: text.length, replacement: "[REDACTED]" };
    blockEnd = nextNewline + 1;
  }
  return {
    end: blockEnd,
    replacement: blockEnd < text.length ? "[REDACTED]\n" : "[REDACTED]",
  };
}

function indentedContinuationEnd(
  text: string,
  currentLineEnd: number,
  keyIndent: number,
  allowSequenceItems: boolean,
): { end: number; replacement: string } | undefined {
  const newline = text.indexOf("\n", currentLineEnd);
  if (newline < 0) return undefined;

  let nextLineStart = newline + 1;
  let sawIndentedContent = false;
  while (nextLineStart < text.length) {
    const nextEnd = lineEnd(text, nextLineStart);
    const line = text.slice(nextLineStart, nextEnd);
    const indent = line.match(/^[ \t]*/u)?.[0].length ?? 0;
    if (line.trim() !== "") {
      if (/^[ \t]*[\w.-]+[ \t]*:(?:\s|$)/u.test(line)) break;
      if (!allowSequenceItems && /^[ \t]*-[ \t]+/u.test(line)) break;
      if (indent <= keyIndent) break;
      sawIndentedContent = true;
    }
    const nextNewline = text.indexOf("\n", nextEnd);
    if (nextNewline < 0) {
      nextLineStart = text.length;
      break;
    }
    nextLineStart = nextNewline + 1;
  }

  if (!sawIndentedContent) return undefined;
  return {
    end: nextLineStart,
    replacement: nextLineStart < text.length ? "[REDACTED]\n" : "[REDACTED]",
  };
}

function redactStructuredSecrets(text: string): string {
  STRUCTURED_SECRET_RE.lastIndex = 0;
  let output = "";
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  while ((match = STRUCTURED_SECRET_RE.exec(text)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart >= text.length) continue;

    const keyLineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const block = blockScalarEnd(text, valueStart, keyLineStart);
    let valueEnd: number;
    let replacement = "[REDACTED]";
    if (block) {
      valueEnd = block.end;
      replacement = block.replacement;
    } else if (text[valueStart] === '"' || text[valueStart] === "'") {
      valueEnd = quotedValueEnd(text, valueStart);
    } else if (text[valueStart] === "[" || text[valueStart] === "{") {
      valueEnd = balancedValueEnd(text, valueStart);
    } else {
      const endOfLine = lineEnd(text, valueStart);
      const isFlowValue = match[1] !== "";
      const flowBoundary = isFlowValue ? text.slice(valueStart, endOfLine).search(/[,}\]]/u) : -1;
      const comment = text.slice(valueStart, endOfLine).search(/[ \t]#/u);
      valueEnd = endOfLine;
      if (flowBoundary >= 0) valueEnd = valueStart + flowBoundary;
      if (comment >= 0) valueEnd = Math.min(valueEnd, valueStart + comment);
      while (valueEnd > valueStart && /[ \t]/u.test(text[valueEnd - 1]!)) valueEnd -= 1;

      const continuation = isFlowValue
        ? undefined
        : indentedContinuationEnd(
            text,
            endOfLine,
            match.index + match[1]!.length + match[2]!.length - keyLineStart,
            valueStart === endOfLine,
          );
      if (continuation) {
        valueEnd = continuation.end;
        replacement = continuation.replacement;
        if (valueStart === endOfLine && !/[ \t]$/u.test(match[0])) {
          replacement = ` ${replacement}`;
        }
      }
    }

    output += text.slice(copiedThrough, valueStart) + replacement;
    copiedThrough = valueEnd;
    STRUCTURED_SECRET_RE.lastIndex = valueEnd;
  }
  return copiedThrough === 0 ? text : output + text.slice(copiedThrough);
}

function redactCliSecrets(text: string): string {
  const argvRedacted = text.replace(ARGV_SECRET_RE, (_whole, prefix: string, value: string) => {
    const quote = value[0] ?? '"';
    return `${prefix}${quote}[REDACTED]${quote}`;
  });
  return argvRedacted.replace(CLI_SECRET_RE, "$1[REDACTED]");
}

/** Content-level defense in depth for producers that forgot sensitive metadata. */
export function scrubSecrets(text: string): string {
  const basicRedacted = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(
      /([?&](?:(?:access|refresh|auth|id)[_-]?token|token|api[_-]?key|password|passwd|client[_-]?secret|secret)=)[^&#\s]*/giu,
      "$1[REDACTED]",
    )
    .replace(/(\bAuthorization\s*:\s*)(?:Bearer|Basic|Token)\s+[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(\b(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(
      /((?:^|[\s"'`;,])(?=[A-Za-z_][A-Za-z0-9_]*\s*=)(?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;]+)/gimu,
      "$1[REDACTED]",
    );
  return redactCliSecrets(redactStructuredSecrets(basicRedacted)).replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu,
    "[REDACTED]",
  );
}
