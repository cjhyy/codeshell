/**
 * Renderer-side global typings for window.codeShell. Imported by the
 * renderer tsconfig so `window.codeShell.sendRpc(...)` is type-checked.
 */

declare global {
  interface Window {
    codeShell: {
      sendRpc(msg: unknown): void;
      onRpc(
        listener: (msg: unknown) => void,
      ): (event: unknown, msg: unknown) => void;
      removeRpcListener(
        wrapped: (event: unknown, msg: unknown) => void,
      ): void;
    };
  }
}

export {};
