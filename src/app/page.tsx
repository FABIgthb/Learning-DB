import Link from "next/link";
import { ArrowRight, BookOpen, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { readLearnerId } from "@/lib/learner";
import { getLearnerLessonStats, getPublishedTracks } from "@/lib/lessons";

export const dynamic = "force-dynamic";

const DIFFICULTY_LABEL = { BEGINNER: "Beginner", INTERMEDIATE: "Intermediate", ADVANCED: "Advanced" } as const;

export default async function HomePage() {
  const [tracks, learnerId] = await Promise.all([getPublishedTracks(), readLearnerId()]);
  const lessonIds = tracks.flatMap((t) => t.modules.flatMap((m) => m.lessons.map((l) => l.id)));
  const stats = await getLearnerLessonStats(learnerId, lessonIds);

  return (
    <div className="bg-grid">
      <section className="container py-16 sm:py-24">
        <div className="max-w-3xl">
          <Badge variant="outline" className="mb-4 font-mono">
            ~/learn $ ./start.sh
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Learn the shell by <span className="text-primary">actually typing</span>.
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Bite-sized lessons with a real-feeling Linux terminal right next to them. Navigate a file system, then level up with the tools power users swear by:{" "}
            <code className="font-mono text-foreground">fzf</code>, <code className="font-mono text-foreground">jq</code>,{" "}
            <code className="font-mono text-foreground">rg</code> and <code className="font-mono text-foreground">bat</code>.
          </p>
        </div>
      </section>

      <section className="container pb-24">
        {tracks.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No tracks published yet</CardTitle>
              <CardDescription>
                Add Markdown lessons to <code className="font-mono">/content</code> and run the import, or seed the database with{" "}
                <code className="font-mono">npm run db:seed</code>.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {tracks.map((track) => {
              const lessons = track.modules.flatMap((m) => m.lessons);
              const done = lessons.filter((l) => stats.get(l.id)?.done).length;
              const minutes = lessons.reduce((sum, l) => sum + l.estimatedMinutes, 0);
              const firstUnfinished = track.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleSlug: m.slug }))).find((l) => !stats.get(l.id)?.done);
              return (
                <Card key={track.id} className="flex flex-col transition-colors hover:border-primary/40">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{DIFFICULTY_LABEL[track.difficulty]}</Badge>
                      {track.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag} variant="outline" className="font-mono text-[11px]">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    <CardTitle className="mt-3 text-2xl">
                      <Link href={`/learn/${track.slug}`} className="hover:underline">
                        {track.title}
                      </Link>
                    </CardTitle>
                    <CardDescription>{track.summary}</CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto flex flex-col gap-4">
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <BookOpen className="h-3.5 w-3.5" /> {track.modules.length} modules · {lessons.length} lessons
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" /> ~{minutes} min
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Progress value={lessons.length ? (done / lessons.length) * 100 : 0} />
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {done}/{lessons.length}
                      </span>
                    </div>
                    {firstUnfinished ? (
                      <Link href={`/learn/${track.slug}/${firstUnfinished.moduleSlug}/${firstUnfinished.slug}`} className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                        {done === 0 ? "Start" : "Continue"}: {firstUnfinished.title} <ArrowRight className="h-4 w-4" />
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-success">Track complete ✔</span>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
