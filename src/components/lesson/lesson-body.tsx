import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnsiBlock } from "@/components/terminal/ansi-text";
import { findLanguage, highlight } from "@/lib/terminal/highlight";

/** Full lesson article. Fenced code blocks reuse the terminal's highlighter so docs and `bat` look identical. */
export function LessonBody({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-invert max-w-none prose-headings:scroll-mt-20 prose-headings:font-semibold prose-a:text-primary prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-pre:bg-transparent prose-pre:p-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const match = /language-([\w+-]+)/.exec(className ?? "");
            const text = String(children ?? "");
            const isBlock = Boolean(match) || text.includes("\n");
            if (!isBlock) return <code>{children}</code>;
            const lang = match ? findLanguage(match[1]) : null;
            const lines = lang ? highlight(text.replace(/\n$/, ""), lang).join("\n") : text.replace(/\n$/, "");
            return (
              <div className="not-prose my-4 overflow-hidden rounded-lg border border-terminal-border bg-terminal-bg">
                {match ? <div className="border-b border-terminal-border px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-terminal-fg/50">{match[1]}</div> : null}
                <AnsiBlock text={lines} className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-terminal-fg [&>div]:whitespace-pre" />
              </div>
            );
          },
          a: ({ children, href }) => (
            <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel={href?.startsWith("http") ? "noreferrer noopener" : undefined}>
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
