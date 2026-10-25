import "./point-scale.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ControlsPanel from "./components/ControlsPanel";
import AIImportDialog from "./components/AIImportDialog";
import { DockPanel, DockSplitter, MAX_PANEL, MIN_PANEL, WindowMenu, defaultLayout, normalizeLayout } from "./components/Dock";
import type { LayoutState, PanelId, PanelState, PanelVis, WindowMenuItem } from "./components/Dock";
import GCodePanel from "./components/GCodePanel";
import ProfileEditor, { type EdSettings, type ReferenceImage } from "./components/ProfileEditor";
import SimulationView from "./components/SimulationView";
import PreferencesDialog, { DEFAULT_PREFERENCES, type AppPreferences } from "./components/PreferencesDialog";
import { IconArrowLeft, IconArrowRight, IconCheck, IconCode, IconDownload, IconLayers, IconPen, IconSim, IconSettings, IconSpindle, IconWarn } from "./components/icons";
import { buildDxf } from "./lib/dxf";
import { MIN_HOLDER2_OFFSET, PRESETS, STRATEGIES, applyGcodeOvr, deriveGcodeOvr, generate, makeOps, normalizeParams, presetPoints, seedGcodeEdit, translateHolder2Edit } from "./lib/lathe";
import type { EditBuf, ELine, GcodeOvrMap, GenResult, Holder2State, OpType, Params, PPoint, Preset } from "./lib/lathe";
import type { SketchSeg } from "./lib/sketch";
import { autoSplitPoint, branchPathPoints, branchPoints, chainPolyline, flattenSketch, normalizeSketch, orderChain, segMid, sketchFromPoints, sketchFromWall, splitChainAt } from "./lib/sketch";
import { cn } from "./utils/cn";

const STORE_KEY = "kharraatcode-v1";

/** نگاشت معکوس انتخاب Edit Path به سطر متن G-code، شامل خطوط تکراری و Bridgeها. */
function editLineGCodeIndex(lineId: number, editLines: ELine[], gen: GenResult): number {
  const editIndex=editLines.findIndex(line=>line.id===lineId);
  if(editIndex<0)return -1;
  const line=editLines[editIndex];
  const bridge=/^#bridge:(.+):(\d+)$/.exec(line.key);
  if(bridge){
    const baseKey=bridge[1],move=/^move:(\d+)$/.exec(baseKey);
    const segment=move?gen.segs[Number(move[1])]:gen.segs.find(candidate=>candidate.ovrKey===baseKey);
    return segment?.line??-1;
  }
  const move=/^#move:(\d+)$/.exec(line.key);
  if(move)return gen.segs[Number(move[1])]?.line??-1;
  if(line.key.startsWith("#"))return -1;
  let occurrence=-1;
  for(let i=0;i<=editIndex;i++)if(editLines[i].key===line.key)occurrence++;
  const matches=gen.segs.filter(segment=>segment.ovrKey===line.key);
  return matches.length?matches[Math.min(Math.max(0,occurrence),matches.length-1)].line:-1;
}

interface Saved {
  points?: PPoint[];
  sketch?: SketchSeg[];
  params?: Partial<Params>;
  settings?: Partial<EdSettings>;
  preferences?: Partial<AppPreferences>;
  layout?: LayoutState;
  activePreset?: string | null;
  referenceImages?: ReferenceImage[];
  gcodeOvr?: Record<string, { s?: { z: number; x: number }; e?: { z: number; x: number }; via?: { z: number; x: number }[]; moves?: { motion: 0 | 1; feed: number }[]; bridgeMoves?: Record<number, { motion: 0 | 1; feed: number }>; del?: boolean }>;
  version?: number;
}

const SAVE_VERSION = 9;

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
  referenceImages: ReferenceImage[];
  activePreset: string | null;
  savedSnapshot: string | null;
  past: HistEntry[];
  future: HistEntry[];
}

