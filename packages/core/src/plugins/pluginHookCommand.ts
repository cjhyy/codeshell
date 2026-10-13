/**
 * Compile approved plugin path templates without putting filesystem paths in
 * shell source. Paths remain environment data, including quotes and `$()`.
 * This is a deliberately bounded template compiler, not a shell parser.
 */
import { win32 } from "node:path";

const NAMES = "CODESHELL_PLUGIN_ROOT|CODESHELL_PLUGIN_DATA|PLUGIN_ROOT|PLUGIN_DATA";
const MACRO = new RegExp(`^\\$(?:\\{(${NAMES})\\}|(${NAMES})(?![A-Za-z0-9_]))`);
const HAS_MACRO = new RegExp(`\\$(?:\\{(?:${NAMES})\\}|(?:${NAMES})(?![A-Za-z0-9_]))`);

export interface PluginHookInvocation {
  file: string;
  args: string[];
  shell: boolean;
  windowsVerbatimArguments?: boolean;
  environment: Record<string, string>;
}

function unsupported(context: string): never {
  throw new Error(`Plugin root/data placeholder is unsupported in ${context}`);
}

function macroAt(command: string, at: number): { text: string; name: string } | undefined {
  const match = MACRO.exec(command.slice(at));
  return match ? { text: match[0], name: match[1] ?? match[2] } : undefined;
}

/** Escaped dollars and comments alone do not opt a legacy command into templates. */
function hasActivePosixTemplate(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") i++;
    else if (!quote && char === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      if (end === -1) return false;
      i = end;
    } else if (command.startsWith("$$", i)) i++;
    else if (macroAt(command, i)) return true;
    else if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char;
    }
  }
  return false;
}

/** Unknown parameter expressions are opaque; their quotes are not outer quotes. */
function parameterEnd(command: string, start: number): number {
  let depth = 1;
  let quote = "";
  for (let i = start + 2; i < command.length; i++) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      i++;
    } else if (
      quote !== "'" &&
      (command.startsWith("$(", i) || char === "`" || command.startsWith("$'", i))
    ) {
      unsupported("command substitution or ANSI-C quoting inside an unknown parameter expansion");
    } else if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char;
    } else if (!quote && command.startsWith("${", i)) {
      depth++;
      i++;
    } else if (!quote && char === "}" && --depth === 0) {
      return i + 1;
    }
  }
  return unsupported("an unterminated parameter expansion");
}

