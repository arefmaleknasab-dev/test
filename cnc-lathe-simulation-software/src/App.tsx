import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ControlsPanel from "./components/ControlsPanel";
import {
  DockPanel,
  DockSplitter,
  MAX_PANEL,
  MIN_PANEL,
  WindowMenu,
  defaultLayout,
  normalizeLayout,
} from "./components/Dock";
import type {
  LayoutState,
  PanelId,
  PanelState,
  PanelVis,
  WindowMenuItem,
} from "./components/Dock";
import GCodePanel from "./components/GCodePanel";
import ProfileEditor, { type EdSettings } from "./components/ProfileEditor";
import SimulationView from "./components/SimulationView";
import {
  IconCheck,
  IconCode,
  IconDownload,
  IconLayers,
  IconPen,
  IconRedo,
  IconSim,
  IconSpindle,
  IconUndo,
  IconWarn,
} from "./components/icons";
import { buildDxf } from "./lib/dxf";
import {
  PRESETS,
  STRATEGIES,
  generate,
  makeOps,
  normalizeParams,
  presetPoints,
} from "./lib/lathe";
import type { Params, PPoint, Preset } from "./lib/lathe";
import { buildPathBuf, changedItemCount, emitPathProgram } from "./lib/path";
import type { PathBuf } from "./lib/path";
import type { SketchSeg } from "./lib/sketch";
import { cn } from "./utils/cn";
import {
  autoSplitPoint,
  branchPoints,
  chainPolyline,
  flattenSketch,
  normalizeSketch,
  orderChain,
  sketchFromPoints,
  sketchFromWall,
  splitChainAt,
} from "./lib/sketch";

const STORE_KEY = "kharraatcode-v1";

interface Saved {
  points?: PPoint[];
  sketch?: SketchSeg[];
  params?: Partial<Params>;
  settings?: Partial<EdSettings>;
  layout?: LayoutState;
  activePreset?: string | null;
  path?: PathBuf;
  version?: number;
}

/* نسخه ۷: «ادیت جی‌کد» حذف شد — نسخه ۸: «ویرایش مسیر» با بافرِ Polyline جایش آمد */
const SAVE_VERSION = 8;

let SAVED: Saved | null = null;
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) SAVED = JSON.parse(raw) as Saved;
} catch {
  SAVED = null;
}

/* داده‌های پیش از نسخه ۲: عملیات «spring» و «offset» معنای متفاوتی داشتند */
const IS_LEGACY = !SAVED || !SAVED.version || SAVED.version < 3;

/* ---------- حالت «ویرایش مسیر» ----------
   بافرِ مسیر (Polyline یکپارچۀ جی‌کد) + اینکه حالت باز است یا نه. تا وقتی بافر
   وجود دارد، برنامه از روی همان بافر ساخته می‌شود؛ «تأیید» فقط حالت را می‌بندد
   و مسیرِ ویرایش‌شده فعال می‌ماند. */
interface PathEdit {
  buf: PathBuf;
  open: boolean;
}

/* گام تاریخچه — اسکچ + وضعیت کاملِ ویرایش مسیر (واگرد بعد از تأیید، خودِ حالت
   و آخرین تغییر را برمی‌گرداند) */
interface HistEntry {
  sketch: SketchSeg[];
  path: PathEdit | null;
}

