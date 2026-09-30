/** Text-processing commands: echo, printf, head, tail, wc, sort, uniq, grep, cut, tr, tee, seq, xargs, less/more. */

import { stripAnsi } from "../ansi";
import { CommandError, type CommandContext, type CommandSpec } from "../command";
import { FsError, relativePath } from "../filesystem";
import { parseCount, parseOptions, shellQuote, splitLines } from "./args";
import { readInputs } from "./files";

function interpretEscapes(text: string): { text: string; stop: boolean } {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\\" || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "e":
        out += "\x1b";
        break;
      case "v":
        out += "\v";
        break;
      case "f":
        out += "\f";
        break;
      case "\\":
        out += "\\";
        break;
      case "c":
        return { text: out, stop: true };
      case "0": {
        const m = /^[0-7]{0,3}/.exec(text.slice(i + 1)) as RegExpExecArray;
        out += String.fromCharCode(Number.parseInt(m[0] || "0", 8));
        i += m[0].length;
        break;
      }
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 1));
        if (m) {
          out += String.fromCharCode(Number.parseInt(m[0], 16));
          i += m[0].length;
        } else out += "\\x";
        break;
      }
      default:
        out += "\\" + next;
    }
  }
  return { text: out, stop: false };
}

const echo: CommandSpec = {
  name: "echo",
  summary: "Display a line of text.",
  usage: "echo [-neE] [STRING]...\n  -n  do not output the trailing newline\n  -e  enable interpretation of backslash escapes\n  -E  disable interpretation of backslash escapes (default)",
  builtin: true,
  literalHelp: true,
  run(ctx) {
    let newline = true;
    let escapes = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (!/^-[neE]+$/.test(arg)) break;
      for (const flag of arg.slice(1)) {
        if (flag === "n") newline = false;
        if (flag === "e") escapes = true;
        if (flag === "E") escapes = false;
      }
    }
    let text = ctx.args.slice(i).join(" ");
    if (escapes) {
      const result = interpretEscapes(text);
      text = result.text;
      if (result.stop) newline = false;
    }
    ctx.stdout(text + (newline ? "\n" : ""));
    return 0;
  },
};

const printf: CommandSpec = {
  name: "printf",
  summary: "Format and print data.",
  usage: "printf FORMAT [ARGUMENT]...\n  %s string, %d integer, %f float, %x hex, %% literal %, \\n newline, \\t tab",
  builtin: true,
  literalHelp: true,
  run(ctx) {
    if (ctx.args.length === 0) throw new CommandError("usage: printf format [arguments]", 2);
    const [format, ...rest] = ctx.args;
    const args = [...rest];
    let out = "";
    let status = 0;
    const once = (): boolean => {
      let consumed = false;
      const spec = /%([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifxXoceEgGb%])/g;
      let last = 0;
      let m: RegExpExecArray | null;
      let piece = "";
      while ((m = spec.exec(format)) !== null) {
        piece += interpretEscapes(format.slice(last, m.index)).text;
        last = spec.lastIndex;
        const [, flags, widthRaw, precision, conv] = m;
        if (conv === "%") {
          piece += "%";
          continue;
        }
        consumed = true;
        const width = widthRaw === "*" ? Number(args.shift() ?? 0) : Number(widthRaw ?? 0);
        const arg = args.shift() ?? "";
        let text: string;
        switch (conv) {
          case "s":
            text = precision !== undefined ? arg.slice(0, Number(precision)) : arg;
            break;
          case "b":
            text = interpretEscapes(arg).text;
            break;
          case "c":
            text = arg.charAt(0);
            break;
          case "d":
          case "i": {
            const n = arg === "" ? 0 : Number.parseInt(arg, 10);
            if (Number.isNaN(n)) {
              ctx.stderr(`printf: '${arg}': invalid number\n`);
              status = 1;
            }
            text = String(Number.isNaN(n) ? 0 : n);
            if (flags.includes("+") && n >= 0) text = "+" + text;
            break;
          }
          case "x":
          case "X":
          case "o": {
            const n = Number.parseInt(arg || "0", 10) || 0;
            text = n.toString(conv === "o" ? 8 : 16);
            if (conv === "X") text = text.toUpperCase();
            break;
          }
          default: {
            const n = Number(arg || 0);
            if (Number.isNaN(n)) {
              ctx.stderr(`printf: '${arg}': invalid number\n`);
              status = 1;
            }
            const p = precision !== undefined ? Number(precision) : 6;
            text = conv === "e" || conv === "E" ? (Number.isNaN(n) ? 0 : n).toExponential(p) : conv === "g" || conv === "G" ? String(Number((Number.isNaN(n) ? 0 : n).toPrecision(p || 1))) : (Number.isNaN(n) ? 0 : n).toFixed(p);
            if (conv === "E" || conv === "G") text = text.toUpperCase();
          }
        }
        if (text.length < width) {
          const padChar = flags.includes("0") && !flags.includes("-") && conv !== "s" ? "0" : " ";
          text = flags.includes("-") ? text.padEnd(width) : text.padStart(width, padChar);
        }
        piece += text;
      }
      piece += interpretEscapes(format.slice(last)).text;
      out += piece;
      return consumed;
    };
    const consumed = once();
    while (consumed && args.length > 0) once();
    ctx.stdout(out);
    return status;
  },
};

