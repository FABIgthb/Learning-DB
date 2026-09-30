/**
 * A small POSIX-shell parser.
 *
 * Supported syntax:
 *   - single quotes, double quotes, backslash escapes
 *   - $VAR, ${VAR}, $?, command substitution $(...) and `...`
 *   - pipelines (|), lists (&&, ||, ;), comments (#)
 *   - redirections: > >> < 2> 2>> &> 2>&1 1>&2 >&2
 *   - leading NAME=value assignments
 *
 * Expansion (variables, substitution, tilde, globbing) happens at execution
 * time in shell.ts, so `export A=1 && echo $A` behaves like bash.
 */

export type QuoteKind = "none" | "single" | "double" | "escaped";

export type WordPart =
  | { kind: "text"; value: string; quote: QuoteKind }
  | { kind: "var"; name: string; quote: QuoteKind }
  | { kind: "subst"; source: string; quote: QuoteKind };

export interface Word {
  parts: WordPart[];
  raw: string;
}

export interface Redirect {
  /** File descriptor being redirected: 0 stdin, 1 stdout, 2 stderr, "both" for &> */
  fd: 0 | 1 | 2 | "both";
  op: ">" | ">>" | "<" | "dup";
  target: Word | null;
  /** For "dup" (2>&1): the fd being duplicated. */
  toFd?: 1 | 2;
}

export interface Assignment {
  name: string;
  value: Word;
}

export interface SimpleCommand {
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
}

export type ListOperator = "&&" | "||" | ";";

export interface CommandList {
  items: { pipeline: Pipeline; next: ListOperator | null }[];
}

export class ParseError extends Error {}

type Token =
  | { type: "word"; word: Word }
  | { type: "op"; value: "|" | "&&" | "||" | ";" }
  | { type: "redir"; redirect: Omit<Redirect, "target">; needsTarget: boolean };

const VAR_START = /[A-Za-z_]/;
const VAR_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_VARS = new Set(["?", "$", "#", "@", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/** Find the index of the `)` closing a `$(` whose content starts at `start`. */
function findSubstitutionEnd(input: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) throw new ParseError("unexpected EOF while looking for matching `''");
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++;
        i++;
      }
      if (i >= input.length) throw new ParseError("unexpected EOF while looking for matching `\"'");
      i++;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new ParseError("unexpected EOF while looking for matching `)'");
}

class Tokenizer {
  private readonly input: string;
  private pos = 0;
  readonly tokens: Token[] = [];

  constructor(input: string) {
    this.input = input;
  }

