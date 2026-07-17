import { registerCapability } from "@cjhyy/code-shell-core/extension";
import { CODING_CAPABILITY } from "../index.capability.js";

registerCapability(CODING_CAPABILITY);
await import("@cjhyy/code-shell-core/bin/agent-server-stdio");
