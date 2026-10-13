import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { compilePosixPluginHookCommand, preparePluginHookInvocation } from "./pluginHookCommand.js";
import { runPluginCommandHook } from "./pluginCommandHook.js";

const names = ["CODESHELL_PLUGIN_ROOT", "PLUGIN_ROOT", "CODESHELL_PLUGIN_DATA", "PLUGIN_DATA"];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const temp = mkdtempSync(join(tmpdir(), "plugin-hook-template-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("approved plugin path template compiler", () => {
  test("keeps unrelated complex shell commands byte-for-byte", () => {
    for (const command of [
      "cat <<'EOF'\nunknown $VALUE `date`\nEOF",
      "echo \"${x:-'a b'}\" $(printf x) `printf y`",
      "printf '%s' '$PLUGIN_ROOT_SUFFIX ${OTHER}'",
      "case x in x) printf x;; esac",
      "sh '-c' 'literal' # ${PLUGIN_ROOT}",
      "eval \\${PLUGIN_ROOT}",
      "sh -c 'echo ok' \\${PLUGIN_ROOT}",
      "node -e '$${PLUGIN_ROOT}'",
    ])
      expect(compilePosixPluginHookCommand(command)).toBe(command);
  });

  test("renders only fixed environment references in each POSIX quoting context", () => {
    for (const name of names) {
      expect(compilePosixPluginHookCommand(`'$` + `{${name}}/hook' arg`)).toBe(
        `''"$` + `{${name}}"'/hook' arg`,
      );
      expect(compilePosixPluginHookCommand(`$${name}/hook`)).toBe(`"$` + `{${name}}"/hook`);
      expect(compilePosixPluginHookCommand(`"$` + `{${name}}/hook"`)).toBe(
        `"$` + `{${name}}/hook"`,
      );
    }
  });

  test("preserves escapes, literal dollars, comments and unknown parameter quotes", () => {
    const command =
      "printf '%s' \\${PLUGIN_ROOT} $$PLUGIN_ROOT $${PLUGIN_ROOT} \"${x:-'a b'}\" '${PLUGIN_DATA}' # $PLUGIN_ROOT\n";
    expect(compilePosixPluginHookCommand(command)).toBe(
      "printf '%s' \\${PLUGIN_ROOT} $$PLUGIN_ROOT $${PLUGIN_ROOT} \"${x:-'a b'}\" ''\"${PLUGIN_DATA}\"'' # $PLUGIN_ROOT\n",
    );
  });

  test("tracks command substitution's independent quotes", () => {
    expect(compilePosixPluginHookCommand("printf \"%s\" \"$(printf '%s' '${PLUGIN_ROOT}')\"")).toBe(
      "printf \"%s\" \"$(printf '%s' ''\"${PLUGIN_ROOT}\"'')\"",
    );
  });

  test("refuses target templates in contexts whose expansion cannot be proved", () => {
    for (const command of [
      "cat <<EOF\n${PLUGIN_ROOT}\nEOF",
      "cat <<'EOF'\n${PLUGIN_ROOT}\nEOF",
      "echo `printf '${PLUGIN_ROOT}'`",
      "echo ${x:-'${PLUGIN_ROOT}'}",
      "printf '%s' ${x:-$(printf })} '${PLUGIN_ROOT}'",
      "echo $((1 + ${PLUGIN_DATA}))",
      "echo $'${PLUGIN_ROOT}'",
      "echo $(case x in x) printf '${PLUGIN_ROOT}';; esac)",
      "echo '${PLUGIN_ROOT}",
      "node -e 'console.log(\"${PLUGIN_ROOT}\")'",
      "sh -c '${PLUGIN_ROOT}/hook'",
      "sh '-c' '${PLUGIN_ROOT}/hook'",
      'sh "-""c" \'${PLUGIN_ROOT}/hook\'',
      "'eval' '${PLUGIN_ROOT}/hook'",
      "e\\val '${PLUGIN_ROOT}/hook'",
      "node '-e' '${PLUGIN_ROOT}/hook'",
      "command /bin/sh '-c' '${PLUGIN_ROOT}/hook'",
      "sh $FLAGS '${PLUGIN_ROOT}/hook'",
      "bash $FLAGS '${PLUGIN_ROOT}/hook'",
      "dash $FLAGS '${PLUGIN_ROOT}/hook'",
      "node $FLAGS '${PLUGIN_ROOT}/hook'",
      "sh -ec '${PLUGIN_ROOT}/hook'",
      "bash -lc '${PLUGIN_ROOT}/hook'",
      "node -pe '${PLUGIN_ROOT}/hook'",
      "sh \"${FLAGS:-'-c'}\" '${PLUGIN_ROOT}/hook'",
      "$EXECUTABLE '${PLUGIN_ROOT}/hook'",
      "command $EXECUTABLE '${PLUGIN_ROOT}/hook'",
      "if true; then $EXECUTABLE '${PLUGIN_ROOT}/hook'; fi",
      "invoke() { $EXECUTABLE; }; invoke '${PLUGIN_ROOT}/hook'",
      "builtin $EXECUTABLE '${PLUGIN_ROOT}/hook'",
      "printf '%s' 'prefix${PLUGIN_ROOT}'",
      "printf '%s' '${PLUGIN_ROOT}'suffix",
    ])
      expect(() => compilePosixPluginHookCommand(command)).toThrow("unsupported");
  });
});

