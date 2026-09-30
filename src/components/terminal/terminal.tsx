"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ansi } from "@/lib/terminal/ansi";
import type { Shell } from "@/lib/terminal/shell";
import type { FzfRequest, OutputSink } from "@/lib/terminal/types";
import { cn } from "@/lib/utils";
import { AnsiLine, LineBuffer } from "./ansi-text";
import { FzfPicker } from "./fzf-picker";

export interface TerminalHandle {
  /** Write raw (ANSI) text to the terminal, e.g. system notices. */
  write(text: string): void;
  clear(): void;
  focus(): void;
  /** Replace the current input line (used by "try the solution"). */
  setInput(text: string): void;
}

export interface TerminalProps {
  shell: Shell;
  /** Runs the command; must stream output into `sink`. */
  onExecute(input: string, sink: OutputSink, columns: number): Promise<void>;
  title?: string;
  banner?: string;
  disabled?: boolean;
  className?: string;
  toolbar?: React.ReactNode;
}

function promptText(shell: Shell): string {
  return `${ansi.bold(ansi.green(`${shell.user}@${shell.hostname}`))}:${ansi.bold(ansi.brightBlue(shell.displayCwd()))}$ `;
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { shell, onExecute, title = "bash", banner, disabled = false, className, toolbar },
  ref,
) {
  const bufferRef = useRef(new LineBuffer());
  const [, setVersion] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ request: FzfRequest; resolve: (s: string[] | null) => void } | null>(null);
  const [columns, setColumns] = useState(80);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const historyIndex = useRef<number | null>(null);
  const draft = useRef("");
  const lastTabInput = useRef<string | null>(null);

  const rerender = useCallback(() => setVersion((v) => v + 1), []);

  const write = useCallback(
    (text: string) => {
      bufferRef.current.write(text);
      rerender();
    },
    [rerender],
  );

  const focus = useCallback(() => {
    const target = scrollRef.current?.querySelector<HTMLInputElement>("input[data-terminal-input='true']") ?? inputRef.current;
    target?.focus({ preventScroll: true });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      write,
      clear: () => {
        bufferRef.current.clear();
        rerender();
      },
      focus,
      setInput: (text: string) => {
        setInput(text);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          const len = text.length;
          inputRef.current?.setSelectionRange(len, len);
        });
      },
    }),
    [write, rerender, focus],
  );

  // Bridge interactive programs (fzf) to the picker UI.
  useEffect(() => {
    shell.interactive = {
      fzf: (request) =>
        new Promise<string[] | null>((resolve) => {
          setPicker({ request, resolve });
        }),
    };
    return () => {
      shell.interactive = null;
    };
  }, [shell]);

  // Banner on mount / when the shell is replaced (reset).
  useEffect(() => {
    bufferRef.current.clear();
    if (banner) bufferRef.current.write(banner.endsWith("\n") ? banner : banner + "\n");
    rerender();
  }, [shell, banner, rerender]);

  // Measure how many monospace columns fit (drives ls/bat layout).
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const probe = measureRef.current;
    if (!container || !probe) return;
    const update = () => {
      const charWidth = probe.getBoundingClientRect().width / 10 || 8;
      const style = getComputedStyle(container);
      const inner = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setColumns(Math.max(20, Math.min(400, Math.floor(inner / charWidth))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    shell.columns = columns;
  }, [shell, columns]);

  // Keep the view pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const run = useCallback(
    async (line: string) => {
      const buffer = bufferRef.current;
      buffer.ensureNewline();
      buffer.write(promptText(shell) + line + "\n");
      rerender();
      historyIndex.current = null;
      draft.current = "";
      if (line.trim() === "") return;
      setBusy(true);
      const sink: OutputSink = {
        stdout: (chunk) => {
          buffer.write(chunk);
          rerender();
        },
        stderr: (chunk) => {
          buffer.write(chunk);
          rerender();
        },
      };
      try {
        await onExecute(line, sink, columns);
      } catch (error) {
        buffer.write(ansi.red(`simulator error: ${error instanceof Error ? error.message : String(error)}`) + "\n");
      } finally {
        buffer.ensureNewline();
        setPicker(null);
        setBusy(false);
        rerender();
        requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      }
    },
    [shell, onExecute, columns, rerender],
  );

  const complete = () => {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const { replaceFrom, candidates } = shell.complete(before);
    if (candidates.length === 0) return;
    const word = before.slice(replaceFrom);
    let completion: string;
    if (candidates.length === 1) {
      const only = candidates[0];
      completion = only.endsWith("/") ? only : only + " ";
    } else {
      completion = commonPrefix(candidates);
      if (completion.length <= word.length) {
        // Second Tab with nothing to add: list the candidates like bash.
        if (lastTabInput.current === input) {
          const buffer = bufferRef.current;
          buffer.ensureNewline();
          buffer.write(promptText(shell) + input + "\n");
          const names = candidates.map((c) => c.replace(/\/$/, "").split("/").pop() + (c.endsWith("/") ? "/" : ""));
          buffer.write(names.join("  ") + "\n");
          rerender();
        }
        lastTabInput.current = input;
        return;
      }
    }
    const next = before.slice(0, replaceFrom) + completion + after;
    setInput(next);
    lastTabInput.current = next;
    const pos = replaceFrom + completion.length;
    requestAnimationFrame(() => el?.setSelectionRange(pos, pos));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const el = event.currentTarget;
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key !== "Tab") lastTabInput.current = null;

    if (event.key === "Enter") {
      event.preventDefault();
      const line = input;
      setInput("");
      void run(line);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      complete();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const entries = shell.history;
      if (entries.length === 0) return;
      if (historyIndex.current === null) {
        if (event.key === "ArrowDown") return;
        draft.current = input;
        historyIndex.current = entries.length - 1;
      } else if (event.key === "ArrowUp") {
        historyIndex.current = Math.max(0, historyIndex.current - 1);
      } else {
        historyIndex.current += 1;
        if (historyIndex.current >= entries.length) {
          historyIndex.current = null;
          setInput(draft.current);
          return;
        }
      }
      const value = entries[historyIndex.current];
      setInput(value);
      requestAnimationFrame(() => el.setSelectionRange(value.length, value.length));
      return;
    }
    if (!ctrl) return;
    const cursor = el.selectionStart ?? input.length;
    switch (event.key.toLowerCase()) {
      case "c": {
        if (el.selectionStart !== el.selectionEnd) return; // allow copy of a selection
        event.preventDefault();
        const buffer = bufferRef.current;
        buffer.ensureNewline();
        buffer.write(promptText(shell) + input + "^C\n");
        setInput("");
        historyIndex.current = null;
        rerender();
        return;
      }
      case "l":
        event.preventDefault();
        bufferRef.current.clear();
        rerender();
        return;
      case "a":
        event.preventDefault();
        el.setSelectionRange(0, 0);
        return;
      case "e":
        event.preventDefault();
        el.setSelectionRange(input.length, input.length);
        return;
      case "u": {
        event.preventDefault();
        setInput(input.slice(cursor));
        requestAnimationFrame(() => el.setSelectionRange(0, 0));
        return;
      }
      case "k":
        event.preventDefault();
        setInput(input.slice(0, cursor));
        return;
      case "w": {
        event.preventDefault();
        const before = input.slice(0, cursor).replace(/\S+\s*$/, "");
        setInput(before + input.slice(cursor));
        requestAnimationFrame(() => el.setSelectionRange(before.length, before.length));
        return;
      }
      default:
        return;
    }
  };

  const lines = bufferRef.current.lines;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border border-terminal-border bg-terminal-bg shadow-2xl shadow-black/40", className)}>
      <div className="flex items-center gap-3 border-b border-terminal-border bg-black/30 px-3 py-2">
        <div className="flex gap-1.5" aria-hidden>
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 truncate text-center font-mono text-xs text-terminal-fg/60">
          {shell.user}@{shell.hostname}: {shell.displayCwd()} — {title}
        </div>
        <div className="flex items-center gap-1">{toolbar}</div>
      </div>
      <div
        ref={scrollRef}
        className="terminal-scroll relative min-h-0 flex-1 cursor-text overflow-y-auto overflow-x-hidden p-3 font-mono text-[13px] leading-[1.35] text-terminal-fg sm:text-sm"
        onMouseUp={() => {
          if (window.getSelection()?.toString()) return;
          focus();
        }}
        role="log"
        aria-live="polite"
        aria-label="Terminal output"
      >
        <span ref={measureRef} className="invisible absolute -left-[9999px] whitespace-pre" aria-hidden>
          MMMMMMMMMM
        </span>
        {lines.map((line) => (
          <AnsiLine key={line.id} spans={line.spans} />
        ))}
        {picker ? (
          <FzfPicker
            key={picker.request.items.length + picker.request.query}
            request={picker.request}
            onDone={(selection) => {
              const resolve = picker.resolve;
              setPicker(null);
              resolve(selection);
            }}
          />
        ) : null}
        {!busy && !picker ? (
          <div className="flex whitespace-pre">
            <AnsiPrompt text={promptText(shell)} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                historyIndex.current = null;
              }}
              onKeyDown={onKeyDown}
              disabled={disabled}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              enterKeyHint="send"
              aria-label="Terminal input"
              className="min-w-0 flex-1 bg-transparent p-0 font-mono text-base text-terminal-fg caret-[#98c379] outline-none sm:text-sm"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});

function AnsiPrompt({ text }: { text: string }) {
  const buffer = new LineBuffer(1);
  buffer.write(text);
  const spans = buffer.lines[0]?.spans ?? [];
  return (
    <span className="shrink-0">
      {spans.map((span, i) => (
        <span key={i} style={{ color: span.style.fg ?? undefined, fontWeight: span.style.bold ? 700 : undefined }}>
          {span.text}
        </span>
      ))}
    </span>
  );
}
