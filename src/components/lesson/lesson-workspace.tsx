"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, CloudOff, Eye, Lightbulb, Loader2, Lock, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Terminal, type TerminalHandle } from "@/components/terminal/terminal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ansi } from "@/lib/terminal/ansi";
import { LessonSession } from "@/lib/terminal/session";
import { MAX_HISTORY_ENTRIES, type HistoryEntry, type OutputSink, type StepDefinition } from "@/lib/terminal/types";
import { cn } from "@/lib/utils";
import { InlineMarkdown } from "./inline-markdown";

export interface LessonWorkspaceProps {
  lessonId: string;
  lessonTitle: string;
  environment: unknown;
  steps: StepDefinition[];
  baselineStepIds: string[];
  initialHistory: HistoryEntry[];
  serverCompletedStepIds: string[];
  nextLesson: { href: string; title: string } | null;
}

type SyncState = "idle" | "saving" | "saved" | "error" | "limit";

interface Feedback {
  stepId: string;
  passed: boolean;
  failures: string[];
  input: string;
}

const BANNER = [
  ansi.bold(ansi.green("Welcome to the learn.fabi-pm.xyz shell simulator")),
  ansi.gray("Type `help` for commands, `<cmd> --help` for options. Tab completes, ↑/↓ browse history."),
  "",
].join("\n");

async function restoreSession(session: LessonSession, history: HistoryEntry[]): Promise<void> {
  for (const entry of history) {
    await session.run(entry.input, { replay: entry.interactions, columns: entry.columns });
  }
}