describe("Windows standalone approved path invocation (pure source contract)", () => {
  const env = {
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    NATIVE: "native unit value",
  };
  const paths = {
    root: "C:\\插件 空格 apostrophe' %NAME% !bang! &stuff $(code)",
    data: "C:\\data % ! &",
  };
  test("supports each alias and quoted/bare executable without inserting path source", () => {
    for (const name of names)
      for (const delimiter of ["'", '"', ""]) {
        const command = `${delimiter}$` + `{${name}}/hook.cmd${delimiter}  session-start %NATIVE%`;
        const out = preparePluginHookInvocation(command, paths, "win32", env);
        expect(out.file).toBe(env.ComSpec);
        expect(out.shell).toBe(false);
        expect(out.windowsVerbatimArguments).toBe(true);
        expect(out.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
        expect(out.args[4]).toBe('""%CODESHELL_PLUGIN_HOOK_PATH_0%"  session-start %NATIVE%"');
        expect(out.environment.CODESHELL_PLUGIN_HOOK_PATH_0).toBe(
          win32.normalize((name.endsWith("ROOT") ? paths.root : paths.data) + "/hook.cmd"),
        );
        expect(out.args.join(" ")).not.toContain(paths.root);
      }
  });
  test("keeps legacy native expansion/custom ComSpec commands untouched", () => {
    const command = '"%PLUGIN_ROOT%\\hook.cmd" %NATIVE%';
    expect(preparePluginHookInvocation(command, paths, "win32", { ComSpec: "custom.exe" })).toEqual(
      { file: command, args: [], shell: true, environment: {} },
    );
  });
  test("refuses occupied namespaces, untrusted ComSpec, re-parsing and invalid paths", () => {
    const command = "'${PLUGIN_ROOT}/hook.cmd' session-start";
    for (const badEnv of [
      { ...env, ComSpec: "C:\\evil\\cmd.exe" },
      { ...env, codeshell_plugin_hook_path_0: "author-owned" },
      { ...env, COMSPEC: env.ComSpec },
      { ...env, SystemRoot: "\\\\server\\Windows" },
    ])
      expect(() => preparePluginHookInvocation(command, paths, "win32", badEnv)).toThrow();
    for (const tail of [
      " & echo injected",
      " | echo injected",
      " call foo",
      " for foo",
      " %CODESHELL_PLUGIN_HOOK_PATH_1%",
    ])
      expect(() => preparePluginHookInvocation(command + tail, paths, "win32", env)).toThrow();
    for (const root of ['C:\\bad"quote', "C:\\bad\nnewline"])
      expect(() =>
        preparePluginHookInvocation(command, { ...paths, root }, "win32", env),
      ).toThrow();
    expect(() =>
      preparePluginHookInvocation(
        command + " '${PLUGIN_DATA}'",
        { ...paths, data: "C:\\trailing\\" },
        "win32",
        env,
      ),
    ).toThrow("trailing-backslash");
    expect(() =>
      preparePluginHookInvocation(
        command,
        { ...paths, root: "C:\\" + "x".repeat(8200) },
        "win32",
        env,
      ),
    ).toThrow("length");
    expect(() =>
      preparePluginHookInvocation(command + " %NATIVE%", paths, "win32", {
        ...env,
        NATIVE: "x".repeat(8200),
      }),
    ).toThrow("length");
    for (const tail of [" %UNAVAILABLE%", " %NATIVE:~0,1%", " %CD%", " %UNPAIRED", " %%"])
      expect(() => preparePluginHookInvocation(command + tail, paths, "win32", env)).toThrow(
        "percent expansion",
      );
  });
});

if (process.platform !== "win32")
  describe("real POSIX hook path execution stays data", () => {
    const marker = join(temp, "injected-dollar");
    const backtickMarker = join(temp, "injected-backtick");
    const root = join(
      temp,
      `插件 空格 apostrophe' double" $(touch ${marker}) \`touch ${backtickMarker}\` %!&`,
    );
    const data = join(temp, `data 空格 ' " $(touch ${marker}) \`touch ${backtickMarker}\` %!&`);
    for (const directory of [root, data]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "probe.cjs"),
        "process.stdout.write(JSON.stringify({additionalContext:JSON.stringify({root:process.env.CODESHELL_PLUGIN_ROOT,data:process.env.CODESHELL_PLUGIN_DATA,arg:process.argv[2]})}))",
      );
      const executable = join(directory, "probe.sh");
      writeFileSync(
        executable,
        `#!/bin/sh\nexec ${quote(process.execPath)} "\${0%/*}/probe.cjs" "$@"\n`,
      );
      chmodSync(executable, 0o755);
    }
    test("quoted/escaped source interpreters refuse hostile path before native execution", async () => {
      for (const interpreter of [
        "sh '-c'",
        'sh "-""c"',
        "'eval'",
        "e\\val",
        "node '-e'",
        "command /bin/sh '-c'",
        "sh $FLAGS",
        "bash -lc",
        "node -pe",
      ]) {
        const result = await runPluginCommandHook(
          {
            command: `${interpreter} '\${PLUGIN_ROOT}/probe.sh'`,
            installPath: root,
            dataPath: data,
            pluginKey: "template-reparse@unit",
          },
          { eventName: "on_session_start", data: { source: "startup" } },
        );
        expect(result).toEqual({});
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(backtickMarker)).toBe(false);
      }
    });
    for (const name of names)
      for (const delimiter of ["'", '"', ""]) {
        test.skipIf(process.platform === "win32")(
          `${name} ${delimiter || "bare"} preserves hostile real path`,
          async () => {
            const command =
              `${delimiter}$` +
              `{${name}}/probe.sh${delimiter} ` +
              `${delimiter}$` +
              `{PLUGIN_DATA}${delimiter}`;
            const result = await runPluginCommandHook(
              { command, installPath: root, dataPath: data, pluginKey: "template-path@unit" },
              { eventName: "on_session_start", data: { source: "startup" } },
            );
            expect(result.messages).toEqual([JSON.stringify({ root, data, arg: data })]);
            expect(existsSync(marker)).toBe(false);
            expect(existsSync(backtickMarker)).toBe(false);
          },
        );
      }
  });

