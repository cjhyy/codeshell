import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { HubAuthStore } from "../hub/auth-store.js";
import { ProjectRegistry } from "./registry.js";

const LABEL = "io.codeshell.project-runtime";
const FORMAT = "codeshell.project-installation-backup";
const MAX_CONTROL_FILE = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Digest = { sha256: string; bytes: number };
type Project = { id: string; ownerId: string; generation: number };
interface Manifest {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  installationId: string;
  helperImage: string;
  projects: Project[];
  control: Record<string, Digest>;
  volumes: Array<{ projectId: string; kind: "data" | "workspace"; file: string; digest: Digest }>;
}
export interface ProjectBackupOptions {
  dataDir: string;
  destination: string;
  /** Locally available, administrator-reviewed Linux image containing tar. No pull occurs. */
  helperImage: string;
}
export interface ProjectRestoreOptions {
  source: string;
  destination: string;
  helperImage: string;
}
const digest = (value: Buffer): Digest => ({
  sha256: createHash("sha256").update(value).digest("hex"),
  bytes: value.length,
});

function imageId(image: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Backup helper must be a local immutable Docker image ID (sha256:...).");
}
async function regular(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    throw new Error("Backup metadata must be a bounded regular file without links.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await file.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || after.size > maximum)
      throw new Error("Backup file changed while opening.");
    const bytes = Buffer.alloc(after.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== after.size) throw new Error("Backup file changed while reading.");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
async function directory(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Expected an ordinary directory.");
}
async function exclusiveDestination(source: string, destination: string) {
  const src = await realpath(source);
  const parent = await realpath(dirname(destination));
  const target = join(parent, relative(dirname(destination), destination));
  const rel = relative(src, target);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep)))
    throw new Error("Backup/restore destination must be outside the source directory.");
  await mkdir(target, { mode: 0o700 }); // Never replace an existing directory.
  return target;
}
function docker(args: string[]): Promise<string> {
  return new Promise((yes, no) => {
    execFile(
      "docker",
      args,
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) no(new Error(`Docker ${args[0]} operation failed.`));
        else yes(stdout.trim());
      },
    );
  });
}
async function inspect(kind: "container" | "volume", name: string) {
  // Distinguish absence from daemon/permission errors through a successful inventory.
  const names = (
    await docker([
      kind === "container" ? "ps" : "volume",
      ...(kind === "container" ? ["-a"] : ["ls"]),
      "--format",
      kind === "container" ? "{{.Names}}" : "{{.Name}}",
    ])
  ).split("\n");
  if (!names.includes(name)) return null;
  const rows = JSON.parse(await docker([kind, "inspect", name]));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Invalid Docker inventory.");
  return rows[0];
}
function labels(installation: string, project: Project) {
  return {
    [`${LABEL}.installation`]: installation,
    [`${LABEL}.project`]: project.id,
    [`${LABEL}.owner`]: project.ownerId,
  };
}
function owns(row: any, expected: Record<string, string>) {
  const actual = row?.Config?.Labels ?? row?.Labels;
  if (!actual || Object.entries(expected).some(([key, value]) => actual[key] !== value))
    throw new Error("Docker resource does not belong to the expected installation and project.");
}
const baseName = (installation: string, projectId: string) =>
  `codeshell-${installation}-${projectId}`;
