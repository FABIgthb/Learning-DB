import { memo, type CSSProperties } from "react";
import { DEFAULT_STYLE, parseAnsiLine, type AnsiSpan, type AnsiStyle } from "@/lib/terminal/ansi";

export interface TerminalLine {
  id: number;
  spans: AnsiSpan[];
}

function styleToCss(style: AnsiStyle): CSSProperties | undefined {
  if (style === DEFAULT_STYLE) return undefined;
  const css: CSSProperties = {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    [fg, bg] = [bg ?? "hsl(var(--terminal-bg))", fg ?? "hsl(var(--terminal-fg))"];
  }
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = 700;
  if (style.dim) css.opacity = 0.65;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  return css;
}

export const AnsiLine = memo(function AnsiLine({ spans }: { spans: AnsiSpan[] }) {
  if (spans.length === 0) return <div className="min-h-[1.35em]">{"​"}</div>;
  return (
    <div className="min-h-[1.35em] whitespace-pre-wrap break-words">
      {spans.map((span, i) => (
        <span key={i} style={styleToCss(span.style)}>
          {span.text}
        </span>
      ))}
    </div>
  );
});

/** Render a multi-line ANSI string (used by the fzf preview pane). */
export function AnsiBlock({ text, className }: { text: string; className?: string }) {
  let style = DEFAULT_STYLE;
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className={className}>
      {lines.map((line, i) => {
        const parsed = parseAnsiLine(line, style);
        style = parsed.style;
        return <AnsiLine key={i} spans={parsed.spans} />;
      })}
    </div>
  );
}

/**
 * Incremental ANSI line buffer: accepts arbitrary output chunks, keeps SGR
 * state across chunk/line boundaries and handles clear-screen sequences.
 */
export class LineBuffer {
  lines: TerminalLine[] = [];
  private nextId = 1;
  private openLine: string | null = null;
  private openLineStyle: AnsiStyle = DEFAULT_STYLE;
  private style: AnsiStyle = DEFAULT_STYLE;

  constructor(private readonly maxLines = 3000) {}

  clear(): void {
    this.lines = [];
    this.openLine = null;
    this.style = DEFAULT_STYLE;
    this.openLineStyle = DEFAULT_STYLE;
  }

  write(chunk: string): void {
    let text = chunk;
    const clearIdx = text.lastIndexOf("\x1b[2J");
    if (clearIdx !== -1) {
      this.clear();
      text = text.slice(clearIdx + 4).replace(/^\x1b\[H/, "").replace(/\x1b\[H/g, "");
    }
    text = text.replace(/\r(?!\n)/g, "").replace(/\r\n/g, "\n").replace(/\x1b\[H/g, "");
    if (text === "") return;
    const pieces = text.split("\n");
    pieces.forEach((piece, index) => {
      const isLast = index === pieces.length - 1;
      if (this.openLine !== null) {
        // Re-render the open line with the appended text.
        this.lines.pop();
        const combined = this.openLine + piece;
        const parsed = parseAnsiLine(combined, this.openLineStyle);
        this.lines.push({ id: this.nextId++, spans: parsed.spans });
        this.style = parsed.style;
        this.openLine = isLast ? combined : null;
        if (!isLast) this.openLineStyle = this.style;
        return;
      }
      if (isLast && piece === "") return;
      const startStyle = this.style;
      const parsed = parseAnsiLine(piece, startStyle);
      this.lines.push({ id: this.nextId++, spans: parsed.spans });
      this.style = parsed.style;
      if (isLast) {
        this.openLine = piece;
        this.openLineStyle = startStyle;
      }
    });
    if (this.lines.length > this.maxLines) this.lines = this.lines.slice(-this.maxLines);
  }

  /** Ensure the next write starts on a fresh line (like a shell prompt after output without newline). */
  ensureNewline(): void {
    this.openLine = null;
    this.openLineStyle = this.style;
  }
}
