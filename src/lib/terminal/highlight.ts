/**
 * Lightweight syntax highlighter emitting 24-bit ANSI colors (Monokai Extended,
 * bat's default theme). Used by `bat` and by `fzf --preview`.
 */

import { ansi, stripAnsi } from "./ansi";

type TokenKind = "keyword" | "string" | "number" | "comment" | "function" | "type" | "constant" | "variable" | "key" | "heading" | "punct" | "added" | "removed" | "meta" | "plain";

const COLORS: Record<TokenKind, [number, number, number] | null> = {
  keyword: [249, 38, 114],
  string: [230, 219, 116],
  number: [174, 129, 255],
  constant: [174, 129, 255],
  comment: [117, 113, 94],
  function: [166, 226, 46],
  type: [102, 217, 239],
  variable: [253, 151, 31],
  key: [102, 217, 239],
  heading: [166, 226, 46],
  punct: [248, 248, 242],
  added: [166, 226, 46],
  removed: [249, 38, 114],
  meta: [117, 113, 94],
  plain: null,
};

function paint(kind: TokenKind, text: string): string {
  const color = COLORS[kind];
  if (!color || text === "") return text;
  const painted = ansi.rgb(color[0], color[1], color[2], text);
  if (kind === "heading") return ansi.bold(painted);
  if (kind === "comment") return ansi.italic(painted);
  return painted;
}

interface LanguageSpec {
  name: string;
  aliases: string[];
  extensions: string[];
  filenames?: string[];
  lineComments?: string[];
  blockComment?: [string, string];
  quotes: string[];
  keywords: string[];
  constants?: string[];
  types?: string[];
  capitalizedTypes?: boolean;
  shellVariables?: boolean;
  custom?: "json" | "yaml" | "markdown" | "diff" | "ini" | "dockerfile";
}

const JS_KEYWORDS = [
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let", "new", "of", "return", "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield", "as",
];

