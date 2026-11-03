import type { ExternalFileOrigin } from "../types";

export interface FileRevealRequest {
  path: string;
  cwd: string | null;
  nonce: number;
  consumed?: boolean;
  reference?: ExternalFileOrigin;
}
