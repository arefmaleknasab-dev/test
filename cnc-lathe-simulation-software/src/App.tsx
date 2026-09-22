import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ControlsPanel from "./components/ControlsPanel";
import { DockPanel, DockSplitter, MAX_PANEL, MIN_PANEL, WindowMenu, defaultLayout, normalizeLayout } from "./components/Dock";
import type { LayoutState, PanelId, PanelState, PanelVis, WindowMenuItem } from "./components/Dock";
import GCodePanel from "./components/GCodePanel";
import ProfileEditor, { type EdSettings } from "./components/ProfileEditor";
import SimulationView from "./components/SimulationView";
import { IconCheck, IconCode, IconDownload, IconLayers, IconPen, IconRedo, IconSim, IconSpindle, IconUndo, IconWarn } from "./components/icons";
import { buildDxf } from "./lib/dxf";
import { PRESETS, STRATEGIES, applyGcodeOvr, deriveGcodeOvr, generate, makeOps, normalizeParams, presetPoints, seedGcodeEdit } from "./lib/lathe";
import type { EditBuf, GcodeOvrMap, Params, PPoint, Preset } from "./lib/lathe";
import type { SketchSeg } from "./lib/sketch";
import { autoSplitPoint, branchPoints, chainPolyline, flattenSketch, normalizeSketch, orderChain, sketchFromPoints, sketchFromWall, splitChainAt } from "./lib/sketch";
import { cn } from "./utils/cn";

const STORE_KEY = "kharraatcode-v1";

interface Saved {
  points?: PPoint[];
  sketch?: SketchSeg[];
  params?: Partial<Params>;
  settings?: Partial<EdSettings>;
  layout?: LayoutState;
  activePreset?: string | null;
  gcodeOvr?: Record<string, { s?: { z: number; x: number }; e?: { z: number; x: number }; via?: { z: number; x: number }[]; del?: boolean }>;
  version?: number;
}

const SAVE_VERSION = 6;

let SAVED: Saved | null = null;
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) SAVED = JSON.parse(raw) as Saved;
} catch {
  SAVED = null;
}

/* داده‌های پیش از نسخه ۲: عملیات «spring» و «offset» معنای متفاوتی داشتند */
const IS_LEGACY = !SAVED || !SAVED.version || SAVED.version < 3;

/* گام تاریخچه — یکپارچه: اسکچ + اوررایدهای تأییدشدهٔ جی‌کد + وضعیت/بافرِ حالت ادیت */
interface HistEntry {
  sketch: SketchSeg[];
  gcodeOvr: GcodeOvrMap;
  editBuf: EditBuf | null;
}

/* بازخوانی ایمنِ اوررایدها از حافظهٔ محلی (سنجش نوع پس از پارس) */
function normGcodeOvr(raw: Saved["gcodeOvr"]): GcodeOvrMap {
  const out: GcodeOvrMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const o: { s?: { z: number; x: number }; e?: { z: number; x: number }; via?: { z: number; x: number }[]; del?: boolean } = {};
    const okPt = (q: unknown): q is { z: number; x: number } =>
      !!q &&
      typeof q === "object" &&
      typeof (q as { z: unknown }).z === "number" &&
      typeof (q as { x: unknown }).x === "number" &&
      isFinite((q as { z: number }).z) &&
      isFinite((q as { x: number }).x);
    if (okPt(v.s)) o.s = { z: v.s!.z, x: v.s!.x };
    if (okPt(v.e)) o.e = { z: v.e!.z, x: v.e!.x };
    if (Array.isArray(v.via)) o.via = v.via.filter(okPt).map((q) => ({ z: q.z, x: q.x }));
    if (v.del === true) o.del = true;
    if (o.s || o.e || o.via?.length || o.del) out[k] = o;
  }
  return out;
}

