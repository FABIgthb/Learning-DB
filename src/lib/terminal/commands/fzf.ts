/**
 * fzf: interactive fuzzy finder.
 *
 * - `--filter/-f QUERY` runs non-interactively (ranked output), like real fzf.
 * - Otherwise the shell's interactive handler opens the in-terminal picker
 *   (see components/terminal/FzfPicker.tsx). Selections are recorded so the
 *   server can replay the session deterministically.
 */

import { stripAnsi } from "../ansi";
import { CommandError, type CommandSpec } from "../command";
import { relativePath } from "../filesystem";
import { fuzzyFilter, type CaseMode } from "../fuzzy";
import { shellQuote, splitLines } from "./args";
import { walkRespectingIgnores } from "./rg";

const USAGE = [
  "usage: fzf [options]",
  "",
  "  Search",
  "    -e, --exact           enable exact-match",
  "    -i / +i               case-insensitive / case-sensitive match (default: smart-case)",
  "    -q, --query=STR       start the finder with the given query",
  "    -f, --filter=STR      filter mode: print matches without the interactive finder",
  "    --no-sort / --tac     do not sort the result / reverse the input order",
  "  Interface",
  "    -m, --multi           enable multi-select with <Tab>",
  "    --prompt=STR          input prompt (default: '> ')",
  "    --header=STR          sticky header",
  "    --preview=CMD         command to preview the highlighted line ({} is replaced)",
  "  Scripting",
  "    -1, --select-1        automatically select the only match",
  "    -0, --exit-0          exit immediately when there's no match",
  "",
  "  Search syntax: sbtrkt (fuzzy)  'wild (exact)  ^music (prefix)  .mp3$ (suffix)  !fire (inverse)  a | b (or)",
  "",
  "  Keys: type to filter · ↑/↓ or Ctrl-K/Ctrl-J move · Tab mark (with -m) · Enter accept · Esc / Ctrl-C abort",
].join("\n");

/** Options that take a value; unknown layout flags are accepted and ignored. */
const VALUE_OPTIONS = new Set(["query", "filter", "prompt", "header", "preview", "height", "layout", "border", "preview-window", "delimiter", "with-nth", "nth", "bind", "color", "info", "pointer", "marker", "min-height", "margin", "padding", "tiebreak", "scheme", "history", "expect", "walker", "walker-root", "walker-skip", "tabstop", "ellipsis", "separator", "scrollbar", "border-label", "preview-label", "header-lines", "jump-labels", "algo"]);
const SHORT_VALUE: Record<string, string> = { q: "query", f: "filter", d: "delimiter", n: "nth" };

