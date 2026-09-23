import { useEffect, useMemo, useRef, useState } from "react";
import type { EditBuf, ELine, EVert, GenResult, OffPatch, Op, Params, SegKind, SplitState } from "../lib/lathe";
import { deleteEditLines, deleteEditVertices, insertEditVertex, normalizeEditBuf, OP_INFO } from "../lib/lathe";
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
  intersectionPoints,
  KIND_FA,
  lineAngle,
  makeSeg,
  moveSeg,
  newSegId,
  orderChain,
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
  IconHand,
  IconLayers,
  IconLine,
  IconMagnet,
  IconMagnetSm,
  IconMinus,
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
  showBore: boolean;
  showRound: boolean;
  showFace: boolean;
  showBottom: boolean;
  showRapids: boolean;
  showGhost: boolean;
}

type Tool = "select" | "line" | "quad" | "cubic" | "arc" | "split";

const TOOLS: { id: Tool; name: string; key: string; icon: React.ReactNode; hint: string }[] = [
  { id: "select", name: "انتخاب", key: "V", icon: <IconCursor className="h-4 w-4" />, hint: "کلیک تکی، باکس انتخابگر چپ‌به‌راست (فقط داخل) و راست‌به‌چپ (متقاطع)، Shift افزودن، Ctrl حذف، دابل‌کلیک زنجیره" },
  { id: "line", name: "خط", key: "L", icon: <IconLine className="h-4 w-4" />, hint: "خط مستقیم: نقطهٔ شروع و پایان" },
  { id: "quad", name: "منحنی", key: "C", icon: <IconQuad className="h-4 w-4" />, hint: "منحنی ساده: شروع، پایان، یک نقطهٔ کنترل" },
  { id: "cubic", name: "منحنی کنترلی", key: "B", icon: <IconCubic className="h-4 w-4" />, hint: "منحنی پیشرفته: شروع، پایان، سپس دستهٔ خروج از پایان و دستهٔ ورود به شروع" },
  { id: "arc", name: "کمان", key: "A", icon: <IconArc3 className="h-4 w-4" />, hint: "کمان سه‌نقطه‌ای: شروع، پایان، نقطه‌ای روی کمان" },
  { id: "split", name: "نقطه Split", key: "S", icon: <IconSplit className="h-4 w-4" />, hint: "قرار دادن نقطه تعیین‌کننده داخل/خارج روی پروفیل" },
];

const NEED_PTS: Record<Tool, number> = { select: 0, line: 2, quad: 3, cubic: 4, arc: 3, split: 1 };

const STEP_HINT: Record<Tool, string[]> = {
  select: [],
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
}

interface Cam {
  s: number;
  ox: number;
  oy: number;
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
  borefin: "#f72585",
  bottom: "#ffd166",
};

type LayerKey = "showRough" | "showFinish" | "showOffset" | "showBore" | "showRound" | "showFace" | "showBottom" | "showRapids" | "showGhost";

const CHIPS: { key: LayerKey; label: string; color: string }[] = [
  { key: "showRound", label: "گرد کردن", color: "#b48ee0" },
  { key: "showRough", label: "مسیر خشن", color: "#45b394" },
  { key: "showBore", label: "داخل‌تراشی", color: "#4cc9f0" },
  { key: "showOffset", label: "آفست", color: "#f59a80" },
  { key: "showFinish", label: "پرداخت", color: "#e0703c" },
  { key: "showFace", label: "پیشانی", color: "#e3a94e" },
  { key: "showBottom", label: "کف‌تراشی", color: "#ffd166" },
  { key: "showRapids", label: "حرکت سریع", color: "#93a1ad" },
  { key: "showGhost", label: "سایه طرح", color: "#c9955a" },
];

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
        <div className="absolute top-[calc(100%+6px)] right-0 w-52 rounded-lg border border-edge bg-panel/95 p-1.5 shadow-xl shadow-black/50 backdrop-blur">
          <div className="px-2 pt-0.5 pb-1 text-[10px] font-bold text-dim">نمایش مسیرهای عملیات روی بوم</div>
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

