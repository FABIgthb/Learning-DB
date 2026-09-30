import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { LessonBody } from "@/components/lesson/lesson-body";
import { LessonWorkspace } from "@/components/lesson/lesson-workspace";
import { Badge } from "@/components/ui/badge";
import { readLearnerId } from "@/lib/learner";
import { getLessonBySlugs, getTrackLessonSequence, parseStoredHistory, toStepDefinitions } from "@/lib/lessons";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type Params = { trackSlug: string; moduleSlug: string; lessonSlug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { trackSlug, moduleSlug, lessonSlug } = await params;
  const lesson = await getLessonBySlugs(trackSlug, moduleSlug, lessonSlug);
  return lesson ? { title: `${lesson.title} — ${lesson.module.track.title}`, description: lesson.summary || undefined } : { title: "Lesson not found" };
}

export default async function LessonPage({ params }: { params: Promise<Params> }) {
  const { trackSlug, moduleSlug, lessonSlug } = await params;
  const [lesson, learnerId] = await Promise.all([getLessonBySlugs(trackSlug, moduleSlug, lessonSlug), readLearnerId()]);
  if (!lesson) notFound();

  const steps = toStepDefinitions(lesson);
  const stepIds = steps.map((s) => s.id);
  const [sequence, progress, completions] = await Promise.all([
    getTrackLessonSequence(lesson.module.trackId),
    learnerId ? prisma.lessonProgress.findUnique({ where: { learnerId_lessonId: { learnerId, lessonId: lesson.id } } }) : null,
    learnerId ? prisma.stepCompletion.findMany({ where: { learnerId, stepId: { in: stepIds } }, select: { stepId: true } }) : [],
  ]);

  const index = sequence.findIndex((l) => l.id === lesson.id);
  const prev = index > 0 ? sequence[index - 1] : null;
  const next = index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : null;
  const href = (l: { moduleSlug: string; slug: string }) => `/learn/${trackSlug}/${l.moduleSlug}/${l.slug}`;
  const completedIds = completions.map((c) => c.stepId);
  const baseline = progress ? progress.baselineStepIds.filter((id) => stepIds.includes(id)) : completedIds;

  return (
    <div className="container max-w-[1600px] py-6">
      <nav className="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          Tracks
        </Link>
        <span>/</span>
        <Link href={`/learn/${trackSlug}`} className="hover:text-foreground">
          {lesson.module.track.title}
        </Link>
        <span>/</span>
        <span>{lesson.module.title}</span>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <article className="min-w-0">
          <header className="mb-6">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{lesson.difficulty.toLowerCase()}</Badge>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" /> {lesson.estimatedMinutes} min
              </span>
              {lesson.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="font-mono text-[11px]">
                  {tag}
                </Badge>
              ))}
            </div>
            <h1 className="text-3xl font-bold tracking-tight">{lesson.title}</h1>
            {lesson.summary ? <p className="mt-2 text-muted-foreground">{lesson.summary}</p> : null}
          </header>
          <LessonBody markdown={lesson.body} />
          <div className="mt-10 flex items-center justify-between gap-4 border-t pt-6 text-sm">
            {prev ? (
              <Link href={href(prev)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ChevronLeft className="h-4 w-4" /> {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={href(next)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                {next.title} <ChevronRight className="h-4 w-4" />
              </Link>
            ) : null}
          </div>
        </article>

        <div className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <LessonWorkspace
            key={lesson.id}
            lessonId={lesson.id}
            lessonTitle={lesson.title}
            environment={lesson.environment}
            steps={steps}
            baselineStepIds={baseline}
            initialHistory={parseStoredHistory(progress?.history)}
            serverCompletedStepIds={completedIds}
            nextLesson={next ? { href: href(next), title: next.title } : null}
          />
        </div>
      </div>
    </div>
  );
}
