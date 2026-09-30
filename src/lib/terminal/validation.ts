/**
 * Step validation — shared by the browser (instant feedback) and the server
 * (authoritative check after replaying the learner's history).
 */

import { stripAnsi } from "./ansi";
import { resolvePath } from "./filesystem";
import { ParseError, parse, wordToLiteral, type CommandList } from "./parser";
import type { Shell } from "./shell";
import type { ExecutionResult, StepDefinition, ValidationOutcome, ValidationRule } from "./types";

/** Expand `-la` into `-a -l` so flag grouping/order does not matter. */
function normalizeFlags(tokens: string[]): { flags: string[]; positionals: string[] } {
  const flags: string[] = [];
  const positionals: string[] = [];
  let endOfOptions = false;
  for (const token of tokens) {
    if (endOfOptions || token === "-" || !token.startsWith("-") || /^-\d+(\.\d+)?$/.test(token)) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith("--")) flags.push(token);
    else if (/^-[A-Za-z]+$/.test(token)) for (const ch of token.slice(1)) flags.push(`-${ch}`);
    else flags.push(token);
  }
  return { flags: [...new Set(flags)].sort(), positionals };
}

function canonicalize(list: CommandList): string {
  return list.items
    .map((item) => {
      const pipeline = item.pipeline.commands
        .map((command) => {
          const words = command.words.map(wordToLiteral);
          const [name, ...rest] = words;
          const { flags, positionals } = normalizeFlags(rest);
          const assignments = command.assignments.map((a) => `${a.name}=${wordToLiteral(a.value)}`);
          const redirects = command.redirects.map((r) => `${r.fd}${r.op}${r.target ? wordToLiteral(r.target).replace(/\/+$/, "") : r.toFd}`);
          return [...assignments, name ?? "", ...flags, ...positionals.map((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p)), ...redirects].join("\u0001");
        })
        .join(" | ");
      return pipeline + (item.next && item.next !== ";" ? ` ${item.next} ` : item.next === ";" ? " ; " : "");
    })
    .join("")
    .trim();
}

/** Canonical form of a command line used by NORMALIZED checks; null if it does not parse. */
export function normalizeCommand(input: string): string | null {
  try {
    return canonicalize(parse(input));
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}

/** Names of every program invoked in a command line (aliases resolved one level). */
export function commandsUsed(input: string, aliases: Map<string, string> = new Map()): string[] {
  let list: CommandList;
  try {
    list = parse(input);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const item of list.items) {
    for (const command of item.pipeline.commands) {
      const first = command.words[0];
      if (!first) continue;
      const name = wordToLiteral(first);
      const alias = aliases.get(name);
      if (alias !== undefined) names.push(...commandsUsed(alias));
      else names.push(name);
      if (name === "xargs" || name === "sudo" || name === "env" || name === "time") {
        const inner = command.words.slice(1).map(wordToLiteral).find((w) => !w.startsWith("-") && !w.includes("="));
        if (inner) names.push(inner);
      }
      for (const word of command.words) {
        for (const part of word.parts) if (part.kind === "subst") names.push(...commandsUsed(part.source, aliases));
      }
    }
  }
  return names;
}

function normalizeOutput(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function safeRegExp(pattern: string, flags: string | null | undefined): RegExp | null {
  try {
    return new RegExp(pattern, (flags ?? "").replace(/[^gimsuy]/g, ""));
  } catch {
    return null;
  }
}

function checkOne(rule: ValidationRule, expected: string, result: ExecutionResult, shell: Shell): boolean {
  const input = result.input.trim();
  const stdout = normalizeOutput(result.stdout);
  switch (rule.type) {
    case "EXACT":
      return input === expected.trim();
    case "NORMALIZED": {
      const a = normalizeCommand(input);
      const b = normalizeCommand(expected);
      return a !== null && b !== null && a === b;
    }
    case "INPUT_REGEX": {
      const re = safeRegExp(expected, rule.flags);
      return re !== null && re.test(input);
    }
    case "OUTPUT_CONTAINS":
      return stdout.includes(expected) || collapseWhitespace(stdout).includes(collapseWhitespace(expected));
    case "OUTPUT_EQUALS":
      return stdout.replace(/\s+$/, "") === expected.replace(/\r\n/g, "\n").replace(/\s+$/, "") || collapseWhitespace(stdout) === collapseWhitespace(expected);
    case "OUTPUT_REGEX": {
      const re = safeRegExp(expected, rule.flags ?? "m");
      return re !== null && re.test(stdout);
    }
    case "CWD_EQUALS":
      return resolvePath(expected, shell.home, shell.home) === result.cwdAfter;
    case "PATH_EXISTS": {
      const abs = resolvePath(expected, shell.home, shell.home);
      if (rule.flags === "dir") return shell.fs.isDirectory(abs);
      if (rule.flags === "file") return shell.fs.isFile(abs);
      return shell.fs.exists(abs);
    }
    case "FILE_CONTAINS": {
      if (!rule.target) return false;
      const abs = resolvePath(rule.target, shell.home, shell.home);
      if (!shell.fs.isFile(abs)) return false;
      const content = shell.fs.readFile(abs);
      return content.includes(expected) || collapseWhitespace(content).includes(collapseWhitespace(expected));
    }
    case "COMMAND_USED":
      return commandsUsed(input, shell.aliases).includes(expected);
  }
}

function defaultFailure(rule: ValidationRule): string {
  switch (rule.type) {
    case "EXACT":
    case "NORMALIZED":
    case "INPUT_REGEX":
      return "That command isn't quite what this step asks for.";
    case "OUTPUT_CONTAINS":
    case "OUTPUT_EQUALS":
    case "OUTPUT_REGEX":
      return "The output doesn't match what this step expects yet.";
    case "CWD_EQUALS":
      return `You should end up in ${rule.expected}.`;
    case "PATH_EXISTS":
      return `${rule.expected} doesn't exist yet.`;
    case "FILE_CONTAINS":
      return `${rule.target} doesn't contain the expected content yet.`;
    case "COMMAND_USED":
      return `Use \`${rule.expected}\` for this step.`;
  }
}

export function evaluateRule(rule: ValidationRule, result: ExecutionResult, shell: Shell): { passed: boolean; message: string | null } {
  if ((rule.requireSuccess ?? true) && result.exitCode !== 0) {
    return { passed: false, message: rule.failureMessage ?? `The command exited with status ${result.exitCode}.` };
  }
  const candidates = [rule.expected, ...(rule.alternatives ?? [])];
  const passed = candidates.some((candidate) => checkOne(rule, candidate, result, shell));
  return { passed, message: passed ? null : rule.failureMessage ?? defaultFailure(rule) };
}

/** A step passes when every validation passes. Commands that are empty never pass. */
export function validateStep(step: StepDefinition, result: ExecutionResult, shell: Shell): ValidationOutcome {
  if (result.input.trim() === "") return { passed: false, failures: [] };
  if (step.validations.length === 0) return { passed: false, failures: ["This step has no validations configured."] };
  const failures: string[] = [];
  for (const rule of step.validations) {
    const outcome = evaluateRule(rule, result, shell);
    if (!outcome.passed && outcome.message) failures.push(outcome.message);
  }
  return { passed: failures.length === 0, failures };
}
