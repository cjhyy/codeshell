import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { CloudAccountManager } from "./manager.js";
import { DEFAULT_CLOUD_ACCOUNT_ORIGIN } from "./types.js";
import { MemoryAccountStore, NativeAccountStore } from "./native-store.js";
import { acquireNativeAccountLock } from "./native-lock.js";
import {
  accountRegistrationUrl,
  readAccountFeatures,
  resolveAccountFeatures,
} from "@cjhyy/code-shell-web/account";

export const ACCOUNT_HELP = `Usage: account <login|status|features|links|logout|register> [options]
  --origin <https-origin>  Account service (default: ${DEFAULT_CLOUD_ACCOUNT_ORIGIN})
  --username <name>        Password login; password is prompted without echo
  --password-stdin         Read one password from stdin; never put it in arguments
  --github                 Sign in using GitHub in the browser
  --memory                 Keep an interactive account session in this process only
  --no-open                Print browser URLs instead of opening them

Credentials use the OS credential store; no plaintext fallback. Registration opens
<origin>/register. Local tasks and serve's Hub/passcode identity remain independent.
With --memory, login keeps an account console open: status, features, links, logout,
register, exit. Closing this console revokes its temporary login. No device relay
or upload is started. Use the same --origin on later account commands. Persistent
commands for one origin are serialized; finish an active login before retrying.`;

