# @cjhyy/code-shell-arena

Optional multi-model analysis capability for `@cjhyy/code-shell-core`. Arena
coordinates participant research, evidence collection, review, debate,
adjudication, and consensus without adding multi-model policy to core.

## Host runtime

Product hosts should use the focused runtime entry:

```ts
import {
  Arena,
  createArenaCapability,
  formatArenaResultForSession,
} from "@cjhyy/code-shell-arena/runtime";
```

`/runtime` contains the Arena class, capability factory, model presets, result
renderers, and public runtime types. It intentionally excludes phase/strategy
internals and Iterate mode, reducing the modules evaluated by normal TUI or
Desktop hosts.

The package root remains fully compatible and continues to expose advanced
algorithms, phase helpers, transitions, ledger primitives, and `IterativeArena`.
Both entries are part of the same release unit.

## Composition

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
