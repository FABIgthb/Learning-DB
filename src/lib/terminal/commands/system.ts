/** Shell builtins and system info: clear, history, help, man, whoami, hostname, uname, env, export, unset, alias, which, type, source, bash, true/false, exit, editors. */

import { CLEAR_SCREEN, ansi } from "../ansi";
import { CommandError, type CommandSpec } from "../command";
import { parse } from "../parser";
import { shellQuote } from "./args";

/** Filled in by commands/index.ts to avoid an import cycle. */
export const registry: { commands: Record<string, CommandSpec> } = { commands: {} };

const clear: CommandSpec = {
  name: "clear",
  summary: "Clear the terminal screen (Ctrl-L does the same).",
  usage: "clear",
  run(ctx) {
    ctx.stdout(CLEAR_SCREEN);
    return 0;
  },
};

const history: CommandSpec = {
  name: "history",
  summary: "Display the command history list.",
  usage: "history [-c] [N]",
  builtin: true,
  run(ctx) {
    if (ctx.args[0] === "-c") {
      ctx.shell.history.length = 0;
      return 0;
    }
    const limit = ctx.args[0] !== undefined ? Number(ctx.args[0]) : Infinity;
    if (Number.isNaN(limit)) throw new CommandError(`${ctx.args[0]}: numeric argument required`);
    const entries = ctx.shell.history.map((cmd, i) => `${String(i + 1).padStart(5)}  ${cmd}`);
    const shown = limit === Infinity ? entries : entries.slice(-limit);
    if (shown.length) ctx.stdout(shown.join("\n") + "\n");
    return 0;
  },
};

