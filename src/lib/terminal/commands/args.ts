import { CommandError } from "../command";

export interface OptionDef {
  key: string;
  short?: string;
  long?: string | string[];
  /** Option takes a value (`-n 5`, `-n5`, `--lines=5`, `--lines 5`). */
  value?: boolean;
}

export class ParsedOptions {
  private readonly values = new Map<string, string[]>();
  private readonly counts = new Map<string, number>();

  constructor(readonly positionals: string[]) {}

  add(key: string, value?: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (value !== undefined) this.values.set(key, [...(this.values.get(key) ?? []), value]);
  }

  has(key: string): boolean {
    return this.counts.has(key);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get(key: string): string | undefined {
    const all = this.values.get(key);
    return all ? all[all.length - 1] : undefined;
  }

  all(key: string): string[] {
    return this.values.get(key) ?? [];
  }
}

export interface ParseConfig {
  /** Key receiving numeric shorthand like `head -5`. */
  numericKey?: string;
  /** Stop option parsing at the first positional (like POSIX getopt; used by xargs). */
  stopAtPositional?: boolean;
}

/** GNU-style option parsing with combined short flags and `--` terminator. */
export function parseOptions(command: string, args: string[], defs: OptionDef[], config: ParseConfig = {}): ParsedOptions {
  const positionals: string[] = [];
  const pending: [string, string | undefined][] = [];
  const byShort = new Map<string, OptionDef>();
  const byLong = new Map<string, OptionDef>();
  for (const def of defs) {
    if (def.short) byShort.set(def.short, def);
    for (const long of Array.isArray(def.long) ? def.long : def.long ? [def.long] : []) byLong.set(long, def);
  }

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const def = byLong.get(name) ?? [...byLong.entries()].find(([long]) => long.startsWith(name) && [...byLong.keys()].filter((l) => l.startsWith(name)).length === 1)?.[1];
      if (!def) throw new CommandError(`unrecognized option '--${name}'\nTry '${command} --help' for more information.`, 2);
      if (def.value) {
        let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
        if (value === undefined) {
          i++;
          if (i >= args.length) throw new CommandError(`option '--${name}' requires an argument\nTry '${command} --help' for more information.`, 2);
          value = args[i];
        }
        pending.push([def.key, value]);
      } else {
        if (eq !== -1) throw new CommandError(`option '--${name}' doesn't allow an argument`, 2);
        pending.push([def.key, undefined]);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (config.numericKey && /^-\d+$/.test(arg)) {
        pending.push([config.numericKey, arg.slice(1)]);
        continue;
      }
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        const def = byShort.get(ch);
        if (!def) throw new CommandError(`invalid option -- '${ch}'\nTry '${command} --help' for more information.`, 2);
        if (def.value) {
          let value = arg.slice(j + 1);
          if (value === "") {
            i++;
            if (i >= args.length) throw new CommandError(`option requires an argument -- '${ch}'\nTry '${command} --help' for more information.`, 2);
            value = args[i];
          }
          pending.push([def.key, value]);
          break;
        }
        pending.push([def.key, undefined]);
      }
      continue;
    }
    positionals.push(arg);
    if (config.stopAtPositional) {
      i++;
      break;
    }
  }
  positionals.push(...args.slice(i));
  const parsed = new ParsedOptions(positionals);
  for (const [key, value] of pending) parsed.add(key, value);
  return parsed;
}

export function parseCount(command: string, value: string | undefined, fallback: number, what = "number of lines"): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CommandError(`invalid ${what}: '${value}'`);
  return n;
}

/** GNU coreutils style quoting used in error messages: ‘name’ / 'name'. */
export function q(name: string): string {
  return `'${name}'`;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