export const LANGUAGES: LanguageSpec[] = [
  {
    name: "TypeScript",
    aliases: ["ts", "typescript", "tsx"],
    extensions: ["ts", "tsx", "mts", "cts"],
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    keywords: [...JS_KEYWORDS, "interface", "type", "enum", "implements", "private", "public", "protected", "readonly", "declare", "namespace", "keyof", "satisfies", "abstract"],
    constants: ["true", "false", "null", "undefined", "NaN", "Infinity"],
    types: ["string", "number", "boolean", "unknown", "any", "never", "void", "object", "Record", "Promise", "Array"],
    capitalizedTypes: true,
  },
  {
    name: "JavaScript",
    aliases: ["js", "javascript", "jsx", "node"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    keywords: JS_KEYWORDS,
    constants: ["true", "false", "null", "undefined", "NaN", "Infinity"],
    capitalizedTypes: true,
  },
  {
    name: "JSON",
    aliases: ["json", "jsonc"],
    extensions: ["json", "jsonc", "geojson", "ndjson"],
    filenames: [".prettierrc", ".eslintrc"],
    quotes: ['"'],
    keywords: [],
    constants: ["true", "false", "null"],
    custom: "json",
  },
  {
    name: "Python",
    aliases: ["py", "python", "python3"],
    extensions: ["py", "pyi"],
    lineComments: ["#"],
    quotes: ['"', "'"],
    keywords: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case"],
    constants: ["True", "False", "None", "self"],
    types: ["int", "str", "float", "bool", "list", "dict", "set", "tuple", "bytes"],
    capitalizedTypes: true,
  },
  {
    name: "Bourne Again Shell (bash)",
    aliases: ["sh", "bash", "zsh", "shell"],
    extensions: ["sh", "bash", "zsh"],
    filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_aliases"],
    lineComments: ["#"],
    quotes: ['"', "'"],
    keywords: ["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "local", "export", "readonly", "set", "unset", "source", "alias", "exit", "shift", "trap"],
    constants: ["true", "false"],
    types: ["echo", "cd", "printf", "read", "test", "eval", "exec"],
    shellVariables: true,
  },
  {
    name: "YAML",
    aliases: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    lineComments: ["#"],
    quotes: ['"', "'"],
    keywords: [],
    constants: ["true", "false", "null", "yes", "no", "on", "off", "~"],
    custom: "yaml",
  },
  {
    name: "Markdown",
    aliases: ["md", "markdown", "mdx"],
    extensions: ["md", "markdown", "mdx"],
    filenames: ["README", "CHANGELOG"],
    quotes: [],
    keywords: [],
    custom: "markdown",
  },
  {
    name: "Go",
    aliases: ["go", "golang"],
    extensions: ["go"],
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    keywords: ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var"],
    constants: ["true", "false", "nil", "iota"],
    types: ["string", "int", "int64", "int32", "uint", "byte", "rune", "bool", "error", "float64", "any"],
    capitalizedTypes: true,
  },
  {
    name: "Rust",
    aliases: ["rs", "rust"],
    extensions: ["rs"],
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"'],
    keywords: ["as", "async", "await", "break", "const", "continue", "crate", "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "type", "unsafe", "use", "where", "while", "dyn"],
    constants: ["true", "false", "None", "Some", "Ok", "Err"],
    types: ["i32", "i64", "u8", "u32", "u64", "usize", "f64", "bool", "str", "String", "Vec", "Option", "Result"],
    capitalizedTypes: true,
  },
  {
    name: "SQL",
    aliases: ["sql", "psql"],
    extensions: ["sql"],
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    quotes: ["'", '"'],
    keywords: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop", "index", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "as", "and", "or", "not", "in", "is", "primary", "key", "references", "unique", "default", "returning", "with", "distinct", "union"].flatMap((k) => [k, k.toUpperCase()]),
    constants: ["true", "false", "null", "TRUE", "FALSE", "NULL"],
    types: ["int", "integer", "text", "varchar", "boolean", "timestamp", "serial", "uuid", "jsonb", "INT", "INTEGER", "TEXT", "VARCHAR", "BOOLEAN", "TIMESTAMP", "SERIAL", "UUID", "JSONB"],
  },
  {
    name: "Dockerfile",
    aliases: ["dockerfile", "docker"],
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
    lineComments: ["#"],
    quotes: ['"', "'"],
    keywords: [],
    shellVariables: true,
    custom: "dockerfile",
  },
  {
    name: "TOML / INI",
    aliases: ["toml", "ini", "conf", "cfg", "env"],
    extensions: ["toml", "ini", "conf", "cfg", "env", "service"],
    filenames: [".env", ".gitconfig", ".editorconfig"],
    lineComments: ["#", ";"],
    quotes: ['"', "'"],
    keywords: [],
    constants: ["true", "false"],
    custom: "ini",
  },
  {
    name: "Diff",
    aliases: ["diff", "patch"],
    extensions: ["diff", "patch"],
    quotes: [],
    keywords: [],
    custom: "diff",
  },
  {
    name: "Plain Text",
    aliases: ["txt", "text", "plain", "log"],
    extensions: ["txt", "log", "csv", "tsv"],
    filenames: [".gitignore", ".dockerignore", "LICENSE"],
    quotes: [],
    keywords: [],
  },
];

const PLAIN = LANGUAGES[LANGUAGES.length - 1];

export function findLanguage(name: string): LanguageSpec | null {
  const lower = name.toLowerCase();
  return LANGUAGES.find((l) => l.aliases.includes(lower) || l.name.toLowerCase() === lower || l.extensions.includes(lower)) ?? null;
}

export function detectLanguage(path: string, firstLine = ""): LanguageSpec {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const byName = LANGUAGES.find((l) => l.filenames?.some((f) => f === base || base.startsWith(f + ".")));
  if (byName) return byName;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    const byExt = LANGUAGES.find((l) => l.extensions.includes(ext));
    if (byExt) return byExt;
  }
  if (/^#!.*\b(ba|z)?sh\b/.test(firstLine)) return findLanguage("bash") as LanguageSpec;
  if (/^#!.*\bpython/.test(firstLine)) return findLanguage("python") as LanguageSpec;
  if (/^#!.*\bnode/.test(firstLine)) return findLanguage("js") as LanguageSpec;
  if (/^\s*[{[]/.test(firstLine)) return findLanguage("json") as LanguageSpec;
  return PLAIN;
}

interface HighlightState {
  inBlockComment: boolean;
  inFence: boolean;
}

function highlightGeneric(line: string, lang: LanguageSpec, state: HighlightState): string {
  const keywords = new Set(lang.keywords);
  const constants = new Set(lang.constants ?? []);
  const types = new Set(lang.types ?? []);
  let out = "";
  let i = 0;

  while (i < line.length) {
    if (state.inBlockComment && lang.blockComment) {
      const end = line.indexOf(lang.blockComment[1], i);
      if (end === -1) {
        out += paint("comment", line.slice(i));
        return out;
      }
      out += paint("comment", line.slice(i, end + lang.blockComment[1].length));
      i = end + lang.blockComment[1].length;
      state.inBlockComment = false;
      continue;
    }
    const rest = line.slice(i);
    if (lang.blockComment && rest.startsWith(lang.blockComment[0])) {
      state.inBlockComment = true;
      out += paint("comment", lang.blockComment[0]);
      i += lang.blockComment[0].length;
      continue;
    }
    const lineComment = lang.lineComments?.find((c) => rest.startsWith(c));
    if (lineComment && (lineComment !== "#" || i === 0 || /\s/.test(line[i - 1]))) {
      out += paint("comment", rest);
      return out;
    }
    const ch = line[i];
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      out += paint("string", line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }
    if (lang.shellVariables && ch === "$") {
      const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[?#@0-9$])/.exec(rest);
      if (m) {
        out += paint("variable", m[0]);
        i += m[0].length;
        continue;
      }
    }
    const prev = i > 0 ? line[i - 1] : " ";
    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(prev)) {
      const m = /^(0x[0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?)/.exec(rest);
      if (m) {
        out += paint("number", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest) as RegExpExecArray;
      const word = m[0];
      const after = line.slice(i + word.length);
      let kind: TokenKind = "plain";
      if (keywords.has(word)) kind = "keyword";
      else if (constants.has(word)) kind = "constant";
      else if (types.has(word)) kind = "type";
      else if (/^\s*\(/.test(after)) kind = "function";
      else if (lang.capitalizedTypes && /^[A-Z][a-z0-9]/.test(word)) kind = "type";
      out += paint(kind, word);
      i += word.length;
      continue;
    }
    if ("=<>!+-*/%&|^~?:".includes(ch)) {
      out += paint("keyword", ch);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function highlightJson(line: string): string {
  return line.replace(
    /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str: string | undefined, colon: string | undefined, constant: string | undefined, num: string | undefined) => {
      if (str !== undefined) return colon ? paint("key", str) + colon : paint("string", str);
      if (constant !== undefined) return paint("constant", constant);
      if (num !== undefined) return paint("number", num);
      return match;
    },
  );
}

function highlightYamlValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const commentIdx = value.search(/\s#/);
  if (commentIdx !== -1) return highlightYamlValue(value.slice(0, commentIdx)) + paint("comment", value.slice(commentIdx));
  if (/^["']/.test(trimmed)) return paint("string", value);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(trimmed)) return paint("constant", value);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return paint("number", value);
  if (/^[|>][-+]?$/.test(trimmed)) return paint("keyword", value);
  if (/^[&*][\w-]+/.test(trimmed)) return paint("variable", value);
  return paint("string", value);
}

function highlightYaml(line: string): string {
  if (/^\s*#/.test(line)) return paint("comment", line);
  if (/^(---|\.\.\.)\s*$/.test(line)) return paint("meta", line);
  const m = /^(\s*)(- )?([^\s:#][^:#]*?|"[^"]*"|'[^']*')(:)(\s|$)(.*)$/.exec(line);
  if (m) {
    return m[1] + (m[2] ? paint("keyword", m[2]) : "") + paint("keyword", m[3]) + m[4] + m[5] + highlightYamlValue(m[6]);
  }
  const item = /^(\s*)(- )(.*)$/.exec(line);
  if (item) return item[1] + paint("keyword", item[2]) + highlightYamlValue(item[3]);
  return line;
}

function highlightMarkdownInline(text: string): string {
  return text
    .replace(/`[^`]+`/g, (m) => paint("string", m))
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (m) => ansi.bold(m))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `[${paint("type", label)}](${ansi.underline(paint("comment", url))})`);
}

function highlightMarkdown(line: string, state: HighlightState): string {
  if (/^\s*(```|~~~)/.test(line)) {
    state.inFence = !state.inFence;
    return paint("comment", line);
  }
  if (state.inFence) return paint("string", line);
  if (/^#{1,6}\s/.test(line)) return paint("heading", line);
  if (/^\s*>/.test(line)) return paint("comment", line);
  const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line);
  if (list) return list[1] + paint("keyword", list[2]) + list[3] + highlightMarkdownInline(list[4]);
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return paint("meta", line);
  return highlightMarkdownInline(line);
}

function highlightDiff(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return ansi.bold(line);
  if (line.startsWith("+")) return paint("added", line);
  if (line.startsWith("-")) return paint("removed", line);
  if (line.startsWith("@@")) return paint("type", line);
  if (/^(diff|index) /.test(line)) return paint("meta", line);
  return line;
}

function highlightIni(line: string): string {
  if (/^\s*[#;]/.test(line)) return paint("comment", line);
  if (/^\s*\[.*\]\s*$/.test(line)) return paint("type", line);
  const m = /^(\s*)([\w.-]+)(\s*[=:]\s*)(.*)$/.exec(line);
  if (m) {
    const value = m[4];
    let painted: string;
    if (/^["']/.test(value)) painted = paint("string", value);
    else if (/^-?\d+(\.\d+)?$/.test(value)) painted = paint("number", value);
    else if (/^(true|false)$/i.test(value)) painted = paint("constant", value);
    else painted = value;
    return m[1] + paint("keyword", m[2]) + m[3] + painted;
  }
  return line;
}

function highlightDockerfile(line: string, lang: LanguageSpec, state: HighlightState): string {
  const m = /^(\s*)([A-Za-z]+)(\s.*)?$/.exec(line);
  const instructions = /^(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)$/i;
  if (m && instructions.test(m[2])) {
    return m[1] + paint("keyword", m[2]) + highlightGeneric(m[3] ?? "", lang, state);
  }
  return highlightGeneric(line, lang, state);
}

/** Highlight source code and return one ANSI-colored string per line. */
export function highlight(code: string, lang: LanguageSpec): string[] {
  const lines = code.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const state: HighlightState = { inBlockComment: false, inFence: false };
  return lines.map((raw) => {
    const line = stripAnsi(raw);
    switch (lang.custom) {
      case "json":
        return highlightJson(line);
      case "yaml":
        return highlightYaml(line);
      case "markdown":
        return highlightMarkdown(line, state);
      case "diff":
        return highlightDiff(line);
      case "ini":
        return highlightIni(line);
      case "dockerfile":
        return highlightDockerfile(line, lang, state);
      default:
        return lang === PLAIN ? line : highlightGeneric(line, lang, state);
    }
  });
}
