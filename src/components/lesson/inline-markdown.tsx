import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Compact markdown for step instructions and hints (no headings/images). */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={["p", "code", "strong", "em", "a", "ul", "ol", "li", "pre", "kbd", "br", "del"]}
      unwrapDisallowed
      components={{
        p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
        code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>,
        pre: ({ children }) => <pre className="my-1 overflow-x-auto rounded bg-muted p-2">{children}</pre>,
        a: ({ children, href }) => (
          <a href={href} className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
        ul: ({ children }) => <ul className="ml-4 list-disc">{children}</ul>,
        ol: ({ children }) => <ol className="ml-4 list-decimal">{children}</ol>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