/* بازخوانی ایمنِ بافرِ مسیر از حافظهٔ محلی (سنجش نوع پس از پارس) */
function normPathBuf(raw: unknown): PathBuf | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { verts?: unknown; items?: unknown; nextI?: unknown };
  if (!Array.isArray(o.verts) || !Array.isArray(o.items) || !o.items.length)
    return null;
  const num = (v: unknown): v is number => typeof v === "number" && isFinite(v);
  const verts: PathBuf["verts"] = [];
  for (const v of o.verts) {
    if (!v || typeof v !== "object") continue;
    const q = v as { z?: unknown; x?: unknown };
    if (!num(q.z) || !num(q.x)) continue;
    verts.push({ id: verts.length, z: q.z, x: q.x });
  }
  const iv = (id: unknown): number | null =>
    num(id) && id >= 0 && id < verts.length ? Math.floor(id) : null;
  const items: PathBuf["items"] = [];
  for (const it of o.items) {
    if (!it || typeof it !== "object") continue;
    const q = it as Record<string, unknown>;
    const va = iv(q.va);
    const vb = iv(q.vb);
    if (va == null || vb == null || va === vb) continue;
    const pts = Array.isArray(q.pts)
      ? (q.pts.filter(
          (r) =>
            r &&
            typeof r === "object" &&
            num((r as { z: unknown }).z) &&
            num((r as { x: unknown }).x),
        ) as { z: number; x: number }[])
      : null;
    items.push({
      id: items.length + 1,
      va,
      vb,
      ha: iv(q.ha),
      hb: iv(q.hb),
      curve: q.curve === true && iv(q.ha) != null && iv(q.hb) != null,
      pts: pts && pts.length >= 2 ? pts : null,
      dirty: q.dirty !== false,
      motion: q.motion === 0 ? 0 : 1,
      feed: num(q.feed) ? q.feed : 0,
      kind: (typeof q.kind === "string"
        ? q.kind
        : "copy") as PathBuf["items"][number]["kind"],
      op: (typeof q.op === "string"
        ? q.op
        : "sys") as PathBuf["items"][number]["op"],
      opId: num(q.opId) ? q.opId : -1,
      holder: q.holder === 2 ? 2 : 1,
      note: Array.isArray(q.note)
        ? (q.note.filter((n) => typeof n === "string") as string[])
        : undefined,
      fan: num(q.fan) ? q.fan : undefined,
      fanU: num(q.fanU) ? q.fanU : undefined,
    });
  }
  if (!items.length) return null;
  return { verts, items, nextI: items.length + 1, rev: 0 };
}

