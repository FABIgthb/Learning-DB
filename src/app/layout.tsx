import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { TerminalSquare } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_ORIGIN ?? "https://learn.fabi-pm.xyz"),
  title: {
    default: "learn.fabi-pm.xyz — master the Linux shell",
    template: "%s · learn.fabi-pm.xyz",
  },
  description: "Hands-on lessons for the Linux shell and niche CLI/DevOps tools (fzf, jq, ripgrep, bat) with a live terminal simulator.",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#09090b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">
        <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container flex h-14 items-center justify-between gap-4">
            <Link href="/" className="flex items-center gap-2 font-mono text-sm font-semibold">
              <TerminalSquare className="h-5 w-5 text-primary" />
              <span>
                learn<span className="text-muted-foreground">.fabi-pm.xyz</span>
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/" className="transition-colors hover:text-foreground">
                Tracks
              </Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="border-t py-6">
          <div className="container flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
            <span className="font-mono">$ echo &quot;keep typing&quot;</span>
            <span>Self-hosted · served through Cloudflare Tunnel</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
