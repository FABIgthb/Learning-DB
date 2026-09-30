/**
 * Content QA: every seeded lesson must be completable by typing each step's
 * reference solution in order, and the server replay must agree.
 */

import { describe, expect, it } from "vitest";
import { TRACKS } from "../../../prisma/seed-data";
import { fuzzyFilter } from "./fuzzy";
import { LessonSession, replayLesson } from "./session";
import type { StepDefinition } from "./types";

/** Interactive fzf stand-in: picks the best match for a query derived from the step instruction. */
function pickerFor(query: string) {
  return {
    fzf: async (request: { items: string[] }) => {
      const ranked = fuzzyFilter(request.items, query);
      return ranked.length ? [ranked[0].item] : null;
    },
  };
}

for (const track of TRACKS) {
  for (const module of track.modules) {
    for (const lesson of module.lessons) {
      describe(`${track.slug}/${module.slug}/${lesson.slug}`, () => {
        const steps: StepDefinition[] = lesson.steps.map((s, i) => ({ ...s, id: s.key, order: i + 1 }));

        it("has unique step keys", () => {
          expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
        });

        it("is completable with the reference solutions", async () => {
          const session = new LessonSession({ environment: lesson.environment, steps, interactive: pickerFor("products") });
          for (const step of steps) {
            const { evaluation, result } = await session.run(step.solution);
            expect(evaluation?.stepId, `step ${step.key}`).toBe(step.id);
            expect(evaluation?.outcome.failures, `step ${step.key}: $ ${step.solution}\n${result.stdout}${result.stderr}`).toEqual([]);
            expect(evaluation?.outcome.passed).toBe(true);
          }
          expect(session.isComplete).toBe(true);

          const replay = await replayLesson({ environment: lesson.environment, steps, history: session.history });
          expect(replay.lessonComplete).toBe(true);
        });
      });
    }
  }
}
