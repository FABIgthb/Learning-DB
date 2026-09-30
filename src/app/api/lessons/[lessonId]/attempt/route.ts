/**
 * Progress sync for the terminal simulator.
 *
 * POST   — the browser sends the full command history since the last terminal
 *          reset. The server replays it from the lesson's initial environment
 *          (never trusting client-side validation), records newly completed
 *          steps, stores the history (to restore state on reload) and logs the
 *          latest attempt.
 * DELETE — reset the terminal (`?scope=terminal`, default) or restart the
 *          lesson and clear its step completions (`?scope=lesson`).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { attachLearnerCookie, getOrCreateLearner } from "@/lib/learner";
import { lessonWithStepsInclude, toStepDefinitions } from "@/lib/lessons";
import { prisma } from "@/lib/prisma";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { replayLesson } from "@/lib/terminal/session";
import { MAX_HISTORY_ENTRIES, historyEntrySchema } from "@/lib/terminal/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  history: z.array(historyEntrySchema).max(MAX_HISTORY_ENTRIES),
});

const REPLAY_TIMEOUT_MS = 5_000;

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function json(body: unknown, init: { status?: number; learner?: { id: string; created: boolean } } = {}) {
  const response = NextResponse.json(body, { status: init.status ?? 200, headers: { "Cache-Control": "no-store" } });
  if (init.learner?.created) attachLearnerCookie(response, init.learner.id);
  return response;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("replay timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ lessonId: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return json({ error: "Expected application/json." }, { status: 415 });
  }
  if (!rateLimit(`attempt:${clientIp(request.headers)}`, { capacity: 30, refillPerSecond: 5 })) {
    return json({ error: "Too many requests — slow down a little." }, { status: 429 });
  }

  const { lessonId } = await context.params;
  let payload: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid payload.", details: parsed.error.flatten() }, { status: 400 });
    }
    payload = parsed.data;
  } catch {
    return json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const lesson = await prisma.lesson.findFirst({
    where: { id: lessonId, status: "PUBLISHED" },
    include: lessonWithStepsInclude,
  });
  if (!lesson) return json({ error: "Lesson not found." }, { status: 404 });

  const learner = await getOrCreateLearner();
  const steps = toStepDefinitions(lesson);
  const stepIds = steps.map((s) => s.id);

  const [progress, existingCompletions] = await Promise.all([
    prisma.lessonProgress.findUnique({ where: { learnerId_lessonId: { learnerId: learner.id, lessonId } } }),
    prisma.stepCompletion.findMany({ where: { learnerId: learner.id, stepId: { in: stepIds } }, select: { stepId: true } }),
  ]);
  const alreadyCompleted = new Set(existingCompletions.map((c) => c.stepId));
  const baseline = progress ? progress.baselineStepIds.filter((id) => stepIds.includes(id)) : [...alreadyCompleted];

  let replay;
  try {
    replay = await withTimeout(
      replayLesson({ environment: lesson.environment, steps, history: payload.history, alreadyCompleted: baseline }),
      REPLAY_TIMEOUT_MS,
    );
  } catch (error) {
    console.error(`[attempt] replay failed for lesson ${lessonId}:`, error);
    return json({ error: "Could not verify your session. Reset the terminal and try again." }, { status: 422, learner });
  }

  const union = new Set([...alreadyCompleted, ...replay.completedStepIds]);
  const lessonComplete = steps.length > 0 && steps.every((s) => union.has(s.id));
  const newCompletions = replay.newlyCompleted.filter((c) => !alreadyCompleted.has(c.stepId));
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (newCompletions.length > 0) {
      await tx.stepCompletion.createMany({
        data: newCompletions.map((c) => ({ learnerId: learner.id, stepId: c.stepId, command: c.command.slice(0, 2000) })),
        skipDuplicates: true,
      });
    }
    await tx.lessonProgress.upsert({
      where: { learnerId_lessonId: { learnerId: learner.id, lessonId } },
      create: {
        learnerId: learner.id,
        lessonId,
        status: lessonComplete ? "COMPLETED" : "IN_PROGRESS",
        completedAt: lessonComplete ? now : null,
        history: payload.history,
        baselineStepIds: baseline,
      },
      update: {
        status: lessonComplete ? "COMPLETED" : "IN_PROGRESS",
        completedAt: lessonComplete ? (progress?.completedAt ?? now) : null,
        history: payload.history,
      },
    });
    if (replay.last?.stepId) {
      await tx.commandAttempt.create({
        data: {
          learnerId: learner.id,
          stepId: replay.last.stepId,
          input: replay.last.input.slice(0, 2000),
          passed: replay.last.passed,
          exitCode: replay.last.exitCode,
        },
      });
    }
  });

  return json(
    {
      completedStepIds: steps.filter((s) => union.has(s.id)).map((s) => s.id),
      newlyCompletedStepIds: newCompletions.map((c) => c.stepId),
      lessonComplete,
    },
    { learner },
  );
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ lessonId: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  if (!rateLimit(`reset:${clientIp(request.headers)}`, { capacity: 10, refillPerSecond: 1 })) {
    return json({ error: "Too many requests." }, { status: 429 });
  }
  const { lessonId } = await context.params;
  const scope = request.nextUrl.searchParams.get("scope") === "lesson" ? "lesson" : "terminal";

  const lesson = await prisma.lesson.findFirst({ where: { id: lessonId }, select: { id: true, steps: { select: { id: true } } } });
  if (!lesson) return json({ error: "Lesson not found." }, { status: 404 });

  const learner = await getOrCreateLearner();
  const stepIds = lesson.steps.map((s) => s.id);

  const baseline = await prisma.$transaction(async (tx) => {
    if (scope === "lesson") {
      await tx.stepCompletion.deleteMany({ where: { learnerId: learner.id, stepId: { in: stepIds } } });
    }
    const completions = await tx.stepCompletion.findMany({ where: { learnerId: learner.id, stepId: { in: stepIds } }, select: { stepId: true } });
    const ids = completions.map((c) => c.stepId);
    const complete = stepIds.length > 0 && stepIds.every((id) => ids.includes(id));
    await tx.lessonProgress.upsert({
      where: { learnerId_lessonId: { learnerId: learner.id, lessonId } },
      create: { learnerId: learner.id, lessonId, history: [], baselineStepIds: ids, status: complete ? "COMPLETED" : "IN_PROGRESS", completedAt: complete ? new Date() : null },
      update: { history: [], baselineStepIds: ids, status: complete ? "COMPLETED" : "IN_PROGRESS", ...(complete ? {} : { completedAt: null }) },
    });
    return ids;
  });

  return json({ completedStepIds: baseline, scope }, { learner });
}
