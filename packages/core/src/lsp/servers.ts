/**
 * Built-in language server configurations.
 */

export interface LSPServerConfig {
  name: string;
  language: string;
  extensions: string[];
  command: string;
  args: string[];
  installHint: string;
}

export const BUILTIN_LSP_SERVERS: LSPServerConfig[] = [
  {
    name: "typescript",
    language: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    command: "typescript-language-server",
    args: ["--stdio"],
    installHint: "npm install -g typescript-language-server typescript",
  },
  {
    name: "python",
    language: "python",
    extensions: [".py"],
    command: "pylsp",
    args: [],
    installHint: "pip install python-lsp-server",
  },
  {
    name: "go",
    language: "go",
    extensions: [".go"],
    command: "gopls",
    args: ["serve"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    name: "rust",
    language: "rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    installHint: "rustup component add rust-analyzer",
  },
  {
    name: "json",
    language: "json",
    extensions: [".json"],
    command: "vscode-json-languageserver",
    args: ["--stdio"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  {
    name: "css",
    language: "css",
    extensions: [".css", ".scss", ".less"],
    command: "vscode-css-languageserver",
    args: ["--stdio"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
];

/**
 * Detect which LSP server to use based on file extension.
 */
export function detectLSPServer(filePath: string): LSPServerConfig | undefined {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return BUILTIN_LSP_SERVERS.find((s) => s.extensions.includes(ext));
}
