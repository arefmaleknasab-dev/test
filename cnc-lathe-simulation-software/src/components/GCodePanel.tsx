import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { GenResult } from "../lib/lathe";
import { fmtTime } from "../lib/lathe";
import { cn } from "../utils/cn";

interface Props {
  gen: GenResult;
  activeLine: number;
  onLineClick?: (line: number) => void;
}

const TOKEN_RE = /(%|\(.*?\)|[NO]\d+|G\d+(?:\.\d+)?|M\d+|[XYZ]-?\d+(?:\.\d+)?|[FSP]\d+(?:\.\d+)?)/g;

function tokenize(line: string) {
  const parts: { text: string; cls: string }[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: line.slice(last, i), cls: "" });
    const tok = m[0];
    let cls = "";
    if (tok === "%" || tok.startsWith("O")) cls = "gc-tok-d";
    else if (tok.startsWith("(")) cls = "gc-tok-c";
    else if (tok.startsWith("N")) cls = "gc-tok-n";
    else if (tok.startsWith("G")) cls = "gc-tok-g";
    else if (tok.startsWith("M")) cls = "gc-tok-m";
    else if (tok.startsWith("X") || tok.startsWith("Z")) cls = "gc-tok-ax";
    else cls = "gc-tok-f";
    parts.push({ text: tok, cls });
    last = i + tok.length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), cls: "" });
  return parts;
}


const ROW_H = 20; // ارتفاع ثابت هر سطر (px) — سطرها تک‌خط و یکدست‌اند
const OVERSCAN = 8; // سطرهای اضافی بالا/پایین دید برای اسکرول نرم

interface RowProps { ln: number; parts: { text: string; cls: string }[]; active: boolean; top: number; onClick?: (line: number) => void }
/* سطر memo: هنگام پخش شبیه‌سازی فقط ۲ سطر (قبلی/فعلی) بازرندر می‌شوند نه ~۱۶۰۰ سطر */
const GCodeLine = memo(function GCodeLine({ ln, parts, active, top, onClick }: RowProps) {
  return (
    <div data-ln={ln} onClick={() => onClick?.(ln)} className={cn("gc-line", onClick && "cursor-pointer", active && "border-brass bg-brass/10")} style={{ textAlign: "left", position: "absolute", top, left: 0, right: 0, height: ROW_H, overflow: "hidden" }}>
      <span className="mr-2 inline-block w-7 select-none text-right text-[10px] text-dim">{ln + 1}</span>
      {parts.map((t, j) => (
        <span key={j} className={t.cls}>
          {t.text}
        </span>
      ))}
    </div>
  );
});

export default function GCodePanel({ gen, activeLine, onLineClick }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  const highlighted = useMemo(() => gen.lines.map((l) => tokenize(l)), [gen.lines]);

  /* مجازی‌سازی: فقط سطرهای داخل دید (+حاشیه) رندر می‌شوند تا تایپ/اسکرول گیر نکند */
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setView({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      const n = { top: el.scrollTop, height: el.clientHeight };
      setView((v) => (v.top === n.top && v.height === n.height ? v : n));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* دنبال‌کردن خط فعال شبیه‌سازی (معادل block:nearest) */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || activeLine < 0) return;
    const y = activeLine * ROW_H;
    if (y < el.scrollTop + OVERSCAN * ROW_H) el.scrollTop = Math.max(0, y - OVERSCAN * ROW_H);
    else if (y + ROW_H > el.scrollTop + el.clientHeight - OVERSCAN * ROW_H)
      el.scrollTop = y + ROW_H - el.clientHeight + OVERSCAN * ROW_H;
  }, [activeLine]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const n = { top: el.scrollTop, height: el.clientHeight };
    setView((v) => (v.top === n.top && v.height === n.height ? v : n));
  };
  const start = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
  const end = Math.min(highlighted.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);

  /* کپی دستی: چون لیست مجازی است (فقط سطرهای داخل دید رندر می‌شوند)، اگر
     انتخاب کاربر از اول تا آخر سطرهای نمایشی بود (مثل Ctrl+A)، کل برنامه —
     نه فقط همان چند سطر — با پایان‌خط CRLF در کلیپ‌بورد گذاشته می‌شود.
     انتخاب چند خط محدود، دست‌نخورده کپی می‌شود. */
  const onCopyFull = (e: ClipboardEvent<HTMLDivElement>) => {
    try {
      const sel = window.getSelection();
      const el = bodyRef.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !el) return;
      const first = el.querySelector(`[data-ln="${start}"]`);
      const last = el.querySelector(`[data-ln="${end - 1}"]`);
      if (first && last && sel.containsNode(first, true) && sel.containsNode(last, true)) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", gen.lines.join("\r\n"));
      }
    } catch {
      /* ignore — کپی عادی انجام می‌شود */
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-edge bg-panel">
      {/* آمار */}
      <div className="grid grid-cols-4 gap-px border-b border-edge bg-edge">
        <Stat label="زمان تخمینی" value={fmtTime(gen.timeSec)} accent />
        <Stat label="باربرداری" value={`${gen.volumeCm3.toFixed(1)} cm³`} />
        <Stat label="مسیر برش" value={`${(gen.cutLen / 10).toFixed(0)} cm`} />
        <Stat label="عملیات خشن" value={String(gen.roughLayers)} />
      </div>

      <div ref={bodyRef} onScroll={onScroll} onCopy={onCopyFull} className="min-h-0 flex-1 overflow-auto" dir="ltr">
        <div style={{ height: highlighted.length * ROW_H, position: "relative" }}>
          {highlighted.slice(start, end).map((parts, k) => (
            <GCodeLine key={start + k} ln={start + k} parts={parts} active={start + k === activeLine} top={(start + k) * ROW_H} onClick={onLineClick} />
          ))}
        </div>
      </div>

    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-panel px-2.5 py-1.5">
      <div className="text-[9.5px] font-semibold text-dim">{label}</div>
      <div className={cn("font-mono text-[12.5px] font-bold", accent ? "text-brass2" : "text-ink/90")} dir="ltr" style={{ textAlign: "right" }}>
        {value}
      </div>
    </div>
  );
}