async function withInputs(ctx: CommandContext, files: string[], fn: (content: string, name: string) => void): Promise<number> {
  if (files.length === 0 && ctx.stdin === null) {
    throw new CommandError("reading from the terminal is not supported in the simulator — pass a file or pipe input");
  }
  return readInputs(ctx, files, fn);
}

function headTail(mode: "head" | "tail"): CommandSpec {
  return {
    name: mode,
    summary: mode === "head" ? "Output the first part of files." : "Output the last part of files.",
    usage:
      mode === "head"
        ? "head [OPTION]... [FILE]...\n  -n, --lines=[-]NUM  print the first NUM lines (default 10); with -NUM, all but the last NUM lines\n  -c, --bytes=NUM     print the first NUM bytes\n  -q                  never print headers"
        : "tail [OPTION]... [FILE]...\n  -n, --lines=[+]NUM  output the last NUM lines (default 10); +NUM starts at line NUM\n  -c, --bytes=NUM     output the last NUM bytes\n  -q                  never print headers",
    async run(ctx) {
      const opts = parseOptions(
        mode,
        ctx.args,
        [
          { key: "lines", short: "n", long: "lines", value: true },
          { key: "bytes", short: "c", long: "bytes", value: true },
          { key: "quiet", short: "q", long: ["quiet", "silent"] },
          { key: "verbose", short: "v", long: "verbose" },
          { key: "follow", short: "f", long: "follow" },
        ],
        { numericKey: "lines" },
      );
      if (opts.has("follow")) throw new CommandError("-f (follow) is not supported in the simulator");
      const rawLines = opts.get("lines") ?? "10";
      const rawBytes = opts.get("bytes");
      const fromStart = mode === "tail" && rawLines.startsWith("+");
      const allButLast = mode === "head" && rawLines.startsWith("-");
      const count = parseCount(mode, rawLines.replace(/^[+-]/, ""), 10);
      const byteCount = rawBytes !== undefined ? parseCount(mode, rawBytes, 0, "number of bytes") : null;
      const files = opts.positionals;
      const headers = (files.length > 1 && !opts.has("quiet")) || opts.has("verbose");
      let first = true;
      return withInputs(ctx, files, (content, name) => {
        if (headers) {
          ctx.stdout(`${first ? "" : "\n"}==> ${name === "-" ? "standard input" : name} <==\n`);
          first = false;
        }
        if (byteCount !== null) {
          ctx.stdout(mode === "head" ? content.slice(0, byteCount) : content.slice(Math.max(0, content.length - byteCount)));
          return;
        }
        const lines = splitLines(content);
        let selected: string[];
        if (mode === "head") selected = allButLast ? lines.slice(0, Math.max(0, lines.length - count)) : lines.slice(0, count);
        else selected = fromStart ? lines.slice(Math.max(0, count - 1)) : count === 0 ? [] : lines.slice(-count);
        if (selected.length === 0) return;
        const endsWithNewline = content.endsWith("\n");
        const lastIncluded = mode === "head" ? selected.length === lines.length : true;
        ctx.stdout(selected.join("\n") + (lastIncluded && !endsWithNewline ? "" : "\n"));
      });
    },
  };
}