const help: CommandSpec = {
  name: "help",
  summary: "List the commands available in this simulator.",
  usage: "help [COMMAND]",
  builtin: true,
  run(ctx) {
    const target = ctx.args[0];
    if (target) {
      const spec = registry.commands[target];
      if (!spec) throw new CommandError(`no help topics match '${target}'`);
      ctx.stdout(`${spec.usage}\n\n${spec.summary}\n`);
      return 0;
    }
    const seen = new Set<CommandSpec["run"]>();
    const rows = Object.values(registry.commands)
      .filter((spec) => {
        if (seen.has(spec.run)) return false;
        seen.add(spec.run);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const width = Math.max(...rows.map((r) => r.name.length)) + 2;
    const lines = rows.map((r) => (ctx.stdoutIsTTY ? ansi.bold(ansi.cyan(r.name.padEnd(width))) : r.name.padEnd(width)) + r.summary);
    ctx.stdout(
      [
        "Simulated GNU bash, version 5.2 — commands run against an in-browser file system.",
        "Tip: every command supports --help. Tab completes, ↑/↓ browse history, Ctrl-L clears, Ctrl-C cancels.",
        "",
        ...lines,
        "",
      ].join("\n"),
    );
    return 0;
  },
};

const man: CommandSpec = {
  name: "man",
  summary: "Show the manual for a command.",
  usage: "man COMMAND",
  run(ctx) {
    const target = ctx.args[ctx.args.length - 1];
    if (!target) throw new CommandError("What manual page do you want?\nFor example, try 'man man'.");
    const spec = registry.commands[target];
    if (!spec) throw new CommandError(`No manual entry for ${target}`, 16);
    const title = `${target.toUpperCase()}(1)`;
    ctx.stdout(
      [
        `${title.padEnd(30)}User Commands${title.padStart(30)}`,
        "",
        ctx.stdoutIsTTY ? ansi.bold("NAME") : "NAME",
        `       ${target} - ${spec.summary}`,
        "",
        ctx.stdoutIsTTY ? ansi.bold("SYNOPSIS") : "SYNOPSIS",
        ...spec.usage.split("\n").map((l) => `       ${l}`),
        "",
      ].join("\n"),
    );
    return 0;
  },
};

const whoami: CommandSpec = {
  name: "whoami",
  summary: "Print the current user name.",
  usage: "whoami",
  run(ctx) {
    ctx.stdout(`${ctx.shell.user}\n`);
    return 0;
  },
};

const hostname: CommandSpec = {
  name: "hostname",
  summary: "Show the system's host name.",
  usage: "hostname",
  run(ctx) {
    ctx.stdout(`${ctx.shell.hostname}\n`);
    return 0;
  },
};

const uname: CommandSpec = {
  name: "uname",
  summary: "Print system information.",
  usage: "uname [-a] [-s] [-r] [-m] [-n]",
  run(ctx) {
    const info = { s: "Linux", n: ctx.shell.hostname, r: "6.8.0-learn", v: "#1 SMP PREEMPT_DYNAMIC", m: "x86_64", o: "GNU/Linux" };
    const flags = ctx.args.join("").replace(/-/g, "");
    if (flags.includes("a")) {
      ctx.stdout(`${info.s} ${info.n} ${info.r} ${info.v} ${info.m} ${info.o}\n`);
      return 0;
    }
    const keys = flags === "" ? ["s"] : [...flags];
    const parts = keys.map((k) => {
      if (!(k in info)) throw new CommandError(`invalid option -- '${k}'`);
      return info[k as keyof typeof info];
    });
    ctx.stdout(parts.join(" ") + "\n");
    return 0;
  },
};

const env: CommandSpec = {
  name: "env",
  summary: "Print the environment, or run a command in a modified environment.",
  usage: "env [NAME=VALUE]... [COMMAND [ARG]...]",
  async run(ctx) {
    const args = [...ctx.args];
    const overrides: [string, string][] = [];
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) {
      const assignment = args.shift() as string;
      const eq = assignment.indexOf("=");
      overrides.push([assignment.slice(0, eq), assignment.slice(eq + 1)]);
    }
    if (args.length === 0) {
      const vars = new Map(ctx.shell.vars);
      for (const [k, v] of overrides) vars.set(k, v);
      vars.set("PWD", ctx.shell.cwd);
      ctx.stdout([...vars.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
      return 0;
    }
    const saved = overrides.map(([k]) => [k, ctx.shell.vars.get(k)] as const);
    for (const [k, v] of overrides) ctx.shell.vars.set(k, v);
    try {
      return await ctx.shell.runArgv(args, { stdin: ctx.stdin, stdout: ctx.stdout, stderr: ctx.stderr, tty: ctx.stdoutIsTTY });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) ctx.shell.vars.delete(k);
        else ctx.shell.vars.set(k, v);
      }
    }
  },
};

const printenv: CommandSpec = {
  name: "printenv",
  summary: "Print all or part of the environment.",
  usage: "printenv [VARIABLE]...",
  run(ctx) {
    if (ctx.args.length === 0) {
      ctx.stdout([...ctx.shell.vars.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
      return 0;
    }
    let status = 0;
    for (const name of ctx.args) {
      const value = name === "PWD" ? ctx.shell.cwd : ctx.shell.vars.get(name);
      if (value === undefined) status = 1;
      else ctx.stdout(`${value}\n`);
    }
    return status;
  },
};

const exportCmd: CommandSpec = {
  name: "export",
  summary: "Set environment variables.",
  usage: "export [NAME[=VALUE]]...",
  builtin: true,
  run(ctx) {
    const args = ctx.args.filter((a) => a !== "-n" && a !== "-p");
    if (args.length === 0) {
      const lines = [...ctx.shell.vars.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `declare -x ${k}="${v.replace(/(["\\$`])/g, "\\$1")}"`);
      ctx.stdout(lines.join("\n") + "\n");
      return 0;
    }
    let status = 0;
    for (const arg of args) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        ctx.stderr(`bash: export: \`${arg}': not a valid identifier\n`);
        status = 1;
        continue;
      }
      if (eq !== -1) ctx.shell.vars.set(name, arg.slice(eq + 1));
      else if (!ctx.shell.vars.has(name)) ctx.shell.vars.set(name, "");
    }
    return status;
  },
};

