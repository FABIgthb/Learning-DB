/**
 * ripgrep (rg) simulation: recursive regex search that respects .gitignore
 * (inside git repositories), .ignore and .rgignore, skips hidden files by
 * default, supports file types, globs, context, counting, replacements and
 * rg's tty vs. pipe output formats.
 */

import { CommandError, type CommandSpec } from "../command";
import { basename, compareNames, joinPath, relativePath, type FsNode } from "../filesystem";
import type { Shell } from "../shell";
import { parseOptions, splitLines } from "./args";

export const RG_TYPES: Record<string, string[]> = {
  c: ["*.c", "*.h"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.h"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  docker: ["Dockerfile", "Dockerfile.*", "*.dockerfile", "Containerfile"],
  go: ["*.go"],
  html: ["*.html", "*.htm"],
  java: ["*.java"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"],
  json: ["*.json", "*.jsonc", "*.jsonl", "*.ndjson", "*.geojson"],
  log: ["*.log"],
  make: ["Makefile", "makefile", "GNUmakefile", "*.mk", "*.mak"],
  markdown: ["*.md", "*.markdown", "*.mdx", "*.mkd"],
  md: ["*.md", "*.markdown", "*.mdx", "*.mkd"],
  py: ["*.py", "*.pyi"],
  rust: ["*.rs"],
  sh: ["*.sh", "*.bash", "*.zsh", ".bashrc", ".zshrc", ".bash_profile", ".profile", ".bash_aliases"],
  sql: ["*.sql", "*.psql"],
  toml: ["*.toml", "Cargo.lock"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  txt: ["*.txt"],
  yaml: ["*.yaml", "*.yml"],
};

/* ---------------------------------------------------------------- */
/* Glob + ignore matching                                            */
/* ---------------------------------------------------------------- */

/** Convert a gitignore-style glob to a RegExp over a slash-separated relative path. */
export function gitGlobToRegExp(glob: string, caseInsensitive = false): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length;
        if (atStart && glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atEnd) {
          source += ".*";
          i += 1;
          continue;
        }
        source += ".*";
        i += 1;
        continue;
      }
      source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) source += "\\[";
      else {
        source += "[" + glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close === -1) source += "\\{";
      else {
        source += "(?:" + glob.slice(i + 1, close).split(",").map((alt) => alt.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")";
        i = close;
      }
    } else if (ch === "\\" && i + 1 < glob.length) {
      source += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
}

interface IgnoreRule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

interface IgnoreFile {
  /** Absolute directory containing the ignore file. */
  base: string;
  rules: IgnoreRule[];
}

function parseIgnoreFile(content: string, base: string): IgnoreFile {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    let line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const pattern = anchored ? line : `**/${line}`;
    rules.push({ regex: gitGlobToRegExp(pattern), negate, dirOnly });
  }
  return { base, rules };
}

/** Last matching rule wins across all applicable ignore files (outermost first). */
function isIgnored(path: string, isDirectory: boolean, stack: IgnoreFile[]): boolean {
  let ignored = false;
  for (const file of stack) {
    if (!(path === file.base || path.startsWith(file.base === "/" ? "/" : file.base + "/"))) continue;
    const rel = relativePath(path, file.base);
    for (const rule of file.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(rel)) ignored = !rule.negate;
    }
  }
  return ignored;
}

