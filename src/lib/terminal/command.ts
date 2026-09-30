import type { Shell } from "./shell";

export interface CommandContext {
  /** Name the command was invoked as (argv[0]). */
  name: string;
  args: string[];
  /** Piped/redirected input, or null when stdin is the terminal. */
  stdin: string | null;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  stdoutIsTTY: boolean;
  shell: Shell;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number> | number;

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  /** Shell builtins report errors as "bash: name: ..." */
  builtin?: boolean;
  /** Commands that treat --help as a normal argument (echo, printf). */
  literalHelp?: boolean;
  run: CommandHandler;
}

/** Thrown by commands for fatal usage errors; converted to "name: message" + exit code. */
export class CommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