const unset: CommandSpec = {
  name: "unset",
  summary: "Unset shell variables.",
  usage: "unset NAME...",
  builtin: true,
  run(ctx) {
    for (const name of ctx.args.filter((a) => !a.startsWith("-"))) ctx.shell.vars.delete(name);
    return 0;
  },
};

const alias: CommandSpec = {
  name: "alias",
  summary: "Define or display aliases.",
  usage: "alias [NAME[=VALUE] ...]\n  e.g. alias ll='ls -alF'",
  builtin: true,
  run(ctx) {
    const format = (name: string, value: string) => `alias ${name}='${value.replace(/'/g, "'\\''")}'`;
    if (ctx.args.length === 0 || (ctx.args.length === 1 && ctx.args[0] === "-p")) {
      const lines = [...ctx.shell.aliases.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, v]) => format(n, v));
      if (lines.length) ctx.stdout(lines.join("\n") + "\n");
      return 0;
    }
    let status = 0;
    for (const arg of ctx.args) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        const value = ctx.shell.aliases.get(arg);
        if (value === undefined) {
          ctx.stderr(`bash: alias: ${arg}: not found\n`);
          status = 1;
        } else ctx.stdout(format(arg, value) + "\n");
        continue;
      }
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (!/^[A-Za-z0-9_.:-]+$/.test(name)) {
        ctx.stderr(`bash: alias: \`${name}': invalid alias name\n`);
        status = 1;
        continue;
      }
      try {
        parse(value);
      } catch (error) {
        ctx.stderr(`bash: alias: ${name}: ${(error as Error).message}\n`);
        status = 1;
        continue;
      }
      ctx.shell.aliases.set(name, value);
    }
    return status;
  },
};

const unalias: CommandSpec = {
  name: "unalias",
  summary: "Remove alias definitions.",
  usage: "unalias [-a] NAME...",
  builtin: true,
  run(ctx) {
    if (ctx.args.includes("-a")) {
      ctx.shell.aliases.clear();
      return 0;
    }
    let status = 0;
    for (const name of ctx.args) {
      if (!ctx.shell.aliases.delete(name)) {
        ctx.stderr(`bash: unalias: ${name}: not found\n`);
        status = 1;
      }
    }
    return status;
  },
};

const BUILTIN_NAMES = new Set(["cd", "pwd", "echo", "printf", "export", "unset", "alias", "unalias", "history", "help", "type", "source", ".", "true", "false", "exit"]);

const which: CommandSpec = {
  name: "which",
  summary: "Locate a command.",
  usage: "which [-a] COMMAND...",
  run(ctx) {
    let status = 0;
    for (const name of ctx.args.filter((a) => !a.startsWith("-"))) {
      if (registry.commands[name] && !BUILTIN_NAMES.has(name)) ctx.stdout(`/usr/bin/${name}\n`);
      else status = 1;
    }
    return status;
  },
};

const type: CommandSpec = {
  name: "type",
  summary: "Describe how a name would be interpreted as a command.",
  usage: "type NAME...",
  builtin: true,
  run(ctx) {
    let status = 0;
    for (const name of ctx.args.filter((a) => !a.startsWith("-"))) {
      const aliasValue = ctx.shell.aliases.get(name);
      if (aliasValue !== undefined) ctx.stdout(`${name} is aliased to \`${aliasValue}'\n`);
      else if (BUILTIN_NAMES.has(name)) ctx.stdout(`${name} is a shell builtin\n`);
      else if (registry.commands[name]) ctx.stdout(`${name} is /usr/bin/${name}\n`);
      else {
        ctx.stderr(`bash: type: ${name}: not found\n`);
        status = 1;
      }
    }
    return status;
  },
};

const source: CommandSpec = {
  name: "source",
  summary: "Execute commands from a file in the current shell.",
  usage: "source FILE",
  builtin: true,
  async run(ctx) {
    const file = ctx.args[0];
    if (!file) throw new CommandError("filename argument required\nsource: usage: source filename [arguments]", 2);
    return ctx.shell.sourceFile(file, { stdin: ctx.stdin, stdout: ctx.stdout, stderr: ctx.stderr, tty: ctx.stdoutIsTTY });
  },
};

