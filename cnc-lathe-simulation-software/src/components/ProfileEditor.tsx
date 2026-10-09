import { useEffect, useMemo, useRef, useState } from "react";
import type { EditBuf, ELine, EVert, GenResult, Holder2State, OffPatch, Op, Params, SegKind, SplitState } from "../lib/lathe";
import { deleteEditLines, deleteEditVertices, insertEditVertex, MIN_HOLDER2_OFFSET, normalizeEditBuf, OP_INFO, RAPID_RATE, translateHolder2Edit } from "../lib/lathe";
import type { SketchKind, SketchSeg, SnapPoint, SPoint } from "../lib/sketch";
import {
  arcRadius,
  arcWithRadius,
  chainPolyline,
  cloneSeg,
  defaultCubicHandles,
  dist,
  distToSeg,
  endFromLenAngle,
  evalSeg,
  intersectionPoints,
  KIND_FA,
  lineAngle,
  makeSeg,
  moveSeg,
  newSegId,
  orderChain,
  segBounds,
  segLength,
  segMid,
  segPoints,
  SNAP_FA,
  snapCandidates,
  splitChainAt,
} from "../lib/sketch";
import { cn } from "../utils/cn";
import {
  IconArc3,
  IconCheck,
  IconCode,
  IconCopy,
  IconCorner,
  IconCubic,
  IconCursor,
  IconFit,
  IconFillet,
  IconGrid,
  IconHand,
  IconLayers,
  IconLine,
  IconMagnet,
  IconMagnetSm,
  IconMinus,
  IconMove,
  IconPlus,
  IconQuad,
  IconRedo,
  IconSplit,
  IconTrash,
  IconUndo,
  IconX,
} from "./icons";

export interface EdSettings {
  snap: number;
  smartSnap: boolean;
  showRough: boolean;
  showFinish: boolean;
  showOffset: boolean;
  showInnerRough: boolean;
  showInnerOffset: boolean;
  showInnerFinish: boolean;
  showRound: boolean;
  showFace: boolean;
  showBottom: boolean;
  showRapids: boolean;
  showGhost: boolean;
  /** شفافیت مشترک همهٔ لایه‌های مسیر و سایهٔ طرح (۰٫۱ تا ۱). */
  layerOpacity: number;
  /** گرید مستقل حالت ویرایش مسیر (نمایش + فاصله خطوط اصلی + تقسیمات داخلی). */
  editGridVisible: boolean;
  editGridSize: number;
  editGridDivisions: number;
}

type Tool = "select" | "move" | "fillet" | "line" | "quad" | "cubic" | "arc" | "split";

const TOOLS: { id: Tool; name: string; key: string; icon: React.ReactNode; hint: string }[] = [
  { id: "select", name: "انتخاب", key: "V", icon: <IconCursor className="h-4 w-4" />, hint: "انتخاب" },
  { id: "move", name: "جابجایی", key: "M", icon: <IconMove className="h-4 w-4" />, hint: "جابجایی دقیق با مقدار یا عبارت ریاضی" },
  { id: "fillet", name: "فیلت", key: "F", icon: <IconFillet className="h-4 w-4" />, hint: "ایجاد قوس مماس بین دو خط" },
  { id: "line", name: "خط", key: "L", icon: <IconLine className="h-4 w-4" />, hint: "خط مستقیم: نقطهٔ شروع و پایان" },
  { id: "quad", name: "منحنی", key: "C", icon: <IconQuad className="h-4 w-4" />, hint: "منحنی ساده: شروع، پایان، یک نقطهٔ کنترل" },
  { id: "cubic", name: "منحنی کنترلی", key: "B", icon: <IconCubic className="h-4 w-4" />, hint: "منحنی پیشرفته: شروع، پایان، سپس دستهٔ خروج از پایان و دستهٔ ورود به شروع" },
  { id: "arc", name: "کمان", key: "A", icon: <IconArc3 className="h-4 w-4" />, hint: "کمان سه‌نقطه‌ای: شروع، پایان، نقطه‌ای روی کمان" },
  { id: "split", name: "نقطه Split", key: "S", icon: <IconSplit className="h-4 w-4" />, hint: "قرار دادن نقطه تعیین‌کننده داخل/خارج روی پروفیل" },
];

const NEED_PTS: Record<Tool, number> = { select: 0, move: 0, fillet: 0, line: 2, quad: 3, cubic: 4, arc: 3, split: 1 };

const STEP_HINT: Record<Tool, string[]> = {
  select: [],
  move: [],
  fillet: [],
  line: ["نقطهٔ شروع خط", "نقطهٔ پایان خط"],
  quad: ["نقطهٔ شروع", "نقطهٔ پایان", "نقطهٔ کنترل منحنی"],
  cubic: ["نقطهٔ شروع", "نقطهٔ پایان", "دستهٔ خروج از پایان", "دستهٔ ورود به شروع"],
  arc: ["نقطهٔ شروع کمان", "نقطهٔ پایان کمان", "نقطه‌ای روی کمان"],
  split: ["کلیک روی پروفیل برای قرار دادن نقطه Split"],
};

