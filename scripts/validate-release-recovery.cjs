/* global require, module */
/* eslint @typescript-eslint/no-require-imports: "off" -- actions/github-script loads this CommonJS helper. */
const { readdirSync, readFileSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

const REQUIRED_JOBS = [
  "verify tag matches package versions",
  "package release smoke (ten tarballs)",
  "package (ubuntu-latest)",
  "package (macos-latest)",
  "package (windows-latest)",
];
const REQUIRED_ARTIFACTS = ["codeshell-linux", "codeshell-mac", "codeshell-windows"];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/** Read-only gate: recover an existing tag's verified installers, never rebuild or retag. */
async function validateReleaseRecovery({ github, context, tag, sourceRunId }) {
  requireCondition(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag), "Invalid release tag");
  requireCondition(/^[1-9]\d*$/.test(sourceRunId), "Invalid source run ID");
  const runId = Number(sourceRunId);
  requireCondition(Number.isSafeInteger(runId), "Source run ID is out of range");
  const repo = context.repo;
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId });
  requireCondition(
    run.path === ".github/workflows/release.yml" &&
      run.event === "push" &&
      run.head_branch === tag &&
      run.head_repository?.full_name === `${repo.owner}/${repo.repo}` &&
      run.status === "completed",
    "Source must be a completed release workflow pushed for this repository and tag",
  );
  const { data: reference } = await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` });
  let object = reference.object;
  for (let depth = 0; object.type === "tag" && depth < 8; depth += 1) {
    const { data: annotatedTag } = await github.rest.git.getTag({ ...repo, tag_sha: object.sha });
    object = annotatedTag.object;
  }
  requireCondition(
    object.type === "commit" && object.sha === run.head_sha,
    "Source run SHA does not match the existing tag commit",
  );
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: runId,
    filter: "latest",
    per_page: 100,
  });
  for (const name of REQUIRED_JOBS) {
    const matches = jobs.filter((job) => job.name === name);
    requireCondition(
      matches.length === 1 &&
        matches[0].status === "completed" &&
        matches[0].conclusion === "success",
      `Source prerequisite did not succeed: ${name}`,
    );
  }
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...repo,
    run_id: runId,
    per_page: 100,
  });
  const artifactIds = REQUIRED_ARTIFACTS.map((name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    requireCondition(
      matches.length === 1 && !matches[0].expired && matches[0].size_in_bytes > 0,
      `Source artifact missing, ambiguous, empty, or expired: ${name}`,
    );
    return matches[0].id;
  });
  return { sha: object.sha, artifactIds: artifactIds.join(",") };
}

/** Verify downloaded updater manifests and asset names before publishing anything. */
function collectReleaseAssets(directory, version) {
  const root = resolve(directory);
  const assets = [];
  const names = new Set();
  const versionInName = new RegExp(
    `(?:^|[-_])${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[-_.]|$)`,
  );
  for (const platform of REQUIRED_ARTIFACTS) {
    const platformDir = join(root, platform);
    const metadata =
      platform === "codeshell-windows"
        ? "latest.yml"
        : platform === "codeshell-mac"
          ? "latest-mac.yml"
          : "latest-linux.yml";
    const manifest = readFileSync(join(platformDir, metadata), "utf8");
    requireCondition(
      manifest.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m)?.[1] === version,
      `Updater version does not match the tag: ${platform}/${metadata}`,
    );
    const files = readdirSync(platformDir, { withFileTypes: true }).filter(
      (entry) =>
        entry.isFile() &&
        /(?:\.(?:exe|dmg|zip|AppImage|blockmap)|^latest[^/]*\.yml)$/.test(entry.name),
    );
    requireCondition(
      files.some((entry) => /\.(exe|dmg|zip|AppImage)$/.test(entry.name)),
      `Installer missing from ${platform}`,
    );
    for (const file of files) {
      requireCondition(
        file.name.endsWith(".yml") || versionInName.test(file.name),
        `Release asset filename does not match the tag: ${file.name}`,
      );
      requireCondition(!names.has(basename(file.name)), "Duplicate release asset basename");
      names.add(file.name);
      assets.push(join(platformDir, file.name));
    }
  }
  return assets.sort();
}

module.exports = { validateReleaseRecovery, collectReleaseAssets };