const fzf: CommandSpec = {
  name: "fzf",
  summary: "A command-line fuzzy finder.",
  usage: USAGE,
  async run(ctx) {
    const options = new Map<string, string>();
    const flags = new Set<string>();
    let caseMode: CaseMode = "smart";
    const args = [...ctx.args];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "+i") {
        caseMode = "respect";
        continue;
      }
      if (arg === "+m" || arg === "+s" || arg === "+x" || arg === "+e") {
        if (arg === "+m") flags.delete("multi");
        continue;
      }
      if (arg.startsWith("--")) {
        const eq = arg.indexOf("=");
        const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        if (VALUE_OPTIONS.has(name)) {
          let value = eq === -1 ? undefined : arg.slice(eq + 1);
          if (value === undefined) {
            value = args[++i];
            if (value === undefined) throw new CommandError(`option --${name} requires an argument`, 2);
          }
          options.set(name, value);
          continue;
        }
        const aliases: Record<string, string> = {
          exact: "exact",
          multi: "multi",
          "no-multi": "no-multi",
          "select-1": "select-1",
          "exit-0": "exit-0",
          "no-sort": "no-sort",
          tac: "tac",
          "ignore-case": "ignore-case",
          "no-ignore-case": "no-ignore-case",
          "smart-case": "smart-case",
          "print-query": "print-query",
          "read0": "read0",
          "print0": "print0",
          ansi: "ansi",
          reverse: "reverse",
          cycle: "cycle",
          "no-mouse": "ignored",
          "no-hscroll": "ignored",
          "no-info": "ignored",
          "no-scrollbar": "ignored",
          "no-separator": "ignored",
          "keep-right": "ignored",
          "inline-info": "ignored",
          sync: "ignored",
          border: "ignored",
          "highlight-line": "ignored",
          "no-bold": "ignored",
          "track": "ignored",
          "disabled": "disabled",
          "phony": "disabled",
          "filepath-word": "ignored",
          "no-unicode": "ignored",
          "literal": "ignored",
        };
        const key = aliases[name];
        if (!key) throw new CommandError(`unknown option: ${arg}`, 2);
        flags.add(key);
        if (key === "ignore-case") caseMode = "ignore";
        if (key === "no-ignore-case") caseMode = "respect";
        if (key === "smart-case") caseMode = "smart";
        if (key === "no-multi") flags.delete("multi");
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        for (let j = 1; j < arg.length; j++) {
          const ch = arg[j];
          if (SHORT_VALUE[ch]) {
            let value = arg.slice(j + 1);
            if (value === "") {
              value = args[++i];
              if (value === undefined) throw new CommandError(`option -${ch} requires an argument`, 2);
            }
            options.set(SHORT_VALUE[ch], value);
            break;
          }
          if (ch === "e") flags.add("exact");
          else if (ch === "m") flags.add("multi");
          else if (ch === "i") caseMode = "ignore";
          else if (ch === "1") flags.add("select-1");
          else if (ch === "0") flags.add("exit-0");
          else if (ch === "x") flags.add("extended");
          else if (ch === "s") continue;
          else throw new CommandError(`unknown option: -${ch}`, 2);
        }
        continue;
      }
      throw new CommandError(`unknown option: ${arg}`, 2);
    }

    // Input list: stdin, $FZF_DEFAULT_COMMAND, or a walk of the current directory.
    let items: string[];
    if (ctx.stdin !== null) {
      const text = flags.has("ansi") ? stripAnsi(ctx.stdin) : ctx.stdin;
      items = flags.has("read0") ? text.split("\0").filter(Boolean) : splitLines(text);
    } else {
      const defaultCommand = ctx.shell.vars.get("FZF_DEFAULT_COMMAND");
      if (defaultCommand) {
        const result = await ctx.shell.capture(defaultCommand);
        items = splitLines(stripAnsi(result.stdout));
      } else {
        const root = ctx.shell.cwd;
        items = [];
        for (const entry of walkRespectingIgnores(ctx.shell, root, { hidden: false, noIgnore: false, noIgnoreVcs: false })) {
          items.push(relativePath(entry.path, root));
          if (items.length > 50_000) break;
        }
      }
    }
    if (flags.has("tac")) items = [...items].reverse();

    const exact = flags.has("exact");
    const noSort = flags.has("no-sort");
    const filterQuery = options.get("filter");
    const print = (lines: string[]) => {
      if (lines.length === 0) return;
      const sep = flags.has("print0") ? "\0" : "\n";
      ctx.stdout(lines.join(sep) + sep);
    };

    if (filterQuery !== undefined) {
      const ranked = fuzzyFilter(items, filterQuery, { caseMode, exact, noSort });
      print(ranked.map((r) => r.item));
      return ranked.length > 0 ? 0 : 1;
    }

    const query = options.get("query") ?? "";
    if (flags.has("select-1") || flags.has("exit-0")) {
      const ranked = fuzzyFilter(items, query, { caseMode, exact, noSort });
      if (flags.has("exit-0") && ranked.length === 0) return 1;
      if (flags.has("select-1") && ranked.length === 1) {
        if (flags.has("print-query")) print([query]);
        print([ranked[0].item]);
        return 0;
      }
    }

    const previewCommand = options.get("preview");
    const sandbox = previewCommand ? ctx.shell.sandbox() : null;
    const preview = previewCommand && sandbox
      ? async (item: string): Promise<string> => {
          const quoted = shellQuote(item);
          const cmd = previewCommand.replace(/\{\+?[fnqs]*\}/g, quoted);
          const result = await sandbox.capture(cmd);
          return result.stdout + result.stderr;
        }
      : null;

    const selection = await ctx.shell.pick({
      items,
      query,
      prompt: options.get("prompt") ?? "> ",
      multi: flags.has("multi"),
      exact,
      caseMode,
      noSort,
      header: options.get("header") ?? null,
      preview,
    });
    if (selection === null) return 130;
    if (selection.length === 0) return 1;
    if (flags.has("print-query")) print([query]);
    print(selection);
    return 0;
  },
};

export const FZF_COMMANDS: CommandSpec[] = [fzf];
