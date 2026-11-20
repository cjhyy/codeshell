import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const require = createRequire(new URL("../package.json", import.meta.url));
const builder = createRequire(require.resolve("electron-builder/package.json"));
const library = dirname(builder.resolve("app-builder-lib/package.json"));
const vendor = (name) => readFileSync(join(library, "templates/nsis", name), "utf8");
const perUserTemplate = vendor("multiUser.nsh");
const lines = (source) =>
  source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";"));
const setter = (source) => {
  const matches = [
    ...source.matchAll(/^\s*!macro setInstallModePerUser\r?\n([\s\S]*?)^\s*!macroend/gmu),
  ];
  assert.equal(matches.length, 1, "One explicit per-user setter is required");
  return lines(matches[0][1]);
};
const api =
  "System::Call 'SHELL32::SHGetKnownFolderPath(g \"${FOLDERID_UserProgramFiles}\", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'";
const copy = "System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'";
const free = "System::Call 'OLE32::CoTaskMemFree(p r2)'";
const fixedRead = "System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'";
// This finite model executes only this setter's reviewed statement vocabulary.
// It tests NSIS source dataflow under Win32 contracts, not a compiler, DLL ABI,
// real allocation, installation or the cause of a previously observed crash.
function model(instructions, fixture = {}) {
  assert.ok(instructions.length <= 64);
  const input = {
    registry: "",
    override: "",
    hresult: 0,
    pointer: "4096",
    path: "D:\\用户\\😀\\Programs",
    ...fixture,
  };
  const limit = 32; // A model bound in WCHARs; JS string indices are UTF-16 units.
  const state = {
    registers: { 1: "saved-one", 2: "saved-two" },
    stack: ["existing-bottom", "existing-top"],
    calls: [],
    sourceReads: [],
    freed: false,
  };
  const r = state.registers;
  const copyWchars = () => {
    assert.equal(r["2"], input.pointer);
    assert.notEqual(r["2"], "0");
    assert.equal(state.freed, false);
    assert.equal(typeof input.path, "string");
    const units = [];
    for (let index = 0; index < limit - 1; index++) {
      assert.ok(index <= input.path.length, "Copy read beyond the terminated source");
      state.sourceReads.push(index);
      const unit = index === input.path.length ? 0 : input.path.charCodeAt(index);
      if (unit === 0) break;
      units.push(unit);
    }
    r["0"] = String.fromCharCode(...units);
    state.calls.push("copy");
  };
  const actions = new Map([
    [
      "strcpy $installmode currentuser",
      () => {
        r.installMode = "CurrentUser";
      },
    ],
    [
      "setshellvarcontext current",
      () => {
        state.shellContext = "current";
      },
    ],
    [
      'readregstr $peruserinstallationfolder hkcu "${install_registry_key}" installlocation',
      () => {
        r.perUserInstallationFolder = input.registry;
      },
    ],
    [
      "strcpy $instdir $peruserinstallationfolder",
      () => {
        r.INSTDIR = r.perUserInstallationFolder;
      },
    ],
    [
      'strcpy $0 "$localappdata\\programs"',
      () => {
        r["0"] = "C:\\LocalAppData\\Programs";
      },
    ],
    [
      "strcpy $2 0",
      () => {
        r["2"] = "0";
      },
    ],
    [
      api.toLowerCase(),
      () => {
        assert.equal(r["2"], "0", "Initialize the out pointer before calling the Shell");
        r["1"] = String(input.hresult);
        r["2"] = input.pointer;
        state.calls.push("lookup");
      },
    ],
    [copy.toLowerCase(), copyWchars],
    [
      free.toLowerCase(),
      () => {
        assert.equal(r["2"], input.pointer);
        assert.notEqual(r["2"], "0");
        assert.equal(state.freed, false);
        state.freed = true;
        state.calls.push("free");
      },
    ],
    [
      'strcpy $instdir "$0\\${app_filename}"',
      () => {
        r.INSTDIR = `${r["0"]}\\code-shell`;
      },
    ],
    [
      "!insertmacro getdparameter $r0",
      () => {
        r.R0 = input.override;
      },
    ],
    [
      "strcpy $instdir $r0",
      () => {
        r.INSTDIR = r.R0;
      },
    ],
  ]);
  const conditions = new Map([
    ['$peruserinstallationfolder != ""', () => r.perUserInstallationFolder !== ""],
    ["$1 == 0", () => r["1"] === "0"],
    ["$2 != 0", () => r["2"] !== "0"],
    ['$r0 != ""', () => r.R0 !== ""],
  ]);
  // Classify every line first, including skipped branches. No arbitrary code or
  // unknown System::Call can hide behind a model input that skips that branch.
  const program = instructions.map((instruction) => {
    const line = instruction.toLowerCase();
    const condition = line.match(/^\$\{if\} (.+)$/u);
    if (condition && conditions.has(condition[1])) return { when: conditions.get(condition[1]) };
    if (line === "${else}" || line === "${endif}") return { control: line };
    const register = line.match(/^(push|pop) \$(1|2)$/u);
    if (register)
      return {
        run: () => {
          if (register[1] === "push") state.stack.push(r[register[2]]);
          else {
            assert.ok(state.stack.length > 2);
            r[register[2]] = state.stack.pop();
          }
        },
      };
    assert.ok(actions.has(line), `Unreviewed setter instruction: ${instruction}`);
    return { run: actions.get(line) };
  });
  let active = true;
  const branches = [];
  for (const instruction of program) {
    if (instruction.when) {
      assert.ok(branches.length < 4);
      const condition = instruction.when();
      branches.push({ parent: active, condition, hadElse: false });
      active = active && condition;
    } else if (instruction.control) {
      assert.ok(branches.length > 0);
      const branch = branches.at(-1);
      if (instruction.control === "${else}") {
        assert.equal(branch.hadElse, false);
        branch.hadElse = true;
        active = branch.parent && !branch.condition;
      } else {
        branches.pop();
        active = branch.parent;
      }
    } else if (active) instruction.run();
  }
  assert.equal(branches.length, 0);
  assert.equal(r["1"], "saved-one");
  assert.equal(r["2"], "saved-two");
  assert.deepEqual(state.stack, ["existing-bottom", "existing-top"]);
  assert.equal(r.installMode, "CurrentUser");
  assert.equal(state.shellContext, "current");
  return state;
}