const wc: CommandSpec = {
  name: "wc",
  summary: "Print newline, word, and byte counts for each file.",
  usage: "wc [OPTION]... [FILE]...\n  -l, --lines  print the newline counts\n  -w, --words  print the word counts\n  -c, --bytes  print the byte counts\n  -m, --chars  print the character counts",
  async run(ctx) {
    const opts = parseOptions("wc", ctx.args, [
      { key: "lines", short: "l", long: "lines" },
      { key: "words", short: "w", long: "words" },
      { key: "bytes", short: "c", long: "bytes" },
      { key: "chars", short: "m", long: "chars" },
    ]);
    const selected = ["lines", "words", "chars", "bytes"].filter((k) => opts.has(k));
    const columns = selected.length > 0 ? selected : ["lines", "words", "bytes"];
    const rows: { counts: number[]; name: string }[] = [];
    const status = await withInputs(ctx, opts.positionals, (content, name) => {
      const counts: Record<string, number> = {
        lines: (content.match(/\n/g) ?? []).length,
        words: content.split(/\s+/).filter(Boolean).length,
        chars: [...content].length,
        bytes: new TextEncoder().encode(content).length,
      };
      rows.push({ counts: columns.map((c) => counts[c]), name: name === "-" ? "" : name });
    });
    if (rows.length > 1) rows.push({ counts: columns.map((_, i) => rows.reduce((sum, r) => sum + r.counts[i], 0)), name: "total" });
    const onlyStdin = opts.positionals.length === 0;
    const width = onlyStdin ? (columns.length === 1 ? 1 : 7) : Math.max(...rows.flatMap((r) => r.counts.map((c) => String(c).length)));
    for (const row of rows) {
      const nums = row.counts.map((c) => String(c).padStart(width)).join(" ");
      ctx.stdout(row.name ? `${nums} ${row.name}\n` : `${nums}\n`);
    }
    return status;
  },
};

function sortKey(line: string, field: number | null, separator: string | undefined): string {
  if (field === null) return line;
  const parts = separator !== undefined ? line.split(separator) : line.trim().split(/\s+/);
  return parts[field - 1] ?? "";
}

function parseHuman(value: string): number {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([KMGTP]?)/i.exec(value);
  if (!m) return 0;
  const mult = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 }[m[2].toUpperCase()] ?? 1;
  return Number(m[1]) * mult;
}

const sort: CommandSpec = {
  name: "sort",
  summary: "Sort lines of text files.",
  usage: "sort [OPTION]... [FILE]...\n  -r  reverse\n  -n  numeric sort\n  -h  human numeric sort (2K, 1G)\n  -u  unique\n  -f  ignore case\n  -k N  sort by field N\n  -t SEP  field separator",
  async run(ctx) {
    const opts = parseOptions("sort", ctx.args, [
      { key: "reverse", short: "r", long: "reverse" },
      { key: "numeric", short: "n", long: "numeric-sort" },
      { key: "human", short: "h", long: "human-numeric-sort" },
      { key: "unique", short: "u", long: "unique" },
      { key: "fold", short: "f", long: "ignore-case" },
      { key: "key", short: "k", long: "key", value: true },
      { key: "sep", short: "t", long: "field-separator", value: true },
      { key: "output", short: "o", long: "output", value: true },
    ]);
    const lines: string[] = [];
    const status = await withInputs(ctx, opts.positionals, (content) => lines.push(...splitLines(content)));
    const keySpec = opts.get("key");
    const field = keySpec ? Number.parseInt(keySpec, 10) : null;
    if (keySpec && (field === null || Number.isNaN(field) || field < 1)) throw new CommandError(`invalid number at field start: invalid count at start of '${keySpec}'`, 2);
    const keyFlags = keySpec ? keySpec.replace(/^[\d,.]+/, "") : "";
    const numeric = opts.has("numeric") || keyFlags.includes("n");
    const human = opts.has("human") || keyFlags.includes("h");
    const reverse = opts.has("reverse") || keyFlags.includes("r");
    const sep = opts.get("sep");
    const compare = (a: string, b: string): number => {
      const ka = sortKey(a, field, sep);
      const kb = sortKey(b, field, sep);
      let c: number;
      if (human) c = parseHuman(ka) - parseHuman(kb);
      else if (numeric) c = (Number.parseFloat(ka) || 0) - (Number.parseFloat(kb) || 0);
      else {
        const x = opts.has("fold") ? ka.toLowerCase() : ka;
        const y = opts.has("fold") ? kb.toLowerCase() : kb;
        c = x < y ? -1 : x > y ? 1 : 0;
      }
      if (c === 0 && !opts.has("unique")) c = a < b ? -1 : a > b ? 1 : 0;
      return reverse ? -c : c;
    };
    let sorted = [...lines].sort(compare);
    if (opts.has("unique")) sorted = sorted.filter((line, i) => i === 0 || compare(sorted[i - 1], line) !== 0);
    const output = sorted.length ? sorted.join("\n") + "\n" : "";
    const outFile = opts.get("output");
    if (outFile) ctx.shell.fs.writeFile(ctx.shell.resolve(outFile), output);
    else ctx.stdout(output);
    return status;
  },
};

