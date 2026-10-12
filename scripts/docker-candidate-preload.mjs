// All dependencies are test-only builtins; this must finish before the product entry.
import { candidateFile, installDockerCandidateGuard } from "./docker-candidate-guard.mjs";

const file = candidateFile(process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG ?? "", {
  privateFile: true,
});
if (file.sha256 !== process.env.CODESHELL_DOCKER_CANDIDATE_CONFIG_HASH)
  throw new Error("Docker candidate policy digest changed");
const config = JSON.parse(file.bytes);
if (config.role === "controller")
  throw new Error(
    "Docker candidate controller requires the native egress adapter; direct preload refused",
  );
installDockerCandidateGuard(config);