export function compilePosixPluginHookCommand(command: string): string {
  if (!HAS_MACRO.test(command) || !hasActivePosixTemplate(command)) return command;
  let out = "";
  type Quote = "" | "'" | '"';
  type Word = { literal: string; dynamic: boolean; template: boolean };
  const emptyWord = (): Word => ({ literal: "", dynamic: false, template: false });
  let word = emptyWord();
  let words: Word[] = [];
  const finishWord = () => {
    if (word.literal || word.dynamic || word.template) {
      // Compare quote/escape-decoded literal words: '-c', -""c, e\\val, etc.
      if (!word.dynamic && /^(?:eval|source|\.|-c|-e|--eval|--command)$/.test(word.literal)) {
        unsupported("a command that re-interprets path arguments as source");
      }
      if (
        !word.dynamic &&
        /^(?:if|then|elif|else|fi|while|until|do|done|for|select|in|case|esac|function|\{|\}|!)$/.test(
          word.literal,
        )
      ) {
        unsupported("shell control-flow or function syntax");
      }
      words.push(word);
    }
    word = emptyWord();
  };
  const finishCommand = () => {
    finishWord();
    const executable = words.find((item) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item.literal));
    if (executable?.dynamic && !executable.template) unsupported("a dynamic executable word");
    const interpreterIndex = words.findIndex(
      (item) =>
        !item.dynamic &&
        /(?:^|\/)(?:sh|bash|dash|ksh|zsh|ash|fish|csh|tcsh|node|python(?:\d+(?:\.\d+)?)?|perl|ruby|pwsh|powershell)(?:\.exe)?$/i.test(
          item.literal,
        ),
    );
    const wrapper = executable && /^(?:command|exec|env|builtin|time)$/.test(executable.literal);
    if (
      (interpreterIndex !== -1 || wrapper) &&
      words.some((item) => item.dynamic && !item.template)
    ) {
      unsupported("dynamic interpreter or command-wrapper arguments");
    }
    if (interpreterIndex !== -1) {
      const argumentsBeforeScript = words.slice(interpreterIndex + 1);
      const templateIndex = argumentsBeforeScript.findIndex((item) => item.template);
      const flags =
        templateIndex === -1
          ? argumentsBeforeScript
          : argumentsBeforeScript.slice(0, templateIndex);
      if (flags.some((item) => item.literal.startsWith("-") && item.literal !== "--")) {
        // Shells accept -ec/-lc; Node accepts -pe. A list of only exact -c/-e
        // words cannot establish that a rooted argument will be a script file.
        unsupported("interpreter flags before a template script path");
      }
    }
    words = [];
  };
  let quote: Quote = "";
  let wordStart = 0;
  const substitutions: {
    quote: Quote;
    parentheses: number;
    wordStart: number;
    word: Word;
    words: Word[];
  }[] = [];
  for (let i = 0; i < command.length; ) {
    const char = command[i];
    if (char === "\\" && quote !== "'") {
      out += command.slice(i, i + 2);
      const next = command[i + 1] ?? "";
      if (quote === '"' && !/[$`"\\\n]/.test(next)) word.literal += "\\";
      if (next !== "\n") word.literal += next;
      i += 2;
      continue;
    }
    if (!quote && char === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
      const end = command.indexOf("\n", i);
      out += command.slice(i, end === -1 ? command.length : end);
      i = end === -1 ? command.length : end;
      continue;
    }
    if ((quote !== "'" && char === "`") || (!quote && command.startsWith("<<", i))) {
      unsupported(char === "`" ? "backtick substitution" : "a here-document or here-string");
    }
    if (!quote && command.startsWith("$'", i)) unsupported("ANSI-C quoting");
    if (command.startsWith("$$", i)) {
      out += "$$";
      if (quote === "'") word.literal += "$$";
      else word.dynamic = true;
      i += 2;
      continue;
    }
    const macro = macroAt(command, i);
    if (macro) {
      word.template = true;
      // Only complete rooted path words are new host templates. In particular,
      // a placeholder embedded in `node -e`/JSON/program text is not path data.
      const prefix = command.slice(wordStart, i);
      if (prefix !== "" && prefix !== quote)
        unsupported("a template that is not a complete path word");
      const suffixStart = i + macro.text.length;
      if (
        command[suffixStart] &&
        command[suffixStart] !== "/" &&
        command[suffixStart] !== quote &&
        !/[\s;&|()<>]/.test(command[suffixStart])
      ) {
        unsupported("a template that is not a rooted path word");
      }
      if (quote) {
        let end = suffixStart;
        for (; end < command.length; end++) {
          if (quote === '"' && command[end] === "\\") end++;
          else if (command[end] === quote) break;
        }
        if (end === command.length || (command[end + 1] && !/[\s;&|()<>]/.test(command[end + 1]))) {
          unsupported("compound path-word quoting");
        }
      }
      const parameter = `\${${macro.name}}`;
      out += quote === "'" ? `'"${parameter}"'` : quote === '"' ? parameter : `"${parameter}"`;
      i += macro.text.length;
      continue;
    }
    if (quote !== "'" && command.startsWith("${", i)) {
      const end = parameterEnd(command, i);
      const expression = command.slice(i, end);
      if (HAS_MACRO.test(expression)) unsupported("a nested parameter expansion");
      word.dynamic = true;
      out += expression;
      i = end;
      continue;
    }
    if (quote !== "'" && command.startsWith("$(", i)) {
      if (command.startsWith("$((", i)) unsupported("arithmetic expansion");
      word.dynamic = true;
      substitutions.push({ quote, parentheses: 1, wordStart, word, words });
      word = emptyWord();
      words = [];
      quote = "";
      wordStart = i + 2;
      out += "$(";
      i += 2;
      continue;
    }
    if (!quote && substitutions.length) {
      if (/^case(?:\s|$)/.test(command.slice(i)) && (i === 0 || /[\s;&|()]/.test(command[i - 1]))) {
        unsupported("case syntax inside command substitution");
      }
      const frame = substitutions[substitutions.length - 1];
      if (char === "(") frame.parentheses++;
      if (char === ")" && --frame.parentheses === 0) {
        finishCommand();
        quote = frame.quote;
        wordStart = frame.wordStart;
        word = frame.word;
        words = frame.words;
        substitutions.pop();
        out += char;
        i++;
        continue;
      }
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char;
    } else if (!quote && /[\s;&|()<>]/.test(char)) {
      if (/[\n;&|()<>]/.test(char)) finishCommand();
      else finishWord();
    } else if (quote !== "'" && char === "$" && /[A-Za-z0-9_@*#?$!-]/.test(command[i + 1] ?? "")) {
      word.dynamic = true;
    } else {
      word.literal += char;
    }
    if (!quote && /[\s;&|()<>]/.test(char)) wordStart = i + 1;
    out += char;
    i++;
  }
  if (quote || substitutions.length) unsupported("unclosed shell syntax");
  finishCommand();
  return out;
}

function windowsCommand(
  command: string,
  paths: { root: string; data: string },
  env: NodeJS.ProcessEnv,
): PluginHookInvocation {
  const environment: Record<string, string> = {};
  // New `$` template syntax is supported only in a simple invocation with
  // complete path words. Native cmd programs without these templates bypass us.
  if (/CODESHELL_PLUGIN_HOOK_PATH_/i.test(command))
    unsupported("an occupied Windows template namespace");
  const words = [...command.matchAll(/'[^']*'|"[^"]*"|[^\s]+/g)];
  if (!words.length) unsupported("an empty Windows invocation");
  let replaced = 0;
  let previousEnd = 0;
  const compiled = words.map((match, index) => {
    const word = match[0];
    const before = command.slice(previousEnd, match.index);
    previousEnd = match.index + word.length;
    const quote = word[0] === "'" || word[0] === '"' ? word[0] : "";
    const text = quote ? word.slice(1, -1) : word;
    if (
      quote &&
      (word[word.length - 1] !== quote ||
        (command[previousEnd] && !/\s/.test(command[previousEnd])))
    ) {
      unsupported("compound Windows quoting");
    }
    if (!HAS_MACRO.test(text)) {
      if (
        (quote !== '"' && /[&|<>^()\r\n]/.test(text)) ||
        /^(?:call|for|cmd(?:\.exe)?)$/i.test(text)
      ) {
        unsupported("Windows shell operators or command re-parsing");
      }
      return before + word;
    }
    const macro = macroAt(text, 0);
    if (
      !macro ||
      (text.length > macro.text.length && !/^[\\/]/.test(text.slice(macro.text.length)))
    ) {
      unsupported("a Windows path template that is not a complete rooted word");
    }
    const suffix = text.slice(macro.text.length);
    if (HAS_MACRO.test(suffix)) unsupported("multiple Windows placeholders in one word");
    const value = win32.normalize((macro.name.endsWith("ROOT") ? paths.root : paths.data) + suffix);
    if (/[\x00-\x1f"]/.test(value) || value.endsWith("\\"))
      unsupported("an invalid or trailing-backslash Win32 path argument");
    const name = `CODESHELL_PLUGIN_HOOK_PATH_${index}`;
    if (Object.keys(env).some((key) => key.toUpperCase() === name)) {
      unsupported("an occupied Windows template namespace");
    }
    environment[name] = value;
    replaced++;
    return before + `"%${name}%"`;
  });
  if (!replaced) unsupported("a Windows command without a complete path template");
  if (!macroAt(words[0][0].replace(/^['"]|['"]$/g, ""), 0)) {
    unsupported("a Windows invocation whose executable is not a rooted path template");
  }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (
    !systemRoot ||
    !/^[A-Za-z]:[\\/]/.test(systemRoot) ||
    !win32.isAbsolute(systemRoot) ||
    /[\x00-\x1f"%]/.test(systemRoot)
  ) {
    unsupported("an untrusted Windows SystemRoot");
  }
  const file = win32.join(systemRoot, "System32", "cmd.exe");
  const comspecKeys = Object.keys(env).filter((key) => key.toLowerCase() === "comspec");
  if (comspecKeys.length > 1) unsupported("duplicate case-insensitive ComSpec keys");
  const comspec = comspecKeys.length ? env[comspecKeys[0]] : undefined;
  if (comspec && win32.normalize(comspec).toLowerCase() !== file.toLowerCase()) {
    unsupported("a non-system ComSpec");
  }
  const shellCommand = compiled.join("") + command.slice(previousEnd);
  const expansionEnv = {
    ...env,
    CODESHELL_PLUGIN_ROOT: paths.root,
    PLUGIN_ROOT: paths.root,
    CODESHELL_PLUGIN_DATA: paths.data,
    PLUGIN_DATA: paths.data,
    ...environment,
  };
  // Bound a single cmd percent pass; never recursively expand a path slot's
  // returned value. Retain native %VAR% source exactly in the actual command.
  if (/%/.test(shellCommand.replace(/%[^%\r\n]+%/g, ""))) {
    unsupported("unbalanced native cmd percent expansion");
  }
  const expanded = shellCommand.replace(/%([^%\r\n]+)%/g, (literal, name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) unsupported("complex native cmd percent expansion");
    const values = Object.entries(expansionEnv)
      .filter(([key, value]) => key.toUpperCase() === name.toUpperCase() && value !== undefined)
      .map(([, value]) => value!);
    if (!values.length) unsupported("an unknown or dynamic native cmd percent expansion");
    return values.reduce(
      (longest, value) => (value.length > longest.length ? value : longest),
      literal,
    );
  });
  if (`"${file}" /d /v:off /s /c "${expanded}"`.length > 8191)
    unsupported("the cmd command-line length limit");
  return {
    file,
    args: ["/d", "/v:off", "/s", "/c", `"${shellCommand}"`],
    shell: false,
    windowsVerbatimArguments: true,
    environment,
  };
}

export function preparePluginHookInvocation(
  command: string,
  paths: { root: string; data: string },
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): PluginHookInvocation {
  if (!HAS_MACRO.test(command)) return { file: command, args: [], shell: true, environment: {} };
  if (platform === "win32") return windowsCommand(command, paths, env);
  return { file: compilePosixPluginHookCommand(command), args: [], shell: true, environment: {} };
}