export default function App() {
  const [sketch, setSketch] = useState<SketchSeg[]>(() => {
    const fromSaved = normalizeSketch(SAVED?.sketch);
    if (fromSaved) return fromSaved;
    if (SAVED?.points && SAVED.points.length >= 2)
      return sketchFromPoints(SAVED.points);
    return sketchFromPoints(presetPoints(PRESETS[0]));
  });
  const [params, setParams] = useState<Params>(() =>
    normalizeParams(SAVED?.params, IS_LEGACY),
  );
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
  const [layout, setLayout] = useState<LayoutState>(() =>
    normalizeLayout(SAVED?.layout),
  );
  const [mode, setMode] = useState<"design" | "sim">("design");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>(
    SAVED?.activePreset ?? PRESETS[0].id,
  );
  const [activeLine, setActiveLine] = useState(-1);
  const [isolatedOpId, setIsolatedOpId] = useState<number | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    kind: "ok" | "warn";
  } | null>(null);
  const [, setHistVer] = useState(0);

  /* ویرایش مسیر — بافرِ Polyline و باز/بسته بودن حالت */
  const [path, setPath] = useState<PathEdit | null>(() => {
    const saved = normPathBuf(SAVED?.path);
    return saved ? { buf: saved, open: false } : null;
  });
  const pathRef = useRef<PathEdit | null>(path);
  pathRef.current = path;
  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  const toastTimer = useRef<number | null>(null);
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;

  /* تاریخچهٔ یکپارچه: هر گام = {اسکچ، ویرایش مسیر}. واگرد بعد از «تأیید» دقیقاً
     به حالت ویرایش مسیر و آخرین تغییر بازمی‌گردد (خواستهٔ کاربر) */
  const snap = (): HistEntry => ({
    sketch: sketchRef.current,
    path: pathRef.current,
  });
  const pushPast = (e: HistEntry) => {
    past.current.push(e);
    future.current = [];
    if (past.current.length > 120) past.current.shift();
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
          splitInfo: {
            outerDir: sp.outerDir,
            innerDir: sp.innerDir,
            at: sp.splitAt,
          },
        };
      }
    }
    const none: {
      outerDir: 1 | -1;
      innerDir: 1 | -1;
      at: { z: number; r: number };
    } | null = null;
    return {
      points: flattenSketch(sketch, blankR, params.blankL),
      innerPoints: [] as PPoint[],
      splitInfo: none,
    };
  }, [sketch, params.split, params.blankD, params.blankL]);

  const genBase = useMemo(
    () => generate(points, params, innerPoints),
    [points, params, innerPoints],
  );

  /* برنامه = مسیرِ ویرایش‌شده (تا وقتی اورراید فعال است) یا همان برنامهٔ پایه */
  const gen = useMemo(
    () => (path ? emitPathProgram(path.buf, params, genBase) : genBase),
    [path, params, genBase],
  );

  /* ذخیره محلی */
  useEffect(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          sketch,
          params,
          settings,
          activePreset,
          layout,
          path: path && !path.open ? path.buf : null,
          version: SAVE_VERSION,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [sketch, params, settings, activePreset, layout, path]);

  /* هنگام تغییر برنامه، هایلایت جی‌کد پاک شود */
  useEffect(() => {
    setActiveLine(-1);
  }, [gen]);

  /* اگر عملیاتِ ایزوله‌شده حذف شد، از حالت ایزوله خارج شو */
  useEffect(() => {
    if (isolatedOpId != null && !params.ops.some((o) => o.id === isolatedOpId))
      setIsolatedOpId(null);
  }, [params.ops, isolatedOpId]);

  /* واگرد / بازانجام — روی اسکچ و ویرایش مسیر با هم */
  const commitRef = useRef<HistEntry | null>(null);
  const restore = (e: HistEntry) => {
    setSketch(e.sketch);
    setPath(e.path);
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

  /* ---------- حالت «ویرایش مسیر» ---------- */
  const genBaseRef = useRef(genBase);
  genBaseRef.current = genBase;
  const openDepth = useRef<number | null>(null);
  /* وضعیت دقیقِ لحظۀ ورود (برای «انصراف» وقتی هیچ تغییری ثبت نشده) */
  const openEntry = useRef<HistEntry | null>(null);
  const openPath = () => {
    if (pathRef.current?.open) return;
    const cur = pathRef.current;
    openDepth.current = past.current.length;
    openEntry.current = snap();
    setPath({
      buf: cur ? cur.buf : buildPathBuf(genBaseRef.current.segs),
      open: true,
    });
    setHistVer((v) => v + 1);
    showToast(
      cur
        ? "ویرایش مسیر — همان برنامهٔ ویرایش‌شدهٔ قبلی باز شد"
        : "ویرایش مسیر — کل برنامه به یک Polyline یکپارچه تبدیل شد",
    );
  };
  /* «تأیید»: حالت بسته می‌شود، مسیرِ ویرایش‌شده فعال می‌ماند (بی‌گامِ تاریخچهٔ اضافه،
     تا واگرد دقیقاً به آخرین تغییرِ حالت ویرایش برگردد) */
  const closePath = () => {
    const cur = pathRef.current;
    if (!cur) return;
    /* مقایسه با برنامۀ «الان» (genBase تازه) — وگرنه اگر بین باز و بستن شدن،
       پارامتر عوض شده باشد، بافرِ دست‌نخورده اشتباهاً تغییریافته شمرده می‌شود */
    const changed = changedItemCount(cur.buf, genBase.segs) > 0;
    if (changed) {
      /* «تأیید» خودش یک گامِ تاریخچه است: واگرد بعد از تأیید، دقیقاً به حالت
         ویرایش مسیر و آخرین تغییر برمی‌گردد (خواستهٔ کاربر) */
      pushPast({ sketch: sketchRef.current, path: { ...cur, open: true } });
    }
    setPath(changed ? { ...cur, open: false } : null);
    openDepth.current = null;
    setHistVer((v) => v + 1);
    showToast(
      changed
        ? "مسیر ویرایش‌شده ثبت شد ✓ جی‌کد و شبیه‌سازی از همین مسیر ساخته می‌شوند"
        : "تغییری نبود — اورراید مسیر پاک شد",
    );
  };
  /* «انصراف»: به وضعیتِ لحظۀ ورود به حالت برمی‌گردد (روی همان تاریخچهٔ اصلی) */
  const cancelPath = () => {
    if (!pathRef.current) return;
    /* واگردِ همهٔ گام‌های این نشست روی همان تاریخچۀ اصلی؛ چون setState ناهمگام
       است، وضعیتِ مقصد را مستقیم از پشته می‌خوانیم (نه از ref) */
    const depth = openDepth.current ?? past.current.length;
    let target: HistEntry | null = null;
    while (past.current.length > depth) target = past.current.pop()!;
    future.current = [];
    commitRef.current = null;
    openDepth.current = null;
    const entry = target ??
      openEntry.current ?? { sketch: sketchRef.current, path: null };
    /* حالت حتماً بسته می‌شود (گام‌های درونِ حالت، open:true دارند) */
    restore({
      sketch: entry.sketch,
      path: entry.path ? { ...entry.path, open: false } : null,
    });
    showToast("تغییرهای این نشستِ ویرایش مسیر واگرد شد", "warn");
  };
  const clearPathOverride = () => {
    if (!pathRef.current) return;
    pushPast(snap());
    setPath(null);
    setHistVer((v) => v + 1);
    showToast("اورراید مسیر حذف شد — فایل از پروفایل و عملیات دوباره ساخته شد");
  };
  /* تغییر بافر (جابه‌جایی/حذف/افزودن نقطه) — یک‌گام تاریخچه برای هر ژست */
  const onPathBuf = (next: PathBuf, commit: boolean) => {
    const cur = pathRef.current;
    if (!cur) return;
    if (!commit) {
      if (!commitRef.current) commitRef.current = snap();
      setPath({ ...cur, buf: next });
      return;
    }
    const pend = commitRef.current ?? snap();
    commitRef.current = null;
    pushPast(pend);
    setPath({ ...cur, buf: next });
    setHistVer((v) => v + 1);
  };

  const showToast = useCallback((msg: string, kind: "ok" | "warn" = "ok") => {
    setToast({ msg, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  /* کال‌بک‌های پایدار: هویت ثابت تا فرزندهای memo هنگام تیک شبیه‌سازی بازرندر نشوند */
  const onParamsCb = useCallback(
    (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch })),
    [],
  );
  const onStrategyCb = useCallback(
    (name: string) => showToast(`استراتژی «${name}» فعال شد`),
    [showToast],
  );

  /* ---------- چیدمان داک (پنجره‌ها) ---------- */
  const setPanel = useCallback((id: PanelId, patch: Partial<PanelState>) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], ...patch } }));
  }, []);
  const togglePanel = useCallback((id: PanelId) => {
    setLayout((l) => ({ ...l, [id]: { ...l[id], open: !l[id].open } }));
  }, []);
  const toggleCollapse = useCallback((id: PanelId) => {
    setLayout((l) => ({
      ...l,
      [id]: { ...l[id], collapsed: !l[id].collapsed },
    }));
  }, []);
  const resizePanel = useCallback((id: PanelId, dx: number) => {
    setLayout((l) => {
      const max = Math.max(360, window.innerWidth - 560);
      const size = Math.min(
        Math.min(MAX_PANEL, max),
        Math.max(MIN_PANEL, Math.round(l[id].size + dx)),
      );
      if (size === l[id].size) return l;
      return { ...l, [id]: { ...l[id], size } };
    });
  }, []);
  const resetPanelSize = useCallback((id: PanelId) => {
    setLayout((l) => ({
      ...l,
      [id]: { ...l[id], size: defaultLayout()[id].size },
    }));
  }, []);
  const resetLayout = useCallback(() => {
    setLayout(defaultLayout());
    showToast("چیدمان پنجره‌ها بازنشانی شد");
  }, [showToast]);
  const panelVis = (id: PanelId): PanelVis =>
    !layout[id].open ? "closed" : layout[id].collapsed ? "collapsed" : "open";

  /* تغییر اسکچ — با commit=false تغییر زنده (کشیدن) و با true ثبت در تاریخچه */
  const onSketchChange = useCallback((next: SketchSeg[], commit: boolean) => {
    if (commit) {
      pushPast(commitRef.current ?? snap());
      commitRef.current = null;
      setActivePreset(null);
      /* ویرایشِ پروفایل، اوررایدِ مسیر را بی‌معنا می‌کند (با واگرد برمی‌گردد) */
      if (pathRef.current) {
        setPath(null);
        openDepth.current = null;
        showToast("پروفایل تغییر کرد — اورراید مسیر پاک شد", "warn");
      }
    } else if (!commitRef.current) {
      commitRef.current = snap(); // وضعیت پیش از شروع کشیدن
    }
    setSketch(next);
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = useCallback(
    (p: Preset) => {
      if (p.wall) {
        /* کاسه: دیواره به ترتیب مسیر (خارج ← لبه ← داخل) ساخته می‌شود */
        onSketchChange(
          sketchFromWall(p.wall.map(([z, r, smooth]) => ({ z, r, smooth }))),
          true,
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
          : `پیش‌تنظیم «${p.name}» اعمال شد`,
      );
    },
    [onSketchChange, showToast],
  );

  /* قرار دادن خودکار نقطه Split روی لبه (بیشترین X زنجیره) */
  const autoSplit = useCallback(() => {
    const poly = chainPolyline(orderChain(sketch));
    const auto = autoSplitPoint(poly);
    if (auto) {
      setParams((prev) => ({
        ...prev,
        split: { ...prev.split, enabled: true, z: auto.z, r: auto.r },
      }));
      showToast(
        `نقطه Split روی لبه قرار گرفت (X ${auto.z} • ⌀ ${(auto.r * 2).toFixed(1)})`,
      );
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
    const { text, vertexCount, opCount } = buildDxf(
      gen.segs,
      params.ops,
      params.blankL,
      params.blankD / 2,
    );
    const blob = new Blob([text], { type: "application/dxf;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kharraatcode-cutpath.dxf";
    a.click();
    URL.revokeObjectURL(url);
    showToast(
      `مسیر برشی ${opCount.toLocaleString("fa-IR")} عملیات با ${vertexCount.toLocaleString("fa-IR")} نقطه به DXF تبدیل شد`,
    );
  };

  const editorTitle = path?.open
    ? "ویرایش مسیر جی‌کد"
    : mode === "design"
      ? "طراحی پروفایل"
      : "شبیه‌سازی تراش";
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
            <h1 className="font-display text-[22px] leading-6 text-brass2">
              خراط‌کد
            </h1>
            <p className="mt-0.5 text-[10px] font-medium text-mute">
              شبیه‌ساز و جی‌کدساز خراطی دومحور CNC
            </p>
          </div>
        </div>

        {/* تب‌ها */}
        <nav className="mx-auto flex rounded-lg border border-edge bg-panel2 p-0.5">
          <TabBtn
            on={mode === "design"}
            onClick={() => setMode("design")}
            icon={<IconPen className="h-3.5 w-3.5" />}
            label="طراحی پروفایل"
          />
          <TabBtn
            on={mode === "sim"}
            onClick={() => setMode("sim")}
            icon={<IconSim className="h-3.5 w-3.5" />}
            label="شبیه‌سازی تراش"
          />
        </nav>

        <div className="flex items-center gap-1.5">
          <WindowMenu
            items={menuItems}
            onToggle={togglePanel}
            onReset={resetLayout}
          />
          <span className="mx-1 h-5 w-px bg-edge" />
          <button
            className="btn !px-2 !py-1.5"
            onClick={undo}
            disabled={past.current.length === 0}
            title="واگرد (Ctrl+Z)"
          >
            <IconUndo className="h-4 w-4" />
          </button>
          <button
            className="btn !px-2 !py-1.5"
            onClick={redo}
            disabled={future.current.length === 0}
            title="بازانجام (Ctrl+Y)"
          >
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
          <button
            className="btn !px-2.5 !py-1.5 text-[11.5px]"
            onClick={copyGCode}
          >
            کپی جی‌کد
          </button>
          <button
            className="btn btn-brass !px-2.5 !py-1.5 text-[11.5px]"
            onClick={downloadGCode}
          >
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
            icon={
              mode === "design" ? (
                <IconPen className="h-3.5 w-3.5" />
              ) : (
                <IconSim className="h-3.5 w-3.5" />
              )
            }
            state={layout.editor}
            onCollapse={() => toggleCollapse("editor")}
            onClose={() => setPanel("editor", { open: false })}
            className="order-1 min-w-0 @4xl:order-3"
            expandedClassName="h-[54vh] flex-1 @4xl:h-auto"
          >
            {mode === "design" ? (
              <ProfileEditor
                segs={sketch}
                onSegs={onSketchChange}
                path={path?.open ? path.buf : null}
                pathOverride={!!path}
                pathChanged={
                  !!path && changedItemCount(path.buf, genBase.segs) > 0
                }
                onPathToggle={(open) => (open ? openPath() : closePath())}
                onPathBuf={onPathBuf}
                onPathConfirm={closePath}
                onPathCancel={cancelPath}
                onPathClear={clearPathOverride}
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
              <SimulationView
                gen={gen}
                params={params}
                onActiveLine={setActiveLine}
              />
            )}
          </DockPanel>
        ) : (
          <div className="order-1 grid min-h-[220px] flex-1 place-items-center rounded-lg border border-dashed border-edge2 bg-panel/40 p-6 text-center @4xl:order-3 @4xl:h-auto">
            <div>
              <p className="text-[13px] font-bold text-mute">
                پنجره ویرایشگر بسته است
              </p>
              <p className="mt-1 text-[11.5px] text-dim">
                از منوی «پنجره» بالای صفحه دوباره بازش کنید
              </p>
              <button
                type="button"
                className="btn mx-auto mt-3 !px-3 !py-1.5 text-[12px]"
                onClick={() => setPanel("editor", { open: true })}
              >
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
            toast.kind === "ok"
              ? "border-ok/40 bg-panel/95 text-ok"
              : "border-danger/40 bg-panel/95 text-danger",
          )}
          style={{ transform: "translate(-50%,0)" }}
        >
          {toast.kind === "ok" ? (
            <IconCheck className="h-4 w-4" />
          ) : (
            <IconWarn className="h-4 w-4" />
          )}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function TabBtn({
  on,
  onClick,
  icon,
  label,
}: {
  on: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-bold transition-all",
        on
          ? "bg-brass text-[#241a0c] shadow-[0_2px_10px_rgba(227,169,78,0.35)]"
          : "text-mute hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