interface Props {
  segs: SketchSeg[];
  onSegs: (next: SketchSeg[], commit: boolean) => void;
  selected: number[];
  onSelected: (ids: number[]) => void;
  params: Params;
  gen: GenResult;
  split: SplitState;
  onSplit: (s: SplitState) => void;
  settings: EdSettings;
  onSettings: (patch: Partial<EdSettings>) => void;
  ops: Op[];
  isolatedOpId: number | null;
  onClearIsolate: () => void;
  /** انتخاب هندسه، بلوک متناظر را در پنجرهٔ جی‌کد فعال و اسکرول می‌کند. */
  onActiveGCodeLine: (line: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /* حالت ویرایش مسیر */
  edit: EditBuf | null;
  editChanges: number;
  onEditToggle: (open: boolean) => void;
  onEditBuf: (next: EditBuf | null, commit: boolean) => void;
  onEditConfirm: () => void;
  onEditCancel: () => void;
  onEditDiscard: () => void;
}

interface Cam {
  s: number;
  ox: number;
  oy: number;
}

const SPEED_PRESETS = [80, 100, 300, 500, 700, 900, 1500] as const;
const SPEED_COLORS: Record<number, string> = {
  80: "#4cc9f0",
  100: "#4895ef",
  300: "#43d6b5",
  500: "#8ac926",
  700: "#ffd166",
  900: "#f4a261",
  1500: "#b48ee0",
};
const latinDigits = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

const speedStroke = (motion: 0 | 1, feed: number) => {
  if (motion === 0) return "#ef4444";
  const exact = SPEED_COLORS[Math.round(feed)];
  if (exact) return exact;
  /* سرعت دستی: طیف آبی تا بنفش، دور از قرمز اختصاصی G0. */
  const hue = 195 + Math.min(95, Math.max(0, (feed / 1500) * 95));
  return `hsl(${hue.toFixed(0)} 72% 62%)`;
};

/** خطِ هندسی EditBuf را با کلید پایدار و شمارهٔ وقوع به بلوک جی‌کد وصل می‌کند. */
function editLineGCodeIndex(lineId: number, editLines: ELine[], gen: GenResult): number {
  const editIndex = editLines.findIndex((line) => line.id === lineId);
  if (editIndex < 0) return -1;
  const line = editLines[editIndex];
  const bridge = /^#bridge:(.+):(\d+)$/.exec(line.key);
  if (bridge) {
    const baseKey = bridge[1];
    const moveIndex = /^move:(\d+)$/.exec(baseKey);
    const seg = moveIndex
      ? gen.segs[Number(moveIndex[1])]
      : gen.segs.find((candidate) => candidate.ovrKey === baseKey);
    return seg?.line ?? -1;
  }
  const move = /^#move:(\d+)$/.exec(line.key);
  if (move) return gen.segs[Number(move[1])]?.line ?? -1;
  if (line.key.startsWith("#")) return -1;

  let occurrence = -1;
  for (let i = 0; i <= editIndex; i++) {
    if (editLines[i].key === line.key) occurrence++;
  }
  const matches = gen.segs.filter((segment) => segment.ovrKey === line.key);
  if (!matches.length) return -1;
  return matches[Math.min(Math.max(0, occurrence), matches.length - 1)].line;
}

const SEG_COLOR: Record<SegKind, string> = {
  rapid: "#93a1ad",
  round: "#b48ee0",
  rough: "#45b394",
  roughz: "#6ab0d8",
  copy: "#a3c15c",
  face: "#e3a94e",
  finish: "#e0703c",
  offset: "#f59a80",
  bore: "#4cc9f0",
  boreoff: "#c77dff",
  borefin: "#f72585",
  bottom: "#ffd166",
};

type LayerKey =
  | "showRough"
  | "showFinish"
  | "showOffset"
  | "showInnerRough"
  | "showInnerOffset"
  | "showInnerFinish"
  | "showRound"
  | "showFace"
  | "showBottom"
  | "showRapids"
  | "showGhost";

const CHIPS: { key: LayerKey; label: string; color: string }[] = [
  { key: "showRound", label: "گرد کردن", color: "#b48ee0" },
  { key: "showRough", label: "مسیر خشن", color: "#45b394" },
  { key: "showInnerRough", label: "خشن داخل (کاسه)", color: "#4cc9f0" },
  { key: "showOffset", label: "آفست", color: "#f59a80" },
  { key: "showInnerOffset", label: "آفست داخل‌تراشی", color: "#c77dff" },
  { key: "showFinish", label: "پرداخت", color: "#e0703c" },
  { key: "showInnerFinish", label: "پرداخت داخل", color: "#f72585" },
  { key: "showFace", label: "پیشانی", color: "#e3a94e" },
  { key: "showBottom", label: "کف‌تراشی", color: "#ffd166" },
  { key: "showRapids", label: "حرکت سریع", color: "#93a1ad" },
  { key: "showGhost", label: "سایه طرح", color: "#c9955a" },
];
const TOOLPATH_LAYER_KEYS = CHIPS.filter((chip) => chip.key !== "showGhost").map((chip) => chip.key);

/* منوی کرکره‌ای لایه‌های نمایش — جایگزین نوار چیپ‌های افقی */
function LayerMenu({ settings, onSettings }: { settings: EdSettings; onSettings: (p: Partial<EdSettings>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const activeN = CHIPS.filter((c) => settings[c.key]).length;
  const allLayersOff = activeN === 0;
  const opacity = Math.min(1, Math.max(0.1, settings.layerOpacity));
  const toggleAllLayers = () => {
    const next = allLayersOff;
    const patch: Partial<EdSettings> = {};
    for (const chip of CHIPS) Object.assign(patch, { [chip.key]: next });
    onSettings(patch);
  };
  return (
    <div ref={ref} className="anim-in relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="لایه‌های نمایش مسیرها روی بوم"
        className="chip-toggle border-edge bg-panel/85 text-ink backdrop-blur-sm transition-all hover:border-edge2"
      >
        <IconLayers className="h-3.5 w-3.5 text-brass" />
        لایه‌ها
        <span className={cn("rounded-full border px-1 font-mono text-[9px] font-bold", activeN === CHIPS.length ? "border-teal/50 text-teal" : "border-edge2 text-mute")}>
          {activeN}/{CHIPS.length}
        </span>
        <svg
          viewBox="0 0 12 12"
          className={cn("h-2 w-2 text-dim transition-transform", open && "-rotate-180")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] right-0 max-h-[calc(100vh-100px)] w-64 overflow-y-auto rounded-lg border border-edge bg-panel/95 p-1.5 shadow-xl shadow-black/50 backdrop-blur">
          <div className="px-2 pt-0.5 pb-1 text-[10px] font-bold text-dim">نمایش مسیرهای عملیات روی بوم</div>
          <div className="mb-1.5 rounded-md border border-edge bg-bg/45 p-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={toggleAllLayers}
                className={cn(
                  "rounded-md border px-2 py-1 text-[10px] font-bold transition-colors",
                  allLayersOff
                    ? "border-teal/50 bg-teal/10 text-teal hover:bg-teal/20"
                    : "border-danger/40 bg-danger/8 text-danger/90 hover:bg-danger/15"
                )}
              >
                {allLayersOff ? "روشن کردن همه" : "خاموش کردن همه"}
              </button>
              <span className="font-mono text-[9px] text-mute" dir="ltr">{Math.round(opacity * 100)}%</span>
            </div>
            <label className="mt-1.5 flex items-center gap-2 text-[9.5px] text-dim">
              <span className="shrink-0">کمرنگ</span>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={Math.round(opacity * 100)}
                onChange={(e) => onSettings({ layerOpacity: Number(e.target.value) / 100 })}
                className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[#e3a94e]"
                aria-label="شدت نمایش لایه‌ها"
              />
              <span className="shrink-0">پررنگ</span>
            </label>
            {allLayersOff && (
              <p className="mt-1.5 rounded border border-teal/25 bg-teal/8 px-1.5 py-1 text-[8.5px] leading-4 text-teal">
                حالت سبک فعال است؛ مسیرها هنگام ترسیم/درگ محاسبه و رندر زنده نمی‌شوند.
              </p>
            )}
          </div>
          {CHIPS.map((c) => (
            <button
              key={c.key}
              onClick={() => onSettings({ [c.key]: !settings[c.key] } as Partial<EdSettings>)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-right text-[11.5px] transition-colors hover:bg-panel3"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color, opacity: settings[c.key] ? 1 : 0.25 }} />
              <span className={cn("flex-1 truncate", settings[c.key] ? "text-ink/85" : "text-dim")}>{c.label}</span>
              {settings[c.key] ? (
                <IconCheck className="h-3.5 w-3.5 shrink-0 text-teal" />
              ) : (
                <span className="h-3 w-3 shrink-0 rounded-[4px] border border-edge2" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* کلید دو‌بخشی گریدِ حالت Edit: کلیک روی آیکن نمایش را عوض می‌کند و فلش
   کوچک فقط تنظیمات فاصلهٔ خطوط اصلی/تقسیمات داخلی را باز می‌کند. */
function EditGridControl({
  settings,
  onSettings,
}: {
  settings: EdSettings;
  onSettings: (patch: Partial<EdSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const main = Math.min(500, Math.max(1, settings.editGridSize));
  const divisions = Math.min(20, Math.max(1, Math.round(settings.editGridDivisions)));
  const minor = main / divisions;
  const setNumber = (key: "editGridSize" | "editGridDivisions", raw: string) => {
    const n = Number(latinDigits(raw));
    if (!Number.isFinite(n)) return;
    if (key === "editGridSize") onSettings({ editGridSize: Math.min(500, Math.max(1, Math.round(n * 100) / 100)) });
    else onSettings({ editGridDivisions: Math.min(20, Math.max(1, Math.round(n))) });
  };

  return (
    <div ref={ref} className="relative flex overflow-visible rounded-lg border border-edge bg-panel/85 shadow-lg shadow-black/20 backdrop-blur-sm">
      <button
        type="button"
        role="switch"
        aria-checked={settings.editGridVisible}
        onClick={() => onSettings({ editGridVisible: !settings.editGridVisible })}
        title={settings.editGridVisible ? "پنهان‌کردن گرید و حفظ محورها" : "نمایش گرید و تقسیمات"}
        className={cn(
          "flex h-[30px] items-center gap-1.5 rounded-r-[7px] px-2 text-[10.5px] font-bold transition-colors",
          settings.editGridVisible ? "bg-teal/12 text-teal" : "text-dim hover:bg-panel3 hover:text-ink"
        )}
      >
        <IconGrid className="h-3.5 w-3.5" />
        گرید
      </button>
      <button
        type="button"
        aria-label="تنظیمات گرید"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="اندازه گرید اصلی و تعداد تقسیمات داخلی"
        className={cn(
          "grid h-[30px] w-6 place-items-center rounded-l-[7px] border-r border-edge transition-colors",
          open ? "bg-brass/15 text-brass2" : "text-dim hover:bg-panel3 hover:text-ink"
        )}
      >
        <svg viewBox="0 0 12 12" className={cn("h-2.5 w-2.5 transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="anim-in absolute top-[calc(100%+6px)] right-0 z-40 w-60 rounded-lg border border-edge2 bg-panel/97 p-2.5 text-right shadow-2xl shadow-black/60 backdrop-blur-sm">
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-md border border-teal/35 bg-teal/10 text-teal">
              <IconGrid className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-bold text-ink">تنظیمات گرید مسیر</div>
              <div className="text-[8.5px] text-dim">واحد همه اندازه‌ها میلی‌متر است</div>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 flex items-center justify-between text-[9.5px] font-semibold text-mute">
              اندازه گرید اصلی
              <span className="font-mono text-[8.5px] text-teal" dir="ltr">{Number(main.toFixed(2))} mm</span>
            </span>
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={main}
              onChange={(e) => setNumber("editGridSize", e.target.value)}
              className="field-input !py-1.5 font-mono !text-[11px]"
              dir="ltr"
            />
          </label>

          <label className="mt-2 block">
            <span className="mb-1 flex items-center justify-between text-[9.5px] font-semibold text-mute">
              تقسیم‌بندی داخل هر گرید
              <span className="font-mono text-[8.5px] text-brass2" dir="ltr">{divisions} ×</span>
            </span>
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              value={divisions}
              onChange={(e) => setNumber("editGridDivisions", e.target.value)}
              className="field-input !py-1.5 font-mono !text-[11px]"
              dir="ltr"
            />
          </label>

          <div className="mt-2 rounded-md border border-edge bg-[#08111f] p-2">
            <div className="relative h-12 overflow-hidden rounded border border-[#263548]">
              <div className="absolute inset-0" style={{
                backgroundImage: `linear-gradient(to right, rgba(31,45,63,.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(31,45,63,.6) 1px, transparent 1px)`,
                backgroundSize: `${100 / divisions}% ${100 / divisions}%`,
              }} />
              <div className="absolute inset-0 border border-[#3f4f65]/70" />
            </div>
            <div className="mt-1 flex items-center justify-between text-[8.5px] text-dim">
              <span>فاصله خطوط داخلی</span>
              <span className="font-mono text-brass2" dir="ltr">{Number(minor.toFixed(3))} mm</span>
            </div>
          </div>
          <p className="mt-1.5 text-[8.5px] leading-4 text-dim">
            خاموش‌کردن گرید، محورهای X/Y را پنهان نمی‌کند؛ تقاطع دو محور همان مبدأ است.
          </p>
        </div>
      )}
    </div>
  );
}

const KIND_VISIBLE: Record<SegKind, LayerKey> = {
  rapid: "showRapids",
  round: "showRound",
  rough: "showRough",
  roughz: "showRough",
  copy: "showRough",
  face: "showFace",
  finish: "showFinish",
  offset: "showOffset",
  bore: "showInnerRough",
  boreoff: "showInnerOffset",
  borefin: "showInnerFinish",
  bottom: "showBottom",
};

const SNAP_STEPS = [1, 0.5, 5, 0];
const SNAP_COLOR: Record<string, string> = {
  end: "#45b394",
  mid: "#e3a94e",
  center: "#b48ee0",
  ctrl: "#6ab0d8",
  cross: "#e0703c",
  axis: "#f3c26b",
  grid: "#8b7c5f",
};

type SketchPointPart = "a" | "b" | "c1" | "c2" | "via";

const segInsideStock = (seg: SketchSeg, blankL: number, blankR: number): boolean => {
  const b = segBounds(seg);
  const eps = 1e-7;
  return (
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxZ) &&
    Number.isFinite(b.minR) &&
    Number.isFinite(b.maxR) &&
    b.minZ >= -eps &&
    b.maxZ <= blankL + eps &&
    b.minR >= -eps &&
    b.maxR <= blankR + eps
  );
};

const withSegPoint = (seg: SketchSeg, part: SketchPointPart, point: SPoint): SketchSeg =>
  ({ ...seg, [part]: point }) as SketchSeg;

/**
 * نقطهٔ کنترل می‌تواند بیرون خام قرار بگیرد، اما جابه‌جایی در نخستین جایی که
 * خود منحنی به مرز خام می‌رسد متوقف می‌شود. نقاط واقعی خط/کمان همچنان مستقیماً
 * به ابعاد خام محدودند.
 */
const constrainSegPointToStock = (
  seg: SketchSeg,
  part: SketchPointPart,
  requested: SPoint,
  blankL: number,
  blankR: number
): SPoint => {
  const current = seg[part];
  if (!current) return requested;
  const isBezierControl = part === "c1" || part === "c2";
  const target = isBezierControl
    ? requested
    : {
        z: Math.min(blankL, Math.max(0, requested.z)),
        r: Math.min(blankR, Math.max(0, requested.r)),
      };

  if (segInsideStock(withSegPoint(seg, part, target), blankL, blankR)) return target;
  /* دادهٔ قدیمیِ نامعتبر را بدتر نکن؛ ولی اگر مقصد معتبر بود، شرط بالا آن را پذیرفته است. */
  if (!segInsideStock(seg, blankL, blankR)) return current;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    const p = {
      z: current.z + (target.z - current.z) * t,
      r: current.r + (target.r - current.r) * t,
    };
    if (segInsideStock(withSegPoint(seg, part, p), blankL, blankR)) lo = t;
    else hi = t;
  }
  return {
    z: current.z + (target.z - current.z) * lo,
    r: current.r + (target.r - current.r) * lo,
  };
};

/* پس از حذف در Edit Path نزدیک‌ترین خط باقی‌مانده به محل حذف انتخاب می‌شود. */
function replacementEditLine(original: ELine[], remaining: ELine[], affected: Set<number>): number | null {
  if (!remaining.length) return null;
  const remainingIds = new Set(remaining.map((line) => line.id));
  const indices = original.map((line, index) => affected.has(line.id) ? index : -1).filter((index) => index >= 0);
  const pivot = indices.length ? Math.min(...indices) : 0;
  for (let distance = 0; distance < original.length; distance++) {
    const after = pivot + distance;
    if (after < original.length && remainingIds.has(original[after].id)) return original[after].id;
    const before = pivot - 1 - distance;
    if (before >= 0 && remainingIds.has(original[before].id)) return original[before].id;
  }
  return remaining[0].id;
}

type FilletPick = { id: number; click: SPoint };
type FilletResult = { first: SketchSeg; second: SketchSeg; arc: SketchSeg };

/** Fillet دقیق دو پاره‌خط: محل کلیک، شاخه‌ای را که باید باقی بماند تعیین می‌کند. */
function buildLineFillet(a: SketchSeg, b: SketchSeg, pickA: SPoint, pickB: SPoint, radius: number, blankL: number, blankR: number): { result?: FilletResult; error?: string; maxRadius?: number } {
  if (a.kind !== "line" || b.kind !== "line" || a.id === b.id) return { error: "دو خط متفاوت انتخاب کنید" };
  if (!(radius > 0) || !Number.isFinite(radius)) return { error: "شعاع باید بزرگ‌تر از صفر باشد" };
  const ad = { z: a.b.z - a.a.z, r: a.b.r - a.a.r };
  const bd = { z: b.b.z - b.a.z, r: b.b.r - b.a.r };
  const cross = ad.z * bd.r - ad.r * bd.z;
  if (Math.abs(cross) < 1e-9) return { error: "خطوط موازی یا منطبق هستند" };
  const q = { z: b.a.z - a.a.z, r: b.a.r - a.a.r };
  const ta = (q.z * bd.r - q.r * bd.z) / cross;
  const intersection = { z: a.a.z + ad.z * ta, r: a.a.r + ad.r * ta };
  const unitToward = (line: SketchSeg, click: SPoint) => {
    const d = { z: line.b.z - line.a.z, r: line.b.r - line.a.r };
    const len = Math.hypot(d.z, d.r);
    const u = { z: d.z / len, r: d.r / len };
    const sign = (click.z - intersection.z) * u.z + (click.r - intersection.r) * u.r >= 0 ? 1 : -1;
    return { z: u.z * sign, r: u.r * sign };
  };
  const u1 = unitToward(a, pickA), u2 = unitToward(b, pickB);
  const dot = Math.max(-1, Math.min(1, u1.z * u2.z + u1.r * u2.r));
  const theta = Math.acos(dot);
  if (theta < 1e-5 || Math.PI - theta < 1e-5) return { error: "زاویه خطوط برای Fillet معتبر نیست" };
  const tanHalf = Math.tan(theta / 2);
  const tangentDistance = radius / tanHalf;
  const available = (line: SketchSeg, u: SPoint) => Math.max(
    (line.a.z - intersection.z) * u.z + (line.a.r - intersection.r) * u.r,
    (line.b.z - intersection.z) * u.z + (line.b.r - intersection.r) * u.r,
  );
  const availA = available(a, u1), availB = available(b, u2);
  const maxRadius = Math.max(0, Math.min(availA, availB) * tanHalf);
  /* نقطه مماس مجاز است به سمت تقاطع خطوط برگردد. این حالت هنگام جایگزینی
     Fillet موجود با شعاع کوچک‌تر ضروری است، چون دو خط قبلاً تا نقاط مماس
     شعاع بزرگ‌تر کوتاه شده‌اند و باید دوباره به سمت گوشه امتداد یابند. */
  if (tangentDistance > availA + 1e-7 || tangentDistance > availB + 1e-7 || maxRadius <= 1e-7) {
    return { error: `شعاع نامعتبر — حداکثر ${Math.max(0, maxRadius).toFixed(2)}`, maxRadius };
  }
  const t1 = { z: intersection.z + u1.z * tangentDistance, r: intersection.r + u1.r * tangentDistance };
  const t2 = { z: intersection.z + u2.z * tangentDistance, r: intersection.r + u2.r * tangentDistance };
  const bisector = { z: u1.z + u2.z, r: u1.r + u2.r };
  const bl = Math.hypot(bisector.z, bisector.r);
  const centerDistance = radius / Math.sin(theta / 2);
  const center = { z: intersection.z + bisector.z / bl * centerDistance, r: intersection.r + bisector.r / bl * centerDistance };
  const v1 = { z: t1.z - center.z, r: t1.r - center.r }, v2 = { z: t2.z - center.z, r: t2.r - center.r };
  const vm = { z: v1.z + v2.z, r: v1.r + v2.r };
  const vl = Math.hypot(vm.z, vm.r);
  const via = { z: center.z + vm.z / vl * radius, r: center.r + vm.r / vl * radius };
  const trim = (line: SketchSeg, tangent: SPoint, u: SPoint) => {
    const pa = (line.a.z - intersection.z) * u.z + (line.a.r - intersection.r) * u.r;
    const pb = (line.b.z - intersection.z) * u.z + (line.b.r - intersection.r) * u.r;
    return pa >= pb ? { ...line, b: tangent } : { ...line, a: tangent };
  };
  const result = { first: trim(a, t1, u1), second: trim(b, t2, u2), arc: { id: -999999, kind: "arc" as const, a: t1, b: t2, via } };
  if (!segInsideStock(result.first, blankL, blankR) || !segInsideStock(result.second, blankL, blankR) || !segInsideStock(result.arc, blankL, blankR)) {
    return { error: "قوس از محدوده خام خارج می‌شود", maxRadius };
  }
  return { result, maxRadius };
}

/** Evaluates a deliberately small arithmetic grammar; no eval/Function is used. */
function arithmeticValue(source: string): number | null {
  const text = latinDigits(source).replace(/\s+/g, "");
  if (!text) return null;
  let i = 0;
  const expression = (): number => {
    let value = term();
    while (text[i] === "+" || text[i] === "-") { const op = text[i++]; const rhs = term(); value = op === "+" ? value + rhs : value - rhs; }
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (text[i] === "*" || text[i] === "/") { const op = text[i++]; const rhs = factor(); if (op === "/" && Math.abs(rhs) < 1e-14) throw Error(); value = op === "*" ? value * rhs : value / rhs; }
    return value;
  };
  const factor = (): number => {
    if (text[i] === "+" || text[i] === "-") { const sign = text[i++] === "-" ? -1 : 1; return sign * factor(); }
    if (text[i] === "(") { i++; const value = expression(); if (text[i++] !== ")") throw Error(); return value; }
    const match = text.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw Error(); i += match[0].length; return Number(match[0]);
  };
  try { const value = expression(); return i === text.length && Number.isFinite(value) ? Math.round(value * 1e12) / 1e12 : null; } catch { return null; }
}

type MoveAxis = "free" | "x" | "y";
type MoveSession = {
  ids: number[]; base: SketchSeg[]; origin: SPoint; clientX: number; clientY: number;
  pointer: SPoint; axis: MoveAxis; mode: "relative" | "absolute";
  dirX: 1 | -1; dirY: 1 | -1;
  lastClientX: number; lastClientY: number;
  editBase?: EVert[]; editVertexIds?: number[];
};

export default function ProfileEditor({
  segs,
  onSegs,
  selected,
  onSelected,
  params,
  gen,
  split,
  onSplit,
  settings,
  onSettings,
  ops,
  isolatedOpId,
  onClearIsolate,
  onActiveGCodeLine,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  edit,
  editChanges,
  onEditToggle,
  onEditBuf,
  onEditConfirm,
  onEditCancel,
  onEditDiscard,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Cam | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const previousToolRef = useRef<Tool>("select");
  const chooseTool = (next: Tool) => {
    if (next === toolRef.current) return;
    previousToolRef.current = toolRef.current;
    toolRef.current = next;
    setTool(next);
  };
  const [filletPicks, setFilletPicks] = useState<FilletPick[]>([]);
  const [filletBox, setFilletBox] = useState<{ x: number; y: number; value: string; error: string } | null>(null);
  const filletInputRef = useRef<HTMLInputElement>(null);
  const [moveBox, setMoveBox] = useState<{ x: number; y: number; value: string; error: string } | null>(null);
  const [moveSession, setMoveSession] = useState<MoveSession | null>(null);
  const moveInputRef = useRef<HTMLInputElement>(null);
  const [lastMove, setLastMove] = useState<{ dz: number; dr: number } | null>(null);
  useEffect(() => { if (filletBox) requestAnimationFrame(() => { filletInputRef.current?.focus(); filletInputRef.current?.select(); }); }, [!!filletBox]);
  useEffect(() => { if (moveBox) requestAnimationFrame(() => { moveInputRef.current?.focus(); moveInputRef.current?.select(); }); }, [!!moveBox]);
  useEffect(() => {
    const releaseAxis = (event: KeyboardEvent) => {
      if (event.key === "Shift") setMoveSession((session) => session ? { ...session, axis: "free" } : session);
    };
    window.addEventListener("keyup", releaseAxis);
    return () => window.removeEventListener("keyup", releaseAxis);
  }, []);
  /* پیش‌نمایش عددی بدون ثبت در تاریخچه؛ Enter همان هندسه را به یک گام Undo تبدیل می‌کند. */
  useEffect(() => {
    if (!moveBox?.value.trim() || !moveSession) return;
    const parts = moveBox.value.split(",");
    const values = parts.map(arithmeticValue);
    if (parts.length > 2 || values.some((v) => v == null)) return;
    const dx = moveSession.pointer.z - moveSession.origin.z, dy = moveSession.pointer.r - moveSession.origin.r;
    let dz = 0, dr = 0;
    if (values.length === 2) { dz = values[0]!; dr = values[1]!; }
    else {
      const amount = values[0]!;
      if (moveSession.axis === "x") dz = amount * moveSession.dirX;
      else if (moveSession.axis === "y") dr = amount * moveSession.dirY;
      else {
        /* مقدار تکی شعاع حرکت است، نه قفل مختصات: نشانگر جهت را تعیین می‌کند
           و نقطه/خط آزادانه روی دایره‌ای با همین شعاع حرکت می‌کند. */
        const length = Math.hypot(dx, dy);
        if (length > 1e-9) { dz = amount * dx / length; dr = amount * dy / length; }
        else { dz = amount * moveSession.dirX; dr = 0; }
      }
    }
    if (moveSession.mode === "absolute") {
      const editAnchor = moveSession.editBase?.find((v) => moveSession.editVertexIds?.includes(v.id));
      const sketchAnchor = moveSession.base.find((s) => moveSession.ids.includes(s.id))?.a;
      const anchor = editAnchor ? { z: editAnchor.z, r: editAnchor.x / 2 } : sketchAnchor!;
      if (values.length === 2) { dz -= anchor.z; dr -= anchor.r; }
      else if (dz) dz = Math.abs(dz) - anchor.z; else dr = Math.abs(dr) - anchor.r;
    }
    if (moveSession.editBase && moveSession.editVertexIds && edit) {
      const moving = new Set(moveSession.editVertexIds);
      onEditBuf({
        ...edit,
        verts: moveSession.editBase.map((vertex) => moving.has(vertex.id)
          ? { ...vertex, z: vertex.z + dz, x: vertex.x + 2 * dr }
          : vertex),
      }, false);
    } else {
      onSegs(moveSession.base.map((segment) => moveSession.ids.includes(segment.id) ? moveSeg(segment, dz, dr) : segment), false);
    }
  }, [moveBox?.value, moveSession?.pointer, moveSession?.axis, moveSession?.mode]);
  const [draft, setDraft] = useState<SPoint[]>([]);
  /* در منحنی کنترلی، پس از کلیک دوم ابتدا دستهٔ متصل به نقطهٔ پایان (c2) و سپس  */
  /* دستهٔ متصل به نقطهٔ شروع (c1) تنظیم می‌شود — مانند ابزار Pen.                */
  const draftSecondSet = useRef(false); // آیا دستهٔ دوم (c2) ثبت شده است؟
  const cancelDraft = () => {
    draftSecondSet.current = false;
    setDraft([]);
  };
  const [cursor, setCursor] = useState<SPoint | null>(null);
  const [snapHit, setSnapHit] = useState<SnapPoint | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  /* نقطه Split یک موجودیت مستقل است: با کلیک انتخاب و با Delete/سطل حذف می‌شود. */
  const [splitSelected, setSplitSelected] = useState(false);
  const [splitHovered, setSplitHovered] = useState(false);

  /* ---------- حالت ویرایش مسیر — ویرایشگرِ پلی‌لاینِ پیوسته (مثل بک‌پلات سیمکو) ---------- */
  const editOpen = !!edit;
  const toolpathLayersVisible = TOOLPATH_LAYER_KEYS.some((key) => settings[key]);
  const layerOpacity = Math.min(1, Math.max(0.1, settings.layerOpacity));
  /* فقط تغییر روشن/خاموشی مسیرها هندسهٔ SVG را بازسازی می‌کند؛ اسلایدر شفافیت
     نباید روی برنامه‌های چند هزارخطی useMemo سنگین را دوباره اجرا کند. */
  const layerVisibilityKey = TOOLPATH_LAYER_KEYS.map((key) => settings[key] ? "1" : "0").join("");
  const [selL, setSelL] = useState<number[]>([]); // خطوط انتخابی
  const [activeLine, setActiveLine] = useState<number | null>(null); // مبنای پیمایش Arrow
  const [selV, setSelV] = useState<number[]>([]); // رأس‌های انتخابی (نقاط مشترک)
  const [showPathPoints, setShowPathPoints] = useState(true);
  const [showPathBySpeed, setShowPathBySpeed] = useState(false);
  const [speedMenu, setSpeedMenu] = useState<{ x: number; y: number } | null>(null);
  const [manualSpeed, setManualSpeed] = useState("");
  const [speedError, setSpeedError] = useState("");
  const [shiftDown, setShiftDown] = useState(false);
  const shiftRef = useRef(false);
  const [selOff, setSelOff] = useState<number[]>([]); // منحنی‌های افست انتخابی
  const [hoverBuf, setHoverBuf] = useState<number | null>(null);
  const [hoverPathEndpoint, setHoverPathEndpoint] = useState<number | null>(null);
  const [bufMarq, setBufMarq] = useState<{ ids: number[]; vxs: number[] } | null>(null);
  const [hitPicker, setHitPicker] = useState<{ x: number; y: number; lines: number[]; verts: number[] } | null>(null);
  const [pickerHover, setPickerHover] = useState<{ kind: "line" | "vert"; id: number } | null>(null);

  const focusEditLineInGCode = (lineId: number | null) => {
    if (!edit || lineId == null) {
      onActiveGCodeLine(-1);
      return;
    }
    const index = editLineGCodeIndex(lineId, edit.lines, gen);
    onActiveGCodeLine(index >= 0 && index < gen.lines.length ? index : -1);
  };
  const focusEditVertexInGCode = (vertexId: number) => {
    if (!edit) return;
    /* بلوکی که به نقطه می‌رسد بر بلوک خروجی اولویت دارد. */
    let owner: ELine | undefined;
    for (let i = edit.lines.length - 1; i >= 0; i--) {
      if (edit.lines[i].vb === vertexId) { owner = edit.lines[i]; break; }
    }
    owner ??= edit.lines.find((line) => line.va === vertexId);
    focusEditLineInGCode(owner?.id ?? null);
  };

  /* انتخاب Segment در خود EditBuf نگه‌داری می‌شود تا بخشی از تاریخچه اصلی باشد. */
  const selectEditLines = (ids: number[], requestedActive: number | null, record = true) => {
    const ordered = edit ? edit.lines
      .filter((l) => ids.includes(l.id) && (isolatedOpId == null || l.opId === isolatedOpId))
      .map((l) => l.id) : [];
    const active = requestedActive != null && ordered.includes(requestedActive)
      ? requestedActive
      : ordered[ordered.length - 1] ?? null;
    setSelL(ordered);
    setActiveLine(active);
    focusEditLineInGCode(active);
    if (!edit) return;
    const stored = edit.selLines ?? [];
    if ((edit.activeLine ?? null) === active && stored.length === ordered.length && stored.every((id, i) => id === ordered[i])) return;
    onEditBuf({ ...edit, selLines: ordered, activeLine: active }, record);
  };

  /* Undo/Redo ممکن است یک EditBuf قدیمی را برگرداند؛ انتخاب محلی باید همگام شود. */
  useEffect(() => {
    if (!edit) return;
    setSelL(edit.selLines ?? []);
    setActiveLine(edit.activeLine ?? null);
  }, [edit?.selLines, edit?.activeLine]);

  /* Undo/Redo یا بازتولید جی‌کد نیز باید هایلایت پنجرهٔ متن را با انتخاب نگه دارد؛
     اگر نقطه‌ای انتخاب است، خطِ ورودیِ همان نقطه بر activeLine قبلی اولویت دارد. */
  useEffect(() => {
    if (!editOpen || !edit) return;
    let lineId = edit.activeLine ?? null;
    const vertexId = selV[selV.length - 1];
    if (vertexId != null) {
      const incoming = [...edit.lines].reverse().find((line) => line.vb === vertexId);
      lineId = (incoming ?? edit.lines.find((line) => line.va === vertexId))?.id ?? lineId;
    }
    if (lineId == null) return;
    const index = editLineGCodeIndex(lineId, edit.lines, gen);
    onActiveGCodeLine(index >= 0 && index < gen.lines.length ? index : -1);
  }, [editOpen, edit?.activeLine, edit?.lines, selV, gen.segs, gen.lines.length, onActiveGCodeLine]);

  useEffect(() => {
    if (editOpen) {
      /* ابزارهای ترسیم پروفایل در ویرایش مسیر مجاز نیستند. */
      setTool("select");
      setDraft([]);
      setCursor(null);
      setSnapHit(null);
      onSelected([]);
      setSelPoints([]);
      setSplitSelected(false);
      setSplitHovered(false);
      setMarqueeSplitHit(false);
      return;
    }
    setSelL([]);
    setActiveLine(null);
    setSelV([]);
    setSelOff([]);
    setHoverBuf(null);
    setHoverPathEndpoint(null);
    setBufMarq(null);
    setHitPicker(null);
    setPickerHover(null);
    setSpeedMenu(null);
  }, [editOpen]);
  useEffect(() => {
    if (toolpathLayersVisible) return;
    /* با خاموشی کامل مسیرها هیچ انتخاب/hover پنهانی باقی نمی‌ماند؛ بنابراین
       pointermove و pan به پیمایش هزاران خط وارد نمی‌شوند. */
    setSelL([]);
    setActiveLine(null);
    setSelV([]);
    setSelOff([]);
    setHoverBuf(null);
    setHoverPathEndpoint(null);
    setBufMarq(null);
    setHitPicker(null);
    setPickerHover(null);
    setSpeedMenu(null);
  }, [toolpathLayersVisible]);
  useEffect(() => {
    if (split.enabled) return;
    setSplitSelected(false);
    setSplitHovered(false);
  }, [split.enabled]);
  useEffect(() => {
    if (tool !== "fillet") { setFilletPicks([]); setFilletBox(null); }
  }, [tool]);
  useEffect(() => {
    if (tool !== "select") {
      setSplitSelected(false);
      setSplitHovered(false);
    }
  }, [tool]);
  /* نقاط جداشده (unjoined) — به‌صورت پیش‌فرض همهٔ نقاطِ هم‌مکان متصل‌اند */
  const [separated, setSeparated] = useState<Set<string>>(new Set());
  /* منوی راست‌کلیک برای اتصال/جداسازی نقطه */
  const [splitCtxMenu, setSplitCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    segId: number;
    part: "a" | "b";
    separated: boolean;
    clusterSize: number;
  } | null>(null);
  /* انتخاب مستقل نقاط (جدا از انتخاب المان) */
  const [selPoints, setSelPoints] = useState<{ segId: number; part: "a" | "b" | "c1" | "c2" | "via" }[]>([]);
  /* انتخاب باکسی (باکس انتخابگر) */
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    add: boolean;
    remove: boolean;
  } | null>(null);
  const [marqueeHits, setMarqueeHits] = useState<number[]>([]);
  /* نقاط نامزدِ داخل باکس انتخاب */
  const [marqueePointHits, setMarqueePointHits] = useState<{ segId: number; part: "a" | "b" | "via" | "c1" | "c2" }[]>([]);
  const [marqueeSplitHit, setMarqueeSplitHit] = useState(false);
  const [panMode, setPanMode] = useState(false);
  /* فیلتر نوع المان برای انتخاب (همه روشن = بدون فیلتر) */
  const [selFilter, setSelFilter] = useState<Record<SketchKind, boolean>>({
    line: true,
    quad: true,
    cubic: true,
    arc: true,
  });
  const camRef = useRef(cam);
  camRef.current = cam;

  const L = params.blankL;
  const R = params.blankD / 2;

  const handleKey = (segId: number, part: "a" | "b") => `${segId}:${part}`;

  const screenPt = (c: Cam, z: number, r: number): [number, number] => [c.ox + z * c.s, c.oy - r * c.s];
  const worldPt = (c: Cam, sx: number, sy: number): SPoint => ({ z: (sx - c.ox) / c.s, r: (c.oy - sy) / c.s });

  const fit = (w: number, h: number): Cam => {
    const pad = 60;
    const s = Math.min((w - pad * 2) / L, (h - pad * 2) / params.blankD);
    return { s, ox: (w - L * s) / 2, oy: h / 2 };
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      if (r.width > 40 && r.height > 40) setCam((c) => c ?? fit(r.width, r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, params.blankD]);

  /* زوم با چرخ ماوس */
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !cam || size.w === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      setCam((c) => {
        if (!c) return c;
        const k = e.deltaY < 0 ? 1.16 : 1 / 1.16;
        const ns = Math.min(90, Math.max(0.35, c.s * k));
        const wa = (sx - c.ox) / c.s;
        const wb = (c.oy - sy) / c.s;
        return { s: ns, ox: sx - wa * ns, oy: sy + wb * ns };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [cam, size.w, size.h]);

  /* میانبرهای صفحه‌کلید */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA") return;

      /* ---------- حالت ویرایش مسیر: Esc اول انتخاب، بعد خروج ---------- */
      if (editOpen && e.key === "Escape") {
        if (selL.length || selV.length || selOff.length) {
          e.preventDefault();
          if (selL.length) selectEditLines([], null, true);
          else { setSelL([]); setActiveLine(null); }
          setSelV([]);
          setSelOff([]);
          return;
        }
        if (!drag.current && !marquee) {
          e.preventDefault();
          onEditCancel();
          return;
        }
      }
      if (editOpen && edit && selL.length && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const active = activeLine != null && selL.includes(activeLine) ? activeLine : selL[selL.length - 1];
        const navigable = edit.lines.filter((line) => isolatedOpId == null || line.opId === isolatedOpId);
        const index = navigable.findIndex((line) => line.id === active);
        const nextIndex = index + (e.key === "ArrowLeft" ? -1 : 1);
        if (index >= 0 && nextIndex >= 0 && nextIndex < navigable.length) {
          const nextId = navigable[nextIndex].id;
          selectEditLines(e.shiftKey ? [...selL, nextId] : [nextId], nextId, true);
          setSelV([]);
        }
        return;
      }
      if (editOpen && (e.key === "Delete" || e.key === "Backspace") && edit) {
        if (selV.length) {
          e.preventDefault();
          const affected = new Set(edit.lines.filter((line) => selV.includes(line.va) || selV.includes(line.vb)).map((line) => line.id));
          const fin = deleteEditVertices(edit.verts, edit.lines, selV);
          const replacement = replacementEditLine(edit.lines, fin.lines, affected);
          if (fin.lines.length) onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, selLines: replacement == null ? [] : [replacement], activeLine: replacement }, true);
          setSelV([]); setSelL(replacement == null ? [] : [replacement]); setActiveLine(replacement);
          return;
        }
        if (selL.length) {
          e.preventDefault();
          const removed = new Set(selL);
          const fin = deleteEditLines(edit.verts, edit.lines, selL);
          const replacement = replacementEditLine(edit.lines, fin.lines, removed);
          if (fin.lines.length) onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, selLines: replacement == null ? [] : [replacement], activeLine: replacement }, true);
          setSelL(replacement == null ? [] : [replacement]); setActiveLine(replacement); setSelV([]);
          return;
        }
      }
      const k = e.key.toLowerCase();
      const undoKey = e.code === "KeyZ" || k === "z";
      const redoKey = e.code === "KeyY" || k === "y";
      if ((e.ctrlKey || e.metaKey) && undoKey && !e.shiftKey) {
        e.preventDefault();
        onUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (redoKey || (e.shiftKey && undoKey))) {
        e.preventDefault();
        onRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "a") {
        e.preventDefault();
        if (editOpen && edit) {
          const ids = edit.lines
            .filter((line) => isolatedOpId == null || line.opId === isolatedOpId)
            .map((line) => line.id);
          selectEditLines(ids, ids[ids.length - 1] ?? null, true);
          setSelV([]);
        } else selectAllEligible();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "i") {
        e.preventDefault();
        if (editOpen && edit) {
          const eligible = edit.lines
            .filter((line) => isolatedOpId == null || line.opId === isolatedOpId)
            .map((line) => line.id);
          const next = eligible.filter((id) => !selL.includes(id));
          selectEditLines(next, next[next.length - 1] ?? null, true);
          setSelV([]);
        } else invertSelection();
        return;
      }
      if (e.key === "Escape") {
        if (drag.current?.mode === "marquee") {
          drag.current = null;
          setMarquee(null);
          setMarqueeHits([]);
          setMarqueePointHits([]);
          setMarqueeSplitHit(false);
          return;
        }
        if (speedMenu) {
          setSpeedMenu(null);
          return;
        }
        if (ctxMenu) {
          setCtxMenu(null);
          return;
        }
        if (draft.length) cancelDraft();
        else if (isolatedOpId != null) onClearIsolate();
        else if (tool !== "select") chooseTool("select");
        else if (splitSelected) setSplitSelected(false);
        else {
          if (selPoints.length) setSelPoints([]);
          onSelected([]);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (splitSelected) {
          e.preventDefault();
          deleteSelectedSplit();
          return;
        }
        if (selPoints.length) {
          e.preventDefault();
          deleteSelectedPoints();
          return;
        }
        if (selected.length) {
          e.preventDefault();
          deleteSelected();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === "r" && tool === "move" && lastMove && selected.length) {
        e.preventDefault();
        const next = segs.map((s) => selected.includes(s.id) ? moveSeg(s, lastMove.dz, lastMove.dr) : s);
        onSegs(next, true);
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t && (!editOpen || t.id === "select")) {
        chooseTool(t.id);
        cancelDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, selected, tool, isolatedOpId, segs, selFilter, selPoints, splitSelected, split, editOpen, selL, activeLine, selV, selOff, edit, marquee, ctxMenu, speedMenu, lastMove]);

  /* وضعیت فیزیکی Shift برای پیش‌نمایش بازه؛ مستقل از زبان صفحه‌کلید. */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      shiftRef.current = true;
      setShiftDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      shiftRef.current = false;
      setShiftDown(false);
    };
    const blur = () => {
      shiftRef.current = false;
      setShiftDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  /* Space بین دو ابزار آخر سوییچ می‌کند؛ پن همچنان با دکمه وسط/راست در دسترس است. */
  useEffect(() => {
    const toggleLastTool = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA") return;
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      const previous = previousToolRef.current;
      if (editOpen && previous !== "select" && previous !== "move") return;
      chooseTool(previous);
      cancelDraft();
    };
    window.addEventListener("keydown", toggleLastTool);
    return () => window.removeEventListener("keydown", toggleLastTool);
  }, [editOpen]);

  /* ---------- اسنپ ---------- */
  const snapPts = useMemo(() => snapCandidates(segs), [segs]);
  const crossPts = useMemo(() => (settings.smartSnap ? intersectionPoints(segs) : []), [segs, settings.smartSnap]);

  const applySnap = (raw: SPoint, skipIds: number[] = []): { p: SPoint; hit: SnapPoint | null } => {
    const c = camRef.current;
    if (!c) return { p: raw, hit: null };
    const tolW = 11 / c.s; // ۱۱ پیکسل
    if (settings.smartSnap) {
      let best: SnapPoint | null = null;
      let bestD = tolW;
      for (const sp of [...snapPts, ...crossPts]) {
        if (sp.segId != null && skipIds.includes(sp.segId)) continue;
        const d = dist(sp.p, raw);
        if (d < bestD) {
          bestD = d;
          best = sp;
        }
      }
      if (best) return { p: { ...best.p }, hit: best };
      /* چسبیدن به محور دوران */
      if (Math.abs(raw.r) < tolW) return { p: { z: raw.z, r: 0 }, hit: { p: { z: raw.z, r: 0 }, type: "axis" } };
    }
    const g = settings.snap;
    if (g > 0) {
      const p = { z: Math.round(raw.z / g) * g, r: Math.round(raw.r / g) * g };
      return { p, hit: { p, type: "grid" } };
    }
    return { p: { z: Math.round(raw.z * 10) / 10, r: Math.round(raw.r * 10) / 10 }, hit: null };
  };

  const toWorld = (clientX: number, clientY: number): SPoint => {
    const el = svgRef.current!;
    const rect = el.getBoundingClientRect();
    return worldPt(camRef.current!, clientX - rect.left, clientY - rect.top);
  };

  const clampPt = (p: SPoint): SPoint => ({ z: Math.min(L, Math.max(0, p.z)), r: Math.min(R, Math.max(0, p.r)) });

  /** نقطهٔ نشانگرِ مرحلهٔ فعلی ترسیم؛ دسته‌های بزیه به خود خام clamp نمی‌شوند. */
  const constrainDraftPoint = (p: SPoint): SPoint => {
    if (tool === "quad" && draft.length === 2) {
      const base: SketchSeg = {
        id: -1,
        kind: "quad",
        a: draft[0],
        b: draft[1],
        c1: { z: (draft[0].z + draft[1].z) / 2, r: (draft[0].r + draft[1].r) / 2 },
      };
      return constrainSegPointToStock(base, "c1", p, L, R);
    }
    if (tool === "cubic" && draft.length === 4) {
      const base: SketchSeg = {
        id: -1,
        kind: "cubic",
        a: draft[0],
        b: draft[1],
        c1: draft[2],
        c2: draft[3],
      };
      return constrainSegPointToStock(base, draftSecondSet.current ? "c1" : "c2", p, L, R);
    }
    if (tool === "arc" && draft.length === 2) {
      const base: SketchSeg = {
        id: -1,
        kind: "arc",
        a: draft[0],
        b: draft[1],
        via: { z: (draft[0].z + draft[1].z) / 2, r: (draft[0].r + draft[1].r) / 2 },
      };
      return constrainSegPointToStock(base, "via", p, L, R);
    }
    return clampPt(p);
  };

  /* ---------- تشخیص برخورد ---------- */
  const hitSeg = (w: SPoint): SketchSeg | null => {
    const c = camRef.current;
    if (!c) return null;
    const tol = 7 / c.s;

    /* خط انتخاب‌شده در تمام محدوده hit خودش اولویت قطعی دارد. در غیر این صورت
       یک خط موازی/نزدیک که چند پیکسل نزدیک‌تر است به‌اشتباه جای آن drag می‌شد. */
    let selectedBest: SketchSeg | null = null;
    let selectedBestD = tol;
    for (const s of segs) {
      if (!selected.includes(s.id)) continue;
      const d = distToSeg(s, w);
      if (d < selectedBestD) {
        selectedBestD = d;
        selectedBest = s;
      }
    }
    if (selectedBest) return selectedBest;

    let best: SketchSeg | null = null;
    let bestD = tol;
    for (const s of segs) {
      /* فیلتر نوع: المان فیلترشده فقط اگر از قبل انتخاب باشد قابل لمس است (برای درگ گروهی) */
      if (!filterAllows(s.kind) && !selected.includes(s.id)) continue;
      const d = distToSeg(s, w);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };

  /* نزدیک‌ترین نقطه روی پروفیل (برای ابزار Split) */
  const nearestOnSeg = (s: SketchSeg, w: SPoint): { point: SPoint; t: number; distance: number } => {
    /* جست‌وجوی پارامتری باعث می‌شود وسط Line نیز واقعاً قابل انتخاب باشد؛ روش
       قبلی برای Line فقط دو سر را آزمایش می‌کرد. برای همه انواع منحنی نیز نقطه
       نهایی روی خود هندسه باقی می‌ماند. */
    if (s.kind === "line") {
      const dz = s.b.z - s.a.z, dr = s.b.r - s.a.r;
      const l2 = dz * dz + dr * dr;
      const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((w.z - s.a.z) * dz + (w.r - s.a.r) * dr) / l2)) : 0;
      const point = evalSeg(s, t);
      return { point, t, distance: dist(point, w) };
    }
    let bestT = 0, bestD = Infinity;
    const samples = 80;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples, d = dist(evalSeg(s, t), w);
      if (d < bestD) { bestD = d; bestT = t; }
    }
    let lo = Math.max(0, bestT - 1 / samples), hi = Math.min(1, bestT + 1 / samples);
    for (let i = 0; i < 18; i++) {
      const t1 = lo + (hi - lo) / 3, t2 = hi - (hi - lo) / 3;
      if (dist(evalSeg(s, t1), w) <= dist(evalSeg(s, t2), w)) hi = t2;
      else lo = t1;
    }
    const t = (lo + hi) / 2, point = evalSeg(s, t);
    return { point, t, distance: dist(point, w) };
  };

  const nearestOnSketch = (w: SPoint): SPoint | null => {
    let best: SPoint | null = null, bestD = Infinity;
    for (const s of segs) {
      const hit = nearestOnSeg(s, w);
      if (hit.distance < bestD) { bestD = hit.distance; best = hit.point; }
    }
    return best ? clampPt({ ...best }) : null;
  };

  /* سمت هر المان نسبت به نقطه Split (خارج/داخل) — برای رنگ‌آمیزی شاخه‌ها */
  const segSide = useMemo(() => {
    const m = new Map<number, "outer" | "inner">();
    if (!split.enabled || segs.length === 0) return m;
    const poly = chainPolyline(orderChain(segs));
    if (poly.length < 3) return m;
    const sp = splitChainAt(poly, { z: split.z, r: split.r });
    for (const s of segs) {
      const mid = segMid(s);
      let bi = 0;
      let bd = Infinity;
      poly.forEach((p, i) => {
        const d = dist(p, mid);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      m.set(s.id, bi <= sp.splitIndex ? "outer" : "inner");
    }
    return m;
  }, [segs, split]);

  type HandleRef = { segId: number; part: "a" | "b" | "c1" | "c2" | "via" };
  const hitHandle = (w: SPoint): HandleRef | null => {
    const c = camRef.current;
    if (!c) return null;
    const tol = 9 / c.s;
    let best: HandleRef | null = null;
    let bestD = tol;
    const check = (segId: number, part: HandleRef["part"], p?: SPoint) => {
      if (!p) return;
      const d = dist(p, w);
      if (d < bestD) {
        bestD = d;
        best = { segId, part };
      }
    };
    for (const s of segs) {
      const isSel = selected.includes(s.id);
      /* اگر حتی یک نقطهٔ المان مستقل انتخاب شده باشد، دسته‌های کنترلش قابل دسترسی‌اند */
      const hasSelPoint = selPointSegIds.includes(s.id);
      if (!filterAllows(s.kind) && !isSel && !hasSelPoint) continue;
      check(s.id, "a", s.a);
      check(s.id, "b", s.b);
      if (s.via) check(s.id, "via", s.via);
      if (isSel || hasSelPoint) {
        check(s.id, "c1", s.c1);
        check(s.id, "c2", s.c2);
      }
    }
    return best;
  };

  /*
   * خوشهٔ اتصال برای جابه‌جایی: نقاطی که باید هنگام کشیدنِ یک نقطه با هم حرکت کنند.
   * قانون: فقط نقاطی که **دقیقاً روی مختصات یکسانی** قرار دارند و **جداشده نشده‌اند**.
   * یعنی «اتصال» = همان مختصاتِ مشترک (Join)؛ اگر کاربر با راست‌کلیک نقطه را جدا
   * کند یا المان همسایه را جابه‌جا کند (تا دیگر هم‌مختصات نمانند)، از خوشه خارج می‌شود.
   */
  const clusterOf = (segId: number, part: "a" | "b"): { segId: number; part: "a" | "b" }[] => {
    if (separated.has(handleKey(segId, part))) return [{ segId, part }];
    const seg = segs.find((s) => s.id === segId);
    if (!seg) return [{ segId, part }];
    const origin = seg[part];
    const out: { segId: number; part: "a" | "b" }[] = [];
    for (const s of segs) {
      for (const pp of ["a", "b"] as const) {
        if (separated.has(handleKey(s.id, pp))) continue;
        if (s[pp].z === origin.z && s[pp].r === origin.r) out.push({ segId: s.id, part: pp });
      }
    }
    return out.length ? out : [{ segId, part }];
  };

  /*
   * قفل جابه‌جایی: المانی که حداقل یک سرش به المان دیگری خارج از گروهِ درگ متصل
   * باشد، نباید با کشیدن بدنه جابه‌جا شود تا اتصال پاره نشود. ویرایش نقاط و
   * دسته‌ها همچنان آزاد است. برای جابه‌جایی باید کل زنجیرهٔ متصل با هم انتخاب شود.
   */
  const endAttachedOutside = (segId: number, part: "a" | "b", allowed: number[]): boolean => {
    if (separated.has(handleKey(segId, part))) return false;
    const cluster = clusterOf(segId, part);
    return cluster.some((c) => c.segId !== segId && !allowed.includes(c.segId));
  };
  const segLocked = (segId: number, allowed: number[]): boolean =>
    endAttachedOutside(segId, "a", allowed) || endAttachedOutside(segId, "b", allowed);

  /* ---------- انتخاب ---------- */
  const filterAllows = (kind: SketchKind) => selFilter[kind];

  const pointInRectW = (p: SPoint, r: { z0: number; z1: number; r0: number; r1: number }) =>
    p.z >= r.z0 - 1e-9 && p.z <= r.z1 + 1e-9 && p.r >= r.r0 - 1e-9 && p.r <= r.r1 + 1e-9;

  const marqueeHitsSplit = (r: { z0: number; z1: number; r0: number; r1: number }) =>
    !editOpen && split.enabled && pointInRectW({ z: split.z, r: split.r }, r);

  const segSegInt = (p1: SPoint, p2: SPoint, p3: SPoint, p4: SPoint) => {
    const d = (p2.z - p1.z) * (p4.r - p3.r) - (p2.r - p1.r) * (p4.z - p3.z);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((p3.z - p1.z) * (p4.r - p3.r) - (p3.r - p1.r) * (p4.z - p3.z)) / d;
    const u = ((p3.z - p1.z) * (p2.r - p1.r) - (p3.r - p1.r) * (p2.z - p1.z)) / d;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
  };

  const segHitsRect = (s: SketchSeg, r: { z0: number; z1: number; r0: number; r1: number }, mode: "window" | "crossing") => {
    const poly = s.kind === "line" ? [s.a, s.b] : segPoints(s, 48);
    if (mode === "window") return poly.every((p) => pointInRectW(p, r));
    if (poly.some((p) => pointInRectW(p, r))) return true;
    const c = [
      { z: r.z0, r: r.r0 },
      { z: r.z1, r: r.r0 },
      { z: r.z1, r: r.r1 },
      { z: r.z0, r: r.r1 },
    ];
    for (let i = 0; i < poly.length - 1; i++) {
      for (let k = 0; k < 4; k++) {
        if (segSegInt(poly[i], poly[i + 1], c[k], c[(k + 1) % 4])) return true;
      }
    }
    return false;
  };

  const marqueeHitIds = (
    rectW: { z0: number; z1: number; r0: number; r1: number },
    mode: "window" | "crossing"
  ): number[] => {
    const out: number[] = [];
    for (const s of segs) {
      if (!filterAllows(s.kind)) continue;
      if (segHitsRect(s, rectW, mode)) out.push(s.id);
    }
    return out;
  };

  /* نقاط انتهایی، نقطهٔ کمان و دسته‌های کنترلِ داخل باکس.
     دسته‌های کنترل فقط برای المان‌هایی گزینش می‌شوند که فعال‌اند (نقطه‌شان قبلاً
     انتخاب شده یا خود المان انتخاب شده است). */
  const marqueeHitPoints = (
    rectW: { z0: number; z1: number; r0: number; r1: number }
  ): { segId: number; part: "a" | "b" | "via" | "c1" | "c2" }[] => {
    const out: { segId: number; part: "a" | "b" | "via" | "c1" | "c2" }[] = [];
    for (const s of segs) {
      if (!filterAllows(s.kind)) continue;
      for (const pp of ["a", "b", "via"] as const) {
        const pt = s[pp];
        if (pt && pointInRectW(pt, rectW)) out.push({ segId: s.id, part: pp });
      }
      if (selPointSegIds.includes(s.id) || selected.includes(s.id)) {
        for (const pp of ["c1", "c2"] as const) {
          const pt = s[pp];
          if (pt && pointInRectW(pt, rectW)) out.push({ segId: s.id, part: pp });
        }
      }
    }
    return out;
  };

  /* زنجیرهٔ متصل‌ها از روی اتصالات دقیق (برای دابل‌کلیک) */
  const chainIds = (startId: number): number[] => {
    const byPt = new Map<string, { segId: number; part: "a" | "b" }[]>();
    for (const s of segs) {
      for (const pp of ["a", "b"] as const) {
        if (separated.has(handleKey(s.id, pp))) continue;
        const k = `${s[pp].z},${s[pp].r}`;
        const arr = byPt.get(k) ?? [];
        arr.push({ segId: s.id, part: pp });
        byPt.set(k, arr);
      }
    }
    const seen = new Set<number>([startId]);
    const q = [startId];
    while (q.length) {
      const id = q.pop()!;
      const s = segs.find((x) => x.id === id);
      if (!s) continue;
      for (const pp of ["a", "b"] as const) {
        if (separated.has(handleKey(id, pp))) continue;
        const mates = byPt.get(`${s[pp].z},${s[pp].r}`) ?? [];
        for (const m of mates) {
          if (!seen.has(m.segId)) {
            seen.add(m.segId);
            q.push(m.segId);
          }
        }
      }
    }
    return [...seen].filter((id) => {
      const s = segs.find((x) => x.id === id);
      return s ? filterAllows(s.kind) : false;
    });
  };

  const eligibleIds = () => segs.filter((s) => filterAllows(s.kind)).map((s) => s.id);
  const selectAllEligible = () => {
    setSplitSelected(false);
    onSelected(eligibleIds());
  };
  const invertSelection = () => {
    setSplitSelected(false);
    const elig = eligibleIds();
    const ineligKept = selected.filter((id) => !elig.includes(id));
    onSelected([...ineligKept, ...elig.filter((id) => !selected.includes(id))]);
  };

  /* ---------- عملیات ویرایش ---------- */
  const commit = (next: SketchSeg[]) => onSegs(next, true);

  const deleteSelected = () => {
    if (!selected.length) return;
    commit(segs.filter((s) => !selected.includes(s.id)));
    onSelected([]);
  };

  const deleteSelectedSplit = () => {
    if (!splitSelected || !split.enabled) return;
    onSplit({ ...split, enabled: false });
    setSplitSelected(false);
    setSplitHovered(false);
  };

  /*
   * حذف نقطهٔ انتخاب‌شده با حفظ مسیر: اگر نقطه بین دو المان باشد، آن دو در یک
   * المان ادغام می‌شوند (A—B—C با حذف B می‌شود A—C). اگر نقطه فقط متعلق به یک
   * المان باشد، همان المان حذف می‌شود. حذف نقطهٔ روی کمان، کمان را به خط تبدیل می‌کند.
   */
  const deleteSelectedPoints = () => {
    const endPoints = selPoints.filter((p) => p.part === "a" || p.part === "b");
    const viaPoints = selPoints.filter((p) => p.part === "via");
    if (!endPoints.length && !viaPoints.length) return;

    let next = [...segs];
    let nextSelPoints = [...selPoints];
    const removedSegIds = new Set<number>();

    /* حذف نقطهٔ روی کمان → تبدیل کمان به خطِ وتری */
    for (const sp of viaPoints) {
      const seg = next.find((s) => s.id === sp.segId);
      if (seg && seg.kind === "arc" && !removedSegIds.has(seg.id)) {
        next = next.map((s) => (s.id === seg.id ? ({ id: s.id, kind: "line", a: s.a, b: s.b } as SketchSeg) : s));
        nextSelPoints = nextSelPoints.filter((p) => !(p.segId === seg.id && p.part === "via"));
      }
    }

    /* حذف نقاط انتهایی با ادغام المان‌های همسایه */
    for (const sp of endPoints) {
      const refSeg = next.find((s) => s.id === sp.segId && !removedSegIds.has(s.id));
      if (!refSeg) continue;
      const origin = refSeg[sp.part];
      if (!origin) continue;

      const owners: { seg: SketchSeg; part: "a" | "b" }[] = [];
      for (const s of next) {
        if (removedSegIds.has(s.id)) continue;
        for (const pp of ["a", "b"] as const) {
          if (separated.has(handleKey(s.id, pp))) continue;
          if (s[pp].z === origin.z && s[pp].r === origin.r) owners.push({ seg: s, part: pp });
        }
      }

      if (owners.length >= 2) {
        /* نقطه بین دو المان — ادغام در یک المان تا مسیر حفظ شود */
        const [o1, o2] = owners;
        const free1 = o1.part === "a" ? o1.seg.b : o1.seg.a;
        const free2 = o2.part === "a" ? o2.seg.b : o2.seg.a;
        let newSeg: SketchSeg;
        if (o1.seg.kind === "line" && o2.seg.kind === "line") {
          newSeg = { id: newSegId(), kind: "line", a: free1, b: free2 };
        } else {
          const [h1, h2] = defaultCubicHandles(free1, free2);
          newSeg = { id: newSegId(), kind: "cubic", a: free1, b: free2, c1: h1, c2: h2 };
        }
        next = next.filter((s) => s.id !== o1.seg.id && s.id !== o2.seg.id);
        removedSegIds.add(o1.seg.id);
        removedSegIds.add(o2.seg.id);
        next.push(newSeg);
        nextSelPoints = nextSelPoints.filter((p) => p.segId !== o1.seg.id && p.segId !== o2.seg.id);
      } else if (owners.length === 1) {
        /* نقطه فقط متعلق به یک المان — حذف همان المان */
        next = next.filter((s) => s.id !== owners[0].seg.id);
        removedSegIds.add(owners[0].seg.id);
        nextSelPoints = nextSelPoints.filter((p) => p.segId !== owners[0].seg.id);
      }
    }

    commit(next);
    setSelPoints(nextSelPoints.filter((p) => !removedSegIds.has(p.segId)));
  };

  const duplicateSelected = () => {
    if (!selected.length) return;
    const source = segs.filter((s) => selected.includes(s.id));
    const bounds = source.map(segBounds);
    const minR = Math.min(...bounds.map((b) => b.minR));
    const maxR = Math.max(...bounds.map((b) => b.maxR));
    const requestedDr = Math.min(6, R * 0.12);
    const dr = Math.min(R - maxR, Math.max(-minR, requestedDr));
    const copies = source.map((s) => cloneSeg(s, 0, dr));
    commit([...segs, ...copies]);
    onSelected(copies.map((c) => c.id));
  };

  const patchSeg = (id: number, patch: Partial<SketchSeg>, doCommit = true) => {
    const next = segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
    onSegs(next, doCommit);
  };

  /* ویرایش مختصات یک نقطهٔ مستقل */
  const patchPoint = (segId: number, part: SketchPointPart, patch: Partial<SPoint>) => {
    const next = segs.map((s) => {
      if (s.id !== segId) return s;
      const cur = s[part];
      if (!cur) return s;
      const point = constrainSegPointToStock(s, part, { ...cur, ...patch }, L, R);
      return withSegPoint(s, part, point);
    });
    onSegs(next, true);
  };

  /* المان‌هایی که حداقل یک نقطه‌شان مستقل انتخاب شده — برای هایلایت منحنی‌های متصل */
  const selPointSegIds = useMemo(() => [...new Set(selPoints.map((p) => p.segId))], [selPoints]);

  /* با حذف المان یا تغییر نوع، نقاط انتخابیِ نامعتبر پاک شوند */
  useEffect(() => {
    setSelPoints((prev) => {
      const valid = prev.filter((p) => {
        const s = segs.find((x) => x.id === p.segId);
        return !!s && s[p.part] != null;
      });
      return valid.length === prev.length ? prev : valid;
    });
  }, [segs]);

  /* جداسازی نقطه: دیگر با نقاط هم‌مکان خود جابه‌جا نمی‌شود */
  const doUnjoin = (segId: number, part: "a" | "b") => {
    setSeparated((prev) => new Set(prev).add(handleKey(segId, part)));
    setCtxMenu(null);
  };

  /* اتصال نقطه: به نزدیک‌ترین نقطهٔ انتهایی می‌چسبد و دوباره با خوشه حرکت می‌کند */
  const doJoin = (segId: number, part: "a" | "b") => {
    const seg = segs.find((s) => s.id === segId);
    setCtxMenu(null);
    if (!seg) return;
    const origin = seg[part];
    const tol = 20 / (camRef.current?.s ?? 1);
    let nearest: SPoint | null = null;
    let nd = tol;
    for (const s of segs) {
      for (const pp of ["a", "b"] as const) {
        if (s.id === segId && pp === part) continue;
        const d = dist(s[pp], origin);
        if (d > 1e-6 && d < nd) {
          nd = d;
          nearest = s[pp];
        }
      }
    }
    if (nearest) {
      const target = nearest;
      onSegs(segs.map((s) => (s.id === segId ? ({ ...s, [part]: { ...target } } as SketchSeg) : s)), true);
    }
    setSeparated((prev) => {
      const n = new Set(prev);
      n.delete(handleKey(segId, part));
      return n;
    });
  };

  /* منوی مرورگر همیشه سرکوب می‌شود؛ منوی اتصال در pointerup راست‌کلیک باز می‌شود */
  const onContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
  };

  /* ---------- بافرِ ادیت: رأس‌های مشترک، خطوطِ زنجیرشده ---------- */
  const lines = edit ? edit.lines : ([] as ELine[]);
  const verts = edit ? edit.verts : ([] as EVert[]);
  const pathStartVid = lines[0]?.va ?? null;
  const pathEndVid = lines[lines.length - 1]?.vb ?? null;
  const vById = useMemo(() => new Map(verts.map((v) => [v.id, v])), [verts]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const vertexLineCount = useMemo(() => {
    const count = new Map<number, number>();
    for (const line of lines) {
      count.set(line.va, (count.get(line.va) ?? 0) + 1);
      count.set(line.vb, (count.get(line.vb) ?? 0) + 1);
    }
    return count;
  }, [lines]);
  /* Set و جدول degree مانع جست‌وجوی O(n²) هنگام هر فریم pan می‌شوند. */
  const selectedLineIds = useMemo(() => new Set(selL), [selL]);
  const rangePreview = useMemo(() => {
    if (!editOpen || !toolpathLayersVisible || !shiftDown || activeLine == null || hoverBuf == null) return [] as number[];
    const from = lines.findIndex((l) => l.id === activeLine);
    const to = lines.findIndex((l) => l.id === hoverBuf);
    if (from < 0 || to < 0) return [] as number[];
    const lo = Math.min(from, to), hi = Math.max(from, to);
    return lines.slice(lo, hi + 1)
      .filter((line) => isolatedOpId == null || line.opId === isolatedOpId)
      .map((l) => l.id);
  }, [editOpen, toolpathLayersVisible, shiftDown, activeLine, hoverBuf, lines, isolatedOpId]);
  const vz = (vid: number): EVert => vById.get(vid) ?? { id: vid, z: 0, x: 0 };
  const bufVisible = (l: ELine) => settings[KIND_VISIBLE[l.motion === 0 ? "rapid" : l.kind]];
  const bufPx = (c: Cam, l: ELine): [number, number, number, number] => {
    const a = vz(l.va);
    const b = vz(l.vb);
    const [x1, y1] = screenPt(c, a.z, a.x / 2);
    const [x2, y2] = screenPt(c, b.z, b.x / 2);
    return [x1, y1, x2, y2];
  };
  const setBufGeom = (nextVerts: EVert[], nextLines: ELine[], commit: boolean) => {
    if (!edit) return;
    if (!commit) {
      onEditBuf({ ...edit, verts: nextVerts, lines: nextLines }, false);
      return;
    }
    /* اعتبارسنجی پس از هر ثبت (خواستهٔ ۹): صفرطول/تکراری/رأسِ یتیم حذف */
    const fin = normalizeEditBuf(nextVerts, nextLines);
    onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines }, true);
  };
  useEffect(() => {
    setSelV([]);
    setSelOff([]);
    setHitPicker(null);
    setPickerHover(null);
    if (!edit || isolatedOpId == null) return;
    const allowed = new Set(edit.lines.filter((line) => line.opId === isolatedOpId).map((line) => line.id));
    const stored = edit.selLines ?? selL;
    const kept = stored.filter((id) => allowed.has(id));
    if (kept.length !== stored.length) {
      const storedActive = edit.activeLine ?? activeLine;
      const nextActive = storedActive != null && allowed.has(storedActive) ? storedActive : null;
      selectEditLines(kept, nextActive, true);
    }
    // selectEditLines عمداً در dependency نیست؛ این effect فقط با تغییر isolate اجرا می‌شود.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolatedOpId, editOpen]);

  /* با ورود به ویرایش مسیر، قاب دور کل مسیر واقعی ماشین (شامل آفست هلدر ۲) تنظیم می‌شود. */
  const editFitDone = useRef(false);
  useEffect(() => {
    if (!editOpen) { editFitDone.current = false; return; }
    if (editFitDone.current || !verts.length || size.w < 40 || size.h < 40) return;
    let z0 = 0, z1 = L, r0 = -R, r1 = R;
    for (const v of verts) { z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); r0 = Math.min(r0, v.x / 2); r1 = Math.max(r1, v.x / 2); }
    const pad = 56, sw = Math.max(1, z1 - z0), sh = Math.max(1, r1 - r0);
    const scale = Math.max(0.2, Math.min(90, Math.min((size.w - 2 * pad) / sw, (size.h - 2 * pad) / sh)));
    setCam({ s: scale, ox: (size.w - sw * scale) / 2 - z0 * scale, oy: (size.h + (r0 + r1) * scale) / 2 });
    editFitDone.current = true;
  }, [editOpen, verts, size.w, size.h, L, R]);

  /* ران‌های بافر برای رسم — مسیرِ کامل، یک زنجیرۀ پیوسته (اتصال‌ها رأسِ مشترک‌اند) */
  const bufRuns = useMemo(() => {
    if (!editOpen || !cam || !toolpathLayersVisible) return [] as { kind: SegKind; opId: number; motion: 0 | 1; feed: number; d: string }[];
    const out: { kind: SegKind; opId: number; motion: 0 | 1; feed: number; d: string }[] = [];
    let cur: { kind: SegKind; opId: number; motion: 0 | 1; feed: number; pts: [number, number][] } | null = null;
    const flush = () => {
      if (cur && cur.pts.length > 1) {
        let d = `M ${cur.pts[0][0].toFixed(1)} ${cur.pts[0][1].toFixed(1)}`;
        for (let i = 1; i < cur.pts.length; i++) d += ` L ${cur.pts[i][0].toFixed(1)} ${cur.pts[i][1].toFixed(1)}`;
        out.push({ kind: cur.kind, opId: cur.opId, motion: cur.motion, feed: cur.feed, d });
      }
      cur = null;
    };
    for (const l of edit!.lines) {
      const kind: SegKind = l.motion === 0 ? "rapid" : l.kind;
      if (!settings[KIND_VISIBLE[kind]]) {
        flush();
        continue;
      }
      const a = vz(l.va);
      const b = vz(l.vb);
      if (!cur || cur.kind !== kind || cur.opId !== l.opId || cur.motion !== l.motion || Math.abs(cur.feed - l.feed) > 1e-8) {
        flush();
        cur = { kind, opId: l.opId, motion: l.motion, feed: l.feed, pts: [screenPt(cam, a.z, a.x / 2)] };
      }
      cur.pts.push(screenPt(cam, b.z, b.x / 2));
    }
    flush();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, cam, layerVisibilityKey, editOpen, toolpathLayersVisible]);

  const lineHitDistance = (c: Cam, l: ELine, px: number, py: number) => {
    const [x1, y1, x2, y2] = bufPx(c, l);
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
    const t = Math.min(1, Math.max(0, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / len2));
    return Math.hypot(px - (x1 + (x2 - x1) * t), py - (y1 + (y2 - y1) * t));
  };
  const bufSelectable = (l: ELine) => bufVisible(l) && (isolatedOpId == null || l.opId === isolatedOpId);
  const hitBufLines = (px: number, py: number): number[] => {
    const c = camRef.current;
    if (!c || !editOpen || !toolpathLayersVisible) return [];
    return lines.filter(bufSelectable).map((l) => ({ id: l.id, d: lineHitDistance(c, l, px, py) }))
      .filter((h) => h.d <= 6).sort((a, b) => a.d - b.d).map((h) => h.id);
  };
  const hitBufLine = (px: number, py: number) => hitBufLines(px, py)[0] ?? null;

  /* hit نشان‌های S/E با محل بصری خودشان محاسبه می‌شود؛ در مسیر بسته این دو
     نشان برای خوانایی ۱۳px از مرکز فاصله دارند. */
  const hitPathEndpoint = (px: number, py: number, allowed?: Set<number>): number | null => {
    const c = camRef.current;
    if (!c || pathStartVid == null || pathEndVid == null) return null;
    const start = vById.get(pathStartVid), end = vById.get(pathEndVid);
    if (!start || !end) return null;
    const coincident = Math.hypot(start.z - end.z, start.x - end.x) < 1e-7;
    const candidates = [
      { id: pathStartVid, v: start, dx: coincident ? -13 : 0 },
      { id: pathEndVid, v: end, dx: coincident ? 13 : 0 },
    ].filter((item) => !allowed || allowed.has(item.id));
    let best: { id: number; d: number } | null = null;
    for (const item of candidates) {
      const [x, y] = screenPt(c, item.v.z, item.v.x / 2);
      const d = Math.hypot(px - (x + item.dx), py - y);
      if (d <= 12 && (!best || d < best.d)) best = { id: item.id, d };
    }
    return best?.id ?? null;
  };

  /* S/E حتی با خاموش‌بودن نقاط قابل انتخاب‌اند؛ بقیه رأس‌ها تابع سوییچ نقاط‌اند. */
  const hitBufVerts = (px: number, py: number): number[] => {
    const c = camRef.current;
    if (!c || !editOpen || !toolpathLayersVisible) return [];
    const allowed = new Set(lines.filter(bufSelectable).flatMap((l) => [l.va, l.vb]));
    const endpoint = hitPathEndpoint(px, py, allowed);
    const hits = showPathPoints
      ? verts.filter((v) => allowed.has(v.id)).map((v) => {
          const [x, y] = screenPt(c, v.z, v.x / 2); return { id: v.id, d: Math.hypot(px - x, py - y) };
        }).filter((h) => h.d <= 8.5).sort((a, b) => a.d - b.d).map((h) => h.id)
      : [];
    return endpoint == null ? hits : [endpoint, ...hits.filter((id) => id !== endpoint)];
  };
  const hitBufVx = (px: number, py: number) => hitBufVerts(px, py)[0] ?? null;

  const applySelectedSpeed = (motion: 0 | 1, feed = RAPID_RATE) => {
    if (!edit || !selL.length) return;
    const ids = new Set(selL);
    const nextLines = edit.lines.map((line) =>
      ids.has(line.id) ? { ...line, motion, feed: motion === 0 ? RAPID_RATE : feed, feedOvr: true } : line
    );
    /* تغییر چند خط یک تراکنش واحد در history اصلی است. نمایش رنگ سرعت نیز
       همان لحظه روشن می‌شود تا تغییر G0→G1 و رنگ جدید قابل مشاهده باشد. */
    onEditBuf({ ...edit, lines: nextLines }, true);
    setShowPathBySpeed(true);
    setSpeedMenu(null);
  };
  const applyManualSpeed = () => {
    if (!/^\d+$/.test(manualSpeed)) {
      setSpeedError("عدد ۰ تا ۲۰۰۰ وارد کنید");
      return;
    }
    const value = Number(manualSpeed);
    if (!Number.isInteger(value) || value < 0 || value > 2000) {
      setSpeedError("عدد ۰ تا ۲۰۰۰ وارد کنید");
      return;
    }
    setSpeedError("");
    if (value === 0) applySelectedSpeed(0);
    else applySelectedSpeed(1, value);
  };
  const openSpeedMenu = (clientX: number, clientY: number) => {
    if (!editOpen || !selL.length) return;
    const loc = toLocal(clientX, clientY);
    const hit = hitBufLines(loc.x, loc.y).find((id) => selectedLineIds.has(id));
    if (hit == null) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    setManualSpeed("");
    setSpeedError("");
    setSpeedMenu({ x: clientX - rect.left, y: clientY - rect.top });
  };

  /* گامِ حرکت: فقط «میزانِ» جابه‌جایی از شبکه (چیپِ آهنربا) گرفته می‌شود — قفل روی خطوط شبکه نیست */
  const quantStep = (raw: SPoint, start: SPoint): { z: number; r: number } => {
    const dz = raw.z - start.z;
    const dr = raw.r - start.r;
    const g = settings.snap;
    if (g <= 0) return { z: dz, r: dr };
    return { z: Math.round(dz / g) * g, r: Math.round(dr / g) * g };
  };

  /* ---------- لایهٔ افست: به ازای هر قطعهٔ پروفایل یک منحنی (۱:۱)، مستقل ویرایش می‌شود ---------- */
  /* مسیرهای آفست در مختصات واقعی ماشین، داخل خود Polyline حضور دارند. */
  const offSegs = useMemo(() => [] as SketchSeg[], []);
  const pxDistOff = (o: SketchSeg, px: number, py: number): number => {
    const c = camRef.current;
    if (!c) return Infinity;
    const poly = o.kind === "line" ? [o.a, o.b] : segPoints(o, 24);
    let best = Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      const [x1, y1] = screenPt(c, poly[i].z, poly[i].r);
      const [x2, y2] = screenPt(c, poly[i + 1].z, poly[i + 1].r);
      const len2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1) || 1;
      const t = Math.min(1, Math.max(0, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / len2));
      best = Math.min(best, Math.hypot(px - (x1 + (x2 - x1) * t), py - (y1 + (y2 - y1) * t)));
    }
    return best;
  };
  const hitOffSeg = (px: number, py: number): number | null => {
    if (!camRef.current || !editOpen) return null;
    let best: number | null = null;
    let bestD = 3;
    for (const o of offSegs) {
      const d = pxDistOff(o, px, py);
      if (d < bestD) {
        bestD = d;
        best = o.id;
      }
    }
    return best;
  };
  type OffHandleRef = { id: number; part: "a" | "b" | "c1" | "c2" | "via" };
  const hitOffHandle = (px: number, py: number): OffHandleRef | null => {
    const c = camRef.current;
    if (!c || !editOpen) return null;
    let best: OffHandleRef | null = null;
    let bestD = 4.2;
    for (const o of offSegs) {
      const isSel = selOff.includes(o.id);
      const check = (part: OffHandleRef["part"], q?: SPoint) => {
        if (!q) return;
        const [qx, qy] = screenPt(c, q.z, q.r);
        const d = Math.hypot(px - qx, py - qy);
        if (d < bestD) {
          bestD = d;
          best = { id: o.id, part };
        }
      };
      check("a", o.a);
      check("b", o.b);
      if (isSel) {
        check("via", o.via);
        check("c1", o.c1);
        check("c2", o.c2);
      }
    }
    return best;
  };
  const patchOff = (id: number, patch: OffPatch, commit: boolean) => {
    if (!edit) return;
    const cur = edit.off[id] ?? {};
    onEditBuf({ ...edit, off: { ...edit.off, [id]: { ...cur, ...patch } } }, commit);
  };

  /* باکسِ انتخاب: خطوط + رأس‌ها */
  const bufMarqueeHits = (rectW: { z0: number; z1: number; r0: number; r1: number }, mode: "window" | "crossing") => {
    const ids: number[] = [];
    const vxs: number[] = [];
    if (!toolpathLayersVisible) return { ids, vxs };
    const inR = (z: number, r: number) => z >= rectW.z0 - 1e-9 && z <= rectW.z1 + 1e-9 && r >= rectW.r0 - 1e-9 && r <= rectW.r1 + 1e-9;
    const selectableLines = edit!.lines.filter(bufSelectable);
    const allowedVerts = new Set(selectableLines.flatMap((line) => [line.va, line.vb]));
    for (const v of edit!.verts) if (allowedVerts.has(v.id) && inR(v.z, v.x / 2)) vxs.push(v.id);
    for (const l of selectableLines) {
      const a = { z: vz(l.va).z, r: vz(l.va).x / 2 };
      const b = { z: vz(l.vb).z, r: vz(l.vb).x / 2 };
      const both = inR(a.z, a.r) && inR(b.z, b.r);
      let hit = both;
      if (!hit && mode === "crossing") {
        const mid = { z: (a.z + b.z) / 2, r: (a.r + b.r) / 2 };
        hit = inR(a.z, a.r) || inR(b.z, b.r) || inR(mid.z, mid.r) || segSegInt(a, b, { z: rectW.z0, r: rectW.r0 }, { z: rectW.z1, r: rectW.r1 }) || segSegInt(a, b, { z: rectW.z0, r: rectW.r1 }, { z: rectW.z1, r: rectW.r0 });
      }
      if (hit) ids.push(l.id);
    }
    return { ids, vxs };
  };

  /* ---------- تعامل ماوس ---------- */
  const drag = useRef<
    | { mode: "pan"; sx: number; sy: number; cam0: Cam; moved: boolean; btn: number }
    | { mode: "handle"; ref: HandleRef; cluster: { segId: number; part: HandleRef["part"] }[]; moved: boolean }
    | { mode: "move"; ids: number[]; clicked: number; last: SPoint; sx: number; sy: number; moved: boolean }
    | { mode: "draw"; sx: number; sy: number; cam0: Cam; moved: boolean }
    | { mode: "marquee"; sx: number; sy: number; base: number[]; moved: boolean }
    | { mode: "rwait"; sx: number; sy: number; cam0: Cam; moved: boolean }
    | {
        mode: "eline";
        ids: number[];
        start: SPoint;
        base: Map<number, EVert>;
        sx: number;
        sy: number;
        moved: boolean;
        /** Drag روی Segmentهای H2 یعنی تغییر سراسری آفست، نه اعوجاج یک خط. */
        holder2?: { base: Holder2State; next: Holder2State; latestVerts: EVert[] };
      }
    | { mode: "evert"; vid: number; start: SPoint; base: EVert; sx: number; sy: number; moved: boolean }
    | { mode: "eoff"; id: number; last: SPoint; seed: SketchSeg; sx: number; sy: number; moved: boolean }
    | { mode: "eoffh"; id: number; part: "a" | "b" | "c1" | "c2" | "via"; sx: number; sy: number; moved: boolean }
    | null
  >(null);
  /* Pan موقت با دکمه وسط/راست، بدون از دست‌دادن Drag فعالِ رأس Edit Path. */
  const editVertexPan = useRef<{ pointerId: number; sx: number; sy: number; cam0: Cam } | null>(null);

  const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  /* فقط نشان اصلی Split روی پروفایل فعال است؛ قرینهٔ سمت مقابل حذف شده است. */
  const hitSplitMarker = (px: number, py: number): boolean => {
    const c = camRef.current;
    if (!c || editOpen || !split.enabled) return false;
    const [x, y] = screenPt(c, split.z, split.r);
    return Math.hypot(px - x, py - y) <= 10;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!camRef.current) return;
    setCtxMenu(null);
    setSplitCtxMenu(null);
    setSpeedMenu(null);
    /* گرفتن اشاره‌گر روی خودِ SVG تا رویدادهای move/up همیشه به آن برسند */
    svgRef.current?.setPointerCapture?.(e.pointerId);
    const raw = toWorld(e.clientX, e.clientY);
    if (tool === "fillet" && e.button === 0 && !editOpen) {
      const hit = hitSeg(raw);
      if (!hit || hit.kind !== "line") {
        if (filletPicks.length === 0) setFilletBox(null);
        return;
      }
      if (filletPicks.length === 0 || filletPicks[0].id === hit.id) {
        setFilletPicks([{ id: hit.id, click: raw }]);
        onSelected([hit.id]);
        setFilletBox(null);
      } else {
        const next = [filletPicks[0], { id: hit.id, click: raw }];
        setFilletPicks(next);
        onSelected(next.map((pick) => pick.id));
        const rect = wrapRef.current!.getBoundingClientRect();
        setFilletBox({ x: Math.min(rect.width - 128, Math.max(40, e.clientX - rect.left + 14)), y: Math.min(rect.height - 58, Math.max(8, e.clientY - rect.top - 44)), value: "5", error: "" });
      }
      drag.current = null;
      return;
    }
    if (tool === "move" && e.button === 0) {
      /* کلیک دوم، پیش‌نمایش فعلی را تأیید می‌کند و پنجره را می‌بندد. */
      if (moveSession) {
        const base = moveSession.base.find((segment) => moveSession.ids.includes(segment.id));
        const current = base ? segs.find((segment) => segment.id === base.id) : null;
        if (base && current) setLastMove({ dz: current.a.z - base.a.z, dr: current.a.r - base.a.r });
        if (moveSession.editBase && edit) onEditBuf({ ...edit }, true);
        else onSegs(segs, true);
        setMoveBox(null); setMoveSession(null);
        return;
      }
      let ids: number[];
      let editBase: EVert[] | undefined;
      let editVertexIds: number[] | undefined;
      if (editOpen && edit) {
        const loc = toLocal(e.clientX, e.clientY);
        const hitVertex = hitBufVx(loc.x, loc.y);
        const hit = hitVertex == null ? hitBufLine(loc.x, loc.y) : null;
        const vertexSet = new Set<number>();
        if (hitVertex != null) {
          const chosen = selV.includes(hitVertex) ? [...selV] : [hitVertex];
          setSelV(chosen);
          ids = chosen.map((id) => -id - 1); // کلید داخلی برای نشست Move نقطه‌ای
          for (const id of chosen) vertexSet.add(id);
        } else if (hit != null || selL.length) {
          ids = hit != null ? (selL.includes(hit) ? [...selL] : [hit]) : [...selL];
          if (hit != null && !selL.includes(hit)) selectEditLines(ids, hit, true);
          for (const line of edit.lines) if (ids.includes(line.id)) { vertexSet.add(line.va); vertexSet.add(line.vb); }
        } else if (selV.length) {
          ids = selV.map((id) => -id - 1);
          for (const id of selV) vertexSet.add(id);
        } else return;
        editVertexIds = [...vertexSet];
        editBase = edit.verts.map((vertex) => ({ ...vertex }));
      } else {
        const hit = hitSeg(raw);
        ids = hit ? (selected.includes(hit.id) ? [...selected] : [hit.id]) : [...selected];
        if (!ids.length) return;
        if (hit) onSelected(ids);
      }
      const rect = wrapRef.current!.getBoundingClientRect();
      setMoveSession({ ids, base: segs.map((segment) => ({ ...segment })), editBase, editVertexIds, origin: raw, pointer: raw, clientX: e.clientX, clientY: e.clientY, axis: "free", mode: "relative", dirX: 1, dirY: 1, lastClientX: e.clientX, lastClientY: e.clientY });
      setMoveBox({ x: Math.min(rect.width - 58, Math.max(4, e.clientX - rect.left + 12)), y: Math.min(rect.height - 42, Math.max(4, e.clientY - rect.top - 48)), value: "", error: "" });
      drag.current = null;
      return;
    }

    /* هنگام Drag رأس در Edit Path، دکمه وسط یا راست فقط یک Pan موقت آغاز
       می‌کند و خود ژست جابه‌جایی رأس در drag.current حفظ می‌شود. */
    const activeDragMode = drag.current?.mode;
    const canPanDuringDrag = activeDragMode === "handle" || activeDragMode === "move" ||
      activeDragMode === "evert" || activeDragMode === "eline" || activeDragMode === "eoff" || activeDragMode === "eoffh";
    if (canPanDuringDrag && (e.button === 1 || e.button === 2)) {
      e.preventDefault();
      editVertexPan.current = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, cam0: camRef.current };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }

    /* دکمهٔ وسط همیشه پن است (هر ابزاری) */
    if (e.button === 1) {
      e.preventDefault();
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false, btn: 1 };
      return;
    }
    /* دکمهٔ راست: درگ = پن، کلیک بدون حرکت = منو/لغو (در pointerup تصمیم گرفته می‌شود) */
    if (e.button === 2) {
      drag.current = { mode: "rwait", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false };
      return;
    }

    /* در ابزارهای رسم نیز کشیدن یک نقطهٔ موجود، همان نقطه/دسته را جابه‌جا می‌کند.
       کلیک ساده همچنان در pointerup به‌عنوان ورودی ابزار رسم پردازش می‌شود. */
    const drawingHandle = !editOpen ? hitHandle(raw) : null;
    if (drawingHandle) {
      const cluster = drawingHandle.part === "a" || drawingHandle.part === "b"
        ? clusterOf(drawingHandle.segId, drawingHandle.part)
        : [drawingHandle];
      drag.current = { mode: "handle", ref: drawingHandle, cluster, moved: false };
      return;
    }

    if (tool !== "select") {
      /* حالت ترسیم — کلیک بدون حرکت نقطه ثبت می‌کند، کشیدن نما را جابه‌جا می‌کند */
      drag.current = { mode: "draw", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false };
      return;
    }

    /* پن صریح (دکمهٔ دست یا Space) بر باکس انتخاب اولویت دارد */
    if (panMode) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false, btn: 0 };
      return;
    }

    if (!editOpen) {
      const loc = toLocal(e.clientX, e.clientY);
      if (hitSplitMarker(loc.x, loc.y)) {
        /* Split انتخابی مستقل است؛ انتخاب خطوط/نقاط قبلی را پاک می‌کنیم. */
        setSplitSelected(true);
        onSelected([]);
        setSelPoints([]);
        drag.current = null;
        return;
      }
      setSplitSelected(false);
    }

    /* --- حالت ویرایش مسیر — رأسِ انتخابی، سرِ افست، منحنی افست، بدنهٔ خط --- */
    if (editOpen) {
      const ploc = toLocal(e.clientX, e.clientY);
      const nearVerts = hitBufVerts(ploc.x, ploc.y);
      const nearLines = hitBufLines(ploc.x, ploc.y);
      const endpointCandidate = nearVerts.find((id) => id === pathStartVid || id === pathEndVid);

      /* نشان‌های ابتدا/انتها بر Segment زیرین اولویت دارند تا با یک کلیک ساده
         انتخاب شوند و همان لحظه امکان drag آن‌ها وجود داشته باشد. */
      if (endpointCandidate != null) {
        if (e.shiftKey) setSelV(selV.includes(endpointCandidate) ? selV.filter((id) => id !== endpointCandidate) : [...selV, endpointCandidate]);
        else setSelV([endpointCandidate]);
        focusEditVertexInGCode(endpointCandidate);
        setHitPicker(null);
        setPickerHover(null);
        drag.current = { mode: "evert", vid: endpointCandidate, start: raw, base: { ...vz(endpointCandidate) }, sx: ploc.x, sy: ploc.y, moved: false };
        return;
      }

      /* Shift+کلیک: انتخاب قطعی بازهٔ هندسی از Segment فعال تا هدف، همراه با
         حفظ تمام انتخاب‌های قبلی. اولویت آن از انتخاب Vertex بالاتر است. */
      if ((e.shiftKey || shiftRef.current) && activeLine != null && nearLines.length) {
        const target = nearLines[0];
        const from = lines.findIndex((line) => line.id === activeLine);
        const to = lines.findIndex((line) => line.id === target);
        if (from >= 0 && to >= 0) {
          const lo = Math.min(from, to), hi = Math.max(from, to);
          const range = lines.slice(lo, hi + 1).filter(bufSelectable).map((line) => line.id);
          selectEditLines([...selL, ...range], target, true);
          setSelV([]);
          setHitPicker(null);
          setPickerHover(null);
          return;
        }
      }

      /* Ctrl+کلیک روی Segment انتخاب‌شده، حتی در محل هم‌پوشانی، فقط همان را لغو می‌کند. */
      if (e.ctrlKey || e.metaKey) {
        const selectedHit = activeLine != null && nearLines.includes(activeLine)
          ? activeLine
          : nearLines.find((id) => selL.includes(id));
        if (selectedHit != null) {
          const ids = selL.filter((id) => id !== selectedHit);
          selectEditLines(ids, null, true);
          setSelV([]);
          setHitPicker(null);
          setPickerHover(null);
          return;
        }
      }
      const alreadyChosen = nearVerts.some((id) => selV.includes(id)) || nearLines.some((id) => selL.includes(id));
      if (nearVerts.length + nearLines.length > 1 && !e.shiftKey && !alreadyChosen) {
        const rect = wrapRef.current!.getBoundingClientRect();
        setPickerHover(null);
        setHitPicker({ x: e.clientX - rect.left, y: e.clientY - rect.top, lines: nearLines, verts: nearVerts });
        return;
      }
      setHitPicker(null);
      setPickerHover(null);
      const bv = hitBufVx(ploc.x, ploc.y);
      if (bv != null) {
        if (e.shiftKey) setSelV(selV.includes(bv) ? selV.filter((x) => x !== bv) : [...selV, bv]);
        else if (!selV.includes(bv)) setSelV([bv]);
        focusEditVertexInGCode(bv);
        drag.current = { mode: "evert", vid: bv, start: raw, base: { ...vz(bv) }, sx: ploc.x, sy: ploc.y, moved: false };
        return;
      }
      const oh = hitOffHandle(ploc.x, ploc.y);
      if (oh) {
        if (!selOff.includes(oh.id)) setSelOff([...(e.shiftKey ? selOff : []), oh.id]);
        drag.current = { mode: "eoffh", id: oh.id, part: oh.part, sx: ploc.x, sy: ploc.y, moved: false };
        return;
      }
      const os = hitOffSeg(ploc.x, ploc.y);
      if (os != null) {
        if (e.shiftKey) setSelOff(selOff.includes(os) ? selOff.filter((x) => x !== os) : [...selOff, os]);
        else if (!selOff.includes(os)) setSelOff([os]);
        const seed = offSegs.find((o) => o.id === os);
        drag.current = seed ? { mode: "eoff", id: os, last: raw, seed, sx: e.clientX, sy: e.clientY, moved: false } : null;
        return;
      }
      /* در محدوده هم‌پوشان، خط فعال/انتخاب‌شده همیشه قبل از نزدیک‌ترین خط دیگر
         انتخاب می‌شود؛ بنابراین شروع drag هرگز ناخواسته به همسایه منتقل نمی‌شود. */
      const selectedBl = activeLine != null && nearLines.includes(activeLine)
        ? activeLine
        : nearLines.find((id) => selL.includes(id));
      const bl = selectedBl ?? hitBufLine(ploc.x, ploc.y);
      if (bl != null) {
        let ids: number[];
        if (e.ctrlKey || e.metaKey) {
          ids = selL.includes(bl) ? selL.filter((x) => x !== bl) : [...selL, bl];
          selectEditLines(ids, ids.includes(bl) ? bl : null, true);
          setSelV([]);
          return;
        }
        if (e.shiftKey) ids = selL.includes(bl) ? selL.filter((x) => x !== bl) : [...selL, bl];
        else ids = selL.includes(bl) ? selL : [bl];
        ids = lines.filter((line) => ids.includes(line.id) && bufSelectable(line)).map((line) => line.id);
        selectEditLines(ids, bl, true);
        setSelV([]);
        const selectedLines = ids.map((id) => lineById.get(id)).filter((line): line is ELine => !!line);
        const holder2Drag = selectedLines.length > 0 && selectedLines.every((line) => line.holder === 2);
        const vset = new Set<number>();
        if (holder2Drag) {
          /* آفست H2 یک تبدیل سراسری است؛ مبنا باید کل Polyline باشد تا با
             انتخاب تنها یک Segment، بقیهٔ داخل‌تراشی عقب نماند. */
          for (const v of verts) vset.add(v.id);
        } else {
          for (const l of selectedLines) { vset.add(l.va); vset.add(l.vb); }
        }
        const base = new Map<number, EVert>();
        for (const vid of vset) base.set(vid, { ...vz(vid) });
        const holderBase = edit?.holder2 ?? params.holder2;
        drag.current = {
          mode: "eline",
          ids,
          start: raw,
          base,
          sx: e.clientX,
          sy: e.clientY,
          moved: false,
          ...(holder2Drag
            ? { holder2: { base: { ...holderBase }, next: { ...holderBase }, latestVerts: verts } }
            : {}),
        };
        return;
      }
    }
    const s = editOpen ? null : hitSeg(raw);
    if (s) {
      /* المانِ متصل (از یک یا هر دو سر به المان خارج از گروه) قفل است و درگ نمی‌شود */
      const allowed = selected.includes(s.id) ? [...selected] : [s.id];
      if (allowed.some((id) => segLocked(id, allowed))) {
        if (e.shiftKey) onSelected(selected.includes(s.id) ? selected.filter((x) => x !== s.id) : [...selected, s.id]);
        else if (e.ctrlKey || e.metaKey) onSelected(selected.filter((x) => x !== s.id));
        else if (!selected.includes(s.id)) onSelected([s.id]);
        return;
      }
      /* تصمیم نهایی کلیک در pointerup گرفته می‌شود تا درگ گروهی ممکن باشد */
      drag.current = { mode: "move", ids: [...selected], clicked: s.id, last: raw, sx: e.clientX, sy: e.clientY, moved: false };
      return;
    }
    /* فضای خالی: شروع باکس انتخابگر (پاک‌سازی در pointerup اگر کلیک بود) */
    const loc = toLocal(e.clientX, e.clientY);
    drag.current = { mode: "marquee", sx: loc.x, sy: loc.y, base: [...selected], moved: false };
    setMarquee({ x0: loc.x, y0: loc.y, x1: loc.x, y1: loc.y, add: e.shiftKey, remove: e.ctrlKey || e.metaKey });
    setMarqueeHits([]);
    setMarqueeSplitHit(false);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const activeMode = drag.current?.mode;
    const canPanDuringDrag = activeMode === "handle" || activeMode === "move" ||
      activeMode === "evert" || activeMode === "eline" || activeMode === "eoff" || activeMode === "eoffh";
    const auxiliaryButtonHeld = (e.buttons & 2) !== 0 || (e.buttons & 4) !== 0;
    let temporaryPan = editVertexPan.current;
    /* بعضی مرورگرها هنگام نگه‌داشتن دکمه چپ، PointerDown دکمه دوم را ارسال
       نمی‌کنند؛ buttons در PointerMove منبع قطعی است و Pan را همان‌جا آغاز می‌کند. */
    if (canPanDuringDrag && auxiliaryButtonHeld && !temporaryPan && camRef.current) {
      temporaryPan = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, cam0: camRef.current };
      editVertexPan.current = temporaryPan;
    }
    if (temporaryPan && temporaryPan.pointerId === e.pointerId && auxiliaryButtonHeld) {
      setCam({
        s: temporaryPan.cam0.s,
        ox: temporaryPan.cam0.ox + e.clientX - temporaryPan.sx,
        oy: temporaryPan.cam0.oy + e.clientY - temporaryPan.sy,
      });
      return;
    }
    if (temporaryPan && !auxiliaryButtonHeld) {
      editVertexPan.current = null;
      return; // یک فریم برای تثبیت دوربین؛ از جهش نقطه پس از Pan جلوگیری می‌کند
    }
    const raw = toWorld(e.clientX, e.clientY);
    if (tool === "fillet" && e.button === 0 && !editOpen) {
      const hit = hitSeg(raw);
      if (!hit || hit.kind !== "line") {
        if (filletPicks.length === 0) setFilletBox(null);
        return;
      }
      if (filletPicks.length === 0 || filletPicks[0].id === hit.id) {
        setFilletPicks([{ id: hit.id, click: raw }]);
        onSelected([hit.id]);
        setFilletBox(null);
      } else {
        const next = [filletPicks[0], { id: hit.id, click: raw }];
        setFilletPicks(next);
        onSelected(next.map((pick) => pick.id));
        const rect = wrapRef.current!.getBoundingClientRect();
        setFilletBox({ x: Math.min(rect.width - 128, Math.max(40, e.clientX - rect.left + 14)), y: Math.min(rect.height - 58, Math.max(8, e.clientY - rect.top - 44)), value: "5", error: "" });
      }
      drag.current = null;
      return;
    }
    if (tool === "move" && moveSession) {
      const rect = wrapRef.current!.getBoundingClientRect();
      setMoveBox((box) => box ? {
        ...box,
        x: Math.min(rect.width - 58, Math.max(4, e.clientX - rect.left + 12)),
        y: Math.min(rect.height - 42, Math.max(4, e.clientY - rect.top - 48)),
      } : box);
      const dx = e.clientX - moveSession.clientX, dy = e.clientY - moveSession.clientY;
      /* در یک dead-zone بسیار کوچک دور نقطه شروع، جهت قبلی حفظ و جابه‌جایی صفر
         می‌شود؛ بنابراین عبور نویزی از مبدأ حرکت را به جهت مخالف پرتاب نمی‌کند. */
      const nearOrigin = Math.hypot(dx, dy) < 5;
      const stepX = e.clientX - moveSession.lastClientX;
      const stepY = e.clientY - moveSession.lastClientY;
      /* انتخاب جهت Shift از جهت واقعیِ حرکت اخیر موس می‌آید، نه فاصلهٔ کلی آن
         از آبجکت/نقطه شروع؛ پس با دورشدن نشانگر، کشش به جهت مخالف ایجاد نمی‌شود. */
      let axis: MoveAxis = "free";
      if (e.shiftKey) {
        const sx = Math.abs(stepX), sy = Math.abs(stepY);
        if (moveSession.axis === "free") axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        else if (moveSession.axis === "x") {
          /* فقط یک حرکت عمودیِ واضح محور را عوض می‌کند؛ نویز مورب/ریز نادیده گرفته می‌شود. */
          axis = sy > 2.5 && sy > sx * 1.7 ? "y" : "x";
        } else {
          axis = sx > 2.5 && sx > sy * 1.7 ? "x" : "y";
        }
      }
      const dirX: 1 | -1 = dx > 5 ? 1 : dx < -5 ? -1 : moveSession.dirX;
      const dirY: 1 | -1 = dy < -5 ? 1 : dy > 5 ? -1 : moveSession.dirY;
      setMoveSession({ ...moveSession, pointer: raw, axis, dirX, dirY, lastClientX: e.clientX, lastClientY: e.clientY });
      if (!moveBox?.value.trim()) {
        /* حرکت آزاد Move به گام شبکه می‌چسبد؛ Alt موقتاً Snap را دور می‌زند. */
        const snapped = e.altKey
          ? { z: raw.z - moveSession.origin.z, r: raw.r - moveSession.origin.r }
          : quantStep(raw, moveSession.origin);
        const dz = nearOrigin ? 0 : axis === "y" ? 0 : snapped.z;
        const dr = nearOrigin ? 0 : axis === "x" ? 0 : snapped.r;
        if (moveSession.editBase && moveSession.editVertexIds && edit) {
          const moving = new Set(moveSession.editVertexIds);
          onEditBuf({ ...edit, verts: moveSession.editBase.map((v) => moving.has(v.id) ? { ...v, z: v.z + dz, x: v.x + 2 * dr } : v) }, false);
        } else onSegs(moveSession.base.map((s) => moveSession.ids.includes(s.id) ? moveSeg(s, dz, dr) : s), false);
      }
      return;
    }
    if (readoutRef.current) readoutRef.current.textContent = editOpen ? `محور طولی ${raw.z.toFixed(2)}   محور شعاعی ${raw.r.toFixed(2)}` : `X ${raw.z.toFixed(1)}   Y⌀ ${(raw.r * 2).toFixed(1)}`;

    const d = drag.current;
    if (!d) {
      if (tool === "select") {
        /* Split و نقاط هندسی بر خط زیرین اولویت دارند تا انتخابشان مبهم نباشد. */
        const ploc = toLocal(e.clientX, e.clientY);
        const onSplitMarker = hitSplitMarker(ploc.x, ploc.y);
        setSplitHovered(onSplitMarker);
        const onHandle = !editOpen && !onSplitMarker && hitHandle(raw) != null;
        let hb: number | null = null;
        let endpoint: number | null = null;
        if (editOpen && !onHandle) {
          const allowed = new Set(lines.filter(bufSelectable).flatMap((line) => [line.va, line.vb]));
          endpoint = hitPathEndpoint(ploc.x, ploc.y, allowed);
          hb = endpoint == null && hitOffSeg(ploc.x, ploc.y) == null ? hitBufLine(ploc.x, ploc.y) : null;
        }
        setHoverPathEndpoint(endpoint);
        if (editOpen && hb != null) {
          setHoverBuf(hb);
          setHoverId(null);
        } else {
          if (editOpen) setHoverBuf(null);
          const s = editOpen || onHandle || onSplitMarker ? null : hitSeg(raw);
          setHoverId(s ? s.id : null);
        }
        setSnapHit(null);
      } else if (tool === "split") {
        setSplitHovered(false);
        /* ابزار Split مغناطیسی به پروفیل می‌چسبد */
        setCursor(nearestOnSketch(raw));
        setSnapHit(null);
      } else {
        const { p, hit } = applySnap(raw);
        setCursor(constrainDraftPoint(p));
        setSnapHit(hit);
      }
      return;
    }

    if (d.mode === "pan") {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      setCam({ s: d.cam0.s, ox: d.cam0.ox + (e.clientX - d.sx), oy: d.cam0.oy + (e.clientY - d.sy) });
      return;
    }

    if (d.mode === "rwait") {
      /* راست‌درگ = پن؛ اگر حرکت نکرد، در pointerup به‌عنوان کلیک‌راست عمل می‌شود */
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
        d.moved = true;
        drag.current = { mode: "pan", sx: d.sx, sy: d.sy, cam0: d.cam0, moved: true, btn: 2 };
        setCam({ s: d.cam0.s, ox: d.cam0.ox + (e.clientX - d.sx), oy: d.cam0.oy + (e.clientY - d.sy) });
      }
      return;
    }

    if (d.mode === "eline") {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      /* رأس‌های مشترک = یک‌جا جابه‌جا می‌شوند → همسایه‌ها بی‌درز دنباله می‌آیند؛
         جابه‌جایی از مبنایِ لحظهٔ کلیک و با گامِ شبکه (فقط «میزان» حرکت) */
      const { z: qz, r: qr } = quantStep(raw, d.start);
      if (d.holder2 && edit) {
        /* نگاشت نمایش: حرکت راست = Xoff بیشتر؛ حرکت بالا (v بیشتر) = Yoff کمتر،
           چون Ym = Yw/2 − Yoff. آفست و هندسه از یک دلتا ساخته می‌شوند. */
        const round2 = (v: number) => Math.round(v * 100) / 100;
        const next: Holder2State = {
          xOff: Math.max(MIN_HOLDER2_OFFSET, round2(d.holder2.base.xOff + qz)),
          yOff: Math.max(MIN_HOLDER2_OFFSET, round2(d.holder2.base.yOff - qr)),
        };
        const dz = next.xOff - d.holder2.base.xOff;
        const dv = d.holder2.base.yOff - next.yOff;
        const baseVerts = Array.from(d.base.values());
        const nv = translateHolder2Edit(baseVerts, lines, dz, dv);
        d.holder2.next = next;
        d.holder2.latestVerts = nv;
        /* پیش‌نویس Params را عوض نمی‌کند؛ ControlsPanel مقدار را از EditBuf
           می‌خواند و اعداد X/Y در همین فریم به‌صورت زنده عوض می‌شوند. */
        onEditBuf({ ...edit, verts: nv, lines, holder2: next }, false);
      } else {
        const nv = verts.map((v) => {
          const b0 = d.base.get(v.id);
          return b0 ? { ...v, z: b0.z + qz, x: b0.x + 2 * qr } : v;
        });
        setBufGeom(nv, lines, false);
      }
      return;
    }
    if (d.mode === "evert") {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      const { z: qz, r: qr } = quantStep(raw, d.start);
      const nv = verts.map((v) => (v.id === d.vid ? { ...v, z: d.base.z + qz, x: d.base.x + 2 * qr } : v));
      setBufGeom(nv, lines, false);
      return;
    }
    if (d.mode === "eoff") {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      const dz = raw.z - d.last.z;
      const dr = raw.r - d.last.r;
      const base = edit?.off[d.id] ?? {};
      const seed: SketchSeg = d.seed;
      const cur = { ...seed, ...base } as SketchSeg;
      const sh = (q?: SPoint): SPoint | undefined => (q ? { z: q.z + dz, r: q.r + dr } : q);
      const patch: OffPatch = {};
      patch.a = sh(cur.a);
      patch.b = sh(cur.b);
      if (cur.c1) patch.c1 = sh(cur.c1);
      if (cur.c2) patch.c2 = sh(cur.c2);
      if (cur.via) patch.via = sh(cur.via);
      patchOff(d.id, patch, false);
      d.last = raw;
      return;
    }
    if (d.mode === "eoffh") {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      patchOff(d.id, { [d.part]: { z: raw.z, r: raw.r } } as OffPatch, false);
      return;
    }
    if (d.mode === "marquee") {
      const loc = toLocal(e.clientX, e.clientY);
      if (!d.moved && Math.hypot(loc.x - d.sx, loc.y - d.sy) < 4) return;
      d.moved = true;
      const c = camRef.current!;
      const w0 = worldPt(c, d.sx, d.sy);
      const w1 = worldPt(c, loc.x, loc.y);
      const rectW = {
        z0: Math.min(w0.z, w1.z),
        z1: Math.max(w0.z, w1.z),
        r0: Math.min(w0.r, w1.r),
        r1: Math.max(w0.r, w1.r),
      };
      const mode: "window" | "crossing" = loc.x >= d.sx ? "window" : "crossing";
      setMarquee({ x0: d.sx, y0: d.sy, x1: loc.x, y1: loc.y, add: e.shiftKey, remove: e.ctrlKey || e.metaKey });
      if (editOpen) {
        /* در ویرایش مسیر فقط پیش‌نمایش EditBuf محاسبه می‌شود؛ پروفایل اصلی
           نباید حتی به‌صورت موقت داخل باکس هایلایت شود. */
        setMarqueeHits([]);
        setMarqueePointHits([]);
        setMarqueeSplitHit(false);
        setBufMarq(bufMarqueeHits(rectW, mode));
      } else {
        setBufMarq(null);
        setMarqueeHits(marqueeHitIds(rectW, mode));
        setMarqueePointHits(marqueeHitPoints(rectW));
        setMarqueeSplitHit(marqueeHitsSplit(rectW));
      }
      return;
    }

    if (d.mode === "draw") {
      /* تا وقتی کاربر واقعاً نکشیده، فقط پیش‌نمایش به‌روز می‌شود */
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
        d.moved = true;
        setCam({ s: d.cam0.s, ox: d.cam0.ox + (e.clientX - d.sx), oy: d.cam0.oy + (e.clientY - d.sy) });
      } else if (tool === "split") {
        setCursor(nearestOnSketch(raw));
        setSnapHit(null);
      } else {
        const { p, hit } = applySnap(raw);
        setCursor(constrainDraftPoint(p));
        setSnapHit(hit);
      }
      return;
    }

