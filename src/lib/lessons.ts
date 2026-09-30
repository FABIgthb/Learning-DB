import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { historyEntrySchema, type HistoryEntry, type StepDefinition, type ValidationType } from "@/lib/terminal/types";

export const lessonWithStepsInclude = {
  steps: {
    orderBy: { order: "asc" },
    include: { validations: { orderBy: { order: "asc" } } },
  },
} satisfies Prisma.LessonInclude;

export type LessonWithSteps = Prisma.LessonGetPayload<{ include: typeof lessonWithStepsInclude }>;

/** Map Prisma rows to the engine's StepDefinition shape (safe to send to the browser). */
export function toStepDefinitions(lesson: LessonWithSteps): StepDefinition[] {
  return lesson.steps.map((step) => ({
    id: step.id,
    key: step.key,
    order: step.order,
    title: step.title,
    instruction: step.instruction,
    hint: step.hint,
    solution: step.solution,
    successMessage: step.successMessage,
    validations: step.validations.map((v) => ({
      id: v.id,
      type: v.type as ValidationType,
      expected: v.expected,
      target: v.target,
      flags: v.flags,
      alternatives: v.alternatives,
      requireSuccess: v.requireSuccess,
      failureMessage: v.failureMessage,
    })),
  }));
}

/** Parse stored history defensively (content may have been written by older versions). */
export function parseStoredHistory(value: Prisma.JsonValue | null | undefined): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryEntry[] = [];
  for (const item of value) {
    const parsed = historyEntrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function getPublishedTracks() {
  return prisma.track.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ order: "asc" }, { title: "asc" }],
    include: {
      modules: {
        where: { status: "PUBLISHED" },
        orderBy: { order: "asc" },
        include: {
          lessons: {
            where: { status: "PUBLISHED" },
            orderBy: { order: "asc" },
            select: { id: true, slug: true, title: true, summary: true, estimatedMinutes: true, difficulty: true, tags: true },
          },
        },
      },
    },
  });
}

export async function getTrackBySlug(slug: string) {
  return prisma.track.findFirst({
    where: { slug, status: "PUBLISHED" },
    include: {
      modules: {
        where: { status: "PUBLISHED" },
        orderBy: { order: "asc" },
        include: {
          lessons: {
            where: { status: "PUBLISHED" },
            orderBy: { order: "asc" },
            select: { id: true, slug: true, title: true, summary: true, estimatedMinutes: true, difficulty: true, tags: true },
          },
        },
      },
    },
  });
}

export async function getLessonBySlugs(trackSlug: string, moduleSlug: string, lessonSlug: string) {
  return prisma.lesson.findFirst({
    where: {
      slug: lessonSlug,
      status: "PUBLISHED",
      module: { slug: moduleSlug, status: "PUBLISHED", track: { slug: trackSlug, status: "PUBLISHED" } },
    },
    include: {
      ...lessonWithStepsInclude,
      module: { include: { track: true } },
    },
  });
}

/** Lessons of a track in reading order, for prev/next navigation. */
export async function getTrackLessonSequence(trackId: string) {
  const modules = await prisma.module.findMany({
    where: { trackId, status: "PUBLISHED" },
    orderBy: { order: "asc" },
    select: {
      slug: true,
      title: true,
      lessons: { where: { status: "PUBLISHED" }, orderBy: { order: "asc" }, select: { id: true, slug: true, title: true } },
    },
  });
  return modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleSlug: m.slug, moduleTitle: m.title })));
}

/** Map lessonId → { completedSteps, totalSteps, status } for a learner. */
export async function getLearnerLessonStats(learnerId: string | null, lessonIds: string[]) {
  const stats = new Map<string, { completed: number; total: number; done: boolean }>();
  if (lessonIds.length === 0) return stats;
  const totals = await prisma.lessonStep.groupBy({ by: ["lessonId"], where: { lessonId: { in: lessonIds } }, _count: { _all: true } });
  for (const t of totals) stats.set(t.lessonId, { completed: 0, total: t._count._all, done: false });
  if (!learnerId) return stats;
  const completions = await prisma.stepCompletion.findMany({
    where: { learnerId, step: { lessonId: { in: lessonIds } } },
    select: { step: { select: { lessonId: true } } },
  });
  for (const c of completions) {
    const entry = stats.get(c.step.lessonId);
    if (entry) entry.completed += 1;
  }
  const progress = await prisma.lessonProgress.findMany({ where: { learnerId, lessonId: { in: lessonIds } }, select: { lessonId: true, status: true } });
  for (const p of progress) {
    const entry = stats.get(p.lessonId);
    if (entry) entry.done = p.status === "COMPLETED" || (entry.total > 0 && entry.completed >= entry.total);
  }
  return stats;
}
