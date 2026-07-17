# @cjhyy/code-shell-web

Browser-only state and UI helpers for CodeShell's remote client. The package
contains no Electron code and imports CodeShell core contracts as types only.

## Public surface

The root entry exports:

- the reconnecting WebSocket hook and remote-app state machine;
- protocol stream reducers and message mappers;
- pairing, device-credential, attachment, risk and storage helpers;
- the mobile i18n namespace and translation helpers.

```ts
import { useRemoteApp, useRemoteSocket, classifyRisk, translate } from "@cjhyy/code-shell-web";
```

The reusable browser logic is emitted to `dist/`. The package also ships the
standalone Vite application in `dist-app/`; `@cjhyy/code-shell-server/serve`
uses those assets for the ready-made headless web host.

## Commands

```bash
bun run --cwd packages/web build
bun run --cwd packages/web build:app
bun run --cwd packages/web dev:app
```

`build` cleans both output directories before compiling the library and
building the application, so published assets cannot contain stale files.

## Boundary

This package may use browser APIs and type-only core protocol imports. It must
not import Electron, Desktop preload globals, Node-only runtime modules or core
runtime implementations.

## License

MIT.
