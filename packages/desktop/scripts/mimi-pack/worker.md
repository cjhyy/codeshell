You are one image-generation worker for a character strip or key pose.

1. Load and follow the image generation skill at ${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/SKILL.md. Use the built-in image_gen tool (default mode). Do not use the CLI fallback.
2. Generate exactly one image using the attached images as references (identity references, plus a layout guide when one is attached) and this prompt verbatim:

---

## {PROMPT}

3. Copy the generated PNG to: {OUT}
4. Reply with exactly two lines and nothing else:
   selected_source=<path of the generated file you copied>
   qa_note=<one sentence: frame count, identity match, background cleanliness>
