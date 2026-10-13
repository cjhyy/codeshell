// Builtins/test guard only. This preload runs before the real Server/Core entry.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import {
  candidateHash,
  candidateFile,
  installDockerCandidateGuard,
} from "../docker-candidate-guard.mjs";
import { loadCandidateStockWebSocket } from "../docker-candidate-stock-ws.mjs";

const bytes = readFileSync(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG);
assert.equal(candidateHash(bytes), process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH);
const config = JSON.parse(bytes);
const children = new Set();
const closed = [];
const guard = installDockerCandidateGuard(config, {
  ...(config.role === "controller"
    ? {
        loadStockWebSocket: () => loadCandidateStockWebSocket(config.stockWebSocket),
        runtimeChild(_config, command, args, options) {
          const worker = config.worker;
          if (command !== worker.node || JSON.stringify(args) !== JSON.stringify([worker.entry]))
            return undefined;
          assert.equal(realpathSync(options.cwd), worker.cwd);
          const policy = candidateFile(config.workerPolicy, { privateFile: true });
          assert.equal(options.env.CODESHELL_DOCKER_CANDIDATE_CONFIG, config.workerPolicy);
          assert.equal(options.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH, policy.sha256);
          assert.equal(JSON.parse(policy.bytes).role, "worker");
          return {
            path: worker.node,
            sha256: worker.nodeHash,
            entry: worker.entry,
            entryHash: worker.entryHash,
            cwd: worker.cwd,
            role: "worker",
            environment: {
              HOME: config.home,
              USERPROFILE: config.home,
              CODE_SHELL_HOME: `${config.home}/.code-shell`,
              NODE_OPTIONS: process.env.NODE_OPTIONS,
              CODESHELL_DOCKER_CANDIDATE_CONFIG: config.workerPolicy,
              CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH: policy.sha256,
            },
          };
        },
        childStarted(child) {
          children.add(child);
          child.once("close", (code, signal) => {
            children.delete(child);
            closed.push({ pid: child.pid, code, signal });
          });
        },
      }
    : {}),
});
globalThis[Symbol.for("codeshell.connection-recovery.fixture")] = {
  config,
  guard,
  children,
  closed,
};