export interface AccountCliOptions {
  action: "login" | "status" | "features" | "links" | "logout" | "register";
  origin: string;
  username?: string;
  github: boolean;
  passwordStdin: boolean;
  memory: boolean;
  open: boolean;
}
export function parseAccountArgs(argv: string[]): AccountCliOptions {
  const [action, ...flags] = argv;
  if (!["login", "status", "features", "links", "logout", "register"].includes(action))
    throw new Error(ACCOUNT_HELP);
  const options: AccountCliOptions = {
    action: action as AccountCliOptions["action"],
    origin: DEFAULT_CLOUD_ACCOUNT_ORIGIN,
    github: false,
    passwordStdin: false,
    memory: false,
    open: true,
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--origin" || flag === "--username") {
      const value = flags[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--origin") options.origin = value;
      else options.username = value;
    } else if (flag === "--github") options.github = true;
    else if (flag === "--password-stdin") options.passwordStdin = true;
    else if (flag === "--memory") options.memory = true;
    else if (flag === "--no-open") options.open = false;
    else
      throw new Error(
        "Unknown account option. Passwords must use the hidden prompt or --password-stdin.",
      );
  }
  accountRegistrationUrl(options.origin);
  if (options.github && (options.username || options.passwordStdin))
    throw new Error("Choose GitHub or password login.");
  if (
    options.action !== "login" &&
    (options.github || options.username || options.passwordStdin || options.memory)
  )
    throw new Error("Login options require account login.");
  return options;
}
async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => reject(new Error("无法打开浏览器，请手动访问显示的地址。")));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("无法打开浏览器，请手动访问显示的地址。")),
    );
  });
}
async function question(label: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("Interactive login needs a terminal. Use --username and --password-stdin.");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(label);
    muted = secret;
    return await answer;
  } finally {
    rl.close();
    if (secret) process.stderr.write("\n");
  }
}
async function stdinPassword() {
  if (process.stdin.isTTY) throw new Error("--password-stdin expects piped input.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new Error("Password input exceeds its limit.");
    chunks.push(bytes);
  }
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (!password || /[\r\n]/.test(password))
    throw new Error("Provide exactly one password on stdin.");
  return password;
}
export interface AccountCliDependencies {
  createManager?: (
    options: AccountCliOptions,
    openExternal: (url: string) => Promise<void>,
  ) => CloudAccountManager;
  write?: (text: string) => void;
  open?: (url: string) => Promise<void>;
  prompt?: (label: string, secret?: boolean) => Promise<string>;
  readPassword?: () => Promise<string>;
  interactive?: boolean;
  acquireLock?: (origin: string) => Promise<() => Promise<void>>;
}
/** Shared entry for TUI and serve; it never changes Host/Hub authentication. */
export async function runAccountCli(
  argv: string[],
  deps: AccountCliDependencies = {},
): Promise<void> {
  const write = deps.write ?? ((text) => console.log(text));
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    write(ACCOUNT_HELP);
    return;
  }
  const options = parseAccountArgs(argv);
  const navigate = async (url: string) => {
    write(url);
    if (options.open) await (deps.open ?? openBrowser)(url);
  };
  if (options.memory && (!(deps.interactive ?? process.stdin.isTTY) || options.passwordStdin))
    throw new Error(
      "--memory requires an interactive terminal and keeps the session open. Use OS storage for one-shot stdin login.",
    );
  const release =
    options.memory || options.action === "register"
      ? undefined
      : await (deps.acquireLock ?? acquireNativeAccountLock)(options.origin);
  try {
    const manager =
      deps.createManager?.(options, navigate) ??
      new CloudAccountManager({
        store:
          options.memory || options.action === "register"
            ? new MemoryAccountStore()
            : new NativeAccountStore(options.origin),
        openExternal: navigate,
        changed() {},
      });
    const register = async () => {
      const capabilities = await manager.capabilities(options.origin);
      if (!capabilities.registrationAllowed) throw new Error("此账号服务暂未开放注册。");
      await navigate(accountRegistrationUrl(options.origin));
    };
    const prompt = deps.prompt ?? question;
    const display = async (action: "status" | "features" | "links") => {
      await manager.resume();
      const status = manager.status();
      if (action === "status") {
        write(JSON.stringify(status, null, 2));
        return;
      }
      const deployment = await manager.capabilities(options.origin);
      const overview =
        status.state === "signed-in" && status.account && status.origin === options.origin
          ? await manager.overview({ origin: options.origin, accountId: status.account.id })
          : undefined;
      const deploymentFeatures = readAccountFeatures(deployment);
      const features = resolveAccountFeatures({
        deployment: deploymentFeatures,
        account: status.state === "signed-in" ? readAccountFeatures(overview) : undefined,
        signedIn: status.state === "signed-in",
        // This CLI currently implements account-owned Link listing only.
        supported: deployment.linkManagementEnabled === true ? ["links.remote"] : [],
      });
      if (action === "links") {
        if (features["links.remote"].state !== "ready" || !status.account)
          throw new Error(
            `Account Link list is ${features["links.remote"].state}. Sign in to a service with Link management enabled.`,
          );
        write(
          JSON.stringify(
            await manager.manageLinks({
              action: "list",
              origin: options.origin,
              accountId: status.account.id,
            }),
            null,
            2,
          ),
        );
      } else write(JSON.stringify({ ...status, features }, null, 2));
    };
    try {
      if (options.action === "register") {
        await register();
        return;
      }
      if (options.action === "login") {
        if (options.github)
          await manager.signInWithGitHub({ origin: options.origin, connectGitHub: false });
        else
          await manager.signIn("login", {
            origin: options.origin,
            username: options.username ?? (await prompt("Username: ")),
            password: options.passwordStdin
              ? await (deps.readPassword ?? stdinPassword)()
              : await prompt("Password: ", true),
          });
        const signedIn = manager.status();
        write(JSON.stringify(signedIn, null, 2));
        if (signedIn.state !== "signed-in") return;
        try {
          await display("features");
        } catch {
          write("Signed in. Feature status could not be loaded; retry with account features.");
        }
        if (options.memory) {
          write(
            "Temporary account session active. Commands: status, features, links, logout, register, exit.",
          );
          while (true) {
            const command = (await prompt("account> ")).trim();
            if (command === "exit" || command === "logout") break;
            try {
              if (command === "status" || command === "features" || command === "links")
                await display(command);
              else if (command === "register") await register();
              else write("Commands: status, features, links, logout, register, exit");
            } catch {
              write("Account operation could not finish. Retry features, links, status, or exit.");
            }
          }
        }
      } else if (options.action === "logout") write(JSON.stringify(await manager.logout()));
      else await display(options.action);
    } finally {
      try {
        if (options.memory) await manager.logout();
      } finally {
        manager.dispose();
      }
    }
  } finally {
    await release?.();
  }
}
