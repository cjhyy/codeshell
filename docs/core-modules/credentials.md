# credentials

**One-line role.** A small two-layer (user / project) on-disk store for long-lived secret references — `token` and `link` credentials — that other parts of core resolve by id (notably MCP `credentialRef` → `Authorization: Bearer`).

## 职责 / Responsibility

This module owns persistence and resolution of *named* credentials. A consumer stores a secret once under a stable kebab-case `id`, then references it by that id elsewhere (e.g. an MCP server config's `credentialRef`) instead of pasting the raw secret. Storage mirrors `SettingsManager`'s two-layer model: a user layer at `~/.code-shell/credentials.json` and an optional project layer at `<cwd>/.code-shell/credentials.json`, with project winning on id collisions.

Boundaries: it only handles `token` and `link` types. **Cookies are deliberately out of scope** — by design they live in the host's `persist:browser` session partition and are leased on demand (the cookie bridge lives in `packages/desktop/src/main/credentials-service.ts`, not here). This module also does no encryption: secrets are stored plaintext in a `0o600` file. It does not inject anything into the environment or HTTP requests itself — callers resolve and apply.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Public barrel. Re-exports `CredentialStore` and the public types. |
| `store.ts` | The `CredentialStore` class: read/write the two JSON layers, upsert/remove, merged `list`/`resolve`, and `listMasked` for UI. |
| `types.ts` | Wire types: `Credential`, `CredentialType` (`"token" \| "link"`), `CredentialStoreFile`. |
| `store.test.ts` | bun tests covering round-trip, scope precedence, resolve, remove, masking (uses `process.env.HOME` to isolate). |

## 公开接口 / Public API

Exported from `packages/core/src/index.ts` (and the module `index.ts`):

```ts
type CredentialType = "token" | "link";

interface Credential {
  id: string;            // kebab-case, unique within a layer, e.g. "my-figma-token"
  type: CredentialType;
  label: string;         // display name
  secret?: string;       // token value, or JSON for link (client id/secret)
  exposeAsEnv?: string;  // OPTIONAL shell env var name (see Gotchas — not yet wired)
  meta?: { appUrl?: string };
}

interface CredentialStoreFile { version: 1; credentials: Credential[] }

type CredentialScope = "user" | "project";

interface MaskedCredential extends Omit<Credential, "secret"> {
  hasSecret: boolean;
  secretHint?: string;   // e.g. "****abcd"; never the full plaintext
}

class CredentialStore {
  constructor(cwd?: string);                       // omit cwd → user-scope only
  save(scope: CredentialScope, cred: Credential): void;   // upsert by id
  remove(scope: CredentialScope, id: string): void;
  list(): Credential[];                            // merged, project overrides user
  resolve(id: string): Credential | undefined;     // merged lookup by id
  listMasked(): MaskedCredential[];                // safe for UI, no secrets
}
```

## 怎么用 / How to use

**1. Resolve a credential to a Bearer header (real call site — `tool-system/mcp-manager.ts`).**
MCP-referenced credentials are user-global, so the shared manager constructs a user-scope store (no cwd) and passes a resolver into the pure `buildHttpHeaders`:

```ts
import { CredentialStore } from "../credentials/index.js";

const credStore = new CredentialStore(undefined); // user scope
const headers = buildHttpHeaders(name, config, (id) => credStore.resolve(id)?.secret);
// buildHttpHeaders throws if config.credentialRef is set but resolves to empty/undefined.
```

**2. Host CRUD for a settings UI (desktop service pattern).**
Save into the chosen layer, then hand the renderer a masked view:

```ts
import { CredentialStore } from "@code-shell/core"; // re-exported from core index

const store = new CredentialStore(projectCwd);      // pass cwd to reach the project layer
store.save("user", {
  id: "my-figma-token",
  type: "token",
  label: "Figma PAT",
  secret: rawToken,
});
return store.listMasked(); // -> [{ id, type, label, hasSecret, secretHint: "****abcd", ... }]
```

## 注意 / Gotchas

- **No encryption.** Secrets are written as plaintext JSON (file mode `0o600`, atomic temp+rename). Treat the file like an ssh key; never log `credential.secret`. For UI always go through `listMasked()` / `secretHint`, never `list()`.
- **Cookies are not stored here.** Despite the module's "cookie bridge" framing, no cookie type exists. The cookie path is host-side (Electron `persist:browser` → on-demand Netscape `cookies.txt` lease in `packages/desktop/src/main/credentials-service.ts`). Don't add a `"cookie"` `CredentialType`.
- **`exposeAsEnv` is stored but not yet consumed.** The field's doc comment says it feeds `readShellEnv`, but `engine.ts#readShellEnv` currently only layers `localEnvironment.env` and the top-level `env` map — it does **not** read `CredentialStore`. Setting `exposeAsEnv` has no runtime effect today; wiring it is future work.
- **Scope precedence:** `list()`/`resolve()` merge user then project, **project wins** on same id. `save`/`remove` are per-scope and require you to name the scope explicitly. A store built with no `cwd` silently has no project layer (project reads/writes are no-ops).
- **`credentialRef` must resolve or it throws.** In `buildHttpHeaders`, a configured `credentialRef` that resolves to `undefined`/`""` raises `MCP server "<name>": credential "<id>" not found or empty` at connect time — a missing credential fails the connection rather than silently sending no auth.
- **`credentialRef` is stripped from MCP schema validation** in places (see `b503bc1c`); the binding survives round-trip but don't assume every parsed config object still carries it after every transform — verify with a round-trip test (`settings/schema.test.ts`).
- **Test isolation via `HOME`:** `userHome()` honors `process.env.HOME` (mirrors `settings/manager.ts`). Tests must override `HOME` to a temp dir, or they will read/write the real `~/.code-shell/credentials.json`.
- **Not present in this worktree.** As of writing, the module lives on the `main` branch only (merge `e68aa185`); the `worktree-core-bug-fixes` checkout does not contain `packages/core/src/credentials/`. Changes to core require a rebuild before TUI/dist consumers pick them up.
