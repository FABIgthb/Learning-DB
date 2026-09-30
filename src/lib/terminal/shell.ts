/**
 * The simulated shell: variable/tilde/brace/glob expansion, command
 * substitution, pipelines, redirections, aliases, scripts and command dispatch.
 *
 * Everything is deterministic and DOM-free so the exact same code runs in the
 * browser (interactive terminal) and on the server (replay verification).
 */

import { stripAnsi } from "./ansi";
import { CommandError } from "./command";
import { COMMANDS } from "./commands";
import { FsError, VirtualFileSystem, basename, dirname, joinPath, normalizeAbsolute, resolvePath } from "./filesystem";
import { ParseError, parse, type CommandList, type Pipeline, type Redirect, type SimpleCommand, type Word, type WordPart } from "./parser";
import { environmentSpecSchema, type EnvironmentSpecInput, type ExecutionResult, type FzfRequest, type InteractiveHandlers, type OutputSink } from "./types";

export { CommandError } from "./command";
export type { CommandContext, CommandHandler, CommandSpec } from "./command";

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SUBSTITUTION_DEPTH = 8;
const MAX_SCRIPT_DEPTH = 8;

class OutputLimitError extends Error {}

type Target =
  | { kind: "sink"; write: (chunk: string) => void }
  | { kind: "buffer"; chunks: string[] }
  | { kind: "file"; path: string; chunks: string[] }
  | { kind: "null" };

interface IoContext {
  stdin: string | null;
  stdout: Target;
  stderr: Target;
  /** Whether stdout of this context ultimately reaches the terminal. */
  tty: boolean;
}

interface Field {
  segments: { text: string; glob: boolean }[];
  quoted: boolean;
}

export class Shell {
  fs: VirtualFileSystem;
  cwd: string;
  previousCwd: string | null = null;
  readonly home: string;
  readonly user: string;
  readonly hostname: string;
  vars: Map<string, string>;
  aliases = new Map<string, string>();
  positional: string[] = [];
  lastExitCode = 0;
  history: string[] = [];
  columns = 80;
  interactive: InteractiveHandlers | null;
  /** Selections made by interactive programs during the current top-level command. */
  private interactionLog: string[][] = [];
  /** Recorded selections to replay (server-side verification). */
  private replayQueue: string[][] | null = null;
  private substitutionDepth = 0;
  private scriptDepth = 0;
  private outputBytes = 0;

  constructor(options: {
    fs: VirtualFileSystem;
    cwd: string;
    home: string;
    user: string;
    hostname: string;
    env?: Record<string, string>;
    interactive?: InteractiveHandlers | null;
  }) {
    this.fs = options.fs;
    this.cwd = options.cwd;
    this.home = options.home;
    this.user = options.user;
    this.hostname = options.hostname;
    this.interactive = options.interactive ?? null;
    this.vars = new Map(
      Object.entries({
        HOME: options.home,
        USER: options.user,
        LOGNAME: options.user,
        HOSTNAME: options.hostname,
        SHELL: "/bin/bash",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        PWD: options.cwd,
        EDITOR: "vim",
        PAGER: "less",
        BAT_THEME: "Monokai Extended",
        FZF_DEFAULT_OPTS: "--height 40% --layout=reverse",
        ...options.env,
      }),
    );
  }

