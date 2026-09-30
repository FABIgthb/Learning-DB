/**
 * A compact jq interpreter (generator based, like the real thing).
 *
 * Covers the features used in day-to-day jq: paths (.a.b, .[0], .[], .[2:4], ..),
 * pipes, comma, alternatives (//), optional (?), try/catch, if/elif/else,
 * object/array construction, string interpolation, @formats, variables
 * (`as $x`, --arg, --argjson, $ENV), reduce/foreach, assignment operators
 * (=, |=, +=, -=, *=, /=, %=, //=), del/path/paths/getpath/setpath and
 * ~90 builtins (select, map, sort_by, group_by, to_entries, test, sub, ...).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class JqError extends Error {
  /** Value carried by `error(value)`; message is its string form. */
  readonly value: Json;
  constructor(value: Json) {
    super(typeof value === "string" ? value : JSON.stringify(value));
    this.value = value;
  }
}

export class JqCompileError extends Error {}

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

type StringPart = string | { source: string };

type Tok =
  | { t: "field"; name: string }
  | { t: "dot" }
  | { t: "recurse" }
  | { t: "var"; name: string }
  | { t: "format"; name: string }
  | { t: "num"; value: number }
  | { t: "str"; parts: StringPart[] }
  | { t: "ident"; name: string }
  | { t: "op"; value: string }
  | { t: "eof" };