const uniq: CommandSpec = {
  name: "uniq",
  summary: "Report or omit repeated (adjacent) lines.",
  usage: "uniq [OPTION]... [INPUT]\n  -c  prefix lines by the number of occurrences\n  -d  only print duplicate lines\n  -u  only print unique lines\n  -i  ignore case",
  async run(ctx) {
    const opts = parseOptions("uniq", ctx.args, [
      { key: "count", short: "c", long: "count" },
      { key: "repeated", short: "d", long: "repeated" },
      { key: "unique", short: "u", long: "unique" },
      { key: "ignore", short: "i", long: "ignore-case" },
    ]);
    const lines: string[] = [];
    const status = await withInputs(ctx, opts.positionals.slice(0, 1), (content) => lines.push(...splitLines(content)));
    const groups: { line: string; count: number }[] = [];
    for (const line of lines) {
      const last = groups[groups.length - 1];
      const same = last && (opts.has("ignore") ? last.line.toLowerCase() === line.toLowerCase() : last.line === line);
      if (same) last.count++;
      else groups.push({ line, count: 1 });
    }
    const out = groups
      .filter((g) => (opts.has("repeated") ? g.count > 1 : true) && (opts.has("unique") ? g.count === 1 : true))
      .map((g) => (opts.has("count") ? `${String(g.count).padStart(7)} ${g.line}` : g.line));
    if (out.length) ctx.stdout(out.join("\n") + "\n");
    return status;
  },
};

/** Convert a POSIX basic regular expression to a JavaScript one. */
export function breToJs(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[++i];
      if ("|(){}+?".includes(next)) out += next;
      else out += "\\" + next;
      continue;
    }
    if ("|(){}+?".includes(ch)) out += "\\" + ch;
    else out += ch;
  }
  return out;
}

function posixClasses(pattern: string): string {
  return pattern
    .replace(/\[:alpha:\]/g, "A-Za-z")
    .replace(/\[:digit:\]/g, "0-9")
    .replace(/\[:alnum:\]/g, "A-Za-z0-9")
    .replace(/\[:upper:\]/g, "A-Z")
    .replace(/\[:lower:\]/g, "a-z")
    .replace(/\[:space:\]/g, "\\s")
    .replace(/\[:punct:\]/g, "!-\\/:-@\\[-`{-~")
    .replace(/\[:xdigit:\]/g, "0-9A-Fa-f");
}

const GREP_COLORS = { match: "\x1b[01;31m", file: "\x1b[35m", line: "\x1b[32m", sep: "\x1b[36m", reset: "\x1b[0m" };

