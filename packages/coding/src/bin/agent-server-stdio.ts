import { registerCapability } from "@cjhyy/code-shell-core";
import { CODING_CAPABILITY } from "../index.js";

registerCapability(CODING_CAPABILITY);
await import("@cjhyy/code-shell-core/bin/agent-server-stdio");