    if (d.mode === "handle") {
      d.moved = true;
      /* اگر نقطهٔ درگ‌شده جزو چند نقطهٔ مستقلِ انتخاب‌شده است، همه با هم جابه‌جا می‌شوند */
      const inMulti =
        selPoints.length > 1 &&
        selPoints.some((sp) => sp.segId === d.ref.segId && sp.part === d.ref.part);
      const skipIds = inMulti
        ? [...new Set(selPoints.map((sp) => sp.segId))]
        : d.cluster.map((c) => c.segId);
      const { p, hit } = applySnap(raw, skipIds);
      setSnapHit(hit);

      const refSeg = segs.find((s) => s.id === d.ref.segId);
      const refPt = refSeg ? refSeg[d.ref.part] : null;
      if (!refPt) return;

      /* برای کنترل‌پوینت‌ها مقصد clamp نمی‌شود. کل جابه‌جایی (تکی یا چندانتخابی)
         فقط تا جایی اعمال می‌شود که هندسهٔ واقعی همهٔ منحنی‌های درگیر داخل خام بماند. */
      const toMove = new Map<string, { segId: number; part: SketchPointPart }>();
      if (inMulti) {
        for (const sp of selPoints) {
          if (sp.part === "a" || sp.part === "b") {
            for (const c of clusterOf(sp.segId, sp.part)) toMove.set(`${c.segId}:${c.part}`, c);
          } else {
            toMove.set(`${sp.segId}:${sp.part}`, sp);
          }
        }
      } else {
        for (const h of d.cluster) toMove.set(`${h.segId}:${h.part}`, h);
      }

      const bySeg = new Map<number, SketchPointPart[]>();
      for (const h of toMove.values()) {
        const parts = bySeg.get(h.segId) ?? [];
        if (!parts.includes(h.part)) parts.push(h.part);
        bySeg.set(h.segId, parts);
      }
      const dz = p.z - refPt.z;
      const dr = p.r - refPt.r;
      const moveSubset = (source: SketchSeg[], ddz: number, ddr: number): SketchSeg[] => source.map((s) => {
        const parts = bySeg.get(s.id)!;
        let out = s;
        for (const part of parts) {
          const cur = s[part];
          if (cur) out = withSegPoint(out, part, { z: cur.z + ddz, r: cur.r + ddr });
        }
        return out;
      });
      /* فقط منحنی‌های واقعاً درگیر بررسی می‌شوند. قبلاً در هر مرحله جست‌وجوی
         دودویی کل اسکچ map/filter می‌شد و Drag دسته‌های Bézier را سنگین می‌کرد. */
      const moving = segs.filter((s) => bySeg.has(s.id));
      const valid = (candidate: SketchSeg[]) => candidate.every((s) => segInsideStock(s, L, R));
      const allowedScale = (source: SketchSeg[], ddz: number, ddr: number): number => {
        if (Math.abs(ddz) + Math.abs(ddr) < 1e-12) return 1;
        if (valid(moveSubset(source, ddz, ddr))) return 1;
        if (!valid(source)) return 0;
        let lo = 0, hi = 1;
        /* ۱۲ مرحله دقتی بهتر از ۰٫۰۲۵٪ می‌دهد و برای حرکت زنده کافی است. */
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (valid(moveSubset(source, ddz * mid, ddr * mid))) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      const zScale = allowedScale(moving, dz, 0);
      const afterZMoving = moveSubset(moving, dz * zScale, 0);
      const rScale = allowedScale(afterZMoving, 0, dr);
      const finalMoving = moveSubset(afterZMoving, 0, dr * rScale);
      const movedById = new Map(finalMoving.map((segment) => [segment.id, segment]));
      onSegs(segs.map((segment) => movedById.get(segment.id) ?? segment), false);
      return;
    }

    if (d.mode === "move") {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
      if (!d.moved) {
        /* شروع درگ: انتخابِ در حال حرکت مشخص می‌شود */
        d.moved = true;
        if (e.shiftKey) {
          if (!d.ids.includes(d.clicked)) d.ids = [...d.ids, d.clicked];
        } else if (e.ctrlKey || e.metaKey) {
          d.ids = d.ids.filter((x) => x !== d.clicked);
          if (!d.ids.length) {
            drag.current = null;
            return;
          }
        } else if (!d.ids.includes(d.clicked)) {
          d.ids = [d.clicked];
        }
        onSelected([...d.ids]);
        d.last = raw;
        return;
      }
      const requestedDz = raw.z - d.last.z;
      const requestedDr = raw.r - d.last.r;
      d.last = raw;
      const moving = segs.filter((s) => d.ids.includes(s.id));
      const bounds = moving.map(segBounds);
      const minZ = Math.min(...bounds.map((b) => b.minZ));
      const maxZ = Math.max(...bounds.map((b) => b.maxZ));
      const minR = Math.min(...bounds.map((b) => b.minR));
      const maxR = Math.max(...bounds.map((b) => b.maxR));
      /* کران از خود منحنی محاسبه می‌شود، نه از دسته‌ها؛ دسته‌ها آزادانه می‌توانند
         بیرون خام بمانند، درحالی‌که انتقال کل خط از مرز عبور نمی‌کند. */
      const dz = Math.min(L - maxZ, Math.max(-minZ, requestedDz));
      const dr = Math.min(R - maxR, Math.max(-minR, requestedDr));
      onSegs(segs.map((s) => (d.ids.includes(s.id) ? moveSeg(s, dz, dr) : s)), false);
    }
  };