const OPERATORS = ["?//", "|=", "+=", "-=", "*=", "/=", "%=", "//=", "==", "!=", "<=", ">=", "//", "|", ",", ":", ";", "(", ")", "[", "]", "{", "}", "<", ">", "+", "-", "*", "/", "%", "=", "?"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const identStart = /[A-Za-z_]/;
  const identChar = /[A-Za-z0-9_]/;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === ".") {
      if (src[i + 1] === ".") {
        out.push({ t: "recurse" });
        i += 2;
        continue;
      }
      if (src[i + 1] !== undefined && identStart.test(src[i + 1])) {
        let j = i + 1;
        while (j < src.length && identChar.test(src[j])) j++;
        out.push({ t: "field", name: src.slice(i + 1, j) });
        i = j;
        continue;
      }
      if (src[i + 1] !== undefined && /[0-9]/.test(src[i + 1])) {
        const m = /^\.[0-9]+([eE][+-]?[0-9]+)?/.exec(src.slice(i)) as RegExpExecArray;
        out.push({ t: "num", value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      out.push({ t: "dot" });
      i++;
      continue;
    }
    if (ch === "$" || ch === "@") {
      let j = i + 1;
      while (j < src.length && identChar.test(src[j])) j++;
      const name = src.slice(i + 1, j);
      if (!name) throw new JqCompileError(`syntax error, unexpected '${ch}'`);
      out.push(ch === "$" ? { t: "var", name } : { t: "format", name });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      const parts: StringPart[] = [];
      let buf = "";
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          if (e === "(") {
            let depth = 1;
            let j = i + 2;
            while (j < src.length && depth > 0) {
              if (src[j] === '"') {
                j++;
                while (j < src.length && src[j] !== '"') {
                  if (src[j] === "\\") j++;
                  j++;
                }
              } else if (src[j] === "(") depth++;
              else if (src[j] === ")") depth--;
              j++;
            }
            if (depth !== 0) throw new JqCompileError("unterminated string interpolation");
            if (buf) parts.push(buf);
            buf = "";
            parts.push({ source: src.slice(i + 2, j - 1) });
            i = j;
            continue;
          }
          const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\", '"': '"', "/": "/" };
          if (e === "u") {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JqCompileError("invalid \\u escape");
            buf += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          if (e === undefined || !(e in escapes)) throw new JqCompileError(`invalid escape \\${e ?? ""}`);
          buf += escapes[e];
          i += 2;
          continue;
        }
        buf += src[i];
        i++;
      }
      if (i >= src.length) throw new JqCompileError("unterminated string literal");
      i++;
      if (buf || parts.length === 0) parts.push(buf);
      out.push({ t: "str", parts });
      continue;
    }
    if (identStart.test(ch)) {
      let j = i;
      while (j < src.length && (identChar.test(src[j]) || (src[j] === ":" && src[j + 1] === ":"))) {
        j += src[j] === ":" ? 2 : 1;
      }
      out.push({ t: "ident", name: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new JqCompileError(`syntax error, unexpected INVALID_CHARACTER '${ch}'`);
    out.push({ t: "op", value: op });
    i += op.length;
  }
  out.push({ t: "eof" });
  return out;
}

/* ------------------------------------------------------------------ */
/* AST + parser                                                        */
/* ------------------------------------------------------------------ */

type Node =
  | { k: "identity" }
  | { k: "recurse_default" }
  | { k: "index"; target: Node; key: Node }
  | { k: "slice"; target: Node; from: Node | null; to: Node | null }
  | { k: "iterate"; target: Node }
  | { k: "try"; body: Node; handler: Node | null }
  | { k: "pipe"; left: Node; right: Node }
  | { k: "comma"; left: Node; right: Node }
  | { k: "literal"; value: Json }
  | { k: "string"; parts: (string | Node)[]; format: string | null }
  | { k: "format"; name: string }
  | { k: "array"; body: Node | null }
  | { k: "object"; entries: { key: Node; value: Node | null; keyVar?: string }[] }
  | { k: "neg"; body: Node }
  | { k: "binary"; op: string; left: Node; right: Node }
  | { k: "and"; left: Node; right: Node }
  | { k: "or"; left: Node; right: Node }
  | { k: "alt"; left: Node; right: Node }
  | { k: "assign"; op: string; lhs: Node; rhs: Node }
  | { k: "if"; cond: Node; then: Node; elifs: { cond: Node; then: Node }[]; otherwise: Node | null }
  | { k: "reduce"; source: Node; name: string; init: Node; update: Node }
  | { k: "foreach"; source: Node; name: string; init: Node; update: Node; extract: Node | null }
  | { k: "call"; name: string; args: Node[] }
  | { k: "var"; name: string }
  | { k: "as"; source: Node; name: string; body: Node }
  | { k: "def"; name: string; params: string[]; body: Node; rest: Node };

const KEYWORDS = new Set(["if", "then", "elif", "else", "end", "as", "reduce", "foreach", "try", "catch", "and", "or", "def", "label", "import", "include"]);

class Parser {
  private toks: Tok[];
  private p = 0;

  constructor(src: string) {
    this.toks = lex(src);
  }

  private peek(offset = 0): Tok {
    return this.toks[Math.min(this.p + offset, this.toks.length - 1)];
  }

  private next(): Tok {
    const tok = this.toks[this.p];
    if (this.p < this.toks.length - 1) this.p++;
    return tok;
  }

  private isOp(value: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.t === "op" && tok.value === value;
  }

  private isIdent(name: string): boolean {
    const tok = this.peek();
    return tok.t === "ident" && tok.name === name;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new JqCompileError(`syntax error, expected '${value}' but got ${describe(this.peek())}`);
    this.next();
  }

  private expectIdent(name: string): void {
    if (!this.isIdent(name)) throw new JqCompileError(`syntax error, expected '${name}' but got ${describe(this.peek())}`);
    this.next();
  }

  parseProgram(): Node {
    const node = this.parsePipe();
    if (this.peek().t !== "eof") throw new JqCompileError(`syntax error, unexpected ${describe(this.peek())}`);
    return node;
  }

  private parsePipe(): Node {
    if (this.isIdent("def")) return this.parseDef();
    const left = this.parseComma();
    if (this.isIdent("as")) {
      this.next();
      const v = this.next();
      if (v.t !== "var") throw new JqCompileError("syntax error, expected $variable after 'as'");
      this.expectOp("|");
      return { k: "as", source: left, name: v.name, body: this.parsePipe() };
    }
    if (this.isOp("|")) {
      this.next();
      return { k: "pipe", left, right: this.parsePipe() };
    }
    return left;
  }

  private parseDef(): Node {
    this.expectIdent("def");
    const nameTok = this.next();
    if (nameTok.t !== "ident") throw new JqCompileError("syntax error, expected function name after 'def'");
    const params: string[] = [];
    if (this.isOp("(")) {
      this.next();
      for (;;) {
        const p = this.next();
        if (p.t === "ident") params.push(p.name);
        else if (p.t === "var") params.push("$" + p.name);
        else throw new JqCompileError("syntax error in def parameters");
        if (this.isOp(";")) {
          this.next();
          continue;
        }
        this.expectOp(")");
        break;
      }
    }
    this.expectOp(":");
    const body = this.parsePipe();
    this.expectOp(";");
    const rest = this.parsePipe();
    return { k: "def", name: nameTok.name, params, body, rest };
  }

  private parseComma(): Node {
    let left = this.parseAlt();
    while (this.isOp(",")) {
      this.next();
      left = { k: "comma", left, right: this.parseAlt() };
    }
    return left;
  }

  private parseAlt(): Node {
    const left = this.parseAssign();
    if (this.isOp("//")) {
      this.next();
      return { k: "alt", left, right: this.parseAlt() };
    }
    return left;
  }

  private parseAssign(): Node {
    const lhs = this.parseOr();
    const tok = this.peek();
    if (tok.t === "op" && ["=", "|=", "+=", "-=", "*=", "/=", "%=", "//="].includes(tok.value)) {
      this.next();
      return { k: "assign", op: tok.value, lhs, rhs: this.parseAlt() };
    }
    return lhs;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isIdent("or")) {
      this.next();
      left = { k: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseCompare();
    while (this.isIdent("and")) {
      this.next();
      left = { k: "and", left, right: this.parseCompare() };
    }
    return left;
  }

  private parseCompare(): Node {
    const left = this.parseAdditive();
    const tok = this.peek();
    if (tok.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(tok.value)) {
      this.next();
      return { k: "binary", op: tok.value, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      const tok = this.peek();
      if (tok.t === "op" && (tok.value === "+" || tok.value === "-")) {
        this.next();
        left = { k: "binary", op: tok.value, left, right: this.parseMultiplicative() };
      } else return left;
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.t === "op" && (tok.value === "*" || tok.value === "/" || tok.value === "%")) {
        this.next();
        left = { k: "binary", op: tok.value, left, right: this.parseUnary() };
      } else return left;
    }
  }

  private parseUnary(): Node {
    if (this.isOp("-")) {
      this.next();
      return { k: "neg", body: this.parsePostfix() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      if (tok.t === "field") {
        this.next();
        node = { k: "index", target: node, key: { k: "literal", value: tok.name } };
        continue;
      }
      if (tok.t === "dot" && this.peek(1).t === "str") {
        this.next();
        node = { k: "index", target: node, key: this.parseString(null) };
        continue;
      }
      if (tok.t === "dot" && this.isOp("[", 1)) {
        this.next();
        continue;
      }
      if (this.isOp("[")) {
        node = this.parseBracketSuffix(node);
        continue;
      }
      if (this.isOp("?")) {
        this.next();
        node = { k: "try", body: node, handler: null };
        continue;
      }
      return node;
    }
  }

  private parseBracketSuffix(target: Node): Node {
    this.expectOp("[");
    if (this.isOp("]")) {
      this.next();
      return { k: "iterate", target };
    }
    if (this.isOp(":")) {
      this.next();
      const to = this.parsePipe();
      this.expectOp("]");
      return { k: "slice", target, from: null, to };
    }
    const key = this.parsePipe();
    if (this.isOp(":")) {
      this.next();
      if (this.isOp("]")) {
        this.next();
        return { k: "slice", target, from: key, to: null };
      }
      const to = this.parsePipe();
      this.expectOp("]");
      return { k: "slice", target, from: key, to };
    }
    this.expectOp("]");
    return { k: "index", target, key };
  }

  private parseString(format: string | null): Node {
    const tok = this.next();
    if (tok.t !== "str") throw new JqCompileError(`syntax error, expected string but got ${describe(tok)}`);
    const parts = tok.parts.map((part) => (typeof part === "string" ? part : new Parser(part.source).parseProgram()));
    if (parts.every((p) => typeof p === "string") && format === null) {
      return { k: "literal", value: (parts as string[]).join("") };
    }
    return { k: "string", parts, format };
  }

  private parsePrimary(): Node {
    const tok = this.peek();
    switch (tok.t) {
      case "dot":
        this.next();
        if (this.peek().t === "str") return { k: "index", target: { k: "identity" }, key: this.parseString(null) };
        return { k: "identity" };
      case "field":
        this.next();
        return { k: "index", target: { k: "identity" }, key: { k: "literal", value: tok.name } };
      case "recurse":
        this.next();
        return { k: "recurse_default" };
      case "num":
        this.next();
        return { k: "literal", value: tok.value };
      case "str":
        return this.parseString(null);
      case "format":
        this.next();
        if (this.peek().t === "str") return this.parseString(tok.name);
        return { k: "format", name: tok.name };
      case "var":
        this.next();
        return { k: "var", name: tok.name };
      case "ident":
        return this.parseIdentPrimary(tok.name);
      case "op":
        if (tok.value === "(") {
          this.next();
          const inner = this.parsePipe();
          this.expectOp(")");
          return inner;
        }
        if (tok.value === "[") {
          this.next();
          if (this.isOp("]")) {
            this.next();
            return { k: "array", body: null };
          }
          const body = this.parsePipe();
          this.expectOp("]");
          return { k: "array", body };
        }
        if (tok.value === "{") return this.parseObject();
        throw new JqCompileError(`syntax error, unexpected '${tok.value}'`);
      default:
        throw new JqCompileError(`syntax error, unexpected ${describe(tok)}`);
    }
  }

  private parseIdentPrimary(name: string): Node {
    if (name === "if") return this.parseIf();
    if (name === "try") {
      this.next();
      const body = this.parsePostfix();
      let handler: Node | null = null;
      if (this.isIdent("catch")) {
        this.next();
        handler = this.parsePostfix();
      }
      return { k: "try", body, handler };
    }
    if (name === "reduce" || name === "foreach") {
      this.next();
      const source = this.parsePostfix();
      this.expectIdent("as");
      const v = this.next();
      if (v.t !== "var") throw new JqCompileError(`syntax error, expected $variable in ${name}`);
      this.expectOp("(");
      const init = this.parsePipe();
      this.expectOp(";");
      const update = this.parsePipe();
      let extract: Node | null = null;
      if (name === "foreach" && this.isOp(";")) {
        this.next();
        extract = this.parsePipe();
      }
      this.expectOp(")");
      return name === "reduce" ? { k: "reduce", source, name: v.name, init, update } : { k: "foreach", source, name: v.name, init, update, extract };
    }
    if (KEYWORDS.has(name)) throw new JqCompileError(`syntax error, unexpected ${name}`);
    this.next();
    if (name === "true") return { k: "literal", value: true };
    if (name === "false") return { k: "literal", value: false };
    if (name === "null") return { k: "literal", value: null };
    const args: Node[] = [];
    if (this.isOp("(")) {
      this.next();
      for (;;) {
        args.push(this.parsePipe());
        if (this.isOp(";")) {
          this.next();
          continue;
        }
        this.expectOp(")");
        break;
      }
    }
    return { k: "call", name, args };
  }

  private parseIf(): Node {
    this.expectIdent("if");
    const cond = this.parsePipe();
    this.expectIdent("then");
    const then = this.parsePipe();
    const elifs: { cond: Node; then: Node }[] = [];
    let otherwise: Node | null = null;
    for (;;) {
      if (this.isIdent("elif")) {
        this.next();
        const c = this.parsePipe();
        this.expectIdent("then");
        elifs.push({ cond: c, then: this.parsePipe() });
        continue;
      }
      if (this.isIdent("else")) {
        this.next();
        otherwise = this.parsePipe();
      }
      this.expectIdent("end");
      break;
    }
    return { k: "if", cond, then, elifs, otherwise };
  }

  private parseObject(): Node {
    this.expectOp("{");
    const entries: { key: Node; value: Node | null; keyVar?: string }[] = [];
    while (!this.isOp("}")) {
      const tok = this.peek();
      let key: Node;
      let keyVar: string | undefined;
      if (tok.t === "ident") {
        this.next();
        key = { k: "literal", value: tok.name };
      } else if (tok.t === "var") {
        this.next();
        key = { k: "literal", value: tok.name };
        keyVar = tok.name;
      } else if (tok.t === "str") {
        key = this.parseString(null);
      } else if (tok.t === "format" && this.peek(1).t === "str") {
        this.next();
        key = this.parseString(tok.name);
      } else if (tok.t === "num") {
        throw new JqCompileError("syntax error, object keys must be strings");
      } else if (this.isOp("(")) {
        this.next();
        key = this.parsePipe();
        this.expectOp(")");
      } else {
        throw new JqCompileError(`syntax error, unexpected ${describe(tok)} in object construction`);
      }
      let value: Node | null = null;
      if (this.isOp(":")) {
        this.next();
        value = this.parseObjectValue();
      }
      entries.push({ key, value, keyVar });
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      if (!this.isOp("}")) throw new JqCompileError(`syntax error, expected ',' or '}' but got ${describe(this.peek())}`);
    }
    this.expectOp("}");
    return { k: "object", entries };
  }

  /** Object values are ExpD: pipes allowed only inside parentheses, but `|` chains of terms are allowed. */
  private parseObjectValue(): Node {
    let left = this.parseAlt();
    while (this.isOp("|")) {
      this.next();
      left = { k: "pipe", left, right: this.parseAlt() };
    }
    return left;
  }
}

function describe(tok: Tok): string {
  switch (tok.t) {
    case "eof":
      return "end of file";
    case "op":
      return `'${tok.value}'`;
    case "ident":
      return tok.name;
    case "field":
      return `.${tok.name}`;
    case "var":
      return `$${tok.name}`;
    case "num":
      return String(tok.value);
    case "str":
      return "string";
    case "format":
      return `@${tok.name}`;
    default:
      return tok.t;
  }
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

export function jqType(v: Json): "null" | "boolean" | "number" | "string" | "array" | "object" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v as "boolean" | "number" | "string" | "object";
}

const TYPE_ORDER = { null: 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };

export function compareJson(a: Json, b: Json): number {
  const ta = jqType(a);
  const tb = jqType(b);
  if (ta !== tb) {
    const oa = ta === "boolean" ? (a ? 2 : 1) : TYPE_ORDER[ta];
    const ob = tb === "boolean" ? (b ? 2 : 1) : TYPE_ORDER[tb];
    return oa - ob;
  }
  switch (ta) {
    case "null":
      return 0;
    case "boolean":
      return (a ? 1 : 0) - (b ? 1 : 0);
    case "number":
      return (a as number) - (b as number);
    case "string":
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case "array": {
      const x = a as Json[];
      const y = b as Json[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareJson(x[i], y[i]);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    case "object": {
      const x = a as Record<string, Json>;
      const y = b as Record<string, Json>;
      const kc = compareJson(Object.keys(x).sort(), Object.keys(y).sort());
      if (kc !== 0) return kc;
      for (const key of Object.keys(x).sort()) {
        const c = compareJson(x[key], y[key]);
        if (c !== 0) return c;
      }
      return 0;
    }
  }
}

function truthy(v: Json): boolean {
  return v !== null && v !== false;
}

function errValue(v: Json): string {
  const text = JSON.stringify(v);
  return text.length > 11 ? text.slice(0, 10) + "..." : text;
}

function typeErr(v: Json, what: string): JqError {
  return new JqError(`${jqType(v)} (${errValue(v)}) ${what}`);
}

function indexValue(t: Json, k: Json): Json {
  if (t === null) {
    if (typeof k === "string" || typeof k === "number" || k === null) return null;
    if (isObj(k)) return null;
  }
  if (isObj(t)) {
    if (typeof k === "string") return Object.prototype.hasOwnProperty.call(t, k) ? t[k] : null;
    throw new JqError(`Cannot index object with ${jqType(k)}`);
  }
  if (Array.isArray(t)) {
    if (typeof k === "number") {
      if (Number.isNaN(k)) return null;
      let i = Math.floor(k);
      if (i < 0) i += t.length;
      return i >= 0 && i < t.length ? t[i] : null;
    }
    if (Array.isArray(k)) return indicesOf(t, k);
    if (isObj(k)) return sliceValue(t, (k.start ?? null) as Json, (k.end ?? null) as Json);
    throw new JqError(typeof k === "string" ? `Cannot index array with "${k}"` : `Cannot index array with ${jqType(k)}`);
  }
  if (typeof k === "string") throw new JqError(`Cannot index ${jqType(t)} with "${k}"`);
  throw new JqError(`Cannot index ${jqType(t)} with ${jqType(k)}`);
}

function isObj(v: Json): v is { [key: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sliceBounds(len: number, from: Json, to: Json): [number, number] {
  const norm = (v: Json, dflt: number): number => {
    if (v === null) return dflt;
    if (typeof v !== "number") throw new JqError("Start and end indices of an array slice must be numbers");
    let n = Math.floor(v);
    if (n < 0) n += len;
    return Math.min(Math.max(n, 0), len);
  };
  const s = norm(from, 0);
  const e = norm(to, len);
  return [s, Math.max(s, e)];
}

function sliceValue(t: Json, from: Json, to: Json): Json {
  if (t === null) return null;
  if (typeof t === "string" || Array.isArray(t)) {
    const [s, e] = sliceBounds(t.length, from, to);
    return t.slice(s, e);
  }
  throw new JqError(`Cannot index ${jqType(t)} with object`);
}

function indicesOf(hay: Json, needle: Json): Json {
  if (hay === null) return null;
  const out: number[] = [];
  if (typeof hay === "string" && typeof needle === "string") {
    if (needle === "") return null;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = hay.indexOf(needle, i + 1);
    }
    return out;
  }
  if (Array.isArray(hay)) {
    const n = Array.isArray(needle) ? needle : [needle];
    if (n.length === 0) return null;
    for (let i = 0; i + n.length <= hay.length; i++) {
      if (n.every((v, j) => compareJson(hay[i + j], v) === 0)) out.push(i);
    }
    return out;
  }
  throw new JqError(`Cannot determine indices of ${jqType(needle)} in ${jqType(hay)}`);
}

function deepMerge(a: Record<string, Json>, b: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key];
    out[key] = isObj(existing) && isObj(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function arith(op: string, a: Json, b: Json): Json {
  switch (op) {
    case "+":
      if (a === null) return b;
      if (b === null) return a;
      if (typeof a === "number" && typeof b === "number") return a + b;
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (isObj(a) && isObj(b)) return { ...a, ...b };
      break;
    case "-":
      if (typeof a === "number" && typeof b === "number") return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => compareJson(x, y) === 0));
      break;
    case "*":
      if (typeof a === "number" && typeof b === "number") return a * b;
      if (typeof a === "string" && typeof b === "number") return b <= 0 ? null : a.repeat(Math.max(1, Math.ceil(b)));
      if (typeof a === "number" && typeof b === "string") return a <= 0 ? null : b.repeat(Math.max(1, Math.ceil(a)));
      if (isObj(a) && isObj(b)) return deepMerge(a, b);
      break;
    case "/":
      if (typeof a === "number" && typeof b === "number") {
        if (b === 0) throw new JqError(`${jqType(a)} (${errValue(a)}) and ${jqType(b)} (${errValue(b)}) cannot be divided because the divisor is zero`);
        return a / b;
      }
      if (typeof a === "string" && typeof b === "string") return splitString(a, b);
      break;
    case "%":
      if (typeof a === "number" && typeof b === "number") {
        const bi = Math.trunc(b);
        if (bi === 0) throw new JqError(`${jqType(a)} (${errValue(a)}) and ${jqType(b)} (${errValue(b)}) cannot be divided because the divisor is zero`);
        const r = Math.trunc(a) % Math.abs(bi);
        return r === 0 ? 0 : r;
      }
      break;
    case "==":
      return compareJson(a, b) === 0;
    case "!=":
      return compareJson(a, b) !== 0;
    case "<":
      return compareJson(a, b) < 0;
    case "<=":
      return compareJson(a, b) <= 0;
    case ">":
      return compareJson(a, b) > 0;
    case ">=":
      return compareJson(a, b) >= 0;
  }
  const verb = { "+": "added", "-": "subtracted", "*": "multiplied", "/": "divided", "%": "divided" }[op] ?? "combined";
  throw new JqError(`${jqType(a)} (${errValue(a)}) and ${jqType(b)} (${errValue(b)}) cannot be ${verb}`);
}

function splitString(s: string, sep: string): Json {
  if (s === "") return [];
  return sep === "" ? [...s] : s.split(sep);
}

function containsJson(a: Json, b: Json): boolean {
  if (jqType(a) !== jqType(b)) throw new JqError(`${jqType(a)} (${errValue(a)}) and ${jqType(b)} (${errValue(b)}) cannot have their containment checked`);
  if (typeof a === "string") return a.includes(b as string);
  if (Array.isArray(a)) return (b as Json[]).every((bv) => a.some((av) => jqType(av) === jqType(bv) && containsJson(av, bv)));
  if (isObj(a)) {
    return Object.entries(b as Record<string, Json>).every(([key, bv]) => Object.prototype.hasOwnProperty.call(a, key) && jqType(a[key]) === jqType(bv) && containsJson(a[key], bv));
  }
  return compareJson(a, b) === 0;
}

export function toJqString(v: Json): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

type PathKey = string | number | { start: Json; end: Json };
type Path = PathKey[];

function getPath(v: Json, path: Path): Json {
  let cur = v;
  for (const key of path) {
    if (cur === null) return null;
    cur = typeof key === "object" ? sliceValue(cur, key.start, key.end) : indexValue(cur, key);
  }
  return cur;
}

function setPath(v: Json, path: Path, value: Json, i = 0): Json {
  if (i === path.length) return value;
  const key = path[i];
  if (typeof key === "string") {
    if (v !== null && !isObj(v)) throw new JqError(`Cannot index ${jqType(v)} with "${key}"`);
    const obj = v ?? {};
    return { ...obj, [key]: setPath(obj[key] ?? null, path, value, i + 1) };
  }
  if (typeof key === "number") {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot index ${jqType(v)} with number`);
    const arr = [...(v ?? [])];
    let idx = Math.floor(key);
    if (idx < 0) {
      idx += arr.length;
      if (idx < 0) throw new JqError("Out of bounds negative array index");
    }
    if (idx > 100_000) throw new JqError("Array index too large");
    while (arr.length < idx) arr.push(null);
    arr[idx] = setPath(arr[idx] ?? null, path, value, i + 1);
    return arr;
  }
  if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot update field at object index of ${jqType(v)}`);
  const arr = v ?? [];
  const [s, e] = sliceBounds(arr.length, key.start, key.end);
  const replacement = setPath(arr.slice(s, e), path, value, i + 1);
  if (!Array.isArray(replacement)) throw new JqError("A slice of an array can only be assigned another array");
  return [...arr.slice(0, s), ...replacement, ...arr.slice(e)];
}

function deletePaths(v: Json, paths: Path[]): Json {
  const sorted = [...paths].sort((a, b) => compareJson(b as Json, a as Json));
  let out = v;
  for (const path of sorted) out = deletePath(out, path);
  return out;
}

function deletePath(v: Json, path: Path): Json {
  if (path.length === 0) return null;
  if (v === null) return null;
  const [key, ...rest] = path;
  if (rest.length > 0) {
    const child = typeof key === "object" ? sliceValue(v, key.start, key.end) : indexValue(v, key);
    if (child === null) return v;
    return setPath(v, [key], deletePath(child, rest));
  }
  if (typeof key === "string") {
    if (!isObj(v)) throw new JqError(`Cannot delete field at object index of ${jqType(v)}`);
    const copy = { ...v };
    delete copy[key];
    return copy;
  }
  if (!Array.isArray(v)) throw new JqError(`Cannot delete field at index of ${jqType(v)}`);
  if (typeof key === "number") {
    let idx = Math.floor(key);
    if (idx < 0) idx += v.length;
    if (idx < 0 || idx >= v.length) return v;
    return [...v.slice(0, idx), ...v.slice(idx + 1)];
  }
  const [s, e] = sliceBounds(v.length, key.start, key.end);
  return [...v.slice(0, s), ...v.slice(e)];
}

function pathToJson(path: Path): Json {
  return path.map((k) => (typeof k === "object" ? { start: k.start, end: k.end } : k));
}

function jsonToPath(v: Json): Path {
  if (!Array.isArray(v)) throw new JqError("Path must be specified as an array");
  return v.map((k) => {
    if (typeof k === "string" || typeof k === "number") return k;
    if (isObj(k)) return { start: k.start ?? null, end: k.end ?? null };
    throw new JqError(`Invalid path component ${JSON.stringify(k)}`);
  });
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                           */
/* ------------------------------------------------------------------ */

interface UserFunction {
  params: string[];
  body: Node;
  env: Env;
}

interface Closure {
  node: Node;
  env: Env;
}

interface Env {
  vars: Map<string, Json>;
  funcs: Map<string, UserFunction>;
  /** Filter-parameters of the enclosing user function(s). */
  closures: Map<string, Closure>;
}

class Budget {
  private steps = 0;
  constructor(private readonly max: number) {}
  tick(): void {
    this.steps++;
    if (this.steps > this.max) throw new JqError("evaluation limit exceeded (the simulator caps jq programs at 2,000,000 steps)");
  }
}

function withVar(env: Env, name: string, value: Json): Env {
  const vars = new Map(env.vars);
  vars.set(name, value);
  return { ...env, vars };
}

type BuiltinFn = (ctx: Evaluator, args: Node[], input: Json, env: Env) => Generator<Json>;

function* one(v: Json): Generator<Json> {
  yield v;
}

function firstOf(gen: Generator<Json>): Json | undefined {
  for (const v of gen) return v;
  return undefined;
}

function applyFormat(name: string, v: Json): string {
  switch (name) {
    case "text":
      return toJqString(v);
    case "json":
      return JSON.stringify(v);
    case "html":
      return toJqString(v).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[c] as string);
    case "uri":
      return [...new TextEncoder().encode(toJqString(v))]
        .map((b) => {
          const c = String.fromCharCode(b);
          return /[A-Za-z0-9\-_.~]/.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
        })
        .join("");
    case "csv":
    case "tsv": {
      if (!Array.isArray(v)) throw new JqError(`${jqType(v)} (${errValue(v)}) cannot be ${name}-formatted, only an array can be`);
      return v
        .map((x) => {
          if (typeof x === "number") return String(x);
          if (typeof x === "boolean") return String(x);
          if (x === null) return "";
          if (typeof x === "string") {
            return name === "csv" ? `"${x.replace(/"/g, '""')}"` : x.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
          }
          throw new JqError(`${jqType(x)} (${errValue(x)}) is not valid in a csv row`);
        })
        .join(name === "csv" ? "," : "\t");
    }
    case "sh": {
      const quote = (x: Json): string => {
        if (typeof x === "string") return `'${x.replace(/'/g, "'\\''")}'`;
        if (x === null || typeof x === "number" || typeof x === "boolean") return String(x);
        throw new JqError(`${jqType(x)} (${errValue(x)}) can not be escaped for shell`);
      };
      return Array.isArray(v) ? v.map(quote).join(" ") : quote(v);
    }
    case "base64": {
      const bytes = new TextEncoder().encode(toJqString(v));
      let bin = "";
      bytes.forEach((b) => (bin += String.fromCharCode(b)));
      return btoa(bin);
    }
    case "base64d": {
      try {
        const bin = atob(toJqString(v).replace(/=+$/, ""));
        return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      } catch {
        throw new JqError(`${jqType(v)} (${errValue(v)}) is not valid base64 data`);
      }
    }
    default:
      throw new JqError(`${name} is not a valid format`);
  }
}

function regexFrom(re: Json, flags: Json): { regex: RegExp; global: boolean } {
  if (typeof re !== "string") throw new JqError(`${jqType(re)} (${errValue(re)}) cannot be matched, as it is not a string`);
  const f = flags === null ? "" : toJqString(flags);
  let js = "u";
  let global = false;
  for (const c of f) {
    if (c === "g") global = true;
    else if (c === "i") js += "i";
    else if (c === "x") continue;
    else if (c === "s") js += "s";
    else if (c === "m") js += "s";
    else if (c === "n") continue;
    else if (c === "l" || c === "p") continue;
    else throw new JqError(`${f} is not a valid modifier string`);
  }
  // Translate Oniguruma named groups (?<name>...) – identical in JS – and possessive-free syntax as-is.
  try {
    return { regex: new RegExp(re, js + "g"), global };
  } catch (e) {
    throw new JqError(`${re} (at offset 0) is not a valid regex: ${(e as Error).message}`);
  }
}

function matchObjects(input: string, re: Json, flags: Json, forceGlobal: boolean): Json[] {
  const { regex, global } = regexFrom(re, flags);
  const out: Json[] = [];
  const cpOffset = (idx: number) => [...input.slice(0, idx)].length;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(input)) !== null) {
    const groupNames = Object.entries(m.groups ?? {});
    const captures: Json[] = [];
    for (let g = 1; g < m.length; g++) {
      const text = m[g];
      const name = groupNames.find(([, value]) => value === text)?.[0] ?? null;
      const offset = text === undefined ? -1 : cpOffset(input.indexOf(text, m.index));
      captures.push({ offset, length: text === undefined ? 0 : [...text].length, string: text ?? null, name });
    }
    out.push({ offset: cpOffset(m.index), length: [...m[0]].length, string: m[0], captures });
    if (m[0] === "") regex.lastIndex++;
    if (!global && !forceGlobal) break;
  }
  return out;
}

class Evaluator {
  readonly budget: Budget;
  readonly builtins: Map<string, BuiltinFn>;
  readonly envVars: Record<string, string>;

  constructor(envVars: Record<string, string>) {
    this.budget = new Budget(2_000_000);
    this.builtins = buildBuiltins();
    this.envVars = envVars;
  }

  *eval(node: Node, input: Json, env: Env): Generator<Json> {
    this.budget.tick();
    switch (node.k) {
      case "identity":
        yield input;
        return;
      case "recurse_default":
        yield* this.recurse(input);
        return;
      case "literal":
        yield node.value;
        return;
      case "var": {
        if (node.name === "ENV") {
          yield { ...this.envVars };
          return;
        }
        if (node.name === "__loc__") {
          yield { file: "<stdin>", line: 1 };
          return;
        }
        if (!env.vars.has(node.name)) throw new JqCompileError(`$${node.name} is not defined`);
        yield env.vars.get(node.name) as Json;
        return;
      }
      case "index":
        for (const t of this.eval(node.target, input, env)) {
          for (const k of this.eval(node.key, input, env)) yield indexValue(t, k);
        }
        return;
      case "slice":
        for (const t of this.eval(node.target, input, env)) {
          for (const to of node.to ? this.eval(node.to, input, env) : one(null)) {
            for (const from of node.from ? this.eval(node.from, input, env) : one(null)) yield sliceValue(t, from, to);
          }
        }
        return;
      case "iterate":
        for (const t of this.eval(node.target, input, env)) {
          if (Array.isArray(t)) yield* t;
          else if (isObj(t)) yield* Object.values(t);
          else throw new JqError(`Cannot iterate over ${jqType(t)}${t === null ? "" : ` (${errValue(t)})`}`);
        }
        return;
      case "try": {
        const results: Json[] = [];
        try {
          for (const v of this.eval(node.body, input, env)) results.push(v);
        } catch (e) {
          yield* results;
          if (e instanceof JqError) {
            if (node.handler) yield* this.eval(node.handler, e.value, env);
            return;
          }
          throw e;
        }
        yield* results;
        return;
      }
      case "pipe":
        for (const v of this.eval(node.left, input, env)) yield* this.eval(node.right, v, env);
        return;
      case "comma":
        yield* this.eval(node.left, input, env);
        yield* this.eval(node.right, input, env);
        return;
      case "string":
        yield* this.evalString(node.parts, node.format, input, env, 0, "");
        return;
      case "format":
        yield applyFormat(node.name, input);
        return;
      case "array":
        yield node.body ? [...this.eval(node.body, input, env)] : [];
        return;
      case "object":
        yield* this.evalObject(node.entries, 0, input, env, {});
        return;
      case "neg":
        for (const v of this.eval(node.body, input, env)) {
          if (typeof v !== "number") throw new JqError(`${jqType(v)} (${errValue(v)}) cannot be negated`);
          yield -v;
        }
        return;
      case "binary":
        for (const r of this.eval(node.right, input, env)) {
          for (const l of this.eval(node.left, input, env)) yield arith(node.op, l, r);
        }
        return;
      case "and":
        for (const l of this.eval(node.left, input, env)) {
          if (!truthy(l)) {
            yield false;
            continue;
          }
          for (const r of this.eval(node.right, input, env)) yield truthy(r);
        }
        return;
      case "or":
        for (const l of this.eval(node.left, input, env)) {
          if (truthy(l)) {
            yield true;
            continue;
          }
          for (const r of this.eval(node.right, input, env)) yield truthy(r);
        }
        return;
      case "alt": {
        let any = false;
        try {
          for (const v of this.eval(node.left, input, env)) {
            if (truthy(v)) {
              any = true;
              yield v;
            }
          }
        } catch (e) {
          if (!(e instanceof JqError)) throw e;
        }
        if (!any) yield* this.eval(node.right, input, env);
        return;
      }
      case "if":
        yield* this.evalIf(node.cond, node.then, node.elifs, node.otherwise, input, env);
        return;
      case "as":
        for (const v of this.eval(node.source, input, env)) yield* this.eval(node.body, input, withVar(env, node.name, v));
        return;
      case "reduce": {
        for (const init of this.eval(node.init, input, env)) {
          let acc: Json = init;
          for (const item of this.eval(node.source, input, env)) {
            let last: Json | undefined;
            for (const v of this.eval(node.update, acc, withVar(env, node.name, item))) last = v;
            acc = last === undefined ? null : last;
          }
          yield acc;
        }
        return;
      }
      case "foreach": {
        for (const init of this.eval(node.init, input, env)) {
          let acc: Json = init;
          for (const item of this.eval(node.source, input, env)) {
            const itemEnv = withVar(env, node.name, item);
            for (const v of this.eval(node.update, acc, itemEnv)) {
              acc = v;
              if (node.extract) yield* this.eval(node.extract, v, itemEnv);
              else yield v;
            }
          }
        }
        return;
      }
      case "assign":
        yield* this.evalAssign(node.op, node.lhs, node.rhs, input, env);
        return;
      case "def": {
        const funcs = new Map(env.funcs);
        const fnEnv: Env = { ...env, funcs };
        funcs.set(`${node.name}/${node.params.length}`, { params: node.params, body: node.body, env: fnEnv });
        yield* this.eval(node.rest, input, fnEnv);
        return;
      }
      case "call":
        yield* this.call(node.name, node.args, input, env);
        return;
    }
  }

  private *evalIf(cond: Node, then: Node, elifs: { cond: Node; then: Node }[], otherwise: Node | null, input: Json, env: Env): Generator<Json> {
    for (const c of this.eval(cond, input, env)) {
      if (truthy(c)) yield* this.eval(then, input, env);
      else if (elifs.length > 0) yield* this.evalIf(elifs[0].cond, elifs[0].then, elifs.slice(1), otherwise, input, env);
      else if (otherwise) yield* this.eval(otherwise, input, env);
      else yield input;
    }
  }

  private *evalString(parts: (string | Node)[], format: string | null, input: Json, env: Env, i: number, acc: string): Generator<Json> {
    if (i === parts.length) {
      yield acc;
      return;
    }
    const part = parts[i];
    if (typeof part === "string") {
      yield* this.evalString(parts, format, input, env, i + 1, acc + part);
      return;
    }
    for (const v of this.eval(part, input, env)) {
      const text = format ? applyFormat(format, v) : toJqString(v);
      yield* this.evalString(parts, format, input, env, i + 1, acc + text);
    }
  }

  private *evalObject(entries: { key: Node; value: Node | null; keyVar?: string }[], i: number, input: Json, env: Env, acc: Record<string, Json>): Generator<Json> {
    if (i === entries.length) {
      yield acc;
      return;
    }
    const entry = entries[i];
    for (const k of this.eval(entry.key, input, env)) {
      if (typeof k !== "string") throw new JqError(`Object keys must be strings`);
      let values: Iterable<Json>;
      if (entry.value) values = this.eval(entry.value, input, env);
      else if (entry.keyVar !== undefined) values = this.eval({ k: "var", name: entry.keyVar }, input, env);
      else values = one(indexValue(input, k));
      for (const v of values) yield* this.evalObject(entries, i + 1, input, env, { ...acc, [k]: v });
    }
  }

  *recurse(v: Json): Generator<Json> {
    this.budget.tick();
    yield v;
    if (Array.isArray(v)) for (const x of v) yield* this.recurse(x);
    else if (isObj(v)) for (const x of Object.values(v)) yield* this.recurse(x);
  }

  /** Enumerate [path, value] pairs for a path expression. */
  *paths(node: Node, input: Json, env: Env, base: Path = []): Generator<[Path, Json]> {
    this.budget.tick();
    switch (node.k) {
      case "identity":
        yield [base, input];
        return;
      case "recurse_default":
        yield* this.recursePaths(input, base);
        return;
      case "index":
        for (const [p, v] of this.paths(node.target, input, env, base)) {
          for (const k of this.eval(node.key, input, env)) {
            if (typeof k !== "string" && typeof k !== "number") {
              if (isObj(k)) {
                yield [[...p, { start: k.start ?? null, end: k.end ?? null }], indexValue(v, k)];
                continue;
              }
              throw new JqError(`Cannot index ${jqType(v)} with ${jqType(k)}`);
            }
            yield [[...p, k], indexValue(v, k)];
          }
        }
        return;
      case "slice":
        for (const [p, v] of this.paths(node.target, input, env, base)) {
          for (const to of node.to ? this.eval(node.to, input, env) : one(null)) {
            for (const from of node.from ? this.eval(node.from, input, env) : one(null)) {
              yield [[...p, { start: from, end: to }], sliceValue(v, from, to)];
            }
          }
        }
        return;
      case "iterate":
        for (const [p, v] of this.paths(node.target, input, env, base)) {
          if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield [[...p, i], v[i]];
          else if (isObj(v)) for (const key of Object.keys(v)) yield [[...p, key], v[key]];
          else if (v !== null) throw new JqError(`Cannot iterate over ${jqType(v)} (${errValue(v)})`);
        }
        return;
      case "pipe":
        for (const [p, v] of this.paths(node.left, input, env, base)) yield* this.paths(node.right, v, env, p);
        return;
      case "comma":
        yield* this.paths(node.left, input, env, base);
        yield* this.paths(node.right, input, env, base);
        return;
      case "try": {
        const results: [Path, Json][] = [];
        try {
          for (const r of this.paths(node.body, input, env, base)) results.push(r);
        } catch (e) {
          if (!(e instanceof JqError)) throw e;
        }
        yield* results;
        return;
      }
      case "if":
        for (const c of this.eval(node.cond, input, env)) {
          if (truthy(c)) yield* this.paths(node.then, input, env, base);
          else if (node.elifs.length > 0) {
            yield* this.paths({ k: "if", cond: node.elifs[0].cond, then: node.elifs[0].then, elifs: node.elifs.slice(1), otherwise: node.otherwise }, input, env, base);
          } else if (node.otherwise) yield* this.paths(node.otherwise, input, env, base);
          else yield [base, input];
        }
        return;
      case "alt": {
        let any = false;
        try {
          for (const [p, v] of this.paths(node.left, input, env, base)) {
            if (truthy(v)) {
              any = true;
              yield [p, v];
            }
          }
        } catch (e) {
          if (!(e instanceof JqError)) throw e;
        }
        if (!any) yield* this.paths(node.right, input, env, base);
        return;
      }
      case "as":
        for (const v of this.eval(node.source, input, env)) yield* this.paths(node.body, input, withVar(env, node.name, v), base);
        return;
      case "literal":
        if (node.value === null) {
          yield [base, null];
          return;
        }
        break;
      case "def": {
        const funcs = new Map(env.funcs);
        const fnEnv: Env = { ...env, funcs };
        funcs.set(`${node.name}/${node.params.length}`, { params: node.params, body: node.body, env: fnEnv });
        yield* this.paths(node.rest, input, fnEnv, base);
        return;
      }
      case "call":
        yield* this.callPaths(node, input, env, base);
        return;
      default:
        break;
    }
    throw new JqError(`Invalid path expression with result ${errValue(firstOf(this.eval(node, input, env)) ?? null)}`);
  }

  *recursePaths(v: Json, base: Path): Generator<[Path, Json]> {
    this.budget.tick();
    yield [base, v];
    if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* this.recursePaths(v[i], [...base, i]);
    else if (isObj(v)) for (const key of Object.keys(v)) yield* this.recursePaths(v[key], [...base, key]);
  }

  private *callPaths(node: Extract<Node, { k: "call" }>, input: Json, env: Env, base: Path): Generator<[Path, Json]> {
    const { name, args } = node;
    const closure = args.length === 0 ? env.closures.get(name) : undefined;
    if (closure) {
      yield* this.paths(closure.node, input, closure.env, base);
      return;
    }
    const user = env.funcs.get(`${name}/${args.length}`);
    if (user) {
      const fnEnv = this.bindUserFunction(user, args, input, env);
      if (fnEnv) yield* this.paths(user.body, input, fnEnv, base);
      else {
        for (const bound of this.bindValueParams(user, args, input, env)) yield* this.paths(user.body, input, bound, base);
      }
      return;
    }
    switch (`${name}/${args.length}`) {
      case "empty/0":
        return;
      case "select/1":
        for (const c of this.eval(args[0], input, env)) if (truthy(c)) yield [base, input];
        return;
      case "recurse/0":
        yield* this.recursePaths(input, base);
        return;
      case "recurse/1": {
        const self = this;
        const walk = function* (p: Path, v: Json): Generator<[Path, Json]> {
          self.budget.tick();
          yield [p, v];
          for (const [cp, cv] of self.paths(args[0], v, env, p)) yield* walk(cp, cv);
        };
        yield* walk(base, input);
        return;
      }
      case "first/1":
        for (const r of this.paths(args[0], input, env, base)) {
          yield r;
          return;
        }
        return;
      case "last/1": {
        let last: [Path, Json] | undefined;
        for (const r of this.paths(args[0], input, env, base)) last = r;
        if (last) yield last;
        return;
      }
      case "first/0":
        yield [[...base, 0], indexValue(input, 0)];
        return;
      case "last/0":
        yield [[...base, -1], indexValue(input, -1)];
        return;
      case "getpath/1":
        for (const p of this.eval(args[0], input, env)) {
          const path = jsonToPath(p);
          let value: Json = null;
          try {
            value = getPath(input, path);
          } catch {
            value = null;
          }
          yield [[...base, ...path], value];
        }
        return;
      case "paths/0":
        for (const [p, v] of this.recursePaths(input, base)) if (p.length > base.length) yield [p, v];
        return;
      case "error/0":
      case "error/1":
        yield* this.eval(node, input, env) as unknown as Generator<[Path, Json]>;
        return;
      default:
        throw new JqError(`Invalid path expression with result ${errValue(firstOf(this.call(name, args, input, env)) ?? null)}`);
    }
  }

  private bindUserFunction(fn: UserFunction, args: Node[], _input: Json, env: Env): Env | null {
    if (fn.params.some((p) => p.startsWith("$"))) return null;
    const closures = new Map(fn.env.closures);
    fn.params.forEach((param, i) => closures.set(param, { node: args[i], env }));
    const funcs = new Map(fn.env.funcs);
    return { vars: fn.env.vars, funcs, closures };
  }

  /** Cartesian product over `$param` value arguments. */
  private *bindValueParams(fn: UserFunction, args: Node[], input: Json, env: Env, i = 0, acc?: Env): Generator<Env> {
    const base: Env = acc ?? { vars: new Map(fn.env.vars), funcs: new Map(fn.env.funcs), closures: new Map(fn.env.closures) };
    if (i === fn.params.length) {
      yield base;
      return;
    }
    const param = fn.params[i];
    if (param.startsWith("$")) {
      for (const v of this.eval(args[i], input, env)) {
        const vars = new Map(base.vars);
        vars.set(param.slice(1), v);
        const closures = new Map(base.closures);
        closures.set(param.slice(1), { node: { k: "literal", value: v }, env });
        yield* this.bindValueParams(fn, args, input, env, i + 1, { ...base, vars, closures });
      }
      return;
    }
    const closures = new Map(base.closures);
    closures.set(param, { node: args[i], env });
    yield* this.bindValueParams(fn, args, input, env, i + 1, { ...base, closures });
  }

  *call(name: string, args: Node[], input: Json, env: Env): Generator<Json> {
    if (args.length === 0) {
      const closure = env.closures.get(name);
      if (closure) {
        yield* this.eval(closure.node, input, closure.env);
        return;
      }
    }
    const user = env.funcs.get(`${name}/${args.length}`);
    if (user) {
      const fnEnv = this.bindUserFunction(user, args, input, env);
      if (fnEnv) yield* this.eval(user.body, input, fnEnv);
      else for (const bound of this.bindValueParams(user, args, input, env)) yield* this.eval(user.body, input, bound);
      return;
    }
    const builtin = this.builtins.get(`${name}/${args.length}`);
    if (!builtin) throw new JqCompileError(`${name}/${args.length} is not defined`);
    yield* builtin(this, args, input, env);
  }

  private *evalAssign(op: string, lhs: Node, rhs: Node, input: Json, env: Env): Generator<Json> {
    if (op === "|=") {
      let out = input;
      for (const [p] of [...this.paths(lhs, input, env)]) {
        const current = getPath(out, p);
        const next = firstOf(this.eval(rhs, current, env));
        out = next === undefined ? deletePaths(out, [p]) : setPath(out, p, next);
      }
      yield out;
      return;
    }
    if (op === "=") {
      for (const value of this.eval(rhs, input, env)) {
        let out = input;
        for (const [p] of [...this.paths(lhs, input, env)]) out = setPath(out, p, value);
        yield out;
      }
      return;
    }
    const arithOp = op.slice(0, -1);
    for (const rv of this.eval(rhs, input, env)) {
      let out = input;
      for (const [p] of [...this.paths(lhs, input, env)]) {
        const current = getPath(out, p);
        out = setPath(out, p, arithOp === "//" ? (truthy(current) ? current : rv) : arith(arithOp, current, rv));
      }
      yield out;
    }
  }

  evalOne(node: Node, input: Json, env: Env): Json[] {
    return [...this.eval(node, input, env)];
  }
}

function buildBuiltins(): Map<string, BuiltinFn> {
  const b = new Map<string, BuiltinFn>();
  const def = (name: string, arity: number, fn: BuiltinFn) => b.set(`${name}/${arity}`, fn);
  /** Define a builtin whose args are all evaluated to values (cartesian product). */
  const defValues = (name: string, arity: number, fn: (input: Json, ...args: Json[]) => Json) =>
    def(name, arity, function* (ctx, args, input, env) {
      const combos = (i: number, acc: Json[]): Json[][] => {
        if (i === args.length) return [acc];
        const out: Json[][] = [];
        for (const v of ctx.eval(args[i], input, env)) out.push(...combos(i + 1, [...acc, v]));
        return out;
      };
      for (const values of combos(0, [])) yield fn(input, ...values);
    });

  def("empty", 0, function* () {});
  def("not", 0, function* (_c, _a, input) {
    yield !truthy(input);
  });
  defValues("error", 0, (input) => {
    throw new JqError(input);
  });
  defValues("error", 1, (_input, msg) => {
    throw new JqError(msg);
  });
  defValues("length", 0, (v) => {
    if (v === null) return 0;
    if (typeof v === "boolean") throw new JqError(`boolean (${v}) has no length`);
    if (typeof v === "number") return Math.abs(v);
    if (typeof v === "string") return [...v].length;
    if (Array.isArray(v)) return v.length;
    return Object.keys(v).length;
  });
  defValues("utf8bytelength", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "only strings have UTF-8 byte length");
    return new TextEncoder().encode(v).length;
  });
  const keysOf = (v: Json, sorted: boolean): Json => {
    if (Array.isArray(v)) return v.map((_, i) => i);
    if (isObj(v)) return sorted ? Object.keys(v).sort() : Object.keys(v);
    throw typeErr(v, "has no keys");
  };
  defValues("keys", 0, (v) => keysOf(v, true));
  defValues("keys_unsorted", 0, (v) => keysOf(v, false));
  defValues("has", 1, (v, k) => {
    if (isObj(v) && typeof k === "string") return Object.prototype.hasOwnProperty.call(v, k);
    if (Array.isArray(v) && typeof k === "number") return k >= 0 && k < v.length;
    throw new JqError(`Cannot check whether ${jqType(v)} has a ${jqType(k)} key`);
  });
  defValues("in", 1, (k, v) => {
    if (isObj(v) && typeof k === "string") return Object.prototype.hasOwnProperty.call(v, k);
    if (Array.isArray(v) && typeof k === "number") return k >= 0 && k < v.length;
    throw new JqError(`Cannot check whether ${jqType(v)} has a ${jqType(k)} key`);
  });
  def("select", 1, function* (ctx, args, input, env) {
    for (const c of ctx.eval(args[0], input, env)) if (truthy(c)) yield input;
  });
  def("map", 1, function* (ctx, args, input, env) {
    const items = Array.isArray(input) ? input : isObj(input) ? Object.values(input) : null;
    if (items === null) throw new JqError(`Cannot iterate over ${jqType(input)}${input === null ? "" : ` (${errValue(input)})`}`);
    const out: Json[] = [];
    for (const item of items) out.push(...ctx.eval(args[0], item, env));
    yield out;
  });
  def("map_values", 1, function* (ctx, args, input, env) {
    if (Array.isArray(input)) {
      const out: Json[] = [];
      for (const item of input) {
        const v = firstOf(ctx.eval(args[0], item, env));
        if (v !== undefined) out.push(v);
      }
      yield out;
      return;
    }
    if (isObj(input)) {
      const out: Record<string, Json> = {};
      for (const [k, item] of Object.entries(input)) {
        const v = firstOf(ctx.eval(args[0], item, env));
        if (v !== undefined) out[k] = v;
      }
      yield out;
      return;
    }
    throw new JqError(`Cannot iterate over ${jqType(input)}`);
  });
  def("path", 1, function* (ctx, args, input, env) {
    for (const [p] of ctx.paths(args[0], input, env)) yield pathToJson(p);
  });
  def("paths", 0, function* (ctx, _args, input) {
    for (const [p] of ctx.recursePaths(input, [])) if (p.length > 0) yield pathToJson(p);
  });
  def("paths", 1, function* (ctx, args, input, env) {
    for (const [p, v] of ctx.recursePaths(input, [])) {
      if (p.length === 0) continue;
      for (const c of ctx.eval(args[0], v, env)) if (truthy(c)) yield pathToJson(p);
    }
  });
  def("leaf_paths", 0, function* (ctx, _args, input) {
    for (const [p, v] of ctx.recursePaths(input, [])) if (p.length > 0 && !Array.isArray(v) && !isObj(v)) yield pathToJson(p);
  });
  defValues("getpath", 1, (v, p) => {
    try {
      return getPath(v, jsonToPath(p));
    } catch {
      return null;
    }
  });
  defValues("setpath", 2, (v, p, value) => setPath(v, jsonToPath(p), value));
  defValues("delpaths", 1, (v, ps) => {
    if (!Array.isArray(ps)) throw new JqError("Paths must be specified as an array");
    return deletePaths(v, ps.map(jsonToPath));
  });
  def("del", 1, function* (ctx, args, input, env) {
    const ps = [...ctx.paths(args[0], input, env)].map(([p]) => p);
    yield deletePaths(input, ps);
  });
  defValues("to_entries", 0, (v) => {
    if (!isObj(v)) throw typeErr(v, "has no keys");
    return Object.entries(v).map(([key, value]) => ({ key, value }));
  });
  defValues("from_entries", 0, (v) => {
    if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${jqType(v)}`);
    const out: Record<string, Json> = {};
    for (const e of v) {
      if (!isObj(e)) throw new JqError(`Cannot index ${jqType(e)} with "key"`);
      const key = e.key ?? e.k ?? e.name ?? e.Name ?? e.Key ?? e.K ?? null;
      const value = "value" in e ? e.value : "v" in e ? e.v : "Value" in e ? e.Value : null;
      if (key === null || typeof key === "boolean") throw new JqError(`Cannot use ${jqType(key)} (${errValue(key)}) as object key`);
      out[typeof key === "string" ? key : JSON.stringify(key)] = value;
    }
    return out;
  });
  def("with_entries", 1, function* (ctx, args, input, env) {
    if (!isObj(input)) throw typeErr(input, "has no keys");
    const mapped: Json[] = [];
    for (const [key, value] of Object.entries(input)) mapped.push(...ctx.eval(args[0], { key, value }, env));
    yield* ctx.call("from_entries", [], mapped, env);
  });
  defValues("add", 0, (v) => {
    const items = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null;
    if (items === null) throw new JqError(`Cannot iterate over ${jqType(v)}`);
    return items.reduce<Json>((acc, x) => arith("+", acc, x), null);
  });
  def("add", 1, function* (ctx, args, input, env) {
    let acc: Json = null;
    for (const v of ctx.eval(args[0], input, env)) acc = arith("+", acc, v);
    yield acc;
  });
  defValues("any", 0, (v) => (Array.isArray(v) ? v.some(truthy) : isObj(v) ? Object.values(v).some(truthy) : false));
  defValues("all", 0, (v) => (Array.isArray(v) ? v.every(truthy) : isObj(v) ? Object.values(v).every(truthy) : true));
  def("any", 1, function* (ctx, args, input, env) {
    const items = Array.isArray(input) ? input : isObj(input) ? Object.values(input) : [];
    yield items.some((item) => ctx.evalOne(args[0], item, env).some(truthy));
  });
  def("all", 1, function* (ctx, args, input, env) {
    const items = Array.isArray(input) ? input : isObj(input) ? Object.values(input) : [];
    yield items.every((item) => ctx.evalOne(args[0], item, env).every(truthy));
  });
  def("any", 2, function* (ctx, args, input, env) {
    for (const v of ctx.eval(args[0], input, env)) {
      if (ctx.evalOne(args[1], v, env).some(truthy)) {
        yield true;
        return;
      }
    }
    yield false;
  });
  def("all", 2, function* (ctx, args, input, env) {
    for (const v of ctx.eval(args[0], input, env)) {
      if (!ctx.evalOne(args[1], v, env).every(truthy)) {
        yield false;
        return;
      }
    }
    yield true;
  });
  const flatten = (v: Json[], depth: number): Json[] => v.reduce<Json[]>((acc, x) => (Array.isArray(x) && depth > 0 ? [...acc, ...flatten(x, depth - 1)] : [...acc, x]), []);
  defValues("flatten", 0, (v) => {
    if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${jqType(v)}`);
    return flatten(v, Infinity);
  });
  defValues("flatten", 1, (v, d) => {
    if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${jqType(v)}`);
    if (typeof d !== "number" || d < 0) throw new JqError("flatten depth must not be negative");
    return flatten(v, d);
  });
  def("range", 1, function* (ctx, args, input, env) {
    for (const n of ctx.eval(args[0], input, env)) {
      if (typeof n !== "number") throw new JqError("Range bounds must be numeric");
      for (let i = 0; i < n; i++) {
        ctx.budget.tick();
        yield i;
      }
    }
  });
  def("range", 2, function* (ctx, args, input, env) {
    for (const from of ctx.eval(args[0], input, env)) {
      for (const to of ctx.eval(args[1], input, env)) {
        if (typeof from !== "number" || typeof to !== "number") throw new JqError("Range bounds must be numeric");
        for (let i = from; i < to; i++) {
          ctx.budget.tick();
          yield i;
        }
      }
    }
  });
  def("range", 3, function* (ctx, args, input, env) {
    for (const from of ctx.eval(args[0], input, env)) {
      for (const to of ctx.eval(args[1], input, env)) {
        for (const by of ctx.eval(args[2], input, env)) {
          if (typeof from !== "number" || typeof to !== "number" || typeof by !== "number") throw new JqError("Range bounds must be numeric");
          if (by === 0) return;
          for (let i = from; by > 0 ? i < to : i > to; i += by) {
            ctx.budget.tick();
            yield i;
          }
        }
      }
    }
  });
  const num = (name: string, fn: (n: number) => number) =>
    defValues(name, 0, (v) => {
      if (typeof v !== "number") throw typeErr(v, "number required");
      return fn(v);
    });
  num("floor", Math.floor);
  num("ceil", Math.ceil);
  num("round", Math.round);
  num("sqrt", Math.sqrt);
  num("fabs", Math.abs);
  num("abs", Math.abs);
  num("log", Math.log);
  num("log2", Math.log2);
  num("log10", Math.log10);
  num("exp", Math.exp);
  num("exp10", (n) => 10 ** n);
  num("trunc", Math.trunc);
  defValues("pow", 2, (_v, a, c) => {
    if (typeof a !== "number" || typeof c !== "number") throw new JqError("pow requires numbers");
    return a ** c;
  });
  defValues("infinite", 0, () => Number.MAX_VALUE);
  defValues("nan", 0, () => null);
  defValues("isinfinite", 0, (v) => typeof v === "number" && !Number.isFinite(v));
  defValues("isnan", 0, (v) => typeof v === "number" && Number.isNaN(v));
  defValues("isnormal", 0, (v) => typeof v === "number" && Number.isFinite(v) && v !== 0);
  defValues("type", 0, (v) => jqType(v));
  defValues("tostring", 0, (v) => toJqString(v));
  defValues("tonumber", 0, (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    throw new JqError(`Cannot parse '${toJqString(v)}' as JSON`);
  });
  defValues("tojson", 0, (v) => JSON.stringify(v));
  defValues("fromjson", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "only strings can be parsed");
    try {
      return JSON.parse(v) as Json;
    } catch {
      throw new JqError(`${v} (while parsing '${v}')`);
    }
  });
  defValues("ascii_downcase", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be lowercased");
    return v.replace(/[A-Z]/g, (c) => c.toLowerCase());
  });
  defValues("ascii_upcase", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be uppercased");
    return v.replace(/[a-z]/g, (c) => c.toUpperCase());
  });
  defValues("explode", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be exploded");
    return [...v].map((c) => c.codePointAt(0) as number);
  });
  defValues("implode", 0, (v) => {
    if (!Array.isArray(v)) throw typeErr(v, "cannot be imploded");
    return String.fromCodePoint(...v.map((c) => Number(c)));
  });
  defValues("ltrimstr", 1, (v, s) => (typeof v === "string" && typeof s === "string" && v.startsWith(s) ? v.slice(s.length) : v));
  defValues("rtrimstr", 1, (v, s) => (typeof v === "string" && typeof s === "string" && s !== "" && v.endsWith(s) ? v.slice(0, -s.length) : v));
  defValues("trim", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be trimmed");
    return v.trim();
  });
  defValues("ltrim", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be trimmed");
    return v.trimStart();
  });
  defValues("rtrim", 0, (v) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be trimmed");
    return v.trimEnd();
  });
  defValues("startswith", 1, (v, s) => {
    if (typeof v !== "string" || typeof s !== "string") throw new JqError("startswith() requires string inputs");
    return v.startsWith(s);
  });
  defValues("endswith", 1, (v, s) => {
    if (typeof v !== "string" || typeof s !== "string") throw new JqError("endswith() requires string inputs");
    return v.endsWith(s);
  });
  defValues("split", 1, (v, s) => {
    if (typeof v !== "string" || typeof s !== "string") throw new JqError("split input and separator must be strings");
    return splitString(v, s);
  });
  defValues("split", 2, (v, re, flags) => {
    if (typeof v !== "string") throw typeErr(v, "cannot be matched, as it is not a string");
    const { regex } = regexFrom(re, flags);
    return v.split(regex);
  });
  defValues("join", 1, (v, sep) => {
    if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${jqType(v)}`);
    if (typeof sep !== "string") throw new JqError("join separator must be a string");
    return v
      .map((x) => {
        if (x === null) return "";
        if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return String(x);
        throw new JqError(`Cannot join with ${jqType(x)}`);
      })
      .join(sep);
  });
  defValues("contains", 1, (v, x) => containsJson(v, x));
  defValues("inside", 1, (v, x) => containsJson(x, v));
  defValues("indices", 1, (v, x) => indicesOf(v, x));
  defValues("index", 1, (v, x) => {
    const r = indicesOf(v, x);
    return Array.isArray(r) && r.length > 0 ? r[0] : null;
  });
  defValues("rindex", 1, (v, x) => {
    const r = indicesOf(v, x);
    return Array.isArray(r) && r.length > 0 ? r[r.length - 1] : null;
  });
  const requireArray = (v: Json, what: string): Json[] => {
    if (!Array.isArray(v)) throw typeErr(v, `cannot be ${what}, as it is not an array`);
    return v;
  };
  defValues("sort", 0, (v) => [...requireArray(v, "sorted")].sort(compareJson));
  defValues("reverse", 0, (v) => {
    if (v === null) return [];
    if (typeof v === "string") return [...v].reverse().join("");
    return [...requireArray(v, "reversed")].reverse();
  });
  defValues("unique", 0, (v) => {
    const sorted = [...requireArray(v, "sorted")].sort(compareJson);
    return sorted.filter((x, i) => i === 0 || compareJson(x, sorted[i - 1]) !== 0);
  });
  const keyed = (ctx: Evaluator, f: Node, input: Json, env: Env, what: string) =>
    requireArray(input, what).map((item, index) => ({ item, index, key: [...ctx.eval(f, item, env)] as Json }));
  def("sort_by", 1, function* (ctx, args, input, env) {
    yield keyed(ctx, args[0], input, env, "sorted")
      .sort((a, b) => compareJson(a.key, b.key) || a.index - b.index)
      .map((x) => x.item);
  });
  def("group_by", 1, function* (ctx, args, input, env) {
    const sorted = keyed(ctx, args[0], input, env, "grouped").sort((a, b) => compareJson(a.key, b.key) || a.index - b.index);
    const groups: Json[][] = [];
    sorted.forEach((x, i) => {
      if (i === 0 || compareJson(x.key, sorted[i - 1].key) !== 0) groups.push([x.item]);
      else groups[groups.length - 1].push(x.item);
    });
    yield groups;
  });
  def("unique_by", 1, function* (ctx, args, input, env) {
    const sorted = keyed(ctx, args[0], input, env, "grouped").sort((a, b) => compareJson(a.key, b.key) || a.index - b.index);
    yield sorted.filter((x, i) => i === 0 || compareJson(x.key, sorted[i - 1].key) !== 0).map((x) => x.item);
  });
  const extreme = (dir: 1 | -1) =>
    function* (ctx: Evaluator, args: Node[], input: Json, env: Env): Generator<Json> {
      const items = args.length ? keyed(ctx, args[0], input, env, "compared") : requireArray(input, "compared").map((item, index) => ({ item, index, key: item }));
      if (items.length === 0) {
        yield null;
        return;
      }
      let best = items[0];
      for (const x of items.slice(1)) {
        const c = compareJson(x.key, best.key);
        if (dir === 1 ? c >= 0 : c < 0) best = x;
      }
      yield best.item;
    };
  def("min", 0, extreme(-1));
  def("max", 0, extreme(1));
  def("min_by", 1, extreme(-1));
  def("max_by", 1, extreme(1));
  defValues("first", 0, (v) => indexValue(v, 0));
  defValues("last", 0, (v) => indexValue(v, -1));
  defValues("nth", 1, (v, n) => indexValue(v, n));
  def("first", 1, function* (ctx, args, input, env) {
    for (const v of ctx.eval(args[0], input, env)) {
      yield v;
      return;
    }
  });
  def("last", 1, function* (ctx, args, input, env) {
    let last: Json | undefined;
    for (const v of ctx.eval(args[0], input, env)) last = v;
    if (last !== undefined) yield last;
  });
  def("nth", 2, function* (ctx, args, input, env) {
    for (const n of ctx.eval(args[0], input, env)) {
      if (typeof n !== "number" || n < 0) throw new JqError("Out of bounds negative array index");
      let i = 0;
      for (const v of ctx.eval(args[1], input, env)) {
        if (i === n) {
          yield v;
          break;
        }
        i++;
      }
    }
  });
  def("limit", 2, function* (ctx, args, input, env) {
    for (const n of ctx.eval(args[0], input, env)) {
      if (typeof n !== "number" || n <= 0) continue;
      let i = 0;
      for (const v of ctx.eval(args[1], input, env)) {
        yield v;
        if (++i >= n) break;
      }
    }
  });
  def("until", 2, function* (ctx, args, input, env) {
    let cur = input;
    for (;;) {
      ctx.budget.tick();
      if (truthy(firstOf(ctx.eval(args[0], cur, env)) ?? null)) break;
      cur = firstOf(ctx.eval(args[1], cur, env)) ?? null;
    }
    yield cur;
  });
  def("while", 2, function* (ctx, args, input, env) {
    let cur = input;
    for (;;) {
      ctx.budget.tick();
      if (!truthy(firstOf(ctx.eval(args[0], cur, env)) ?? null)) break;
      yield cur;
      const next = firstOf(ctx.eval(args[1], cur, env));
      if (next === undefined) break;
      cur = next;
    }
  });
  def("repeat", 1, function* (ctx, args, input, env) {
    let cur = input;
    for (;;) {
      ctx.budget.tick();
      yield cur;
      const next = firstOf(ctx.eval(args[0], cur, env));
      if (next === undefined) return;
      cur = next;
    }
  });
  def("recurse", 0, function* (ctx, _args, input) {
    yield* ctx.recurse(input);
  });
  def("recurse", 1, function* (ctx, args, input, env) {
    const walk = function* (v: Json): Generator<Json> {
      ctx.budget.tick();
      yield v;
      for (const child of ctx.eval(args[0], v, env)) yield* walk(child);
    };
    yield* walk(input);
  });
  def("recurse", 2, function* (ctx, args, input, env) {
    const walk = function* (v: Json): Generator<Json> {
      ctx.budget.tick();
      yield v;
      for (const child of ctx.eval(args[0], v, env)) {
        if (ctx.evalOne(args[1], child, env).some(truthy)) yield* walk(child);
      }
    };
    yield* walk(input);
  });
  def("env", 0, function* (ctx) {
    yield { ...ctx.envVars };
  });
  def("input_filename", 0, function* () {
    yield null;
  });
  def("debug", 0, function* (_ctx, _args, input) {
    yield input;
  });
  def("isvalid", 1, function* (ctx, args, input, env) {
    try {
      ctx.evalOne(args[0], input, env);
      yield true;
    } catch (e) {
      if (e instanceof JqError) yield false;
      else throw e;
    }
  });
  def("isempty", 1, function* (ctx, args, input, env) {
    for (const _ of ctx.eval(args[0], input, env)) {
      yield false;
      return;
    }
    yield true;
  });
  def("error", 1, function* (ctx, args, input, env) {
    for (const msg of ctx.eval(args[0], input, env)) throw new JqError(msg);
  });
  const typeFilter = (name: string, pred: (v: Json) => boolean) =>
    def(name, 0, function* (_c, _a, input) {
      if (pred(input)) yield input;
    });
  typeFilter("arrays", Array.isArray);
  typeFilter("objects", isObj);
  typeFilter("iterables", (v) => Array.isArray(v) || isObj(v));
  typeFilter("scalars", (v) => !Array.isArray(v) && !isObj(v));
  typeFilter("strings", (v) => typeof v === "string");
  typeFilter("numbers", (v) => typeof v === "number");
  typeFilter("booleans", (v) => typeof v === "boolean");
  typeFilter("nulls", (v) => v === null);
  typeFilter("values", (v) => v !== null);
  defValues("transpose", 0, (v) => {
    const rows = requireArray(v, "transposed").map((r) => (Array.isArray(r) ? r : []));
    const width = Math.max(0, ...rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => rows.map((r) => (i < r.length ? r[i] : null)));
  });
  defValues("ascii", 0, (v) => String.fromCharCode(Number(v)));
  def("splits", 1, function* (ctx, args, input, env) {
    for (const re of ctx.eval(args[0], input, env)) {
      if (typeof input !== "string") throw typeErr(input, "cannot be matched, as it is not a string");
      yield* input.split(regexFrom(re, null).regex);
    }
  });
  const regexBuiltin = (name: string, arity: 1 | 2, fn: (input: string, re: Json, flags: Json) => Generator<Json>) =>
    def(name, arity, function* (ctx, args, input, env) {
      if (typeof input !== "string") throw typeErr(input, "cannot be matched, as it is not a string");
      for (const re of ctx.eval(args[0], input, env)) {
        if (arity === 2) {
          for (const flags of ctx.eval(args[1], input, env)) yield* fn(input, re, flags);
        } else if (Array.isArray(re)) {
          yield* fn(input, re[0] ?? null, re[1] ?? null);
        } else {
          yield* fn(input, re, null);
        }
      }
    });
  for (const arity of [1, 2] as const) {
    regexBuiltin("test", arity, function* (input, re, flags) {
      yield matchObjects(input, re, flags, false).length > 0;
    });
    regexBuiltin("match", arity, function* (input, re, flags) {
      yield* matchObjects(input, re, flags, false);
    });
    regexBuiltin("capture", arity, function* (input, re, flags) {
      for (const m of matchObjects(input, re, flags, false)) {
        const out: Record<string, Json> = {};
        for (const c of (m as { captures: { name: Json; string: Json }[] }).captures) if (typeof c.name === "string") out[c.name] = c.string;
        yield out;
      }
    });
    regexBuiltin("scan", arity, function* (input, re, flags) {
      for (const m of matchObjects(input, re, flags, true)) {
        const caps = (m as { captures: { string: Json }[]; string: Json }).captures;
        yield caps.length > 0 ? caps.map((c) => c.string) : (m as { string: Json }).string;
      }
    });
  }
  const substitute = (global: boolean) =>
    function* (ctx: Evaluator, args: Node[], input: Json, env: Env): Generator<Json> {
      if (typeof input !== "string") throw typeErr(input, "cannot be matched, as it is not a string");
      const flagValues = args.length === 3 ? ctx.evalOne(args[2], input, env) : [null];
      for (const re of ctx.eval(args[0], input, env)) {
        for (const flags of flagValues) {
          const { regex, global: g } = regexFrom(re, flags);
          const all = global || g;
          let result = "";
          let last = 0;
          let m: RegExpExecArray | null;
          let matched = false;
          while ((m = regex.exec(input)) !== null) {
            matched = true;
            const captures: Record<string, Json> = {};
            for (const [name, value] of Object.entries(m.groups ?? {})) captures[name] = value ?? null;
            const replacement = firstOf(ctx.eval(args[1], captures, env));
            if (typeof replacement !== "string") throw new JqError(`${jqType(replacement ?? null)} cannot be added to a string`);
            result += input.slice(last, m.index) + replacement;
            last = m.index + m[0].length;
            if (m[0] === "") regex.lastIndex++;
            if (!all) break;
          }
          yield matched ? result + input.slice(last) : input;
        }
      }
    };
  def("sub", 2, substitute(false));
  def("sub", 3, substitute(false));
  def("gsub", 2, substitute(true));
  def("gsub", 3, substitute(true));
  def("tojson", 0, function* (_c, _a, input) {
    yield JSON.stringify(input);
  });
  def("builtins", 0, function* (ctx) {
    yield [...ctx.builtins.keys()];
  });
  def("halt_error", 0, function* (_c, _a, input) {
    throw new JqError(input);
  });
  def("getpath", 1, function* (ctx, args, input, env) {
    for (const p of ctx.eval(args[0], input, env)) {
      try {
        yield getPath(input, jsonToPath(p));
      } catch {
        yield null;
      }
    }
  });
  def("to_number", 0, function* (ctx, _a, input, env) {
    yield* ctx.call("tonumber", [], input, env);
  });
  def("splits", 2, function* (ctx, args, input, env) {
    for (const re of ctx.eval(args[0], input, env)) {
      for (const flags of ctx.eval(args[1], input, env)) {
        if (typeof input !== "string") throw typeErr(input, "cannot be matched, as it is not a string");
        yield* input.split(regexFrom(re, flags).regex);
      }
    }
  });
  return b;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface CompiledProgram {
  run(input: Json): Generator<Json>;
}

export function compile(program: string, variables: Record<string, Json> = {}, envVars: Record<string, string> = {}): CompiledProgram {
  const ast = new Parser(program.trim() === "" ? "." : program).parseProgram();
  const evaluator = new Evaluator(envVars);
  const env: Env = { vars: new Map(Object.entries(variables)), funcs: new Map(), closures: new Map() };
  return {
    run(input: Json) {
      return evaluator.eval(ast, input, env);
    },
  };
}

/** Parse a stream of concatenated/whitespace-separated JSON texts (NDJSON, `{..}{..}`, etc.). */
export function parseJsonStream(text: string): Json[] {
  const values: Json[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      let depth = 0;
      for (; i < n; i++) {
        const c = text[i];
        if (c === '"') {
          i++;
          while (i < n && text[i] !== '"') {
            if (text[i] === "\\") i++;
            i++;
          }
          continue;
        }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else if (ch === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
    } else {
      while (i < n && !/[\s{}[\]"]/.test(text[i])) i++;
    }
    const chunk = text.slice(start, i);
    try {
      values.push(JSON.parse(chunk) as Json);
    } catch {
      const before = text.slice(0, start);
      const line = before.split("\n").length;
      const column = start - before.lastIndexOf("\n");
      throw new JqError(`Invalid JSON text at line ${line}, column ${column}: ${chunk.length > 30 ? chunk.slice(0, 30) + "…" : chunk}`);
    }
  }
  return values;
}

export interface FormatOptions {
  indent: number;
  compact: boolean;
  color: boolean;
  sortKeys: boolean;
  tab: boolean;
}

const JQ_COLORS = {
  null: "1;30",
  false: "0;39",
  true: "0;39",
  number: "0;39",
  string: "0;32",
  array: "1;39",
  object: "1;39",
  key: "34;1",
};

function colored(code: string, text: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Serialize like jq's default output (2-space indent, optional colors). */
export function formatJson(v: Json, options: FormatOptions, level = 0): string {
  const { color } = options;
  const unit = options.tab ? "\t" : " ".repeat(options.indent);
  const pretty = !options.compact && (options.tab || options.indent > 0);
  const pad = (l: number) => (pretty ? unit.repeat(l) : "");
  const nl = pretty ? "\n" : "";
  if (v === null) return colored(JQ_COLORS.null, "null", color);
  if (typeof v === "boolean") return colored(v ? JQ_COLORS.true : JQ_COLORS.false, String(v), color);
  if (typeof v === "number") {
    const text = Number.isFinite(v) ? JSON.stringify(v) : v > 0 ? "1.7976931348623157e+308" : "-1.7976931348623157e+308";
    return colored(JQ_COLORS.number, text, color);
  }
  if (typeof v === "string") return colored(JQ_COLORS.string, JSON.stringify(v), color);
  if (Array.isArray(v)) {
    if (v.length === 0) return colored(JQ_COLORS.array, "[]", color);
    const items = v.map((x) => pad(level + 1) + formatJson(x, options, level + 1));
    return colored(JQ_COLORS.array, "[", color) + nl + items.join(colored(JQ_COLORS.array, ",", color) + nl) + nl + pad(level) + colored(JQ_COLORS.array, "]", color);
  }
  const keys = options.sortKeys ? Object.keys(v).sort() : Object.keys(v);
  if (keys.length === 0) return colored(JQ_COLORS.object, "{}", color);
  const sep = pretty ? ": " : ":";
  const items = keys.map((key) => pad(level + 1) + colored(JQ_COLORS.key, JSON.stringify(key), color) + colored(JQ_COLORS.object, sep, color) + formatJson(v[key], options, level + 1));
  return colored(JQ_COLORS.object, "{", color) + nl + items.join(colored(JQ_COLORS.object, ",", color) + nl) + nl + pad(level) + colored(JQ_COLORS.object, "}", color);
}
