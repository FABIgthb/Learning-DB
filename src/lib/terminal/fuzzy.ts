/**
 * fzf-compatible fuzzy matching (algorithm v1 + extended search syntax).
 *
 * Extended syntax (space-separated terms are ANDed, `|` ORs adjacent terms):
 *   sbtrkt   fuzzy match
 *   'wild    exact substring
 *   ^music   prefix
 *   .mp3$    suffix
 *   !fire    inverse exact match
 *   !^music  inverse prefix, !.mp3$ inverse suffix
 */

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = 8;
const BONUS_NON_WORD = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

export type CaseMode = "smart" | "ignore" | "respect";

export interface MatchResult {
  score: number;
  positions: number[];
}

export interface RankedItem {
  item: string;
  index: number;
  score: number;
  positions: number[];
}

type CharClass = "lower" | "upper" | "number" | "delimiter" | "white" | "other";

function charClass(ch: string | undefined): CharClass {
  if (ch === undefined) return "white";
  if (ch >= "a" && ch <= "z") return "lower";
  if (ch >= "A" && ch <= "Z") return "upper";
  if (ch >= "0" && ch <= "9") return "number";
  if (ch === " " || ch === "\t") return "white";
  if ("/,:;|_-.".includes(ch)) return "delimiter";
  return "other";
}

function bonusFor(prev: CharClass, current: CharClass): number {
  if (current === "lower" || current === "upper" || current === "number") {
    if (prev === "white") return BONUS_BOUNDARY + 2;
    if (prev === "delimiter") return BONUS_BOUNDARY + 1;
    if (prev === "other") return BONUS_BOUNDARY;
  }
  if (prev === "lower" && current === "upper") return BONUS_CAMEL;
  if (prev !== "number" && current === "number") return BONUS_CAMEL;
  if (current === "other" || current === "delimiter") return BONUS_NON_WORD;
  return 0;
}