function insideGitRepo(shell: Shell, dir: string): boolean {
  let current = dir;
  for (;;) {
    if (shell.fs.isDirectory(joinPath(current, ".git"))) return true;
    if (current === "/") return false;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
}

/** Collect ignore files from ancestors of `dir` (gitignore only inside repos). */
function ancestorIgnores(shell: Shell, dir: string, useVcs: boolean, useDot: boolean): IgnoreFile[] {
  const dirs: string[] = [];
  let current = dir;
  for (;;) {
    dirs.unshift(current);
    if (current === "/") break;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
  const out: IgnoreFile[] = [];
  const inRepo = insideGitRepo(shell, dir);
  for (const d of dirs) out.push(...ignoresIn(shell, d, useVcs && inRepo, useDot));
  return out;
}

function ignoresIn(shell: Shell, dir: string, useVcs: boolean, useDot: boolean): IgnoreFile[] {
  const out: IgnoreFile[] = [];
  const names = [...(useVcs ? [".gitignore"] : []), ...(useDot ? [".ignore", ".rgignore"] : [])];
  for (const name of names) {
    const path = joinPath(dir, name);
    if (shell.fs.isFile(path)) out.push(parseIgnoreFile(shell.fs.readFile(path), dir));
  }
  return out;
}

export interface WalkOptions {
  hidden: boolean;
  noIgnore: boolean;
  noIgnoreVcs: boolean;
  maxDepth?: number;
}

/** Walk like the `ignore` crate: sorted, skipping hidden + ignored paths and .git. */
export function* walkRespectingIgnores(shell: Shell, root: string, options: WalkOptions): Generator<{ path: string; node: FsNode }> {
  const rootNode = shell.fs.stat(root);
  if (rootNode.type === "file") {
    yield { path: root, node: rootNode };
    return;
  }
  const useVcs = !options.noIgnore && !options.noIgnoreVcs;
  const useDot = !options.noIgnore;
  const base = ancestorIgnores(shell, root, useVcs, useDot);
  const inRepo = insideGitRepo(shell, root);

  function* visit(dir: string, node: Extract<FsNode, { type: "dir" }>, stack: IgnoreFile[], depth: number): Generator<{ path: string; node: FsNode }> {
    const names = [...node.children.keys()].sort(compareNames);
    for (const name of names) {
      const child = node.children.get(name) as FsNode;
      const path = joinPath(dir, name);
      if (name === ".git" && child.type === "dir") continue;
      if (!options.hidden && name.startsWith(".")) continue;
      if (stack.length > 0 && isIgnored(path, child.type === "dir", stack)) continue;
      if (child.type === "dir") {
        if (options.maxDepth !== undefined && depth + 1 > options.maxDepth) continue;
        const childIgnores = ignoresIn(shell, path, useVcs && (inRepo || insideGitRepo(shell, path)), useDot);
        yield* visit(path, child, childIgnores.length ? [...stack, ...childIgnores] : stack, depth + 1);
      } else {
        yield { path, node: child };
      }
    }
  }
  yield* visit(root, rootNode, base, 0);
}

/* ---------------------------------------------------------------- */
/* Command                                                           */
/* ---------------------------------------------------------------- */

const COLOR = {
  path: "\x1b[0m\x1b[35m",
  line: "\x1b[0m\x1b[32m",
  column: "\x1b[0m\x1b[32m",
  match: "\x1b[0m\x1b[1m\x1b[31m",
  reset: "\x1b[0m",
};

/** Translate Rust regex syntax to JavaScript. */
function rustRegexToJs(pattern: string): { source: string; flags: string } {
  let source = pattern.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>");
  let flags = "";
  const inline = /^\(\?([imsx]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    if (inline[1].includes("i")) flags += "i";
    if (inline[1].includes("s")) flags += "s";
  }
  source = source.replace(/\\z/g, "$").replace(/\\A/g, "^");
  return { source, flags };
}

function expandReplacement(template: string, match: RegExpExecArray | RegExpMatchArray): string {
  return template.replace(/\$(\$|\{([A-Za-z0-9_]+)\}|([0-9]+|[A-Za-z_][A-Za-z0-9_]*))/g, (_all, token: string, braced?: string, bare?: string) => {
    if (token === "$") return "$";
    const name = braced ?? bare ?? "";
    if (/^\d+$/.test(name)) return match[Number(name)] ?? "";
    return match.groups?.[name] ?? "";
  });
}

const rg: CommandSpec = {
  name: "rg",
  summary: "ripgrep: recursively search the current directory for a regex pattern (respects .gitignore).",
  usage: [
    "rg [OPTIONS] PATTERN [PATH ...]",
    "rg [OPTIONS] --files [PATH ...]",
    "",
    "  -i, --ignore-case        case insensitive search",
    "  -S, --smart-case         case insensitive unless the pattern has uppercase",
    "  -s, --case-sensitive     case sensitive search (default)",
    "  -F, --fixed-strings      treat the pattern as a literal string",
    "  -w, --word-regexp        only show matches surrounded by word boundaries",
    "  -x, --line-regexp        only show matches surrounded by line boundaries",
    "  -v, --invert-match       invert matching",
    "  -e, --regexp PATTERN     a pattern to search for (repeatable)",
    "  -l, --files-with-matches print only paths with at least one match",
    "      --files-without-match",
    "  -c, --count              show the number of matching lines per file",
    "      --count-matches      show the number of matches per file",
    "  -o, --only-matching      print only the matched parts",
    "  -r, --replace TEXT       replace matches with TEXT ($1, ${name} supported)",
    "  -n, --line-number / -N, --no-line-number",
    "      --column             show column numbers",
    "  -A/-B/-C NUM             show NUM lines after/before/around each match",
    "  -m, --max-count NUM      limit the number of matching lines per file",
    "  -g, --glob GLOB          include/exclude files (prefix with ! to exclude)",
    "  -t, --type TYPE          only search files of TYPE (see --type-list)",
    "  -T, --type-not TYPE      do not search files of TYPE",
    "      --type-list          show all supported file types",
    "  -., --hidden             search hidden files and directories",
    "      --no-ignore          don't respect .gitignore/.ignore/.rgignore",
    "  -u                       --no-ignore; -uu also --hidden",
    "      --files              print each file that would be searched",
    "  -H, --with-filename / -I, --no-filename",
    "      --heading / --no-heading",
    "  -q, --quiet              do not print anything, exit 0 on match",
    "      --color WHEN         never, auto, always",
    "  -d, --max-depth NUM      descend at most NUM directories",
  ].join("\n"),
  run(ctx) {
    const opts = parseOptions("rg", ctx.args, [
      { key: "ignoreCase", short: "i", long: "ignore-case" },
      { key: "smartCase", short: "S", long: "smart-case" },
      { key: "caseSensitive", short: "s", long: "case-sensitive" },
      { key: "fixed", short: "F", long: "fixed-strings" },
      { key: "word", short: "w", long: "word-regexp" },
      { key: "lineRegexp", short: "x", long: "line-regexp" },
      { key: "invert", short: "v", long: "invert-match" },
      { key: "regexp", short: "e", long: "regexp", value: true },
      { key: "files", short: "l", long: "files-with-matches" },
      { key: "filesWithout", long: "files-without-match" },
      { key: "count", short: "c", long: "count" },
      { key: "countMatches", long: "count-matches" },
      { key: "only", short: "o", long: "only-matching" },
      { key: "replace", short: "r", long: "replace", value: true },
      { key: "lineNumber", short: "n", long: "line-number" },
      { key: "noLineNumber", short: "N", long: "no-line-number" },
      { key: "column", long: "column" },
      { key: "after", short: "A", long: "after-context", value: true },
      { key: "before", short: "B", long: "before-context", value: true },
      { key: "context", short: "C", long: "context", value: true },
      { key: "max", short: "m", long: "max-count", value: true },
      { key: "glob", short: "g", long: "glob", value: true },
      { key: "iglob", long: "iglob", value: true },
      { key: "type", short: "t", long: "type", value: true },
      { key: "typeNot", short: "T", long: "type-not", value: true },
      { key: "typeList", long: "type-list" },
      { key: "hidden", short: ".", long: "hidden" },
      { key: "noIgnore", long: "no-ignore" },
      { key: "noIgnoreVcs", long: "no-ignore-vcs" },
      { key: "unrestricted", short: "u", long: "unrestricted" },
      { key: "listFiles", long: "files" },
      { key: "withFilename", short: "H", long: "with-filename" },
      { key: "noFilename", short: "I", long: "no-filename" },
      { key: "heading", long: "heading" },
      { key: "noHeading", long: "no-heading" },
      { key: "quiet", short: "q", long: "quiet" },
      { key: "color", long: ["color", "colour"], value: true },
      { key: "maxDepth", short: "d", long: "max-depth", value: true },
      { key: "sort", long: "sort", value: true },
      { key: "multiline", short: "U", long: "multiline" },
      { key: "trim", long: "trim" },
      { key: "stats", long: "stats" },
      { key: "null", short: "0", long: "null" },
      { key: "pretty", short: "p", long: "pretty" },
      { key: "vimgrep", long: "vimgrep" },
    ]);
    const { shell } = ctx;

    if (opts.has("typeList")) {
      const lines = Object.entries(RG_TYPES).map(([name, globs]) => `${name}: ${globs.join(", ")}`);
      ctx.stdout(lines.join("\n") + "\n");
      return 0;
    }

    const positionals = [...opts.positionals];
    const patterns = opts.all("regexp");
    const listFiles = opts.has("listFiles");
    if (patterns.length === 0 && !listFiles) {
      const p = positionals.shift();
      if (p === undefined) {
        throw new CommandError(
          "error: no pattern given\n\nUSAGE:\n    rg [OPTIONS] PATTERN [PATH ...]\n    rg [OPTIONS] --files [PATH ...]\n\nFor more information try --help",
          2,
        );
      }
      patterns.push(p);
    }

    const unrestricted = opts.count("unrestricted");
    const hidden = opts.has("hidden") || unrestricted >= 2;
    const noIgnore = opts.has("noIgnore") || unrestricted >= 1;
    const pretty = opts.has("pretty");
    const colorMode = opts.get("color") ?? (pretty ? "always" : "auto");
    const color = colorMode === "always" || colorMode === "ansi" || (colorMode === "auto" && ctx.stdoutIsTTY);
    const tty = ctx.stdoutIsTTY || pretty;

    // Pattern compilation
    const pieces = patterns.map((p) => {
      if (opts.has("fixed")) return { source: p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), flags: "" };
      return rustRegexToJs(p);
    });
    let source = pieces.map((p) => `(?:${p.source})`).join("|");
    if (opts.has("word")) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    if (opts.has("lineRegexp")) source = `^(?:${source})$`;
    const lastCaseFlag = ["ignoreCase", "smartCase", "caseSensitive"].filter((k) => opts.has(k)).pop();
    let insensitive = pieces.some((p) => p.flags.includes("i"));
    if (lastCaseFlag === "ignoreCase") insensitive = true;
    if (lastCaseFlag === "smartCase") insensitive = !patterns.some((p) => /[A-Z]/.test(p.replace(/\\[A-Za-z]/g, "")));
    let regex: RegExp | null = null;
    if (!listFiles) {
      try {
        regex = new RegExp(source, `gmu${insensitive ? "i" : ""}${pieces.some((p) => p.flags.includes("s")) ? "s" : ""}`);
      } catch (e) {
        throw new CommandError(`regex parse error:\n    ${patterns.join("|")}\n    ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`, 2);
      }
    }

    // File filters
    const typeGlobs = (name: string) => {
      const globs = RG_TYPES[name];
      if (!globs) throw new CommandError(`unrecognized file type: ${name}`, 2);
      return globs.map((g) => gitGlobToRegExp(g));
    };
    const includeTypes = opts.all("type").flatMap(typeGlobs);
    const excludeTypes = opts.all("typeNot").flatMap(typeGlobs);
    const globs = [...opts.all("glob").map((g) => ({ g, ci: false })), ...opts.all("iglob").map((g) => ({ g, ci: true }))].map(({ g, ci }) => {
      const negate = g.startsWith("!");
      const pattern = negate ? g.slice(1) : g;
      return { negate, regex: gitGlobToRegExp(pattern.includes("/") ? pattern.replace(/^\//, "") : `**/${pattern}`, ci) };
    });
    const hasPositiveGlob = globs.some((g) => !g.negate);
    const passesFilters = (displayPath: string): boolean => {
      const name = basename(displayPath);
      if (includeTypes.length && !includeTypes.some((r) => r.test(name))) return false;
      if (excludeTypes.some((r) => r.test(name))) return false;
      if (globs.length) {
        const rel = displayPath.replace(/^\.\//, "");
        let included = !hasPositiveGlob;
        for (const g of globs) if (g.regex.test(rel)) included = !g.negate;
        if (!included) return false;
      }
      return true;
    };

    // Collect haystacks
    type Haystack = { display: string; content: string };
    const haystacks: Haystack[] = [];
    let status = 1;
    let hadError = false;
    const maxDepth = opts.get("maxDepth") !== undefined ? Number(opts.get("maxDepth")) : undefined;
    const searchStdin = positionals.length === 0 && ctx.stdin !== null && !listFiles;
    const targets = positionals.length > 0 ? positionals : searchStdin ? [] : ["."];
    const implicitCwd = positionals.length === 0;
    let searchedDirectory = false;

    if (searchStdin) haystacks.push({ display: "<stdin>", content: ctx.stdin as string });
    for (const target of targets) {
      if (target === "-") {
        haystacks.push({ display: "<stdin>", content: ctx.stdin ?? "" });
        continue;
      }
      const abs = shell.resolve(target);
      const node = shell.fs.get(abs);
      if (!node) {
        ctx.stderr(`rg: ${target}: No such file or directory (os error 2)\n`);
        hadError = true;
        continue;
      }
      if (node.type === "file") {
        // Explicit files bypass ignore rules and type filters (like rg).
        haystacks.push({ display: target, content: node.content });
        continue;
      }
      searchedDirectory = true;
      for (const entry of walkRespectingIgnores(shell, abs, { hidden, noIgnore, noIgnoreVcs: opts.has("noIgnoreVcs"), maxDepth })) {
        const rel = relativePath(entry.path, abs);
        const display = implicitCwd ? rel : `${target.replace(/\/$/, "")}/${rel}`;
        if (!passesFilters(display)) continue;
        if (entry.node.type === "file") haystacks.push({ display, content: entry.node.content });
      }
    }

    if (listFiles) {
      const files = haystacks.filter((h) => h.display !== "<stdin>").map((h) => h.display);
      if (files.length) ctx.stdout(files.join(opts.has("null") ? "\0" : "\n") + (opts.has("null") ? "\0" : "\n"));
      return files.length ? (hadError ? 2 : 0) : hadError ? 2 : 1;
    }

    const re = regex as RegExp;
    const showFilename = opts.has("noFilename") ? false : opts.has("withFilename") || searchedDirectory || haystacks.length > 1;
    const heading = opts.has("noHeading") ? false : opts.has("heading") || (tty && showFilename && !opts.has("vimgrep"));
    const onlyStdin = haystacks.every((h) => h.display === "<stdin>");
    const lineNumbers = opts.has("noLineNumber") ? false : opts.has("lineNumber") || opts.has("column") || opts.has("vimgrep") || (tty && !onlyStdin);
    const showColumn = opts.has("column") || opts.has("vimgrep");
    const after = Number(opts.get("after") ?? opts.get("context") ?? 0);
    const before = Number(opts.get("before") ?? opts.get("context") ?? 0);
    const maxCount = opts.get("max") !== undefined ? Number(opts.get("max")) : Infinity;
    const replacement = opts.get("replace");
    const c = (code: string, text: string) => (color ? code + text + COLOR.reset : text);
    const out: string[] = [];
    let firstFileBlock = true;

    for (const hay of haystacks) {
      const lines = splitLines(hay.content);
      const matchLines: number[] = [];
      let matchTotal = 0;
      for (let i = 0; i < lines.length && matchLines.length < maxCount; i++) {
        re.lastIndex = 0;
        const matches = [...lines[i].matchAll(re)].filter((m) => m[0] !== "" || lines[i] === "" || opts.has("lineRegexp"));
        const isMatch = (matches.length > 0) !== opts.has("invert");
        if (isMatch) {
          matchLines.push(i);
          matchTotal += opts.has("invert") ? 1 : matches.length;
        }
      }
      if (matchLines.length > 0) status = 0;
      if (opts.has("quiet")) {
        if (status === 0) return 0;
        continue;
      }
      const pathLabel = c(COLOR.path, hay.display);

      if (opts.has("files")) {
        if (matchLines.length > 0) out.push(pathLabel);
        continue;
      }
      if (opts.has("filesWithout")) {
        if (matchLines.length === 0) out.push(pathLabel);
        continue;
      }
      if (opts.has("count") || opts.has("countMatches")) {
        const n = opts.has("countMatches") ? matchTotal : matchLines.length;
        if (n > 0) out.push(showFilename ? `${pathLabel}:${n}` : String(n));
        continue;
      }
      if (matchLines.length === 0) continue;

      const block: string[] = [];
      if (heading) {
        if (!firstFileBlock) block.push("");
        block.push(pathLabel);
      }
      firstFileBlock = false;

      const shown = new Map<number, boolean>();
      for (const i of matchLines) {
        for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) if (!shown.has(j)) shown.set(j, false);
        shown.set(i, true);
      }
      let previous = -1;
      for (const i of [...shown.keys()].sort((a, b) => a - b)) {
        const isMatch = shown.get(i) as boolean;
        if ((before > 0 || after > 0) && previous !== -1 && i > previous + 1) block.push(c("\x1b[0m", "--"));
        previous = i;
        const sep = isMatch ? ":" : "-";
        const line = lines[i];
        re.lastIndex = 0;
        const firstMatch = isMatch && !opts.has("invert") ? re.exec(line) : null;
        const col = firstMatch ? [...line.slice(0, firstMatch.index)].length + 1 : 1;
        let prefix = "";
        if (showFilename && !heading) prefix += pathLabel + sep;
        if (lineNumbers) prefix += c(COLOR.line, String(i + 1)) + sep;
        if (showColumn && isMatch) prefix += c(COLOR.column, String(col)) + sep;

        if (opts.has("only") && isMatch && !opts.has("invert")) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            if (m[0] === "") continue;
            const text = replacement !== undefined ? expandReplacement(replacement, m) : m[0];
            block.push(prefix + c(COLOR.match, text));
          }
          continue;
        }
        let body = line;
        if (isMatch && !opts.has("invert")) {
          re.lastIndex = 0;
          body = line.replace(re, (...args: unknown[]) => {
            const m = args[0] as string;
            if (m === "") return m;
            const last = args[args.length - 1];
            const hasGroups = typeof last === "object" && last !== null;
            const captures = args.slice(1, hasGroups ? -3 : -2) as string[];
            const matchArray = Object.assign([m, ...captures], {
              groups: hasGroups ? (last as Record<string, string>) : undefined,
            }) as unknown as RegExpMatchArray;
            const text = replacement !== undefined ? expandReplacement(replacement, matchArray) : m;
            return c(COLOR.match, text);
          });
        }
        if (opts.has("trim")) body = body.replace(/^\s+/, "");
        block.push(prefix + body);
      }
      out.push(...block);
    }

    if (out.length) ctx.stdout(out.join("\n") + "\n");
    return hadError ? 2 : status;
  },
};

export const RG_COMMANDS: CommandSpec[] = [rg, { ...rg, name: "ripgrep" }];
