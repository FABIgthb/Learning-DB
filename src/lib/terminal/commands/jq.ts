/** jq command-line wrapper around the interpreter in ../jq.ts */

import { stripAnsi } from "../ansi";
import { CommandError, type CommandSpec } from "../command";
import { JqCompileError, JqError, compile, formatJson, parseJsonStream, toJqString, type Json } from "../jq";

const USAGE = [
  "Usage: jq [OPTIONS] FILTER [FILES...]",
  "",
  "  -r, --raw-output         output strings without quotes",
  "  -j, --join-output        like -r but without newlines between outputs",
  "  -c, --compact-output     compact instead of pretty-printed output",
  "  -n, --null-input         use `null` as the single input value",
  "  -s, --slurp              read all inputs into an array",
  "  -R, --raw-input          read each line as a string instead of JSON",
  "  -S, --sort-keys          sort keys of each object on output",
  "  -e, --exit-status        set exit status based on the last output",
  "  -C, --color-output / -M, --monochrome-output",
  "      --tab / --indent N   indentation",
  "      --arg NAME VALUE     set $NAME to the string VALUE",
  "      --argjson NAME JSON  set $NAME to the JSON value",
  "",
  "Examples:",
  "  jq '.name' package.json",
  "  jq -r '.items[] | select(.active) | .id' data.json",
  "  jq '[.users[] | {name, email}]' users.json",
].join("\n");

const jq: CommandSpec = {
  name: "jq",
  summary: "Command-line JSON processor.",
  usage: USAGE,
  run(ctx) {
    const flags = new Set<string>();
    const variables: Record<string, Json> = {};
    const positional: string[] = [];
    let indent = 2;
    const args = [...ctx.args];
    const shortMap: Record<string, string> = {
      r: "raw",
      j: "join",
      c: "compact",
      n: "null",
      s: "slurp",
      R: "rawInput",
      S: "sort",
      e: "exit",
      C: "color",
      M: "mono",
      a: "ascii",
    };
    const longMap: Record<string, string> = {
      "raw-output": "raw",
      "join-output": "join",
      "compact-output": "compact",
      "null-input": "null",
      slurp: "slurp",
      "raw-input": "rawInput",
      "sort-keys": "sort",
      "exit-status": "exit",
      "color-output": "color",
      "monochrome-output": "mono",
      "ascii-output": "ascii",
      tab: "tab",
      seq: "seq",
      "raw-output0": "raw0",
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg === "--arg" || arg === "--argjson") {
        const name = args[i + 1];
        const value = args[i + 2];
        if (name === undefined || value === undefined) throw new CommandError(`${arg} takes two parameters (e.g. ${arg} varname value)`, 2);
        if (arg === "--arg") variables[name] = value;
        else {
          try {
            variables[name] = JSON.parse(value) as Json;
          } catch {
            throw new CommandError(`Invalid JSON text passed to --argjson`, 2);
          }
        }
        i += 2;
        continue;
      }
      if (arg === "--indent") {
        const n = Number(args[i + 1]);
        if (!Number.isInteger(n) || n < 0 || n > 7) throw new CommandError("Cannot indent more than 7 characters", 2);
        indent = n;
        i += 1;
        continue;
      }
      if (arg.startsWith("--") && arg.length > 2) {
        const key = longMap[arg.slice(2)];
        if (!key) throw new CommandError(`Unknown option: ${arg}\n${USAGE}`, 2);
        flags.add(key);
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(arg)) {
        for (const ch of arg.slice(1)) {
          const key = shortMap[ch];
          if (!key) throw new CommandError(`Unknown option: -${ch}\n${USAGE}`, 2);
          flags.add(key);
        }
        continue;
      }
      positional.push(arg);
    }

    let filter = positional.shift();
    if (filter === undefined) {
      if (ctx.stdin === null) throw new CommandError(USAGE, 2);
      filter = ".";
    }

    let program;
    try {
      program = compile(filter, variables, Object.fromEntries(ctx.shell.vars));
    } catch (error) {
      if (error instanceof JqCompileError) {
        ctx.stderr(`jq: error: ${error.message}\njq: 1 compile error\n`);
        return 3;
      }
      throw error;
    }

    // Gather input text.
    const texts: { name: string; text: string }[] = [];
    if (positional.length === 0) {
      if (!flags.has("null")) {
        if (ctx.stdin === null) throw new CommandError("reading JSON from the terminal is not supported in the simulator — pass a file or pipe input (or use -n)", 2);
        texts.push({ name: "<stdin>", text: stripAnsi(ctx.stdin) });
      }
    } else {
      for (const file of positional) {
        const abs = ctx.shell.resolve(file);
        const node = ctx.shell.fs.get(abs);
        if (!node) {
          ctx.stderr(`jq: error: Could not open ${file}: No such file or directory\n`);
          return 2;
        }
        if (node.type === "dir") {
          ctx.stderr(`jq: error: Could not open ${file}: Is a directory\n`);
          return 2;
        }
        texts.push({ name: file, text: node.content });
      }
    }

    let inputs: Json[] = [];
    try {
      if (flags.has("rawInput")) {
        const joined = texts.map((t) => t.text).join("");
        inputs = flags.has("slurp") ? [joined] : joined.split("\n").filter((line, i, all) => !(i === all.length - 1 && line === ""));
      } else {
        for (const t of texts) inputs.push(...parseJsonStream(t.text));
        if (flags.has("slurp")) inputs = [inputs];
      }
    } catch (error) {
      if (error instanceof JqError) {
        ctx.stderr(`jq: error (at ${texts[0]?.name ?? "<stdin>"}:0): Cannot parse input: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    if (flags.has("null")) inputs = [null];

    const color = flags.has("color") || (ctx.stdoutIsTTY && !flags.has("mono"));
    const formatOptions = {
      indent,
      compact: flags.has("compact"),
      color,
      sortKeys: flags.has("sort"),
      tab: flags.has("tab"),
    };
    const raw = flags.has("raw") || flags.has("join") || flags.has("raw0");
    const separator = flags.has("join") ? "" : flags.has("raw0") ? "\0" : "\n";

    let last: Json | undefined;
    let status = 0;
    let produced = 0;
    for (const input of inputs) {
      try {
        for (const value of program.run(input)) {
          produced++;
          if (produced > 100_000) throw new JqError("too many outputs (the simulator caps jq at 100000 results)");
          last = value;
          let text = raw && typeof value === "string" ? value : formatJson(value, formatOptions);
          if (flags.has("ascii")) text = text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
          if (flags.has("seq")) text = "\x1e" + text;
          ctx.stdout(text + separator);
        }
      } catch (error) {
        if (error instanceof JqError) {
          const msg = typeof error.value === "string" ? error.value : `${toJqString(error.value)} (not a string)`;
          ctx.stderr(`jq: error (at ${texts[0]?.name ?? "<unknown>"}:${inputs.indexOf(input)}): ${msg}\n`);
          status = 5;
          continue;
        }
        if (error instanceof JqCompileError) {
          ctx.stderr(`jq: error: ${error.message}\njq: 1 compile error\n`);
          return 3;
        }
        throw error;
      }
    }
    if (status !== 0) return status;
    if (flags.has("exit")) {
      if (last === undefined) return 4;
      return last === null || last === false ? 1 : 0;
    }
    return 0;
  },
};

export const JQ_COMMANDS: CommandSpec[] = [jq];
