import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { readLearnerId } from "@/lib/learner";
import { getLearnerLessonStats, getTrackBySlug } from "@/lib/lessons";

export const dynamic = "force-dynamic";

type Params = { trackSlug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { trackSlug } = await params;
  const track = await getTrackBySlug(trackSlug);
  return track ? { title: track.title, description: track.summary } : { title: "Track not found" };
}

export default async function TrackPage({ params }: { params: Promise<Params> }) {
  const { trackSlug } = await params;
  const [track, learnerId] = await Promise.all([getTrackBySlug(trackSlug), readLearnerId()]);
  if (!track) notFound();
  const lessons = track.modules.flatMap((m) => m.lessons);
  const stats = await getLearnerLessonStats(learnerId, lessons.map((l) => l.id));
  const done = lessons.filter((l) => stats.get(l.id)?.done).length;

  return (
    <div className="container max-w-4xl py-12">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link href="/" className="hover:text-foreground">
          Tracks
        </Link>{" "}
        / <span className="text-foreground">{track.title}</span>
      </nav>
      <h1 className="text-4xl font-bold tracking-tight">{track.title}</h1>
      <p className="mt-3 text-lg text-muted-foreground">{track.summary}</p>
      {track.description ? <p className="mt-3 text-muted-foreground">{track.description}</p> : null}
      <div className="mt-6 flex items-center gap-3">
        <Progress value={lessons.length ? (done / lessons.length) * 100 : 0} />
        <span className="shrink-0 text-sm text-muted-foreground">
          {done}/{lessons.length} lessons
        </span>
      </div>

      <div className="mt-10 flex flex-col gap-10">
        {track.modules.map((module, mi) => (
          <section key={module.id}>
            <h2 className="text-xl font-semibold">
              <span className="mr-2 font-mono text-muted-foreground">{String(mi + 1).padStart(2, "0")}</span>
              {module.title}
            </h2>
            {module.summary ? <p className="mt-1 text-sm text-muted-foreground">{module.summary}</p> : null}
            <ol className="mt-4 flex flex-col gap-2">
              {module.lessons.map((lesson) => {
                const s = stats.get(lesson.id);
                return (
                  <li key={lesson.id}>
                    <Link
                      href={`/learn/${track.slug}/${module.slug}/${lesson.slug}`}
                      className="flex items-center gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
                    >
                      {s?.done ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" /> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{lesson.title}</div>
                        {lesson.summary ? <div className="truncate text-sm text-muted-foreground">{lesson.summary}</div> : null}
                      </div>
                      <div className="hidden shrink-0 items-center gap-3 text-xs text-muted-foreground sm:flex">
                        {s && s.total > 0 && !s.done && s.completed > 0 ? (
                          <Badge variant="outline">
                            {s.completed}/{s.total} tasks
                          </Badge>
                        ) : null}
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> {lesson.estimatedMinutes} min
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