  /** Build a fresh shell from a lesson's environment spec. */
  static fromSpec(input: EnvironmentSpecInput | unknown, options: { interactive?: InteractiveHandlers | null } = {}): Shell {
    const spec = environmentSpecSchema.parse(input ?? {});
    const home = normalizeAbsolute(spec.home ?? `/home/${spec.user}`);
    const fs = new VirtualFileSystem();
    for (const dir of ["/bin", "/etc", "/tmp", "/usr/bin", "/var/log", home]) fs.mkdir(dir, { parents: true });
    fs.writeFile("/etc/hostname", `${spec.hostname}\n`);
    fs.writeFile(
      "/etc/os-release",
      'NAME="Debian GNU/Linux"\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n',
    );

    const entries = Object.entries(spec.files).sort(([a], [b]) => a.localeCompare(b));
    for (const [rawPath, content] of entries) {
      const abs = resolvePath(rawPath, home, home);
      if (rawPath.endsWith("/")) {
        fs.mkdir(abs, { parents: true });
        continue;
      }
      fs.mkdir(dirname(abs), { parents: true });
      fs.writeFile(abs, content ?? "", { executable: /\.(sh|bash)$/.test(abs) || (content ?? "").startsWith("#!") });
    }
    for (const exe of spec.executables) {
      const abs = resolvePath(exe, home, home);
      if (fs.isFile(abs)) fs.setExecutable(abs, true);
    }
    const cwd = spec.cwd ? resolvePath(spec.cwd, home, home) : home;
    if (!fs.isDirectory(cwd)) fs.mkdir(cwd, { parents: true });

    return new Shell({
      fs,
      cwd,
      home,
      user: spec.user,
      hostname: spec.hostname,
      env: spec.env,
      interactive: options.interactive ?? null,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /** Independent copy (file system + variables) for side-effect-free previews. */
  sandbox(): Shell {
    const copy = new Shell({
      fs: this.fs.clone(),
      cwd: this.cwd,
      home: this.home,
      user: this.user,
      hostname: this.hostname,
      interactive: null,
    });
    copy.vars = new Map(this.vars);
    copy.aliases = new Map(this.aliases);
    copy.columns = this.columns;
    copy.lastExitCode = this.lastExitCode;
    return copy;
  }

  resolve(path: string): string {
    return resolvePath(path, this.cwd, this.home);
  }

  /** Path shown in the prompt (`~/projects`). */
  displayCwd(): string {
    if (this.cwd === this.home) return "~";
    if (this.cwd.startsWith(this.home + "/")) return "~" + this.cwd.slice(this.home.length);
    return this.cwd;
  }

  setCwd(path: string): void {
    this.previousCwd = this.cwd;
    this.cwd = path;
    this.vars.set("OLDPWD", this.previousCwd);
    this.vars.set("PWD", path);
  }

  /**
   * Execute one line of user input.
   * `sink` receives terminal output as it is produced (before interactive prompts).
   * `replay` provides recorded fzf selections for deterministic re-execution.
   */
  async execute(input: string, sink?: OutputSink, replay?: string[][]): Promise<ExecutionResult> {
    const cwdBefore = this.cwd;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    this.interactionLog = [];
    this.replayQueue = replay ? replay.map((r) => [...r]) : null;
    this.outputBytes = 0;

    const guard = (chunk: string) => {
      this.outputBytes += chunk.length;
      if (this.outputBytes > MAX_OUTPUT_BYTES) throw new OutputLimitError();
    };
    const io: IoContext = {
      stdin: null,
      tty: true,
      stdout: {
        kind: "sink",
        write: (chunk) => {
          guard(chunk);
          stdoutChunks.push(chunk);
          sink?.stdout(chunk);
        },
      },
      stderr: {
        kind: "sink",
        write: (chunk) => {
          stderrChunks.push(chunk);
          sink?.stderr(chunk);
        },
      },
    };

    const trimmed = input.trim();
    if (trimmed !== "") {
      this.history.push(input);
      if (this.history.length > 1000) this.history.shift();
    }

    let exitCode = this.lastExitCode;
    try {
      const list = parse(input);
      if (list.items.length > 0) exitCode = await this.executeList(list, io);
    } catch (error) {
      exitCode = this.reportFatal(error, io);
    }
    this.lastExitCode = exitCode;
    this.replayQueue = null;

    return {
      input,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      exitCode,
      cwdBefore,
      cwdAfter: this.cwd,
      interactions: this.interactionLog,
    };
  }

  /** Run fzf's interactive picker (or consume a recorded selection during replay). */
  async pick(request: FzfRequest): Promise<string[] | null> {
    let selection: string[] | null;
    if (this.replayQueue) {
      const recorded = this.replayQueue.shift();
      selection = recorded ?? null;
    } else if (this.interactive) {
      selection = await this.interactive.fzf(request);
    } else {
      selection = null;
    }
    if (selection) this.interactionLog.push(selection);
    return selection;
  }

  /** Run a command line with captured output (used by fzf --preview and xargs). */
  async capture(input: string, stdin: string | null = null): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: IoContext = {
      stdin,
      tty: false,
      stdout: { kind: "buffer", chunks: out },
      stderr: { kind: "buffer", chunks: err },
    };
    let exitCode: number;
    try {
      exitCode = await this.executeList(parse(input), io);
    } catch (error) {
      exitCode = this.reportFatal(error, io);
    }
    return { stdout: out.join(""), stderr: err.join(""), exitCode };
  }

  /** Execute argv directly (no parsing), used by xargs. */
  async runArgv(argv: string[], io: { stdin: string | null; stdout: (s: string) => void; stderr: (s: string) => void; tty: boolean }): Promise<number> {
    return this.dispatch(argv, {
      stdin: io.stdin,
      tty: io.tty,
      stdout: { kind: "sink", write: io.stdout },
      stderr: { kind: "sink", write: io.stderr },
    });
  }

  /** Tab completion candidates for the word under the cursor. */
  complete(line: string): { replaceFrom: number; candidates: string[] } {
    const match = /(\S*)$/.exec(line) as RegExpExecArray;
    const word = match[1];
    const replaceFrom = line.length - word.length;
    const before = line.slice(0, replaceFrom);
    const isCommandPosition = /(^|[|;&])\s*$/.test(before);
    if (isCommandPosition && !word.includes("/")) {
      const names = [...Object.keys(COMMANDS), ...this.aliases.keys()].filter((n) => n.startsWith(word)).sort();
      return { replaceFrom, candidates: [...new Set(names)] };
    }
    const slash = word.lastIndexOf("/");
    const dirPart = slash === -1 ? "" : word.slice(0, slash + 1);
    const prefix = word.slice(slash + 1);
    const dirAbs = this.resolve(dirPart === "" ? "." : dirPart);
    if (!this.fs.isDirectory(dirAbs)) return { replaceFrom, candidates: [] };
    const candidates = this.fs
      .readdir(dirAbs)
      .filter((name) => name.startsWith(prefix) && (prefix.startsWith(".") || !name.startsWith(".")))
      .map((name) => dirPart + name + (this.fs.isDirectory(joinPath(dirAbs, name)) ? "/" : ""));
    return { replaceFrom, candidates };
  }

  /* ---------------------------------------------------------------- */
  /* Execution                                                         */
  /* ---------------------------------------------------------------- */

  private reportFatal(error: unknown, io: IoContext): number {
    if (error instanceof OutputLimitError) {
      this.write(io.stderr, "\nbash: output limit exceeded (2 MB) — command aborted\n");
      return 1;
    }
    if (error instanceof ParseError) {
      this.write(io.stderr, `bash: ${error.message}\n`);
      return 2;
    }
    if (error instanceof FsError) {
      this.write(io.stderr, `bash: ${error.path}: ${error.message}\n`);
      return 1;
    }
    this.write(io.stderr, `bash: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  private write(target: Target, chunk: string): void {
    if (chunk === "") return;
    switch (target.kind) {
      case "sink":
        target.write(chunk);
        return;
      case "buffer":
      case "file":
        target.chunks.push(chunk);
        return;
      case "null":
        return;
    }
  }

  async executeList(list: CommandList, io: IoContext): Promise<number> {
    let status = this.lastExitCode;
    let skip = false;
    for (const item of list.items) {
      if (!skip) {
        status = await this.executePipeline(item.pipeline, io);
        this.lastExitCode = status;
      }
      if (item.next === "&&") skip = status !== 0;
      else if (item.next === "||") skip = status === 0;
      else skip = false;
    }
    return status;
  }

  private async executePipeline(pipeline: Pipeline, io: IoContext): Promise<number> {
    let stdin = io.stdin;
    let status = 0;
    for (let i = 0; i < pipeline.commands.length; i++) {
      const last = i === pipeline.commands.length - 1;
      const pipeChunks: string[] = [];
      const commandIo: IoContext = {
        stdin,
        stdout: last ? io.stdout : { kind: "buffer", chunks: pipeChunks },
        stderr: io.stderr,
        tty: last ? io.tty : false,
      };
      status = await this.executeSimple(pipeline.commands[i], commandIo);
      stdin = pipeChunks.join("");
    }
    return status;
  }

  private async executeSimple(command: SimpleCommand, io: IoContext): Promise<number> {
    // Alias expansion (first word only, unquoted, one level deep).
    const firstWord = command.words[0];
    if (firstWord && firstWord.parts.length === 1 && firstWord.parts[0].kind === "text" && firstWord.parts[0].quote === "none") {
      const alias = this.aliases.get(firstWord.parts[0].value);
      if (alias !== undefined) {
        const aliased = parse(alias);
        if (aliased.items.length === 1 && aliased.items[0].pipeline.commands.length === 1) {
          const inner = aliased.items[0].pipeline.commands[0];
          command = {
            assignments: [...command.assignments, ...inner.assignments],
            words: [...inner.words, ...command.words.slice(1)],
            redirects: [...inner.redirects, ...command.redirects],
          };
        } else {
          const rest = command.words.slice(1).map((w) => w.raw).join(" ");
          return this.executeList(parse(`${alias} ${rest}`), io);
        }
      }
    }

    const argv: string[] = [];
    for (const word of command.words) argv.push(...(await this.expandWord(word, io)));

    const assignments: [string, string][] = [];
    for (const assignment of command.assignments) {
      const value = (await this.expandWord(assignment.value, io, { split: false, glob: false })).join(" ");
      assignments.push([assignment.name, value]);
    }

    let redirected: IoContext;
    let files: Extract<Target, { kind: "file" }>[];
    try {
      ({ io: redirected, files } = await this.applyRedirects(command.redirects, io));
    } catch (error) {
      if (error instanceof CommandError) {
        this.write(io.stderr, `bash: ${error.message}\n`);
        return 1;
      }
      throw error;
    }

    let status: number;
    if (argv.length === 0) {
      for (const [name, value] of assignments) this.vars.set(name, value);
      status = 0;
    } else {
      const saved = assignments.map(([name]) => [name, this.vars.get(name)] as const);
      for (const [name, value] of assignments) this.vars.set(name, value);
      try {
        status = await this.dispatch(argv, redirected);
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) this.vars.delete(name);
          else this.vars.set(name, value);
        }
      }
    }

    for (const file of files) {
      try {
        this.fs.writeFile(file.path, file.chunks.join(""), { append: true });
      } catch (error) {
        if (error instanceof FsError) {
          this.write(io.stderr, `bash: ${file.path}: ${error.message}\n`);
          status = 1;
        } else throw error;
      }
    }
    return status;
  }

  private async applyRedirects(redirects: Redirect[], io: IoContext): Promise<{ io: IoContext; files: Extract<Target, { kind: "file" }>[] }> {
    const result: IoContext = { ...io };
    const files: Extract<Target, { kind: "file" }>[] = [];
    for (const redirect of redirects) {
      if (redirect.op === "dup") {
        if (redirect.fd === 2 && redirect.toFd === 1) result.stderr = result.stdout;
        if (redirect.fd === 1 && redirect.toFd === 2) {
          result.stdout = result.stderr;
          result.tty = io.tty && result.stderr.kind === "sink";
        }
        continue;
      }
      const fields = await this.expandWord(redirect.target as Word, io);
      if (fields.length !== 1) throw new CommandError(`${(redirect.target as Word).raw}: ambiguous redirect`);
      const targetPath = fields[0];

      if (redirect.op === "<") {
        const abs = this.resolve(targetPath);
        try {
          result.stdin = this.fs.readFile(abs);
        } catch (error) {
          if (error instanceof FsError) throw new CommandError(`${targetPath}: ${error.message}`);
          throw error;
        }
        continue;
      }

      let target: Target;
      if (targetPath === "/dev/null") {
        target = { kind: "null" };
      } else if (targetPath === "/dev/stdout") {
        target = io.stdout;
      } else if (targetPath === "/dev/stderr") {
        target = io.stderr;
      } else {
        const abs = this.resolve(targetPath);
        if (this.fs.isDirectory(abs)) throw new CommandError(`${targetPath}: Is a directory`);
        try {
          if (redirect.op === ">") this.fs.writeFile(abs, "");
          else if (!this.fs.exists(abs)) this.fs.writeFile(abs, "");
        } catch (error) {
          if (error instanceof FsError) throw new CommandError(`${targetPath}: ${error.message}`);
          throw error;
        }
        const existing = files.find((f) => f.path === abs);
        if (existing) target = existing;
        else {
          const fileTarget: Extract<Target, { kind: "file" }> = { kind: "file", path: abs, chunks: [] };
          files.push(fileTarget);
          target = fileTarget;
        }
      }
      if (redirect.fd === 1 || redirect.fd === "both") {
        result.stdout = target;
        result.tty = target.kind === "sink" && io.tty;
      }
      if (redirect.fd === 2 || redirect.fd === "both") result.stderr = target;
    }
    return { io: result, files };
  }

  private async dispatch(argv: string[], io: IoContext): Promise<number> {
    const [name, ...args] = argv;
    const stdout = (chunk: string) => this.write(io.stdout, chunk);
    const stderr = (chunk: string) => this.write(io.stderr, chunk);

    if (name.includes("/")) return this.runScriptFile(name, args, io);

    const spec = COMMANDS[name];
    if (!spec) {
      stderr(`${name}: command not found\n`);
      const suggestion = Object.keys(COMMANDS).find((n) => levenshtein(n, name) === 1);
      if (suggestion) stderr(`  did you mean: ${suggestion}?\n`);
      return 127;
    }
    const helpIndex = args.indexOf("--help");
    const dashDash = args.indexOf("--");
    if (!spec.literalHelp && helpIndex !== -1 && (dashDash === -1 || helpIndex < dashDash)) {
      stdout(`${spec.usage}\n\n${spec.summary}\n`);
      return 0;
    }
    const prefix = spec.builtin ? `bash: ${name}` : name;
    try {
      return await spec.run({ name, args, stdin: io.stdin, stdout, stderr, stdoutIsTTY: io.tty, shell: this });
    } catch (error) {
      if (error instanceof CommandError) {
        stderr(`${prefix}: ${error.message}\n`);
        return error.exitCode;
      }
      if (error instanceof FsError) {
        stderr(`${prefix}: ${error.path}: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }

  /** Execute `./script.sh` (or `bash script.sh`) line by line. */
  async runScriptFile(path: string, args: string[], io: IoContext, requireExecutable = true): Promise<number> {
    const abs = this.resolve(path);
    const node = this.fs.get(abs);
    if (!node) {
      this.write(io.stderr, `bash: ${path}: No such file or directory\n`);
      return 127;
    }
    if (node.type === "dir") {
      this.write(io.stderr, `bash: ${path}: Is a directory\n`);
      return 126;
    }
    if (requireExecutable && !node.executable) {
      this.write(io.stderr, `bash: ${path}: Permission denied\n`);
      return 126;
    }
    if (this.scriptDepth >= MAX_SCRIPT_DEPTH) {
      this.write(io.stderr, `bash: ${path}: maximum script nesting depth exceeded\n`);
      return 1;
    }
    const savedPositional = this.positional;
    this.positional = [basename(abs), ...args];
    this.scriptDepth++;
    let status = 0;
    try {
      for (const line of node.content.split("\n")) {
        if (line.trim() === "" || line.trim().startsWith("#")) continue;
        status = await this.executeList(parse(line), io);
        this.lastExitCode = status;
      }
    } finally {
      this.scriptDepth--;
      this.positional = savedPositional;
    }
    return status;
  }

  /** Source a file in the current shell (`source file` / `. file`). */
  async sourceFile(path: string, io: { stdout: (s: string) => void; stderr: (s: string) => void; stdin: string | null; tty: boolean }): Promise<number> {
    return this.runScriptFile(path, [], { stdin: io.stdin, tty: io.tty, stdout: { kind: "sink", write: io.stdout }, stderr: { kind: "sink", write: io.stderr } }, false);
  }

  /* ---------------------------------------------------------------- */
  /* Expansion                                                         */
  /* ---------------------------------------------------------------- */

  private variable(name: string): string {
    if (name === "?") return String(this.lastExitCode);
    if (name === "$") return "4242";
    if (name === "#") return String(Math.max(0, this.positional.length - 1));
    if (name === "@") return this.positional.slice(1).join(" ");
    if (/^[0-9]$/.test(name)) {
      if (name === "0") return this.positional[0] ?? "bash";
      return this.positional[Number(name)] ?? "";
    }
    if (name === "PWD") return this.cwd;
    return this.vars.get(name) ?? "";
  }

  private async substitute(source: string, io: IoContext): Promise<string> {
    if (this.substitutionDepth >= MAX_SUBSTITUTION_DEPTH) throw new ParseError("command substitution nested too deeply");
    this.substitutionDepth++;
    const savedCwd = this.cwd;
    const savedPrev = this.previousCwd;
    const savedVars = new Map(this.vars);
    const chunks: string[] = [];
    try {
      await this.executeList(parse(source), {
        stdin: null,
        tty: false,
        stdout: { kind: "buffer", chunks },
        stderr: io.stderr,
      });
    } finally {
      this.substitutionDepth--;
      // $(...) runs in a subshell: directory and variable changes do not leak.
      this.cwd = savedCwd;
      this.previousCwd = savedPrev;
      this.vars = savedVars;
    }
    return stripAnsi(chunks.join("")).replace(/\n+$/, "");
  }

  async expandWord(word: Word, io: IoContext, options: { split?: boolean; glob?: boolean } = {}): Promise<string[]> {
    const split = options.split ?? true;
    const glob = options.glob ?? true;
    const results: string[] = [];
    for (const braced of expandBraces(word.parts)) {
      const fields = await this.expandParts(braced, io, split);
      for (const field of fields) {
        const hasGlob = glob && field.segments.some((s) => s.glob && /[*?[]/.test(s.text));
        if (hasGlob) {
          const matches = this.glob(field);
          if (matches.length > 0) {
            results.push(...matches);
            continue;
          }
        }
        results.push(field.segments.map((s) => s.text).join(""));
      }
    }
    return results;
  }

  private async expandParts(parts: WordPart[], io: IoContext, split: boolean): Promise<Field[]> {
    const fields: Field[] = [];
    let current: Field = { segments: [], quoted: false };
    let started = false;

    const appendSplit = (value: string) => {
      if (!split) {
        current.segments.push({ text: value, glob: true });
        started = true;
        return;
      }
      const pieces = value.split(/[ \t\n]+/);
      pieces.forEach((piece, index) => {
        if (index > 0) {
          if (started && (current.segments.some((s) => s.text !== "") || current.quoted)) fields.push(current);
          current = { segments: [], quoted: false };
          started = false;
        }
        if (piece !== "") {
          current.segments.push({ text: piece, glob: true });
          started = true;
        }
      });
    };

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.kind === "text") {
        let text = part.value;
        if (i === 0 && part.quote === "none" && (text === "~" || text.startsWith("~/"))) {
          text = this.home + text.slice(1);
        }
        if (part.quote !== "none") current.quoted = true;
        current.segments.push({ text, glob: part.quote === "none" });
        started = true;
        continue;
      }
      const value = part.kind === "var" ? this.variable(part.name) : await this.substitute(part.source, io);
      if (part.quote === "double") {
        current.quoted = true;
        current.segments.push({ text: value, glob: false });
        started = true;
      } else {
        appendSplit(value);
      }
    }
    if (started && (current.segments.some((s) => s.text !== "") || current.quoted)) fields.push(current);
    return fields;
  }

  private glob(field: Field): string[] {
    // Build a list of characters flagged as "special" (unquoted glob chars).
    const chars: { ch: string; special: boolean }[] = [];
    for (const segment of field.segments) for (const ch of segment.text) chars.push({ ch, special: segment.glob && /[*?[\]!-]/.test(ch) });

    const components: { ch: string; special: boolean }[][] = [[]];
    for (const c of chars) {
      if (c.ch === "/") components.push([]);
      else components[components.length - 1].push(c);
    }
    const absolute = chars[0]?.ch === "/";
    if (absolute) components.shift();

    let candidates: { display: string; abs: string }[] = [{ display: absolute ? "/" : "", abs: absolute ? "/" : this.cwd }];
    for (let ci = 0; ci < components.length; ci++) {
      const component = components[ci];
      const isLast = ci === components.length - 1;
      if (component.length === 0) {
        // Trailing slash: only keep directories.
        candidates = candidates.filter((c) => this.fs.isDirectory(c.abs)).map((c) => ({ display: c.display.endsWith("/") ? c.display : c.display + "/", abs: c.abs }));
        continue;
      }
      const literal = component.map((c) => c.ch).join("");
      const hasSpecial = component.some((c) => c.special && /[*?[]/.test(c.ch));
      const next: { display: string; abs: string }[] = [];
      for (const candidate of candidates) {
        const prefix = candidate.display === "" ? "" : candidate.display.endsWith("/") ? candidate.display : candidate.display + "/";
        if (!hasSpecial) {
          const abs = joinPath(candidate.abs, literal);
          if (literal === "." || literal === ".." || this.fs.exists(normalizeAbsolute(abs))) {
            next.push({ display: prefix + literal, abs: normalizeAbsolute(abs) });
          }
          continue;
        }
        if (!this.fs.isDirectory(candidate.abs)) continue;
        const regex = globComponentToRegex(component);
        const allowHidden = component[0]?.ch === ".";
        for (const name of this.fs.readdir(candidate.abs)) {
          if (name.startsWith(".") && !allowHidden) continue;
          if (!regex.test(name)) continue;
          const abs = joinPath(candidate.abs, name);
          if (!isLast && !this.fs.isDirectory(abs)) continue;
          next.push({ display: prefix + name, abs });
        }
      }
      candidates = next;
      if (candidates.length === 0) return [];
    }
    return candidates.map((c) => c.display).sort();
  }
}

function globComponentToRegex(component: { ch: string; special: boolean }[]): RegExp {
  let source = "^";
  for (let i = 0; i < component.length; i++) {
    const { ch, special } = component[i];
    if (special && ch === "*") source += "[^/]*";
    else if (special && ch === "?") source += "[^/]";
    else if (special && ch === "[") {
      let j = i + 1;
      let cls = "";
      if (component[j] && (component[j].ch === "!" || component[j].ch === "^")) {
        cls += "^";
        j++;
      }
      while (j < component.length && component[j].ch !== "]") {
        cls += component[j].ch === "\\" ? "\\\\" : component[j].ch;
        j++;
      }
      if (j < component.length) {
        source += `[${cls}]`;
        i = j;
      } else {
        source += "\\[";
      }
    } else source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

/** Brace expansion (`{a,b}`, `{1..5}`, `{a..e}`) on unquoted text parts. */
export function expandBraces(parts: WordPart[]): WordPart[][] {
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (part.kind !== "text" || part.quote !== "none") continue;
    const text = part.value;
    for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
      let depth = 0;
      let close = -1;
      const commas: number[] = [];
      for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        } else if (text[i] === "," && depth === 1) commas.push(i);
      }
      if (close === -1) break;
      const inner = text.slice(open + 1, close);
      let alternatives: string[] | null = null;
      if (commas.length > 0) {
        alternatives = [];
        let start = open + 1;
        for (const comma of [...commas, close]) {
          alternatives.push(text.slice(start, comma));
          start = comma + 1;
        }
      } else {
        const range = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^([a-zA-Z])\.\.([a-zA-Z])$/.exec(inner);
        if (range) {
          alternatives = [];
          if (range[1] !== undefined) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            const step = Math.abs(Number(range[3] ?? 1)) || 1;
            const width = /^-?0\d/.test(range[1]) || /^-?0\d/.test(range[2]) ? Math.max(range[1].length, range[2].length) : 0;
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
              alternatives.push(width ? String(n).padStart(width, "0") : String(n));
              if (alternatives.length > 10_000) break;
            }
          } else {
            const from = (range[4] as string).charCodeAt(0);
            const to = (range[5] as string).charCodeAt(0);
            for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? 1 : -1) alternatives.push(String.fromCharCode(n));
          }
        }
      }
      if (!alternatives) continue;
      const before = text.slice(0, open);
      const after = text.slice(close + 1);
      const out: WordPart[][] = [];
      for (const alt of alternatives) {
        const replaced: WordPart[] = [...parts.slice(0, pi), { kind: "text", value: before + alt + after, quote: "none" }, ...parts.slice(pi + 1)];
        out.push(...expandBraces(replaced));
        if (out.length > 10_000) break;
      }
      return out;
    }
  }
  return [parts];
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}