async function stopped(installation: string, projects: Project[]) {
  for (const project of projects) {
    const row = await inspect("container", baseName(installation, project.id));
    if (!row) continue;
    owns(row, labels(installation, project));
    if (row.State?.Running || row.State?.Restarting || row.State?.Paused)
      throw new Error("Stop every project container before backing up.");
  }
}
async function archive(
  volume: string,
  file: string,
  helperImage: string,
  restore: boolean,
  expected?: Digest,
) {
  const id = randomUUID();
  const name = `codeshell-backup-${id}`;
  const argv = [
    "container",
    "create",
    "--name",
    name,
    "--label",
    `io.codeshell.backup=${id}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--user",
    "0:0",
    "--cap-drop=ALL",
    "--cap-add=DAC_OVERRIDE",
    "--security-opt=no-new-privileges:true",
    "--memory=256m",
    "--pids-limit=32",
    "--mount",
    `type=volume,source=${volume},target=/volume${restore ? "" : ",readonly"}`,
    "--entrypoint",
    "tar",
  ];
  if (restore) argv.push("--cap-add=CHOWN", "--cap-add=FOWNER", "-i");
  argv.push(helperImage, restore ? "-xpf" : "-cpf", "-", "-C", "/volume");
  if (!restore) argv.push(".");
  let container: string | undefined;
  try {
    container = await docker(argv);
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid backup container identity.");
    const child = spawn("docker", ["start", "-a", ...(restore ? ["-i"] : []), container], {
      stdio: [restore ? "pipe" : "ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
    const finished = new Promise<void>((yes, no) => {
      child.once("error", no);
      child.once("close", (code) =>
        code === 0 ? yes() : no(new Error("Volume archive operation failed.")),
      );
    });
    // Opening the archive can fail before Promise.allSettled attaches its handlers.
    void finished.catch(() => undefined);
    if (restore) child.stdout?.resume();
    let input;
    const hash = createHash("sha256");
    let bytes = 0;
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      if (restore) input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const transfer = restore
        ? pipeline(input!.createReadStream(), hashing, child.stdin!)
        : pipeline(
            child.stdout!,
            createWriteStream(file, { flags: "wx", mode: 0o600, flush: true }),
          );
      const results = await Promise.allSettled([
        transfer.catch((error) => {
          child.kill("SIGKILL");
          throw error;
        }),
        finished,
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (restore && expected) same({ sha256: hash.digest("hex"), bytes }, expected);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await input?.close();
    }
  } finally {
    const row = await inspect("container", name);
    if (row) {
      owns(row, { "io.codeshell.backup": id });
      await docker(["rm", "-f", row.Id]);
    }
  }
}
async function fileDigest(path: string): Promise<Digest> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw new Error("Archive must be a regular file without links.");
  const hash = createHash("sha256");
  let bytes = 0;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (metadata.ino !== opened.ino || metadata.dev !== opened.dev || opened.nlink !== 1)
      throw new Error("Archive changed while opening.");
    for await (const chunk of file.createReadStream()) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return { sha256: hash.digest("hex"), bytes };
}
function same(actual: Digest, expected: Digest) {
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
    throw new Error("Backup checksum verification failed.");
}
async function controlBytes(root: string, path: string): Promise<Buffer> {
  const parts = path.split("/");
  let parent = root;
  await directory(parent);
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    await directory(parent);
  }
  return regular(join(root, path), MAX_CONTROL_FILE);
}
async function copyControl(
  source: string,
  destination: string,
  records: Record<string, Digest>,
  prefix = "",
) {
  await directory(source);
  for (const name of await readdir(source)) {
    const key = prefix ? `${prefix}/${name}` : name;
    if (
      ["project-control.lock", "project-runtime-secrets", "administrator-setup.txt"].includes(key)
    )
      continue;
    if (key === "restore-in-progress") throw new Error("Cannot back up an incomplete restore.");
    if (Object.keys(records).length >= 4096)
      throw new Error("Control directory contains too many files.");
    const src = join(source, name),
      dst = join(destination, name);
    const metadata = await lstat(src);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await mkdir(dst, { mode: 0o700 });
      await copyControl(src, dst, records, key);
    } else {
      const bytes = await regular(src, MAX_CONTROL_FILE);
      await writeFile(dst, bytes, { mode: 0o600, flag: "wx", flush: true });
      records[key] = digest(bytes);
    }
  }
}

/** Offline, owner-only backup. It never stops projects or modifies their volumes. */
export async function backupProjectInstallation(options: ProjectBackupOptions) {
  imageId(options.helperImage);
  const source = resolve(options.dataDir);
  await directory(source);
  // Do not initialize a fresh registry as a side effect of a mistaken backup path.
  await regular(join(source, "project-control/registry.json"), 512 * 1024);
  const registry = new ProjectRegistry(source);
  let destination: string | undefined;
  try {
    const rows = registry.all();
    if (rows.some((row) => row.status !== "stopped"))
      throw new Error("Stop all projects and the controller before backup.");
    const auth = new HubAuthStore({ dataDir: source });
    if (!auth.isInitialized()) throw new Error("Complete administrator setup before backing up.");
    const installationId = registry.installationId;
    const projects = rows.map(({ id, ownerId, generation }) => ({ id, ownerId, generation }));
    await stopped(installationId, projects);
    await docker(["image", "inspect", options.helperImage]);
    destination = await exclusiveDestination(source, resolve(options.destination));
    await mkdir(join(destination, "control"), { mode: 0o700 });
    await mkdir(join(destination, "volumes"), { mode: 0o700 });
    const manifest: Manifest = {
      format: FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      installationId,
      helperImage: options.helperImage,
      projects,
      control: Object.create(null),
      volumes: [],
    };
    await copyControl(source, join(destination, "control"), manifest.control);
    for (const project of projects) {
      let found = 0;
      for (const kind of ["data", "workspace"] as const) {
        const volume = `${baseName(installationId, project.id)}-${kind}`;
        const row = await inspect("volume", volume);
        if (!row) continue;
        owns(row, labels(installationId, project));
        const users = await docker(["ps", "-q", "--filter", `volume=${volume}`]);
        if (users) throw new Error("A running container still uses a project volume.");
        const file = `volumes/${project.id}-${kind}.tar`;
        await archive(volume, join(destination, file), options.helperImage, false);
        manifest.volumes.push({
          projectId: project.id,
          kind,
          file,
          digest: await fileDigest(join(destination, file)),
        });
        found++;
      }
      if (found !== 2 && !(found === 0 && project.generation === 0))
        throw new Error("Project volume set is incomplete.");
    }
    await stopped(installationId, projects);
    registry.all(); // Recheck registry ownership and unchanged bytes after asynchronous work.
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(manifestBytes) > 1024 * 1024)
      throw new Error("Backup manifest exceeds its supported size.");
    await writeFile(join(destination, "manifest.json"), manifestBytes, {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    return {
      destination,
      projects: projects.length,
      volumes: manifest.volumes.length,
      installationId,
    };
  } catch (error) {
    if (destination) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    registry.close();
  }
}
function validateManifest(value: any): asserts value is Manifest {
  if (
    value?.format !== FORMAT ||
    value.version !== 1 ||
    !UUID.test(value.installationId) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 128 ||
    !Array.isArray(value.volumes) ||
    value.volumes.length > 256 ||
    !value.control ||
    typeof value.control !== "object" ||
    Array.isArray(value.control)
  )
    throw new Error("Unsupported or invalid Cloud backup manifest.");
  const ids = new Set();
  for (const p of value.projects) {
    if (
      !p ||
      !UUID.test(p.id) ||
      !UUID.test(p.ownerId) ||
      ids.has(p.id) ||
      !Number.isSafeInteger(p.generation) ||
      p.generation < 0
    )
      throw new Error("Invalid backup project identity.");
    ids.add(p.id);
  }
  const paths = new Set();
  for (const item of value.volumes) {
    if (
      !item ||
      !ids.has(item.projectId) ||
      !["data", "workspace"].includes(item.kind) ||
      item.file !== `volumes/${item.projectId}-${item.kind}.tar` ||
      paths.has(item.file)
    )
      throw new Error("Invalid backup volume inventory.");
    paths.add(item.file);
  }
  if (Object.keys(value.control).length > 4096) throw new Error("Invalid control inventory.");
  for (const [path, entry] of Object.entries(value.control) as Array<[string, any]>) {
    if (
      !path ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\0\r\n]/.test(path) ||
      path === "restore-in-progress" ||
      path.startsWith("project-control.lock/") ||
      path === "project-control.lock" ||
      !entry ||
      !SHA.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_CONTROL_FILE
    )
      throw new Error("Invalid backup control entry.");
  }
  for (const item of value.volumes)
    if (
      !item.digest ||
      !SHA.test(item.digest.sha256) ||
      !Number.isSafeInteger(item.digest.bytes) ||
      item.digest.bytes < 0
    )
      throw new Error("Invalid backup archive digest.");
  for (const project of value.projects) {
    const count = value.volumes.filter((v: any) => v.projectId === project.id).length;
    if (count !== 2 && !(count === 0 && project.generation === 0))
      throw new Error("Incomplete backup volume set.");
  }
  for (const path of [
    "project-control/registry.json",
    "project-control/initialized",
    "hub/auth.json",
  ])
    if (!Object.hasOwn(value.control, path)) throw new Error("Backup lacks required control data.");
}

/** Restore into a new directory and new Docker volumes. Original installation is untouched. */
export async function restoreProjectInstallation(options: ProjectRestoreOptions) {
  imageId(options.helperImage);
  const source = resolve(options.source);
  await directory(source);
  await directory(join(source, "control"));
  await directory(join(source, "volumes"));
  const manifest = JSON.parse(
    (await regular(join(source, "manifest.json"), 1024 * 1024)).toString(),
  );
  validateManifest(manifest);
  // Verify every archive before creating a destination or Docker resource.
  for (const volume of manifest.volumes)
    same(await fileDigest(join(source, volume.file)), volume.digest);
  for (const [path, expected] of Object.entries(manifest.control))
    same(digest(await controlBytes(join(source, "control"), path)), expected);
  await docker(["image", "inspect", options.helperImage]);
  const destination = await exclusiveDestination(source, resolve(options.destination));
  const created: Array<{ name: string; expected: Record<string, string> }> = [];
  let registry: ProjectRegistry | undefined;
  try {
    await writeFile(join(destination, "restore-in-progress"), "1\n", {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    for (const [path, expected] of Object.entries(manifest.control)) {
      const bytes = await controlBytes(join(source, "control"), path);
      same(digest(bytes), expected);
      await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(destination, path), bytes, { mode: 0o600, flag: "wx", flush: true });
    }
    registry = new ProjectRegistry(destination);
    const rows = registry.all();
    if (
      registry.installationId !== manifest.installationId ||
      rows.some((p) => p.status !== "stopped") ||
      JSON.stringify(rows.map(({ id, ownerId, generation }) => ({ id, ownerId, generation }))) !==
        JSON.stringify(manifest.projects)
    )
      throw new Error("Backup control and volume identities disagree.");
    const auth = new HubAuthStore({ dataDir: destination });
    if (!auth.isInitialized()) throw new Error("Backup administrator is not initialized.");
    auth.revokeAllSessions();
    registry.renewInstallationForRestore();
    const installationId = registry.installationId;
    for (const volume of manifest.volumes) {
      const project = manifest.projects.find((p) => p.id === volume.projectId)!;
      const name = `${baseName(installationId, project.id)}-${volume.kind}`;
      const expected = labels(installationId, project);
      if (await inspect("volume", name))
        throw new Error("Restore volume already exists; refusing to overwrite.");
      await docker([
        "volume",
        "create",
        ...Object.entries(expected).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        name,
      ]);
      created.push({ name, expected });
      owns(await inspect("volume", name), expected);
      await archive(name, join(source, volume.file), options.helperImage, true, volume.digest);
    }
    // Runtime secrets are generated afresh; old bootstrap URLs and environment identities are not reused.
    for (const path of ["project-runtime-secrets", "administrator-setup.txt", "environment.json"])
      await rm(join(destination, path), { recursive: true, force: true });
    registry.all();
    await rm(join(destination, "restore-in-progress"));
    return {
      destination,
      installationId,
      previousInstallationId: manifest.installationId,
      projects: rows.length,
      volumes: created.length,
    };
  } catch (error) {
    // Only delete volumes created by this restore and still carrying its exact labels.
    for (const { name, expected } of created.reverse()) {
      try {
        owns(await inspect("volume", name), expected);
        await docker(["volume", "rm", name]);
      } catch {
        /* Preserve a busy/changed volume for operator inspection. */
      }
    }
    throw error; // Keep the marked offline directory as recovery evidence; never advertise success.
  } finally {
    registry?.close();
  }
}