const bash: CommandSpec = {
  name: "bash",
  summary: "Run a script file or a command string (-c).",
  usage: "bash SCRIPT [ARGS...]\nbash -c 'COMMAND'",
  async run(ctx) {
    if (ctx.args.length === 0) throw new CommandError("nested interactive shells are not supported in the simulator — run a script (bash script.sh) or bash -c 'cmd'");
    if (ctx.args[0] === "-c") {
      const command = ctx.args[1];
      if (command === undefined) throw new CommandError("-c: option requires an argument", 2);
      const result = await ctx.shell.capture(command, ctx.stdin);
      ctx.stdout(result.stdout);
      ctx.stderr(result.stderr);
      return result.exitCode;
    }
    const [script, ...rest] = ctx.args;
    const scriptPath = script.includes("/") ? script : `./${script}`;
    const line = [scriptPath, ...rest].map(shellQuote).join(" ");
    const node = ctx.shell.fs.get(ctx.shell.resolve(script));
    if (!node) throw new CommandError(`${script}: No such file or directory`, 127);
    if (node.type === "dir") throw new CommandError(`${script}: Is a directory`, 126);
    // Scripts invoked through bash don't need the executable bit.
    const wasExecutable = node.executable;
    node.executable = true;
    try {
      const result = await ctx.shell.capture(line, ctx.stdin);
      ctx.stdout(result.stdout);
      ctx.stderr(result.stderr);
      return result.exitCode;
    } finally {
      node.executable = wasExecutable;
    }
  },
};

const trueCmd: CommandSpec = { name: "true", summary: "Do nothing, successfully.", usage: "true", builtin: true, run: () => 0 };
const falseCmd: CommandSpec = { name: "false", summary: "Do nothing, unsuccessfully.", usage: "false", builtin: true, run: () => 1 };

const exit: CommandSpec = {
  name: "exit",
  summary: "The simulator session is persistent; use the reset button to start over.",
  usage: "exit [N]",
  builtin: true,
  run(ctx) {
    ctx.stderr("exit: this terminal is part of the lesson and stays open — use the ↺ reset button to start fresh.\n");
    return ctx.args[0] !== undefined ? Number(ctx.args[0]) || 0 : 0;
  },
};

const editor = (name: string): CommandSpec => ({
  name,
  summary: `${name} is not available in the simulator.`,
  usage: `${name} FILE`,
  run(ctx) {
    ctx.stderr(`${name}: interactive editors are not available in the simulator.\n  Create or edit files with redirection instead, e.g.:\n    echo 'hello' > notes.txt      # overwrite\n    echo 'more' >> notes.txt      # append\n    printf 'a\\nb\\n' > list.txt   # multiple lines\n`);
    return 1;
  },
});

const sleep: CommandSpec = {
  name: "sleep",
  summary: "Delay for a specified amount of time (instant in the simulator).",
  usage: "sleep NUMBER[SUFFIX]",
  run(ctx) {
    if (ctx.args.length === 0) throw new CommandError("missing operand");
    if (!ctx.args.every((a) => /^\d+(\.\d+)?[smhd]?$/.test(a))) throw new CommandError(`invalid time interval '${ctx.args[0]}'`);
    return 0;
  },
};

export const SYSTEM_COMMANDS: CommandSpec[] = [
  clear,
  history,
  help,
  man,
  whoami,
  hostname,
  uname,
  env,
  printenv,
  exportCmd,
  unset,
  alias,
  unalias,
  which,
  type,
  source,
  { ...source, name: "." },
  bash,
  { ...bash, name: "sh" },
  trueCmd,
  falseCmd,
  exit,
  editor("vim"),
  editor("vi"),
  editor("nano"),
  editor("emacs"),
  sleep,
];
