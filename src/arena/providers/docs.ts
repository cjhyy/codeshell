/**
 * DocsProvider — collects evidence from documentation files:
 * markdown, text, PRDs, design docs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ArenaPlan, ArenaArtifact, ArenaContextProvider } from "../types.js";
import { logger } from "../../logging/logger.js";

const MAX_DOC_CHARS = 10_000;
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc", ".org"]);

export const docsProvider: ArenaContextProvider = {
  kind: "docs",

  collect(plan: ArenaPlan, topic: string): ArenaArtifact[] {
    const artifacts: ArenaArtifact[] = [];
    const sourceSpec = plan.sources.find((s) => s.kind === "docs");
    const targets = sourceSpec?.targets ?? [];

    // Read explicit target documents
    for (const target of targets) {
      const content = safeReadDoc(target);
      if (content) {
        artifacts.push({
          id: `doc-${target}`,
          kind: "doc",
          source: "docs",
          title: target,
          ref: target,
          preview: truncate(content),
        });
      }
    }

    // If no explicit targets, scan common doc locations
    if (targets.length === 0) {
      const docDirs = ["docs", "doc", "design", "specs", "proposals", "."];
      const found = new Set<string>();

      for (const dir of docDirs) {
        if (!existsSync(dir)) continue;
        const docs = findDocFiles(dir, 2);
        for (const docPath of docs) {
          if (found.has(docPath)) continue;
          found.add(docPath);

          // Score relevance by checking if doc content/name relates to topic
          const name = docPath.toLowerCase();
          const topicLower = topic.toLowerCase();
          const keywords = topicLower.split(/\s+/).filter((w) => w.length > 2);
          const isRelevant = keywords.some((kw) => name.includes(kw));

          if (isRelevant || found.size <= 5) {
            const content = safeReadDoc(docPath);
            if (content) {
              artifacts.push({
                id: `doc-${docPath}`,
                kind: "doc",
                source: "docs",
                title: docPath,
                ref: docPath,
                preview: truncate(content),
              });
            }
          }
        }
      }
    }

    logger.info("arena.provider.docs", { artifactCount: artifacts.length });
    return artifacts;
  },
};

function findDocFiles(dir: string, maxDepth: number, depth = 0): string[] {
  if (depth >= maxDepth) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isFile() && DOC_EXTENSIONS.has(extname(entry).toLowerCase())) {
        files.push(full);
      } else if (st.isDirectory() && depth < maxDepth - 1) {
        files.push(...findDocFiles(full, maxDepth, depth + 1));
      }
    }
  } catch { /* ignore */ }
  return files;
}

function safeReadDoc(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (st.size > 500_000) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function truncate(content: string): string {
  if (content.length <= MAX_DOC_CHARS) return content;
  const t = content.slice(0, MAX_DOC_CHARS);
  const lastNl = t.lastIndexOf("\n");
  return t.slice(0, lastNl) + `\n... (truncated, ${content.length} chars total)`;
}
