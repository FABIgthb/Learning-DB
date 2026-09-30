/** bat: cat with syntax highlighting, line numbers, a file header and a grid. */

import { ansi, stripAnsi } from "../ansi";
import { CommandError, type CommandSpec } from "../command";
import { LANGUAGES, detectLanguage, findLanguage, highlight } from "../highlight";
import { parseOptions } from "./args";

const GRID = (s: string) => ansi.rgb(88, 88, 88, s);
const LINE_NO = (s: string) => ansi.rgb(117, 113, 94, s);
const HIGHLIGHT_BG = "\x1b[48;2;62;61;50m";

type StyleComponent = "numbers" | "grid" | "header" | "header-filename" | "rule" | "snip" | "changes";

function parseStyle(style: string): Set<StyleComponent> {
  const out = new Set<StyleComponent>();
  for (const part of style.split(",").map((s) => s.trim())) {
    switch (part) {
      case "full":
      case "default":
      case "auto":
        ["numbers", "grid", "header", "header-filename", "snip", "changes"].forEach((p) => out.add(p as StyleComponent));
        break;
      case "plain":
        break;
      case "header":
        out.add("header");
        out.add("header-filename");
        break;
      case "numbers":
      case "grid":
      case "rule":
      case "snip":
      case "changes":
      case "header-filename":
        out.add(part);
        break;
      default:
        throw new CommandError(`[bat error]: Unknown style '${part}'`);
    }
  }
  return out;
}

function parseRanges(specs: string[], total: number): ((line: number) => boolean) | null {
  if (specs.length === 0) return null;
  const ranges = specs.map((spec) => {
    const m = /^(\d*)(:?)(\+?)(\d*)$/.exec(spec);
    if (!m) throw new CommandError(`[bat error]: invalid line range '${spec}'`);
    const start = m[1] ? Number(m[1]) : 1;
    if (!m[2]) return [start, start] as const;
    if (m[3]) return [start, start + Number(m[4] || 0)] as const;
    return [start, m[4] ? Number(m[4]) : total] as const;
  });
  return (line) => ranges.some(([s, e]) => line >= s && line <= e);
}

function showNonPrintable(line: string): string {
  return line.replace(/\t/g, "├──┤").replace(/ /g, "·").replace(/\r/g, "␍") + "␊";
}