test("the package uses the reviewed upstream setter and preserves uninstall cleanup", () => {
  assert.equal(JSON.parse(readFileSync(join(library, "package.json"), "utf8")).version, "26.18.1");
  const hook = read("../build/nsis-uninstaller-init.nsh");
  assert.deepEqual(lines(hook), ["!macro customUnInit", 'SetOutPath "$TEMP"', "!macroend"]);
  const config = JSON.parse(read("../package.json")).build.nsis;
  assert.equal(config.include, "nsis-uninstaller-init.nsh");
  assert.equal(config.oneClick, false);
  assert.equal(config.perMachine, false);
});

test("a short redirected Unicode folder is copied before free without disturbing registers or stack", () => {
  const result = model(setter(perUserTemplate));
  assert.equal(result.registers.INSTDIR, "D:\\用户\\😀\\Programs\\code-shell");
  assert.deepEqual(result.calls, ["lookup", "copy", "free"]);
  assert.equal(result.sourceReads.at(-1), "D:\\用户\\😀\\Programs".length);
});

test("failed lookup retains the default and frees any nonzero output even on failure", () => {
  for (const pointer of ["0", "4096"]) {
    const result = model(setter(perUserTemplate), { hresult: -1, pointer, path: null });
    assert.equal(result.registers.INSTDIR, "C:\\LocalAppData\\Programs\\code-shell");
    assert.deepEqual(result.calls, pointer === "0" ? ["lookup"] : ["lookup", "free"]);
    assert.deepEqual(result.sourceReads, []);
  }
});

test("existing registration and the original final /D override keep their precedence", () => {
  const program = setter(perUserTemplate);
  const existing = "E:\\existing-install";
  const registered = model(program, { registry: existing });
  assert.equal(registered.registers.INSTDIR, existing);
  assert.deepEqual(registered.calls, []);
  for (const fixture of [{ registry: existing }, {}, { hresult: -1, pointer: "0", path: null }])
    assert.equal(
      model(program, { ...fixture, override: "F:\\explicit" }).registers.INSTDIR,
      "F:\\explicit",
    );
});

test("the copy bound counts WCHAR units and unknown or unbounded calls are refused", () => {
  const program = setter(perUserTemplate);
  const result = model(program, { path: `${"x".repeat(30)}😀tail` });
  const copied = result.registers["0"];
  assert.equal(copied.length, 31);
  assert.equal(copied.charCodeAt(30), 0xd83d, "The model counts UTF-16 units, not code points");
  assert.equal(result.sourceReads.length, 31);
  assert.throws(
    () =>
      model(
        program.map((line) => (line === copy ? fixedRead : line)),
        { registry: "skip" },
      ),
    /Unreviewed setter instruction/u,
  );
  assert.throws(
    () =>
      model(
        program.map((line) =>
          line === copy ? line.replace("i ${NSIS_MAX_STRLEN}", "i 2147483647") : line,
        ),
      ),
    /Unreviewed setter instruction/u,
  );
});

test("the project include and the three template inputs are pinned across the hosted build", () => {
  const runner = read("./smoke-windows-nsis-install.mjs");
  const build = runner.indexOf('await at("nsis-build",');
  assert.ok(build >= 0);
  const pin = runner.indexOf(
    "const nsisUninstallerInitIdentity = await plainFile(nsisUninstallerInit);",
  );
  assert.ok(pin >= 0 && pin < build);
  assert.ok(
    runner.indexOf(
      "assert.deepEqual(await plainFile(nsisUninstallerInit), nsisUninstallerInitIdentity);",
    ) > build,
  );
  assert.ok(runner.includes("...nsisUninstallerInitIdentity,"));
  for (const file of ["multiUser.nsh", "multiUserUi.nsh", "assistedInstaller.nsh"])
    assert.ok(runner.includes(`"templates/nsis/${file}"`));
  const vendorPin = runner.indexOf("perUserModeSourceSHA256: Object.fromEntries(");
  assert.ok(vendorPin >= 0 && vendorPin < build);
  assert.ok(runner.indexOf("report.toolchain.perUserModeSourceSHA256[file]") > build);
});