const grep: CommandSpec = {
  name: "grep",
  summary: "Print lines that match patterns.",
  usage:
    "grep [OPTION]... PATTERN [FILE]...\n  -i  ignore case            -v  invert match\n  -n  line numbers           -c  count matching lines\n  -l  list matching files    -L  list non-matching files\n  -r  recursive              -w  match whole words\n  -x  match whole lines      -o  print only the match\n  -E  extended regex         -F  fixed strings\n  -e PATTERN                 -q  quiet\n  -A/-B/-C NUM  context lines\n  --include=GLOB --exclude=GLOB",
  async run(ctx) {
    const opts = parseOptions(ctx.name, ctx.args, [
      { key: "ignore", short: "i", long: "ignore-case" },
      { key: "invert", short: "v", long: "invert-match" },
      { key: "number", short: "n", long: "line-number" },
      { key: "count", short: "c", long: "count" },
      { key: "files", short: "l", long: "files-with-matches" },
      { key: "nofiles", short: "L", long: "files-without-match" },
      { key: "recursive", short: "r", long: "recursive" },
      { key: "recursive", short: "R", long: "dereference-recursive" },
      { key: "word", short: "w", long: "word-regexp" },
      { key: "line", short: "x", long: "line-regexp" },
      { key: "only", short: "o", long: "only-matching" },
      { key: "extended", short: "E", long: "extended-regexp" },
      { key: "fixed", short: "F", long: "fixed-strings" },
      { key: "perl", short: "P", long: "perl-regexp" },
      { key: "regexp", short: "e", long: "regexp", value: true },
      { key: "quiet", short: "q", long: ["quiet", "silent"] },
      { key: "with", short: "H", long: "with-filename" },
      { key: "without", short: "h", long: "no-filename" },
      { key: "after", short: "A", long: "after-context", value: true },
      { key: "before", short: "B", long: "before-context", value: true },
      { key: "context", short: "C", long: "context", value: true },
      { key: "include", long: "include", value: true },
      { key: "exclude", long: "exclude", value: true },
      { key: "color", long: ["color", "colour"], value: true },
      { key: "max", short: "m", long: "max-count", value: true },
      { key: "silentErrors", short: "s", long: "no-messages" },
    ]);
    const positionals = [...opts.positionals];
    const patterns = opts.all("regexp");
    if (patterns.length === 0) {
      const p = positionals.shift();
      if (p === undefined) throw new CommandError("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.", 2);
      patterns.push(...p.split("\n"));
    }
    const extended = opts.has("extended") || opts.has("perl") || ctx.name === "egrep";
    const fixed = opts.has("fixed") || ctx.name === "fgrep";
    const sources = patterns.map((p) => {
      let src = fixed ? p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") : posixClasses(extended ? p : breToJs(p));
      if (opts.has("word")) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
      if (opts.has("line")) src = `^(?:${src})$`;
      return src;
    });
    let regex: RegExp;
    try {
      regex = new RegExp(sources.join("|"), opts.has("ignore") ? "gi" : "g");
    } catch (e) {
      throw new CommandError(`Invalid regular expression: ${(e as Error).message}`, 2);
    }
    const colorMode = opts.get("color") ?? "auto";
    const color = colorMode === "always" || (colorMode === "auto" && ctx.stdoutIsTTY);
    const c = (code: string, text: string) => (color ? code + text + GREP_COLORS.reset : text);
    const after = Number(opts.get("after") ?? opts.get("context") ?? 0);
    const before = Number(opts.get("before") ?? opts.get("context") ?? 0);
    const maxCount = opts.get("max") !== undefined ? Number(opts.get("max")) : Infinity;
    const includeRe = opts.all("include").map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"));
    const excludeRe = opts.all("exclude").map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"));

    // Collect inputs.
    const inputs: { name: string; content: string }[] = [];
    let status = 1;
    let errors = false;
    const targets = positionals.length > 0 ? positionals : opts.has("recursive") ? ["."] : ["-"];
    for (const target of targets) {
      if (target === "-") {
        if (ctx.stdin === null) throw new CommandError("reading from the terminal is not supported in the simulator — pass a file or pipe input", 2);
        inputs.push({ name: "(standard input)", content: ctx.stdin });
        continue;
      }
      const abs = ctx.shell.resolve(target);
      const node = ctx.shell.fs.get(abs);
      if (!node) {
        if (!opts.has("silentErrors")) ctx.stderr(`grep: ${target}: No such file or directory\n`);
        errors = true;
        continue;
      }
      if (node.type === "dir") {
        if (!opts.has("recursive")) {
          if (!opts.has("silentErrors")) ctx.stderr(`grep: ${target}: Is a directory\n`);
          errors = true;
          continue;
        }
        for (const entry of ctx.shell.fs.walk(abs)) {
          if (entry.node.type !== "file") continue;
          const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
          if (includeRe.length && !includeRe.some((r) => r.test(name))) continue;
          if (excludeRe.some((r) => r.test(name))) continue;
          const shown = target === "." && positionals.length === 0 ? relativePath(entry.path, abs) : `${target.replace(/\/$/, "")}/${relativePath(entry.path, abs)}`;
          inputs.push({ name: shown, content: entry.node.content });
        }
        continue;
      }
      inputs.push({ name: target, content: node.content });
    }

    const multiple = opts.has("with") || (!opts.has("without") && (inputs.length > 1 || opts.has("recursive")));
    for (const input of inputs) {
      const lines = splitLines(input.content);
      const matched: boolean[] = lines.map((line) => {
        regex.lastIndex = 0;
        return regex.test(line) !== opts.has("invert");
      });
      let count = 0;
      const limited = matched.map((m) => {
        if (m && count < maxCount) {
          count++;
          return true;
        }
        return false;
      });
      if (count > 0) status = 0;
      if (opts.has("quiet")) {
        if (status === 0) return 0;
        continue;
      }
      if (opts.has("files")) {
        if (count > 0) ctx.stdout(c(GREP_COLORS.file, input.name) + "\n");
        continue;
      }
      if (opts.has("nofiles")) {
        if (count === 0) ctx.stdout(c(GREP_COLORS.file, input.name) + "\n");
        continue;
      }
      if (opts.has("count")) {
        ctx.stdout((multiple ? c(GREP_COLORS.file, input.name) + c(GREP_COLORS.sep, ":") : "") + count + "\n");
        continue;
      }
      const show = new Map<number, "match" | "context">();
      limited.forEach((m, i) => {
        if (!m) return;
        for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) if (!show.has(j)) show.set(j, "context");
        show.set(i, "match");
      });
      let lastPrinted = -2;
      const indices = [...show.keys()].sort((a, b) => a - b);
      for (const i of indices) {
        const kind = show.get(i) as "match" | "context";
        if ((before > 0 || after > 0) && lastPrinted >= 0 && i > lastPrinted + 1) ctx.stdout(c(GREP_COLORS.sep, "--") + "\n");
        lastPrinted = i;
        const sepChar = kind === "match" ? ":" : "-";
        const prefix = (multiple ? c(GREP_COLORS.file, input.name) + c(GREP_COLORS.sep, sepChar) : "") + (opts.has("number") ? c(GREP_COLORS.line, String(i + 1)) + c(GREP_COLORS.sep, sepChar) : "");
        const line = lines[i];
        if (opts.has("only") && !opts.has("invert")) {
          regex.lastIndex = 0;
          for (const m of line.matchAll(regex)) if (m[0] !== "") ctx.stdout(prefix + c(GREP_COLORS.match, m[0]) + "\n");
          continue;
        }
        const body = kind === "match" && !opts.has("invert") && color ? line.replace(regex, (m) => (m === "" ? m : c(GREP_COLORS.match, m))) : line;
        ctx.stdout(prefix + body + "\n");
      }
    }
    return errors && status !== 0 ? 2 : status;
  },
};

