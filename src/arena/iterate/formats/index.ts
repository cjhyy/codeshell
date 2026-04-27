/**
 * Format packs — prompt templates for code vs document iteration.
 *
 * Each format provides four prompt builders:
 *   - draftPrompt:    used in tournament v1 (every participant writes a candidate)
 *   - mergePrompt:    used in v1 merge (author reads anonymized candidates → v1)
 *   - argueSystem:    system prompt for critics
 *   - argueUser:      user prompt that wraps the current draft for critique
 *   - revisePrompt:   used to produce v(N+1) given v(N) + critiques
 */

import type { Critique, Draft, DraftCandidate, IterateFormat, IterateSubject } from "../types.js";

export interface FormatPack {
  format: IterateFormat;
  draftPrompt(subject: IterateSubject, minLength: number): string;
  mergePrompt(subject: IterateSubject, candidates: DraftCandidate[], minLength: number): string;
  argueSystem(format: IterateFormat): string;
  argueUser(subject: IterateSubject, draft: Draft, lens?: string): string;
  revisePrompt(subject: IterateSubject, previous: Draft, critiques: Critique[], minLength: number): string;
}

const COMMON_DRAFT_RULES = `
Hard rules:
- Output the FULL artifact, not a sketch or outline.
- No "...", "(continued)", "see above", "TBD", or placeholders.
- Don't pad with filler. Every section must carry information.
- Length is a floor, not a target — go beyond it if the topic warrants.
`;

function formatCritiquesForPrompt(critiques: Critique[]): string {
  return critiques
    .map(
      (c, i) =>
        `[${i + 1}] id=${c.id} severity=${c.severity} category=${c.category} from=${c.critic}\n` +
        `    anchor: "${c.anchor}"\n` +
        `    comment: ${c.comment}` +
        (c.suggestion ? `\n    suggestion: ${c.suggestion}` : ""),
    )
    .join("\n\n");
}

// ─── Code format ────────────────────────────────────────────────

export const codeFormat: FormatPack = {
  format: "code",

  draftPrompt(subject, minLength) {
    return `You are writing a complete code artifact for the following task.

Task: ${subject.label}
Description: ${subject.description}
${subject.sources?.length ? `Source files for context: ${subject.sources.join(", ")}` : ""}

This draft will compete with drafts from other participants in a tournament round.
A merger will then read all drafts (anonymously) and pick the strongest parts.
Make your draft strong, distinct, complete, and self-contained.

Output requirements:
- Compile-ready code in the appropriate language (infer from sources / description).
- Include tests if behavior is non-trivial.
- Inline comments only where the WHY is non-obvious — names should explain WHAT.
- At least ${minLength} characters of substantive code (filler will be cut by the merger).
${COMMON_DRAFT_RULES}`;
  },

  mergePrompt(subject, candidates, minLength) {
    const blocks = candidates
      .map((c) => `--- ${c.anonymousLabel} ---\n${c.content}\n--- end ${c.anonymousLabel} ---`)
      .join("\n\n");

    return `Below are ${candidates.length} draft solutions for the same task, presented anonymously.
Your job: produce a single v1 by merging the strongest parts of each.

Task: ${subject.label}
Description: ${subject.description}

${blocks}

Merging rules:
- For each section / function / module, pick the strongest version OR write a new one inspired by the best ideas.
- Inline EVERYTHING. Do not write "see Draft B for the auth helper" — copy the auth helper in.
- v1 must be COMPLETE and at least ${minLength} characters of substantive code.
- After the code, output a 'mergeRationale' section: one short paragraph per major decision, "From Draft X I took ____, because ____. I rejected ____ because ____."

Output format (literally — these markers will be parsed):

<v1_content>
{full code goes here}
</v1_content>

<merge_rationale>
{your rationale here}
</merge_rationale>`;
  },

  argueSystem() {
    return `You are reviewing a code artifact. Find every meaningful issue.

For each issue:
- "anchor": quote 5-15 words verbatim from the draft to locate the issue.
- "severity": "blocker" (must fix), "major" (should fix), "minor" (nice to fix), "nit" (style), or "praise" (good — don't gut this).
- "category": "correctness" | "completeness" | "clarity" | "evidence" | "structure" | "style" | "other".
- "comment": what's wrong and what you'd do.
- "suggestion": optional concrete fix.

Aim for 8-20 critiques. Include PRAISE for parts that are genuinely good — this prevents the author from accidentally gutting them in the next revision.

Output strictly as JSON: {"critiques": [{...}, ...]}`;
  },

  argueUser(subject, draft, lens) {
    return `Task: ${subject.label}
${lens ? `Review lens: ${lens}\n` : ""}
Current draft (v${draft.version}, by ${draft.author}):

${draft.content}

Now produce your critiques as JSON.`;
  },

  revisePrompt(subject, previous, critiques, minLength) {
    return `You wrote v${previous.version}. Critics raised ${critiques.length} points.
Rewrite the artifact as v${previous.version + 1}.

Task: ${subject.label}
Description: ${subject.description}

Current draft (v${previous.version}):
${previous.content}

Critiques:
${formatCritiquesForPrompt(critiques)}

Rules:
- ADDRESS every blocker and major. You may disagree, but say why in changelog.
- Preserve PRAISE-tagged parts unless a later critique contradicts.
- Output the COMPLETE new artifact (at least ${minLength} chars), not a diff.
- After the code, output a JSON block:

<v_next_content>
{full code goes here}
</v_next_content>

<v_next_meta>
{
  "acceptedCritiques": ["id1", "id2", ...],
  "rejectedCritiques": [{"id": "id3", "reason": "..."}, ...],
  "changelog": "what changed and why, in 1-3 short paragraphs"
}
</v_next_meta>`;
  },
};