if (process.platform === "win32")
  describe("real Windows cmd standalone path execution", () => {
    const root = join(temp, "Windows 插件 空格 apostrophe' %PATH% !bang! &stuff $(data)");
    const data = join(temp, "Windows data %USERPROFILE% !bang! &stuff");
    mkdirSync(root, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(root, "probe.cjs"),
      "process.stdout.write(JSON.stringify({additionalContext:JSON.stringify({root:process.env.CODESHELL_PLUGIN_ROOT,data:process.env.CODESHELL_PLUGIN_DATA,arg:process.argv[2]})}))",
    );
    writeFileSync(
      join(root, "probe.cmd"),
      '@echo off\r\n"%CODESHELL_PLUGIN_TEST_NODE%" "%~dp0probe.cjs" %*\r\n',
    );
    test("native cmd preserves percent/bang/ampersand path data with delayed expansion off", async () => {
      const previous = process.env.CODESHELL_PLUGIN_TEST_NODE;
      process.env.CODESHELL_PLUGIN_TEST_NODE = process.execPath;
      try {
        const result = await runPluginCommandHook(
          {
            command: "'${PLUGIN_ROOT}/probe.cmd' '${PLUGIN_DATA}'",
            installPath: root,
            dataPath: data,
            pluginKey: "windows-template@unit",
          },
          { eventName: "on_session_start", data: { source: "startup" } },
        );
        expect(result.messages).toEqual([JSON.stringify({ root, data, arg: data })]);
      } finally {
        if (previous === undefined) delete process.env.CODESHELL_PLUGIN_TEST_NODE;
        else process.env.CODESHELL_PLUGIN_TEST_NODE = previous;
      }
    });
  });
