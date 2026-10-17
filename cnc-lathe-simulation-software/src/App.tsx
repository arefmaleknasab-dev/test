import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ControlsPanel from "./components/ControlsPanel";
import AIImportDialog from "./components/AIImportDialog";
import { DockPanel, DockSplitter, MAX_PANEL, MIN_PANEL, WindowMenu, defaultLayout, normalizeLayout } from "./components/Dock";
import type { LayoutState, PanelId, PanelState, PanelVis, WindowMenuItem } from "./components/Dock";
import GCodePanel from "./components/GCodePanel";
import ProfileEditor, { type EdSettings } from "./components/ProfileEditor";
import SimulationView from "./components/SimulationView";
import PreferencesDialog, { DEFAULT_PREFERENCES, type AppPreferences } from "./components/PreferencesDialog";
import { IconArrowLeft, IconArrowRight, IconCheck, IconCode, IconDownload, IconLayers, IconPen, IconSim, IconSettings, IconSpindle, IconWarn } from "./components/icons";
import { buildDxf } from "./lib/dxf";
import { MIN_HOLDER2_OFFSET, PRESETS, STRATEGIES, applyGcodeOvr, deriveGcodeOvr, generate, makeOps, normalizeParams, presetPoints, seedGcodeEdit, translateHolder2Edit } from "./lib/lathe";
import type { EditBuf, GcodeOvrMap, GenResult, Holder2State, OpType, Params, PPoint, Preset } from "./lib/lathe";
import type { SketchSeg } from "./lib/sketch";
import { autoSplitPoint, branchPathPoints, branchPoints, chainPolyline, flattenSketch, normalizeSketch, orderChain, segMid, sketchFromPoints, sketchFromWall, splitChainAt } from "./lib/sketch";
import { cn } from "./utils/cn";

const STORE_KEY = "kharraatcode-v1";

interface Saved {
  points?: PPoint[];
  sketch?: SketchSeg[];
  params?: Partial<Params>;
  settings?: Partial<EdSettings>;
  preferences?: Partial<AppPreferences>;
  layout?: LayoutState;
  activePreset?: string | null;
  gcodeOvr?: Record<string, { s?: { z: number; x: number }; e?: { z: number; x: number }; via?: { z: number; x: number }[]; moves?: { motion: 0 | 1; feed: number }[]; bridgeMoves?: Record<number, { motion: 0 | 1; feed: number }>; del?: boolean }>;
  version?: number;
}

const SAVE_VERSION = 7;

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
interface ProjectTab {
  id: string;
  name: string;
  sketch: SketchSeg[];
  params: Params;
  gcodeOvr: GcodeOvrMap;
  activePreset: string | null;
  savedSnapshot: string | null;
  past: HistEntry[];
  future: HistEntry[];
}

const projectSnapshot = (sketch: SketchSeg[], params: Params, gcodeOvr: GcodeOvrMap) => JSON.stringify({ sketch, params, gcodeOvr });

interface HistEntry {
  sketch: SketchSeg[];
  gcodeOvr: GcodeOvrMap;
  editBuf: EditBuf | null;
  /** باز یا بسته‌بودن پنجره مستقل از وجود پیش‌نویس ذخیره می‌شود. */
  editOpen: boolean;
  /** همه پارامترهای مولد، به‌ویژه لیست عملیات استراتژی، باید همراه بافر
      ویرایش بازیابی شوند؛ وگرنه بافر قدیمی روی عملیات جدید تأیید می‌شود. */
  params: Params;
}

/* بازخوانی ایمنِ اوررایدها از حافظهٔ محلی (سنجش نوع پس از پارس) */
function normGcodeOvr(raw: Saved["gcodeOvr"]): GcodeOvrMap {
  const out: GcodeOvrMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const o: { s?: { z: number; x: number }; e?: { z: number; x: number }; via?: { z: number; x: number }[]; moves?: { motion: 0 | 1; feed: number }[]; bridgeMoves?: Record<number, { motion: 0 | 1; feed: number }>; del?: boolean } = {};
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
    if (Array.isArray(v.moves)) {
      const moves = v.moves.filter((m) => m && (m.motion === 0 || m.motion === 1) && typeof m.feed === "number" && isFinite(m.feed) && m.feed >= 0);
      if (moves.length) o.moves = moves.map((m) => ({ motion: m.motion, feed: m.feed }));
    }
    if (v.bridgeMoves && typeof v.bridgeMoves === "object") {
      const bridgeMoves: Record<number, { motion: 0 | 1; feed: number }> = {};
      for (const [leg, move] of Object.entries(v.bridgeMoves)) {
        const n = Number(leg);
        if (Number.isInteger(n) && move && (move.motion === 0 || move.motion === 1) && typeof move.feed === "number" && isFinite(move.feed) && move.feed >= 0) {
          bridgeMoves[n] = { motion: move.motion, feed: move.feed };
        }
      }
      if (Object.keys(bridgeMoves).length) o.bridgeMoves = bridgeMoves;
    }
    if (v.del === true) o.del = true;
    if (o.s || o.e || o.via?.length || o.moves?.length || o.bridgeMoves || o.del) out[k] = o;
  }
  return out;
}