  const cutSegmentAtSplit = () => {
    if (!split.enabled || !segs.length) return;
    let target: SketchSeg | null = null;
    let targetT = 0;
    let bestD = Infinity;
    for (const segment of segs) {
      const hit = nearestOnSeg(segment, { z: split.z, r: split.r });
      if (hit.distance < bestD) { bestD = hit.distance; target = segment; targetT = hit.t; }
    }
    if (!target || targetT <= 1e-4 || targetT >= 1 - 1e-4) {
      setSplitCtxMenu(null);
      return;
    }
    const s = target, t = targetT;
    const mix = (a: SPoint, b: SPoint, k: number): SPoint => ({ z: a.z + (b.z - a.z) * k, r: a.r + (b.r - a.r) * k });
    const at = evalSeg(s, t);
    let first: SketchSeg;
    let second: SketchSeg;
    if (s.kind === "quad" && s.c1) {
      const ac = mix(s.a, s.c1, t), cb = mix(s.c1, s.b, t);
      first = { id: s.id, kind: "quad", a: { ...s.a }, b: at, c1: ac };
      second = { id: newSegId(), kind: "quad", a: at, b: { ...s.b }, c1: cb };
    } else if (s.kind === "cubic" && s.c1 && s.c2) {
      const p01 = mix(s.a, s.c1, t), p12 = mix(s.c1, s.c2, t), p23 = mix(s.c2, s.b, t);
      const p012 = mix(p01, p12, t), p123 = mix(p12, p23, t);
      first = { id: s.id, kind: "cubic", a: { ...s.a }, b: at, c1: p01, c2: p012 };
      second = { id: newSegId(), kind: "cubic", a: at, b: { ...s.b }, c1: p123, c2: p23 };
    } else if (s.kind === "arc") {
      first = { id: s.id, kind: "arc", a: { ...s.a }, b: at, via: evalSeg(s, t / 2) };
      second = { id: newSegId(), kind: "arc", a: at, b: { ...s.b }, via: evalSeg(s, (t + 1) / 2) };
    } else {
      first = { id: s.id, kind: "line", a: { ...s.a }, b: at };
      second = { id: newSegId(), kind: "line", a: at, b: { ...s.b } };
    }
    onSegs(segs.flatMap((segment) => segment.id === s.id ? [first, second] : [segment]), true);
    onSplit({ ...split, z: at.z, r: at.r });
    setSplitCtxMenu(null);
  };

