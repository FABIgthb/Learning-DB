import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const LEARNER_COOKIE = "learner_id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const CUID = /^c[a-z0-9]{20,32}$/;

/** Read the learner id from the cookie (Server Components: read-only). */
export async function readLearnerId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(LEARNER_COOKIE)?.value ?? null;
  return value && CUID.test(value) ? value : null;
}

/**
 * Resolve the current learner, creating one if needed (Route Handlers only).
 * Returns `created: true` when the caller must set the cookie on its response.
 */
export async function getOrCreateLearner(): Promise<{ id: string; created: boolean }> {
  const existingId = await readLearnerId();
  if (existingId) {
    const learner = await prisma.learner.update({ where: { id: existingId }, data: { lastSeenAt: new Date() }, select: { id: true } }).catch(() => null);
    if (learner) return { id: learner.id, created: false };
  }
  const learner = await prisma.learner.create({ data: {}, select: { id: true } });
  return { id: learner.id, created: true };
}

export function attachLearnerCookie(response: NextResponse, learnerId: string): void {
  const secure = (process.env.APP_ORIGIN ?? "").startsWith("https://") || process.env.NODE_ENV === "production";
  response.cookies.set(LEARNER_COOKIE, learnerId, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}