export function LessonWorkspace(props: LessonWorkspaceProps) {
  const { lessonId, environment, steps, nextLesson } = props;
  const terminalRef = useRef<TerminalHandle>(null);
  const [session, setSession] = useState(
    () => new LessonSession({ environment, steps, completedStepIds: props.baselineStepIds }),
  );
  const [ready, setReady] = useState(props.initialHistory.length === 0);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set([...props.baselineStepIds, ...props.serverCompletedStepIds]));
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [revealed, setRevealed] = useState<Record<string, "hint" | "solution" | undefined>>({});
  const [sync, setSync] = useState<SyncState>("idle");
  const syncChain = useRef<Promise<void>>(Promise.resolve());
  const pendingHistory = useRef<HistoryEntry[] | null>(null);

  const orderedSteps = useMemo(() => [...steps].sort((a, b) => a.order - b.order), [steps]);
  const currentStep = orderedSteps.find((s) => !completed.has(s.id)) ?? null;
  const doneCount = orderedSteps.filter((s) => completed.has(s.id)).length;
  const lessonComplete = orderedSteps.length > 0 && doneCount === orderedSteps.length;

  // Restore terminal state from the stored history (deterministic replay).
  // The ref guard keeps React StrictMode's double effect invocation from replaying twice.
  const restoreStarted = useRef(false);
  useEffect(() => {
    if (props.initialHistory.length === 0 || restoreStarted.current) return;
    restoreStarted.current = true;
    const count = props.initialHistory.length;
    void restoreSession(session, props.initialHistory).then(() => {
      setCompleted((prev) => new Set([...prev, ...session.completed]));
      setReady(true);
      terminalRef.current?.write(ansi.gray(`↻ Restored your previous session (${count} command${count === 1 ? "" : "s"}).`) + "\n");
    });
    // Runs once for the initial session only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Send the full history to the server; requests are serialized and coalesced. */
  const scheduleSync = useCallback(
    (history: HistoryEntry[]) => {
      if (history.length > MAX_HISTORY_ENTRIES) {
        setSync("limit");
        return;
      }
      pendingHistory.current = history;
      setSync("saving");
      syncChain.current = syncChain.current.then(async () => {
        const payload = pendingHistory.current;
        if (!payload) return;
        pendingHistory.current = null;
        try {
          const response = await fetch(`/api/lessons/${lessonId}/attempt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ history: payload }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as { completedStepIds: string[]; lessonComplete: boolean };
          setCompleted((prev) => new Set([...prev, ...data.completedStepIds]));
          if (!pendingHistory.current) setSync("saved");
        } catch {
          setSync("error");
        }
      });
    },
    [lessonId],
  );

  const onExecute = useCallback(
    async (input: string, sink: OutputSink, columns: number) => {
      const { evaluation } = await session.run(input, { sink, columns });
      if (input.trim() === "") return;
      if (evaluation) {
        const step = orderedSteps.find((s) => s.id === evaluation.stepId);
        setFeedback({ stepId: evaluation.stepId, passed: evaluation.outcome.passed, failures: evaluation.outcome.failures, input });
        if (evaluation.outcome.passed && step) {
          setCompleted((prev) => new Set([...prev, step.id]));
          const message = step.successMessage ? ` ${step.successMessage}` : "";
          sink.stdout(`${ansi.green(`✔ Step ${step.order}: ${step.title}`)}${ansi.gray(message)}\n`);
          if (session.isComplete) sink.stdout(ansi.bold(ansi.green("★ Lesson complete — nice work!")) + "\n");
        }
      }
      scheduleSync([...session.history]);
    },
    [session, orderedSteps, scheduleSync],
  );

  const reset = useCallback(
    async (scope: "terminal" | "lesson") => {
      if (scope === "lesson" && !window.confirm("Restart the lesson? This clears your completed steps for this lesson.")) return;
      let baseline = scope === "lesson" ? [] : [...completed];
      try {
        const response = await fetch(`/api/lessons/${lessonId}/attempt?scope=${scope}`, { method: "DELETE" });
        if (response.ok) {
          const data = (await response.json()) as { completedStepIds: string[] };
          baseline = data.completedStepIds;
          setSync("saved");
        } else setSync("error");
      } catch {
        setSync("error");
      }
      pendingHistory.current = null;
      const next = new LessonSession({ environment, steps, completedStepIds: baseline });
      setSession(next);
      setCompleted(new Set(baseline));
      setFeedback(null);
      setReady(true);
      requestAnimationFrame(() => terminalRef.current?.focus());
    },
    [completed, environment, lessonId, steps],
  );

  const toolbar = (
    <>
      <SyncIndicator state={sync} />
      <Button variant="ghost" size="icon" className="h-7 w-7 text-terminal-fg/70" title="Reset terminal (keeps completed steps)" onClick={() => void reset("terminal")}>
        <RotateCcw />
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <Terminal
        ref={terminalRef}
        shell={session.shell}
        onExecute={onExecute}
        banner={BANNER}
        disabled={!ready}
        toolbar={toolbar}
        title={props.lessonTitle}
        className="h-[60vh] min-h-[360px] lg:h-[calc(100vh-15rem)]"
      />

      <section aria-labelledby="steps-heading" className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="steps-heading" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Tasks
          </h2>
          <span className="text-xs text-muted-foreground">
            {doneCount}/{orderedSteps.length} complete
          </span>
        </div>
        <Progress value={orderedSteps.length ? (doneCount / orderedSteps.length) * 100 : 0} className="mb-4" />

        {lessonComplete ? (
          <div className="mb-4 flex flex-col gap-3 rounded-lg border border-success/40 bg-success/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-success">
              <Sparkles className="h-5 w-5" />
              <span className="font-medium">Lesson complete!</span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => void reset("lesson")}>
                <Trash2 /> Practice again
              </Button>
              {nextLesson ? (
                <Button asChild size="sm">
                  <Link href={nextLesson.href}>
                    Next: {nextLesson.title} <ChevronRight />
                  </Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <ol className="flex flex-col gap-2">
          {orderedSteps.map((step) => {
            const done = completed.has(step.id);
            const active = currentStep?.id === step.id;
            const locked = !done && !active;
            const reveal = revealed[step.id];
            const stepFeedback = feedback && feedback.stepId === step.id && !feedback.passed ? feedback : null;
            return (
              <li
                key={step.id}
                className={cn(
                  "rounded-lg border p-3 transition-colors",
                  active && "border-primary/50 bg-primary/5",
                  done && "border-success/30",
                  locked && "opacity-60",
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0">
                    {done ? <CheckCircle2 className="h-5 w-5 text-success" /> : active ? <Circle className="h-5 w-5 text-primary" /> : <Lock className="h-5 w-5 text-muted-foreground" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {step.order}. {step.title}
                      </span>
                      {done ? <Badge variant="success">done</Badge> : null}
                    </div>
                    {!locked ? (
                      <div className="mt-1 text-sm text-muted-foreground">
                        <InlineMarkdown text={step.instruction} />
                      </div>
                    ) : null}

                    {stepFeedback && stepFeedback.failures.length > 0 ? (
                      <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                        <div className="font-mono text-xs text-muted-foreground">$ {stepFeedback.input}</div>
                        <ul className="mt-1 list-disc pl-5 text-destructive-foreground/90">
                          {stepFeedback.failures.map((f, i) => (
                            <li key={i}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {active ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {step.hint ? (
                          <Button variant="outline" size="sm" onClick={() => setRevealed((r) => ({ ...r, [step.id]: reveal === "hint" ? undefined : "hint" }))}>
                            <Lightbulb /> {reveal === "hint" ? "Hide hint" : "Hint"}
                          </Button>
                        ) : null}
                        <Button variant="ghost" size="sm" onClick={() => setRevealed((r) => ({ ...r, [step.id]: reveal === "solution" ? undefined : "solution" }))}>
                          <Eye /> {reveal === "solution" ? "Hide solution" : "Show solution"}
                        </Button>
                      </div>
                    ) : null}
                    {active && reveal === "hint" && step.hint ? (
                      <div className="mt-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
                        <InlineMarkdown text={step.hint} />
                      </div>
                    ) : null}
                    {(active || done) && reveal === "solution" ? (
                      <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2">
                        <code className="flex-1 overflow-x-auto whitespace-pre font-mono text-sm">{step.solution}</code>
                        <Button size="sm" variant="secondary" onClick={() => terminalRef.current?.setInput(step.solution)}>
                          Paste
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void reset("lesson")}>
            <Trash2 /> Restart lesson
          </Button>
        </div>
      </section>
    </div>
  );
}

function SyncIndicator({ state }: { state: SyncState }) {
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-terminal-fg/60" title="Saving progress">
        <Loader2 className="h-3 w-3 animate-spin" /> saving
      </span>
    );
  }
  if (state === "saved") return <span className="text-[11px] text-terminal-fg/50">saved</span>;
  if (state === "error") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[#e5c07b]" title="Progress could not be saved — it will retry with your next command">
        <CloudOff className="h-3 w-3" /> offline
      </span>
    );
  }
  if (state === "limit") {
    return (
      <span className="text-[11px] text-[#e5c07b]" title={`History limit of ${MAX_HISTORY_ENTRIES} commands reached — reset the terminal to keep saving progress`}>
        limit reached
      </span>
    );
  }
  return null;
}