const KIND_VISIBLE: Record<SegKind, LayerKey> = {
  rapid: "showRapids",
  round: "showRound",
  rough: "showRough",
  roughz: "showRough",
  copy: "showRough",
  face: "showFace",
  finish: "showFinish",
  offset: "showOffset",
  bore: "showBore",
  borefin: "showBore",
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
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Cam | null>(null);
  const [tool, setTool] = useState<Tool>("select");
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

  /* ---------- حالت ویرایش مسیر — ویرایشگرِ پلی‌لاینِ پیوسته (مثل بک‌پلات سیمکو) ---------- */
  const editOpen = !!edit;
  const [selL, setSelL] = useState<number[]>([]); // خطوط انتخابی
  const [activeLine, setActiveLine] = useState<number | null>(null); // مبنای پیمایش Arrow
  const [selV, setSelV] = useState<number[]>([]); // رأس‌های انتخابی (نقاط مشترک)
  const [showPathPoints, setShowPathPoints] = useState(true);
  const [shiftDown, setShiftDown] = useState(false);
  const shiftRef = useRef(false);
  const [selOff, setSelOff] = useState<number[]>([]); // منحنی‌های افست انتخابی
  const [hoverBuf, setHoverBuf] = useState<number | null>(null);
  const [bufMarq, setBufMarq] = useState<{ ids: number[]; vxs: number[] } | null>(null);
  const [hitPicker, setHitPicker] = useState<{ x: number; y: number; lines: number[]; verts: number[] } | null>(null);
  const [pickerHover, setPickerHover] = useState<{ kind: "line" | "vert"; id: number } | null>(null);

  /* انتخاب Segment در خود EditBuf نگه‌داری می‌شود تا بخشی از تاریخچه اصلی باشد. */
  const selectEditLines = (ids: number[], requestedActive: number | null, record = true) => {
    const ordered = edit ? edit.lines.filter((l) => ids.includes(l.id)).map((l) => l.id) : [];
    const active = requestedActive != null && ordered.includes(requestedActive)
      ? requestedActive
      : ordered[ordered.length - 1] ?? null;
    setSelL(ordered);
    setActiveLine(active);
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

  useEffect(() => {
    if (editOpen) return;
    setSelL([]);
    setActiveLine(null);
    setSelV([]);
    setSelOff([]);
    setHoverBuf(null);
    setBufMarq(null);
    setHitPicker(null);
    setPickerHover(null);
  }, [editOpen]);
  /* نقاط جداشده (unjoined) — به‌صورت پیش‌فرض همهٔ نقاطِ هم‌مکان متصل‌اند */
  const [separated, setSeparated] = useState<Set<string>>(new Set());
  /* منوی راست‌کلیک برای اتصال/جداسازی نقطه */
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
  const [panMode, setPanMode] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const spaceRef = useRef(false);
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
        const index = edit.lines.findIndex((line) => line.id === active);
        const nextIndex = index + (e.key === "ArrowLeft" ? -1 : 1);
        if (index >= 0 && nextIndex >= 0 && nextIndex < edit.lines.length) {
          const nextId = edit.lines[nextIndex].id;
          selectEditLines(e.shiftKey ? [...selL, nextId] : [nextId], nextId, true);
          setSelV([]);
        }
        return;
      }
      if (editOpen && (e.key === "Delete" || e.key === "Backspace") && edit) {
        if (selV.length) {
          e.preventDefault();
          const fin = deleteEditVertices(edit.verts, edit.lines, selV);
          if (fin.lines.length) onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, selLines: [], activeLine: null }, true);
          setSelV([]); setSelL([]); setActiveLine(null);
          return;
        }
        if (selL.length) {
          e.preventDefault();
          const fin = deleteEditLines(edit.verts, edit.lines, selL);
          if (fin.lines.length) onEditBuf({ ...edit, verts: fin.verts, lines: fin.lines, selLines: [], activeLine: null }, true);
          setSelL([]); setActiveLine(null); setSelV([]);
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
        selectAllEligible();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "i") {
        e.preventDefault();
        invertSelection();
        return;
      }
      if (e.key === "Escape") {
        if (drag.current?.mode === "marquee") {
          drag.current = null;
          setMarquee(null);
          setMarqueeHits([]);
          return;
        }
        if (ctxMenu) {
          setCtxMenu(null);
          return;
        }
        if (draft.length) cancelDraft();
        else if (isolatedOpId != null) onClearIsolate();
        else if (tool !== "select") setTool("select");
        else {
          if (selPoints.length) setSelPoints([]);
          onSelected([]);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
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
      const t = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (t) {
        setTool(t.id);
        cancelDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, selected, tool, isolatedOpId, segs, selFilter, selPoints, editOpen, selL, activeLine, selV, selOff, edit, marquee]);

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

  /* نگه‌داشتن Space برای پن موقت */
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA") return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        spaceRef.current = true;
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", dn);
      window.removeEventListener("keyup", up);
    };
  }, []);

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

  /* ---------- تشخیص برخورد ---------- */
  const hitSeg = (w: SPoint): SketchSeg | null => {
    const c = camRef.current;
    if (!c) return null;
    const tol = 7 / c.s;
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
  const nearestOnSketch = (w: SPoint): SPoint | null => {
    let best: SPoint | null = null;
    let bestD = Infinity;
    for (const s of segs) {
      const pts = s.kind === "line" ? [s.a, s.b] : segPoints(s, 40);
      for (const p of pts) {
        const d = dist(p, w);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
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
  const selectAllEligible = () => onSelected(eligibleIds());
  const invertSelection = () => {
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
    const copies = segs.filter((s) => selected.includes(s.id)).map((s) => cloneSeg(s, 0, Math.min(6, R * 0.12)));
    commit([...segs, ...copies]);
    onSelected(copies.map((c) => c.id));
  };

  const patchSeg = (id: number, patch: Partial<SketchSeg>, doCommit = true) => {
    const next = segs.map((s) => (s.id === id ? { ...s, ...patch } : s));
    onSegs(next, doCommit);
  };

  /* ویرایش مختصات یک نقطهٔ مستقل */
  const patchPoint = (segId: number, part: "a" | "b" | "c1" | "c2" | "via", patch: Partial<SPoint>) => {
    const next = segs.map((s) => {
      if (s.id !== segId) return s;
      const cur = s[part];
      if (!cur) return s;
      return { ...s, [part]: { ...cur, ...patch } } as SketchSeg;
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
    if (!editOpen || !shiftDown || activeLine == null || hoverBuf == null) return [] as number[];
    const from = lines.findIndex((l) => l.id === activeLine);
    const to = lines.findIndex((l) => l.id === hoverBuf);
    if (from < 0 || to < 0) return [] as number[];
    const lo = Math.min(from, to), hi = Math.max(from, to);
    return lines.slice(lo, hi + 1).map((l) => l.id);
  }, [editOpen, shiftDown, activeLine, hoverBuf, lines]);
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
    setSelV([]); setHitPicker(null);
  }, [isolatedOpId]);

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
    if (!editOpen || !cam) return [] as { kind: SegKind; opId: number; d: string }[];
    const out: { kind: SegKind; opId: number; d: string }[] = [];
    let cur: { kind: SegKind; opId: number; pts: [number, number][] } | null = null;
    const flush = () => {
      if (cur && cur.pts.length > 1) {
        let d = `M ${cur.pts[0][0].toFixed(1)} ${cur.pts[0][1].toFixed(1)}`;
        for (let i = 1; i < cur.pts.length; i++) d += ` L ${cur.pts[i][0].toFixed(1)} ${cur.pts[i][1].toFixed(1)}`;
        out.push({ kind: cur.kind, opId: cur.opId, d });
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
      if (!cur || cur.kind !== kind || cur.opId !== l.opId) {
        flush();
        cur = { kind, opId: l.opId, pts: [screenPt(cam, a.z, a.x / 2)] };
      }
      cur.pts.push(screenPt(cam, b.z, b.x / 2));
    }
    flush();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, cam, settings, editOpen]);

  const lineHitDistance = (c: Cam, l: ELine, px: number, py: number) => {
    const [x1, y1, x2, y2] = bufPx(c, l);
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 || 1;
    const t = Math.min(1, Math.max(0, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / len2));
    return Math.hypot(px - (x1 + (x2 - x1) * t), py - (y1 + (y2 - y1) * t));
  };
  const bufSelectable = (l: ELine) => bufVisible(l) && (isolatedOpId == null || l.opId === isolatedOpId);
  const hitBufLines = (px: number, py: number): number[] => {
    const c = camRef.current;
    if (!c || !editOpen) return [];
    return lines.filter(bufSelectable).map((l) => ({ id: l.id, d: lineHitDistance(c, l, px, py) }))
      .filter((h) => h.d <= 6).sort((a, b) => a.d - b.d).map((h) => h.id);
  };
  const hitBufLine = (px: number, py: number) => hitBufLines(px, py)[0] ?? null;

  /* تمام رأس‌های نزدیک قابل انتخاب‌اند؛ برای هم‌پوشانی، انتخاب‌گر باز می‌شود. */
  const hitBufVerts = (px: number, py: number): number[] => {
    const c = camRef.current;
    if (!c || !editOpen || !showPathPoints) return [];
    const allowed = new Set(lines.filter(bufSelectable).flatMap((l) => [l.va, l.vb]));
    return verts.filter((v) => allowed.has(v.id)).map((v) => {
      const [x, y] = screenPt(c, v.z, v.x / 2); return { id: v.id, d: Math.hypot(px - x, py - y) };
    }).filter((h) => h.d <= 8.5).sort((a, b) => a.d - b.d).map((h) => h.id);
  };
  const hitBufVx = (px: number, py: number) => hitBufVerts(px, py)[0] ?? null;

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
    const inR = (z: number, r: number) => z >= rectW.z0 - 1e-9 && z <= rectW.z1 + 1e-9 && r >= rectW.r0 - 1e-9 && r <= rectW.r1 + 1e-9;
    for (const v of edit!.verts) if (inR(v.z, v.x / 2)) vxs.push(v.id);
    for (const l of edit!.lines) {
      if (!bufVisible(l)) continue;
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
    | { mode: "eline"; ids: number[]; start: SPoint; base: Map<number, EVert>; sx: number; sy: number; moved: boolean }
    | { mode: "evert"; vid: number; start: SPoint; base: EVert; sx: number; sy: number; moved: boolean }
    | { mode: "eoff"; id: number; last: SPoint; seed: SketchSeg; sx: number; sy: number; moved: boolean }
    | { mode: "eoffh"; id: number; part: "a" | "b" | "c1" | "c2" | "via"; sx: number; sy: number; moved: boolean }
    | null
  >(null);

  const toLocal = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!camRef.current) return;
    setCtxMenu(null);
    /* گرفتن اشاره‌گر روی خودِ SVG تا رویدادهای move/up همیشه به آن برسند */
    svgRef.current?.setPointerCapture?.(e.pointerId);
    const raw = toWorld(e.clientX, e.clientY);

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

    if (tool !== "select") {
      /* حالت ترسیم — کلیک بدون حرکت نقطه ثبت می‌کند، کشیدن نما را جابه‌جا می‌کند */
      drag.current = { mode: "draw", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false };
      return;
    }

    /* پن صریح (دکمهٔ دست یا Space) بر باکس انتخاب اولویت دارد */
    if (panMode || spaceRef.current) {
      drag.current = { mode: "pan", sx: e.clientX, sy: e.clientY, cam0: camRef.current, moved: false, btn: 0 };
      return;
    }

    const h = editOpen ? null : hitHandle(raw);
    if (h) {
      /* نقاط انتهاییِ هم‌مکان به‌صورت یک خوشه با هم جابه‌جا می‌شوند؛ انتخاب نقطه در pointerup */
      const cluster = h.part === "a" || h.part === "b" ? clusterOf(h.segId, h.part) : [h];
      drag.current = { mode: "handle", ref: h, cluster, moved: false };
      return;
    }

    /* --- حالت ویرایش مسیر — رأسِ انتخابی، سرِ افست، منحنی افست، بدنهٔ خط --- */
    if (editOpen) {
      const ploc = toLocal(e.clientX, e.clientY);
      const nearVerts = hitBufVerts(ploc.x, ploc.y);
      const nearLines = hitBufLines(ploc.x, ploc.y);

      /* Shift+کلیک: انتخاب قطعی بازهٔ هندسی از Segment فعال تا هدف، همراه با
         حفظ تمام انتخاب‌های قبلی. اولویت آن از انتخاب Vertex بالاتر است. */
      if ((e.shiftKey || shiftRef.current) && activeLine != null && nearLines.length) {
        const target = nearLines[0];
        const from = lines.findIndex((line) => line.id === activeLine);
        const to = lines.findIndex((line) => line.id === target);
        if (from >= 0 && to >= 0) {
          const lo = Math.min(from, to), hi = Math.max(from, to);
          const range = lines.slice(lo, hi + 1).map((line) => line.id);
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
      const bl = hitBufLine(ploc.x, ploc.y);
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
        selectEditLines(ids, bl, true);
        setSelV([]);
        const vset = new Set<number>();
        for (const l of lines) if (ids.includes(l.id)) { vset.add(l.va); vset.add(l.vb); }
        const base = new Map<number, EVert>();
        for (const vid of vset) base.set(vid, { ...vz(vid) });
        drag.current = { mode: "eline", ids, start: raw, base, sx: e.clientX, sy: e.clientY, moved: false };
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
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const raw = toWorld(e.clientX, e.clientY);
    if (readoutRef.current) readoutRef.current.textContent = editOpen ? `محور طولی ${raw.z.toFixed(2)}   محور شعاعی ${raw.r.toFixed(2)}` : `X ${raw.z.toFixed(1)}   Y⌀ ${(raw.r * 2).toFixed(1)}`;

    const d = drag.current;
    if (!d) {
      if (tool === "select") {
        /* اگر نشانگر روی خودِ نقطه باشد، المان زیرین hover نشود تا فقط نقطه سفید شود */
        const onHandle = !editOpen && hitHandle(raw) != null;
        let hb: number | null = null;
        if (editOpen && !onHandle) {
          const ploc = toLocal(e.clientX, e.clientY);
          hb = hitOffSeg(ploc.x, ploc.y) == null ? hitBufLine(ploc.x, ploc.y) : null;
        }
        if (editOpen && hb != null) {
          setHoverBuf(hb);
          setHoverId(null);
        } else {
          if (editOpen) setHoverBuf(null);
          const s = editOpen || onHandle ? null : hitSeg(raw);
          setHoverId(s ? s.id : null);
        }
        setSnapHit(null);
      } else if (tool === "split") {
        /* ابزار Split مغناطیسی به پروفیل می‌چسبد */
        setCursor(nearestOnSketch(raw));
        setSnapHit(null);
      } else {
        const { p, hit } = applySnap(raw);
        setCursor(clampPt(p));
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
      const nv = verts.map((v) => {
        const b0 = d.base.get(v.id);
        return b0 ? { ...v, z: b0.z + qz, x: b0.x + 2 * qr } : v;
      });
      setBufGeom(nv, lines, false);
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
      setMarqueeHits(marqueeHitIds(rectW, mode));
      setMarqueePointHits(marqueeHitPoints(rectW));
      if (editOpen) setBufMarq(bufMarqueeHits(rectW, mode));
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
        setCursor(clampPt(p));
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
      const pt = clampPt(p);

      let next = segs;
      if (inMulti) {
        const refSeg = segs.find((s) => s.id === d.ref.segId);
        const refPt = refSeg ? refSeg[d.ref.part] : null;
        if (refPt) {
          const dz = pt.z - refPt.z;
          const dr = pt.r - refPt.r;
          /* خوشهٔ هر نقطهٔ انتخابی جابه‌جا می‌شود تا اتصالِ نقاط هم‌مکان پاره نشود */
          const toMove = new Map<string, { segId: number; part: "a" | "b" | "c1" | "c2" | "via" }>();
          for (const sp of selPoints) {
            if (sp.part === "a" || sp.part === "b") {
              for (const c of clusterOf(sp.segId, sp.part)) toMove.set(`${c.segId}:${c.part}`, c);
            } else {
              toMove.set(`${sp.segId}:${sp.part}`, sp);
            }
          }
          for (const m of toMove.values()) {
            next = next.map((s) => {
              if (s.id !== m.segId) return s;
              const cur = s[m.part];
              if (!cur) return s;
              return { ...s, [m.part]: { z: cur.z + dz, r: cur.r + dr } } as SketchSeg;
            });
          }
        }
      } else {
        /* جابه‌جایی هم‌زمان همهٔ نقاطِ خوشه تا اتصال حفظ شود */
        for (const h of d.cluster) {
          next = next.map((s) => (s.id === h.segId ? ({ ...s, [h.part]: pt } as SketchSeg) : s));
        }
      }
      onSegs(next, false);
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
      const dz = raw.z - d.last.z;
      const dr = raw.r - d.last.r;
      d.last = raw;
      onSegs(
        segs.map((s) => (d.ids.includes(s.id) ? moveSeg(s, dz, dr) : s)),
        false
      );
    }
  };

  /* بازکردن منوی اتصال/جداسازی نقطه در موقعیت صفحه */
  const openJoinMenu = (clientX: number, clientY: number) => {
    if (tool !== "select") return;
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
    const d = drag.current;
    drag.current = null;
    setSnapHit(null);

    /* --- حالت ویرایش مسیر: ثبت ژست (نرمال‌سازی + تاریخچه) --- */
    if (d?.mode === "eline" || d?.mode === "evert") {
      if (edit && d.moved) setBufGeom(edit.verts, edit.lines, true);
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
      if (wasClick) {
        /* کلیک روی فضای خالی: بدون اصلاح‌کننده پاک‌کردن انتخاب المان‌ها و نقاط */
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          onSelected([]);
          setSelPoints([]);
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
            selectEditLines(nextLines, nextLines.includes(activeLine ?? -1) ? activeLine : null, true);
            setSelV(selV.filter((id) => !bh.vxs.includes(id)));
          } else if (add) {
            const nextLines = [...selL, ...bh.ids.filter((id) => !selL.includes(id))];
            selectEditLines(nextLines, bh.ids[bh.ids.length - 1] ?? activeLine, true);
            setSelV([...selV, ...bh.vxs.filter((id) => !selV.includes(id))]);
          } else {
            selectEditLines(bh.ids, bh.ids[bh.ids.length - 1] ?? null, true);
            setSelV(bh.vxs);
          }
          setBufMarq(null);
          return;
        }
        setBufMarq(null);
      }
      const hits = marqueeHitIds(rectW, mode);
      const pointHits = marqueeHitPoints(rectW);
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
      return;
    }

    if (d && (d.mode === "handle" || d.mode === "move")) {
      if (d.mode === "handle") {
        const ref = d.ref;
        const pkey = (p: { segId: number; part: string }) => `${p.segId}:${p.part}`;
        const exists = selPoints.some((p) => pkey(p) === pkey(ref));
        if (d.moved) {
          onSegs(segs, true); // ثبت در تاریخچه
          if (!e.shiftKey && !exists) setSelPoints([ref]); // نقطهٔ درگ‌شده انتخاب بماند
        } else if (e.shiftKey) {
          setSelPoints(exists ? selPoints.filter((p) => pkey(p) !== pkey(ref)) : [...selPoints, ref]);
        } else if (e.ctrlKey || e.metaKey) {
          setSelPoints(selPoints.filter((p) => pkey(p) !== pkey(ref)));
        } else {
          setSelPoints([ref]);
        }
        return;
      }
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

    if (tool !== "select" && (!d || ((d.mode === "draw" || d.mode === "pan") && !d.moved))) {
      /* ابزار Split: قرار دادن نقطه تعیین‌کننده روی پروفیل */
      if (tool === "split") {
        const hit = nearestOnSketch(toWorld(e.clientX, e.clientY));
        if (hit) onSplit({ enabled: true, z: Math.round(hit.z * 10) / 10, r: Math.round(hit.r * 10) / 10 });
        return;
      }
      /* افزودن نقطهٔ جدید به ترسیم در حال انجام */
      const { p } = applySnap(toWorld(e.clientX, e.clientY));
      const pt = clampPt(p);
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
    if (!cam) return [] as { kind: SegKind; opId: number; holder: 1 | 2; d: string; arrows: string; sx: number; sy: number }[];
    const out: { kind: SegKind; opId: number; holder: 1 | 2; d: string; arrows: string; sx: number; sy: number }[] = [];
    let curKind: SegKind | null = null;
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
        if (curKind !== "rapid") {
          const step = Math.max(1, Math.ceil((pts.length - 1) / 6));
          for (let i = step; i < pts.length - 1; i += step) {
            arrows += arrowHead(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
          }
        } else if ((curFan > 0 || curFanU !== 0) && pts.length >= 2) {
          /* حرکت سریعِ گسترده‌شده در جی‌کد: پیکان جهت در انتها */
          const n = pts.length;
          arrows = arrowHead(pts[n - 2][0], pts[n - 2][1], pts[n - 1][0], pts[n - 1][1]);
        }
        out.push({ kind: curKind, opId: curOpId, holder: curHolder, d, arrows, sx: pts[0][0], sy: pts[0][1] });
      }
      curKind = null;
      curFan = -1;
      curFanU = 0;
      pts = [];
    };
    for (const sg of gen.segs) {
      const kind: SegKind = sg.motion === 0 ? "rapid" : sg.kind;
      /* آفست نمایشی = همان گسترش جی‌کد (فقط قطر، فقط حرکت سریع) */
      const fan = kind === "rapid" ? sg.fan ?? 0 : 0;
      const fanU = kind === "rapid" ? sg.fanU ?? 0 : 0;
      if (kind !== curKind || sg.opId !== curOpId || sg.holder !== curHolder || fan !== curFan || fanU !== curFanU) {
        flush();
        curKind = kind;
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
  }, [gen.segs, cam]);

  const ghostPath = useMemo(() => {
    if (!cam || gen.samples.length < 2) return "";
    let d = "";
    gen.samples.forEach((s, i) => {
      const [x, y] = screenPt(cam, s.z, s.r);
      d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    for (let i = gen.samples.length - 1; i >= 0; i--) {
      const [x, y] = screenPt(cam, gen.samples[i].z, -gen.samples[i].r);
      d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d + "Z";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.samples, cam]);

  const innerGhost = useMemo(() => {
    if (!cam || gen.innerSamples.length < 2) return "";
    let d = "";
    gen.innerSamples.forEach((s, i) => {
      const [x, y] = screenPt(cam, s.z, s.r);
      d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    for (let i = gen.innerSamples.length - 1; i >= 0; i--) {
      const [x, y] = screenPt(cam, gen.innerSamples[i].z, -gen.innerSamples[i].r);
      d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d + "Z";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.innerSamples, cam]);

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
  if (editOpen && selectedLineIds.size) {
    for (const line of lines) {
      if (!selectedLineIds.has(line.id)) continue;
      if (line.id === activeLine) activeLinePath += `${lineD(line)} `;
      else selectedLinesPath += `${lineD(line)} `;
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
  const gridZ: number[] = [];
  for (let z = 0; z <= L + 0.001; z += 10) gridZ.push(z);
  const gridR: number[] = [];
  for (let r = 10; r <= R + 0.001; r += 10) gridR.push(r);

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
  const stepText = tool !== "select" ? STEP_HINT[tool][Math.min(stepIdx, STEP_HINT[tool].length - 1)] : "";

  /* اندازهٔ زندهٔ خط در حال ترسیم */
  let liveInfo = "";
  if (tool !== "select" && draft.length >= 1 && cursor) {
    const a = draft[0];
    const b = draft.length === 1 ? cursor : draft[1];
    liveInfo = `طول ${dist(a, b).toFixed(1)}  •  زاویه ${lineAngle(a, b).toFixed(1)}°`;
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg border border-edge bg-[#120e09]">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className={cn(
          "block touch-none select-none",
          panMode || spaceDown
            ? "cursor-grab"
            : tool !== "select"
              ? "cursor-crosshair"
              : marquee
                ? "cursor-crosshair"
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
          if (!drag.current) setHoverBuf(null);
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

        {/* شبکه */}
        <g>
          {gridZ.map((z) => {
            const sx = cam.ox + z * cam.s;
            return (
              <line key={`v${z}`} x1={sx} y1={cam.oy - R * cam.s} x2={sx} y2={cam.oy + R * cam.s} stroke={z % 50 === 0 ? "rgba(209,183,134,0.16)" : "rgba(209,183,134,0.07)"} strokeWidth={1} />
            );
          })}
          {gridR.map((r) => (
            <g key={`h${r}`}>
              <line x1={cam.ox} y1={cam.oy - r * cam.s} x2={cam.ox + L * cam.s} y2={cam.oy - r * cam.s} stroke={(r * 2) % 50 === 0 ? "rgba(209,183,134,0.14)" : "rgba(209,183,134,0.07)"} strokeWidth={1} />
              <line x1={cam.ox} y1={cam.oy + r * cam.s} x2={cam.ox + L * cam.s} y2={cam.oy + r * cam.s} stroke={(r * 2) % 50 === 0 ? "rgba(209,183,134,0.14)" : "rgba(209,183,134,0.07)"} strokeWidth={1} />
            </g>
          ))}
          {gridZ.filter((z) => z % 50 === 0).map((z) => (
            <text key={`lz${z}`} x={cam.ox + z * cam.s} y={cam.oy + R * cam.s + 18} textAnchor="middle" fontSize="10" fill="#8b7c5f" fontFamily="JetBrains Mono, monospace">
              {z}
            </text>
          ))}
          {gridR.map((r) => (
            <text key={`lr${r}`} x={cam.ox - 8} y={cam.oy - r * cam.s + 3.5} textAnchor="end" fontSize="10" fill="#8b7c5f" fontFamily="JetBrains Mono, monospace">
              ⌀{Math.round(r * 2)}
            </text>
          ))}
          <text x={cam.ox + L * cam.s + 10} y={cam.oy + 3.5} fontSize="11" fill="#a8946f" fontFamily="JetBrains Mono, monospace" fontWeight={700}>X</text>
          <text x={cam.ox - 8} y={cam.oy - R * cam.s - 10} textAnchor="end" fontSize="11" fill="#a8946f" fontFamily="JetBrains Mono, monospace" fontWeight={700}>Y ⌀</text>
        </g>

        <line x1={0} y1={cam.oy} x2={size.w} y2={cam.oy} stroke="rgba(227,169,78,0.35)" strokeWidth={1} strokeDasharray="10 4 2 4" />
        <rect x={cam.ox} y={cam.oy - R * cam.s} width={L * cam.s} height={2 * R * cam.s} fill="url(#hatch)" stroke="rgba(227,169,78,0.55)" strokeWidth={1.3} strokeDasharray="7 5" />

        {!editOpen && settings.showGhost && ghostPath && (
          <g style={{ opacity: iso ? 0.15 : 1, ...fadeStyle }}>
            <path d={ghostPath} fill="rgba(227,169,78,0.12)" stroke="rgba(227,169,78,0.4)" strokeWidth={1} />
          </g>
        )}
        {!editOpen && settings.showGhost && innerGhost && (
          <g style={{ opacity: iso ? 0.15 : 1, ...fadeStyle }}>
            <path d={innerGhost} fill="rgba(76,201,240,0.10)" stroke="rgba(76,201,240,0.55)" strokeWidth={1} strokeDasharray="5 4" />
          </g>
        )}

        {/* مسیر ابزار */}
        <g>
          {runs.map((run, i) => {
            if (editOpen || !settings[KIND_VISIBLE[run.kind]]) return null;
            const isRapid = run.kind === "rapid";
            const matchIso = iso && run.opId === isolatedOpId;
            const dim = iso && !matchIso;
            if (dim && isRapid) return null;
            const color = SEG_COLOR[run.kind];
            const baseOpacity = isRapid ? 0.28 : run.kind === "offset" ? 0.9 : 0.8;
            return (
              <g key={i} style={{ opacity: dim ? 0.06 : 1, ...fadeStyle }}>
                <path d={run.d} fill="none" stroke={color} strokeOpacity={matchIso ? 1 : baseOpacity} strokeWidth={(isRapid ? 1 : run.kind === "finish" ? 1.8 : 1.4) + (matchIso ? 0.7 : 0)} strokeDasharray={isRapid ? "4 4" : run.kind === "offset" ? "7 4" : undefined} strokeLinejoin="round" strokeLinecap="round" filter={matchIso ? "url(#curveGlow)" : undefined} />
                {run.arrows && !dim && <path d={run.arrows} fill={color} fillOpacity={0.95} />}
                {run.holder === 2 && !dim && !isRapid && (
                  <g>
                    <rect x={run.sx - 12} y={run.sy - 21} width={24} height={13} rx={3} fill="#120e09" stroke="#4cc9f0" strokeWidth={1} />
                    <text x={run.sx} y={run.sy - 11} textAnchor="middle" fontSize={8.5} fontWeight={800} fontFamily="JetBrains Mono, monospace" fill="#4cc9f0">
                      H2
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>

        {/* ---------- حالت ویرایش مسیر — کل مسیر، یک زنجیرۀ پیوسته؛ رنگ هر عملیات مثل قبل ---------- */}
        {editOpen && (
          <g>
            {bufRuns.map((run, i) => {
              const isRapid = run.kind === "rapid";
              const matchIso = iso && run.opId === isolatedOpId;
              const dim = iso && !matchIso;
              if (dim && isRapid) return null;
              return (
                <path
                  key={`br${i}`}
                  d={run.d}
                  fill="none"
                  stroke={SEG_COLOR[run.kind]}
                  strokeOpacity={pickerHover ? (dim ? 0.025 : 0.1) : dim ? 0.06 : matchIso ? 1 : isRapid ? 0.4 : 0.9}
                  strokeWidth={(isRapid ? 1.1 : run.kind === "finish" ? 1.8 : 1.5) + (matchIso ? 0.7 : 0)}
                  strokeDasharray={isRapid ? "4 4" : run.kind === "offset" ? "7 4" : undefined}
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
                  stroke={SEG_COLOR[kind]}
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
            {pathStart && (() => {
              const [x, y] = P(pathStart.z, pathStart.x / 2);
              return (
                <g transform={`translate(${x + (pathEndsCoincident ? -13 : 0)} ${y})`} pointerEvents="none" filter="url(#curveGlow)">
                  {pathEndsCoincident && <line x1={8} y1={0} x2={13} y2={0} stroke="#45d19f" strokeWidth={2} />}
                  <circle r={8} fill="#102b24" stroke="#45d19f" strokeWidth={2.5} />
                  <text y={3.2} textAnchor="middle" fontSize={9} fontWeight={900} fill="#8fffd7">S</text>
                  <text x={11} y={-9} fontSize={9} fontWeight={800} fill="#8fffd7">شروع</text>
                </g>
              );
            })()}
            {pathEnd && (() => {
              const [x, y] = P(pathEnd.z, pathEnd.x / 2);
              return (
                <g transform={`translate(${x + (pathEndsCoincident ? 13 : 0)} ${y})`} pointerEvents="none" filter="url(#curveGlow)">
                  {pathEndsCoincident && <line x1={-8} y1={0} x2={-13} y2={0} stroke="#ff756f" strokeWidth={2} />}
                  <path d="M 0 -11 L 11 0 L 0 11 L -11 0 Z" fill="#35191a" fillOpacity={0.82} stroke="#ff756f" strokeWidth={2.5} />
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
                <path d={selectedLinesPath} fill="none" stroke="#45b394" strokeOpacity={pickerHover ? 0.08 : 1} strokeWidth={3} strokeLinecap="round" pointerEvents="none" />
              </>
            )}
            {activeLinePath && (
              <>
                <path d={activeLinePath} fill="none" stroke="#ffd27a" strokeOpacity={pickerHover ? 0.02 : 0.24} strokeWidth={9} strokeLinecap="round" pointerEvents="none" />
                <path d={activeLinePath} fill="none" stroke="#ffd27a" strokeOpacity={pickerHover ? 0.08 : 1} strokeWidth={4.2} strokeLinecap="round" pointerEvents="none" />
              </>
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
                  <circle cx={x} cy={y} r={8} fill={on ? "#ffd27a" : "#45b394"} fillOpacity={0.12} pointerEvents="none" />
                  <circle className="pt-hover" cx={x} cy={y} r={5.5} fill={on ? "#ffd27a" : shared ? "#0f2a22" : "#120e09"} stroke={on ? "#120e09" : "#45b394"} strokeWidth={2.4} />
                </g>
              );
            })}
          </g>
        )}

        {/* المان‌های اسکچ */}
        <g style={{ opacity: editOpen ? 0.12 : iso ? 0.3 : 1, ...fadeStyle }}>
          {/* آینهٔ پایین محور */}
          {segs.map((s) => (
            <path key={`m${s.id}`} d={segPath(s, cam, true)} fill="none" stroke={segSide.get(s.id) === "inner" ? "#4cc9f0" : "#e3a94e"} strokeOpacity={0.28} strokeWidth={1.6} strokeLinecap="round" />
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
                stroke={sel ? "#45b394" : hasSelPt ? "#ffd27a" : hov ? "#fff3dc" : base}
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

          {/* نشانگر نقاط مستقلِ انتخاب‌شده — رنگ خود نقطه تغییر می‌کند */}
          {selPoints.map((ps, i) => {
            const s = segs.find((x) => x.id === ps.segId);
            const pt = s ? s[ps.part] : null;
            if (!s || !pt) return null;
            const [x, y] = P(pt.z, pt.r);
            const isCtrl = ps.part === "c1" || ps.part === "c2";
            return (
              <g key={`selpt-${i}`} filter="url(#curveGlow)">
                <circle
                  className="pt-hover"
                  cx={x}
                  cy={y}
                  r={isCtrl ? 6 : 6.5}
                  fill="#ffd27a"
                  stroke="#120e09"
                  strokeWidth={1.8}
                />
              </g>
            );
          })}

          {/* دسته‌ها و نقاط المان‌های انتخاب‌شده یا دارای نقطهٔ مستقلِ انتخاب‌شده */}
          {handleSegs.map((s) => {
            const [ax, ay] = P(s.a.z, s.a.r);
            const [bx, by] = P(s.b.z, s.b.r);
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
              </g>
            );
          })}

          {/* نقاط انتهایی همهٔ المان‌ها — همیشه قابل‌دیدن برای اتصال و راست‌کلیک
              (المان‌هایی که دسته‌هایشان در بالا رندر شده اینجا تکرار نمی‌شوند) */}
          {segs.map(
            (s) =>
              !selected.includes(s.id) &&
              !selPointSegIds.includes(s.id) && (
                <g key={`e${s.id}`} className="opacity-80">
                  <circle className="pt-hover" cx={P(s.a.z, s.a.r)[0]} cy={P(s.a.z, s.a.r)[1]} r={3.4} fill="#241c12" stroke="#e3a94e" strokeWidth={1.6} />
                  <circle className="pt-hover" cx={P(s.b.z, s.b.r)[0]} cy={P(s.b.z, s.b.r)[1]} r={3.4} fill="#241c12" stroke="#e3a94e" strokeWidth={1.6} />
                </g>
              )
          )}
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
        {tool !== "select" && cursor && (
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
              const ym = P(split.z, -split.r)[1];
              return (
                <g>
                  {[y, ym].map((yy, k) => (
                    <g key={k} filter="url(#curveGlow)">
                      <rect x={x - 7} y={yy - 7} width={14} height={14} transform={`rotate(45 ${x} ${yy})`} fill="#f72585" stroke="#120e09" strokeWidth={1.8} />
                      <circle cx={x} cy={yy} r={2.2} fill="#ffffff" />
                    </g>
                  ))}
                  <text x={x + 13} y={y - 9} fontSize={10} fontFamily="Vazirmatn, sans-serif" fontWeight={800} fill="#f72585" stroke="#120e09" strokeWidth={3} paintOrder="stroke">
                    Split
                  </text>
                </g>
              );
            })()}
          </g>
        )}

        {/* پیش‌نمایش نامزدهای باکس انتخاب */}
        {marquee &&
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
        {marquee &&
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
                    {crossing ? "متقاطع" : "پنجره‌ای"} • {marqueeHits.length} المان، {marqueePointHits.length} نقطه
                    {marquee.remove ? " − حذف" : marquee.add ? " + افزودن" : ""}
                  </text>
                </>
              );
            })()}
          </g>
        )}
      </svg>

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

      {/* ---------- نوار ابزار ترسیم: ستون عمودی چپ ---------- */}
      <div className="absolute top-2.5 bottom-2.5 left-2.5 flex w-[30px] flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-edge bg-panel/92 shadow-lg shadow-black/30 backdrop-blur-sm">
          {TOOLS.map((t, i) => (
            <button
              key={t.id}
              onClick={() => {
                setTool(t.id);
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
          <button onClick={deleteSelected} disabled={!selected.length} title="حذف انتخابی (Delete)" className={cn("grid h-[27px] w-full border-t border-edge place-items-center transition-colors", selected.length ? "text-danger/80 hover:bg-danger/15 hover:text-danger" : "text-dim/40")}>
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
            title="پن (جابه‌جایی نما) — یا Space را نگه دارید، یا با دکمهٔ وسط/راست بکشید"
            onClick={() => setPanMode((v) => !v)}
          >
            <IconHand className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ---------- نوار انتخاب ---------- */}
      {tool === "select" && (
        <div className="anim-in absolute bottom-[44px] left-[46px] z-10 flex max-w-[calc(100%-60px)] flex-col gap-1 rounded-lg border border-edge bg-panel/92 px-2.5 py-1.5 shadow-lg shadow-black/40 backdrop-blur-sm">
          <div className="flex items-center justify-center gap-1.5">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                selected.length ? "border-teal/50 text-teal" : "border-edge text-dim"
              )}
            >
              {selected.length ? `${selected.length} انتخاب شده` : "بدون انتخاب"}
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
            <button onClick={() => onSelected([])} disabled={!selected.length} title="لغو انتخاب (Esc)" className="rounded px-1.5 py-0.5 text-[10.5px] font-bold text-mute transition-colors hover:bg-panel3 hover:text-ink disabled:opacity-35">
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
          <button onClick={() => { setTool("select"); cancelDraft(); }} className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-white/10" title="لغو (Esc)">
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
                onClick={() => { setSelV([id]); selectEditLines([], null, true); setHitPicker(null); setPickerHover(null); }}
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
                <span className="h-2 w-2 rounded-full" style={{ background: SEG_COLOR[l.motion === 0 ? "rapid" : l.kind] }} />
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
              <NumF label="X (طول)" v={pt.z} onC={(v) => patchPoint(ps.segId, ps.part, { z: Math.min(L, Math.max(0, v)) })} />
              <NumF label="⌀ (قطر)" v={pt.r * 2} onC={(v) => patchPoint(ps.segId, ps.part, { r: Math.min(R, Math.max(0, v / 2)) })} />
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
          title="درگ چپ‌به‌راست: فقط المان‌های کاملاً داخل باکس (آبی) • راست‌به‌چپ: المان‌های متقاطع (سبز) • Shift: افزودن • Ctrl: حذف • دابل‌کلیک: انتخاب زنجیره • پن: Space یا دکمهٔ وسط/راست"
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
  const clamp = (p: SPoint): SPoint => ({ z: Math.min(blankL, Math.max(0, p.z)), r: Math.min(blankR, Math.max(0, p.r)) });

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
        <NumF label="X شروع" v={seg.a.z} onC={(v) => onPatch({ a: clamp({ ...seg.a, z: v }) })} />
        <NumF label="⌀ شروع" v={seg.a.r * 2} onC={(v) => onPatch({ a: clamp({ ...seg.a, r: v / 2 }) })} />
        <NumF label="X پایان" v={seg.b.z} onC={(v) => onPatch({ b: clamp({ ...seg.b, z: v }) })} />
        <NumF label="⌀ پایان" v={seg.b.r * 2} onC={(v) => onPatch({ b: clamp({ ...seg.b, r: v / 2 }) })} />
      </div>

      {seg.kind === "line" && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumF label="طول" v={len} onC={(v) => onPatch({ b: clamp(endFromLenAngle(seg.a, v, ang)) })} />
          <NumF label="زاویه°" v={ang} onC={(v) => onPatch({ b: clamp(endFromLenAngle(seg.a, len, v)) })} />
        </div>
      )}

      {seg.kind === "arc" && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumF label="شعاع" v={rad} onC={(v) => onPatch(arcWithRadius(seg, v))} />
          <div className="flex items-end">
            <button
              onClick={() => {
                const mz = (seg.a.z + seg.b.z) / 2;
                const mr = (seg.a.r + seg.b.r) / 2;
                const via = seg.via ?? { z: mz, r: mr };
                onPatch({ via: { z: 2 * mz - via.z, r: 2 * mr - via.r } });
              }}
              className="btn w-full justify-center !py-1.5 text-[10.5px]"
              title="معکوس‌کردن جهت برآمدگی کمان"
            >
              معکوس کمان
            </button>
          </div>
        </div>
      )}

      {(seg.kind === "quad" || seg.kind === "cubic") && seg.c1 && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <NumF label="X کنترل۱" v={seg.c1.z} onC={(v) => onPatch({ c1: clamp({ ...seg.c1!, z: v }) })} />
          <NumF label="⌀ کنترل۱" v={seg.c1.r * 2} onC={(v) => onPatch({ c1: clamp({ ...seg.c1!, r: v / 2 }) })} />
          {seg.kind === "cubic" && seg.c2 && (
            <>
              <NumF label="X کنترل۲" v={seg.c2.z} onC={(v) => onPatch({ c2: clamp({ ...seg.c2!, z: v }) })} />
              <NumF label="⌀ کنترل۲" v={seg.c2.r * 2} onC={(v) => onPatch({ c2: clamp({ ...seg.c2!, r: v / 2 }) })} />
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
