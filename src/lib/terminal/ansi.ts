/** ANSI SGR helpers shared by commands (producing escapes) and the terminal view (rendering them). */

const ESC = "\x1b[";

export const ansi = {
  reset: `${ESC}0m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  italic: (s: string) => `${ESC}3m${s}${ESC}23m`,
  underline: (s: string) => `${ESC}4m${s}${ESC}24m`,
  red: (s: string) => `${ESC}31m${s}${ESC}39m`,
  green: (s: string) => `${ESC}32m${s}${ESC}39m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}39m`,
  blue: (s: string) => `${ESC}34m${s}${ESC}39m`,
  magenta: (s: string) => `${ESC}35m${s}${ESC}39m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}39m`,
  gray: (s: string) => `${ESC}90m${s}${ESC}39m`,
  brightBlue: (s: string) => `${ESC}94m${s}${ESC}39m`,
  rgb: (r: number, g: number, b: number, s: string) => `${ESC}38;2;${r};${g};${b}m${s}${ESC}39m`,
  sgr: (codes: string, s: string) => `${ESC}${codes}m${s}${ESC}0m`,
};

export const CLEAR_SCREEN = "\x1b[H\x1b[2J";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface AnsiStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

export const DEFAULT_STYLE: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
};

/** Terminal palette (One Dark–ish), indexed by ANSI color number 0–15. */
export const PALETTE = [
  "#3f4451",
  "#e06c75",
  "#98c379",
  "#e5c07b",
  "#61afef",
  "#c678dd",
  "#56b6c2",
  "#d7dae0",
  "#6b7280",
  "#ff7b86",
  "#b5e890",
  "#f0d197",
  "#7cc4ff",
  "#dd98f0",
  "#6fd4e0",
  "#ffffff",
];

function xterm256(n: number): string {
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
}

function applyCodes(style: AnsiStyle, params: number[]): AnsiStyle {
  const next = { ...style };
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(next, DEFAULT_STYLE);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = PALETTE[code - 30];
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = PALETTE[code - 40];
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = PALETTE[code - 90 + 8];
    else if (code >= 100 && code <= 107) next.bg = PALETTE[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        next[target] = xterm256(codes[i + 2]);
        i += 2;
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        next[target] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  return next;
}

/**
 * Split one line of text into styled spans. `initial` carries style across
 * lines (SGR state persists over newlines in a real terminal).
 */
export function parseAnsiLine(line: string, initial: AnsiStyle = DEFAULT_STYLE): { spans: AnsiSpan[]; style: AnsiStyle } {
  const spans: AnsiSpan[] = [];
  let style = initial;
  let last = 0;
  const pattern = /\x1b\[([0-9;?]*)([A-Za-z])/g; // eslint-disable-line no-control-regex
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) spans.push({ text: line.slice(last, match.index), style });
    if (match[2] === "m") {
      const params = match[1] === "" ? [] : match[1].split(";").map((p) => Number.parseInt(p, 10) || 0);
      style = applyCodes(style, params);
    }
    last = pattern.lastIndex;
  }
  if (last < line.length) spans.push({ text: line.slice(last), style });
  return { spans, style };
}

/** Visible width of a string (ANSI stripped, tabs expanded to 4). */
export function visibleWidth(text: string): number {
  return stripAnsi(text).replace(/\t/g, "    ").length;
}
