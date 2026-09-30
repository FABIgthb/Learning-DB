import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Lesson environment (stored in Lesson.environment, authored in YAML) */
/* ------------------------------------------------------------------ */

/**
 * `files` is a flat map of absolute (or ~-relative) paths to file contents.
 * A key ending in "/" declares an (empty) directory; its value is ignored.
 * Parent directories are created automatically.
 *
 * ```yaml
 * environment:
 *   cwd: ~/project
 *   files:
 *     ~/project/src/app.ts: |
 *       export const answer = 42;
 *     ~/project/logs/: ""
 * ```
 */
export const environmentSpecSchema = z.object({
  user: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
    .default("learner"),
  hostname: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,63}$/)
    .default("learn"),
  home: z.string().startsWith("/").optional(),
  cwd: z.string().optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  files: z.record(z.string().min(1), z.string().nullable()).default({}),
  executables: z.array(z.string()).default([]),
});

export type EnvironmentSpecInput = z.input<typeof environmentSpecSchema>;
export type EnvironmentSpec = z.output<typeof environmentSpecSchema>;

/* ------------------------------------------------------------------ */
/* Validations (mirror of the Prisma ValidationType enum)              */
/* ------------------------------------------------------------------ */

export const VALIDATION_TYPES = [
  "EXACT",
  "NORMALIZED",
  "INPUT_REGEX",
  "OUTPUT_CONTAINS",
  "OUTPUT_EQUALS",
  "OUTPUT_REGEX",
  "CWD_EQUALS",
  "PATH_EXISTS",
  "FILE_CONTAINS",
  "COMMAND_USED",
] as const;

export type ValidationType = (typeof VALIDATION_TYPES)[number];

export interface ValidationRule {
  id?: string;
  type: ValidationType;
  expected: string;
  target?: string | null;
  flags?: string | null;
  alternatives?: string[];
  requireSuccess?: boolean;
  failureMessage?: string | null;
}

export interface StepDefinition {
  id: string;
  key: string;
  order: number;
  title: string;
  instruction: string;
  hint?: string | null;
  solution: string;
  successMessage?: string | null;
  validations: ValidationRule[];
}

export interface ValidationOutcome {
  passed: boolean;
  failures: string[];
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecutionResult {
  input: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwdBefore: string;
  cwdAfter: string;
  /** Selections made in interactive programs (fzf) during this command, in order. */
  interactions: string[][];
}

/** A command as recorded for deterministic server-side replay. */
export const historyEntrySchema = z.object({
  input: z.string().max(2000),
  interactions: z.array(z.array(z.string().max(4096)).max(1000)).max(20).default([]),
  /** Terminal width when the command ran (affects `ls`/`bat` layout). */
  columns: z.number().int().min(20).max(400).default(80),
});
export const MAX_HISTORY_ENTRIES = 300;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export interface FzfRequest {
  items: string[];
  query: string;
  prompt: string;
  multi: boolean;
  exact: boolean;
  caseMode: "smart" | "ignore" | "respect";
  noSort: boolean;
  header: string | null;
  preview: ((item: string) => Promise<string>) | null;
}

/**
 * Bridges the shell to interactive UIs. Returns the selected lines,
 * or null when the user aborts (Esc / Ctrl-C), like fzf exit code 130.
 */
export interface InteractiveHandlers {
  fzf(request: FzfRequest): Promise<string[] | null>;
}

export interface OutputSink {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}