  /* بازکردن منوی اتصال/جداسازی نقطه در موقعیت صفحه */
  const openJoinMenu = (clientX: number, clientY: number) => {
    if (tool !== "select" && tool !== "split") return;
    const local = toLocal(clientX, clientY);
    if (hitSplitMarker(local.x, local.y)) {
      const rect = wrapRef.current!.getBoundingClientRect();
      setCtxMenu(null);
      setSplitCtxMenu({ x: clientX - rect.left, y: clientY - rect.top });
      return;
    }
    setSplitCtxMenu(null);
    const raw = toWorld(clientX, clientY);
    const h = hitHandle(raw);
    if (h && (h.part === "a" || h.part === "b")) {
      const rect = wrapRef.current!.getBoundingClientRect();
      const cluster = clusterOf(h.segId, h.part);
      if (!selected.includes(h.segId)) onSelected([h.segId]);
      setCtxMenu({
        x: clientX - rect.left,
        y: clientY - rect.top,
        segId: h.segId,
        part: h.part,
        separated: separated.has(handleKey(h.segId, h.part)),
        clusterSize: cluster.length,
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (editVertexPan.current?.pointerId === e.pointerId && (e.button === 1 || e.button === 2)) {
      editVertexPan.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      /* drag.current عمداً باقی می‌ماند تا Drag نقطه با دکمه چپ ادامه یابد. */
      return;
    }
    const d = drag.current;
    drag.current = null;
    setSnapHit(null);
    if (tool === "move" || tool === "fillet") return;

    /* --- حالت ویرایش مسیر: ثبت ژست (نرمال‌سازی + تاریخچه) --- */
    if (d?.mode === "eline" || d?.mode === "evert") {
      if (edit && d.moved) {
        if (d.mode === "eline" && d.holder2) {
          const fin = normalizeEditBuf(d.holder2.latestVerts, edit.lines);
          onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, holder2: d.holder2.next }, true);
        } else setBufGeom(edit.verts, edit.lines, true);
      }
      return;
    }
    if (d?.mode === "eoff") {
      if (edit && d.moved) onEditBuf({ ...edit }, true);
      else if (!e.shiftKey) setSelOff([d.id]);
      return;
    }
    if (d?.mode === "eoffh") {
      if (edit && d.moved) onEditBuf({ ...edit }, true);
      return;
    }

    /* کلیک‌راست بدون درگ: در حالت ترسیم لغو پیش‌نویس، در انتخاب منوی اتصال */
    if (d?.mode === "rwait") {
      if (!d.moved) {
        if (draft.length) cancelDraft();
        else if (editOpen) openSpeedMenu(e.clientX, e.clientY);
        else openJoinMenu(e.clientX, e.clientY);
      }
      return;
    }

    if (d?.mode === "marquee") {
      const loc = toLocal(e.clientX, e.clientY);
      const wasClick = !d.moved && Math.hypot(loc.x - d.sx, loc.y - d.sy) < 4;
      setMarquee(null);
      setMarqueeHits([]);
      setMarqueePointHits([]);
      setMarqueeSplitHit(false);
      if (wasClick) {
        /* کلیک روی فضای خالی: بدون اصلاح‌کننده پاک‌کردن انتخاب المان‌ها و نقاط */
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          onSelected([]);
          setSelPoints([]);
          setSplitSelected(false);
          if (editOpen) { selectEditLines([], null, true); setSelV([]); setHitPicker(null); }
        }
        return;
      }
      const c = camRef.current!;
      const w0 = worldPt(c, d.sx, d.sy);
      const w1 = worldPt(c, loc.x, loc.y);
      const rectW = {
        z0: Math.min(w0.z, w1.z),
        z1: Math.max(w0.z, w1.z),
        r0: Math.min(w0.r, w1.r),
        r1: Math.max(w0.r, w1.r),
      };
      const mode: "window" | "crossing" = loc.x >= d.sx ? "window" : "crossing";
      /* باکس در حالت ادیت: اول خطوط/رأس‌های برنامه؛ اگر چیزی نگرفت، رفتار همیشگیِ پروفایل */
      if (editOpen) {
        const bh = bufMarqueeHits(rectW, mode);
        if (bh.ids.length || bh.vxs.length) {
          const remove = e.ctrlKey || e.metaKey;
          const add = e.shiftKey;
          if (remove) {
            const nextLines = selL.filter((id) => !bh.ids.includes(id));
            const nextVerts = selV.filter((id) => !bh.vxs.includes(id));
            selectEditLines(nextLines, nextLines.includes(activeLine ?? -1) ? activeLine : null, true);
            setSelV(nextVerts);
            if (!nextLines.length && nextVerts.length) focusEditVertexInGCode(nextVerts[nextVerts.length - 1]);
          } else if (add) {
            const nextLines = [...selL, ...bh.ids.filter((id) => !selL.includes(id))];
            const nextVerts = [...selV, ...bh.vxs.filter((id) => !selV.includes(id))];
            selectEditLines(nextLines, bh.ids[bh.ids.length - 1] ?? activeLine, true);
            setSelV(nextVerts);
            if (!nextLines.length && nextVerts.length) focusEditVertexInGCode(nextVerts[nextVerts.length - 1]);
          } else {
            selectEditLines(bh.ids, bh.ids[bh.ids.length - 1] ?? null, true);
            setSelV(bh.vxs);
            if (!bh.ids.length && bh.vxs.length) focusEditVertexInGCode(bh.vxs[bh.vxs.length - 1]);
          }
          setBufMarq(null);
          return;
        }
        setBufMarq(null);
        /* در ویرایش مسیر هرگز به انتخاب پروفایلِ زیرین fall through نمی‌کنیم. */
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          selectEditLines([], null, true);
          setSelV([]);
        }
        return;
      }
      const hits = marqueeHitIds(rectW, mode);
      const pointHits = marqueeHitPoints(rectW);
      const splitHit = marqueeHitsSplit(rectW);
      const remove = e.ctrlKey || e.metaKey;
      const add = e.shiftKey;
      if (remove) onSelected(d.base.filter((id) => !hits.includes(id)));
      else if (add) onSelected([...d.base, ...hits.filter((id) => !d.base.includes(id))]);
      else onSelected(hits);
      /* انتخاب نقاط داخل باکس (با همان اصلاح‌کننده‌ها) */
      const pkey = (p: { segId: number; part: string }) => `${p.segId}:${p.part}`;
      if (remove) setSelPoints(selPoints.filter((p) => !pointHits.some((h) => pkey(h) === pkey(p))));
      else if (add) setSelPoints([...selPoints, ...pointHits.filter((h) => !selPoints.some((p) => pkey(p) === pkey(h)))]);
      else setSelPoints(pointHits);
      if (remove) {
        if (splitHit) setSplitSelected(false);
      } else if (add) {
        if (splitHit) setSplitSelected(true);
      } else {
        setSplitSelected(splitHit);
      }
      return;
    }

    if (d && (d.mode === "handle" || d.mode === "move")) {
      if (d.mode === "handle") {
        const ref = d.ref;
        const pkey = (p: { segId: number; part: string }) => `${p.segId}:${p.part}`;
        const exists = selPoints.some((p) => pkey(p) === pkey(ref));
        if (d.moved) {
          /* نشانگر ابزار رسم هنوز مختصات لحظه شروع Drag را نگه می‌دارد. پیش از
             render ثبت تاریخچه آن را پاک می‌کنیم تا پس از MouseUp حتی یک فریم
             در محل قدیمی چشمک نزند؛ حرکت بعدی موس دوباره نشانگر را می‌سازد. */
          setCursor(null);
          onSegs(segs, true); // ثبت در تاریخچه
          if (!e.shiftKey && !exists) setSelPoints([ref]); // نقطهٔ درگ‌شده انتخاب بماند
          return;
        }
        if (tool === "select") {
          if (e.shiftKey) setSelPoints(exists ? selPoints.filter((p) => pkey(p) !== pkey(ref)) : [...selPoints, ref]);
          else if (e.ctrlKey || e.metaKey) setSelPoints(selPoints.filter((p) => pkey(p) !== pkey(ref)));
          else setSelPoints([ref]);
          return;
        }
        /* کلیک بدون Drag در ابزار رسم باید نقطهٔ مرحلهٔ رسم را ثبت کند. */
      }
      if (d.mode === "move") {
        if (d.moved) {
          onSegs(segs, true); // ثبت در تاریخچه
          return;
        }
        /* کلیک بدون درگ روی المان */
        const id = d.clicked;
        if (e.shiftKey) {
          onSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
        } else if (e.ctrlKey || e.metaKey) {
          onSelected(selected.filter((x) => x !== id));
        } else {
          onSelected([id]);
        }
        return;
      }
    }

