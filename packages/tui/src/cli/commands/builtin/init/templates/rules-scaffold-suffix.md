## After writing CODESHELL.md — optional rules split

After CODESHELL.md exists, check whether it's substantial enough to benefit from splitting topic-specific guidance into `.codeshell/rules/*.md` files (Code Shell loads all of them in addition to the main file).

Only offer the split when the file has at least two clearly different topics (e.g. "code style" AND "testing", or "build commands" AND "PR conventions"). For a short file with one focus, skip this step entirely.

If a split would be useful, use **AskUserQuestion** once with these options (header: "Rules split"). **Translate the question, header, labels, and descriptions into the user's language** (e.g. Chinese if the user has been writing in Chinese — header becomes "规则拆分", "(Recommended)" becomes "(推荐)", etc.). The English wording below is a shape guide:

- "Keep single file (Recommended)" — concise, easy to scan; do nothing further.
- "Split into topic files" — you will Edit CODESHELL.md to a short overview that points at `.codeshell/rules/`, and Write 2-4 topic files (e.g. `code-style.md`, `testing.md`, `conventions.md`) under that directory. Filenames must be lowercase kebab-case.
- "Just scaffold empty files" — you will Write empty `.codeshell/rules/{code-style,testing,conventions}.md` placeholders (each with a single H1 header) so the user can fill them later.

Act on whichever option they pick, then end the turn. If they pick "Keep single file" / "保留单文件" or cancel, do nothing and end the turn.
