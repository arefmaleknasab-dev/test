import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "../utils/cn";
import { IconMinus, IconPlus, IconReset, IconWindow, IconX } from "./icons";

/* ---------- مدل چیدمان ---------- */

export type PanelId = "controls" | "editor" | "gcode";

export interface PanelState {
  open: boolean;
  collapsed: boolean;
  size: number; // عرض (px) در چیدمان دسکتاپ — برای پنل‌های کناری
}

export type LayoutState = Record<PanelId, PanelState>;

export const PANEL_IDS: PanelId[] = ["controls", "editor", "gcode"];

export const MIN_PANEL = 180;
export const MAX_PANEL = 640;

export function defaultLayout(): LayoutState {
  return {
    controls: { open: true, collapsed: false, size: 272 },
    editor: { open: true, collapsed: false, size: 0 },
    gcode: { open: true, collapsed: false, size: 330 },
  };
}

/* ادغام امن چیدمان ذخیره‌شده با پیش‌فرض (مقاوم در برابر داده خراب/قدیمی) */
export function normalizeLayout(saved: unknown): LayoutState {
  const out = defaultLayout();
  if (!saved || typeof saved !== "object") return out;
  const rec = saved as Record<string, unknown>;
  for (const id of PANEL_IDS) {
    const s = rec[id];
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.open === "boolean") out[id].open = o.open;
    if (typeof o.collapsed === "boolean") out[id].collapsed = o.collapsed;
    if (typeof o.size === "number" && Number.isFinite(o.size))
      out[id].size = Math.min(MAX_PANEL, Math.max(MIN_PANEL, Math.round(o.size)));
  }
  return out;
}

/* ---------- قاب پنل: نوار عنوان + جمع‌شدن + بستن ---------- */

interface DockPanelProps {
  title: string;
  icon?: ReactNode;
  state: PanelState;
  onCollapse: () => void;
  onClose: () => void;
  /** عرض ثابت در دسکتاپ (فقط پنل‌های کناری) */
  widthPx?: number;
  /** کلاس‌های ساختاری (order/width) — هم در حالت باز هم جمع‌شده */
  className?: string;
  /** کلاس‌های اضافی فقط در حالت باز (ارتفاع موبایل، flex و...) */
  expandedClassName?: string;
  children: ReactNode;
}

export function DockPanel({
  title,
  icon,
  state,
  onCollapse,
  onClose,
  widthPx,
  className,
  expandedClassName,
  children,
}: DockPanelProps) {
  if (!state.open) return null;

  /* نوار باریکِ جمع‌شده: کلیک = باز شدن */
  if (state.collapsed) {
    return (
      <button
        type="button"
        onClick={onCollapse}
        title={`${title} — باز کردن`}
        className={cn(
          "group flex shrink-0 grow-0 cursor-pointer items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2 transition-colors hover:border-brass/50",
          "@4xl:h-full @4xl:w-11 @4xl:flex-col @4xl:justify-start @4xl:px-0 @4xl:py-2",
          className
        )}
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded text-dim transition-colors group-hover:text-brass2">
          <IconPlus className="h-4 w-4" />
        </span>
        <span className="truncate text-[12px] font-bold text-mute transition-colors group-hover:text-ink @4xl:[writing-mode:vertical-rl]">
          {title}
        </span>
      </button>
    );
  }

  return (
    <section
      style={widthPx != null ? ({ "--dock-w": `${Math.round(widthPx)}px` } as CSSProperties) : undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-1.5",
        widthPx != null && "@4xl:w-[var(--dock-w)] @4xl:shrink-0",
        className,
        expandedClassName
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-panel2/70 px-2">
        {icon && <span className="grid h-5 w-5 shrink-0 place-items-center text-brass">{icon}</span>}
        <h2 className="truncate text-[12px] font-bold text-mute">{title}</h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCollapse}
          title="جمع‌کردن پنل"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-panel3 hover:text-ink"
        >
          <IconMinus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="بستن پنل (بازگشایی از منوی پنجره)"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-dim transition-colors hover:bg-panel3 hover:text-danger"
        >
          <IconX className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/* ---------- جداکننده کشویی بین دو پنل (تغییر اندازه با درگ) ---------- */

interface DockSplitterProps {
  onResize: (dxPx: number) => void;
  onResetSize?: () => void;
  title?: string;
  className?: string;
}

export function DockSplitter({ onResize, onResetSize, title, className }: DockSplitterProps) {
  const dragX = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title ?? "تغییر اندازه (دابل‌کلیک: اندازه پیش‌فرض)"}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        dragX.current = e.clientX;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (dragX.current == null) return;
        const dx = e.clientX - dragX.current;
        dragX.current = e.clientX;
        if (dx !== 0) onResize(dx);
      }}
      onPointerUp={() => {
        dragX.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        dragX.current = null;
        setDragging(false);
      }}
      onDoubleClick={onResetSize}
      className={cn(
        "group hidden w-[9px] shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center @4xl:flex",
        className
      )}
    >
      <div
        className={cn(
          "mx-auto w-px transition-colors",
          dragging ? "bg-brass" : "bg-edge group-hover:bg-brass/70"
        )}
      />
    </div>
  );
}

/* ---------- منوی شناور پنجره ---------- */

export type PanelVis = "open" | "collapsed" | "closed";

export interface WindowMenuItem {
  id: PanelId;
  label: string;
  vis: PanelVis;
}

interface WindowMenuProps {
  items: WindowMenuItem[];
  onToggle: (id: PanelId) => void;
  onReset: () => void;
}

const VIS_DOT: Record<PanelVis, string> = {
  open: "bg-ok",
  collapsed: "bg-brass",
  closed: "bg-dim/40",
};

const VIS_TEXT: Record<PanelVis, string> = {
  open: "باز",
  collapsed: "جمع‌شده",
  closed: "بسته",
};

export function WindowMenu({ items, onToggle, onReset }: WindowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="btn !px-2.5 !py-1.5 text-[11.5px]"
        onClick={() => setMenuOpen((o) => !o)}
        title="نمایش / پنهان کردن پنجره‌ها"
      >
        <IconWindow className="h-3.5 w-3.5" />
        پنجره
      </button>
      {menuOpen && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-60 rounded-lg border border-edge bg-panel/95 p-1.5 shadow-xl shadow-black/50 backdrop-blur">
          <div className="px-2 pb-1 pt-0.5 text-[10.5px] font-bold text-dim">پنجره‌ها</div>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => onToggle(it.id)}
              title={it.vis === "closed" ? "باز کردن پنجره" : "بستن پنجره"}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-right text-[12.5px] text-ink transition-colors hover:bg-panel3"
            >
              <span className={cn("h-2 w-2 shrink-0 rounded-full", VIS_DOT[it.vis])} />
              <span className="flex-1 truncate">{it.label}</span>
              <span className="shrink-0 text-[10px] text-dim">{VIS_TEXT[it.vis]}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-edge" />
          <button
            type="button"
            onClick={() => {
              onReset();
              setMenuOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-right text-[12.5px] text-mute transition-colors hover:bg-panel3 hover:text-ink"
          >
            <IconReset className="h-3.5 w-3.5" />
            بازنشانی چیدمان
          </button>
        </div>
      )}
    </div>
  );
}
