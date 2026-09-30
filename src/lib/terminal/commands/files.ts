/** File-system commands: cd, pwd, ls, cat, mkdir, rmdir, touch, rm, cp, mv, tree, find, chmod, basename, dirname. */

import { CommandError, type CommandContext, type CommandSpec } from "../command";
import { FsError, VirtualFileSystem, basename, compareNames, dirname, joinPath, relativePath, type FsNode } from "../filesystem";
import { parseOptions, splitLines } from "./args";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function colorName(name: string, node: FsNode, tty: boolean): string {
  if (!tty) return name;
  if (node.type === "dir") return `\x1b[01;34m${name}\x1b[0m`;
  if (node.executable) return `\x1b[01;32m${name}\x1b[0m`;
  if (/\.(tar|tgz|gz|zip|xz|bz2|7z)$/.test(name)) return `\x1b[01;31m${name}\x1b[0m`;
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(name)) return `\x1b[01;35m${name}\x1b[0m`;
  return name;
}

function classify(node: FsNode): string {
  if (node.type === "dir") return "/";
  if (node.executable) return "*";
  return "";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M", "G", "T"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return (value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)).toString() + units[unit];
}

function formatDate(mtime: number): string {
  const d = VirtualFileSystem.toDate(mtime);
  const day = String(d.getUTCDate()).padStart(2, " ");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${day} ${hh}:${mm}`;
}

function permissions(node: FsNode): string {
  if (node.type === "dir") return "drwxr-xr-x";
  return node.executable ? "-rwxr-xr-x" : "-rw-r--r--";
}

/** GNU ls column layout (column-major, 2-space gutters). */
export function columnize(items: { text: string; width: number }[], columns: number): string {
  if (items.length === 0) return "";
  for (let cols = Math.min(items.length, Math.max(1, Math.floor(columns / 3))); cols >= 1; cols--) {
    const rows = Math.ceil(items.length / cols);
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let max = 0;
      for (let r = 0; r < rows; r++) {
        const item = items[c * rows + r];
        if (item) max = Math.max(max, item.width);
      }
      widths.push(max);
    }
    const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
    if (total <= columns || cols === 1) {
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        let line = "";
        for (let c = 0; c < cols; c++) {
          const item = items[c * rows + r];
          if (!item) continue;
          const isLastInRow = !items[(c + 1) * rows + r];
          line += item.text + (isLastInRow ? "" : " ".repeat(widths[c] - item.width + 2));
        }
        lines.push(line);
      }
      return lines.join("\n") + "\n";
    }
  }
  return items.map((i) => i.text).join("\n") + "\n";
}

const cd: CommandSpec = {
  name: "cd",
  summary: "Change the shell working directory.",
  usage: "cd [dir]\n  cd        go to $HOME\n  cd -      go to the previous directory\n  cd ..     go up one level",
  builtin: true,
  run(ctx) {
    const { shell } = ctx;
    if (ctx.args.length > 1) throw new CommandError("too many arguments");
    let target = ctx.args[0];
    if (target === undefined || target === "") target = shell.vars.get("HOME") ?? shell.home;
    if (target === "-") {
      if (!shell.previousCwd) throw new CommandError("OLDPWD not set");
      target = shell.previousCwd;
      ctx.stdout(`${target}\n`);
    }
    const abs = shell.resolve(target);
    const node = shell.fs.get(abs);
    if (!node) throw new CommandError(`${ctx.args[0]}: No such file or directory`);
    if (node.type !== "dir") throw new CommandError(`${ctx.args[0]}: Not a directory`);
    shell.setCwd(abs);
    return 0;
  },
};

const pwd: CommandSpec = {
  name: "pwd",
  summary: "Print the name of the current working directory.",
  usage: "pwd [-LP]",
  builtin: true,
  run(ctx) {
    parseOptions("pwd", ctx.args, [
      { key: "L", short: "L" },
      { key: "P", short: "P" },
    ]);
    ctx.stdout(`${ctx.shell.cwd}\n`);
    return 0;
  },
};

const ls: CommandSpec = {
  name: "ls",
  summary: "List directory contents.",
  usage:
    "ls [OPTION]... [FILE]...\n  -a, --all             do not ignore entries starting with .\n  -A, --almost-all      do not list implied . and ..\n  -l                    use a long listing format\n  -h, --human-readable  with -l, print sizes like 1K 234M\n  -1                    list one file per line\n  -R, --recursive       list subdirectories recursively\n  -r, --reverse         reverse order while sorting\n  -t                    sort by time, newest first\n  -S                    sort by file size, largest first\n  -d, --directory       list directories themselves, not their contents\n  -F, --classify        append indicator (one of */) to entries",
  run(ctx) {
    const opts = parseOptions("ls", ctx.args, [
      { key: "all", short: "a", long: "all" },
      { key: "almost", short: "A", long: "almost-all" },
      { key: "long", short: "l" },
      { key: "human", short: "h", long: "human-readable" },
      { key: "one", short: "1" },
      { key: "recursive", short: "R", long: "recursive" },
      { key: "reverse", short: "r", long: "reverse" },
      { key: "time", short: "t" },
      { key: "size", short: "S" },
      { key: "directory", short: "d", long: "directory" },
      { key: "classify", short: "F", long: "classify" },
      { key: "color", long: "color", value: true },
      { key: "group", long: "group-directories-first" },
    ]);
    const { shell } = ctx;
    const colorMode = opts.get("color") ?? "auto";
    const tty = colorMode === "always" || (colorMode !== "never" && ctx.stdoutIsTTY);
    const showAll = opts.has("all");
    const showHidden = showAll || opts.has("almost");
    const long = opts.has("long");
    const onePerLine = opts.has("one") || !ctx.stdoutIsTTY;
    let status = 0;

    type Entry = { name: string; path: string; node: FsNode };

    const sortEntries = (entries: Entry[]): Entry[] => {
      const sorted = [...entries].sort((a, b) => {
        if (opts.has("group")) {
          const d = Number(b.node.type === "dir") - Number(a.node.type === "dir");
          if (d !== 0) return d;
        }
        if (opts.has("time")) return b.node.mtime - a.node.mtime || compareNames(a.name, b.name);
        if (opts.has("size")) return shell.fs.sizeOf(b.node) - shell.fs.sizeOf(a.node) || compareNames(a.name, b.name);
        return compareNames(a.name, b.name);
      });
      return opts.has("reverse") ? sorted.reverse() : sorted;
    };

    const render = (entries: Entry[], withTotal: boolean): string => {
      if (long) {
        const rows = entries.map((e) => {
          const links = e.node.type === "dir" ? 2 + [...e.node.children.values()].filter((c) => c.type === "dir").length : 1;
          const size = shell.fs.sizeOf(e.node);
          return {
            perms: permissions(e.node),
            links: String(links),
            size: opts.has("human") ? humanSize(size) : String(size),
            date: formatDate(e.node.mtime),
            name: colorName(e.name, e.node, tty) + (opts.has("classify") ? classify(e.node) : ""),
          };
        });
        const lw = Math.max(1, ...rows.map((r) => r.links.length));
        const sw = Math.max(1, ...rows.map((r) => r.size.length));
        const totalBlocks = entries.reduce((sum, e) => sum + (e.node.type === "file" ? Math.ceil(shell.fs.sizeOf(e.node) / 4096) * 4 : 4), 0);
        const lines = rows.map((r) => `${r.perms} ${r.links.padStart(lw)} ${shell.user} ${shell.user} ${r.size.padStart(sw)} ${r.date} ${r.name}`);
        return (withTotal ? `total ${opts.has("human") ? humanSize(totalBlocks * 1024) : totalBlocks}\n` : "") + (lines.length ? lines.join("\n") + "\n" : "");
      }
      const items = entries.map((e) => {
        const suffix = opts.has("classify") ? classify(e.node) : "";
        return { text: colorName(e.name, e.node, tty) + suffix, width: e.name.length + suffix.length };
      });
      if (items.length === 0) return "";
      return onePerLine ? items.map((i) => i.text).join("\n") + "\n" : columnize(items, shell.columns);
    };

    const listDir = (path: string, display: string): { output: string; subdirs: [string, string][] } => {
      const node = shell.fs.stat(path);
      if (node.type !== "dir") return { output: "", subdirs: [] };
      let entries: Entry[] = [...node.children.entries()]
        .filter(([name]) => showHidden || !name.startsWith("."))
        .map(([name, child]) => ({ name, path: joinPath(path, name), node: child }));
      entries = sortEntries(entries);
      if (showAll) {
        const parent = shell.fs.stat(dirname(path));
        entries = [{ name: ".", path, node }, { name: "..", path: dirname(path), node: parent }, ...entries];
      }
      const subdirs = entries
        .filter((e) => e.node.type === "dir" && e.name !== "." && e.name !== "..")
        .map((e) => [e.path, display === "." ? `./${e.name}` : `${display.replace(/\/$/, "")}/${e.name}`] as [string, string]);
      return { output: render(entries, true), subdirs };
    };

    const targets = opts.positionals.length > 0 ? opts.positionals : ["."];
    const files: Entry[] = [];
    const dirs: [string, string][] = [];
    for (const target of targets) {
      const abs = shell.resolve(target);
      const node = shell.fs.get(abs);
      if (!node) {
        ctx.stderr(`ls: cannot access '${target}': No such file or directory\n`);
        status = 2;
        continue;
      }
      if (node.type === "dir" && !opts.has("directory")) dirs.push([abs, target]);
      else files.push({ name: target, path: abs, node });
    }

    const chunks: string[] = [];
    if (files.length > 0) chunks.push(render(sortEntries(files), false));
    const showHeaders = dirs.length + files.length > 1 || opts.has("recursive");
    const queue = [...dirs];
    while (queue.length > 0) {
      const [abs, display] = queue.shift() as [string, string];
      const { output, subdirs } = listDir(abs, display);
      chunks.push((showHeaders ? `${display}:\n` : "") + output);
      if (opts.has("recursive")) queue.unshift(...subdirs);
    }
    ctx.stdout(chunks.filter((c) => c !== "").join("\n"));
    return status;
  },
};

async function readInputs(ctx: CommandContext, files: string[], onContent: (content: string, name: string) => void): Promise<number> {
  let status = 0;
  const targets = files.length > 0 ? files : ["-"];
  for (const file of targets) {
    if (file === "-") {
      onContent(ctx.stdin ?? "", "-");
      continue;
    }
    try {
      onContent(ctx.shell.fs.readFile(ctx.shell.resolve(file)), file);
    } catch (error) {
      if (error instanceof FsError) {
        ctx.stderr(`${ctx.name}: ${file}: ${error.message}\n`);
        status = 1;
      } else throw error;
    }
  }
  return status;
}

const cat: CommandSpec = {
  name: "cat",
  summary: "Concatenate files and print on the standard output.",
  usage: "cat [OPTION]... [FILE]...\n  -n, --number     number all output lines\n  -b               number nonempty output lines\n  -E, --show-ends  display $ at end of each line\n  -s               suppress repeated empty output lines",
  async run(ctx) {
    const opts = parseOptions(ctx.name, ctx.args, [
      { key: "number", short: "n", long: "number" },
      { key: "nonblank", short: "b", long: "number-nonblank" },
      { key: "ends", short: "E", long: "show-ends" },
      { key: "squeeze", short: "s", long: "squeeze-blank" },
      { key: "plain", short: "u" },
    ]);
    if (opts.positionals.length === 0 && ctx.stdin === null) {
      throw new CommandError("reading from the terminal is not supported in the simulator — pass a file or pipe input");
    }
    let lineNo = 0;
    let previousBlank = false;
    return readInputs(ctx, opts.positionals, (content) => {
      if (!opts.has("number") && !opts.has("nonblank") && !opts.has("ends") && !opts.has("squeeze")) {
        ctx.stdout(content);
        return;
      }
      const endsWithNewline = content.endsWith("\n");
      const lines = splitLines(content);
      const out: string[] = [];
      for (const line of lines) {
        const blank = line === "";
        if (opts.has("squeeze") && blank && previousBlank) continue;
        previousBlank = blank;
        let text = line + (opts.has("ends") ? "$" : "");
        if (opts.has("nonblank") ? !blank : opts.has("number")) text = `${String(++lineNo).padStart(6)}\t${text}`;
        out.push(text);
      }
      ctx.stdout(out.join("\n") + (endsWithNewline && out.length ? "\n" : ""));
    });
  },
};

const mkdir: CommandSpec = {
  name: "mkdir",
  summary: "Create directories.",
  usage: "mkdir [OPTION]... DIRECTORY...\n  -p, --parents  no error if existing, make parent directories as needed\n  -v, --verbose  print a message for each created directory",
  run(ctx) {
    const opts = parseOptions("mkdir", ctx.args, [
      { key: "parents", short: "p", long: "parents" },
      { key: "verbose", short: "v", long: "verbose" },
      { key: "mode", short: "m", long: "mode", value: true },
    ]);
    if (opts.positionals.length === 0) throw new CommandError("missing operand\nTry 'mkdir --help' for more information.");
    let status = 0;
    for (const dir of opts.positionals) {
      const abs = ctx.shell.resolve(dir);
      try {
        const existed = ctx.shell.fs.exists(abs);
        ctx.shell.fs.mkdir(abs, { parents: opts.has("parents") });
        if (opts.has("verbose") && !existed) ctx.stdout(`mkdir: created directory '${dir}'\n`);
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr(`mkdir: cannot create directory '${dir}': ${error.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};

const rmdir: CommandSpec = {
  name: "rmdir",
  summary: "Remove empty directories.",
  usage: "rmdir DIRECTORY...",
  run(ctx) {
    const opts = parseOptions("rmdir", ctx.args, [{ key: "parents", short: "p", long: "parents" }]);
    if (opts.positionals.length === 0) throw new CommandError("missing operand");
    let status = 0;
    for (const dir of opts.positionals) {
      try {
        ctx.shell.fs.rmdir(ctx.shell.resolve(dir));
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr(`rmdir: failed to remove '${dir}': ${error.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};

const touch: CommandSpec = {
  name: "touch",
  summary: "Change file timestamps, creating empty files that do not exist.",
  usage: "touch [-c] FILE...",
  run(ctx) {
    const opts = parseOptions("touch", ctx.args, [{ key: "nocreate", short: "c", long: "no-create" }]);
    if (opts.positionals.length === 0) throw new CommandError("missing file operand");
    let status = 0;
    for (const file of opts.positionals) {
      const abs = ctx.shell.resolve(file);
      if (opts.has("nocreate") && !ctx.shell.fs.exists(abs)) continue;
      try {
        ctx.shell.fs.touch(abs);
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        ctx.stderr(`touch: cannot touch '${file}': ${error.message}\n`);
        status = 1;
      }
    }
    return status;
  },
};

const rm: CommandSpec = {
  name: "rm",
  summary: "Remove files or directories.",
  usage: "rm [OPTION]... FILE...\n  -f, --force      ignore nonexistent files, never prompt\n  -r, -R, --recursive  remove directories and their contents recursively\n  -d, --dir        remove empty directories\n  -v, --verbose    explain what is being done",
  run(ctx) {
    const opts = parseOptions("rm", ctx.args, [
      { key: "force", short: "f", long: "force" },
      { key: "recursive", short: "r", long: "recursive" },
      { key: "recursive", short: "R" },
      { key: "dir", short: "d", long: "dir" },
      { key: "verbose", short: "v", long: "verbose" },
      { key: "interactive", short: "i" },
    ]);
    if (opts.positionals.length === 0) {
      if (opts.has("force")) return 0;
      throw new CommandError("missing operand\nTry 'rm --help' for more information.");
    }
    let status = 0;
    for (const target of opts.positionals) {
      const abs = ctx.shell.resolve(target);
      if (abs === "/") {
        ctx.stderr("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
        status = 1;
        continue;
      }
      if (ctx.shell.cwd === abs || ctx.shell.cwd.startsWith(abs + "/")) {
        ctx.stderr(`rm: refusing to remove '${target}': it contains the current working directory — cd out of it first\n`);
        status = 1;
        continue;
      }
      const node = ctx.shell.fs.get(abs);
      if (!node) {
        if (!opts.has("force")) {
          ctx.stderr(`rm: cannot remove '${target}': No such file or directory\n`);
          status = 1;
        }
        continue;
      }
      if (node.type === "dir" && !opts.has("recursive")) {
        if (opts.has("dir") && node.children.size === 0) {
          ctx.shell.fs.rmdir(abs);
          continue;
        }
        ctx.stderr(`rm: cannot remove '${target}': Is a directory\n`);
        status = 1;
        continue;
      }
      ctx.shell.fs.remove(abs, { recursive: true });
      if (opts.has("verbose")) ctx.stdout(node.type === "dir" ? `removed directory '${target}'\n` : `removed '${target}'\n`);
    }
    return status;
  },
};

function copyOrMove(ctx: CommandContext, mode: "cp" | "mv"): number {
  const opts = parseOptions(mode, ctx.args, [
    { key: "recursive", short: "r", long: "recursive" },
    { key: "recursive", short: "R" },
    { key: "recursive", short: "a", long: "archive" },
    { key: "verbose", short: "v", long: "verbose" },
    { key: "force", short: "f", long: "force" },
    { key: "noclobber", short: "n", long: "no-clobber" },
    { key: "interactive", short: "i" },
    { key: "target", short: "t", long: "target-directory", value: true },
  ]);
  const { shell } = ctx;
  const positionals = [...opts.positionals];
  let destination = opts.get("target");
  if (destination === undefined) {
    if (positionals.length < 2) {
      throw new CommandError(positionals.length === 0 ? "missing file operand" : `missing destination file operand after '${positionals[0]}'`);
    }
    destination = positionals.pop() as string;
  }
  const destAbs = shell.resolve(destination);
  const destIsDir = shell.fs.isDirectory(destAbs);
  if (positionals.length > 1 && !destIsDir) throw new CommandError(`target '${destination}': Not a directory`);

  let status = 0;
  for (const source of positionals) {
    const srcAbs = shell.resolve(source);
    const node = shell.fs.get(srcAbs);
    if (!node) {
      ctx.stderr(`${mode}: cannot stat '${source}': No such file or directory\n`);
      status = 1;
      continue;
    }
    const target = destIsDir ? joinPath(destAbs, basename(srcAbs)) : destAbs;
    if (target === srcAbs) {
      ctx.stderr(`${mode}: '${source}' and '${destination}' are the same file\n`);
      status = 1;
      continue;
    }
    if (opts.has("noclobber") && shell.fs.exists(target)) continue;
    try {
      if (mode === "cp") {
        if (node.type === "dir" && !opts.has("recursive")) {
          ctx.stderr(`cp: -r not specified; omitting directory '${source}'\n`);
          status = 1;
          continue;
        }
        shell.fs.copy(srcAbs, target, { recursive: true });
      } else {
        if (shell.cwd === srcAbs || shell.cwd.startsWith(srcAbs + "/")) {
          ctx.stderr(`mv: cannot move '${source}': it contains the current working directory\n`);
          status = 1;
          continue;
        }
        shell.fs.move(srcAbs, target);
      }
      if (opts.has("verbose")) {
        const shown = destIsDir ? `${destination.replace(/\/$/, "")}/${basename(srcAbs)}` : destination;
        ctx.stdout(mode === "mv" ? `renamed '${source}' -> '${shown}'\n` : `'${source}' -> '${shown}'\n`);
      }
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      const reason = error.code === "EINVAL" ? `cannot ${mode === "cp" ? "copy" : "move"} a directory, '${source}', into itself, '${destination}'` : `cannot ${mode === "cp" ? "create" : "move"} '${destination}': ${error.message}`;
      ctx.stderr(`${mode}: ${reason}\n`);
      status = 1;
    }
  }
  return status;
}

const cp: CommandSpec = {
  name: "cp",
  summary: "Copy files and directories.",
  usage: "cp [OPTION]... SOURCE... DEST\n  -r, -R, --recursive  copy directories recursively\n  -n, --no-clobber     do not overwrite an existing file\n  -v, --verbose        explain what is being done",
  run: (ctx) => copyOrMove(ctx, "cp"),
};

const mv: CommandSpec = {
  name: "mv",
  summary: "Move (rename) files.",
  usage: "mv [OPTION]... SOURCE... DEST\n  -n, --no-clobber  do not overwrite an existing file\n  -v, --verbose     explain what is being done",
  run: (ctx) => copyOrMove(ctx, "mv"),
};

const tree: CommandSpec = {
  name: "tree",
  summary: "List contents of directories in a tree-like format.",
  usage: "tree [-a] [-d] [-L level] [-I pattern] [--noreport] [directory...]",
  run(ctx) {
    const opts = parseOptions("tree", ctx.args, [
      { key: "all", short: "a" },
      { key: "dirs", short: "d" },
      { key: "level", short: "L", value: true },
      { key: "ignore", short: "I", value: true },
      { key: "full", short: "f" },
      { key: "noreport", long: "noreport" },
      { key: "color", short: "C" },
      { key: "nocolor", short: "n" },
    ]);
    const maxDepth = opts.get("level") !== undefined ? Number(opts.get("level")) : Infinity;
    if (Number.isNaN(maxDepth) || maxDepth < 1) throw new CommandError("Invalid level, must be greater than 0.");
    const ignore = opts.all("ignore").flatMap((p) => p.split("|"));
    const ignoreRegexes = ignore.map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"));
    const color = (ctx.stdoutIsTTY || opts.has("color")) && !opts.has("nocolor");
    let dirs = 0;
    let files = 0;
    let status = 0;
    const out: string[] = [];

    const walk = (abs: string, display: string, prefix: string, depth: number) => {
      const node = ctx.shell.fs.stat(abs);
      if (node.type !== "dir") return;
      const names = [...node.children.keys()]
        .filter((n) => opts.has("all") || !n.startsWith("."))
        .filter((n) => !ignoreRegexes.some((r) => r.test(n)))
        .filter((n) => !opts.has("dirs") || node.children.get(n)?.type === "dir")
        .sort(compareNames);
      names.forEach((name, index) => {
        const child = node.children.get(name) as FsNode;
        const last = index === names.length - 1;
        const childDisplay = `${display.replace(/\/$/, "")}/${name}`;
        const label = opts.has("full") ? childDisplay : name;
        out.push(`${prefix}${last ? "└── " : "├── "}${colorName(label, child, color)}`);
        if (child.type === "dir") {
          dirs++;
          if (depth < maxDepth) walk(joinPath(abs, name), childDisplay, prefix + (last ? "    " : "│   "), depth + 1);
        } else files++;
      });
    };

    const targets = opts.positionals.length ? opts.positionals : ["."];
    for (const target of targets) {
      const abs = ctx.shell.resolve(target);
      const node = ctx.shell.fs.get(abs);
      if (!node) {
        out.push(`${target}  [error opening dir]`);
        status = 2;
        continue;
      }
      out.push(colorName(target, node, color));
      if (node.type === "dir") walk(abs, target, "", 1);
    }
    if (!opts.has("noreport")) {
      out.push("");
      out.push(opts.has("dirs") ? `${dirs} ${dirs === 1 ? "directory" : "directories"}` : `${dirs} ${dirs === 1 ? "directory" : "directories"}, ${files} ${files === 1 ? "file" : "files"}`);
    }
    ctx.stdout(out.join("\n") + "\n");
    return status;
  },
};

type FindPredicate = (entry: { path: string; name: string; node: FsNode; depth: number }) => boolean;

function globToRegExp(pattern: string, flags = ""): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) source += "\\[";
      else {
        source += "[" + pattern.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      source += pattern[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i++;
    } else source += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(source + "$", flags);
}

const find: CommandSpec = {
  name: "find",
  summary: "Search for files in a directory hierarchy.",
  usage:
    "find [PATH...] [EXPRESSION]\n  -name PATTERN    base name matches shell PATTERN\n  -iname PATTERN   like -name, case-insensitive\n  -path PATTERN    whole path matches PATTERN\n  -type f|d        file type\n  -maxdepth N / -mindepth N\n  -empty           empty file or directory\n  -newer FILE      modified more recently than FILE\n  ! / -not EXPR    negate\n  EXPR -o EXPR     or",
  run(ctx) {
    const args = [...ctx.args];
    const paths: string[] = [];
    while (args.length > 0 && !args[0].startsWith("-") && args[0] !== "!" && args[0] !== "(") paths.push(args.shift() as string);
    if (paths.length === 0) paths.push(".");

    let maxDepth = Infinity;
    let minDepth = 0;
    // Expression: OR of AND-groups of (possibly negated) predicates.
    const groups: FindPredicate[][] = [[]];
    let negateNext = false;
    const push = (pred: FindPredicate) => {
      const negate = negateNext;
      negateNext = false;
      groups[groups.length - 1].push(negate ? (e) => !pred(e) : pred);
    };
    const need = (flag: string): string => {
      const value = args.shift();
      if (value === undefined) throw new CommandError(`missing argument to \`${flag}'`);
      return value;
    };

    while (args.length > 0) {
      const token = args.shift() as string;
      switch (token) {
        case "!":
        case "-not":
          negateNext = !negateNext;
          break;
        case "-a":
        case "-and":
          break;
        case "-o":
        case "-or":
          groups.push([]);
          break;
        case "-name": {
          const re = globToRegExp(need(token));
          push((e) => re.test(e.name));
          break;
        }
        case "-iname": {
          const re = globToRegExp(need(token), "i");
          push((e) => re.test(e.name));
          break;
        }
        case "-path":
        case "-wholename": {
          const re = globToRegExp(need(token));
          push((e) => re.test(e.path));
          break;
        }
        case "-type": {
          const type = need(token);
          if (type !== "f" && type !== "d") throw new CommandError(`Unknown argument to -type: ${type}`);
          push((e) => (type === "d" ? e.node.type === "dir" : e.node.type === "file"));
          break;
        }
        case "-maxdepth":
          maxDepth = Number(need(token));
          if (Number.isNaN(maxDepth)) throw new CommandError("Expected a positive decimal integer argument to -maxdepth");
          break;
        case "-mindepth":
          minDepth = Number(need(token));
          if (Number.isNaN(minDepth)) throw new CommandError("Expected a positive decimal integer argument to -mindepth");
          break;
        case "-empty":
          push((e) => (e.node.type === "dir" ? e.node.children.size === 0 : e.node.content.length === 0));
          break;
        case "-executable":
          push((e) => e.node.type === "dir" || e.node.executable);
          break;
        case "-newer": {
          const ref = need(token);
          const refNode = ctx.shell.fs.get(ctx.shell.resolve(ref));
          if (!refNode) throw new CommandError(`'${ref}': No such file or directory`);
          push((e) => e.node.mtime > refNode.mtime);
          break;
        }
        case "-print":
          break;
        case "-exec":
        case "-execdir":
        case "-delete":
          throw new CommandError(`${token} is not supported in the simulator — pipe the results into xargs instead (e.g. find . -name '*.log' | xargs rm)`);
        default:
          throw new CommandError(`unknown predicate \`${token}'`);
      }
    }

    const matches = (e: { path: string; name: string; node: FsNode; depth: number }) => groups.some((group) => group.every((pred) => pred(e)));
    let status = 0;
    const out: string[] = [];
    for (const start of paths) {
      const abs = ctx.shell.resolve(start);
      if (!ctx.shell.fs.exists(abs)) {
        ctx.stderr(`find: '${start}': No such file or directory\n`);
        status = 1;
        continue;
      }
      for (const entry of ctx.shell.fs.walk(abs, { maxDepth })) {
        if (entry.depth < minDepth) continue;
        const rel = entry.path === abs ? start : `${start.replace(/\/$/, "")}/${relativePath(entry.path, abs)}`;
        const info = { path: rel, name: entry.depth === 0 ? basename(start) || start : basename(entry.path), node: entry.node, depth: entry.depth };
        if (matches(info)) out.push(rel);
      }
    }
    if (out.length) ctx.stdout(out.join("\n") + "\n");
    return status;
  },
};

const chmod: CommandSpec = {
  name: "chmod",
  summary: "Change file mode bits (the simulator tracks the executable bit).",
  usage: "chmod MODE FILE...\n  e.g. chmod +x script.sh, chmod 755 script.sh, chmod -x file",
  run(ctx) {
    const args = ctx.args.filter((a) => a !== "-R" && a !== "-v");
    if (args.length < 2) throw new CommandError(args.length === 0 ? "missing operand" : `missing operand after '${args[0]}'`);
    const [mode, ...files] = args;
    let executable: boolean;
    if (/^[0-7]{3,4}$/.test(mode)) executable = (Number.parseInt(mode.slice(-3, -2), 8) & 1) === 1;
    else if (/^[ugoa]*\+[rwx]*x[rwx]*$/.test(mode)) executable = true;
    else if (/^[ugoa]*-[rwx]*x[rwx]*$/.test(mode)) executable = false;
    else if (/^[ugoa]*[+-=][rwx]+$/.test(mode)) return 0;
    else throw new CommandError(`invalid mode: '${mode}'`);
    let status = 0;
    for (const file of files) {
      const abs = ctx.shell.resolve(file);
      if (!ctx.shell.fs.exists(abs)) {
        ctx.stderr(`chmod: cannot access '${file}': No such file or directory\n`);
        status = 1;
        continue;
      }
      ctx.shell.fs.setExecutable(abs, executable);
    }
    return status;
  },
};

const basenameCmd: CommandSpec = {
  name: "basename",
  summary: "Strip directory and suffix from filenames.",
  usage: "basename NAME [SUFFIX]",
  run(ctx) {
    if (ctx.args.length === 0) throw new CommandError("missing operand");
    let name = basename(ctx.args[0].replace(/\/+$/, "") || "/");
    const suffix = ctx.args[1];
    if (suffix && name.endsWith(suffix) && name !== suffix) name = name.slice(0, -suffix.length);
    ctx.stdout(`${name}\n`);
    return 0;
  },
};

const dirnameCmd: CommandSpec = {
  name: "dirname",
  summary: "Strip last component from file name.",
  usage: "dirname NAME...",
  run(ctx) {
    if (ctx.args.length === 0) throw new CommandError("missing operand");
    for (const arg of ctx.args) {
      const trimmed = arg.replace(/\/+$/, "");
      const idx = trimmed.lastIndexOf("/");
      ctx.stdout(`${idx === -1 ? "." : idx === 0 ? "/" : trimmed.slice(0, idx)}\n`);
    }
    return 0;
  },
};

export const FILE_COMMANDS: CommandSpec[] = [cd, pwd, ls, cat, mkdir, rmdir, touch, rm, cp, mv, tree, find, chmod, basenameCmd, dirnameCmd];

export { readInputs, globToRegExp, colorName, humanSize };
