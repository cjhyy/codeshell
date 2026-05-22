declare global {
  interface Window {
    codeShell: {
      sendRpc(msg: unknown): void;
      onRpc(listener: (msg: unknown) => void): (event: unknown, msg: unknown) => void;
      removeRpcListener(wrapped: (event: unknown, msg: unknown) => void): void;
    };
  }
}
export {};