export default function App() {
  const [showAiImport, setShowAiImport] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [preferences, setPreferences] = useState<AppPreferences>(() => {
    const saved = SAVED?.preferences;
    /* تنظیمات خروجی پیش‌تر در Params بودند. فقط پس از اولین ذخیره نسخه جدید،
       مقادیر Preferences معتبرند؛ وگرنه دقیقاً با پیش‌فرض‌های تصویر آغاز شوند. */
    const hasNewGcodePreferences = saved?.gcodeFormat === "modal" || saved?.gcodeFormat === "std";
    return {
      ...DEFAULT_PREFERENCES,
      ...(saved ?? {}),
      ...(!hasNewGcodePreferences ? {
        gcodeFormat: "modal" as const,
        continuousPaths: true,
        optimizeFeeds: true,
        sequenceNumbers: true,
        spreadRapid: false,
      } : {}),
      shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, ...(saved?.shortcuts ?? {}) },
      operationFeeds: { ...DEFAULT_PREFERENCES.operationFeeds, ...(saved?.operationFeeds ?? {}) },
    };
  });
  const [sketch, setSketch] = useState<SketchSeg[]>(() => {
    const fromSaved = normalizeSketch(SAVED?.sketch);
    if (fromSaved) return fromSaved;
    if (SAVED?.points && SAVED.points.length >= 2) return sketchFromPoints(SAVED.points);
    return sketchFromPoints(presetPoints(PRESETS[0]));
  });
  /* منبع مولد مسیر از اسکچ نمایشی جداست تا وقتی همهٔ لایه‌ها خاموش‌اند، درگ
     پروفایل بدون اجرای generate در هر فریم انجام شود؛ در pointerup همگام می‌شود. */
  const [generationSketch, setGenerationSketch] = useState<SketchSeg[]>(sketch);
  const [params, setParams] = useState<Params>(() => normalizeParams(SAVED?.params, IS_LEGACY));
  const [settings, setSettings] = useState<EdSettings>(() => {
    const s = SAVED?.settings;
    const legacyShowBore = (s as (Partial<EdSettings> & { showBore?: boolean }) | undefined)?.showBore;
    /* ۵۰/۵ پیش‌فرض نسخهٔ قبل بود؛ فقط همین جفت مقدار در ارتقای نسخه به ۱۰۰/۱۰ مهاجرت می‌کند. */
    const legacyGridDefaults =
      (SAVED?.version ?? 0) < 7 && s?.editGridSize === 50 && s?.editGridDivisions === 5;
    return {
      snap: s?.snap ?? 1,
      smartSnap: s?.smartSnap ?? true,
      snapTolerancePx: typeof s?.snapTolerancePx === "number" ? Math.min(30, Math.max(3, s.snapTolerancePx)) : 11,
      showRough: s?.showRough ?? false,
      showFinish: s?.showFinish ?? false,
      showOffset: s?.showOffset ?? false,
      showInnerRough: s?.showInnerRough ?? legacyShowBore ?? false,
      showInnerOffset: s?.showInnerOffset ?? legacyShowBore ?? false,
      showInnerFinish: s?.showInnerFinish ?? legacyShowBore ?? false,
      showRound: s?.showRound ?? false,
      showFace: s?.showFace ?? false,
      showBottom: s?.showBottom ?? false,
      showRapids: s?.showRapids ?? false,
      showGhost: s?.showGhost ?? false,
      layerOpacity: typeof s?.layerOpacity === "number" && isFinite(s.layerOpacity)
        ? Math.min(1, Math.max(0.1, s.layerOpacity))
        : 1,
      editGridVisible: s?.editGridVisible ?? true,
      editGridSize: !legacyGridDefaults && typeof s?.editGridSize === "number" && isFinite(s.editGridSize)
        ? Math.min(500, Math.max(1, s.editGridSize))
        : 100,
      editGridDivisions: !legacyGridDefaults && typeof s?.editGridDivisions === "number" && isFinite(s.editGridDivisions)
        ? Math.min(20, Math.max(1, Math.round(s.editGridDivisions)))
        : 10,
    };
  });
  const allProfileLayersHidden =
    !settings.showRough &&
    !settings.showFinish &&
    !settings.showOffset &&
    !settings.showInnerRough &&
    !settings.showInnerOffset &&
    !settings.showInnerFinish &&
    !settings.showRound &&
    !settings.showFace &&
    !settings.showBottom &&
    !settings.showRapids &&
    !settings.showGhost;
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
  const initialProjectId = useRef(`project-${Date.now()}`);
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId.current);
  const [projectTabs, setProjectTabs] = useState<ProjectTab[]>([{ id: initialProjectId.current, name: PRESETS.find(p=>p.id===activePreset)?.name ?? "پروژه بدون نام", sketch, params, gcodeOvr: normGcodeOvr(SAVED?.gcodeOvr), activePreset, savedSnapshot: null, past: [], future: [] }]);
  const [pendingCloseProject, setPendingCloseProject] = useState<string|null>(null);
  const [pendingEditExit, setPendingEditExit] = useState(false);
  const [saveThenCloseProject, setSaveThenCloseProject] = useState<string|null>(null);
  const [editBuf, setEditBuf] = useState<EditBuf | null>(null);
  /* باز/بسته‌بودن UI از وجود پیش‌نویس جداست تا خروج تصادفی، تغییرات تأییدنشده را پاک نکند. */
  const [editOpen, setEditOpen] = useState(false);
  const editOpenRef = useRef(editOpen);
  editOpenRef.current = editOpen;
  const editBufRef = useRef<EditBuf | null>(editBuf);
  editBufRef.current = editBuf;
  /* تغییر preset هندسه و پارامترهای مولد را هم‌زمان عوض می‌کند؛ اگر پیش‌نویس
     مسیر وجود داشته باشد باید بعد از تولید برنامهٔ جدید از نو seed شود. */
  const presetReseedRef = useRef(false);

  /* مبنای بازسازی زندهٔ پیش‌نویس هنگام تغییر پارامترهای مولد مسیر. */
  const pendingParamRebaseRef = useRef<{
    genBase: GenResult;
    params: Params;
    gcodeOvr: GcodeOvrMap;
  } | null>(null);

  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  const toastTimer = useRef<number | null>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const projectHandlesRef = useRef(new Map<string, { name?: string; createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>());
  const stateRef = useRef({ sketch, gcodeOvr, editBuf, editOpen, params });
  stateRef.current = { sketch, gcodeOvr, editBuf, editOpen, params };
  useEffect(() => {
    setProjectTabs(tabs => tabs.map(tab => tab.id===activeProjectId ? { ...tab, sketch, params, gcodeOvr, activePreset } : tab));
  }, [activeProjectId, sketch, params, gcodeOvr, activePreset]);
  const switchProject = (id: string) => {
    if(id===activeProjectId)return;const tab=projectTabs.find(t=>t.id===id);if(!tab)return;
    /* تاریخچه تب مبدأ پیش از سوییچ ذخیره و تاریخچه مستقل مقصد بازیابی می‌شود. */
    setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t));
    setActiveProjectId(id);setSketch(tab.sketch);setGenerationSketch(tab.sketch);setParams(tab.params);setGcodeOvr(tab.gcodeOvr);setActivePreset(tab.activePreset);
    const limit=Math.min(200,Math.max(1,Math.round(preferences.historyLimit)));
    setSelectedIds([]);setEditBuf(null);setEditOpen(false);past.current=tab.past.slice(-limit);future.current=tab.future.slice(-limit);setHistVer(v=>v+1);
  };
  const finishCloseProject = (id:string) => {
    const remaining=projectTabs.filter(t=>t.id!==id);projectHandlesRef.current.delete(id);
    if(remaining.length){setProjectTabs(remaining);if(id===activeProjectId){const next=remaining[Math.max(0,projectTabs.findIndex(t=>t.id===id)-1)]??remaining[0];setActiveProjectId(next.id);setSketch(next.sketch);setGenerationSketch(next.sketch);setParams(next.params);setGcodeOvr(next.gcodeOvr);setActivePreset(next.activePreset);past.current=[...next.past];future.current=[...next.future];setHistVer(v=>v+1);}}
    else { const p=PRESETS[0], nextSketch=sketchFromPoints(presetPoints(p)), id2=`project-${Date.now()}`;const nextParams=normalizeParams({...params,blankD:p.blankD,blankL:p.blankL},false);setProjectTabs([{id:id2,name:"پروژه بدون نام",sketch:nextSketch,params:nextParams,gcodeOvr:{},activePreset:p.id,savedSnapshot:null,past:[],future:[]}]);setActiveProjectId(id2);setSketch(nextSketch);setGenerationSketch(nextSketch);setParams(nextParams);setGcodeOvr({});setActivePreset(p.id);past.current=[];future.current=[];setHistVer(v=>v+1);}
    setPendingCloseProject(null);setSelectedIds([]);setEditBuf(null);setEditOpen(false);
  };
  const requestCloseProject=(id:string)=>{const tab=projectTabs.find(t=>t.id===id);if(!tab)return;const dirty=tab.savedSnapshot!==projectSnapshot(tab.sketch,tab.params,tab.gcodeOvr);if(dirty)setPendingCloseProject(id);else finishCloseProject(id);};

  /* تاریخچهٔ یکپارچه: هر گام = {اسکچ، اورراید جی‌کد، بافر ادیت} — واگرد بعد از تأیید
     دقیقاً به همان حالت ادیت و آخرین تغییر بازمی‌گردد (خواستهٔ کاربر) */
  const snap = (): HistEntry => ({ ...stateRef.current });
  const pushPast = (e: HistEntry) => {
    const limit = Math.min(200, Math.max(1, Math.round(preferences.historyLimit)));
    past.current.push(e);
    if (past.current.length > limit) past.current.splice(0, past.current.length - limit);
    /* هر تغییر تازه شاخهٔ تاریخچه را عوض می‌کند؛ Redo قبلی دیگر معتبر نیست. */
    future.current = [];
  };

  /* پروفایل نقطه‌ای برای موتور تراش — حالت عادی تخت، حالت کاسه دوشاخه (Split) */
  const { points, innerPoints, outerFinishPoints, splitInfo } = useMemo(() => {
    const blankR = params.blankD / 2;
    if (params.split.enabled) {
      const poly = chainPolyline(orderChain(generationSketch));
      if (poly.length >= 3) {
        const sp = splitChainAt(poly, { z: params.split.z, r: params.split.r });
        const outerBranch = params.split.swapped ? sp.inner : sp.outer;
        const innerBranch = params.split.swapped ? sp.outer : sp.inner;
        return {
          points: branchPoints(outerBranch, blankR, params.blankL, "max"),
          /* پرداخت بیرونی نیز باید ترتیب توپولوژیک و گوشه‌های قائم شاخه را حفظ
             کند؛ پوشش مرتب‌شدهٔ points فقط برای محاسبات خشن استفاده می‌شود. */
          outerFinishPoints: branchPathPoints(outerBranch, blankR, params.blankL),
          /* ترتیب واقعی شاخه برای Offset/Finish حفظ می‌شود؛ موتور مسیر یک پوشش
             یکنواخت جداگانه برای پاس‌های خشن می‌سازد. */
          innerPoints: branchPathPoints(innerBranch, blankR, params.blankL),
          splitInfo: {
            outerDir: params.split.swapped ? sp.innerDir : sp.outerDir,
            innerDir: params.split.swapped ? sp.outerDir : sp.innerDir,
            at: sp.splitAt,
          },
        };
      }
    }
    const none: { outerDir: 1 | -1; innerDir: 1 | -1; at: { z: number; r: number } } | null = null;
    const orderedProfile = chainPolyline(orderChain(generationSketch));
    return {
      points: flattenSketch(generationSketch, blankR, params.blankL),
      innerPoints: [] as PPoint[],
      outerFinishPoints: branchPathPoints(orderedProfile, blankR, params.blankL),
      splitInfo: none,
    };
  }, [generationSketch, params.split, params.blankD, params.blankL]);

  useEffect(() => {
    if (!allProfileLayersHidden && generationSketch !== sketch) setGenerationSketch(sketch);
  }, [allProfileLayersHidden, generationSketch, sketch]);

  const generationParams = useMemo<Params>(() => ({ ...params, rpm: preferences.spindleSpeed, format: preferences.gcodeFormat, lineNumbers: preferences.sequenceNumbers, ramp: preferences.continuousPaths, safeBottomInnerLink: preferences.safeBottomInnerLink, simpleFeed: preferences.optimizeFeeds, spreadG0: preferences.spreadRapid, feedByKind: { ...preferences.operationFeeds, roughz: preferences.operationFeeds.rough, copy: preferences.operationFeeds.rough } }), [params, preferences.operationFeeds, preferences.spindleSpeed, preferences.gcodeFormat, preferences.sequenceNumbers, preferences.continuousPaths, preferences.safeBottomInnerLink, preferences.optimizeFeeds, preferences.spreadRapid]);
  const genBase = useMemo(() => generate(points, generationParams, innerPoints, outerFinishPoints), [points, generationParams, innerPoints, outerFinishPoints]);

  const gen = useMemo(() => applyGcodeOvr(genBase, gcodeOvr, generationParams), [genBase, gcodeOvr, generationParams]);

  /* هنگام Drag هلدر دوم، اختلاف آفست به‌تنهایی برای فعال‌کردن «تأیید» کافی است؛
     در این مسیر داغ عمداً deriveGcodeOvr (پیمایش کل برنامه) اجرا نمی‌شود تا
     حرکت حتی روی برنامه‌های چند هزار خطی روان بماند. */
  const editChanges = useMemo(() => {
    if (!editOpen || !editBuf) return 0;
    const draftHolder2 = editBuf.holder2 ?? params.holder2;
    const holder2Changed =
      draftHolder2.xOff !== params.holder2.xOff || draftHolder2.yOff !== params.holder2.yOff;
    let n = holder2Changed ? 1 : 0;
    if (!holder2Changed) {
      const next = deriveGcodeOvr(editBuf.verts, editBuf.lines, genBase.segs, gcodeOvr, params);
      if (JSON.stringify(next) !== JSON.stringify(gcodeOvr)) n++;
    }
    /* ProfileEditor ممکن است حتی بدون تغییر هندسی، آرایهٔ Sketch را با مرجع
       تازه بازگرداند. مقایسهٔ مرجع باعث هشدار خروج کاذب می‌شد؛ فقط اختلاف
       واقعی محتوا باید پیش‌نویس را Dirty کند. */
    if (JSON.stringify(editBuf.sketch) !== JSON.stringify(sketch)) n++;
    return n;
  }, [editOpen, editBuf, params, genBase.segs, gcodeOvr, sketch]);

  /* پارامترهای برداشت مستقیماً توپولوژی مسیر را تغییر می‌دهند. پیش‌نویس فعلی
     ابتدا نسبت به برنامه قبلی به override تبدیل، سپس روی برنامه جدید اعمال
     می‌شود؛ بنابراین Polyline زنده به‌روز می‌شود و ویرایش‌های کاربر نیز تا
     جایی که کلید پایدار Segment وجود دارد حفظ می‌شوند. */
  useEffect(() => {
    const pending = pendingParamRebaseRef.current;
    if (!pending || presetReseedRef.current) return;
    pendingParamRebaseRef.current = null;
    setEditBuf((buf) => {
      if (!buf) return buf;
      /* آفست H2 در حالت ادیت بخشی از پیش‌نویس است. هنگام تغییر پارامترهای دیگر
         نباید به override هندسی تبدیل یا با مقدار تأییدشده بازنویسی شود. */
      const draftHolder2 = buf.holder2 ?? pending.params.holder2;
      const oldDraftParams: Params = { ...pending.params, holder2: draftHolder2 };
      const newDraftParams: Params = { ...params, holder2: draftHolder2 };
      const draftOvr = deriveGcodeOvr(buf.verts, buf.lines, pending.genBase.segs, pending.gcodeOvr, oldDraftParams);
      const rebuilt = applyGcodeOvr(genBase, draftOvr, newDraftParams);
      const seed = seedGcodeEdit(rebuilt.segs, newDraftParams);

      /* انتخاب‌ها با کلید پایدار + شماره قطعه در همان حرکت منتقل می‌شوند. */
      const oldCount = new Map<string, number>();
      const tokenById = new Map<number, string>();
      for (const line of buf.lines) {
        const n = oldCount.get(line.key) ?? 0;
        oldCount.set(line.key, n + 1);
        tokenById.set(line.id, `${line.key}\u0000${n}`);
      }
      const selectedTokens = new Set((buf.selLines ?? []).map((id) => tokenById.get(id)).filter((token): token is string => !!token));
      const activeToken = buf.activeLine == null ? null : tokenById.get(buf.activeLine) ?? null;
      const newCount = new Map<string, number>();
      const selLines: number[] = [];
      let activeLine: number | null = null;
      for (const line of seed.lines) {
        const n = newCount.get(line.key) ?? 0;
        newCount.set(line.key, n + 1);
        const token = `${line.key}\u0000${n}`;
        if (selectedTokens.has(token)) selLines.push(line.id);
        if (token === activeToken) activeLine = line.id;
      }
      return { ...buf, verts: seed.verts, lines: seed.lines, selLines, activeLine };
    });
    setHistVer((v) => v + 1);
  }, [genBase, params]);

  /* پس از اعمال preset، مسیر قدیمی با هندسه/ابعاد جدید مخلوط نمی‌شود؛ بافر
     تازه دقیقاً از خروجی جدید ساخته و انتخاب‌های قبلی پاک می‌شود. */
  useEffect(() => {
    if (!presetReseedRef.current) return;
    presetReseedRef.current = false;
    const seed = seedGcodeEdit(gen.segs, params);
    setEditBuf({ verts: seed.verts, lines: seed.lines, sketch, off: {}, holder2: { ...params.holder2 }, selLines: [], activeLine: null });
    commitRef.current = null;
    setHistVer((v) => v + 1);
  }, [gen, params, sketch]);

  /* ذخیره محلی */
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sketch, params, settings, preferences, activePreset, layout, gcodeOvr, version: SAVE_VERSION }));
    } catch {
      /* ignore */
    }
  }, [sketch, params, settings, preferences, activePreset, layout, gcodeOvr]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.style.setProperty("--profile-line-color", preferences.profileColor);
    root.style.setProperty("--selected-line-color", preferences.selectedColor);
    root.style.setProperty("--guide-line-color", preferences.guideColor);
    root.style.setProperty("--profile-line-width", String(preferences.lineWidth));
    root.style.setProperty("--profile-toolbar-scale", String(preferences.toolbarScale));
  }, [preferences]);

  useEffect(() => {
    const limit=Math.min(200,Math.max(1,Math.round(preferences.historyLimit)));
    if(past.current.length>limit)past.current.splice(0,past.current.length-limit);
    if(future.current.length>limit)future.current.splice(0,future.current.length-limit);
    setProjectTabs(tabs=>tabs.map(tab=>({...tab,past:tab.past.slice(-limit),future:tab.future.slice(-limit)})));
    setHistVer(v=>v+1);
  },[preferences.historyLimit]);

  useEffect(() => {
    if (!preferences.keepEditDraft && !editOpen && editBuf) setEditBuf(null);
  }, [preferences.keepEditDraft, editOpen, editBuf]);

  /* هنگام تغییر برنامه، هایلایت جی‌کد پاک شود */
  useEffect(() => {
    setActiveLine(-1);
  }, [gen]);

  /* در طراحی پروفایل، انتخاب خط نیز نزدیک‌ترین حرکت پرداختیِ متناظر را در جی‌کد
     نشان می‌دهد. در Edit path نگاشت دقیق‌تر بر پایهٔ ovrKey داخل ProfileEditor است. */
  useEffect(() => {
    if (mode !== "design" || editOpen) return;
    const selectedSeg = selectedIds.length
      ? sketch.find((segment) => segment.id === selectedIds[selectedIds.length - 1])
      : null;
    if (!selectedSeg) {
      setActiveLine(-1);
      return;
    }
    const target = segMid(selectedSeg);
    const finalPasses = gen.segs.filter((segment) =>
      segment.line >= 0 && segment.motion === 1 && (segment.kind === "finish" || segment.kind === "borefin")
    );
    const candidates = finalPasses.length
      ? finalPasses
      : gen.segs.filter((segment) => segment.line >= 0 && segment.motion === 1);
    let bestLine = -1;
    let bestDistance = Infinity;
    for (const segment of candidates) {
      const az = segment.z1, ar = segment.x1 / 2;
      const bz = segment.z2, br = segment.x2 / 2;
      const dz = bz - az, dr = br - ar;
      const len2 = dz * dz + dr * dr || 1;
      const t = Math.min(1, Math.max(0, ((target.z - az) * dz + (target.r - ar) * dr) / len2));
      const distance = Math.hypot(target.z - (az + dz * t), target.r - (ar + dr * t));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = segment.line;
      }
    }
    setActiveLine(bestLine);
  }, [mode, editOpen, selectedIds, sketch, gen.segs]);

  /* اگر عملیاتِ ایزوله‌شده حذف شد، از حالت ایزوله خارج شو */
  useEffect(() => {
    if (isolatedOpId != null && !params.ops.some((o) => o.id === isolatedOpId)) setIsolatedOpId(null);
  }, [params.ops, isolatedOpId]);

  /* واگرد / بازانجام روی اسکچ */
  const commitRef = useRef<HistEntry | null>(null);
  const restore = (e: HistEntry) => {
    /* هر rebase معلق متعلق به وضعیت جدیدتر است و نباید پس از Undo روی Snapshot
       بازیابی‌شده اجرا شود؛ این همان مسیری بود که خطوط و جی‌کد را خالی می‌کرد. */
    pendingParamRebaseRef.current = null;
    presetReseedRef.current = false;
    setSketch(e.sketch);
    setGenerationSketch(e.sketch);
    setGcodeOvr(e.gcodeOvr);
    setEditBuf(e.editBuf);
    setParams(e.params);
    /* وجود پیش‌نویس به معنی بازبودن UI نیست. اگر کاربر پیش از تغییر استراتژی
       از ویرایش مسیر خارج شده بود، Undo نیز همان حالت بسته را بازیابی می‌کند. */
    setEditOpen(e.editOpen);
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
    const limit = Math.min(200, Math.max(1, Math.round(preferences.historyLimit)));
    if (past.current.length > limit) past.current.splice(0, past.current.length - limit);
    commitRef.current = null;
    restore(future.current.pop()!);
  };

  /* ---------- حالت ویرایش مسیر ---------- */
  const openEdit = () => {
    if (editOpenRef.current) return;
    /* پیش‌نویس قبلی بدون seed مجدد باز می‌شود؛ انتخاب‌ها و هندسه دقیقاً حفظ شده‌اند. */
    if (editBufRef.current) {
      setEditOpen(true);
      showToast("پیش‌نویس ویرایش مسیر بازیابی شد");
      return;
    }
    pushPast(snap());
    const seed = seedGcodeEdit(gen.segs, params);
    setEditBuf({ verts: seed.verts, lines: seed.lines, sketch, off: {}, holder2: { ...params.holder2 }, selLines: [], activeLine: null });
    setEditOpen(true);
    setHistVer((v) => v + 1);
  };
  const closeEdit = () => {
    if (!editOpenRef.current) return;
    commitRef.current = null;
    if (preferences.keepEditDraft) {
      setEditOpen(false);
      showToast("ویرایش مسیر بسته شد — پیش‌نویس تغییرات برای بازگشت بعدی حفظ شد", "warn");
      return;
    }
    if (editChanges > 0) {
      setPendingEditExit(true);
      return;
    }
    setEditBuf(null);
    setEditOpen(false);
  };
  const discardEdit = () => {
    if (!editBufRef.current) return;
    pushPast(snap());
    commitRef.current = null;
    pendingParamRebaseRef.current = null;
    setEditBuf(null);
    setEditOpen(false);
    setHistVer((v) => v + 1);
    showToast("پیش‌نویس ویرایش مسیر حذف شد", "warn");
  };
  const confirmEdit = () => {
    const eb = editBufRef.current;
    if (!eb) return;
    const draftHolder2 = eb.holder2 ?? params.holder2;
    const draftParams: Params = { ...params, holder2: draftHolder2 };
    const holder2Changed =
      draftHolder2.xOff !== params.holder2.xOff || draftHolder2.yOff !== params.holder2.yOff;
    /* آفست H2 روی هندسهٔ ورود امن مولد نیز اثر دارد (گوشهٔ افقی→عمودی).
       مقایسه با پایهٔ قدیمی آن گوشه را اشتباهاً override می‌کرد؛ پایهٔ پیش‌نویس
       دقیقاً با آفست زنده ساخته می‌شود تا جابه‌جایی خالص، override نسازد. */
    const draftGenBase = holder2Changed ? generate(points, { ...draftParams, rpm: preferences.spindleSpeed, format: preferences.gcodeFormat, lineNumbers: preferences.sequenceNumbers, ramp: preferences.continuousPaths, safeBottomInnerLink: preferences.safeBottomInnerLink, simpleFeed: preferences.optimizeFeeds, spreadG0: preferences.spreadRapid, feedByKind: { ...preferences.operationFeeds, roughz: preferences.operationFeeds.rough, copy: preferences.operationFeeds.rough } }, innerPoints, outerFinishPoints) : genBase;
    const next = deriveGcodeOvr(eb.verts, eb.lines, draftGenBase.segs, gcodeOvr, draftParams);
    const sketchChanged = eb.sketch !== sketch;
    if (!sketchChanged && !holder2Changed && JSON.stringify(next) === JSON.stringify(gcodeOvr)) {
      showToast("تغییری برای ثبت نیست", "warn");
      return;
    }
    pushPast(snap());
    setGcodeOvr(next);
    if (holder2Changed) {
      /* عمداً از onParamsCb عبور نمی‌کند: بافر از قبل با همین آفست در فضای
         ماشین جابه‌جا شده و rebase دوباره باعث دوبرابرشدن حرکت می‌شود. */
      pendingParamRebaseRef.current = null;
      setParams((p) => ({ ...p, holder2: { ...draftHolder2 } }));
    }
    if (sketchChanged) {
      setActivePreset(null);
      setSketch(eb.sketch);
      setGenerationSketch(eb.sketch);
    }
    setHistVer((v) => v + 1);
    showToast(holder2Changed
      ? "جی‌کد و آفست هلدر دوم به‌روز شد ✓ (ویرایش مسیر باز ماند)"
      : "جی‌کد به‌روز شد ✓ (ویرایش مسیر باز ماند)");
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
  const onParamsCb = useCallback((patch: Partial<Params>) => {
    let historicalChange = false;
    if (patch.split) {
      const before = stateRef.current.params.split;
      historicalChange = before.enabled !== patch.split.enabled || before.z !== patch.split.z ||
        before.r !== patch.split.r || before.swapped !== patch.split.swapped;
    }
    if (patch.ops) {
      historicalChange = historicalChange || JSON.stringify(stateRef.current.params.ops) !== JSON.stringify(patch.ops);
    }
    if (historicalChange) {
      /* تغییر استراتژی نیز باید اتمیک باشد: Params و EditBuf پیش از rebase با هم
         ذخیره می‌شوند تا Undo هر دو را به یک نسل از جی‌کد برگرداند. */
      pushPast(snap());
      setHistVer((v) => v + 1);
    }
    if (editBufRef.current && !pendingParamRebaseRef.current) {
      pendingParamRebaseRef.current = { genBase, params, gcodeOvr };
    }
    setParams((p) => {
      const next = { ...p, ...patch };
      /* تعیین Split برای نخستین بار، ذاتاً طرح را دوشاخه می‌کند؛ بنابراین
         استراتژی داخل+خارج و حداقل آفست معتبر H2 هم‌زمان فعال می‌شوند. */
      if (patch.split?.enabled && !p.split.enabled) {
        const bowl = STRATEGIES.find((st) => st.id === "bowl")!;
        next.ops = makeOps(bowl.types);
        next.holder2 = {
          xOff: Math.max(MIN_HOLDER2_OFFSET, p.holder2.xOff),
          yOff: Math.max(MIN_HOLDER2_OFFSET, p.holder2.yOff),
        };
      }
      return next;
    });
  }, [genBase, params, gcodeOvr]);
  const onHolder2SettingsCb = useCallback((value: Holder2State) => {
    const next: Holder2State = {
      xOff: Math.max(MIN_HOLDER2_OFFSET, value.xOff),
      yOff: Math.max(MIN_HOLDER2_OFFSET, value.yOff),
    };
    const eb = editBufRef.current;
    if (editOpenRef.current && eb) {
      const prev = eb.holder2 ?? stateRef.current.params.holder2;
      const verts = translateHolder2Edit(
        eb.verts,
        eb.lines,
        next.xOff - prev.xOff,
        prev.yOff - next.yOff
      );
      onEditBuf({ ...eb, verts, holder2: next }, true);
      return;
    }
    onParamsCb({ holder2: next });
    // onEditBuf بر پایه refهای پایدار کار می‌کند؛ هویت callback فقط با پارامتر مولد عوض می‌شود.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onParamsCb]);
  const onStrategyCb = useCallback((id: string, name: string, types: OpType[]) => {
    /* انتخاب استراتژی یک Reset اتمیک است؛ Snapshot کامل پیش از آن نگه داشته
       می‌شود تا Ctrl+Z پارامترها، Overrideها و Edit Path را یکجا برگرداند. */
    pushPast(snap());
    commitRef.current = null;
    pendingParamRebaseRef.current = null;
    setGcodeOvr({});
    setEditBuf(null);
    setEditOpen(false);
    setParams((current) => ({
      ...current,
      ops: makeOps(types),
      ...(id === "bowl" ? {
        holder2: {
          xOff: Math.max(MIN_HOLDER2_OFFSET, current.holder2.xOff),
          yOff: Math.max(MIN_HOLDER2_OFFSET, current.holder2.yOff),
        },
      } : {}),
    }));
    setHistVer((value) => value + 1);
    showToast(`استراتژی «${name}» فعال شد`);
  }, [showToast]);

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
    if (editOpenRef.current && editBufRef.current) {
      if (!commit && !commitRef.current) commitRef.current = snap();
      onEditBuf({ ...editBufRef.current, sketch: next }, commit);
      return;
    }
    if (commit) {
      pushPast(commitRef.current ?? { sketch, gcodeOvr, editBuf: null, editOpen: false, params });
      commitRef.current = null;
      setActivePreset(null);
    } else if (!commitRef.current) {
      commitRef.current = { sketch, gcodeOvr, editBuf: null, editOpen: false, params }; // وضعیت پیش از شروع کشیدن
    }
    setSketch(next);
    if (commit || !allProfileLayersHidden) setGenerationSketch(next);
    /* اگر پیش‌نویس پنهان وجود دارد، اسکچ جدید را نیز در آن همگام نگه می‌داریم
       تا بازگشت و تأیید بعدی، تغییرات تازهٔ طراحی را بازنویسی نکند. */
    if (editBufRef.current && !editOpenRef.current) {
      setEditBuf({ ...editBufRef.current, sketch: next });
    }
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch, gcodeOvr, allProfileLayersHidden]);

  const applyPreset = useCallback((p: Preset) => {
    const nextSketch: SketchSeg[] = p.empty
      ? []
      : p.sketch
        ? p.sketch.map((seg, index) => ({ ...seg, id: Date.now() * 10 + index }))
        : p.wall
          ? sketchFromWall(p.wall.map(([z, r, smooth]) => ({ z, r, smooth })))
          : sketchFromPoints(presetPoints(p));
    const hadEditDraft = !!editBufRef.current;
    const newProjectId=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setProjectTabs(tabs=>[...tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t),{id:newProjectId,name:p.name,sketch:nextSketch,params,gcodeOvr:{},activePreset:p.id,savedSnapshot:null,past:[],future:[]}]);
    setActiveProjectId(newProjectId);

    /* هر پیش‌تنظیم پروژه‌ای مستقل است و تاریخچه پروژه قبلی وارد آن نمی‌شود. */
    past.current=[];future.current=[];
    commitRef.current = null;
    pendingParamRebaseRef.current = null;
    setSketch(nextSketch);
    setGenerationSketch(nextSketch);
    setGcodeOvr({});
    if (hadEditDraft) {
      presetReseedRef.current = true;
      /* یک render بدون بافر، camera-fit و stateهای تعاملی ویرایشگر را نیز برای
         هندسهٔ کاملاً جدید reset می‌کند؛ حالت edit در App باز می‌ماند. */
      setEditBuf(null);
    }

    setParams((prev) => {
      const next: Params = {
        ...prev,
        blankD: p.blankD,
        blankL: p.blankL,
        /* همهٔ پیش‌تنظیم‌ها با مقطع خام مربعی شروع می‌شوند. */
        blankShape: p.shape,
      };
      next.split = p.split
        ? { enabled: true, z: p.split.z, r: p.split.r }
        : { ...prev.split, enabled: false };
      if (p.strategy) {
        const st = STRATEGIES.find((s) => s.id === p.strategy);
        if (st) next.ops = makeOps(st.types);
        if (p.strategy === "bowl") {
          next.holder2 = {
            xOff: Math.max(MIN_HOLDER2_OFFSET, prev.holder2.xOff),
            yOff: Math.max(MIN_HOLDER2_OFFSET, prev.holder2.yOff),
          };
        }
      }
      return next;
    });
    setActivePreset(p.id);
    setSelectedIds([]);
    showToast(
      hadEditDraft
        ? `پیش‌تنظیم «${p.name}» اعمال و پیش‌نویس مسیر بازسازی شد`
        : p.strategy === "bowl"
          ? `پیش‌تنظیم «${p.name}» + استراتژی داخل/خارج فعال شد`
          : `پیش‌تنظیم «${p.name}» اعمال شد`
    );
  }, [showToast, params, activeProjectId]);

  /* قرار دادن خودکار نقطه Split روی لبه (بیشترین X زنجیره) */
  const autoSplit = useCallback(() => {
    const poly = chainPolyline(orderChain(sketch));
    const auto = autoSplitPoint(poly);
    if (auto) {
      onParamsCb({ split: { enabled: true, z: auto.z, r: auto.r } });
      showToast(`نقطه Split تعیین و استراتژی «کاسه داخل+خارج» فعال شد (X ${auto.z} • ⌀ ${(auto.r * 2).toFixed(1)})`);
    } else {
      showToast("زنجیره پروفیل برای Split خودکار کافی نیست", "warn");
    }
  }, [sketch, showToast, onParamsCb]);

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

  const projectData = () => JSON.stringify({
    format: "KharraatCode Project", version: SAVE_VERSION, savedAt: new Date().toISOString(),
    /* فایل اشتراکی فقط داده‌های مهندسی پروژه را حمل می‌کند؛ تنظیمات شخصی رابط
       کاربر (تم، رنگ، میانبر، حساسیت اسنپ، لایه‌ها و چیدمان) محلی می‌مانند. */
    project: { sketch, params, gcodeOvr },
    output: { postProcessor: preferences.postProcessor, gcodeUnits: preferences.gcodeUnits, sequenceNumbers: preferences.sequenceNumbers, gcodeFormat: preferences.gcodeFormat, continuousPaths: preferences.continuousPaths, optimizeFeeds: preferences.optimizeFeeds, spreadRapid: preferences.spreadRapid, spindleSpeed: preferences.spindleSpeed, operationFeeds: preferences.operationFeeds },
  }, null, 2);
  const downloadProject = (name = "project.kharraat") => {
    const url = URL.createObjectURL(new Blob([projectData()], { type: "application/json;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const saveProjectAs = async (): Promise<boolean> => {
    try {
      const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ name?: string; createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
      if (picker) {
        const handle = await picker({ suggestedName: "project.kharraat", types: [{ description: "KharraatCode Project", accept: { "application/json": [".kharraat"] } }] });
        if (!handle) return false; projectHandlesRef.current.set(activeProjectId,handle);
        const writable = await handle.createWritable(); await writable.write(projectData()); await writable.close();
        if(handle.name)setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,name:handle.name!.replace(/\.kharraat$/i,"")}:t));
      } else downloadProject();
      setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,savedSnapshot:projectSnapshot(sketch,params,gcodeOvr)}:t));
      showToast("پروژه ذخیره شد"); return true;
    } catch (error) { if ((error as {name?:string}).name !== "AbortError") showToast("ذخیره پروژه ممکن نشد", "warn"); return false; }
  };
  const saveProject = async (): Promise<boolean> => {
    const handle = projectHandlesRef.current.get(activeProjectId);
    if (!handle) return saveProjectAs();
    try { const writable = await handle.createWritable(); await writable.write(projectData()); await writable.close(); setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,savedSnapshot:projectSnapshot(sketch,params,gcodeOvr)}:t)); showToast("پروژه ذخیره شد"); return true; }
    catch { showToast("ذخیره مستقیم ممکن نشد؛ از Save As استفاده کنید", "warn"); return false; }
  };
  useEffect(() => {
    if(!saveThenCloseProject || activeProjectId!==saveThenCloseProject)return;
    let live=true;void saveProject().then(ok=>{if(live&&ok)finishCloseProject(saveThenCloseProject);if(live)setSaveThenCloseProject(null);});
    return()=>{live=false;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[saveThenCloseProject,activeProjectId]);

  const openProjectFile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as Saved & {
        format?: string;
        project?: { sketch?: SketchSeg[]; params?: Partial<Params>; gcodeOvr?: Saved["gcodeOvr"] };
        output?: { postProcessor?: string; gcodeUnits?: string; sequenceNumbers?: boolean };
      };
      const data = raw.project ?? raw; // پشتیبانی از فایل‌های پروژه نسخهٔ قبلی
      if (raw.format !== "KharraatCode Project" || !data.sketch) throw new Error("invalid-project");
      const nextSketch = normalizeSketch(data.sketch); if (!nextSketch) throw new Error("invalid-sketch");
      const nextParams=normalizeParams(data.params,false), nextOvr=normGcodeOvr(data.gcodeOvr), newProjectId=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      setProjectTabs(tabs=>[...tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t),{id:newProjectId,name:file.name.replace(/\.kharraat$/i,""),sketch:nextSketch,params:nextParams,gcodeOvr:nextOvr,activePreset:null,savedSnapshot:projectSnapshot(nextSketch,nextParams,nextOvr),past:[],future:[]}]);setActiveProjectId(newProjectId);
      setSketch(nextSketch); setGenerationSketch(nextSketch); setParams(nextParams);
      /* settings/preferences/layout عمداً بارگذاری نمی‌شوند تا محیط شخصی گیرنده تغییر نکند. */
      setActivePreset(null); setGcodeOvr(nextOvr);
      setSelectedIds([]); setEditBuf(null); setEditOpen(false); setMode("design");
      past.current=[]; future.current=[]; setHistVer(v=>v+1);
      const outputDiffers = !!raw.output && (raw.output.postProcessor !== preferences.postProcessor || raw.output.gcodeUnits !== preferences.gcodeUnits || raw.output.sequenceNumbers !== preferences.sequenceNumbers);
      showToast(outputDiffers ? `پروژه باز شد؛ تنظیمات خروجی پروژه با Preferences شما متفاوت است` : `پروژه «${file.name}» باز شد`, outputDiffers ? "warn" : "ok");
    } catch { showToast("این فایل پروژه معتبر خراط‌کد نیست", "warn"); }
  };

  const importAi = (segments: SketchSeg[], length: number, diameter: number) => {
    /* حذف نویز ممیز شناور (مثلاً 28.000000000000004) پیش از ثبت ابعاد خام. */
    length = Math.round(length * 1e6) / 1e6;
    diameter = Math.round(diameter * 1e6) / 1e6;
    pushPast(snap());
    setSketch(segments);
    setGenerationSketch(segments);
    setParams((current) => normalizeParams({ ...current, blankL: Math.max(1, length), blankD: Math.max(1, diameter) }, false));
    setSelectedIds([]);
    setActivePreset(null);
    setGcodeOvr({});
    setEditBuf(null);
    setShowAiImport(false);
    setMode("design");
    showToast(`فایل AI با ابعاد ${length.toFixed(1)} × ${diameter.toFixed(1)} میلی‌متر وارد شد`);
  };

  useEffect(() => {
    const onProjectKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key=e.key.toLowerCase();
      if(key==="s"){e.preventDefault();void (e.shiftKey?saveProjectAs():saveProject());}
      if(key==="o"){e.preventDefault();projectInputRef.current?.click();}
    };
    window.addEventListener("keydown",onProjectKey);return()=>window.removeEventListener("keydown",onProjectKey);
  });

  const editorTitle = mode === "design" ? "طراحی پروفایل" : "شبیه‌سازی تراش";
  const menuItems: WindowMenuItem[] = [
    { id: "controls", label: "تنظیمات", vis: panelVis("controls") },
    { id: "editor", label: editorTitle, vis: panelVis("editor") },
    { id: "gcode", label: "جی‌کد", vis: panelVis("gcode") },
  ];

  return (
    <div className="flex h-full flex-col @container" onDragOver={e=>{if(Array.from(e.dataTransfer.items).some(i=>i.kind==="file")){e.preventDefault();e.dataTransfer.dropEffect="copy";}}} onDrop={e=>{const file=e.dataTransfer.files[0];if(file && (file.name.toLowerCase().endsWith(".kharraat")||file.type==="application/json")){e.preventDefault();void openProjectFile(file);}}}>
      <input ref={projectInputRef} type="file" accept=".kharraat,application/json" className="hidden" onChange={e=>{const file=e.target.files?.[0];if(file)void openProjectFile(file);e.currentTarget.value="";}} />
      {showAiImport && <AIImportDialog onClose={() => setShowAiImport(false)} onImport={importAi} />}
      {showPreferences && <PreferencesDialog value={preferences} snapTolerance={settings.snapTolerancePx} onChange={setPreferences} onSnapTolerance={(snapTolerancePx) => setSettings((s) => ({ ...s, snapTolerancePx }))} onClose={() => setShowPreferences(false)} />}
      {pendingEditExit && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/45 p-4" dir="rtl"><div className="w-full max-w-md rounded-xl border border-edge2 bg-panel p-5 shadow-2xl"><h3 className="text-sm font-bold text-brass2">تغییرات تأییدنشده ویرایش مسیر</h3><p className="mt-3 text-[12px] leading-6 text-mute">تغییراتی در مسیر انجام شده که هنوز تأیید نشده‌اند. آیا می‌خواهید تغییرات را تأیید و سپس از حالت ویرایش مسیر خارج شوید؟</p><div className="mt-5 flex justify-center gap-2"><button onClick={()=>setPendingEditExit(false)} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute">لغو</button><button onClick={()=>{setPendingEditExit(false);discardEdit();}} className="rounded-md border border-danger/50 bg-danger/10 px-4 py-1.5 text-xs font-bold text-danger">خیر</button><button onClick={()=>{confirmEdit();setEditBuf(null);setEditOpen(false);setPendingEditExit(false);}} className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">بله</button></div></div></div>}
      {pendingCloseProject && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/45 p-4" dir="rtl"><div className="w-full max-w-md rounded-xl border border-edge2 bg-panel p-5 shadow-2xl"><h3 className="text-sm font-bold text-brass2">تغییرات ذخیره‌نشده</h3><p className="mt-3 text-[12px] leading-6 text-mute">تغییرات پروژه «{projectTabs.find(t=>t.id===pendingCloseProject)?.name}» ذخیره نشده است. آیا می‌خواهید پیش از بستن پروژه آن را ذخیره کنید؟</p><div className="mt-5 flex justify-center gap-2"><button onClick={()=>setPendingCloseProject(null)} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute">لغو</button><button onClick={()=>finishCloseProject(pendingCloseProject)} className="rounded-md border border-danger/50 bg-danger/10 px-4 py-1.5 text-xs font-bold text-danger">خیر</button><button onClick={()=>{const id=pendingCloseProject;setSaveThenCloseProject(id);if(id!==activeProjectId)switchProject(id);}} className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">بله</button></div></div></div>}
      <DesktopMenuBar
        projects={projectTabs.map(tab=>({id:tab.id,name:tab.name,dirty:tab.savedSnapshot!==projectSnapshot(tab.sketch,tab.params,tab.gcodeOvr)}))}
        activeProjectId={activeProjectId}
        onSwitchProject={switchProject}
        onCloseProject={requestCloseProject}
        onOpenProject={() => projectInputRef.current?.click()}
        onSaveProject={() => void saveProject()}
        onSaveProjectAs={() => void saveProjectAs()}
        onImportAi={() => setShowAiImport(true)}
        onExportGcode={downloadGCode}
        onExportDxf={downloadDxf}
        onPreferences={() => setShowPreferences(true)}
        onUndo={undo}
        onRedo={redo}
        canUndo={past.current.length > 0}
        canRedo={future.current.length > 0}
      />
      {/* ---------- سربرگ ---------- */}
      <header className="relative z-40 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-panel/85 px-3.5 py-2 pl-14 backdrop-blur">
        <button onClick={() => setShowPreferences(true)} title="Preferences" aria-label="Preferences" className="absolute top-2.5 left-3 grid h-8 w-8 place-items-center rounded-lg border border-edge bg-panel2 text-mute shadow-lg transition-colors hover:border-brass/50 hover:text-brass2">
          <IconSettings className="h-4.5 w-4.5" />
        </button>
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
          <button className="btn !px-2 !py-1.5" onClick={redo} disabled={future.current.length === 0} title="بازانجام (Ctrl+Y)">
            <IconArrowRight className="h-4 w-4" />
          </button>
          <button className="btn !px-2 !py-1.5" onClick={undo} disabled={past.current.length === 0} title="واگرد (Ctrl+Z)">
            <IconArrowLeft className="h-4 w-4" />
          </button>
          <span className="mx-1 h-5 w-px bg-edge" />
          {preferences.showHeaderImportAi && <button className="btn !px-2.5 !py-1.5 text-[11.5px]" onClick={() => setShowAiImport(true)} title="وارد کردن فایل Adobe Illustrator با پیش‌نمایش و مقیاس">
            <IconDownload className="h-3.5 w-3.5 rotate-180" />
            ورود AI
          </button>}
          {preferences.showHeaderExportDxf && <button
            className="btn btn-teal !px-2.5 !py-1.5 text-[11.5px]"
            onClick={downloadDxf}
            title="فقط مسیر عملیات تراش به ترتیب استراتژی — یکپارچه + لایهٔ مجزا برای هر عملیات"
          >
            <IconLayers className="h-3.5 w-3.5" />
            خروجی DXF
          </button>}
          {preferences.showHeaderCopyGcode && <button className="btn !px-2.5 !py-1.5 text-[11.5px]" onClick={copyGCode}>
            کپی جی‌کد
          </button>}
          {preferences.showHeaderDownloadNc && <button className="btn btn-brass !px-2.5 !py-1.5 text-[11.5px]" onClick={downloadGCode}>
            <IconDownload className="h-3.5 w-3.5" />
            دانلود NC
          </button>}
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
            params={generationParams}
            holder2Draft={editOpen && editBuf ? editBuf.holder2 : null}
            onHolder2={onHolder2SettingsCb}
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
              segs={editOpen && editBuf ? editBuf.sketch : sketch}
              onSegs={onSketchChange}
              edit={editOpen ? editBuf : null}
              editChanges={editChanges}
              onEditToggle={(open) => (open ? openEdit() : closeEdit())}
              onEditBuf={onEditBuf}
              onEditConfirm={confirmEdit}
              onEditCancel={closeEdit}
              onEditDiscard={discardEdit}
              keepEditDraft={preferences.keepEditDraft}
              selected={selectedIds}
              onSelected={setSelectedIds}
              params={generationParams}
              gen={gen}
              split={params.split}
              onSplit={(split) => onParamsCb({ split })}
              settings={settings}
              onSettings={(patch) => setSettings((s) => ({ ...s, ...patch }))}
              toolShortcuts={preferences.shortcuts}
              ops={params.ops}
              isolatedOpId={isolatedOpId}
              onClearIsolate={() => setIsolatedOpId(null)}
              onActiveGCodeLine={setActiveLine}
              onUndo={undo}
              onRedo={redo}
              canUndo={past.current.length > 0}
              canRedo={future.current.length > 0}
            />
          ) : (
              <SimulationView gen={gen} params={generationParams} onActiveLine={setActiveLine} />
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

function DesktopMenuBar({ projects, activeProjectId, onSwitchProject, onCloseProject, onOpenProject, onSaveProject, onSaveProjectAs, onImportAi, onExportGcode, onExportDxf, onPreferences, onUndo, onRedo, canUndo, canRedo }: {
  projects: {id:string;name:string;dirty:boolean}[]; activeProjectId:string; onSwitchProject:(id:string)=>void; onCloseProject:(id:string)=>void;
  onOpenProject: () => void; onSaveProject: () => void; onSaveProjectAs: () => void;
  onImportAi: () => void; onExportGcode: () => void; onExportDxf: () => void; onPreferences: () => void;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean;
}) {
  const [open, setOpen] = useState<"file" | "edit" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); };
  }, [open]);
  const run = (fn:()=>void) => { setOpen(null); fn(); };
  return <div ref={ref} dir="ltr" onPointerDown={(e)=>{if(e.target===e.currentTarget)setOpen(null);}} className="relative z-[60] flex h-7 shrink-0 items-center border-b border-edge bg-[#0e0c09] px-2 text-[11px] text-mute shadow-sm">
    <MenuTop label="File" active={open==="file"} onClick={()=>setOpen(open==="file"?null:"file")} />
    <MenuTop label="Edit" active={open==="edit"} onClick={()=>setOpen(open==="edit"?null:"edit")} />
    <div className="ml-2 flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]" dir="ltr">
      {projects.map(project=><div key={project.id} className={cn("flex h-[24px] min-w-[115px] max-w-[200px] items-center rounded-t-md border border-b-0 transition-colors",project.id===activeProjectId?"border-edge2 bg-panel text-ink":"border-edge/70 bg-panel2/55 text-dim hover:bg-panel2 hover:text-mute")}><button onClick={()=>{setOpen(null);onSwitchProject(project.id);}} title={project.name} className="min-w-0 flex-1 truncate px-2 text-[10.5px]">{project.dirty&&<span className="ml-1 text-brass">•</span>}{project.name}</button><button onClick={e=>{e.stopPropagation();onCloseProject(project.id);}} title="بستن پروژه" className="grid h-full w-6 shrink-0 place-items-center rounded-sm text-dim hover:bg-danger/15 hover:text-danger">×</button></div>)}
    </div>
    {open==="file" && <div className="absolute top-full left-1 z-50 w-52 overflow-hidden rounded-b-md border border-edge2 bg-panel/98 py-1 shadow-2xl shadow-black/60" dir="rtl">
      <MenuItem label="بازکردن پروژه…" hint="Ctrl+O" onClick={()=>run(onOpenProject)} />
      <MenuItem label="ذخیره" hint="Ctrl+S" onClick={()=>run(onSaveProject)} />
      <MenuItem label="ذخیره با نام…" hint="Ctrl+Shift+S" onClick={()=>run(onSaveProjectAs)} />
      <div className="my-1 border-t border-edge" />
      <MenuItem label="ورود فایل AI…" hint="Import" onClick={()=>run(onImportAi)} />
      <div className="my-1 border-t border-edge" />
      <MenuItem label="خروجی G-code…" hint="NC" onClick={()=>run(onExportGcode)} />
      <MenuItem label="خروجی DXF…" hint="DXF" onClick={()=>run(onExportDxf)} />
      <div className="my-1 border-t border-edge" />
      <MenuItem label="Preferences…" onClick={()=>run(onPreferences)} />
    </div>}
    {open==="edit" && <div className="absolute top-full left-[42px] z-50 w-52 overflow-hidden rounded-b-md border border-edge2 bg-panel/98 py-1 shadow-2xl shadow-black/60" dir="rtl">
      <MenuItem label="واگرد" hint="Ctrl+Z" disabled={!canUndo} onClick={()=>run(onUndo)} />
      <MenuItem label="بازانجام" hint="Ctrl+Y" disabled={!canRedo} onClick={()=>run(onRedo)} />
    </div>}
  </div>;
}
function MenuTop({label,active,onClick}:{label:string;active:boolean;onClick:()=>void}) { return <button onClick={onClick} className={cn("h-full px-3 transition-colors",active?"bg-panel3 text-ink":"hover:bg-panel2 hover:text-ink")}>{label}</button>; }
function MenuItem({label,hint,onClick,disabled=false}:{label:string;hint?:string;onClick:()=>void;disabled?:boolean}) { return <button disabled={disabled} onClick={onClick} className="flex w-full items-center justify-between px-3 py-1.5 text-right text-[11px] text-ink hover:bg-panel3 disabled:opacity-35 disabled:hover:bg-transparent"><span>{label}</span>{hint&&<span dir="ltr" className="font-mono text-[9px] text-dim">{hint}</span>}</button>; }

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
