/**
 * Memory system — persistent cross-session memory.
 *
 * Stores structured memory entries in ~/.code-shell/memory/ as individual markdown files.
 * MEMORY.md is the index file.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  fileName: string;
}

export class MemoryManager {
  private readonly memoryDir: string;
  private readonly indexPath: string;

  constructor(projectDir?: string) {
    // Project-scoped memory: ~/.code-shell/projects/<hash>/memory/
    const baseDir = join(homedir(), ".code-shell");
    if (projectDir) {
      const projectHash = projectDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      this.memoryDir = join(baseDir, "projects", projectHash, "memory");
    } else {
      this.memoryDir = join(baseDir, "memory");
    }
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });
  }

  getMemoryDir(): string { return this.memoryDir; }

  /**
   * Save a memory entry. Creates the file and updates the index.
   */
  save(entry: Omit<MemoryEntry, "fileName">): string {
    const fileName = this.slugify(entry.name) + ".md";
    const filePath = join(this.memoryDir, fileName);

    const content =
      `---\n` +
      `name: ${entry.name}\n` +
      `description: ${entry.description}\n` +
      `type: ${entry.type}\n` +
      `---\n\n` +
      `${entry.content}\n`;

    writeFileSync(filePath, content, "utf-8");
    this.updateIndex();
    return fileName;
  }

  /**
   * Load all memory entries.
   */
  loadAll(): MemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];

    const files = readdirSync(this.memoryDir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const entry = this.loadFile(file);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Load a single memory file.
   */
  private loadFile(fileName: string): MemoryEntry | null {
    const filePath = join(this.memoryDir, fileName);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
      if (!frontmatterMatch) return null;

      const frontmatter = frontmatterMatch[1];
      const content = frontmatterMatch[2].trim();

      const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim() ?? fileName;
      const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
      const type = (frontmatter.match(/type:\s*(.+)/)?.[1]?.trim() ?? "project") as MemoryEntry["type"];

      return { name, description, type, content, fileName };
    } catch {
      return null;
    }
  }

  /**
   * Delete a memory by name or filename.
   */
  delete(nameOrFile: string): boolean {
    const entries = this.loadAll();
    const entry = entries.find(
      (e) => e.name === nameOrFile || e.fileName === nameOrFile,
    );
    if (!entry) return false;

    try {
      unlinkSync(join(this.memoryDir, entry.fileName));
      this.updateIndex();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the MEMORY.md index content for injection into prompts.
   */
  getIndex(): string {
    if (!existsSync(this.indexPath)) return "";
    return readFileSync(this.indexPath, "utf-8");
  }

  /**
   * Build a prompt-friendly summary of all memories.
   */
  buildMemoryContext(): string {
    const entries = this.loadAll();
    if (entries.length === 0) return "";

    const lines = entries.map(
      (e) => `- [${e.type}] ${e.name}: ${e.description}`,
    );

    return (
      `# Persistent Memory\n\n` +
      `The following memories from previous sessions may be relevant:\n\n` +
      lines.join("\n") +
      `\n\nTo read a specific memory, check ~/.code-shell/memory/`
    );
  }

  private updateIndex(): void {
    const entries = this.loadAll();
    const lines = entries.map(
      (e) => `- [${e.name}](${e.fileName}) — ${e.description}`,
    );

    const content = lines.length > 0
      ? lines.join("\n") + "\n"
      : "(no memories stored)\n";

    writeFileSync(this.indexPath, content, "utf-8");
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }
}