export default function App() {
  const [sketch, setSketch] = useState<SketchSeg[]>(() => {
    const fromSaved = normalizeSketch(SAVED?.sketch);
    if (fromSaved) return fromSaved;
    if (SAVED?.points && SAVED.points.length >= 2) return sketchFromPoints(SAVED.points);
    return sketchFromPoints(presetPoints(PRESETS[0]));
  });
  const [params, setParams] = useState<Params>(() => normalizeParams(SAVED?.params, IS_LEGACY));
  const [settings, setSettings] = useState<EdSettings>(() => {
    const s = SAVED?.settings;
    return {
      snap: s?.snap ?? 1,
      smartSnap: s?.smartSnap ?? true,
      showRough: s?.showRough ?? true,
      showFinish: s?.showFinish ?? true,
      showOffset: s?.showOffset ?? true,
      showBore: s?.showBore ?? true,
      showRound: s?.showRound ?? true,
      showFace: s?.showFace ?? true,
      showBottom: s?.showBottom ?? true,
      showRapids: s?.showRapids ?? true,
      showGhost: s?.showGhost ?? true,
    };
  });
  const [layout, setLayout] = useState<LayoutState>(() => normalizeLayout(SAVED?.layout));
  const [mode, setMode] = useState<"design" | "sim">("design");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(SAVED?.activePreset ?? PRESETS[0].id);
  const [activeLine, setActiveLine] = useState(-1);
  const [isolatedOpId, setIsolatedOpId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "warn" } | null>(null);
  const [, setHistVer] = useState(0);

  /* حالت ویرایش مسیر: فایل = برنامهٔ پایه + اوررایدِ تأییدشده (پیش از «تأیید» فایل دست‌نخورده است) */
  const [gcodeOvr, setGcodeOvr] = useState<GcodeOvrMap>(() => normGcodeOvr(SAVED?.gcodeOvr));
  const [editBuf, setEditBuf] = useState<EditBuf | null>(null);
  const editBufRef = useRef<EditBuf | null>(editBuf);
  editBufRef.current = editBuf;

  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  const toastTimer = useRef<number | null>(null);
  const stateRef = useRef({ sketch, gcodeOvr, editBuf });
  stateRef.current = { sketch, gcodeOvr, editBuf };

  /* تاریخچهٔ یکپارچه: هر گام = {اسکچ، اورراید جی‌کد، بافر ادیت} — واگرد بعد از تأیید
     دقیقاً به همان حالت ادیت و آخرین تغییر بازمی‌گردد (خواستهٔ کاربر) */
  const snap = (): HistEntry => ({ ...stateRef.current });
  const pushPast = (e: HistEntry) => {
    past.current.push(e);
    future.current = [];
    if (past.current.length > 80) past.current.shift();
  };

  /* پروفایل نقطه‌ای برای موتور تراش — حالت عادی تخت، حالت کاسه دوشاخه (Split) */
  const { points, innerPoints, splitInfo } = useMemo(() => {
    const blankR = params.blankD / 2;
    if (params.split.enabled) {
      const poly = chainPolyline(orderChain(sketch));
      if (poly.length >= 3) {
        const sp = splitChainAt(poly, { z: params.split.z, r: params.split.r });
        return {
          points: branchPoints(sp.outer, blankR, params.blankL, "max"),
          innerPoints: branchPoints(sp.inner, blankR, params.blankL, "min"),
          splitInfo: { outerDir: sp.outerDir, innerDir: sp.innerDir, at: sp.splitAt },
        };
      }
    }
    const none: { outerDir: 1 | -1; innerDir: 1 | -1; at: { z: number; r: number } } | null = null;
    return { points: flattenSketch(sketch, blankR, params.blankL), innerPoints: [] as PPoint[], splitInfo: none };
  }, [sketch, params.split, params.blankD, params.blankL]);

  const genBase = useMemo(() => generate(points, params, innerPoints), [points, params, innerPoints]);

  const gen = useMemo(() => applyGcodeOvr(genBase, gcodeOvr, params), [genBase, gcodeOvr, params]);

  /* ذخیره محلی */
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sketch, params, settings, activePreset, layout, gcodeOvr, version: SAVE_VERSION }));
    } catch {
      /* ignore */
    }
  }, [sketch, params, settings, activePreset, layout, gcodeOvr]);

  /* هنگام تغییر برنامه، هایلایت جی‌کد پاک شود */
  useEffect(() => {
    setActiveLine(-1);
  }, [gen]);

  /* اگر عملیاتِ ایزوله‌شده حذف شد، از حالت ایزوله خارج شو */
  useEffect(() => {
    if (isolatedOpId != null && !params.ops.some((o) => o.id === isolatedOpId)) setIsolatedOpId(null);
  }, [params.ops, isolatedOpId]);

  /* واگرد / بازانجام روی اسکچ */
  const commitRef = useRef<HistEntry | null>(null);
  const restore = (e: HistEntry) => {
    setSketch(e.sketch);
    setGcodeOvr(e.gcodeOvr);
    setEditBuf(e.editBuf);
    setHistVer((v) => v + 1);
  };
  const undo = () => {
    if (past.current.length === 0) return;
    future.current.push(snap());
    commitRef.current = null;
    restore(past.current.pop()!);
  };
  const redo = () => {
    if (future.current.length === 0) return;
    past.current.push(snap());
    commitRef.current = null;
    restore(future.current.pop()!);
  };

  /* ---------- حالت ویرایش مسیر ---------- */
  const openEdit = () => {
    if (editBufRef.current) return;
    pushPast(snap());
    const seed = seedGcodeEdit(gen.segs, params);
    setEditBuf({ verts: seed.verts, lines: seed.lines, sketch, off: {} });
    setHistVer((v) => v + 1);
  };
  const closeEdit = () => {
    if (!editBufRef.current) return;
    pushPast(snap());
    setEditBuf(null);
    setHistVer((v) => v + 1);
    showToast("حالت ویرایش مسیر بسته شد — فایل، آخرین وضعیتِ تأییدشده است", "warn");
  };
  const confirmEdit = () => {
    const eb = editBufRef.current;
    if (!eb) return;
    const next = deriveGcodeOvr(eb.verts, eb.lines, genBase.segs, gcodeOvr, params);
    const sketchChanged = eb.sketch !== sketch;
    if (!sketchChanged && JSON.stringify(next) === JSON.stringify(gcodeOvr)) {
      showToast("تغییری برای ثبت نیست", "warn");
      return;
    }
    pushPast(snap());
    setGcodeOvr(next);
    if (sketchChanged) {
      setActivePreset(null);
      setSketch(eb.sketch);
    }
    setHistVer((v) => v + 1);
    showToast("جی‌کد به‌روز شد ✓ (ویرایش مسیر باز ماند)");
  };
  /* تغییرات بافر (خطوط/پروفایل/افست) — یک‌گام تاریخچه برای هر ژست */
  const onEditBuf = (next: EditBuf | null, commit: boolean) => {
    if (!commit) {
      if (!commitRef.current) commitRef.current = snap();
      setEditBuf(next);
      return;
    }
    const pend = commitRef.current ?? snap();
    commitRef.current = null;
    pushPast(pend);
    setEditBuf(next);
    setHistVer((v) => v + 1);
  };

  const showToast = useCallback((msg: string, kind: "ok" | "warn" = "ok") => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  /* کال‌بک‌های پایدار: هویت ثابت تا فرزندهای memo هنگام تیک شبیه‌سازی بازرندر نشوند */
  const onParamsCb = useCallback((patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch })), []);
  const onStrategyCb = useCallback((name: string) => showToast(`استراتژی «${name}» فعال شد`), [showToast]);

  /* ---------- چیدمان داک (پنجره‌ها) ---------- */
  const setPanel = useCallback((id: PanelId, patch: Partial<PanelState>) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], ...patch } }));
  }, []);
  const togglePanel = useCallback((id: PanelId) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], open: !l[id].open } }));
  }, []);
  const toggleCollapse = useCallback((id: PanelId) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], collapsed: !l[id].collapsed } }));
  }, []);
  const resizePanel = useCallback((id: PanelId, dx: number) => {
    setLayout((l) => {
      const max = Math.max(360, window.innerWidth - 560);
      const size = Math.min(Math.min(MAX_PANEL, max), Math.max(MIN_PANEL, Math.round(l[id].size + dx)));
      if (size === l[id].size) return l;
      return { ...l, [id]: { ...l[id], size } };
    });
  }, []);
  const resetPanelSize = useCallback((id: PanelId) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], size: defaultLayout()[id].size } }));
  }, []);
  const resetLayout = useCallback(() => {
    setLayout(defaultLayout());
    showToast("چیدمان پنجره‌ها بازنشانی شد");
  }, [showToast]);
  const panelVis = (id: PanelId): PanelVis =>
    !layout[id].open ? "closed" : layout[id].collapsed ? "collapsed" : "open";

  /* تغییر اسکچ — با commit=false تغییر زنده (کشیدن) و با true ثبت در تاریخچه */
  const onSketchChange = useCallback((next: SketchSeg[], commit: boolean) => {
    /* در حالت ادیت، ویرایش پروفایل روی کپیِ کاریِ بافر می‌نشیند (فایل تا «تأیید» عوض نمی‌شود) */
    if (editBufRef.current) {
      if (!commit && !commitRef.current) commitRef.current = snap();
      onEditBuf({ ...editBufRef.current, sketch: next }, commit);
      return;
    }
    if (commit) {
      pushPast(commitRef.current ?? { sketch, gcodeOvr, editBuf: null });
      commitRef.current = null;
      setActivePreset(null);
    } else if (!commitRef.current) {
      commitRef.current = { sketch, gcodeOvr, editBuf: null }; // وضعیت پیش از شروع کشیدن
    }
    setSketch(next);
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch, gcodeOvr]);

  const applyPreset = useCallback((p: Preset) => {
    if (p.wall) {
      /* کاسه: دیواره به ترتیب مسیر (خارج ← لبه ← داخل) ساخته می‌شود */
      onSketchChange(
        sketchFromWall(p.wall.map(([z, r, smooth]) => ({ z, r, smooth }))),
        true
      );
    } else {
      onSketchChange(sketchFromPoints(presetPoints(p)), true);
    }
    setParams((prev) => {
      const next: Params = { ...prev, blankD: p.blankD, blankL: p.blankL };
      if (p.shape) next.blankShape = p.shape;
      next.split = p.split
        ? { enabled: true, z: p.split.z, r: p.split.r }
        : { ...prev.split, enabled: false };
      if (p.strategy) {
        const st = STRATEGIES.find((s) => s.id === p.strategy);
        if (st) next.ops = makeOps(st.types);
      }
      return next;
    });
    setActivePreset(p.id);
    setSelectedIds([]);
    showToast(
      p.strategy === "bowl"
        ? `پیش‌تنظیم «${p.name}» + استراتژی داخل/خارج فعال شد`
        : `پیش‌تنظیم «${p.name}» اعمال شد`
    );
  }, [onSketchChange, showToast]);

  /* قرار دادن خودکار نقطه Split روی لبه (بیشترین X زنجیره) */
  const autoSplit = useCallback(() => {
    const poly = chainPolyline(orderChain(sketch));
    const auto = autoSplitPoint(poly);
    if (auto) {
      setParams((prev) => ({ ...prev, split: { ...prev.split, enabled: true, z: auto.z, r: auto.r } }));
      showToast(`نقطه Split روی لبه قرار گرفت (X ${auto.z} • ⌀ ${(auto.r * 2).toFixed(1)})`);
    } else {
      showToast("زنجیره پروفیل برای Split خودکار کافی نیست", "warn");
    }
  }, [sketch, showToast]);

  /* متن جی‌کد با پایان‌خط CRLF (سازگار با CIMCO/ویندوز و کنترلرها) */
  const gcodeText = () => gen.lines.join("\r\n");

  const copyGCode = async () => {
    const text = gcodeText();
    /* ۱) Clipboard API مدرن — روی http یا داخل iframe ممکن است در دسترس نباشد */
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        showToast("جی‌کد در کلیپ‌بورد کپی شد");
        return;
      }
    } catch {
      /* ادامه به fallback */
    }
    /* ۲) fallback: textarea موقت + execCommand (روی http هم کار می‌کند) */
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (!ok) throw new Error("copy-failed");
      showToast("جی‌کد در کلیپ‌بورد کپی شد");
    } catch {
      showToast("کپی ممکن نشد — فایل را دانلود کنید", "warn");
    }
  };
  const downloadGCode = () => {
    const blob = new Blob([gcodeText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kharraatcode.nc";
    a.click();
    URL.revokeObjectURL(url);
    showToast("فایل kharraatcode.nc آماده شد");
  };

  const downloadDxf = () => {
    const { text, vertexCount, opCount } = buildDxf(gen.segs, params.ops, params.blankL, params.blankD / 2);
    const blob = new Blob([text], { type: "application/dxf;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kharraatcode-cutpath.dxf";
    a.click();
    URL.revokeObjectURL(url);
    showToast(`مسیر برشی ${opCount.toLocaleString("fa-IR")} عملیات با ${vertexCount.toLocaleString("fa-IR")} نقطه به DXF تبدیل شد`);
  };

  const editorTitle = mode === "design" ? "طراحی پروفایل" : "شبیه‌سازی تراش";
  const menuItems: WindowMenuItem[] = [
    { id: "controls", label: "تنظیمات", vis: panelVis("controls") },
    { id: "editor", label: editorTitle, vis: panelVis("editor") },
    { id: "gcode", label: "جی‌کد", vis: panelVis("gcode") },
  ];

  return (
    <div className="flex h-full flex-col @container">
      {/* ---------- سربرگ ---------- */}
      <header className="relative z-40 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel/85 px-3.5 py-2 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg border border-brass/40 bg-gradient-to-b from-panel3 to-panel text-brass shadow-[0_0_18px_rgba(227,169,78,0.18)]">
            <IconSpindle className="h-5 w-5" />
          </span>
          <div className="leading-none">
            <h1 className="font-display text-[22px] leading-6 text-brass2">خراط‌کد</h1>
            <p className="mt-0.5 text-[10px] font-medium text-mute">شبیه‌ساز و جی‌کدساز خراطی دومحور CNC</p>
          </div>
        </div>

        {/* تب‌ها */}
        <nav className="mx-auto flex rounded-lg border border-edge bg-panel2 p-0.5">
          <TabBtn on={mode === "design"} onClick={() => setMode("design")} icon={<IconPen className="h-3.5 w-3.5" />} label="طراحی پروفایل" />
          <TabBtn on={mode === "sim"} onClick={() => setMode("sim")} icon={<IconSim className="h-3.5 w-3.5" />} label="شبیه‌سازی تراش" />
        </nav>

        <div className="flex items-center gap-1.5">
          <WindowMenu items={menuItems} onToggle={togglePanel} onReset={resetLayout} />
          <span className="mx-1 h-5 w-px bg-edge" />
          <button className="btn !px-2 !py-1.5" onClick={undo} disabled={past.current.length === 0} title="واگرد (Ctrl+Z)">
            <IconUndo className="h-4 w-4" />
          </button>
          <button className="btn !px-2 !py-1.5" onClick={redo} disabled={future.current.length === 0} title="بازانجام (Ctrl+Y)">
            <IconRedo className="h-4 w-4" />
          </button>
          <span className="mx-1 h-5 w-px bg-edge" />
          <button
            className="btn btn-teal !px-2.5 !py-1.5 text-[11.5px]"
            onClick={downloadDxf}
            title="فقط مسیر عملیات تراش به ترتیب استراتژی — یکپارچه + لایهٔ مجزا برای هر عملیات"
          >
            <IconLayers className="h-3.5 w-3.5" />
            خروجی DXF
          </button>
          <button className="btn !px-2.5 !py-1.5 text-[11.5px]" onClick={copyGCode}>
            کپی جی‌کد
          </button>
          <button className="btn btn-brass !px-2.5 !py-1.5 text-[11.5px]" onClick={downloadGCode}>
            <IconDownload className="h-3.5 w-3.5" />
            دانلود NC
          </button>
        </div>
      </header>

      {/* ---------- بدنه ---------- */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 @4xl:flex-row @4xl:gap-2 @4xl:overflow-hidden">
        <DockPanel
          title="تنظیمات"
          icon={<IconLayers className="h-3.5 w-3.5" />}
          state={layout.controls}
          onCollapse={() => toggleCollapse("controls")}
          onClose={() => setPanel("controls", { open: false })}
          widthPx={layout.controls.size}
          className="order-2 w-full shrink-0 @4xl:order-1"
        >
          <ControlsPanel
            params={params}
            onParams={onParamsCb}
            points={points}
            innerPoints={innerPoints}
            splitInfo={splitInfo}
            onAutoSplit={autoSplit}
            activePreset={activePreset}
            onApplyPreset={applyPreset}
            onStrategy={onStrategyCb}
            isolatedOpId={isolatedOpId}
            onIsolate={setIsolatedOpId}
            onNotify={showToast}
          />
        </DockPanel>

        {panelVis("controls") === "open" && panelVis("editor") === "open" && (
          <DockSplitter
            className="@4xl:order-2"
            onResize={(dx) => resizePanel("controls", -dx)}
            onResetSize={() => resetPanelSize("controls")}
            title="تغییر عرض پنل تنظیمات (دابل‌کلیک: اندازه پیش‌فرض)"
          />
        )}
        {layout.editor.open ? (
          <DockPanel
            title={editorTitle}
            icon={mode === "design" ? <IconPen className="h-3.5 w-3.5" /> : <IconSim className="h-3.5 w-3.5" />}
            state={layout.editor}
            onCollapse={() => toggleCollapse("editor")}
            onClose={() => setPanel("editor", { open: false })}
            className="order-1 min-w-0 @4xl:order-3"
            expandedClassName="h-[54vh] flex-1 @4xl:h-auto"
          >
            {mode === "design" ? (
            <ProfileEditor
              segs={editBuf ? editBuf.sketch : sketch}
              onSegs={onSketchChange}
              edit={editBuf}
              editChanges={(() => {
                if (!editBuf) return 0;
                const next = deriveGcodeOvr(editBuf.verts, editBuf.lines, genBase.segs, gcodeOvr, params);
                let n = JSON.stringify(next) === JSON.stringify(gcodeOvr) ? 0 : 1;
                if (editBuf.sketch !== sketch) n++;
                return n;
              })()}
              onEditToggle={(open) => (open ? openEdit() : closeEdit())}
              onEditBuf={onEditBuf}
              onEditConfirm={confirmEdit}
              onEditCancel={closeEdit}
              selected={selectedIds}
              onSelected={setSelectedIds}
              params={params}
              gen={gen}
              split={params.split}
              onSplit={(s) => setParams((p) => ({ ...p, split: s }))}
              settings={settings}
              onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
              ops={params.ops}
              isolatedOpId={isolatedOpId}
              onClearIsolate={() => setIsolatedOpId(null)}
              onUndo={undo}
              onRedo={redo}
              canUndo={past.current.length > 0}
              canRedo={future.current.length > 0}
            />
          ) : (
              <SimulationView gen={gen} params={params} onActiveLine={setActiveLine} />
            )}
          </DockPanel>
        ) : (
          <div className="order-1 grid min-h-[220px] flex-1 place-items-center rounded-lg border border-dashed border-edge2 bg-panel/40 p-6 text-center @4xl:order-3 @4xl:h-auto">
            <div>
              <p className="text-[13px] font-bold text-mute">پنجره ویرایشگر بسته است</p>
              <p className="mt-1 text-[11.5px] text-dim">از منوی «پنجره» بالای صفحه دوباره بازش کنید</p>
              <button type="button" className="btn mx-auto mt-3 !px-3 !py-1.5 text-[12px]" onClick={() => setPanel("editor", { open: true })}>
                باز کردن ویرایشگر
              </button>
            </div>
          </div>
        )}

        {panelVis("editor") === "open" && panelVis("gcode") === "open" && (
          <DockSplitter
            className="@4xl:order-4"
            onResize={(dx) => resizePanel("gcode", dx)}
            onResetSize={() => resetPanelSize("gcode")}
            title="تغییر عرض پنل جی‌کد (دابل‌کلیک: اندازه پیش‌فرض)"
          />
        )}
        <DockPanel
          title="جی‌کد"
          icon={<IconCode className="h-3.5 w-3.5" />}
          state={layout.gcode}
          onCollapse={() => toggleCollapse("gcode")}
          onClose={() => setPanel("gcode", { open: false })}
          widthPx={layout.gcode.size}
          className="order-3 w-full shrink-0 @4xl:order-5"
          expandedClassName="h-[420px] @4xl:h-auto"
        >
          <GCodePanel gen={gen} activeLine={activeLine} />
        </DockPanel>
      </div>

      {/* ---------- توست ---------- */}
      {toast && (
        <div
          key={toast.msg}
          className={cn(
            "toast-anim fixed bottom-5 left-1/2 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[12.5px] font-semibold shadow-xl shadow-black/50 backdrop-blur",
            toast.kind === "ok" ? "border-ok/40 bg-panel/95 text-ok" : "border-danger/40 bg-panel/95 text-danger"
          )}
          style={{ transform: "translate(-50%,0)" }}
        >
          {toast.kind === "ok" ? <IconCheck className="h-4 w-4" /> : <IconWarn className="h-4 w-4" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-bold transition-all",
        on ? "bg-brass text-[#241a0c] shadow-[0_2px_10px_rgba(227,169,78,0.35)]" : "text-mute hover:text-ink"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