    if (tool !== "select" && (!d || (((d.mode === "draw" || d.mode === "pan" || d.mode === "handle") && !d.moved)))) {
      /* ابزار Split: قرار دادن نقطه تعیین‌کننده روی پروفیل */
      if (tool === "split") {
        const hit = nearestOnSketch(toWorld(e.clientX, e.clientY));
        if (hit) onSplit({ enabled: true, z: hit.z, r: hit.r, swapped: split.swapped });
        return;
      }
      /* افزودن نقطهٔ جدید به ترسیم در حال انجام */
      const { p } = applySnap(toWorld(e.clientX, e.clientY));
      const pt = constrainDraftPoint(p);
      const need = NEED_PTS[tool];

      if (tool === "cubic") {
        /* منحنی کنترلی (مانند ابزار Pen): کلیک۱ نقطهٔ شروع، کلیک۲ نقطهٔ پایان و    */
        /* دستهٔ خروج از پایان (c2) فعال می‌شود، کلیک۳ دستهٔ c2 را ثبت و دستهٔ      */
        /* ورود به شروع (c1) را فعال می‌کند، کلیک۴ دستهٔ c1 را ثبت و منحنی می‌سازد.  */
        if (draft.length === 0) {
          setDraft([pt]);
          return;
        }
        if (draft.length === 1) {
          /* کلیک ۲: نقطهٔ پایان + دسته‌های پیش‌فرض؛ c2 (متصل به پایان) فعال است */
          const [h1, h2] = defaultCubicHandles(draft[0], pt);
          setDraft([draft[0], pt, h1, h2]);
          return;
        }
        if (draft.length === 4 && !draftSecondSet.current) {
          /* کلیک ۳: ثبت دستهٔ دوم (c2) — متصل به نقطهٔ پایان */
          draftSecondSet.current = true;
          setDraft([draft[0], draft[1], draft[2], pt]);
          return;
        }
        /* کلیک ۴: ثبت دستهٔ اول (c1) — متصل به نقطهٔ شروع — و ساخت منحنی */
        const seg = makeSeg("cubic", [draft[0], draft[1], pt, draft[3]]);
        if (seg) {
          commit([...segs, seg]);
          onSelected([seg.id]);
        }
        draftSecondSet.current = false;
        setDraft([]);
        return;
      }

      const pts = [...draft, pt];
      if (pts.length >= need) {
        const seg = makeSeg(tool as SketchKind, pts);
        if (seg) {
          commit([...segs, seg]);
          onSelected([seg.id]);
        }
        setDraft([]);
      } else {
        setDraft(pts);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (draft.length) {
      cancelDraft();
      return;
    }
    /* در ویرایش مسیر، دابل‌کلیک روی خط یک Vertex جدید درج می‌کند. */
    if (tool !== "select" || !camRef.current) return;
    const raw = toWorld(e.clientX, e.clientY);
    if (editOpen && edit) {
      const loc = toLocal(e.clientX, e.clientY);
      const id = hitBufLine(loc.x, loc.y);
      if (id != null) {
        const fin = insertEditVertex(edit.verts, edit.lines, id, raw.z, raw.r * 2);
        onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, selLines: [], activeLine: null }, true);
        const nearest = fin.verts.reduce((best, v) => Math.hypot(v.z - raw.z, v.x / 2 - raw.r) < Math.hypot(best.z - raw.z, best.x / 2 - raw.r) ? v : best, fin.verts[0]);
        setSelV([nearest.id]); setSelL([]); setActiveLine(null);
        return;
      }
    }
    const s = editOpen ? null : hitSeg(raw);
    if (s) {
      const chain = chainIds(s.id);
      if (e.shiftKey) onSelected([...selected, ...chain.filter((id) => !selected.includes(id))]);
      else onSelected(chain);
    }
  };

  const zoomBy = (k: number) =>
    setCam((c) => {
      if (!c) return c;
      const ns = Math.min(90, Math.max(0.35, c.s * k));
      const cx = size.w / 2;
      const cy = size.h / 2;
      const wa = (cx - c.ox) / c.s;
      const wb = (c.oy - cy) / c.s;
      return { s: ns, ox: cx - wa * ns, oy: cy + wb * ns };
    });

  /* ---------- مسیر ابزار ---------- */
  const runs = useMemo(() => {
    if (!cam || !toolpathLayersVisible) return [] as { kind: SegKind; motion: 0 | 1; opId: number; holder: 1 | 2; d: string; arrows: string; sx: number; sy: number }[];
    const out: { kind: SegKind; motion: 0 | 1; opId: number; holder: 1 | 2; d: string; arrows: string; sx: number; sy: number }[] = [];
    let curKind: SegKind | null = null;
    let curMotion: 0 | 1 = 0;
    let curOpId = -2;
    let curHolder: 1 | 2 = 1;
    let curFan = -1; // گسترش G0 این ران (از جی‌کد) — تغییر آن ران را می‌شکافد
    let curFanU = 0; // گسترش محوری این ران — تغییر آن هم ران را می‌شکافد (پله مورب پنهان)
    let pts: [number, number][] = [];
    const arrowHead = (x1: number, y1: number, x2: number, y2: number) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 7) return "";
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      return `M ${(x2 + ux * 2).toFixed(1)} ${(y2 + uy * 2).toFixed(1)} L ${(x2 - ux * 6.5 - uy * 4).toFixed(1)} ${(y2 - uy * 6.5 + ux * 4).toFixed(1)} L ${(x2 - ux * 6.5 + uy * 4).toFixed(1)} ${(y2 - uy * 6.5 - ux * 4).toFixed(1)} Z `;
    };
    const flush = () => {
      if (curKind && pts.length > 1) {
        let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
        let arrows = "";
        if (curMotion !== 0) {
          const step = Math.max(1, Math.ceil((pts.length - 1) / 6));
          for (let i = step; i < pts.length - 1; i += step) {
            arrows += arrowHead(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
          }
        } else if ((curFan > 0 || curFanU !== 0) && pts.length >= 2) {
          /* حرکت سریعِ گسترده‌شده در جی‌کد: پیکان جهت در انتها */
          const n = pts.length;
          arrows = arrowHead(pts[n - 2][0], pts[n - 2][1], pts[n - 1][0], pts[n - 1][1]);
        }
        out.push({ kind: curKind, motion: curMotion, opId: curOpId, holder: curHolder, d, arrows, sx: pts[0][0], sy: pts[0][1] });
      }
      curKind = null;
      curFan = -1;
      curFanU = 0;
      pts = [];
    };
    for (const sg of gen.segs) {
      const kind: SegKind = sg.motion === 0 ? "rapid" : sg.kind;
      if (!settings[KIND_VISIBLE[kind]]) {
        flush();
        continue;
      }
      /* آفست نمایشی = همان گسترش جی‌کد (فقط قطر، فقط حرکت سریع) */
      const fan = sg.motion === 0 ? sg.fan ?? 0 : 0;
      const fanU = sg.motion === 0 ? sg.fanU ?? 0 : 0;
      if (kind !== curKind || sg.motion !== curMotion || sg.opId !== curOpId || sg.holder !== curHolder || fan !== curFan || fanU !== curFanU) {
        flush();
        curKind = kind;
        curMotion = sg.motion;
        curOpId = sg.opId;
        curHolder = sg.holder;
        curFan = fan;
        curFanU = fanU;
        pts = [screenPt(cam, sg.z1 + fanU, (sg.x1 + fan) / 2)];
      }
      pts.push(screenPt(cam, sg.z2 + fanU, (sg.x2 + fan) / 2));
    }
    flush();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.segs, cam, layerVisibilityKey, toolpathLayersVisible]);

  const ghostPath = useMemo(() => {
    if (!settings.showGhost || !cam) return "";
    /* سایه همیشه از زنجیره کامل طرح ساخته می‌شود، نه شاخه‌های تولیدشده توسط
       Split؛ بنابراین جابه‌جایی Split هیچ مرز یا سطح جدیدی در سایه نمی‌سازد. */
    const fullProfile = chainPolyline(orderChain(segs));
    if (fullProfile.length < 2) return "";
    let d = "";
    fullProfile.forEach((point, i) => {
      const [x, y] = screenPt(cam, point.z, point.r);
      d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    for (let i = fullProfile.length - 1; i >= 0; i--) {
      const [x, y] = screenPt(cam, fullProfile[i].z, -fullProfile[i].r);
      d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d + "Z";
  }, [segs, cam, settings.showGhost]);

  /* ---------- مسیر SVG المان‌های اسکچ ---------- */
  const segPath = (s: SketchSeg, c: Cam, mirror = false): string => {
    const m = mirror ? -1 : 1;
    const P = (p: SPoint) => screenPt(c, p.z, m * p.r);
    if (s.kind === "line") {
      const [x1, y1] = P(s.a);
      const [x2, y2] = P(s.b);
      return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    if (s.kind === "quad" && s.c1) {
      const [x1, y1] = P(s.a);
      const [cx, cy] = P(s.c1);
      const [x2, y2] = P(s.b);
      return `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    if (s.kind === "cubic" && s.c1 && s.c2) {
      const [x1, y1] = P(s.a);
      const [p1x, p1y] = P(s.c1);
      const [p2x, p2y] = P(s.c2);
      const [x2, y2] = P(s.b);
      return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${p1x.toFixed(1)} ${p1y.toFixed(1)}, ${p2x.toFixed(1)} ${p2y.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    const pts = segPoints(s);
    let d = "";
    pts.forEach((p, i) => {
      const [x, y] = P(p);
      d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    return d;
  };

  if (!cam || size.w === 0) return <div ref={wrapRef} className="relative h-full w-full" />;

  const P = (z: number, r: number) => screenPt(cam, z, r);
  const lineD = (l: ELine): string => {
    const a = vz(l.va);
    const b = vz(l.vb);
    const [x1, y1] = screenPt(cam, a.z, a.x / 2);
    const [x2, y2] = screenPt(cam, b.z, b.x / 2);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  /* تمام Segmentهای انتخابی در دو path مرکب رندر می‌شوند، نه صدها path دارای
     Gaussian blur. این کار تعداد nodeها و هزینهٔ GPU را هنگام pan ثابت نگه می‌دارد. */
  let selectedLinesPath = "";
  let activeLinePath = "";
  const selectedSpeedPaths = new Map<string, string>();
  if (editOpen && toolpathLayersVisible && selectedLineIds.size) {
    for (const line of lines) {
      if (!selectedLineIds.has(line.id)) continue;
      const d = `${lineD(line)} `;
      if (line.id === activeLine) {
        activeLinePath += d;
      } else {
        selectedLinesPath += d;
        const color = speedStroke(line.motion, line.feed);
        selectedSpeedPaths.set(color, `${selectedSpeedPaths.get(color) ?? ""}${d}`);
      }
    }
  }
  let rangePreviewPath = "";
  for (const id of rangePreview) {
    const line = lineById.get(id);
    if (line) rangePreviewPath += `${lineD(line)} `;
  }

  const pathStart = editOpen && lines.length ? vz(lines[0].va) : null;
  const pathEnd = editOpen && lines.length ? vz(lines[lines.length - 1].vb) : null;
  const pathEndsCoincident = !!pathStart && !!pathEnd && Math.hypot(pathStart.z - pathEnd.z, pathStart.x - pathEnd.x) < 1e-7;
  const selVids = new Set<number>();
  if (editOpen) {
    for (const id of selL) {
      const l = lineById.get(id);
      if (l) {
        selVids.add(l.va);
        selVids.add(l.vb);
      }
    }
    for (const v of selV) selVids.add(v);
  }
  type GridTick = { value: number; major: boolean };
  const makeGridTicks = (min: number, max: number, step: number, divisions: number): GridTick[] => {
    const first = Math.ceil((min - 1e-9) / step);
    const last = Math.floor((max + 1e-9) / step);
    const count = Math.max(0, last - first + 1);
    /* در زوم‌های خیلی دور، تعداد SVG nodeها محدود می‌شود تا پن/زوم روان بماند. */
    const stride = Math.max(1, Math.ceil(count / 500));
    const out: GridTick[] = [];
    for (let i = first; i <= last; i += stride) {
      if (i === 0) continue; // مبدأ و محورها جداگانه و همیشه واضح رسم می‌شوند.
      out.push({ value: Math.round(i * step * 1e6) / 1e6, major: i % divisions === 0 });
    }
    return out;
  };
  const editGridMain = Math.min(500, Math.max(1, settings.editGridSize));
  const editGridDivisions = Math.min(20, Math.max(1, Math.round(settings.editGridDivisions)));
  /* طراحی پروفایل و ویرایش مسیر دقیقاً از یک اندازهٔ گرید و تقسیمات استفاده می‌کنند. */
  const gridStep = editGridMain / editGridDivisions;
  const gridZ = editOpen
    ? makeGridTicks((0 - cam.ox) / cam.s, (size.w - cam.ox) / cam.s, gridStep, editGridDivisions)
    : makeGridTicks(0, L, gridStep, editGridDivisions);
  const gridR = editOpen
    ? makeGridTicks((cam.oy - size.h) / cam.s, cam.oy / cam.s, gridStep, editGridDivisions)
    : makeGridTicks(-R, R, gridStep, editGridDivisions);
  const gridVisible = !editOpen || settings.editGridVisible;

  const iso = isolatedOpId != null;
  const isoOp = iso ? ops.find((o) => o.id === isolatedOpId) ?? null : null;
  const fadeStyle = { transition: "opacity .3s ease" } as const;
  const snapLabel = settings.snap === 0 ? "آزاد" : `${settings.snap}`;
  const selSegs = segs.filter((s) => selected.includes(s.id));
  const one = selSegs.length === 1 ? selSegs[0] : null;

  /* المان زیر نشانگر و وضعیت قفل بودنش برای نمایش نشانگر مناسب */
  const hoverSeg = hoverId != null ? segs.find((s) => s.id === hoverId) : null;
  const hoverLocked = hoverSeg
    ? (() => {
        const allowed = selected.includes(hoverSeg.id) ? selected : [hoverSeg.id];
        return allowed.some((id) => segLocked(id, allowed));
      })()
    : false;
  /* آیا گروه انتخاب‌شده به المان دیگری متصل است (و در نتیجه قفل)؟ */
  const selLocked = selected.length > 0 && selected.some((id) => segLocked(id, selected));

  /* المان‌هایی که دسته‌های کنترل و نقاطشان نمایش داده می‌شود: یا المان انتخاب شده
     یا حداقل یک نقطه‌اش مستقل انتخاب شده است */
  const handleSegs = segs.filter((s) => selected.includes(s.id) || selPointSegIds.includes(s.id));

  /* پیش‌نمایش ترسیم */
  let previewSeg: SketchSeg | null = null;
  if (tool !== "select" && draft.length > 0 && cursor) {
    const pts = [...draft];
    if (tool === "cubic" && pts.length === 4) {
      /* اگر دستهٔ دوم هنوز ثبت نشده (draftSecondSet=false)، نشانگر دستهٔ متصل به  */
      /* پایان (c2) را جابه‌جا می‌کند؛ وگرنه دستهٔ متصل به شروع (c1) را.            */
      if (!draftSecondSet.current) pts[3] = cursor;
      else pts[2] = cursor;
      previewSeg = makeSeg("cubic", pts);
    } else if (tool === "cubic" && pts.length === 3) {
      previewSeg = makeSeg("cubic", [...pts, cursor]);
    } else {
      previewSeg = makeSeg(tool as SketchKind, [...pts, cursor]);
      if (!previewSeg && pts.length === 1) previewSeg = makeSeg("line", [pts[0], cursor]);
    }
  }
  /* ایندکس مرحلهٔ فعلی — برای منحنی کنترلی بر اساس وضعیت دسته‌ها */
  let stepIdx: number;
  if (tool === "cubic") {
    if (draft.length === 0) stepIdx = 0;
    else if (draft.length === 1) stepIdx = 1;
    else stepIdx = draftSecondSet.current ? 3 : 2; // ۲ = دستهٔ c2، ۳ = دستهٔ c1
  } else {
    stepIdx = draft.length;
  }
  const stepText = tool !== "select" && tool !== "move" ? STEP_HINT[tool][Math.min(stepIdx, STEP_HINT[tool].length - 1)] : "";

  /* اندازهٔ زندهٔ خط در حال ترسیم */
  let liveInfo = "";
  if (tool !== "select" && tool !== "move" && draft.length >= 1 && cursor) {
    const a = draft[0];
    const b = draft.length === 1 ? cursor : draft[1];
    liveInfo = `طول ${dist(a, b).toFixed(1)}  •  زاویه ${lineAngle(a, b).toFixed(1)}°`;
  }

  const concise = (value: number) => {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };
  let moveReadout = "0, 0";
  if (moveSession) {
    const editBase = moveSession.editBase?.find((vertex) => moveSession.editVertexIds?.includes(vertex.id));
    const editCurrent = editBase ? edit?.verts.find((vertex) => vertex.id === editBase.id) : null;
    const base = moveSession.base.find((segment) => moveSession.ids.includes(segment.id));
    const current = base ? segs.find((segment) => segment.id === base.id) : null;
    const bz = editBase?.z ?? base?.a.z, br = editBase ? editBase.x / 2 : base?.a.r;
    const cz = editCurrent?.z ?? current?.a.z, cr = editCurrent ? editCurrent.x / 2 : current?.a.r;
    if (bz != null && br != null && cz != null && cr != null) {
      moveReadout = moveSession.mode === "absolute"
        ? `${concise(cz)}, ${concise(cr)} · ABS`
        : `${concise(cz - bz)}, ${concise(cr - br)}`;
    }
  }

  const filletRadius = filletBox ? arithmeticValue(filletBox.value) : null;
  const filletLines = filletPicks.length === 2
    ? filletPicks.map((pick) => segs.find((segment) => segment.id === pick.id))
    : [];
  const filletCalc = filletLines.length === 2 && filletLines[0] && filletLines[1] && filletRadius != null
    ? buildLineFillet(filletLines[0], filletLines[1], filletPicks[0].click, filletPicks[1].click, filletRadius, L, R)
    : null;

  const confirmFillet = () => {
    if (!filletBox || !filletCalc?.result || filletRadius == null) {
      if (filletBox) setFilletBox({ ...filletBox, error: filletCalc?.error ?? "شعاع نامعتبر" });
      return;
    }
    const result = filletCalc.result;
    const pair = [result.first.id, result.second.id].sort((a, b) => a - b) as [number, number];
    const arc: SketchSeg = { ...result.arc, id: newSegId(), filletOf: pair };
    const sourceLines = [
      segs.find((segment) => segment.id === pair[0]),
      segs.find((segment) => segment.id === pair[1]),
    ].filter((segment): segment is SketchSeg => !!segment);
    const touches = (candidate: SketchSeg, line: SketchSeg) =>
      [candidate.a, candidate.b].some((point) => [line.a, line.b].some((end) => dist(point, end) < 1e-5));
    /* روی یک جفت خط فقط یک Fillet معتبر می‌ماند. علاوه بر metadata، اتصال
       هندسی نیز بررسی می‌شود تا Filletهای ساخته‌شده با نسخه‌های قدیمی جایگزین شوند. */
    const withoutPrevious = segs.filter((segment) => {
      if (segment.kind !== "arc" || segment.id === result.first.id || segment.id === result.second.id) return true;
      const tagged = segment.filletOf && [...segment.filletOf].sort((a, b) => a - b).every((id, i) => id === pair[i]);
      const geometricallyAttached = sourceLines.length === 2 && touches(segment, sourceLines[0]) && touches(segment, sourceLines[1]);
      return !tagged && !geometricallyAttached;
    });
    commit(withoutPrevious.map((segment) => segment.id === result.first.id ? result.first : segment.id === result.second.id ? result.second : segment).concat(arc));
    onSelected([arc.id]);
    setFilletPicks([]); setFilletBox(null);
  };

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative h-full w-full overflow-hidden rounded-lg border border-edge",
        editOpen ? "bg-[#08111f]" : "bg-[#120e09]"
      )}
    >
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className={cn(
          "block touch-none select-none",
          panMode
            ? "cursor-grab"
            : tool === "move"
              ? "cursor-move"
              : tool !== "select"
                ? "cursor-crosshair"
              : marquee
                ? "cursor-crosshair"
                : hoverPathEndpoint != null
                  ? "cursor-move"
                  : hoverId != null
                  ? hoverLocked
                    ? "cursor-default"
                    : "cursor-move"
                  : "cursor-default"
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!drag.current) {
            setHoverBuf(null);
            setHoverPathEndpoint(null);
            setSplitHovered(false);
          }
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
      >
        <defs>
          {/* userSpaceOnUse مانع صفرشدن محدوده فیلتر برای خطوط کاملاً افقی/عمودی می‌شود. */}
          <filter id="curveGlow" filterUnits="userSpaceOnUse" x="-10000" y="-10000" width="20000" height="20000">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="7" height="7" fill="rgba(227,169,78,0.05)" />
            <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(227,169,78,0.10)" strokeWidth="1.4" />
          </pattern>
        </defs>

        {/* گرید: در حالت ادیت تمام فضای ماشین را می‌پوشاند؛ در طراحی فقط محدوده قطعه */}
        {gridVisible && (
          <g pointerEvents="none">
            {gridZ.map((tick) => {
              const sx = cam.ox + tick.value * cam.s;
              return (
                <line
                  key={`v${tick.value}`}
                  x1={sx}
                  y1={editOpen ? 0 : cam.oy - R * cam.s}
                  x2={sx}
                  y2={editOpen ? size.h : cam.oy + R * cam.s}
                  stroke={tick.major ? "rgba(63,79,101,0.42)" : "rgba(31,45,63,0.42)"}
                  strokeWidth={tick.major ? 1 : 0.75}
                />
              );
            })}
            {gridR.map((tick) => {
              const sy = cam.oy - tick.value * cam.s;
              return (
                <line
                  key={`h${tick.value}`}
                  x1={editOpen ? 0 : cam.ox}
                  y1={sy}
                  x2={editOpen ? size.w : cam.ox + L * cam.s}
                  y2={sy}
                  stroke={tick.major ? "rgba(63,79,101,0.42)" : "rgba(31,45,63,0.42)"}
                  strokeWidth={tick.major ? 1 : 0.75}
                />
              );
            })}

            {!editOpen && (
              <>
                {gridZ.filter((tick) => tick.major).map((tick) => (
                  <text key={`lz${tick.value}`} x={cam.ox + tick.value * cam.s} y={cam.oy + R * cam.s + 18} textAnchor="middle" fontSize="10" fill="#8b7c5f" fontFamily="JetBrains Mono, monospace">
                    {tick.value}
                  </text>
                ))}
                {gridR.filter((tick) => tick.value > 0).map((tick) => (
                  <text key={`lr${tick.value}`} x={cam.ox - 8} y={cam.oy - tick.value * cam.s + 3.5} textAnchor="end" fontSize="10" fill="#8b7c5f" fontFamily="JetBrains Mono, monospace">
                    ⌀{Math.round(tick.value * 2)}
                  </text>
                ))}
                <text x={cam.ox + L * cam.s + 10} y={cam.oy + 3.5} fontSize="11" fill="#a8946f" fontFamily="JetBrains Mono, monospace" fontWeight={700}>X</text>
                <text x={cam.ox - 8} y={cam.oy - R * cam.s - 10} textAnchor="end" fontSize="11" fill="#a8946f" fontFamily="JetBrains Mono, monospace" fontWeight={700}>Y ⌀</text>
              </>
            )}
          </g>
        )}

        {!editOpen && <line x1={0} y1={cam.oy} x2={size.w} y2={cam.oy} stroke="rgba(227,169,78,0.35)" strokeWidth={1} strokeDasharray="10 4 2 4" />}
        <rect
          x={cam.ox}
          y={cam.oy - R * cam.s}
          width={L * cam.s}
          height={2 * R * cam.s}
          fill={editOpen ? "transparent" : "url(#hatch)"}
          stroke={editOpen ? "rgba(55,72,94,0.22)" : "rgba(227,169,78,0.55)"}
          strokeWidth={editOpen ? 0.8 : 1.3}
          strokeDasharray={editOpen ? undefined : "7 5"}
        />

        {/* محورهای ساده و نازک مثل مرجع؛ تقاطع آن‌ها خودِ مبدأ است. */}
        {editOpen && (
          <g pointerEvents="none">
            <line x1={0} y1={cam.oy} x2={size.w} y2={cam.oy} stroke="#754052" strokeOpacity={0.9} strokeWidth={1} />
            <line x1={cam.ox} y1={0} x2={cam.ox} y2={size.h} stroke="#3b7373" strokeOpacity={0.9} strokeWidth={1} />
          </g>
        )}

        {!editOpen && settings.showGhost && ghostPath && (
          <g style={{ opacity: (iso ? 0.15 : 1) * layerOpacity, ...fadeStyle }}>
            <path d={ghostPath} fill="rgba(227,169,78,0.12)" stroke="rgba(227,169,78,0.4)" strokeWidth={1} />
          </g>
        )}
        {/* مسیر ابزار */}
        <g>
          {runs.map((run, i) => {
            if (editOpen || !settings[KIND_VISIBLE[run.kind]]) return null;
            const isRapid = run.motion === 0;
            const matchIso = iso && run.opId === isolatedOpId;
            const dim = iso && !matchIso;
            if (dim && isRapid) return null;
            const color = SEG_COLOR[run.kind];
            const baseOpacity = isRapid ? 0.28 : run.kind === "offset" || run.kind === "boreoff" ? 0.9 : 0.8;
            return (
              <g key={i} style={{ opacity: (dim ? 0.06 : 1) * layerOpacity, ...fadeStyle }}>
                <path d={run.d} fill="none" stroke={color} strokeOpacity={matchIso ? 1 : baseOpacity} strokeWidth={(isRapid ? 1 : run.kind === "finish" ? 1.8 : 1.4) + (matchIso ? 0.7 : 0)} strokeDasharray={isRapid ? "4 4" : run.kind === "offset" || run.kind === "boreoff" ? "7 4" : undefined} strokeLinejoin="round" strokeLinecap="round" filter={matchIso ? "url(#curveGlow)" : undefined} />
                {run.arrows && !dim && <path d={run.arrows} fill={color} fillOpacity={0.95} />}
              </g>
            );
          })}
        </g>

        {/* ---------- حالت ویرایش مسیر — کل مسیر، یک زنجیرۀ پیوسته؛ رنگ هر عملیات مثل قبل ---------- */}
        {editOpen && (
          <g>
            {bufRuns.map((run, i) => {
              const isRapid = run.motion === 0;
              const matchIso = iso && run.opId === isolatedOpId;
              const dim = iso && !matchIso;
              if (dim && isRapid) return null;
              return (
                <path
                  key={`br${i}`}
                  d={run.d}
                  fill="none"
                  stroke={showPathBySpeed ? speedStroke(run.motion, run.feed) : SEG_COLOR[run.kind]}
                  strokeOpacity={(pickerHover ? (dim ? 0.025 : 0.1) : dim ? 0.06 : matchIso ? 1 : isRapid ? 0.4 : 0.9) * layerOpacity}
                  strokeWidth={(isRapid ? 1.1 : run.kind === "finish" ? 1.8 : 1.5) + (matchIso ? 0.7 : 0)}
                  strokeDasharray={isRapid ? "4 4" : run.kind === "offset" || run.kind === "boreoff" ? "7 4" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  filter={matchIso ? "url(#curveGlow)" : undefined}
                />
              );
            })}

            {/* پیش‌نمایش گزینه زیر نشانگر در انتخاب‌گر هم‌پوشانی */}
            {pickerHover?.kind === "line" && lineById.get(pickerHover.id) && (() => {
              const line = lineById.get(pickerHover.id)!;
              const kind: SegKind = line.motion === 0 ? "rapid" : line.kind;
              return (
                <path
                  d={lineD(line)}
                  fill="none"
                  stroke={showPathBySpeed ? speedStroke(line.motion, line.feed) : SEG_COLOR[kind]}
                  strokeWidth={5}
                  strokeOpacity={1}
                  strokeLinecap="round"
                  filter="url(#curveGlow)"
                  pointerEvents="none"
                />
              );
            })()}
            {showPathPoints && pickerHover?.kind === "vert" && vById.get(pickerHover.id) && (() => {
              const vertex = vz(pickerHover.id);
              const [x, y] = P(vertex.z, vertex.x / 2);
              return (
                <g pointerEvents="none" filter="url(#curveGlow)">
                  <circle cx={x} cy={y} r={10} fill="#ffd27a" fillOpacity={0.24} stroke="#ffd27a" strokeWidth={3} />
                  <circle cx={x} cy={y} r={3.5} fill="#fff3dc" />
                </g>
              );
            })()}

            {/* نشانگرهای ثابت ابتدا و انتهای Polyline */}
            {toolpathLayersVisible && pathStart && (() => {
              const [x, y] = P(pathStart.z, pathStart.x / 2);
              const hot = hoverPathEndpoint === pathStartVid;
              const selected = pathStartVid != null && selV.includes(pathStartVid);
              return (
                <g transform={`translate(${x + (pathEndsCoincident ? -13 : 0)} ${y})`} pointerEvents="none" filter="url(#curveGlow)">
                  {pathEndsCoincident && <line x1={8} y1={0} x2={13} y2={0} stroke="#45d19f" strokeWidth={2} />}
                  {(hot || selected) && <circle r={13} fill="#45d19f" fillOpacity={hot ? 0.28 : 0.18} stroke={selected ? "#ffd27a" : "#8fffd7"} strokeWidth={2} />}
                  <circle r={hot || selected ? 9.5 : 8} fill={selected ? "#ffd27a" : hot ? "#17483b" : "#102b24"} stroke={selected ? "#fff3dc" : "#45d19f"} strokeWidth={2.5} />
                  <text y={3.2} textAnchor="middle" fontSize={9} fontWeight={900} fill="#8fffd7">S</text>
                  <text x={11} y={-9} fontSize={9} fontWeight={800} fill="#8fffd7">شروع</text>
                </g>
              );
            })()}
            {toolpathLayersVisible && pathEnd && (() => {
              const [x, y] = P(pathEnd.z, pathEnd.x / 2);
              const hot = hoverPathEndpoint === pathEndVid;
              const selected = pathEndVid != null && selV.includes(pathEndVid);
              return (
                <g transform={`translate(${x + (pathEndsCoincident ? 13 : 0)} ${y})`} pointerEvents="none" filter="url(#curveGlow)">
                  {pathEndsCoincident && <line x1={-8} y1={0} x2={-13} y2={0} stroke="#ff756f" strokeWidth={2} />}
                  {(hot || selected) && <circle r={16} fill="#ff756f" fillOpacity={hot ? 0.25 : 0.16} stroke={selected ? "#ffd27a" : "#ffc0bc"} strokeWidth={2} />}
                  <path d={hot || selected ? "M 0 -13 L 13 0 L 0 13 L -13 0 Z" : "M 0 -11 L 11 0 L 0 11 L -11 0 Z"} fill={selected ? "#ffd27a" : hot ? "#592325" : "#35191a"} fillOpacity={0.9} stroke={selected ? "#fff3dc" : "#ff756f"} strokeWidth={2.5} />
                  <text y={3.2} textAnchor="middle" fontSize={9} fontWeight={900} fill="#ffc0bc">E</text>
                  <text x={13} y={13} fontSize={9} fontWeight={800} fill="#ffc0bc">پایان</text>
                </g>
              );
            })()}

            {/* منحنی‌های افست — ۱:۱ با پروفایل، مستقل‌قابل‌ویرایش */}
            {offSegs.map((o) => {
              const sel = selOff.includes(o.id);
              return (
                <path
                  key={`of${o.id}`}
                  d={segPath(o, cam)}
                  fill="none"
                  stroke={sel ? "#ffe9b0" : "#d9b36a"}
                  strokeOpacity={sel ? 1 : 0.72}
                  strokeWidth={sel ? 2.6 : 1.5}
                  strokeDasharray="6 3"
                  strokeLinecap="round"
                  filter={sel ? "url(#curveGlow)" : undefined}
                />
              );
            })}
            {offSegs.map((o) => {
              const sel = selOff.includes(o.id);
              const [ax, ay] = P(o.a.z, o.a.r);
              const [bx, by] = P(o.b.z, o.b.r);
              const c1 = o.c1 ? P(o.c1.z, o.c1.r) : null;
              const c2 = o.c2 ? P(o.c2.z, o.c2.r) : null;
              const via = o.via ? P(o.via.z, o.via.r) : null;
              return (
                <g key={`oh${o.id}`}>
                  {sel && c1 && (
                    <>
                      <line x1={ax} y1={ay} x2={c1[0]} y2={c1[1]} stroke="#6ab0d8" strokeWidth={1} strokeDasharray="3 3" />
                      <circle cx={c1[0]} cy={c1[1]} r={5} fill="#1b2a33" stroke="#6ab0d8" strokeWidth={2} />
                    </>
                  )}
                  {sel && c2 && (
                    <>
                      <line x1={bx} y1={by} x2={c2[0]} y2={c2[1]} stroke="#6ab0d8" strokeWidth={1} strokeDasharray="3 3" />
                      <circle cx={c2[0]} cy={c2[1]} r={5} fill="#1b2a33" stroke="#6ab0d8" strokeWidth={2} />
                    </>
                  )}
                  {sel && via && <circle cx={via[0]} cy={via[1]} r={5} fill="#2b1f33" stroke="#b48ee0" strokeWidth={2} />}
                  <circle cx={ax} cy={ay} r={sel ? 5.2 : 3.6} fill={sel ? "#0f2a22" : "#241c12"} stroke={sel ? "#ffe9b0" : "#d9b36a"} strokeWidth={2} />
                  <circle cx={bx} cy={by} r={sel ? 5.2 : 3.6} fill={sel ? "#0f2a22" : "#241c12"} stroke={sel ? "#ffe9b0" : "#d9b36a"} strokeWidth={2} />
                </g>
              );
            })}
            {hoverBuf != null && lineById.get(hoverBuf) && (
              <path d={lineD(lineById.get(hoverBuf)!)} fill="none" stroke="#fff3dc" strokeOpacity={pickerHover ? 0.08 : 0.9} strokeWidth={2.4} strokeLinecap="round" pointerEvents="none" />
            )}
            {bufMarq?.ids.map((id) => {
              const l = lineById.get(id);
              return l ? <path key={`bm${id}`} d={lineD(l)} fill="none" stroke="#ffffff" strokeOpacity={pickerHover ? 0.08 : 0.8} strokeWidth={2.2} strokeLinecap="round" /> : null;
            })}
            {/* هایلایت انتخاب با pathهای مرکب و glow سبکِ مبتنی بر stroke؛
                از Gaussian blur پرهزینه برای تک‌تک Segmentها استفاده نمی‌شود. */}
            {selectedLinesPath && (
              <>
                <path d={selectedLinesPath} fill="none" stroke="#45b394" strokeOpacity={pickerHover ? 0.02 : 0.2} strokeWidth={7} strokeLinecap="round" pointerEvents="none" />
                {showPathBySpeed ? [...selectedSpeedPaths].map(([color, d]) => (
                  <path key={color} d={d} fill="none" stroke={color} strokeOpacity={pickerHover ? 0.08 : 1} strokeWidth={3.2} strokeLinecap="round" pointerEvents="none" />
                )) : (
                  <path d={selectedLinesPath} fill="none" stroke="#45b394" strokeOpacity={pickerHover ? 0.08 : 1} strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
                )}
              </>
            )}
            {/* خط Active فقط با رنگ آبی روشن مشخص می‌شود؛ بدون Glow یا تغییر ضخامت. */}
            {activeLinePath && (
              <path d={activeLinePath} fill="none" stroke="#7bb8ff" strokeOpacity={pickerHover ? 0.08 : 1} strokeWidth={3.2} strokeLinecap="round" pointerEvents="none" />
            )}
            {/* پیش‌نمایش موقت انتخاب بازه‌ای؛ تا پیش از Shift+کلیک وارد تاریخچه نمی‌شود. */}
            {rangePreviewPath && (
              <>
                <path d={rangePreviewPath} fill="none" stroke="#fff3dc" strokeOpacity={0.18} strokeWidth={10} strokeLinecap="round" pointerEvents="none" />
                <path d={rangePreviewPath} fill="none" stroke="#fff3dc" strokeOpacity={0.82} strokeWidth={5.2} strokeLinecap="round" pointerEvents="none" />
              </>
            )}
            {/* رأس‌های خطوط انتخابی — هر رأس یک نقطه (اشتراک‌ها هم‌مکان‌اند، دو‌تایی نمی‌شود) */}
            {showPathPoints && [...selVids].map((vid) => {
              const v = vz(vid);
              const [x, y] = P(v.z, v.x / 2);
              const on = selV.includes(vid);
              const shared = (vertexLineCount.get(vid) ?? 0) > 1;
              return (
                <g key={`bv${vid}`} opacity={pickerHover ? 0.1 : 1}>
                  <circle className="pt-hover" cx={x} cy={y} r={5.5} fill={shared ? "#0f2a22" : "#120e09"} stroke="#45b394" strokeWidth={2.4} />
                  {on && <circle cx={x} cy={y} r={2.1} fill="#45b394" pointerEvents="none" />}
                </g>
              );
            })}
          </g>
        )}

        {/* المان‌های اسکچ */}
        <g style={{ opacity: editOpen ? 0.12 : iso ? 0.3 : 1, ...fadeStyle }}>
          {/* رنگ شاخه‌ها مستقیماً از زنجیرهٔ تقسیم‌شده رسم می‌شود. بنابراین اگر
              Split وسط یک Arc/Bezier باشد، رنگ داخلی دقیقاً تا خود Split می‌رسد
              و کل منحنی جدید به اشتباه در یک سمت طبقه‌بندی نمی‌شود. */}
          {split.enabled && (() => {
            const divided = splitChainAt(chainPolyline(orderChain(segs)), { z: split.z, r: split.r });
            const pathOf = (points: SPoint[], mirror = false) => points.map((point, i) => {
              const [x, y] = P(point.z, mirror ? -point.r : point.r);
              return `${i ? "L" : "M"}${x},${y}`;
            }).join(" ");
            return <>
              <path d={pathOf(divided.outer, true)} fill="none" stroke={split.swapped ? "#4cc9f0" : "#e3a94e"} strokeOpacity={0.28} strokeWidth={1.6} strokeLinecap="round" />
              <path d={pathOf(divided.inner, true)} fill="none" stroke={split.swapped ? "#e3a94e" : "#4cc9f0"} strokeOpacity={0.28} strokeWidth={1.6} strokeLinecap="round" />
              <path d={pathOf(divided.outer)} fill="none" stroke={split.swapped ? "#4cc9f0" : "#f3c26b"} strokeWidth={2.4} strokeLinecap="round" />
              <path d={pathOf(divided.inner)} fill="none" stroke={split.swapped ? "#f3c26b" : "#4cc9f0"} strokeWidth={2.4} strokeLinecap="round" />
            </>;
          })()}
          {/* بدون Split، رنگ معمول هر المان استفاده می‌شود. */}
          {!split.enabled && segs.map((s) => (
            <path key={`m${s.id}`} d={segPath(s, cam, true)} fill="none" stroke="#e3a94e" strokeOpacity={0.28} strokeWidth={1.6} strokeLinecap="round" />
          ))}
          {segs.map((s) => {
            const sel = selected.includes(s.id);
            const hov = hoverId === s.id;
            const hasSelPt = selPointSegIds.includes(s.id);
            const base = segSide.get(s.id) === "inner" ? "#4cc9f0" : "#f3c26b";
            return (
              <path
                key={s.id}
                d={segPath(s, cam)}
                fill="none"
                stroke={sel ? "#45b394" : hasSelPt ? "#ffd27a" : hov ? "#fff3dc" : split.enabled ? "transparent" : base}
                strokeWidth={sel ? 3.2 : hasSelPt ? 3.4 : hov ? 3 : 2.4}
                strokeLinecap="round"
                filter={sel || hasSelPt ? "url(#curveGlow)" : undefined}
              />
            );
          })}

          {/* نشانهٔ قفل بودن المان زیر نشانگر (متصل به المان دیگر) */}
          {hoverSeg && hoverLocked && !selected.includes(hoverSeg.id) && (
            <path
              d={segPath(hoverSeg, cam)}
              fill="none"
              stroke="#d95848"
              strokeOpacity={0.75}
              strokeWidth={1.2}
              strokeDasharray="4 4"
              strokeLinecap="round"
              pointerEvents="none"
            />
          )}

          {/* دسته‌ها و نقاط المان‌های انتخاب‌شده یا دارای نقطهٔ مستقلِ انتخاب‌شده */}
          {handleSegs.map((s) => {
            const [ax, ay] = P(s.a.z, s.a.r);
            const [bx, by] = P(s.b.z, s.b.r);
            const pointIsActive = (part: HandleRef["part"]) =>
              selPoints.some((point) => point.segId === s.id && point.part === part) ||
              (drag.current?.mode === "handle" && drag.current.ref.segId === s.id && drag.current.ref.part === part);
            return (
              <g key={`h${s.id}`}>
                {s.c1 && (
                  <>
                    <line x1={ax} y1={ay} x2={P(s.c1.z, s.c1.r)[0]} y2={P(s.c1.z, s.c1.r)[1]} stroke="#6ab0d8" strokeWidth={1} strokeDasharray="3 3" />
                    <circle className="pt-hover" cx={P(s.c1.z, s.c1.r)[0]} cy={P(s.c1.z, s.c1.r)[1]} r={5} fill="#1b2a33" stroke="#6ab0d8" strokeWidth={2} />
                  </>
                )}
                {s.c2 && (
                  <>
                    <line x1={bx} y1={by} x2={P(s.c2.z, s.c2.r)[0]} y2={P(s.c2.z, s.c2.r)[1]} stroke="#6ab0d8" strokeWidth={1} strokeDasharray="3 3" />
                    <circle className="pt-hover" cx={P(s.c2.z, s.c2.r)[0]} cy={P(s.c2.z, s.c2.r)[1]} r={5} fill="#1b2a33" stroke="#6ab0d8" strokeWidth={2} />
                  </>
                )}
                {s.via && (
                  <circle className="pt-hover" cx={P(s.via.z, s.via.r)[0]} cy={P(s.via.z, s.via.r)[1]} r={5} fill="#2b1f33" stroke="#b48ee0" strokeWidth={2} />
                )}
                <circle className="pt-hover" cx={ax} cy={ay} r={5.5} fill="#0f2a22" stroke="#45b394" strokeWidth={2.4} />
                <circle className="pt-hover" cx={bx} cy={by} r={5.5} fill="#0f2a22" stroke="#45b394" strokeWidth={2.4} />
                {/* نقطه فعال داخل Handle و روی همه لایه‌های پایه رسم می‌شود. */}
                {s.c1 && pointIsActive("c1") && <circle cx={P(s.c1.z, s.c1.r)[0]} cy={P(s.c1.z, s.c1.r)[1]} r={2.1} fill="#6ab0d8" pointerEvents="none" />}
                {s.c2 && pointIsActive("c2") && <circle cx={P(s.c2.z, s.c2.r)[0]} cy={P(s.c2.z, s.c2.r)[1]} r={2.1} fill="#6ab0d8" pointerEvents="none" />}
                {s.via && pointIsActive("via") && <circle cx={P(s.via.z, s.via.r)[0]} cy={P(s.via.z, s.via.r)[1]} r={2.1} fill="#b48ee0" pointerEvents="none" />}
                {pointIsActive("a") && <circle cx={ax} cy={ay} r={2.1} fill="#45b394" pointerEvents="none" />}
                {pointIsActive("b") && <circle cx={bx} cy={by} r={2.1} fill="#45b394" pointerEvents="none" />}
              </g>
            );
          })}

        </g>

        {/* پیش‌نمایش ترسیم */}
        {previewSeg && (
          <g>
            <path d={segPath(previewSeg, cam)} fill="none" stroke="#45b394" strokeWidth={2.2} strokeDasharray="6 4" strokeLinecap="round" opacity={0.95} />
            {previewSeg.kind === "cubic" && previewSeg.c1 && previewSeg.c2 ? (
              <>
                {/* خطوط اتصال دسته‌ها به نقاط انتهایی */}
                <line x1={P(previewSeg.a.z, previewSeg.a.r)[0]} y1={P(previewSeg.a.z, previewSeg.a.r)[1]} x2={P(previewSeg.c1.z, previewSeg.c1.r)[0]} y2={P(previewSeg.c1.z, previewSeg.c1.r)[1]} stroke="#6ab0d8" strokeWidth={1.2} strokeDasharray="3 3" />
                <line x1={P(previewSeg.b.z, previewSeg.b.r)[0]} y1={P(previewSeg.b.z, previewSeg.b.r)[1]} x2={P(previewSeg.c2.z, previewSeg.c2.r)[0]} y2={P(previewSeg.c2.z, previewSeg.c2.r)[1]} stroke="#6ab0d8" strokeWidth={1.2} strokeDasharray="3 3" />
                {/* نقاط شروع و پایان */}
                <circle cx={P(previewSeg.a.z, previewSeg.a.r)[0]} cy={P(previewSeg.a.z, previewSeg.a.r)[1]} r={4.5} fill="#0f2a22" stroke="#45b394" strokeWidth={2} />
                <circle cx={P(previewSeg.b.z, previewSeg.b.r)[0]} cy={P(previewSeg.b.z, previewSeg.b.r)[1]} r={4.5} fill="#0f2a22" stroke="#45b394" strokeWidth={2} />
                {/* دستهٔ در حال تنظیم برجسته‌تر: ابتدا c2 (پایان)، سپس c1 (شروع) */}
                <circle cx={P(previewSeg.c1.z, previewSeg.c1.r)[0]} cy={P(previewSeg.c1.z, previewSeg.c1.r)[1]} r={draftSecondSet.current ? 6 : 4} fill="#1b2a33" stroke={draftSecondSet.current ? "#f3c26b" : "#6ab0d8"} strokeWidth={2} />
                <circle cx={P(previewSeg.c2.z, previewSeg.c2.r)[0]} cy={P(previewSeg.c2.z, previewSeg.c2.r)[1]} r={!draftSecondSet.current ? 6 : 4} fill="#1b2a33" stroke={!draftSecondSet.current ? "#f3c26b" : "#6ab0d8"} strokeWidth={2} />
              </>
            ) : (
              draft.map((p, i) => (
                <circle key={i} cx={P(p.z, p.r)[0]} cy={P(p.z, p.r)[1]} r={4.5} fill="#0f2a22" stroke="#45b394" strokeWidth={2} />
              ))
            )}
          </g>
        )}
        {/* نشانگر سبز ابزار رسم هنگام Drag نقطه/دسته پنهان می‌شود؛ در غیر این
            صورت در موقعیت شروع Drag باقی می‌ماند و با خود هندسه اشتباه می‌شود. */}
        {tool !== "select" && tool !== "move" && cursor && drag.current?.mode !== "handle" && (
          <circle cx={P(cursor.z, cursor.r)[0]} cy={P(cursor.z, cursor.r)[1]} r={4} fill="none" stroke="#45b394" strokeWidth={1.6} />
        )}

        {/* نشانگر اسنپ */}
        {snapHit && (
          <g>
            <rect
              x={P(snapHit.p.z, snapHit.p.r)[0] - 6}
              y={P(snapHit.p.z, snapHit.p.r)[1] - 6}
              width={12}
              height={12}
              fill="none"
              stroke={SNAP_COLOR[snapHit.type] ?? "#45b394"}
              strokeWidth={2}
            />
            <text
              x={P(snapHit.p.z, snapHit.p.r)[0] + 10}
              y={P(snapHit.p.z, snapHit.p.r)[1] - 9}
              fontSize={9.5}
              fontFamily="Vazirmatn, sans-serif"
              fontWeight={700}
              fill={SNAP_COLOR[snapHit.type] ?? "#45b394"}
              stroke="#120e09"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {SNAP_FA[snapHit.type]}
            </text>
          </g>
        )}

        {/* نشانگر نقاط جداشده (unjoined) — حلقهٔ قرمزِ بریده */}
        <g>
          {[...separated].map((key) => {
            const [sid, part] = key.split(":");
            const s = segs.find((x) => x.id === Number(sid));
            const p = s ? s[part as "a" | "b"] : null;
            if (!s || !p) return null;
            const [x, y] = P(p.z, p.r);
            return (
              <g key={`sep-${key}`}>
                <circle cx={x} cy={y} r={8} fill="rgba(217,88,72,0.12)" stroke="#d95848" strokeWidth={1.6} strokeDasharray="3 2.5" />
                <line x1={x - 5} y1={y + 5} x2={x + 5} y2={y - 5} stroke="#d95848" strokeWidth={1.6} />
              </g>
            );
          })}
        </g>

        {/* نقطه Split */}
        {split.enabled && (
          <g>
            {(() => {
              const [x, y] = P(split.z, split.r);
              return (
                <g style={{ cursor: "pointer" }}>
                  {(splitSelected || splitHovered || marqueeSplitHit) && (
                    <circle
                      cx={x}
                      cy={y}
                      r={splitSelected ? 8 : 7}
                      fill={marqueeSplitHit ? "#4aa3ff" : "#f72585"}
                      fillOpacity={splitSelected ? 0.2 : 0.12}
                      stroke={splitSelected ? "#fff3dc" : marqueeSplitHit ? "#8fc5ff" : "#ff84bc"}
                      strokeWidth={splitSelected ? 1.6 : 1}
                    />
                  )}
                  <rect
                    x={x - 4}
                    y={y - 4}
                    width={8}
                    height={8}
                    transform={`rotate(45 ${x} ${y})`}
                    fill={splitSelected ? "#ffd27a" : splitHovered ? "#ff5ba6" : "#f72585"}
                    stroke="#120e09"
                    strokeWidth={1.2}
                  />
                  <circle cx={x} cy={y} r={1.25} fill="#ffffff" />
                </g>
              );
            })()}
          </g>
        )}

        {/* پیش‌نمایش نامزدهای باکس انتخاب */}
        {!editOpen && marquee &&
          marqueeHits.map((id) => {
            const s = segs.find((x) => x.id === id);
            if (!s || selected.includes(id)) return null;
            return (
              <path
                key={`pv-${id}`}
                d={segPath(s, cam)}
                fill="none"
                stroke={marquee.remove ? "#d95848" : marquee.x1 >= marquee.x0 ? "#4aa3ff" : "#3faf5d"}
                strokeWidth={4.5}
                strokeLinecap="round"
                strokeDasharray={marquee.remove ? "7 4" : undefined}
                opacity={0.75}
              />
            );
          })}

        {/* پیش‌نمایش نقاط نامزدِ داخل باکس */}
        {!editOpen && marquee &&
          marqueePointHits.map((ph, i) => {
            const s = segs.find((x) => x.id === ph.segId);
            const pt = s ? s[ph.part] : null;
            if (!s || !pt) return null;
            const [x, y] = P(pt.z, pt.r);
            const c = marquee.remove ? "#d95848" : "#ffd27a";
            return (
              <g key={`pvp-${i}`} pointerEvents="none">
                <circle cx={x} cy={y} r={8.5} fill="none" stroke={c} strokeWidth={1.8} strokeDasharray="3 2.5" opacity={0.9} />
                <circle cx={x} cy={y} r={3.4} fill={c} opacity={0.9} />
              </g>
            );
          })}

        {/* باکس انتخابگر: چپ‌به‌راست آبی توپر (فقط داخل) / راست‌به‌چپ سبز چین‌دار (متقاطع) */}
        {marquee && Math.hypot(marquee.x1 - marquee.x0, marquee.y1 - marquee.y0) > 4 && (
          <g>
            {(() => {
              const crossing = marquee.x1 < marquee.x0;
              const c = crossing ? "#3faf5d" : "#4aa3ff";
              const x = Math.min(marquee.x0, marquee.x1);
              const y = Math.min(marquee.y0, marquee.y1);
              const w = Math.abs(marquee.x1 - marquee.x0);
              const h = Math.abs(marquee.y1 - marquee.y0);
              return (
                <>
                  <rect x={x} y={y} width={w} height={h} fill={crossing ? "rgba(63,175,93,0.10)" : "rgba(74,163,255,0.10)"} stroke={c} strokeWidth={1.4} strokeDasharray={crossing ? "6 3" : undefined} />
                  <text x={x + 6} y={y - 7} fontSize={10.5} fontFamily="Vazirmatn, sans-serif" fontWeight={700} fill={c} stroke="#120e09" strokeWidth={3} paintOrder="stroke">
                    {crossing ? "متقاطع" : "پنجره‌ای"} • {editOpen ? (bufMarq?.ids.length ?? 0) : marqueeHits.length} المان، {editOpen ? (bufMarq?.vxs.length ?? 0) : marqueePointHits.length + (marqueeSplitHit ? 1 : 0)} نقطه
                    {marquee.remove ? " − حذف" : marquee.add ? " + افزودن" : ""}
                  </text>
                </>
              );
            })()}
          </g>
        )}

        {/* پیش‌نمایش Fillet: خطوط Trim‌شده و Arc مماس پیش از Enter */}
        {tool === "fillet" && filletCalc?.result && (
          <g pointerEvents="none" filter="url(#curveGlow)">
            <path d={segPath(filletCalc.result.first, cam)} fill="none" stroke="#ffd166" strokeWidth={3} strokeDasharray="7 3" />
            <path d={segPath(filletCalc.result.second, cam)} fill="none" stroke="#ffd166" strokeWidth={3} strokeDasharray="7 3" />
            <path d={segPath(filletCalc.result.arc, cam)} fill="none" stroke="#28dfc2" strokeWidth={3.5} />
          </g>
        )}

        {/* راهنمای شعاع Move: از مرکز دایرهٔ فرضی تا موقعیت زنده نشانگر */}
        {moveSession && (() => {
          const [x1, y1] = P(moveSession.origin.z, moveSession.origin.r);
          let guidePoint = moveSession.pointer;
          /* هنگام Shift خود راهنما نیز دقیقاً روی جهت قفل‌شده می‌نشیند. */
          if (moveSession.axis === "x") guidePoint = { z: guidePoint.z, r: moveSession.origin.r };
          else if (moveSession.axis === "y") guidePoint = { z: moveSession.origin.z, r: guidePoint.r };
          const guideParts = moveBox?.value.split(",") ?? [];
          const guideAmount = guideParts.length === 1 ? arithmeticValue(guideParts[0]) : null;
          if (guideAmount != null) {
            const dz = guidePoint.z - moveSession.origin.z;
            const dr = guidePoint.r - moveSession.origin.r;
            const distance = Math.hypot(dz, dr);
            const maxLength = Math.abs(guideAmount);
            if (distance > maxLength && distance > 1e-9) {
              guidePoint = {
                z: moveSession.origin.z + dz / distance * maxLength,
                r: moveSession.origin.r + dr / distance * maxLength,
              };
            }
          }
          const [x2, y2] = P(guidePoint.z, guidePoint.r);
          const guideColor = moveSession.axis === "x"
            ? "#754052"
            : moveSession.axis === "y"
              ? "#3b7373"
              : moveSession.mode === "absolute" ? "#a99cff" : "#28dfc2";
          return (
            <g pointerEvents="none">
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={guideColor} strokeWidth={1.2} strokeDasharray="5 4" opacity={0.95} />
              <circle cx={x1} cy={y1} r={3} fill="#071018" stroke={guideColor} strokeWidth={1.3} />
            </g>
          );
        })()}

      </svg>

      {/* ---------- منوی راست‌کلیک سرعت Segmentهای انتخاب‌شده ---------- */}
      {speedMenu && editOpen && selL.length > 0 && (
        <div
          dir="rtl"
          className="anim-in absolute z-30 w-64 overflow-hidden rounded-lg border border-edge2 bg-panel/97 shadow-2xl shadow-black/60 backdrop-blur-sm"
          style={{ left: Math.max(8, Math.min(speedMenu.x, size.w - 264)), top: Math.max(8, Math.min(speedMenu.y, size.h - 350)) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="border-b border-edge px-3 py-1.5 text-[10px] font-bold text-mute">
            تعیین سرعت · {selL.length.toLocaleString("fa-IR")} خط
          </div>
          <form
            className="flex flex-wrap items-center gap-1.5 px-2.5 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyManualSpeed();
            }}
          >
            <label htmlFor="manual-feed" className="ml-auto text-[10.5px] font-bold text-brass2">تعیین دستی سرعت</label>
            <input
              id="manual-feed"
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0–2000"
              value={manualSpeed}
              onChange={(e) => {
                const value = latinDigits(e.target.value);
                if (!/^\d*$/.test(value)) return;
                if (value !== "" && Number(value) > 2000) return;
                setManualSpeed(value);
                setSpeedError("");
              }}
              className="h-7 w-[68px] rounded border border-edge2 bg-panel3 px-1.5 text-center font-mono text-[11px] text-ink outline-none focus:border-brass"
            />
            <button type="submit" className="h-7 rounded border border-brass/55 bg-brass/15 px-2 text-[10.5px] font-bold text-brass2 transition-colors hover:bg-brass/25">
              تأیید
            </button>
            {speedError && <p className="w-full text-[9px] font-semibold text-red-400">{speedError}</p>}
          </form>
          <p className="border-t border-edge px-3 py-1 text-[9px] leading-4 text-dim">
            انتخاب F برای خط G0 آن را به G1 قابل‌کنترل تبدیل می‌کند؛ G0 استاندارد فیدر برنامه‌پذیر ندارد.
          </p>
          <button onClick={() => applySelectedSpeed(0)} className="flex w-full items-center gap-2 px-3 py-1.5 text-right text-[11.5px] font-semibold text-ink transition-colors hover:bg-panel3">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: speedStroke(0, RAPID_RATE) }} />
            <span className="font-mono">G0</span>
            <span className="mr-auto text-[9px] text-dim">حرکت سریع</span>
          </button>
          {SPEED_PRESETS.map((feed) => (
            <button key={feed} onClick={() => applySelectedSpeed(1, feed)} className="flex w-full items-center gap-2 px-3 py-1.5 text-right text-[11.5px] font-semibold text-ink transition-colors hover:bg-panel3">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: speedStroke(1, feed) }} />
              <span className="font-mono">G1 F{feed}</span>
            </button>
          ))}
        </div>
      )}

      {/* ---------- منوی راست‌کلیک نقطه Split ---------- */}
      {splitCtxMenu && (
        <div
          className="anim-in absolute z-30 w-44 overflow-hidden rounded-md border border-edge bg-panel/97 shadow-xl shadow-black/50 backdrop-blur-sm"
          style={{ left: Math.min(splitCtxMenu.x, size.w - 180), top: Math.min(splitCtxMenu.y, size.h - 82) }}
        >
          <button
            onClick={() => {
              onSplit({ ...split, swapped: !split.swapped });
              setSplitCtxMenu(null);
            }}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-right text-[11px] font-semibold text-ink transition-colors hover:bg-panel3"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" aria-hidden="true">
              <path d="M4 8.5C6.1 4.9 10.2 3.4 14 4.7l1.7.7" stroke="#f3c26b" strokeWidth="2.2" strokeLinecap="round" />
              <path d="m14.2 2.8 3.4 3.2-4.4 1" stroke="#f3c26b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 15.5c-2.1 3.6-6.2 5.1-10 3.8l-1.7-.7" stroke="#4cc9f0" strokeWidth="2.2" strokeLinecap="round" />
              <path d="m9.8 21.2-3.4-3.2 4.4-1" stroke="#4cc9f0" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>جابه‌جایی داخل و خارج</span>
          </button>
          <button
            onClick={cutSegmentAtSplit}
            className="flex w-full items-center gap-2 border-t border-edge px-2 py-1.5 text-right text-[11px] font-semibold text-ink transition-colors hover:bg-panel3"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="2.6" stroke="#4cc9f0" strokeWidth="1.8" />
              <circle cx="7" cy="17" r="2.6" stroke="#f3c26b" strokeWidth="1.8" />
              <path d="m9.2 8.4 10 7.4M9.2 15.6l10-7.4" stroke="#b9c7cf" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>تقسیم المان در Split</span>
          </button>
        </div>
      )}

      {/* ---------- منوی راست‌کلیک: اتصال / جداسازی نقطه ---------- */}
      {ctxMenu && (
        <div
          className="anim-in absolute z-20 w-44 overflow-hidden rounded-lg border border-edge2 bg-panel/97 shadow-2xl shadow-black/60 backdrop-blur-sm"
          style={{ left: Math.min(ctxMenu.x, size.w - 180), top: Math.min(ctxMenu.y, size.h - 120) }}
        >
          <div className="border-b border-edge px-3 py-1.5 text-[10px] font-bold text-mute">
            {ctxMenu.separated ? "نقطه جداشده" : ctxMenu.clusterSize > 1 ? `متصل به ${ctxMenu.clusterSize} نقطه` : "نقطهٔ تنها"}
          </div>
          {ctxMenu.separated ? (
            <button
              onClick={() => doJoin(ctxMenu.segId, ctxMenu.part)}
              className="flex w-full items-center gap-2 px-3 py-2 text-right text-[12px] font-semibold text-teal transition-colors hover:bg-teal/12"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-teal/15">
                <IconMagnetSm className="h-3 w-3" />
              </span>
              اتصال به هم‌جوار (Join)
            </button>
          ) : (
            <button
              onClick={() => doUnjoin(ctxMenu.segId, ctxMenu.part)}
              className="flex w-full items-center gap-2 px-3 py-2 text-right text-[12px] font-semibold text-copper transition-colors hover:bg-copper/12"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-copper/15">
                <IconX className="h-3 w-3" />
              </span>
              جداسازی (Unjoin)
            </button>
          )}
          <p className="border-t border-edge px-3 py-1.5 text-[9.5px] leading-4 text-dim">
            {ctxMenu.separated
              ? "نقطه به نزدیک‌ترین هم‌جوار می‌چسبد و دوباره با آن حرکت می‌کند"
              : "نقطه مستقل می‌شود و دیگر با نقاط هم‌مکان جابه‌جا نمی‌شود"}
          </p>
        </div>
      )}

      {filletBox && filletPicks.length === 2 && (
        <div className="absolute z-50 w-[126px] rounded-md border border-[#28dfc2]/70 bg-[#071018]/95 p-1.5 shadow-2xl" style={{ left: filletBox.x, top: filletBox.y }} dir="ltr">
          <div className="mb-1 text-[9px] font-bold text-[#28dfc2]">Radius</div>
          <input
            ref={filletInputRef}
            value={filletBox.value}
            aria-label="Fillet radius"
            className={cn("h-7 w-full rounded border bg-[#050b10] px-2 font-mono text-xs text-ink outline-none", filletBox.error || filletCalc?.error ? "border-danger" : "border-[#28dfc2]")}
            onChange={(e) => setFilletBox({ ...filletBox, value: e.target.value, error: "" })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") { setFilletPicks([]); setFilletBox(null); onSelected([]); return; }
              if (e.key === "Enter") { e.preventDefault(); confirmFillet(); }
            }}
          />
          {(filletBox.error || filletCalc?.error) && <div className="mt-1 text-[9px] leading-3 text-danger" dir="rtl">{filletBox.error || filletCalc?.error}</div>}
          {!filletCalc?.error && <div className="mt-1 text-[8px] text-dim" dir="rtl">Enter برای ساخت قوس</div>}
        </div>
      )}

      {moveBox && moveSession && (
        <div className="absolute z-50" style={{ left: moveBox.x, top: moveBox.y, width: `${Math.max(42, Math.min(150, 24 + moveBox.value.length * 8))}px` }} dir="ltr">
          <input ref={moveInputRef} value={moveBox.value} aria-label="Move value" className={cn(
            "h-[30px] w-full rounded-[5px] border bg-[#071018]/95 px-2 py-1 font-mono text-xs text-[#d9f7f5] outline-none shadow-[0_8px_24px_rgba(0,0,0,.55)] transition-colors",
            moveSession.mode === "absolute" ? "border-[#9b8cff] focus:border-[#b3a8ff]" : "border-[#00a9c7] focus:border-[#20c9df]",
            moveBox.error && "!border-danger"
          )}
            onChange={(e) => setMoveBox({ ...moveBox, value: e.target.value, error: "" })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") { if (moveSession.editBase && edit) onEditBuf({ ...edit, verts: moveSession.editBase }, false); else onSegs(moveSession.base, false); setMoveBox(null); setMoveSession(null); return; }
              if (e.key === "Tab") { e.preventDefault(); setMoveSession({ ...moveSession, mode: moveSession.mode === "relative" ? "absolute" : "relative" }); return; }
              if (e.key !== "Enter") return;
              const parts = moveBox.value.split(",");
              const values = parts.map(arithmeticValue);
              if (parts.length > 2 || values.some((v) => v == null)) { setMoveBox({ ...moveBox, error: "Invalid value" }); return; }
              const dx = moveSession.pointer.z - moveSession.origin.z, dy = moveSession.pointer.r - moveSession.origin.r;
              let dz = 0, dr = 0;
              if (values.length === 2) { dz = values[0]!; dr = values[1]!; }
              else {
      const amount = values[0]!;
      if (moveSession.axis === "x") dz = amount * moveSession.dirX;
      else if (moveSession.axis === "y") dr = amount * moveSession.dirY;
      else {
        /* مقدار تکی شعاع حرکت است، نه قفل مختصات: نشانگر جهت را تعیین می‌کند
           و نقطه/خط آزادانه روی دایره‌ای با همین شعاع حرکت می‌کند. */
        const length = Math.hypot(dx, dy);
        if (length > 1e-9) { dz = amount * dx / length; dr = amount * dy / length; }
        else { dz = amount * moveSession.dirX; dr = 0; }
      }
    }
              if (moveSession.mode === "absolute") {
      const editAnchor = moveSession.editBase?.find((v) => moveSession.editVertexIds?.includes(v.id));
      const sketchAnchor = moveSession.base.find((s) => moveSession.ids.includes(s.id))?.a;
      const anchor = editAnchor ? { z: editAnchor.z, r: editAnchor.x / 2 } : sketchAnchor!;
      if (values.length === 2) { dz -= anchor.z; dr -= anchor.r; }
      else if (dz) dz = Math.abs(dz) - anchor.z; else dr = Math.abs(dr) - anchor.r;
    }
              if (moveSession.editBase && moveSession.editVertexIds && edit) {
                const moving = new Set(moveSession.editVertexIds);
                onEditBuf({ ...edit, verts: moveSession.editBase.map((v) => moving.has(v.id) ? { ...v, z: v.z + dz, x: v.x + 2 * dr } : v) }, true);
              } else {
                const next = moveSession.base.map((s) => moveSession.ids.includes(s.id) ? moveSeg(s, dz, dr) : s);
                onSegs(next, true);
              }
              setLastMove({ dz, dr }); setMoveBox(null); setMoveSession(null);
            }} />
          <div className={cn(
            "mt-1 whitespace-nowrap pl-0.5 font-mono text-[10px] font-bold leading-none tracking-wide",
            moveSession.mode === "absolute" ? "text-[#b1a4ff]" : "text-[#26e6c7]"
          )}>{moveReadout}</div>
        </div>
      )}

      {/* ---------- نوار ابزار ترسیم: ستون عمودی چپ ---------- */}
      <div className="absolute top-2.5 bottom-2.5 left-2.5 flex w-[30px] flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-edge bg-panel/92 shadow-lg shadow-black/30 backdrop-blur-sm">
          {(editOpen ? TOOLS.filter((t) => t.id === "select" || t.id === "move") : TOOLS).map((t, i) => (
            <button
              key={t.id}
              onClick={() => {
                chooseTool(t.id);
                cancelDraft();
              }}
              title={`${t.name} (${t.key}) — ${t.hint}`}
              className={cn(
                "grid h-[27px] w-full shrink-0 place-items-center transition-colors",
                i > 0 && "border-t border-edge",
                tool === t.id ? "bg-teal text-[#0d201a]" : "text-mute hover:bg-panel3 hover:text-ink"
              )}
            >
              {t.icon}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-edge bg-panel/92 shadow-lg shadow-black/30 backdrop-blur-sm">
          <button onClick={onUndo} disabled={!canUndo} title="واگرد (Ctrl+Z)" className={cn("grid h-[27px] w-full place-items-center transition-colors", canUndo ? "text-mute hover:bg-panel3 hover:text-ink" : "text-dim/40")}>
            <IconUndo className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRedo} disabled={!canRedo} title="بازانجام (Ctrl+Y)" className={cn("grid h-[27px] w-full border-t border-edge place-items-center transition-colors", canRedo ? "text-mute hover:bg-panel3 hover:text-ink" : "text-dim/40")}>
            <IconRedo className="h-3.5 w-3.5" />
          </button>
          <button onClick={duplicateSelected} disabled={!selected.length} title="کپی المان‌های انتخابی (Ctrl+D)" className={cn("grid h-[27px] w-full border-t border-edge place-items-center transition-colors", selected.length ? "text-mute hover:bg-panel3 hover:text-ink" : "text-dim/40")}>
            <IconCopy className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={splitSelected ? deleteSelectedSplit : deleteSelected}
            disabled={!selected.length && !splitSelected}
            title={splitSelected ? "حذف نقطه Split (Delete)" : "حذف انتخابی (Delete)"}
            className={cn(
              "grid h-[27px] w-full place-items-center border-t border-edge transition-colors",
              selected.length || splitSelected ? "text-danger/80 hover:bg-danger/15 hover:text-danger" : "text-dim/40"
            )}
          >
            <IconTrash className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-1">
          <button className="grid h-[27px] w-full place-items-center rounded-lg border border-edge bg-panel/92 text-mute shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:border-edge2 hover:text-ink" title="بزرگ‌نمایی" onClick={() => zoomBy(1.3)}>
            <IconPlus className="h-3.5 w-3.5" />
          </button>
          <button className="grid h-[27px] w-full place-items-center rounded-lg border border-edge bg-panel/92 text-mute shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:border-edge2 hover:text-ink" title="کوچک‌نمایی" onClick={() => zoomBy(1 / 1.3)}>
            <IconMinus className="h-3.5 w-3.5" />
          </button>
          <button className="grid h-[27px] w-full place-items-center rounded-lg border border-edge bg-panel/92 text-mute shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:border-edge2 hover:text-ink" title="جاگذاری نما" onClick={() => setCam(fit(size.w, size.h))}>
            <IconFit className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn(
              "grid h-[27px] w-full place-items-center rounded-lg border bg-panel/92 shadow-lg shadow-black/30 backdrop-blur-sm transition-colors",
              panMode ? "border-teal/60 text-teal" : "border-edge text-mute hover:border-edge2 hover:text-ink"
            )}
            title="پن (جابه‌جایی نما) — با دکمهٔ وسط/راست بکشید"
            onClick={() => setPanMode((v) => !v)}
          >
            <IconHand className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ---------- نوار انتخاب ---------- */}
      {tool === "select" && (
        <div className={cn(
          "anim-in absolute left-[46px] z-10 flex max-w-[calc(100%-60px)] flex-col gap-1 rounded-lg border border-edge bg-panel/92 px-2.5 py-1.5 shadow-lg shadow-black/40 backdrop-blur-sm transition-[bottom]",
          one ? "bottom-[285px]" : selPoints.length ? "bottom-[175px]" : "bottom-[44px]"
        )}>
          <div className="flex items-center justify-center gap-1.5">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                selected.length || splitSelected ? "border-teal/50 text-teal" : "border-edge text-dim"
              )}
            >
              {splitSelected
                ? selected.length ? `Split + ${selected.length} المان` : "نقطه Split انتخاب شده"
                : selected.length ? `${selected.length} انتخاب شده` : "بدون انتخاب"}
            </span>
            {selLocked && (
              <span
                className="rounded-full border border-danger/50 px-2 py-0.5 text-[10px] font-bold text-danger"
                title="این المان(ها) به المان دیگری متصل‌اند و با درگ جابه‌جا نمی‌شوند تا اتصال پاره نشود؛ برای جابه‌جایی، کل زنجیرهٔ متصل را با هم انتخاب کنید یا نقطه را راست‌کلیک و جدا کنید"
              >
                قفل — متصل
              </span>
            )}
            <span className="h-4 w-px bg-edge" />
            <button onClick={selectAllEligible} title="انتخاب همه (Ctrl+A)" className="rounded px-1.5 py-0.5 text-[10.5px] font-bold text-mute transition-colors hover:bg-panel3 hover:text-ink">
              همه
            </button>
            <button onClick={invertSelection} title="معکوس‌کردن انتخاب (Ctrl+I)" className="rounded px-1.5 py-0.5 text-[10.5px] font-bold text-mute transition-colors hover:bg-panel3 hover:text-ink">
              معکوس
            </button>
            <button
              onClick={() => { onSelected([]); setSplitSelected(false); }}
              disabled={!selected.length && !splitSelected}
              title="لغو انتخاب (Esc)"
              className="rounded px-1.5 py-0.5 text-[10.5px] font-bold text-mute transition-colors hover:bg-panel3 hover:text-ink disabled:opacity-35"
            >
              پاک
            </button>
          </div>
          <div className="flex items-center justify-center gap-1 border-t border-edge/60 pt-1" dir="ltr">
            {(["line", "quad", "cubic", "arc"] as SketchKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setSelFilter((f) => ({ ...f, [k]: !f[k] }))}
                title={selFilter[k] ? `عدم انتخاب ${KIND_FA[k]}‌ها در باکس/کلیک` : `انتخاب ${KIND_FA[k]}‌ها`}
                className={cn(
                  "rounded-full border px-2 py-px text-[9px] font-bold transition-all",
                  selFilter[k] ? "border-teal/50 text-teal" : "border-edge text-dim/50 line-through"
                )}
              >
                {KIND_FA[k]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* راهنمای مرحلهٔ ترسیم */}
      {tool !== "select" && (
        <div className="anim-in absolute top-2.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-teal/50 bg-panel/95 py-1.5 pr-3 pl-1.5 text-[11.5px] font-bold text-teal shadow-lg shadow-black/40 backdrop-blur-sm">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-teal/20 font-mono text-[10px]">{stepIdx + 1}</span>
          {stepText}
          {liveInfo && <span className="font-mono text-[10px] font-normal text-mute">{liveInfo}</span>}
          <button onClick={() => { chooseTool("select"); cancelDraft(); }} className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-white/10" title="لغو (Esc)">
            <IconX className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* نشان ایزوله */}
      {iso && isoOp && tool === "select" && (
        <div className="anim-in absolute top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border py-1.5 pr-3 pl-1.5 text-[11.5px] font-bold shadow-lg shadow-black/40 backdrop-blur-sm" style={{ borderColor: `${OP_INFO[isoOp.type].color}77`, background: "#1d1710ee", color: OP_INFO[isoOp.type].color }}>
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: OP_INFO[isoOp.type].color }} />
          نمای ایزوله: {OP_INFO[isoOp.type].name}
          <button onClick={onClearIsolate} className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-white/10" title="خروج (Esc)">
            <IconX className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* ---------- بالا-راست: منوی لایه‌ها + کلید «ویرایش مسیر» (سمت چپِ منو) ---------- */}
      <div dir="rtl" className="absolute top-2.5 right-2.5 z-20 flex items-start gap-2">
        <LayerMenu settings={settings} onSettings={onSettings} />
        <button
          onClick={() => onEditToggle(!editOpen)}
          title="ویرایشِ مسیرِ جی‌کد به‌صورت یک خطِ یکپارچه (مثل سیمکو) — فایل فقط با «تأیید» به‌روز می‌شود"
          className={cn(
            "chip-toggle backdrop-blur-sm transition-all",
            editOpen
              ? "border-brass bg-brass/15 text-brass2"
              : "border-edge bg-panel/85 text-ink hover:border-edge2"
          )}
        >
          <IconCode className={cn("h-3.5 w-3.5", editOpen ? "text-brass2" : "text-brass")} />
          ویرایش مسیر
        </button>
        {editOpen && <EditGridControl settings={settings} onSettings={onSettings} />}
        {editOpen && (
          <button
            type="button"
            role="switch"
            aria-checked={showPathBySpeed}
            onClick={() => setShowPathBySpeed((value) => !value)}
            title="رنگ‌بندی مسیر بر اساس سرعت"
            className={cn(
              "chip-toggle backdrop-blur-sm transition-all",
              showPathBySpeed ? "border-brass/60 bg-brass/12 text-brass2" : "border-edge bg-panel/85 text-dim hover:border-edge2"
            )}
          >
            <span className={cn("relative h-3.5 w-7 rounded-full border transition-colors", showPathBySpeed ? "border-brass/70 bg-brass/25" : "border-edge2 bg-panel3")}>
              <span className={cn("absolute top-0.5 h-2 w-2 rounded-full transition-all", showPathBySpeed ? "right-0.5 bg-brass" : "right-[17px] bg-dim")} />
            </span>
            رنگ سرعت
          </button>
        )}
        {editOpen && (
          <button
            type="button"
            role="switch"
            aria-checked={showPathPoints}
            onClick={() => {
              setPickerHover(null);
              setHitPicker(null);
              setShowPathPoints((visible) => {
                if (visible) setSelV([]);
                return !visible;
              });
            }}
            title={showPathPoints ? "پنهان‌کردن نقاط مسیر و غیرفعال‌کردن انتخاب آن‌ها" : "نمایش و فعال‌کردن نقاط مسیر"}
            className={cn(
              "chip-toggle backdrop-blur-sm transition-all",
              showPathPoints ? "border-teal/55 bg-teal/10 text-teal" : "border-edge bg-panel/85 text-dim hover:border-edge2"
            )}
          >
            <span className={cn("relative h-3.5 w-7 rounded-full border transition-colors", showPathPoints ? "border-teal/70 bg-teal/25" : "border-edge2 bg-panel3")}>
              <span className={cn("absolute top-0.5 h-2 w-2 rounded-full transition-all", showPathPoints ? "right-0.5 bg-teal" : "right-[17px] bg-dim")} />
            </span>
            نقاط
          </button>
        )}
      </div>

      {/* ---------- نوارِ حالت ادیت: شمارش تغییرات + تأیید/انصراف ---------- */}
      {editOpen && (
        <div className="anim-in absolute bottom-2.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-brass/45 bg-[#1d1710ee] py-1.5 pr-3.5 pl-1.5 text-[11.5px] font-bold shadow-lg shadow-black/40 backdrop-blur-sm">
          <span className="h-2 w-2 rounded-full bg-brass" />
          ویرایش مسیر
          <span className="font-mono text-[10px] font-normal text-mute">
            {editChanges ? `${editChanges.toLocaleString("fa-IR")} تغییر · ` : "بدون تغییر · "}
            {lines.length.toLocaleString("fa-IR")} خط · {verts.length.toLocaleString("fa-IR")} نقطه
            {activeLine != null && ` · فعال: ${activeLine.toLocaleString("fa-IR")}`}
          </span>
          <span className="hidden text-[9px] font-normal text-dim xl:inline">Shift+Hover بازه · Shift+Click انتخاب · ←/→ پیمایش</span>
          <button
            onClick={onEditConfirm}
            disabled={!editChanges}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors",
              editChanges
                ? "border-teal/60 bg-teal/15 text-teal hover:bg-teal/25"
                : "border-edge bg-panel/60 text-dim"
            )}
            title="اعمالِ ویرایش‌ها روی فایلِ جی‌کد (شبیه‌سازی و دانلود هم به‌روز می‌شوند)"
          >
            <IconCheck className="h-3 w-3" />
            تأیید
          </button>
          <button
            onClick={onEditDiscard}
            className="flex items-center gap-1 rounded-full border border-red-500/45 bg-red-500/10 px-2.5 py-1 text-[11px] font-bold text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200"
            title="حذف کامل پیش‌نویس و خروج از ویرایش مسیر؛ با Undo قابل بازیابی است"
          >
            <IconTrash className="h-3 w-3" />
            حذف پیش‌نویس
          </button>
          <button
            onClick={onEditCancel}
            className="rounded-full border border-edge bg-panel/70 px-2.5 py-1 text-[11px] font-bold text-mute transition-colors hover:text-ink"
            title="خروج از ویرایش مسیر؛ پیش‌نویس تغییرات برای ورود بعدی حفظ می‌شود"
          >
            خروج
          </button>
        </div>
      )}

      {hitPicker && editOpen && (
        <div
          className="anim-in absolute z-30 w-60 rounded-lg border border-brass/45 bg-panel/95 p-2 shadow-2xl shadow-black/60 backdrop-blur"
          style={{ left: Math.min(hitPicker.x + 10, size.w - 250), top: Math.min(hitPicker.y + 10, size.h - 190) }}
        >
          <div className="mb-1.5 flex items-center justify-between px-1 text-[10.5px] font-bold text-brass2">
            <span>انتخاب مورد هم‌پوشان</span>
            <button onClick={() => { setHitPicker(null); setPickerHover(null); }} className="text-dim hover:text-ink"><IconX className="h-3 w-3" /></button>
          </div>
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {hitPicker.verts.map((id) => (
              <button
                key={`pv${id}`}
                className="w-full rounded-md border border-edge bg-panel2 px-2 py-1.5 text-right text-[10.5px] text-ink hover:border-brass/70 hover:bg-panel3"
                onMouseEnter={() => setPickerHover({ kind: "vert", id })}
                onMouseLeave={() => setPickerHover(null)}
                onFocus={() => setPickerHover({ kind: "vert", id })}
                onBlur={() => setPickerHover(null)}
                onClick={() => { setSelV([id]); selectEditLines([], null, true); focusEditVertexInGCode(id); setHitPicker(null); setPickerHover(null); }}
              >
                نقطه {id.toLocaleString("fa-IR")} · X {vz(id).z.toFixed(2)} · Y { (vz(id).x / 2).toFixed(2) }
              </button>
            ))}
            {hitPicker.lines.map((id) => { const l = lineById.get(id); return l ? (
              <button
                key={`pl${id}`}
                className="flex w-full items-center gap-2 rounded-md border border-edge bg-panel2 px-2 py-1.5 text-right text-[10.5px] text-ink hover:border-brass/70 hover:bg-panel3"
                onMouseEnter={() => setPickerHover({ kind: "line", id })}
                onMouseLeave={() => setPickerHover(null)}
                onFocus={() => setPickerHover({ kind: "line", id })}
                onBlur={() => setPickerHover(null)}
                onClick={() => { selectEditLines([id], id, true); setSelV([]); setHitPicker(null); setPickerHover(null); }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: showPathBySpeed ? speedStroke(l.motion, l.feed) : SEG_COLOR[l.motion === 0 ? "rapid" : l.kind] }} />
                <span>خط {id.toLocaleString("fa-IR")} · {l.motion === 0 ? "حرکت سریع" : OP_INFO[ops.find((o) => o.id === l.opId)?.type ?? "finish"].name}</span>
              </button>
            ) : null; })}
          </div>
          <p className="mt-1.5 px-1 text-[9px] text-dim">مورد را انتخاب کنید؛ سپس برای جابه‌جایی آن را بکشید.</p>
        </div>
      )}

      {/* ---------- بازرس هندسی ---------- */}
      {one && tool === "select" && (
        <Inspector
          seg={one}
          blankL={L}
          blankR={R}
          onPatch={(patch) => patchSeg(one.id, patch)}
          onClose={() => onSelected([])}
        />
      )}
      {selSegs.length > 1 && tool === "select" && (
        <div className="anim-in absolute right-2.5 bottom-11 rounded-lg border border-teal/40 bg-panel/95 px-3 py-2 text-[11px] font-bold text-teal backdrop-blur-sm">
          {selSegs.length} المان انتخاب شده — برای جابه‌جایی بکشید یا Delete بزنید
        </div>
      )}

      {/* ---------- پنل ویرایش نقطهٔ مستقل ---------- */}
      {selPoints.length === 1 && tool === "select" && (() => {
        const ps = selPoints[0];
        const s = segs.find((x) => x.id === ps.segId);
        const pt = s ? s[ps.part] : null;
        if (!s || !pt) return null;
        const partFa =
          ps.part === "a" ? "نقطهٔ شروع" :
          ps.part === "b" ? "نقطهٔ پایان" :
          ps.part === "c1" ? "دستهٔ کنترل ۱" :
          ps.part === "c2" ? "دستهٔ کنترل ۲" : "نقطهٔ روی کمان";
        return (
          <div className="anim-in absolute left-2.5 bottom-11 w-[196px] rounded-lg border border-brass/40 bg-panel/95 p-2.5 shadow-xl shadow-black/40 backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-brass2">
                <span className="h-2 w-2 rounded-full bg-brass2" />
                {partFa}
              </span>
              <button onClick={() => setSelPoints([])} className="grid h-5 w-5 place-items-center rounded text-dim transition-colors hover:text-ink" title="بستن">
                <IconX className="h-3 w-3" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <NumF label="X (طول)" v={pt.z} onC={(v) => patchPoint(ps.segId, ps.part, { z: v })} />
              <NumF label="⌀ (قطر)" v={pt.r * 2} onC={(v) => patchPoint(ps.segId, ps.part, { r: v / 2 })} />
            </div>
            <p className="mt-1.5 text-center text-[9px] text-dim">{KIND_FA[s.kind]} — بکشید یا مقدار دقیق وارد کنید</p>
          </div>
        );
      })()}
      {selPoints.length > 1 && tool === "select" && (
        <div className="anim-in absolute left-2.5 bottom-11 rounded-lg border border-brass/40 bg-panel/95 px-3 py-2 text-[11px] font-bold text-brass2 backdrop-blur-sm">
          {selPoints.length} نقطه انتخاب شده — بکشید تا با هم جابه‌جا شوند
        </div>
      )}

      {/* گیر و راهنما */}
      <div className="absolute right-2.5 bottom-2.5 flex items-center gap-2">
        <button
          className={cn("chip-toggle backdrop-blur-sm transition-all", settings.smartSnap ? "border-teal/50 bg-panel/85 text-teal" : "border-edge bg-panel/60 text-dim")}
          title="چسبندگی هوشمند به نقاط انتها، وسط، مرکز و تقاطع"
          onClick={() => onSettings({ smartSnap: !settings.smartSnap })}
        >
          <IconCheck className="h-3.5 w-3.5" />
          اسنپ هوشمند
        </button>
        <button
          className="chip-toggle border-edge bg-panel/85 text-mute backdrop-blur-sm hover:text-ink"
          title="گیر شبکه"
          onClick={() => {
            const i = SNAP_STEPS.indexOf(settings.snap);
            onSettings({ snap: SNAP_STEPS[(i + 1) % SNAP_STEPS.length] });
          }}
        >
          <IconMagnet className="h-3.5 w-3.5 text-brass" />
          شبکه: {snapLabel}
        </button>
        <span className="hidden items-center gap-1.5 rounded-full border border-edge bg-panel/85 px-2.5 py-1 text-[10.5px] text-mute backdrop-blur-sm lg:inline-flex">
          <IconCorner className="h-3.5 w-3.5" />
          {segs.length} المان
        </span>
        <span
          className="hidden items-center gap-1.5 rounded-full border border-edge bg-panel/85 px-2.5 py-1 text-[10.5px] text-mute backdrop-blur-sm xl:inline-flex"
          title="درگ چپ‌به‌راست: فقط المان‌های کاملاً داخل باکس (آبی) • راست‌به‌چپ: المان‌های متقاطع (سبز) • Shift: افزودن • Ctrl: حذف • دابل‌کلیک: انتخاب زنجیره • پن: دکمهٔ وسط/راست • Space: سوییچ دو ابزار آخر"
        >
          <span className="inline-block h-2.5 w-4 rounded-[2px] border border-[#4aa3ff] bg-[#4aa3ff]/25" />
          <span className="inline-block h-2.5 w-4 rounded-[2px] border border-dashed border-[#3faf5d] bg-[#3faf5d]/20" />
          باکس انتخابگر
        </span>
      </div>

      <div className="absolute bottom-2.5 left-2.5 rounded-md border border-edge bg-panel/90 px-2.5 py-1 font-mono text-[11px] tracking-wide text-brass2/90 backdrop-blur-sm" dir="ltr">
        <span ref={readoutRef}>X 0.0&nbsp;&nbsp;Y⌀ 0.0</span>
      </div>
    </div>
  );
}

/* ---------------- بازرس هندسی المان ---------------- */

function Inspector({
  seg,
  blankL,
  blankR,
  onPatch,
  onClose,
}: {
  seg: SketchSeg;
  blankL: number;
  blankR: number;
  onPatch: (patch: Partial<SketchSeg>) => void;
  onClose: () => void;
}) {
  const len = segLength(seg);
  const ang = lineAngle(seg.a, seg.b);
  const rad = seg.kind === "arc" ? arcRadius(seg) : 0;
  const arcDivisions = seg.kind === "arc" ? (seg.arcDivisions ?? Math.max(2, segPoints(seg).length - 1)) : 0;
  const setArcDivisions = (value: number) => onPatch({ arcDivisions: Math.max(2, Math.min(500, Math.round(value))) });
  const constrainPoint = (part: SketchPointPart, p: SPoint) =>
    constrainSegPointToStock(seg, part, p, blankL, blankR);

  return (
    <div className="anim-in absolute right-2.5 bottom-11 w-[228px] rounded-lg border border-teal/40 bg-panel/95 p-2.5 shadow-xl shadow-black/40 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-teal">
          <span className="h-2 w-2 rounded-full bg-teal" />
          {KIND_FA[seg.kind]}
        </span>
        <button onClick={onClose} className="grid h-5 w-5 place-items-center rounded text-dim transition-colors hover:text-ink" title="بستن">
          <IconX className="h-3 w-3" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <NumF label="X شروع" v={seg.a.z} onC={(v) => onPatch({ a: constrainPoint("a", { ...seg.a, z: v }) })} />
        <NumF label="⌀ شروع" v={seg.a.r * 2} onC={(v) => onPatch({ a: constrainPoint("a", { ...seg.a, r: v / 2 }) })} />
        <NumF label="X پایان" v={seg.b.z} onC={(v) => onPatch({ b: constrainPoint("b", { ...seg.b, z: v }) })} />
        <NumF label="⌀ پایان" v={seg.b.r * 2} onC={(v) => onPatch({ b: constrainPoint("b", { ...seg.b, r: v / 2 }) })} />
      </div>

      {seg.kind === "line" && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumF label="طول" v={len} onC={(v) => onPatch({ b: constrainPoint("b", endFromLenAngle(seg.a, v, ang)) })} />
          <NumF label="زاویه°" v={ang} onC={(v) => onPatch({ b: constrainPoint("b", endFromLenAngle(seg.a, len, v)) })} />
        </div>
      )}

      {seg.kind === "arc" && (
        <>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <NumF
              label="شعاع"
              v={rad}
              onC={(v) => {
                const nextVia = arcWithRadius(seg, v).via;
                if (nextVia) onPatch({ via: constrainPoint("via", nextVia) });
              }}
            />
            <div className="flex items-end">
              <button
                onClick={() => {
                  const mz = (seg.a.z + seg.b.z) / 2;
                  const mr = (seg.a.r + seg.b.r) / 2;
                  const via = seg.via ?? { z: mz, r: mr };
                  onPatch({ via: constrainPoint("via", { z: 2 * mz - via.z, r: 2 * mr - via.r }) });
                }}
                className="btn w-full justify-center !py-1.5 text-[10.5px]"
                title="معکوس‌کردن جهت برآمدگی کمان"
              >
                معکوس کمان
              </button>
            </div>
          </div>
          <div className="mt-1.5">
            <div className="mb-1 text-[9px] font-semibold text-dim">تعداد تقسیمات کمان</div>
            <div className="flex h-7 overflow-hidden rounded border border-edge bg-panel2" dir="ltr">
              <button type="button" className="grid w-8 place-items-center border-r border-edge text-sm font-bold text-teal hover:bg-teal/10" onClick={() => setArcDivisions(arcDivisions - 1)} title="کاهش تقسیمات">−</button>
              <input
                type="number"
                min={2}
                max={500}
                step={1}
                value={arcDivisions}
                onChange={(e) => setArcDivisions(Number(e.target.value))}
                className="min-w-0 flex-1 bg-transparent text-center font-mono text-[11px] text-ink outline-none"
                aria-label="تعداد تقسیمات کمان"
              />
              <button type="button" className="grid w-8 place-items-center border-l border-edge text-sm font-bold text-teal hover:bg-teal/10" onClick={() => setArcDivisions(arcDivisions + 1)} title="افزایش تقسیمات">+</button>
            </div>
          </div>
        </>
      )}

      {(seg.kind === "quad" || seg.kind === "cubic") && seg.c1 && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumF label="X کنترل۱" v={seg.c1.z} onC={(v) => onPatch({ c1: constrainPoint("c1", { ...seg.c1!, z: v }) })} />
          <NumF label="⌀ کنترل۱" v={seg.c1.r * 2} onC={(v) => onPatch({ c1: constrainPoint("c1", { ...seg.c1!, r: v / 2 }) })} />
          {seg.kind === "cubic" && seg.c2 && (
            <>
              <NumF label="X کنترل۲" v={seg.c2.z} onC={(v) => onPatch({ c2: constrainPoint("c2", { ...seg.c2!, z: v }) })} />
              <NumF label="⌀ کنترل۲" v={seg.c2.r * 2} onC={(v) => onPatch({ c2: constrainPoint("c2", { ...seg.c2!, r: v / 2 }) })} />
            </>
          )}
        </div>
      )}

      <p className="mt-1.5 text-center font-mono text-[9px] text-dim">طول کمان/منحنی: {len.toFixed(1)} mm</p>


    </div>
  );
}

function NumF({ label, v, onC }: { label: string; v: number; onC: (n: number) => void }) {
  const [t, setT] = useState(String(Math.round(v * 100) / 100));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setT(String(Math.round(v * 100) / 100));
  }, [v]);
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9px] font-semibold text-mute">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        dir="ltr"
        className="field-input !px-1.5 !py-1 text-center !text-[11px]"
        value={t}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setT(e.target.value);
          const n = parseFloat(e.target.value.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
          if (Number.isFinite(n)) onC(n);
        }}
        onBlur={() => {
          focused.current = false;
          setT(String(Math.round(v * 100) / 100));
        }}
      />
    </label>
  );
}
