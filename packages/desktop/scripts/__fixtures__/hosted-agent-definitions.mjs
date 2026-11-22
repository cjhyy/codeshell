import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function verifyHostedAgentDefinitions(first, second, mount, projectId) {
  const target = { projectId };
  const definition = {
    name: "host-role",
    description: "Host-scoped role",
    systemPrompt: "Review fixture",
  };
  const path = join(mount, ".code-shell", "agents", "host-role.md");
  const saved = await first.evaluate(
    ([def, target]) => window.codeshell.saveAgent(def, { scope: "project", target }),
    [definition, target],
  );
  assert.equal(saved.filePath, path);
  assert.ok((await readFile(path, "utf8")).includes(definition.systemPrompt));
  assert.ok(
    (await second.evaluate((target) => window.codeshell.listAgents(target), target)).some(
      (role) => role.name === definition.name,
    ),
  );
  const body = await second.evaluate(
    ([target, path]) => window.codeshell.readAgentBody(target, path),
    [target, path],
  );
  assert.ok(body.includes(definition.systemPrompt));
  const userRoles = await second.evaluate(() => window.codeshell.listAgents(null));
  assert.ok(!userRoles.some((role) => role.filePath === path));
  await assert.rejects(
    second.evaluate((path) => window.codeshell.readAgentBody(null, path), path),
    /Desktop Host request failed/,
  );
  await second.evaluate(
    ([name, target]) => window.codeshell.deleteAgent(name, { scope: "project", target }),
    [definition.name, target],
  );
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.ok(
    !(await first.evaluate((target) => window.codeshell.listAgents(target), target)).some(
      (role) => role.name === definition.name,
    ),
  );
}
