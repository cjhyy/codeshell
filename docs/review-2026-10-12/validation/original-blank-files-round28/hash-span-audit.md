# R28 Main fsRoot fingerprint span clarification

Both recorded hashes are correct. They identify different exact byte spans; neither implies a product mismatch. The original report is preserved unchanged as `contract-counterreview.original-20df4c8.md` and remains at `contract-counterreview.md` (SHA-256 `20df4c8afa147c15894e27e47285a13f1e39528aced9c31f12eb55e281f4aa16`). The canonical labeled copy is `contract-counterreview.final.md`; only the fingerprint description is clarified.

| SHA-256 | Exact source span | Bytes / lines / trailing LF |
| --- | --- | --- |
| `f237e505b949a33c5257a3052513eafc0e353cfdf5ff062af74f4d81ac545510` | Three complete `ipcMain.handle` registrations: `fsRoot:readDir`, `fsRoot:readFile`, `fsRoot:exists`; starts at the first `i` and ends immediately before `ipcMain.handle("fsSession:readDir",` | 846 bytes / 14 LF-terminated source lines / includes the final LF after the exists `});` |
| `2820bebc653dec326e7a816ff53ad14969983f1f94c1fb0e4178db564d300f9a` | Only the second argument to readDir: starts at `async`, ends after that arrow function's `}`; excludes the IPC prefix, following `);`, and trailing LF | 219 bytes / 4 source lines / 3 internal LF bytes / no final LF |

The arrow includes the source's two-space indentation on its two body lines. It is not a 3-line function body, a trimmed complete registration, or the three-handler bundle. The two frozen Main files differ as whole files, but each of these respective spans matches byte-for-byte. The child confirmed its original bundle algorithm was `t = Path(index).read_text(); a = t.index('ipcMain.handle("fsRoot:readDir"'); z = t.index('ipcMain.handle("fsSession:readDir"', a); sha256(t[a:z].encode())`. Independently checked: each entire frozen source has zero CRLF sequences, and that UTF-8 re-encoded text slice equals the raw-byte slice exactly. Its precise label is `main-index.fsRoot-readDir-readFile-exists.ipc-registration-block.utf8-lf`. `hash-span-audit.json` records source file hashes, exact text, 0-based byte start/end-exclusive offsets, and 1-based line/columns.

Reproduction uses Python standard-library raw-byte reads only, with no product import, TypeScript import, fixture/test execution, Git, network, or model:

```python
from pathlib import Path
from hashlib import sha256
b = Path(REPO / "packages/desktop/src/main/index.ts").read_bytes()
a = b.index(b'ipcMain.handle("fsRoot:readDir",')
z = b.index(b'ipcMain.handle("fsSession:readDir",', a)
print(sha256(b[a:z]).hexdigest())  # f237e505...; final LF retained
s = b.index(b'async (_e, projectId: string, rootId: string, dir?: string) => {', a)
e = b.index(b'\n});', s) + 2  # includes LF + closing }, excludes ); and final LF
print(sha256(b[s:e]).hexdigest())  # 2820bebc...
```

The dynamic R27 fixture's original arrow hash provenance is `TypeScript AST -> ipcMain.handle CallExpression -> arguments[1].getText(sourceFile) -> createHash("sha256").update(block)`. That existing algorithm produces the same exact 219-byte arrow text; this clarification rederives it by raw delimiters without importing or executing that fixture. Current R28 source manifest and R27 executed receipts stay untouched. New findings/executions/product imports: **0**.