// ─── Document format ────────────────────────────────────────────

export const documentFormat: FormatPack = {
  format: "document",

  draftPrompt(subject, minLength) {
    return `You are writing a complete long-form document for the following subject.

Subject: ${subject.label}
Description: ${subject.description}
${subject.sources?.length ? `Reference materials: ${subject.sources.join(", ")}` : ""}

This draft will compete with drafts from other participants in a tournament round.
A merger will then read all drafts (anonymously) and pick the strongest parts.
Make your draft strong, distinct, complete, and self-contained.

Document requirements:
- Use clear hierarchical structure (## sections, ### subsections).
- Every section must carry concrete information: examples, comparisons, trade-offs, numbers.
- Cite sources inline with [n] footnotes when you make factual claims.
- At least ${minLength} characters of substantive prose (filler will be cut by the merger).
${COMMON_DRAFT_RULES}`;
  },

  mergePrompt(subject, candidates, minLength) {
    const blocks = candidates
      .map((c) => `--- ${c.anonymousLabel} ---\n${c.content}\n--- end ${c.anonymousLabel} ---`)
      .join("\n\n");

    return `Below are ${candidates.length} draft documents for the same subject, presented anonymously.
Your job: produce a single v1 markdown document by merging the strongest parts.

Subject: ${subject.label}
Description: ${subject.description}

${blocks}

Merging rules:
- Pick the strongest section from each draft, OR write a new section that combines their best ideas.
- DO NOT write "see Draft B for ____" — inline everything.
- The final v1 must be COMPLETE and at least ${minLength} characters.
- Maintain coherent voice and consistent structure across sections.

Output format (literally — these markers will be parsed):

<v1_content>
{full markdown document}
</v1_content>

<merge_rationale>
{1-3 short paragraphs: from which draft you took which section, why; what you rejected, why}
</merge_rationale>`;
  },

  argueSystem() {
    return `You are reviewing a long-form document. Find every meaningful issue.

For each issue:
- "anchor": quote 5-15 words verbatim from the document to locate the issue.
- "severity": "blocker" | "major" | "minor" | "nit" | "praise".
- "category": "correctness" | "completeness" | "clarity" | "evidence" | "structure" | "style" | "other".
- "comment": what's wrong / missing / weak.
- "suggestion": optional concrete fix or content to add.

Aim for 8-20 critiques. Don't be polite — depth, missing sections, weak claims, and structural issues matter more than typos. Include PRAISE for genuinely strong parts so the author doesn't gut them on revision.

Output strictly as JSON: {"critiques": [{...}, ...]}`;
  },

  argueUser(subject, draft, lens) {
    return `Subject: ${subject.label}
${lens ? `Review lens: ${lens}\n` : ""}
Current document (v${draft.version}, by ${draft.author}):

${draft.content}

Now produce your critiques as JSON.`;
  },

  revisePrompt(subject, previous, critiques, minLength) {
    return `You wrote v${previous.version}. Critics raised ${critiques.length} points.
Rewrite the document as v${previous.version + 1}.

Subject: ${subject.label}
Description: ${subject.description}

Current document (v${previous.version}):
${previous.content}

Critiques:
${formatCritiquesForPrompt(critiques)}

Rules:
- ADDRESS every blocker and major. You may disagree, but say why in changelog.
- Preserve PRAISE-tagged parts.
- Expand sections that were called out as thin / missing examples / lacking evidence.
- Output the COMPLETE new document (at least ${minLength} chars).

Output format (literally — these markers will be parsed):

<v_next_content>
{full markdown document}
</v_next_content>

<v_next_meta>
{
  "acceptedCritiques": ["id1", "id2", ...],
  "rejectedCritiques": [{"id": "id3", "reason": "..."}, ...],
  "changelog": "what changed and why, in 1-3 short paragraphs"
}
</v_next_meta>`;
  },
};

// ─── Selector ───────────────────────────────────────────────────

export function getFormat(format: IterateFormat): FormatPack {
  return format === "code" ? codeFormat : documentFormat;
}
