/**
 * LessonSession couples a Shell with a lesson's ordered steps.
 * The browser drives it interactively; the server uses `replayLesson` to
 * re-run the recorded history from a fresh environment and decide — without
 * trusting the client — which steps were genuinely completed.
 */

import { Shell } from "./shell";
import { validateStep } from "./validation";
import type { EnvironmentSpecInput, ExecutionResult, HistoryEntry, InteractiveHandlers, OutputSink, StepDefinition, ValidationOutcome } from "./types";

export interface StepEvaluation {
  stepId: string;
  outcome: ValidationOutcome;
}

export interface SessionRunResult {
  result: ExecutionResult;
  evaluation: StepEvaluation | null;
  entry: HistoryEntry;
}

export class LessonSession {
  readonly shell: Shell;
  readonly steps: StepDefinition[];
  readonly completed: Set<string>;
  readonly history: HistoryEntry[] = [];
  /** Which input completed each step during this session. */
  readonly completedBy = new Map<string, string>();

  constructor(options: {
    environment: EnvironmentSpecInput | unknown;
    steps: StepDefinition[];
    completedStepIds?: Iterable<string>;
    interactive?: InteractiveHandlers | null;
  }) {
    this.shell = Shell.fromSpec(options.environment, { interactive: options.interactive ?? null });
    this.steps = [...options.steps].sort((a, b) => a.order - b.order);
    this.completed = new Set(options.completedStepIds ?? []);
  }

  get currentStep(): StepDefinition | null {
    return this.steps.find((step) => !this.completed.has(step.id)) ?? null;
  }

  get isComplete(): boolean {
    return this.steps.length > 0 && this.steps.every((step) => this.completed.has(step.id));
  }

  /** Execute a command, record it for replay, and validate it against the current step. */
  async run(input: string, options: { sink?: OutputSink; replay?: string[][]; columns?: number } = {}): Promise<SessionRunResult> {
    if (options.columns) this.shell.columns = options.columns;
    const step = this.currentStep;
    const result = await this.shell.execute(input, options.sink, options.replay);
    const entry: HistoryEntry = { input, interactions: result.interactions, columns: this.shell.columns };
    if (input.trim() !== "") this.history.push(entry);

    let evaluation: StepEvaluation | null = null;
    if (step && input.trim() !== "") {
      const outcome = validateStep(step, result, this.shell);
      evaluation = { stepId: step.id, outcome };
      if (outcome.passed) {
        this.completed.add(step.id);
        this.completedBy.set(step.id, input);
      }
    }
    return { result, evaluation, entry };
  }
}

export interface ReplayResult {
  completedStepIds: string[];
  /** Steps newly completed by this history (not in `alreadyCompleted`). */
  newlyCompleted: { stepId: string; command: string }[];
  /** Evaluation of the final history entry (for attempt logging). */
  last: { input: string; stepId: string | null; passed: boolean; exitCode: number } | null;
  lessonComplete: boolean;
}

/** Deterministically replay `history` from the lesson's initial environment. */
export async function replayLesson(options: {
  environment: EnvironmentSpecInput | unknown;
  steps: StepDefinition[];
  history: HistoryEntry[];
  alreadyCompleted?: Iterable<string>;
}): Promise<ReplayResult> {
  const initial = new Set(options.alreadyCompleted ?? []);
  const session = new LessonSession({
    environment: options.environment,
    steps: options.steps,
    completedStepIds: initial,
    interactive: null,
  });
  let last: ReplayResult["last"] = null;
  for (const entry of options.history) {
    const { result, evaluation } = await session.run(entry.input, { replay: entry.interactions, columns: entry.columns });
    last = {
      input: entry.input,
      stepId: evaluation?.stepId ?? null,
      passed: evaluation?.outcome.passed ?? false,
      exitCode: result.exitCode,
    };
  }
  const newlyCompleted = [...session.completedBy.entries()].filter(([id]) => !initial.has(id)).map(([stepId, command]) => ({ stepId, command }));
  return {
    completedStepIds: [...session.completed],
    newlyCompleted,
    last,
    lessonComplete: session.isComplete,
  };
}
