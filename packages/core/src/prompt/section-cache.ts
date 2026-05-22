/**
 * Per-section prompt caching.
 * Mirrors Claude Code's systemPromptSectionCache — each section cached independently.
 */

export interface PromptSection {
  name: string;
  compute: () => string | Promise<string>;
  cacheBreak?: boolean;
}

export class SectionCache {
  private cache = new Map<string, string>();

  async resolve(sections: PromptSection[]): Promise<string[]> {
    const results: string[] = [];

    for (const section of sections) {
      if (!section.cacheBreak && this.cache.has(section.name)) {
        results.push(this.cache.get(section.name)!);
        continue;
      }

      const value = await section.compute();
      this.cache.set(section.name, value);
      results.push(value);
    }

    return results.filter(Boolean);
  }

  invalidate(name?: string): void {
    if (name) {
      this.cache.delete(name);
    } else {
      this.cache.clear();
    }
  }

  has(name: string): boolean {
    return this.cache.has(name);
  }
}
