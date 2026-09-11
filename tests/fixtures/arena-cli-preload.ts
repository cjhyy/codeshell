import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import * as runtime from "../../packages/arena/dist/index.runtime.js";

globalThis.fetch = async () => {
  throw new Error("Arena CLI fixture forbids network requests");
};

// This preload only runs in the isolated CLI child. Keep Commander, settings,
// catalog and participant resolution real; replace the external model run.
const mockedRuntime = () => ({
  ...runtime,
  Arena: class {
    constructor(private readonly config: unknown) {}
    async run(topic: string, options: unknown) {
      writeFileSync(
        process.env.CODESHELL_ARENA_CLI_CAPTURE!,
        JSON.stringify({ config: this.config, topic, options }),
      );
      return {};
    }
  },
  printArenaResult: () => {},
});
mock.module("@cjhyy/code-shell-arena/runtime", mockedRuntime);
mock.module("../../packages/arena/dist/index.runtime.js", mockedRuntime);
mock.module("../../packages/arena/src/index.runtime.js", mockedRuntime);

mock.module("../../packages/tui/src/bootstrap/setup.js", () => ({ setup: async () => {} }));
