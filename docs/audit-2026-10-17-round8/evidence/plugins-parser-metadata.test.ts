import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarketplaceInput, deriveMarketplaceName } from "../../../packages/core/src/plugins/parseMarketplaceInput.js";
import { assertSafePluginName } from "../../../packages/core/src/plugins/installer/paths.js";
import { validateMarketplace, validatePluginEntrySource } from "../../../packages/core/src/plugins/schemas.js";
import { detectPluginFormat } from "../../../packages/core/src/plugins/installer/detectFormat.js";
import { normalizePluginManifest, readCanonicalPluginManifest } from "../../../packages/core/src/plugins/installer/normalizeManifest.js";
const owned: string[] = [];
afterEach(async () => { for (const p of owned.splice(0)) await rm(p, {recursive: true, force: true}); });
async function ownTemp() {const p=await mkdtemp(join(tmpdir(),"codeshell-audit-r8-plugin-meta-")); owned.push(p); return p;}
describe("round8 plugin parser metadata", () => {
  test("PLUGIN-R8-03: accepted Windows backslash source derives an unusable marketplace name", () => {
    const input = String.raw`C:\work\skills.git`;
    const source = parseMarketplaceInput(input);
    expect(source).toEqual({source:"git",url:input});
    const name = deriveMarketplaceName(source!);
    expect(name).toBe(String.raw`\work\skills`);
    expect(() => assertSafePluginName(name)).toThrow("plugin name must be a single path segment");
    console.log(JSON.stringify({id:"PLUGIN-R8-03",input,source,name,result:"rejected by the same name guard called by marketplaceDir before clone"}));
  });
  test("control: Windows forward slashes, POSIX, github shorthand and HTTPS derive usable tails", () => {
    for (const input of ["C:/work/skills.git","/tmp/skills.git","owner/Skills","https://github.com/owner/Skills.git"]) {
      const source = parseMarketplaceInput(input);
      expect(source).not.toBeNull();
      expect(deriveMarketplaceName(source!)).toBe("skills");
      expect(() => assertSafePluginName(deriveMarketplaceName(source!))).not.toThrow();
    }
  });
  test("ordinary marketplace metadata source normalization and owner fallback", () => {
    const result = validateMarketplace({name:"example",interface:{displayName:"Example"},plugins:[
      {name:"local",source:{source:"local",path:"./plugins/local"},version:"1.2.3"},
      {name:"remote",source:{source:"url",url:"https://example.invalid/project.git",path:"plugins/remote",ref:"v1",sha:"abc"}}
    ]});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.owner.name).toBe("Example");
    expect(result.value.plugins[0].source).toBe("./plugins/local");
    expect(result.value.plugins[0].version).toBe("1.2.3");
    expect(result.value.plugins[1].source).toEqual({source:"git-subdir",url:"https://example.invalid/project.git",path:"plugins/remote",ref:"v1",sha:"abc"});
    expect(validatePluginEntrySource({source:"local"},"entry").ok).toBe(false);
  });
  test("format detection follows the documented binary rule without opening any manifest", async () => {
    const root=await ownTemp();
    expect(detectPluginFormat(root)).toBe("cc");
    await mkdir(join(root,".claude-plugin"));
    await writeFile(join(root,".claude-plugin","plugin.json"),"{}");
    expect(detectPluginFormat(root)).toBe("cc");
    await mkdir(join(root,".codex-plugin"));
    await writeFile(join(root,".codex-plugin","plugin.json"),"{}");
    expect(detectPluginFormat(root)).toBe("codex");
  });
  test("canonical metadata normalization and readback preserve declared display fields", async () => {
    const root=await ownTemp(), src=join(root,"source"), dest=join(root,"canonical");
    await mkdir(join(src,".codex-plugin"),{recursive:true});
    await writeFile(join(src,".codex-plugin","plugin.json"),JSON.stringify({name:"example",version:"1.2.3",description:"ordinary metadata",interface:{displayName:"Example",defaultPrompt:["Review this file"],brandColor:"#123abc",unknownField:"ignored"}}));
    const manifest=await normalizePluginManifest(src,{name:"example",format:"codex",destinationRoot:dest});
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.interface).toEqual({displayName:"Example",defaultPrompt:["Review this file"],brandColor:"#123abc"});
    expect(await readCanonicalPluginManifest(dest)).toEqual(manifest);
  });
});
