import { ConfigError } from "../exceptions.js";

/** Legacy approval envelopes reserve __* names for trusted host loopbacks. */
export function assertPublicToolName(name: string): void {
  if (name.startsWith("__")) {
    throw new ConfigError(`Tool name "${name}" is reserved for internal host requests`, {
      reservedToolName: name,
    });
  }
}