const cut: CommandSpec = {
  name: "cut",
  summary: "Remove sections from each line of files.",
  usage: "cut OPTION... [FILE]...\n  -d DELIM  use DELIM instead of TAB for field delimiter\n  -f LIST   select only these fields (e.g. 1,3 or 2-4 or 3-)\n  -c LIST   select only these characters",
  async run(ctx) {
    const opts = parseOptions("cut", ctx.args, [
      { key: "delim", short: "d", long: "delimiter", value: true },
      { key: "fields", short: "f", long: "fields", value: true },
      { key: "chars", short: "c", long: "characters", value: true },
      { key: "bytes", short: "b", long: "bytes", value: true },
      { key: "suppress", short: "s", long: "only-delimited" },
    ]);
    const list = opts.get("fields") ?? opts.get("chars") ?? opts.get("bytes");
    if (!list) throw new CommandError("you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.");
    const ranges = list.split(",").map((part) => {
      const m = /^(\d*)(-?)(\d*)$/.exec(part);
      if (!m || (m[1] === "" && m[3] === "")) throw new CommandError(`invalid field value '${part}'`);
      const start = m[1] ? Number(m[1]) : 1;
      const end = m[2] ? (m[3] ? Number(m[3]) : Infinity) : start;
      return [start, end] as const;
    });
    const selected = (i: number) => ranges.some(([s, e]) => i >= s && i <= e);
    const delim = opts.get("delim") ?? "\t";
    if (delim.length !== 1) throw new CommandError("the delimiter must be a single character");
    const out: string[] = [];
    const status = await withInputs(ctx, opts.positionals, (content) => {
      for (const line of splitLines(content)) {
        if (opts.has("fields")) {
          if (!line.includes(delim)) {
            if (!opts.has("suppress")) out.push(line);
            continue;
          }
          out.push(line.split(delim).filter((_, i) => selected(i + 1)).join(delim));
        } else {
          out.push([...line].filter((_, i) => selected(i + 1)).join(""));
        }
      }
    });
    if (out.length) ctx.stdout(out.join("\n") + "\n");
    return status;
  },
};

