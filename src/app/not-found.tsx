import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="container flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <p className="font-mono text-sm text-muted-foreground">bash: cd: page: No such file or directory</p>
      <h1 className="text-3xl font-bold">404 — not found</h1>
      <Button asChild>
        <Link href="/">cd ~</Link>
      </Button>
    </div>
  );
}
