"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fuzzyFilter } from "@/lib/terminal/fuzzy";
import type { FzfRequest } from "@/lib/terminal/types";
import { cn } from "@/lib/utils";
import { AnsiBlock } from "./ansi-text";

const VISIBLE_ROWS = 12;

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i], hit });
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <span key={i} className="font-bold text-[#98c379]">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * In-terminal fzf UI (reverse layout): prompt on top, ranked list below,
 * optional preview pane. Resolves with the selection or null on abort.
 */
export function FzfPicker({ request, onDone }: { request: FzfRequest; onDone: (selection: string[] | null) => void }) {
  const [query, setQuery] = useState(request.query);
  const [cursor, setCursor] = useState(0);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  const ranked = useMemo(
    () => fuzzyFilter(request.items, query, { caseMode: request.caseMode, exact: request.exact, noSort: request.noSort }),
    [request, query],
  );

  const current = ranked[Math.min(cursor, Math.max(0, ranked.length - 1))];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    if (!request.preview || !current) {
      setPreview("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      request.preview?.(current.item).then((text) => {
        if (!cancelled) setPreview(text);
      });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [request, current]);

  const finish = useCallback(
    (selection: string[] | null) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone(selection);
    },
    [onDone],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const move = (delta: number) => {
      event.preventDefault();
      setCursor((c) => Math.max(0, Math.min(ranked.length - 1, c + delta)));
    };
    if (event.key === "Escape" || (ctrl && (event.key === "c" || event.key === "g" || event.key === "q"))) {
      event.preventDefault();
      finish(null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (request.multi && marked.size > 0) {
        finish(request.items.filter((_, index) => marked.has(index)));
      } else {
        finish(current ? [current.item] : []);
      }
      return;
    }
    if (event.key === "ArrowUp" || (ctrl && (event.key === "k" || event.key === "p"))) return move(-1);
    if (event.key === "ArrowDown" || (ctrl && (event.key === "j" || event.key === "n"))) return move(1);
    if (event.key === "PageUp") return move(-VISIBLE_ROWS);
    if (event.key === "PageDown") return move(VISIBLE_ROWS);
    if (event.key === "Tab" && request.multi) {
      event.preventDefault();
      if (!current) return;
      setMarked((prev) => {
        const next = new Set(prev);
        if (next.has(current.index)) next.delete(current.index);
        else next.add(current.index);
        return next;
      });
      setCursor((c) => Math.min(ranked.length - 1, c + (event.shiftKey ? -1 : 1)));
      return;
    }
    if (event.key === "Tab") event.preventDefault();
    if (ctrl && event.key === "u") {
      event.preventDefault();
      setQuery("");
    }
  };

  const start = Math.max(0, Math.min(cursor - Math.floor(VISIBLE_ROWS / 2), ranked.length - VISIBLE_ROWS));
  const visible = ranked.slice(start, start + VISIBLE_ROWS);

  return (
    <div className="my-1 rounded border border-terminal-border/80 bg-black/20" role="dialog" aria-label="fzf fuzzy finder">
      <div className={cn("flex", request.preview ? "flex-col md:flex-row" : "flex-col")}>
        <div className={cn("min-w-0", request.preview ? "md:w-1/2" : "w-full")}>
          <label className="flex items-center gap-1 px-2 pt-1">
            <span className="text-[#61afef]">{request.prompt}</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent text-terminal-fg caret-[#98c379] outline-none"
              aria-label="fzf query"
              data-terminal-input="true"
            />
          </label>
          <div className="flex items-center gap-2 px-2 text-[#e5c07b]">
            <span>
              {ranked.length}/{request.items.length}
            </span>
            {request.multi && marked.size > 0 ? <span>({marked.size})</span> : null}
            <span className="flex-1 border-b border-dashed border-terminal-border" />
          </div>
          {request.header ? <div className="px-2 text-[#56b6c2]">{request.header}</div> : null}
          <ul className="px-1 pb-1" role="listbox">
            {visible.map((entry, i) => {
              const active = start + i === cursor;
              const isMarked = marked.has(entry.index);
              return (
                <li
                  key={`${entry.index}-${entry.item}`}
                  role="option"
                  aria-selected={active}
                  className={cn("flex cursor-pointer gap-1 whitespace-pre rounded-sm px-1", active && "bg-white/10")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setCursor(start + i);
                  }}
                  onDoubleClick={() => finish([entry.item])}
                >
                  <span className={cn("w-3 shrink-0", active ? "text-[#e06c75]" : "text-transparent")}>▌</span>
                  <span className={cn("w-3 shrink-0", isMarked ? "text-[#c678dd]" : "text-transparent")}>•</span>
                  <span className="truncate">
                    <Highlighted text={entry.item} positions={entry.positions} />
                  </span>
                </li>
              );
            })}
            {ranked.length === 0 ? <li className="px-2 text-terminal-fg/50">no matches</li> : null}
          </ul>
        </div>
        {request.preview ? (
          <div className="terminal-scroll max-h-72 min-w-0 overflow-auto border-t border-terminal-border p-2 md:w-1/2 md:border-l md:border-t-0">
            <AnsiBlock text={preview} />
          </div>
        ) : null}
      </div>
      <div className="border-t border-terminal-border px-2 py-0.5 text-[11px] text-terminal-fg/50">
        ↑/↓ move · Enter select{request.multi ? " · Tab mark" : ""} · Esc cancel
      </div>
    </div>
  );
}
