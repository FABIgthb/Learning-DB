/**
 * Seeds the launch track. Idempotent: re-running updates content in place and
 * keeps learner progress (steps are matched by their stable `key`).
 *
 *   npm run db:seed
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { environmentSpecSchema } from "../src/lib/terminal/types";
import { TRACKS } from "./seed-data";

const prisma = new PrismaClient();

async function main() {
  for (const [trackIndex, track] of TRACKS.entries()) {
    const trackRow = await prisma.track.upsert({
      where: { slug: track.slug },
      create: {
        slug: track.slug,
        title: track.title,
        summary: track.summary,
        description: track.description,
        difficulty: track.difficulty,
        tags: track.tags,
        order: trackIndex,
      },
      update: {
        title: track.title,
        summary: track.summary,
        description: track.description,
        difficulty: track.difficulty,
        tags: track.tags,
        order: trackIndex,
        status: "PUBLISHED",
      },
    });

    for (const [moduleIndex, module] of track.modules.entries()) {
      const moduleRow = await prisma.module.upsert({
        where: { trackId_slug: { trackId: trackRow.id, slug: module.slug } },
        create: { trackId: trackRow.id, slug: module.slug, title: module.title, summary: module.summary, order: moduleIndex },
        update: { title: module.title, summary: module.summary, order: moduleIndex, status: "PUBLISHED" },
      });

      for (const [lessonIndex, lesson] of module.lessons.entries()) {
        const environment = environmentSpecSchema.parse(lesson.environment) as Prisma.InputJsonValue;
        const lessonRow = await prisma.lesson.upsert({
          where: { moduleId_slug: { moduleId: moduleRow.id, slug: lesson.slug } },
          create: {
            moduleId: moduleRow.id,
            slug: lesson.slug,
            title: lesson.title,
            summary: lesson.summary,
            body: lesson.body,
            order: lessonIndex,
            estimatedMinutes: lesson.estimatedMinutes,
            difficulty: lesson.difficulty,
            tags: lesson.tags,
            environment,
          },
          update: {
            title: lesson.title,
            summary: lesson.summary,
            body: lesson.body,
            order: lessonIndex,
            estimatedMinutes: lesson.estimatedMinutes,
            difficulty: lesson.difficulty,
            tags: lesson.tags,
            environment,
            status: "PUBLISHED",
          },
        });

        await prisma.$transaction(async (tx) => {
          const keys = lesson.steps.map((s) => s.key);
          await tx.lessonStep.deleteMany({ where: { lessonId: lessonRow.id, key: { notIn: keys } } });
          for (const [stepIndex, step] of lesson.steps.entries()) {
            const data = {
              order: stepIndex + 1,
              title: step.title,
              instruction: step.instruction,
              hint: step.hint ?? null,
              solution: step.solution,
              successMessage: step.successMessage ?? null,
            };
            const stepRow = await tx.lessonStep.upsert({
              where: { lessonId_key: { lessonId: lessonRow.id, key: step.key } },
              create: { lessonId: lessonRow.id, key: step.key, ...data },
              update: data,
            });
            await tx.commandValidation.deleteMany({ where: { stepId: stepRow.id } });
            await tx.commandValidation.createMany({
              data: step.validations.map((v, order) => ({
                stepId: stepRow.id,
                order,
                type: v.type,
                expected: v.expected,
                target: v.target ?? null,
                flags: v.flags ?? null,
                alternatives: v.alternatives ?? [],
                requireSuccess: v.requireSuccess ?? true,
                failureMessage: v.failureMessage ?? null,
              })),
            });
          }
        });
        console.log(`  ✓ ${track.slug}/${module.slug}/${lesson.slug} (${lesson.steps.length} steps)`);
      }
    }
  }
}

main()
  .then(() => console.log("Seed complete."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
