import { ManagePage } from "./ManagePage";

interface Props {
  activeRepoPath: string | null;
}

/**
 * Unified extensions surface (Codex-style). P1: renders the management page
 * (plugins / skills / MCP tabs). P3 will add a discovery home + switch here.
 */
export function ExtensionsPage({ activeRepoPath }: Props) {
  const cwd = activeRepoPath ?? "/";
  return (
    <div className="ext-page">
      <ManagePage cwd={cwd} activeRepoPath={activeRepoPath} />
    </div>
  );
}
