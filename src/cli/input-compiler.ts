/**
 * Input compiler — transforms raw user input into structured messages.
 */

import { readFileSync, existsSync } from "node:fs";
import type { CompiledInput, Message } from "../types.js";

const SLASH_COMMANDS = new Set(["/help", "/compact", "/clear", "/plan", "/exit", "/quit"]);

export function compileInput(rawText: string): CompiledInput {
  const trimmed = rawText.trim();

  // Check for slash commands
  if (trimmed.startsWith("/")) {
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (SLASH_COMMANDS.has(cmd)) {
      return {
        messages: [],
        rawText: trimmed,
        options: { slashCommand: cmd },
      };
    }
  }

  // Process @file references
  let processedText = trimmed;
  const mentionedFiles: string[] = [];

  const filePattern = /@([\w./\-]+(?:\.\w+)?)/g;
  let match;
  while ((match = filePattern.exec(trimmed)) !== null) {
    const filePath = match[1];
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        processedText += `\n\n<file path="${filePath}">\n${content}\n</file>`;
        mentionedFiles.push(filePath);
      } catch {
        // Skip unreadable files
      }
    }
  }

  const messages: Message[] = [{ role: "user", content: processedText }];

  return {
    messages,
    rawText: trimmed,
    options: {
      mentionedFiles: mentionedFiles.length > 0 ? mentionedFiles : undefined,
    },
  };
}