const projectSnapshot = (sketch: SketchSeg[], params: Params, gcodeOvr: GcodeOvrMap, images: ReferenceImage[] = []) => JSON.stringify({ sketch, params, gcodeOvr, images });

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
  const [imageImportRequest,setImageImportRequest]=useState(0);
  const imageHistoryApi=useRef<{undo:()=>void;redo:()=>void;canUndo:boolean;canRedo:boolean}|null>(null);
  const [imageHistoryState,setImageHistoryState]=useState({canUndo:false,canRedo:false});
  const registerImageHistory=useCallback((api:{undo:()=>void;redo:()=>void;canUndo:boolean;canRedo:boolean})=>{imageHistoryApi.current=api;setImageHistoryState(s=>s.canUndo===api.canUndo&&s.canRedo===api.canRedo?s:{canUndo:api.canUndo,canRedo:api.canRedo});},[]);
  const [saveAsName,setSaveAsName]=useState<string|null>(null);
  const saveAsResolver=useRef<((name:string|null)=>void)|null>(null);
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
      /* مهاجرت نسخه ۹: سه میانبر اختیاری نوار بالا از این نسخه پیش‌فرض خاموش‌اند. */
      ...((SAVED?.version ?? 0) < 9 ? {
        showHeaderImportAi: false,
        showHeaderExportDxf: false,
        showHeaderCopyGcode: false,
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
  /* درگ می‌تواند در یک فریم ده‌ها pointermove تولید کند؛ G-code فقط برای آخرین
     هندسه همان فریم لازم است، نه همه وضعیت‌های میانی که هرگز نمایش داده نمی‌شوند. */
  const generationFrameRef = useRef<number | null>(null);
  const pendingGenerationSketchRef = useRef<SketchSeg[] | null>(null);
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
      showInnerArea: s?.showInnerArea ?? false,
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
  const [referenceImages,setReferenceImages]=useState<ReferenceImage[]>(()=>SAVED?.referenceImages??[]);
  const initialProjectId = useRef(`project-${Date.now()}`);
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId.current);
  const [projectTabs, setProjectTabs] = useState<ProjectTab[]>([{ id: initialProjectId.current, name: PRESETS.find(p=>p.id===activePreset)?.name ?? "پروژه بدون نام", sketch, params, gcodeOvr: normGcodeOvr(SAVED?.gcodeOvr), referenceImages, activePreset, savedSnapshot: null, past: [], future: [] }]);
  const [recentProjects, setRecentProjects] = useState<ProjectTab[]>(() => { try { return JSON.parse(localStorage.getItem("kharraat-recent-projects") || "[]") as ProjectTab[]; } catch { return []; } });
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const projectTabsHydrated = useRef(false);
  const projectTabsRef = useRef(projectTabs);
  projectTabsRef.current = projectTabs;
  useEffect(() => {
    // فهرست اخیر باید مجموعهٔ همهٔ تب‌ها باشد، نه فقط تب فعال یا آخرین تب بسته‌شده.
    if (!projectTabsHydrated.current) { projectTabsHydrated.current = true; return; }
    if (!projectTabs.length) return;
    setRecentProjects(previous => {
      const byId = new Map<string, ProjectTab>();
      for (const tab of previous) byId.set(tab.id, tab);
      // تب‌های جدیدتر در ابتدای فهرست قرار می‌گیرند؛ ترتیب تب‌های داخل پروژه
      // از چپ به راست/قدیمی به جدید است، بنابراین از انتها وارد می‌کنیم.
      for (const tab of [...projectTabs].reverse()) { byId.delete(tab.id); byId.set(tab.id, tab); }
      const merged = Array.from(byId.values()).slice(0, 30);
      try { localStorage.setItem("kharraat-recent-projects", JSON.stringify(merged)); } catch {}
      return merged;
    });
  }, [projectTabs]);
  useEffect(() => {
    const saveAllOpenTabs = () => {
      const open = projectTabsRef.current;
      if (!open.length) return;
      try { localStorage.setItem("kharraat-recent-projects", JSON.stringify(open)); } catch {}
    };
    // visibilitychange هنگام بارگذاری اولیه نیز ممکن است اجرا شود و تب موقت اولیه
    // را روی فهرست ذخیره‌شده بنویسد؛ فقط خروج واقعی مرورگر معتبر است.
    window.addEventListener("beforeunload", saveAllOpenTabs);
    return () => { window.removeEventListener("beforeunload", saveAllOpenTabs); };
  }, []);
  const [pendingCloseProject, setPendingCloseProject] = useState<string|null>(null);
  const [newProjectDraft,setNewProjectDraft]=useState<{name:string;diameter:string;length:string}|null>(null);
  const [pendingEditExit, setPendingEditExit] = useState(false);
  const [saveThenCloseProject, setSaveThenCloseProject] = useState<string|null>(null);
  const [editBuf, setEditBuf] = useState<EditBuf | null>(null);
  /* باز/بسته‌بودن UI از وجود پیش‌نویس جداست تا خروج تصادفی، تغییرات تأییدنشده را پاک نکند. */
  const [editOpen, setEditOpen] = useState(false);
  const editOpenRef = useRef(editOpen);
  editOpenRef.current = editOpen;
  const editBufRef = useRef<EditBuf | null>(editBuf);
  const editBaselineRef = useRef<string>("");
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
    setProjectTabs(tabs => tabs.map(tab => tab.id===activeProjectId ? { ...tab, sketch, params, gcodeOvr, referenceImages, activePreset } : tab));
  }, [activeProjectId, sketch, params, gcodeOvr, referenceImages, activePreset]);
  const switchProject = (id: string) => {
    if(id===activeProjectId)return;const tab=projectTabs.find(t=>t.id===id);if(!tab)return;
    /* تاریخچه تب مبدأ پیش از سوییچ ذخیره و تاریخچه مستقل مقصد بازیابی می‌شود. */
    setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t));
    setActiveProjectId(id);setSketch(tab.sketch);setGenerationSketch(tab.sketch);setParams(tab.params);setGcodeOvr(tab.gcodeOvr);setReferenceImages(tab.referenceImages??[]);setActivePreset(tab.activePreset);
    const limit=Math.min(200,Math.max(1,Math.round(preferences.historyLimit)));
    setSelectedIds([]);setEditBuf(null);setEditOpen(false);past.current=tab.past.slice(-limit);future.current=tab.future.slice(-limit);setHistVer(v=>v+1);
  };
  const finishCloseProject = (id:string) => {
    const closed = projectTabs.find(t=>t.id===id);
    const remaining=projectTabs.filter(t=>t.id!==id);
    // هنگام بستن تک‌تک تب‌ها، همان تب بسته‌شده باید در صدر فهرست اخیر قرار بگیرد.
    const ordered = closed ? [closed, ...remaining, ...recentProjects] : [...remaining, ...recentProjects];
    const seen = new Set<string>();
    const recent = ordered.filter(tab => !seen.has(tab.id) && (seen.add(tab.id), true)).slice(0, 30);
    setRecentProjects(recent); try { localStorage.setItem("kharraat-recent-projects", JSON.stringify(recent)); } catch {}
    projectHandlesRef.current.delete(id);
    if(remaining.length){setProjectTabs(remaining);if(id===activeProjectId){const next=remaining[Math.max(0,projectTabs.findIndex(t=>t.id===id)-1)]??remaining[0];setActiveProjectId(next.id);setSketch(next.sketch);setGenerationSketch(next.sketch);setParams(next.params);setGcodeOvr(next.gcodeOvr);setReferenceImages(next.referenceImages??[]);setActivePreset(next.activePreset);past.current=[...next.past];future.current=[...next.future];setHistVer(v=>v+1);}}
    else { setProjectTabs([]); setWelcomeOpen(true); }
    setPendingCloseProject(null);setSelectedIds([]);setEditBuf(null);setEditOpen(false);
  };
  const requestCloseProject=(id:string)=>{const tab=projectTabs.find(t=>t.id===id);if(!tab)return;const dirty=tab.savedSnapshot!==projectSnapshot(tab.sketch,tab.params,tab.gcodeOvr,tab.referenceImages);if(dirty)setPendingCloseProject(id);else finishCloseProject(id);};
  const openNewProject=()=>{
    setWelcomeOpen(false);
    let number=1;
    while(projectTabs.some(tab=>tab.name===`پروژه جدید ${number}`))number++;
    setNewProjectDraft({name:`پروژه جدید ${number}`,diameter:String(params.blankD),length:String(params.blankL)});
  };
  const createNewProject=()=>{
    if(!newProjectDraft)return;
    const diameter=Number(newProjectDraft.diameter),length=Number(newProjectDraft.length),name=newProjectDraft.name.trim();
    if(!(diameter>=0.01&&diameter<=10000)||!(length>=0.01&&length<=10000)){showToast("قطر و طول قطعه باید بین ۰٫۰۱ تا ۱۰۰۰۰ میلی‌متر باشند","warn");return;}
    const id=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const nextParams=normalizeParams({...params,blankD:diameter,blankL:length,split:{...params.split,enabled:false},innerZoneOrder:[],innerZoneBounds:[]},false);
    /* پروژه تازه در لحظه ایجاد وضعیت تمیز دارد؛ هشدار فقط پس از نخستین تغییر
       واقعی نسبت به همین Snapshot نمایش داده می‌شود. */
    const initialSnapshot=projectSnapshot([],nextParams,{},[]);
    setProjectTabs(tabs=>[...tabs.map(tab=>tab.id===activeProjectId?{...tab,past:[...past.current],future:[...future.current]}:tab),{id,name:name||`پروژه جدید ${tabs.length+1}`,sketch:[],params:nextParams,gcodeOvr:{},referenceImages:[],activePreset:null,savedSnapshot:initialSnapshot,past:[],future:[]}]);
    setActiveProjectId(id);setSketch([]);setGenerationSketch([]);setParams(nextParams);setGcodeOvr({});setReferenceImages([]);setActivePreset(null);setSelectedIds([]);setEditBuf(null);setEditOpen(false);past.current=[];future.current=[];setHistVer(v=>v+1);setNewProjectDraft(null);
  };

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

  const generationParams = useMemo<Params>(() => ({ ...params, rpm: preferences.spindleSpeed, format: preferences.gcodeFormat, lineNumbers: preferences.sequenceNumbers, ramp: preferences.continuousPaths, safeBottomInnerLink: preferences.safeBottomInnerLink, innerBoundaryRoutingMode: preferences.innerBoundaryRoutingMode, simpleFeed: preferences.optimizeFeeds, spreadG0: preferences.spreadRapid, feedByKind: { ...preferences.operationFeeds, roughz: preferences.operationFeeds.rough, copy: preferences.operationFeeds.rough } }), [params, preferences.operationFeeds, preferences.spindleSpeed, preferences.gcodeFormat, preferences.sequenceNumbers, preferences.continuousPaths, preferences.safeBottomInnerLink, preferences.innerBoundaryRoutingMode, preferences.optimizeFeeds, preferences.spreadRapid]);
  const genBase = useMemo(() => generate(points, generationParams, innerPoints, outerFinishPoints), [points, generationParams, innerPoints, outerFinishPoints]);

  const gen = useMemo(() => applyGcodeOvr(genBase, gcodeOvr, generationParams), [genBase, gcodeOvr, generationParams]);

  /* هنگام Drag هلدر دوم، اختلاف آفست به‌تنهایی برای فعال‌کردن «تأیید» کافی است؛
     در این مسیر داغ عمداً deriveGcodeOvr (پیمایش کل برنامه) اجرا نمی‌شود تا
     حرکت حتی روی برنامه‌های چند هزار خطی روان بماند. */
  const editChanges = useMemo(() => {
    if (!editOpen || !editBuf) return 0;
    /* Pan، Zoom، Scroll و انتخاب‌ها جزو هندسه پیش‌نویس نیستند. Dirty فقط از
       رأس‌ها، خطوط، Sketch و آفست هلدر محاسبه می‌شود و با Seed لحظه ورود سنجیده می‌شود. */
    const geometry=JSON.stringify({verts:editBuf.verts,lines:editBuf.lines,sketch:editBuf.sketch,holder2:editBuf.holder2});
    return geometry===editBaselineRef.current?0:1;
  }, [editOpen, editBuf]);

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
    const nextEdit: EditBuf = { verts: seed.verts, lines: seed.lines, sketch, off: {}, holder2: { ...params.holder2 }, selLines: [], activeLine: null };
    editBaselineRef.current = JSON.stringify({ verts: nextEdit.verts, lines: nextEdit.lines, sketch: nextEdit.sketch, holder2: nextEdit.holder2 });
    setEditBuf(nextEdit);
    commitRef.current = null;
    setHistVer((v) => v + 1);
  }, [gen, params, sketch]);

  /* ذخیره محلی */
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ sketch, params, settings, preferences, activePreset, layout, gcodeOvr, referenceImages, version: SAVE_VERSION }));
    } catch {
      /* ignore */
    }
  }, [sketch, params, settings, preferences, activePreset, layout, gcodeOvr, referenceImages]);

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

  const selectFromGCode = useCallback((lineIndex: number) => {
    setActiveLine(lineIndex);
    if (!editOpen) return;
    setEditBuf((current) => {
      if (!current) return current;
      const matching=current.lines.find(line=>editLineGCodeIndex(line.id,current.lines,gen)===lineIndex);
      if(!matching)return current;
      return { ...current, selLines: [matching.id], activeLine: matching.id };
    });
  }, [editOpen, gen]);

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
  const undoAny=()=>imageHistoryApi.current?.canUndo?imageHistoryApi.current.undo():undo();
  const redoAny=()=>imageHistoryApi.current?.canRedo?imageHistoryApi.current.redo():redo();

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
    const nextEdit: EditBuf = { verts: seed.verts, lines: seed.lines, sketch, off: {}, holder2: { ...params.holder2 }, selLines: [], activeLine: null };
    editBaselineRef.current = JSON.stringify({ verts: nextEdit.verts, lines: nextEdit.lines, sketch: nextEdit.sketch, holder2: nextEdit.holder2 });
    setEditBuf(nextEdit);
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
    const draftGenBase = holder2Changed ? generate(points, { ...draftParams, rpm: preferences.spindleSpeed, format: preferences.gcodeFormat, lineNumbers: preferences.sequenceNumbers, ramp: preferences.continuousPaths, safeBottomInnerLink: preferences.safeBottomInnerLink, innerBoundaryRoutingMode: preferences.innerBoundaryRoutingMode, simpleFeed: preferences.optimizeFeeds, spreadG0: preferences.spreadRapid, feedByKind: { ...preferences.operationFeeds, roughz: preferences.operationFeeds.rough, copy: preferences.operationFeeds.rough } }, innerPoints, outerFinishPoints) : genBase;
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
    /* تأیید، وضعیت فعلی را به Baseline جدید تبدیل می‌کند. کپی سطحی EditBuf
       وابستگی useMemo را نیز تغییر می‌دهد تا editChanges همان لحظه صفر شود و
       خروج بعد از تأیید، هشدار تغییرات تأییدنشده نشان ندهد. */
    editBaselineRef.current = JSON.stringify({ verts: eb.verts, lines: eb.lines, sketch: eb.sketch, holder2: eb.holder2 });
    setEditBuf({ ...eb });
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
    if (commit) {
      if (generationFrameRef.current != null) cancelAnimationFrame(generationFrameRef.current);
      generationFrameRef.current = null;pendingGenerationSketchRef.current = null;
      setGenerationSketch(next);
    } else if (!allProfileLayersHidden) {
      pendingGenerationSketchRef.current = next;
      if (generationFrameRef.current == null) generationFrameRef.current = requestAnimationFrame(() => {
        generationFrameRef.current = null;
        const latest=pendingGenerationSketchRef.current;pendingGenerationSketchRef.current=null;
        if(latest)setGenerationSketch(latest);
      });
    }
    /* اگر پیش‌نویس پنهان وجود دارد، اسکچ جدید را نیز در آن همگام نگه می‌داریم
       تا بازگشت و تأیید بعدی، تغییرات تازهٔ طراحی را بازنویسی نکند. */
    if (editBufRef.current && !editOpenRef.current) {
      setEditBuf({ ...editBufRef.current, sketch: next });
    }
    setHistVer((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sketch, gcodeOvr, allProfileLayersHidden]);

  const applyPreset = useCallback((p: Preset) => {
    setWelcomeOpen(false);
    const nextSketch: SketchSeg[] = p.empty
      ? []
      : p.sketch
        ? p.sketch.map((seg, index) => ({ ...seg, id: Date.now() * 10 + index }))
        : p.wall
          ? sketchFromWall(p.wall.map(([z, r, smooth]) => ({ z, r, smooth })))
          : sketchFromPoints(presetPoints(p));
    const hadEditDraft = !!editBufRef.current;
    const newProjectId=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setProjectTabs(tabs=>[...tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t),{id:newProjectId,name:p.name,sketch:nextSketch,params,gcodeOvr:{},referenceImages:[],activePreset:p.id,savedSnapshot:null,past:[],future:[]}]);
    setActiveProjectId(newProjectId);

    /* هر پیش‌تنظیم پروژه‌ای مستقل است و تاریخچه پروژه قبلی وارد آن نمی‌شود. */
    past.current=[];future.current=[];
    commitRef.current = null;
    pendingParamRebaseRef.current = null;
    setSketch(nextSketch);
    setGenerationSketch(nextSketch);
    setGcodeOvr({});
    setReferenceImages([]);
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
      /* پروژه‌های ذخیره‌شده می‌توانند تنظیمات ماشین‌کاری خود را نیز همراه
         پیش‌تنظیم نگه دارند؛ ابعاد و Split صریح پریست در پایان قطعی می‌شوند. */
      if (p.params) Object.assign(next, p.params);
      next.blankD = p.blankD;
      next.blankL = p.blankL;
      next.blankShape = p.shape;
      next.split = p.split
        ? { enabled: true, z: p.split.z, r: p.split.r }
        : { ...prev.split, enabled: false };
      // پریست در لحظهٔ ایجاد «تمیز» است؛ بنابراین بستن آن بدون ویرایش نباید
      // هشدار تغییرات ذخیره‌نشده نشان دهد.
      setProjectTabs(tabs => tabs.map(tab => tab.id === newProjectId
        ? { ...tab, savedSnapshot: projectSnapshot(nextSketch, next, {}, []) }
        : tab));
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
    a.download = "kharraatcode.cnc";
    a.click();
    URL.revokeObjectURL(url);
    showToast("فایل kharraatcode.cnc آماده شد");
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
    project: { sketch, params, gcodeOvr, referenceImages },
    output: { postProcessor: preferences.postProcessor, gcodeUnits: preferences.gcodeUnits, sequenceNumbers: preferences.sequenceNumbers, gcodeFormat: preferences.gcodeFormat, continuousPaths: preferences.continuousPaths, optimizeFeeds: preferences.optimizeFeeds, spreadRapid: preferences.spreadRapid, spindleSpeed: preferences.spindleSpeed, operationFeeds: preferences.operationFeeds },
  }, null, 2);
  const downloadProject = (name = "project.kharraat") => {
    const url = URL.createObjectURL(new Blob([projectData()], { type: "application/json;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const askProjectName=()=>new Promise<string|null>(resolve=>{saveAsResolver.current=resolve;setSaveAsName(projectTabs.find(t=>t.id===activeProjectId)?.name||"project");});
  const saveProjectAs = async (): Promise<boolean> => {
    try {
      if(!preferences.useWindowsSaveDialog){const entered=await askProjectName();if(!entered)return false;const clean=entered.trim().replace(/[\\/:*?"<>|]+/g,"-").replace(/\.kharraat$/i,"")||"project";downloadProject(`${clean}.kharraat`);setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,name:clean,savedSnapshot:projectSnapshot(sketch,params,gcodeOvr,referenceImages)}:t));showToast("پروژه ذخیره شد");return true;}
      const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ name?: string; createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
      if (picker) {
        const handle = await picker({ suggestedName: "project.kharraat", types: [{ description: "KharraatCode Project", accept: { "application/json": [".kharraat"] } }] });
        if (!handle) return false; projectHandlesRef.current.set(activeProjectId,handle);
        const writable = await handle.createWritable(); await writable.write(projectData()); await writable.close();
        if(handle.name)setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,name:handle.name!.replace(/\.kharraat$/i,"")}:t));
      } else {const entered=await askProjectName();if(!entered)return false;downloadProject(`${entered.trim().replace(/[\\/:*?"<>|]+/g,"-").replace(/\.kharraat$/i,"")||"project"}.kharraat`);}
      setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,savedSnapshot:projectSnapshot(sketch,params,gcodeOvr,referenceImages)}:t));
      showToast("پروژه ذخیره شد"); return true;
    } catch (error) { if ((error as {name?:string}).name !== "AbortError") showToast("ذخیره پروژه ممکن نشد", "warn"); return false; }
  };
  const saveProject = async (): Promise<boolean> => {
    const handle = projectHandlesRef.current.get(activeProjectId);
    if (!handle) return saveProjectAs();
    try { const writable = await handle.createWritable(); await writable.write(projectData()); await writable.close(); setProjectTabs(tabs=>tabs.map(t=>t.id===activeProjectId?{...t,savedSnapshot:projectSnapshot(sketch,params,gcodeOvr,referenceImages)}:t)); showToast("پروژه ذخیره شد"); return true; }
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
        project?: { sketch?: SketchSeg[]; params?: Partial<Params>; gcodeOvr?: Saved["gcodeOvr"]; referenceImages?: ReferenceImage[] };
        output?: { postProcessor?: string; gcodeUnits?: string; sequenceNumbers?: boolean };
      };
      const data = raw.project ?? raw; // پشتیبانی از فایل‌های پروژه نسخهٔ قبلی
      if (raw.format !== "KharraatCode Project" || !data.sketch) throw new Error("invalid-project");
      const nextSketch = normalizeSketch(data.sketch); if (!nextSketch) throw new Error("invalid-sketch");
      const nextParams=normalizeParams(data.params,false), nextOvr=normGcodeOvr(data.gcodeOvr), nextImages=data.referenceImages??[], newProjectId=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      setProjectTabs(tabs=>[...tabs.map(t=>t.id===activeProjectId?{...t,past:[...past.current],future:[...future.current]}:t),{id:newProjectId,name:file.name.replace(/\.kharraat$/i,""),sketch:nextSketch,params:nextParams,gcodeOvr:nextOvr,referenceImages:nextImages,activePreset:null,savedSnapshot:projectSnapshot(nextSketch,nextParams,nextOvr,nextImages),past:[],future:[]}]);setActiveProjectId(newProjectId);
      setSketch(nextSketch); setGenerationSketch(nextSketch); setParams(nextParams);
      /* settings/preferences/layout عمداً بارگذاری نمی‌شوند تا محیط شخصی گیرنده تغییر نکند. */
      setActivePreset(null); setGcodeOvr(nextOvr); setReferenceImages(nextImages);
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
      const key=/^Key[A-Z]$/.test(e.code)?e.code.slice(3).toLowerCase():e.key.toLowerCase();
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
      {(welcomeOpen||projectTabs.length===0)&&<div className="fixed inset-0 z-[100] grid place-items-center bg-bg p-8" dir="rtl"><div className="w-full max-w-5xl"><h1 className="text-2xl font-bold text-brass2">خراط‌کد</h1><p className="mt-1 text-sm text-dim">مدیریت پروژه‌ها</p><div className="mt-8 grid gap-5 md:grid-cols-3"><section className="rounded-xl border border-edge2 bg-panel p-5"><h2 className="font-bold text-ink">پروژه‌های اخیر</h2>{recentProjects.length?<div className="mt-3 max-h-64 space-y-1 overflow-y-auto pl-1">{recentProjects.map(p=><button key={p.id} className="truncate rounded-md px-2 py-1 text-right text-xs text-mute hover:bg-panel2" onClick={()=>{setWelcomeOpen(false);setProjectTabs(recentProjects);const t=recentProjects.find(x=>x.id===p.id)!;setActiveProjectId(t.id);setSketch(t.sketch);setGenerationSketch(t.sketch);setParams(t.params);setGcodeOvr(t.gcodeOvr);setReferenceImages(t.referenceImages||[]);setActivePreset(t.activePreset);}}>{p.name}</button>)}<button className="mt-2 rounded-md bg-teal/15 px-3 py-2 text-xs font-bold text-teal" onClick={()=>{setWelcomeOpen(false);setProjectTabs(recentProjects);const t=recentProjects[0];setActiveProjectId(t.id);setSketch(t.sketch);setGenerationSketch(t.sketch);setParams(t.params);setGcodeOvr(t.gcodeOvr);setReferenceImages(t.referenceImages||[]);setActivePreset(t.activePreset);}}>باز کردن همه پروژه‌ها</button></div>:<p className="mt-3 text-xs leading-6 text-dim">پروژه اخیری وجود ندارد.</p>}<button className="mt-3 w-full rounded-md border border-edge px-3 py-2 text-xs text-mute" onClick={()=>{setWelcomeOpen(false);projectInputRef.current?.click()}}>باز کردن فایل پروژه</button></section><section className="rounded-xl border border-brass/60 bg-brass/10 p-5"><h2 className="font-bold text-brass2">ایجاد پروژه جدید</h2><p className="mt-3 text-xs leading-6 text-mute">یک پروژه خالی برای طراحی پروفایل بسازید.</p><button className="mt-5 w-full rounded-md bg-brass px-3 py-2 text-xs font-bold text-[#241a0c]" onClick={openNewProject}>طراحی پروفایل جدید</button></section><section className="rounded-xl border border-edge2 bg-panel p-5"><h2 className="font-bold text-ink">پیش‌تنظیم‌های طراحی</h2><div className="mt-3 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto">{PRESETS.map(p=><button key={p.id} className="rounded-md border border-edge bg-panel2 px-3 py-2 text-right transition-colors hover:border-brass/60 hover:bg-brass/10" onClick={()=>applyPreset(p)}><span className="block text-[11px] font-bold text-ink">{p.name}</span><small className="mt-1 block font-mono text-[8px] text-dim">D{p.blankD} × L{p.blankL} mm</small></button>)}</div></section></div></div></div>}{newProjectDraft&&<div className="fixed inset-0 z-[140] grid place-items-center bg-black/50 p-4" dir="rtl"><form onSubmit={e=>{e.preventDefault();createNewProject();}} className="w-full max-w-md overflow-hidden rounded-xl border border-edge2 bg-panel shadow-2xl"><div className="border-b border-edge bg-panel2 px-5 py-4"><h3 className="text-sm font-bold text-brass2">ایجاد پروژه جدید</h3><label className="mt-3 block text-[10.5px] text-mute">نام پروژه<input autoFocus value={newProjectDraft.name} onChange={e=>setNewProjectDraft({...newProjectDraft,name:e.target.value})} onFocus={e=>e.currentTarget.select()} className="field-input mt-1.5 w-full"/></label></div><div className="p-5"><div className="grid grid-cols-2 gap-3"><label className="text-[10.5px] text-mute">قطر قطعه (mm)<input type="number" min="0.01" max="10000" step="0.01" value={newProjectDraft.diameter} onChange={e=>setNewProjectDraft({...newProjectDraft,diameter:e.target.value})} className="field-input mt-1.5 w-full"/></label><label className="text-[10.5px] text-mute">طول قطعه (mm)<input type="number" min="0.01" max="10000" step="0.01" value={newProjectDraft.length} onChange={e=>setNewProjectDraft({...newProjectDraft,length:e.target.value})} className="field-input mt-1.5 w-full"/></label></div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={()=>setNewProjectDraft(null)} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute hover:text-ink">لغو</button><button type="submit" className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">ایجاد پروژه</button></div></div></form></div>}
      {saveAsName!==null&&<div className="fixed inset-0 z-[130] grid place-items-center bg-black/45 p-4" dir="rtl"><form onSubmit={e=>{e.preventDefault();const value=saveAsName;setSaveAsName(null);saveAsResolver.current?.(value);saveAsResolver.current=null;}} className="w-full max-w-sm rounded-xl border border-edge2 bg-panel p-5 shadow-2xl"><h3 className="text-sm font-bold text-brass2">ذخیره پروژه با نام</h3><label className="mt-4 block text-[11px] text-mute">نام پروژه<input autoFocus value={saveAsName} onChange={e=>setSaveAsName(e.target.value)} onFocus={e=>e.currentTarget.select()} className="field-input mt-2 w-full"/></label><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={()=>{setSaveAsName(null);saveAsResolver.current?.(null);saveAsResolver.current=null;}} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute">لغو</button><button type="submit" className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">ذخیره</button></div></form></div>}
      {pendingEditExit && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/45 p-4" dir="rtl"><div className="w-full max-w-md rounded-xl border border-edge2 bg-panel p-5 shadow-2xl"><h3 className="text-sm font-bold text-brass2">تغییرات تأییدنشده ویرایش مسیر</h3><p className="mt-3 text-[12px] leading-6 text-mute">تغییراتی در مسیر انجام شده که هنوز تأیید نشده‌اند. آیا می‌خواهید تغییرات را تأیید و سپس از حالت ویرایش مسیر خارج شوید؟</p><div className="mt-5 flex justify-center gap-2"><button onClick={()=>setPendingEditExit(false)} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute">لغو</button><button onClick={()=>{setPendingEditExit(false);discardEdit();}} className="rounded-md border border-danger/50 bg-danger/10 px-4 py-1.5 text-xs font-bold text-danger">خیر</button><button onClick={()=>{confirmEdit();setEditBuf(null);setEditOpen(false);setPendingEditExit(false);}} className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">بله</button></div></div></div>}
      {pendingCloseProject && <div className="fixed inset-0 z-[120] grid place-items-center bg-black/45 p-4" dir="rtl"><div className="w-full max-w-md rounded-xl border border-edge2 bg-panel p-5 shadow-2xl"><h3 className="text-sm font-bold text-brass2">تغییرات ذخیره‌نشده</h3><p className="mt-3 text-[12px] leading-6 text-mute">تغییرات پروژه «{projectTabs.find(t=>t.id===pendingCloseProject)?.name}» ذخیره نشده است. آیا می‌خواهید پیش از بستن پروژه آن را ذخیره کنید؟</p><div className="mt-5 flex justify-center gap-2"><button onClick={()=>setPendingCloseProject(null)} className="rounded-md border border-edge px-4 py-1.5 text-xs text-mute">لغو</button><button onClick={()=>finishCloseProject(pendingCloseProject)} className="rounded-md border border-danger/50 bg-danger/10 px-4 py-1.5 text-xs font-bold text-danger">خیر</button><button onClick={()=>{const id=pendingCloseProject;setSaveThenCloseProject(id);if(id!==activeProjectId)switchProject(id);}} className="rounded-md bg-brass px-4 py-1.5 text-xs font-bold text-[#241a0c]">بله</button></div></div></div>}
      <DesktopMenuBar
        projects={projectTabs.map(tab=>({id:tab.id,name:tab.name,dirty:tab.savedSnapshot!==projectSnapshot(tab.sketch,tab.params,tab.gcodeOvr,tab.referenceImages)}))}
        activeProjectId={activeProjectId}
        onSwitchProject={switchProject}
        onCloseProject={requestCloseProject}
        onNewProject={openNewProject}
        onOpenProject={() => projectInputRef.current?.click()}
        onSaveProject={() => void saveProject()}
        onSaveProjectAs={() => void saveProjectAs()}
        onImportAi={() => setShowAiImport(true)}
        onImportImage={() => setImageImportRequest(v=>v+1)}
        onExportGcode={downloadGCode}
        onExportDxf={downloadDxf}
        onPreferences={() => setShowPreferences(true)}
        onUndo={undoAny}
        onRedo={redoAny}
        canUndo={past.current.length > 0||imageHistoryState.canUndo}
        canRedo={future.current.length > 0||imageHistoryState.canRedo}
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
          <button className="btn !px-2 !py-1.5" onClick={redoAny} disabled={future.current.length === 0&&!imageHistoryState.canRedo} title="بازانجام (Ctrl+Y)">
            <IconArrowRight className="h-4 w-4" />
          </button>
          <button className="btn !px-2 !py-1.5" onClick={undoAny} disabled={past.current.length === 0&&!imageHistoryState.canUndo} title="واگرد (Ctrl+Z)">
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
            دانلود CNC
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
            outerDisplayPoints={outerFinishPoints}
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
              key={activeProjectId}
              projectId={activeProjectId}
              referenceImages={referenceImages}
              onReferenceImages={setReferenceImages}
              imageImportRequest={imageImportRequest}
              registerImageHistory={registerImageHistory}
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
              showCanvasPaintTool={preferences.showCanvasPaintTool}
              rightClickToolToggle={preferences.rightClickToolToggle}
              deferMarqueeControlPoints={preferences.deferMarqueeControlPoints}
              profileLineWidth={preferences.lineWidth}
              pointScale={preferences.pointScale}
              disableSelectionGlow={preferences.disableSelectionGlow}
              profileColor={preferences.profileColor}
              selectedColor={preferences.selectedColor}
              guideLineColor={preferences.guideColor}
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
          <GCodePanel gen={gen} activeLine={activeLine} onLineClick={selectFromGCode} />
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

function DesktopMenuBar({ projects, activeProjectId, onSwitchProject, onCloseProject, onNewProject, onOpenProject, onSaveProject, onSaveProjectAs, onImportAi, onImportImage, onExportGcode, onExportDxf, onPreferences, onUndo, onRedo, canUndo, canRedo }: {
  projects: {id:string;name:string;dirty:boolean}[]; activeProjectId:string; onSwitchProject:(id:string)=>void; onCloseProject:(id:string)=>void;
  onNewProject:()=>void; onOpenProject: () => void; onSaveProject: () => void; onSaveProjectAs: () => void;
  onImportAi: () => void; onImportImage: () => void; onExportGcode: () => void; onExportDxf: () => void; onPreferences: () => void;
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
      <button onClick={()=>{setOpen(null);onNewProject();}} title="ایجاد پروژه جدید" aria-label="ایجاد پروژه جدید" className="mb-px grid h-[23px] w-7 shrink-0 place-items-center rounded-t-md border border-b-0 border-edge/80 bg-panel2/70 text-[18px] leading-none text-mute transition-colors hover:border-brass/60 hover:bg-panel3 hover:text-brass2">+</button>
    </div>
    {open==="file" && <div className="absolute top-full left-1 z-50 w-52 overflow-hidden rounded-b-md border border-edge2 bg-panel/98 py-1 shadow-2xl shadow-black/60" dir="rtl">
      <MenuItem label="ایجاد پروژه جدید…" hint="New" onClick={()=>run(onNewProject)} />
      <MenuItem label="بازکردن پروژه…" hint="Ctrl+O" onClick={()=>run(onOpenProject)} />
      <MenuItem label="ذخیره" hint="Ctrl+S" onClick={()=>run(onSaveProject)} />
      <MenuItem label="ذخیره با نام…" hint="Ctrl+Shift+S" onClick={()=>run(onSaveProjectAs)} />
      <div className="my-1 border-t border-edge" />
      <MenuItem label="ورود فایل AI…" hint="Import" onClick={()=>run(onImportAi)} />
      <MenuItem label="وارد کردن عکس…" onClick={()=>run(onImportImage)} />
      <div className="my-1 border-t border-edge" />
      <MenuItem label="خروجی G-code…" hint="CNC" onClick={()=>run(onExportGcode)} />
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