/** fzf "v1" fuzzy match: greedy forward scan, then backward scan to tighten the window. */
export function fuzzyMatch(text: string, pattern: string, caseSensitive: boolean): MatchResult | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLowerCase();

  let pi = 0;
  let end = -1;
  for (let i = 0; i < hay.length; i++) {
    if (hay[i] === needle[pi]) {
      pi++;
      if (pi === needle.length) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  let start = end;
  pi = needle.length - 1;
  for (let i = end; i >= 0; i--) {
    if (hay[i] === needle[pi]) {
      pi--;
      if (pi < 0) {
        start = i;
        break;
      }
    }
  }

  const positions: number[] = [];
  let score = 0;
  let inGap = false;
  let consecutive = 0;
  let firstBonus = 0;
  pi = 0;
  for (let i = start; i <= end; i++) {
    if (pi < needle.length && hay[i] === needle[pi]) {
      const bonus = bonusFor(charClass(text[i - 1]), charClass(text[i]));
      score += SCORE_MATCH;
      if (consecutive === 0) {
        firstBonus = bonus;
      } else {
        if (bonus === BONUS_BOUNDARY || bonus === BONUS_BOUNDARY + 1 || bonus === BONUS_BOUNDARY + 2) firstBonus = bonus;
        const effective = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
        score += effective - bonus;
      }
      score += pi === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus;
      positions.push(i);
      consecutive++;
      inGap = false;
      pi++;
    } else {
      score += inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
  }
  return { score, positions };
}

type TermKind = "fuzzy" | "exact" | "prefix" | "suffix" | "equal";

interface Term {
  kind: TermKind;
  text: string;
  inverse: boolean;
  caseSensitive: boolean;
}

function parseTerm(raw: string, caseMode: CaseMode, forceExact: boolean): Term | null {
  let text = raw;
  let inverse = false;
  let kind: TermKind = forceExact ? "exact" : "fuzzy";
  if (text.startsWith("!")) {
    inverse = true;
    kind = "exact";
    text = text.slice(1);
  }
  if (text !== "$" && text.endsWith("$") && !text.endsWith("\\$")) {
    kind = "suffix";
    text = text.slice(0, -1);
  }
  if (text.startsWith("'")) {
    kind = forceExact && !inverse ? "fuzzy" : kind === "suffix" ? "suffix" : "exact";
    text = text.slice(1);
  } else if (text.startsWith("^")) {
    kind = kind === "suffix" ? "equal" : "prefix";
    text = text.slice(1);
  }
  text = text.replace(/\\\$/g, "$");
  if (text === "") return null;
  const caseSensitive = caseMode === "respect" || (caseMode === "smart" && /[A-Z]/.test(text));
  return { kind, text, inverse, caseSensitive };
}

/** Parse an extended-search query into OR-groups that are ANDed together. */
export function parseQuery(query: string, caseMode: CaseMode, exact: boolean): Term[][] {
  const tokens = query
    .replace(/\\ /g, "\u0000")
    .split(/ +/)
    .map((t) => t.replace(/\u0000/g, " "))
    .filter((t) => t.length > 0);
  const groups: Term[][] = [];
  let current: Term[] = [];
  let pendingOr = false;
  for (const token of tokens) {
    if (token === "|") {
      pendingOr = true;
      continue;
    }
    const term = parseTerm(token, caseMode, exact);
    if (!term) continue;
    if (pendingOr && current.length > 0) {
      current.push(term);
    } else {
      if (current.length > 0) groups.push(current);
      current = [term];
    }
    pendingOr = false;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function matchTerm(text: string, term: Term): MatchResult | null {
  const hay = term.caseSensitive ? text : text.toLowerCase();
  const needle = term.caseSensitive ? term.text : term.text.toLowerCase();
  const span = (start: number): MatchResult => ({
    score: SCORE_MATCH * needle.length + BONUS_BOUNDARY * (start === 0 ? 2 : 1),
    positions: Array.from({ length: needle.length }, (_, k) => start + k),
  });
  switch (term.kind) {
    case "fuzzy":
      return fuzzyMatch(text, term.text, term.caseSensitive);
    case "exact": {
      const idx = hay.indexOf(needle);
      return idx === -1 ? null : span(idx);
    }
    case "prefix":
      return hay.startsWith(needle) ? span(0) : null;
    case "suffix":
      return hay.endsWith(needle) ? span(hay.length - needle.length) : null;
    case "equal":
      return hay === needle ? span(0) : null;
  }
}

/** Match one line against a parsed query. Returns null if it is filtered out. */
export function matchQuery(text: string, groups: Term[][]): MatchResult | null {
  let score = 0;
  const positions = new Set<number>();
  for (const group of groups) {
    let groupMatched = false;
    for (const term of group) {
      const result = matchTerm(text, term);
      if (term.inverse) {
        if (result === null) {
          groupMatched = true;
          break;
        }
        continue;
      }
      if (result) {
        groupMatched = true;
        score += result.score;
        result.positions.forEach((p) => positions.add(p));
        break;
      }
    }
    if (!groupMatched) return null;
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

export interface FilterOptions {
  caseMode?: CaseMode;
  exact?: boolean;
  noSort?: boolean;
  limit?: number;
}

/** Filter and rank items like `fzf --filter`. */
export function fuzzyFilter(items: string[], query: string, options: FilterOptions = {}): RankedItem[] {
  const groups = parseQuery(query, options.caseMode ?? "smart", options.exact ?? false);
  const ranked: RankedItem[] = [];
  items.forEach((item, index) => {
    const result = groups.length === 0 ? { score: 0, positions: [] } : matchQuery(item, groups);
    if (result) ranked.push({ item, index, score: result.score, positions: result.positions });
  });
  if (!options.noSort && groups.length > 0) {
    ranked.sort((a, b) => b.score - a.score || a.item.length - b.item.length || a.index - b.index);
  }
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}
