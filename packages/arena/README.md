# @cjhyy/code-shell-arena

Retained private multi-model analysis source for `@cjhyy/code-shell-core`. Arena
coordinates participant research, evidence collection, review, debate,
adjudication, and consensus without adding multi-model policy to core.

## Private workspace entries

This package is `private: true`, is not published to npm, and is not loaded by
Desktop, TUI, or Server. Its source and tests remain in this workspace for
experimentation; the following entry is an internal example, not a product Host
installation instruction:

```ts
import {
  Arena,
  createArenaCapability,
  formatArenaResultForSession,
} from "@cjhyy/code-shell-arena/runtime";
```

`/runtime` contains the Arena class, capability factory, model presets, result
renderers, and public runtime types. It intentionally excludes phase/strategy
internals and Iterate mode for isolated workspace experiments.

The package root remains fully compatible and continues to expose advanced
algorithms, phase helpers, transitions, ledger primitives, and `IterativeArena`.
Both entries are private. The workspace version follows the repository version
for consistency, but neither entry is a published release artifact.

## Workspace experiment

```ts
import { Engine } from "@cjhyy/code-shell-core";
import { createArenaCapability } from "@cjhyy/code-shell-arena/runtime";

const engine = new Engine({
  llm: {
    provider: "openai",
    model: "openai/gpt-5.4",
    apiKey: process.env.OPENAI_API_KEY!,
  },
  capabilities: [createArenaCapability()],
});
```

## License

MIT.