function expandTrSet(set: string): string[] {
  const classes: Record<string, string> = {
    "[:lower:]": "abcdefghijklmnopqrstuvwxyz",
    "[:upper:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "[:digit:]": "0123456789",
    "[:space:]": " \t\n\r\v\f",
    "[:alpha:]": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "[:alnum:]": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "[:punct:]": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
  };
  let s = set;
  for (const [name, chars] of Object.entries(classes)) s = s.split(name).join(chars);
  s = interpretEscapes(s).text;
  const out: string[] = [];
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i + 1] === "-" && chars[i + 2] !== undefined) {
      const from = chars[i].codePointAt(0) as number;
      const to = chars[i + 2].codePointAt(0) as number;
      for (let c = from; c <= to; c++) out.push(String.fromCodePoint(c));
      i += 2;
    } else out.push(chars[i]);
  }
  return out;
}

const tr: CommandSpec = {
  name: "tr",
  summary: "Translate, squeeze, and/or delete characters from standard input.",
  usage: "tr [OPTION]... SET1 [SET2]\n  -d  delete characters in SET1\n  -s  squeeze repeated characters\n  e.g. tr a-z A-Z, tr -d '\\r', tr -s ' '",
  run(ctx) {
    const opts = parseOptions("tr", ctx.args, [
      { key: "delete", short: "d", long: "delete" },
      { key: "squeeze", short: "s", long: "squeeze-repeats" },
      { key: "complement", short: "c", long: "complement" },
      { key: "complement", short: "C" },
    ]);
    if (ctx.stdin === null) throw new CommandError("reading from the terminal is not supported in the simulator — pipe input into tr");
    const [set1Raw, set2Raw] = opts.positionals;
    if (set1Raw === undefined) throw new CommandError("missing operand");
    const set1 = expandTrSet(set1Raw);
    const set2 = set2Raw !== undefined ? expandTrSet(set2Raw) : [];
    const inSet1 = (ch: string) => set1.includes(ch) !== opts.has("complement");
    let out = "";
    for (const ch of ctx.stdin) {
      if (opts.has("delete")) {
        if (!inSet1(ch)) out += ch;
        continue;
      }
      if (set2.length > 0 && !opts.has("complement")) {
        const idx = set1.indexOf(ch);
        out += idx === -1 ? ch : set2[Math.min(idx, set2.length - 1)];
      } else if (set2.length > 0 && inSet1(ch)) out += set2[set2.length - 1];
      else out += ch;
    }
    if (opts.has("squeeze")) {
      const squeezeSet = opts.has("delete") ? set2 : set2.length ? set2 : set1;
      let squeezed = "";
      for (const ch of out) if (!(squeezed.endsWith(ch) && squeezeSet.includes(ch))) squeezed += ch;
      out = squeezed;
    }
    ctx.stdout(out);
    return 0;
  },
};

const tee: CommandSpec = {
  name: "tee",
  summary: "Read from standard input and write to standard output and files.",
  usage: "tee [-a] [FILE]...\n  -a, --append  append to the given files, do not overwrite",
  run(ctx) {
    const opts = parseOptions("tee", ctx.args, [{ key: "append", short: "a", long: "append" }]);
    const input = ctx.stdin ?? "";
    let status = 0;
    for (const file of opts.positionals) {
      try {
        ctx.shell.fs.writeFile(ctx.shell.resolve(file), input, { append: opts.has("append") });
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr(`tee: ${file}: ${error.message}\n`);
        status = 1;
      }
    }
    ctx.stdout(input);
    return status;
  },
};