const bat: CommandSpec = {
  name: "bat",
  summary: "A cat(1) clone with syntax highlighting and Git integration.",
  usage: [
    "bat [OPTIONS] [FILE]...",
    "",
    "  -l, --language LANG        set the language for syntax highlighting",
    "  -p, --plain                show plain style (alias for --style=plain)",
    "  -n, --number               only show line numbers, no other decorations",
    "  -A, --show-all             show non-printable characters",
    "  -r, --line-range N:M       only print lines N to M (e.g. 30:40, :40, 40:, 40:+10)",
    "  -H, --highlight-line N     highlight line N (or a range N:M)",
    "      --style STYLE          full, plain, numbers, header, grid, rule, snip",
    "      --color WHEN           auto, never, always",
    "      --decorations WHEN     auto, never, always",
    "      --file-name NAME       name to show in the header",
    "      --paging WHEN          accepted for compatibility (the simulator never pages)",
    "  -L, --list-languages       list supported languages",
    "      --list-themes          list themes",
    "      --theme THEME          accepted for compatibility",
  ].join("\n"),
  run(ctx) {
    const opts = parseOptions(ctx.name, ctx.args, [
      { key: "language", short: "l", long: "language", value: true },
      { key: "plain", short: "p", long: "plain" },
      { key: "number", short: "n", long: "number" },
      { key: "showAll", short: "A", long: "show-all" },
      { key: "range", short: "r", long: "line-range", value: true },
      { key: "highlight", short: "H", long: "highlight-line", value: true },
      { key: "style", long: "style", value: true },
      { key: "color", long: "color", value: true },
      { key: "decorations", long: "decorations", value: true },
      { key: "fileName", long: "file-name", value: true },
      { key: "paging", long: "paging", value: true },
      { key: "listLanguages", short: "L", long: "list-languages" },
      { key: "listThemes", long: "list-themes" },
      { key: "theme", long: "theme", value: true },
      { key: "wrap", long: "wrap", value: true },
      { key: "terminalWidth", long: "terminal-width", value: true },
      { key: "tabs", long: "tabs", value: true },
      { key: "unbuffered", short: "u", long: "unbuffered" },
    ]);

    if (opts.has("listLanguages")) {
      const lines = LANGUAGES.map((l) => {
        const exts = [...l.extensions, ...(l.filenames ?? [])].join(",");
        return ctx.stdoutIsTTY ? `${ansi.bold(l.name.padEnd(28))}${exts}` : `${l.name}:${exts}`;
      });
      ctx.stdout(lines.join("\n") + "\n");
      return 0;
    }
    if (opts.has("listThemes")) {
      ctx.stdout(["Monokai Extended (default)", "OneHalfDark", "Dracula", "Nord", "GitHub"].join("\n") + "\n");
      return 0;
    }

    const colorMode = opts.get("color") ?? "auto";
    const decoMode = opts.get("decorations") ?? "auto";
    const color = colorMode === "always" || (colorMode === "auto" && ctx.stdoutIsTTY);
    const decorationsAllowed = decoMode === "always" || (decoMode === "auto" && ctx.stdoutIsTTY);

    let style: Set<StyleComponent>;
    if (opts.has("plain")) style = new Set();
    else if (opts.has("number")) style = new Set(["numbers"]);
    else style = parseStyle(opts.get("style") ?? ctx.shell.vars.get("BAT_STYLE") ?? "default");
    if (!decorationsAllowed) style = new Set();

    const languageOverride = opts.get("language");
    const forcedLanguage = languageOverride ? findLanguage(languageOverride) : null;
    if (languageOverride && !forcedLanguage) throw new CommandError(`[bat error]: unknown syntax: '${languageOverride}'`);

    const files = opts.positionals.length > 0 ? opts.positionals : ctx.stdin !== null ? ["-"] : [];
    if (files.length === 0) {
      throw new CommandError("[bat error]: no input — reading from the terminal is not supported in the simulator. Pass a file (bat FILE) or pipe input.");
    }

    const width = Math.max(40, ctx.shell.columns);
    const numberWidth = 4;
    const gutter = style.has("numbers") ? numberWidth + 3 : 0;
    const hasGrid = style.has("grid");
    let status = 0;
    const blocks: string[] = [];

    files.forEach((file, index) => {
      let content: string;
      let displayName: string;
      if (file === "-") {
        content = ctx.stdin ?? "";
        displayName = opts.get("fileName") ?? "STDIN";
      } else {
        const abs = ctx.shell.resolve(file);
        const node = ctx.shell.fs.get(abs);
        if (!node) {
          ctx.stderr(`[bat error]: '${file}': No such file or directory (os error 2)\n`);
          status = 1;
          return;
        }
        if (node.type === "dir") {
          ctx.stderr(`[bat error]: '${file}' is a directory.\n`);
          status = 1;
          return;
        }
        content = node.content;
        displayName = opts.get("fileName") ?? file;
      }
      const plainContent = stripAnsi(content);
      const lang = forcedLanguage ?? detectLanguage(displayName === "STDIN" ? "" : displayName, plainContent.split("\n", 1)[0]);
      const rawLines = plainContent.split("\n");
      if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
      const highlighted = color ? highlight(plainContent, lang) : rawLines;
      const inRange = parseRanges(opts.all("range"), rawLines.length);
      const highlightRange = parseRanges(opts.all("highlight"), rawLines.length);

      // Plain mode (no decorations): behave exactly like cat.
      if (style.size === 0) {
        const lines: string[] = [];
        let lastSelected = 0;
        highlighted.forEach((line, i) => {
          const lineNo = i + 1;
          if (inRange && !inRange(lineNo)) return;
          let out = opts.has("showAll") ? showNonPrintable(line) : line;
          if (highlightRange && highlightRange(lineNo) && color) out = `${HIGHLIGHT_BG}${out}\x1b[0m`;
          lines.push(out);
          lastSelected = lineNo;
        });
        if (lines.length === 0) return;
        const trailingNewline = plainContent.endsWith("\n") || lastSelected < rawLines.length;
        blocks.push(lines.join("\n") + (trailingNewline ? "\n" : ""));
        return;
      }

      const out: string[] = [];
      const hr = (junction: string) => GRID("─".repeat(gutter) + (gutter > 0 ? junction : "") + "─".repeat(Math.max(0, width - gutter - 1)));
      const gridPrefix = gutter > 0 ? " ".repeat(gutter) + GRID("│") + " " : "";
      if (hasGrid) out.push(hr("┬"));
      else if (style.has("rule") && index > 0) out.push(GRID("─".repeat(width)));
      if (style.has("header") || style.has("header-filename")) {
        const label = plainContent === "" ? `File: ${ansi.bold(displayName)}   ${ansi.dim("<EMPTY>")}` : `File: ${ansi.bold(displayName)}`;
        out.push((hasGrid ? gridPrefix : "") + label);
        if (hasGrid) out.push(hr("┼"));
      }
      let previousShown = 0;
      highlighted.forEach((line, i) => {
        const lineNo = i + 1;
        if (inRange && !inRange(lineNo)) return;
        if (style.has("snip") && previousShown !== 0 && lineNo > previousShown + 1) {
          const snip = " 8< ";
          const side = Math.max(0, Math.floor((width - gutter - snip.length) / 2));
          out.push(gutter > 0 ? " ".repeat(gutter) + GRID(hasGrid ? "┤" : " ") + GRID("─".repeat(side) + snip + "─".repeat(side)) : GRID("─".repeat(side) + snip + "─".repeat(side)));
        }
        previousShown = lineNo;
        let body = opts.has("showAll") ? showNonPrintable(line) : line;
        if (highlightRange && highlightRange(lineNo)) body = color ? `${HIGHLIGHT_BG}${body}\x1b[0m` : body;
        const number = style.has("numbers") ? LINE_NO(String(lineNo).padStart(numberWidth)) + "   " : "";
        const withGrid = style.has("numbers") && hasGrid ? LINE_NO(String(lineNo).padStart(numberWidth)) + "   " + GRID("│") + " " : number;
        out.push((color ? withGrid : stripAnsi(withGrid)) + body);
      });
      if (hasGrid) out.push(hr("┴"));
      const rendered = out.join("\n") + "\n";
      blocks.push(color ? rendered : stripAnsi(rendered));
    });

    ctx.stdout(blocks.join(""));
    return status;
  },
};

export const BAT_COMMANDS: CommandSpec[] = [bat, { ...bat, name: "batcat" }];
