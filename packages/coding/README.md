# @cjhyy/code-shell-capability-coding

Optional coding capability pack for [`@cjhyy/code-shell-core`](../core/README.md).
It owns CodeShell's coding policy and implementations: the `terminal-coding`
preset, coding prompt, Git/worktree behavior, LSP, ApplyPatch, NotebookEdit,
Brief, review/quota helpers, and external coding-agent adapters.

The package is deliberately separate from core. A service building a customer
support, data, or media agent can install core without pulling a coding preset
into its default runtime. The TUI and Desktop applications install this pack at
their composition roots.

## Use with core

```ts
import { Engine } from "@cjhyy/code-shell-core";
import { CODING_CAPABILITY } from "@cjhyy/code-shell-capability-coding";

const engine = new Engine({
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  capabilities: [CODING_CAPABILITY],
});

// No preset is required: this capability contributes terminal-coding as its
// product default. Passing preset: "general" remains supported.
const result = await engine.run("Inspect this repository and fix the failing test.");
console.log(result.text);
```

For a process composition root, `registerCapability(CODING_CAPABILITY)` installs
the same pack for subsequently created Engines and RunManagers. Prefer the
per-Engine `capabilities` field in reusable libraries and tests.

## Boundary

- Core owns lifecycle contracts and calls generic capability hooks.
- This package owns repository context, instruction boundary detection,
  worktree-specific tool services, and coding artifact detectors.
- Desktop owns the Electron host, renderer panels, protocol bridge, and app
  packaging. The Desktop worker uses this package's agent-server wrapper.

## License

MIT. ApplyPatch carries its upstream Apache-2.0 notice in
`src/tools/apply-patch/NOTICE.md` and `LICENSE-codex`.