  run(): Token[] {
    const s = this.input;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.pos++;
        continue;
      }
      if (ch === "#") break;
      if (this.tryOperator()) continue;
      this.readWord();
    }
    return this.tokens;
  }

  private tryOperator(): boolean {
    const s = this.input;
    const rest = s.slice(this.pos);
    const push = (token: Token, length: number) => {
      this.tokens.push(token);
      this.pos += length;
      return true;
    };
    if (rest.startsWith("&&")) return push({ type: "op", value: "&&" }, 2);
    if (rest.startsWith("||")) return push({ type: "op", value: "||" }, 2);
    if (rest.startsWith("2>&1")) return push({ type: "redir", redirect: { fd: 2, op: "dup", toFd: 1 }, needsTarget: false }, 4);
    if (rest.startsWith("1>&2")) return push({ type: "redir", redirect: { fd: 1, op: "dup", toFd: 2 }, needsTarget: false }, 4);
    if (rest.startsWith(">&2")) return push({ type: "redir", redirect: { fd: 1, op: "dup", toFd: 2 }, needsTarget: false }, 3);
    if (rest.startsWith("&>>")) return push({ type: "redir", redirect: { fd: "both", op: ">>" }, needsTarget: true }, 3);
    if (rest.startsWith("&>")) return push({ type: "redir", redirect: { fd: "both", op: ">" }, needsTarget: true }, 2);
    if (rest.startsWith("2>>")) return push({ type: "redir", redirect: { fd: 2, op: ">>" }, needsTarget: true }, 3);
    if (rest.startsWith("2>")) return push({ type: "redir", redirect: { fd: 2, op: ">" }, needsTarget: true }, 2);
    if (rest.startsWith("1>>")) return push({ type: "redir", redirect: { fd: 1, op: ">>" }, needsTarget: true }, 3);
    if (rest.startsWith("1>")) return push({ type: "redir", redirect: { fd: 1, op: ">" }, needsTarget: true }, 2);
    if (rest.startsWith(">>")) return push({ type: "redir", redirect: { fd: 1, op: ">>" }, needsTarget: true }, 2);
    if (rest.startsWith(">")) return push({ type: "redir", redirect: { fd: 1, op: ">" }, needsTarget: true }, 1);
    if (rest.startsWith("<")) return push({ type: "redir", redirect: { fd: 0, op: "<" }, needsTarget: true }, 1);
    if (rest.startsWith("|")) return push({ type: "op", value: "|" }, 1);
    if (rest.startsWith(";")) return push({ type: "op", value: ";" }, 1);
    if (rest.startsWith("&")) throw new ParseError("background jobs (&) are not supported in this simulator");
    if (rest.startsWith("(") || rest.startsWith(")")) {
      throw new ParseError(`syntax error near unexpected token \`${rest[0]}'`);
    }
    return false;
  }

  private readWord(): void {
    const s = this.input;
    const start = this.pos;
    const parts: WordPart[] = [];
    let text = "";
    let textQuote: QuoteKind = "none";

    const flush = () => {
      if (text) parts.push({ kind: "text", value: text, quote: textQuote });
      text = "";
    };
    const appendText = (value: string, quote: QuoteKind) => {
      if (quote !== textQuote) {
        flush();
        textQuote = quote;
      }
      text += value;
    };

    const readDollar = (quote: QuoteKind): boolean => {
      // this.pos points at "$"
      const next = s[this.pos + 1];
      if (next === "(") {
        const end = findSubstitutionEnd(s, this.pos + 2);
        flush();
        parts.push({ kind: "subst", source: s.slice(this.pos + 2, end), quote });
        this.pos = end + 1;
        return true;
      }
      if (next === "{") {
        const end = s.indexOf("}", this.pos + 2);
        if (end === -1) throw new ParseError("unexpected EOF while looking for matching `}'");
        const name = s.slice(this.pos + 2, end);
        if (!/^([A-Za-z_][A-Za-z0-9_]*|[?$#@0-9])$/.test(name)) throw new ParseError(`\${${name}}: bad substitution`);
        flush();
        parts.push({ kind: "var", name, quote });
        this.pos = end + 1;
        return true;
      }
      if (next !== undefined && SPECIAL_VARS.has(next)) {
        flush();
        parts.push({ kind: "var", name: next, quote });
        this.pos += 2;
        return true;
      }
      if (next !== undefined && VAR_START.test(next)) {
        let end = this.pos + 1;
        while (end < s.length && VAR_CHAR.test(s[end])) end++;
        flush();
        parts.push({ kind: "var", name: s.slice(this.pos + 1, end), quote });
        this.pos = end;
        return true;
      }
      return false;
    };

    while (this.pos < s.length) {
      const ch = s[this.pos];
      if (" \t\n\r|&;<>()".includes(ch)) break;
      if (ch === "\\") {
        if (this.pos + 1 < s.length) appendText(s[this.pos + 1], "escaped");
        this.pos += 2;
        continue;
      }
      if (ch === "'") {
        const close = s.indexOf("'", this.pos + 1);
        if (close === -1) throw new ParseError("unexpected EOF while looking for matching `''");
        flush();
        // Push even when empty so '' produces an (empty) argument.
        parts.push({ kind: "text", value: s.slice(this.pos + 1, close), quote: "single" });
        textQuote = "none";
        this.pos = close + 1;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        flush();
        textQuote = "double";
        let sawContent = false;
        while (this.pos < s.length && s[this.pos] !== '"') {
          const c = s[this.pos];
          if (c === "\\" && this.pos + 1 < s.length && '"\\$`\n'.includes(s[this.pos + 1])) {
            appendText(s[this.pos + 1], "double");
            this.pos += 2;
            sawContent = true;
            continue;
          }
          if (c === "$" && readDollar("double")) {
            textQuote = "double";
            sawContent = true;
            continue;
          }
          if (c === "`") {
            const close = s.indexOf("`", this.pos + 1);
            if (close === -1) throw new ParseError("unexpected EOF while looking for matching ``'");
            flush();
            parts.push({ kind: "subst", source: s.slice(this.pos + 1, close), quote: "double" });
            textQuote = "double";
            this.pos = close + 1;
            sawContent = true;
            continue;
          }
          appendText(c, "double");
          sawContent = true;
          this.pos++;
        }
        if (this.pos >= s.length) throw new ParseError("unexpected EOF while looking for matching `\"'");
        this.pos++;
        if (!sawContent) parts.push({ kind: "text", value: "", quote: "double" });
        flush();
        textQuote = "none";
        continue;
      }
      if (ch === "`") {
        const close = s.indexOf("`", this.pos + 1);
        if (close === -1) throw new ParseError("unexpected EOF while looking for matching ``'");
        flush();
        parts.push({ kind: "subst", source: s.slice(this.pos + 1, close), quote: "none" });
        textQuote = "none";
        this.pos = close + 1;
        continue;
      }
      if (ch === "$" && readDollar("none")) {
        textQuote = "none";
        continue;
      }
      appendText(ch, "none");
      this.pos++;
    }
    flush();
    this.tokens.push({ type: "word", word: { parts, raw: s.slice(start, this.pos) } });
  }
}

export function tokenize(input: string): Token[] {
  return new Tokenizer(input).run();
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function splitAssignment(word: Word): Assignment | null {
  const first = word.parts[0];
  if (!first || first.kind !== "text" || first.quote !== "none") return null;
  const match = ASSIGNMENT.exec(first.value);
  if (!match) return null;
  const rest = first.value.slice(match[0].length);
  const valueParts: WordPart[] = [];
  if (rest) valueParts.push({ kind: "text", value: rest, quote: "none" });
  valueParts.push(...word.parts.slice(1));
  return { name: match[1], value: { parts: valueParts, raw: word.raw.slice(match[0].length) } };
}

export function parse(input: string): CommandList {
  const tokens = tokenize(input);
  const list: CommandList = { items: [] };
  let pipeline: Pipeline = { commands: [] };
  let command: SimpleCommand = { assignments: [], words: [], redirects: [] };

  const commandIsEmpty = (c: SimpleCommand) => c.words.length === 0 && c.assignments.length === 0 && c.redirects.length === 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "word") {
      if (command.words.length === 0) {
        const assignment = splitAssignment(token.word);
        if (assignment) {
          command.assignments.push(assignment);
          continue;
        }
      }
      command.words.push(token.word);
      continue;
    }
    if (token.type === "redir") {
      if (token.needsTarget) {
        const next = tokens[i + 1];
        if (!next || next.type !== "word") {
          throw new ParseError(`syntax error near unexpected token \`${next && next.type === "op" ? next.value : "newline"}'`);
        }
        command.redirects.push({ ...token.redirect, target: next.word });
        i++;
      } else {
        command.redirects.push({ ...token.redirect, target: null });
      }
      continue;
    }
    // operator
    if (commandIsEmpty(command)) throw new ParseError(`syntax error near unexpected token \`${token.value}'`);
    pipeline.commands.push(command);
    command = { assignments: [], words: [], redirects: [] };
    if (token.value === "|") {
      if (i === tokens.length - 1) throw new ParseError("syntax error: unexpected end of input after `|'");
      continue;
    }
    list.items.push({ pipeline, next: token.value });
    pipeline = { commands: [] };
  }

  if (!commandIsEmpty(command)) {
    pipeline.commands.push(command);
  }
  if (pipeline.commands.length > 0) {
    list.items.push({ pipeline, next: null });
  } else if (list.items.length > 0) {
    const last = list.items[list.items.length - 1];
    if (last.next === "&&" || last.next === "||") {
      throw new ParseError("syntax error: unexpected end of input");
    }
    last.next = null;
  }
  return list;
}

/**
 * Word → literal text without running expansions (variables stay `$NAME`).
 * Used to compare commands structurally in NORMALIZED validations.
 */
export function wordToLiteral(word: Word): string {
  return word.parts
    .map((part) => {
      if (part.kind === "text") return part.value;
      if (part.kind === "var") return `$${part.name}`;
      return `$(${part.source.trim()})`;
    })
    .join("");
}