const seq: CommandSpec = {
  name: "seq",
  summary: "Print a sequence of numbers.",
  usage: "seq [-s SEP] [-w] LAST | FIRST LAST | FIRST INCREMENT LAST",
  run(ctx) {
    const args = [...ctx.args];
    let separator = "\n";
    let equalWidth = false;
    while (args.length && /^-[sw]/.test(args[0]) && !/^-\d/.test(args[0])) {
      const flag = args.shift() as string;
      if (flag === "-w") equalWidth = true;
      else if (flag === "-s") separator = interpretEscapes(args.shift() ?? "\n").text;
      else if (flag.startsWith("-s")) separator = interpretEscapes(flag.slice(2)).text;
    }
    const nums = args.map(Number);
    if (nums.length === 0 || nums.length > 3 || nums.some(Number.isNaN)) throw new CommandError(nums.length === 0 ? "missing operand" : `invalid floating point argument: '${args.find((a) => Number.isNaN(Number(a)))}'`);
    const [first, step, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
    if (step === 0) throw new CommandError("invalid Zero increment value: '0'");
    const out: string[] = [];
    for (let n = first; step > 0 ? n <= last : n >= last; n += step) {
      out.push(String(Math.round(n * 1e10) / 1e10));
      if (out.length > 100_000) throw new CommandError("sequence too long for the simulator (max 100000 numbers)");
    }
    const width = Math.max(...out.map((s) => s.length));
    const rendered = equalWidth ? out.map((s) => s.padStart(width, "0")) : out;
    if (rendered.length) ctx.stdout(rendered.join(separator) + "\n");
    return 0;
  },
};

const xargs: CommandSpec = {
  name: "xargs",
  summary: "Build and execute command lines from standard input.",
  usage: "xargs [OPTION]... [COMMAND [INITIAL-ARGS]...]\n  -I REPLACE  replace occurrences of REPLACE in the command with each input line\n  -n MAX      use at most MAX arguments per command line\n  -d DELIM    input items are separated by DELIM\n  -0          input items are separated by NUL\n  -r          do not run the command if the input is empty\n  -t          print commands before executing them",
  async run(ctx) {
    const opts = parseOptions(
      "xargs",
      ctx.args,
      [
        { key: "replace", short: "I", value: true },
        { key: "max", short: "n", long: "max-args", value: true },
        { key: "delim", short: "d", long: "delimiter", value: true },
        { key: "null", short: "0", long: "null" },
        { key: "noRunEmpty", short: "r", long: "no-run-if-empty" },
        { key: "verbose", short: "t", long: "verbose" },
        { key: "procs", short: "P", long: "max-procs", value: true },
      ],
      { stopAtPositional: true },
    );
    const command = opts.positionals.length ? opts.positionals : ["echo"];
    const input = stripAnsi(ctx.stdin ?? "");
    let items: string[];
    const replace = opts.get("replace");
    if (opts.has("null")) items = input.split("\0").filter((s) => s !== "");
    else if (opts.get("delim") !== undefined) items = input.split(interpretEscapes(opts.get("delim") as string).text).filter((s) => s !== "");
    else if (replace !== undefined) items = splitLines(input).filter((s) => s.trim() !== "");
    else items = [...input.matchAll(/"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'])+)/g)].map((m) => m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, "$1"));
    if (items.length === 0 && (opts.has("noRunEmpty") || replace !== undefined)) return 0;

    const batches: string[][] = [];
    if (replace !== undefined) {
      for (const item of items) batches.push(command.map((part) => part.split(replace).join(item)));
    } else {
      const max = opts.get("max") !== undefined ? Math.max(1, Number(opts.get("max"))) : Infinity;
      if (items.length === 0) batches.push([...command]);
      for (let i = 0; i < items.length; i += max === Infinity ? items.length || 1 : max) {
        batches.push([...command, ...items.slice(i, max === Infinity ? undefined : i + max)]);
      }
    }
    if (batches.length > 5000) throw new CommandError("too many command invocations for the simulator (max 5000)");
    let status = 0;
    for (const argv of batches) {
      if (opts.has("verbose")) ctx.stderr(argv.map(shellQuote).join(" ") + "\n");
      const code = await ctx.shell.runArgv(argv, { stdin: "", stdout: ctx.stdout, stderr: ctx.stderr, tty: ctx.stdoutIsTTY });
      if (code === 127) return 127;
      if (code !== 0) status = 123;
    }
    return status;
  },
};

const pager: (name: string) => CommandSpec = (name) => ({
  name,
  summary: `${name} is non-interactive in the simulator and behaves like cat.`,
  usage: `${name} [FILE]...`,
  async run(ctx) {
    const files = ctx.args.filter((a) => !a.startsWith("-"));
    return withInputs(ctx, files, (content) => ctx.stdout(content));
  },
});

export const TEXT_COMMANDS: CommandSpec[] = [
  echo,
  printf,
  headTail("head"),
  headTail("tail"),
  wc,
  sort,
  uniq,
  grep,
  { ...grep, name: "egrep" },
  { ...grep, name: "fgrep" },
  cut,
  tr,
  tee,
  seq,
  xargs,
  pager("less"),
  pager("more"),
];

export { interpretEscapes };
