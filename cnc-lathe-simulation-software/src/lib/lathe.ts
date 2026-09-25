/* ------------------------------------------------------------------ */
/*  خراط‌کد — موتور هندسه، مسیر ابزار و جی‌کد برای خراطی دومحور (X/Z)   */
/* ------------------------------------------------------------------ */

import type { SketchSeg } from "./sketch";

export interface PPoint {
  id: number;
  z: number; // موقعیت طولی (mm)
  r: number; // شعاع (mm)
  smooth: boolean; // نقطه صاف (اسپلاین) یا گوشه
}

/** روش خشن‌تراشی: کلاسیک (یک‌طرفه) | رفت‌وبرگشتی (زیگزاگ) | ناحیه‌ای */
export type RoughMode = "classic" | "zigzag" | "zone";

export const ROUGH_MODES: { id: RoughMode; name: string }[] = [
  { id: "classic", name: "یک‌طرفه (کلاسیک)" },
  { id: "zigzag", name: "رفت‌وبرگشتی (زیگزاگ)" },
  { id: "zone", name: "ناحیه‌ای" },
];

/* ---------------- شکل مقطع خام و پوشش دورانی ---------------- */

/** شکل مقطع خام: دایره | مربع | شش‌ضلعی | هشت‌ضلعی */
export type BlankShape = "circle" | "square" | "hex" | "octagon";

export const BLANK_SHAPES: { id: BlankShape; name: string; sides: number }[] = [
  { id: "circle", name: "دایره‌ای", sides: 0 },
  { id: "square", name: "مربعی", sides: 4 },
  { id: "hex", name: "شش‌ضلعی", sides: 6 },
  { id: "octagon", name: "هشت‌ضلعی", sides: 8 },
];

/**
 * محاسبهٔ پوشش دورانی خام: هنگام چرخش، گوشه‌های مقطعِ چندضلعی دایره‌ای بزرگ‌تر
 * از «قطر واقعی» (قطر محاطی / فاصلهٔ بین لبه‌های موازی) را جاروب می‌کنند.
 * قطر واقعی = blankD (قطر محاطی) و قطر مؤثر دوران = قطر محیطی (دورترین گوشه).
 */
export function rotationalEnvelope(blankD: number, shape: BlankShape): {
  maxRotD: number; // قطر مؤثر دوران (پوشش حداکثری)
  inR: number; // شعاع محاطی (قطر واقعی / ۲)
  outR: number; // شعاع محیطی (دورترین نقطه از محور)
  sides: number; // تعداد اضلاع (۰ = دایره)
  hasCorners: boolean;
  growth: number; // میزان افزایش نسبت به قطر واقعی
} {
  const s = BLANK_SHAPES.find((b) => b.id === shape);
  const inR = blankD / 2;
  if (!s || s.sides === 0) {
    return { maxRotD: blankD, inR, outR: inR, sides: 0, hasCorners: false, growth: 0 };
  }
  const outR = inR / Math.cos(Math.PI / s.sides);
  return {
    maxRotD: outR * 2,
    inR,
    outR,
    sides: s.sides,
    hasCorners: true,
    growth: outR * 2 - blankD,
  };
}

/* ---------------- نقطه Split و هلدر دوم (کاسه) ---------------- */

/**
 * نقطه تعیین‌کننده (Split Point): زنجیرهٔ پروفیل را به دو شاخه تقسیم می‌کند —
 * شاخهٔ «خارج کاسه» (External) و شاخهٔ «داخل کاسه» (Internal).
 */
export interface SplitState {
  enabled: boolean;
  z: number; // موقعیت طولی نقطه روی پروفیل (mm)
  r: number; // شعاع نقطه روی پروفیل (mm)
}

/**
 * هلدر دوم (داخل‌تراش): نسبت به هلدر اول ۹۰ درجه در جهت منفی چرخیده است.
 * موقعیت مکانی آن ثابت نیست؛ اپراتور با دو آفست آن را تنظیم می‌کند:
 * xOff = فاصله در جهت ‎+X‎ محلی ، yOff = فاصله در جهت ‎−Y‎ محلی.
 */
export interface Holder2State {
  xOff: number;
  yOff: number;
}

/** چرخش ثابت هلدر دوم نسبت به هلدر اول (درجه) */
export const HOLDER2_ROT = -90;

export const DEFAULT_SPLIT: SplitState = { enabled: false, z: 90, r: 68 };
export const DEFAULT_HOLDER2: Holder2State = { xOff: 50, yOff: 50 };
export const MIN_HOLDER2_OFFSET = 50;

export interface Params {
  blankD: number; // قطر خام
  blankL: number; // طول خام
  blankShape: BlankShape; // شکل مقطع خام
  doc: number; // عمق بار خشن (شعاع)
  offsetDist: number; // فاصله آفست — مرجع مراحل خشن قبل از پرداخت بیرونی
  innerOffsetDist: number; // فاصله آفست داخل‌تراشی — مرجع خشن و پاس پیش از پرداخت داخل
  innerStartClearance: number; // فاصله شروع داخل‌تراشی جلوتر از اولین عملیات H2
  innerEndTravel: number; // حرکت مستقیم +X پس از آخرین عملیات داخل‌تراشی
  feedRough: number; // mm/min
  feedFinish: number; // mm/min
  rpm: number;
  tool: ToolSpec; // مشخصات مهندسی ابزار
  safety: number; // فاصله امن جمع‌کردن
  roughMode: RoughMode; // روش خشن‌تراشی
  ramp: boolean; // اتصال پیوسته بین مسیرهای خشن (بدون G0 — فرورفتن مستقیم برشی)
  simpleFeed: boolean; // فیدر بهینه: همهٔ فیدرها به دو F اصلی (خشن/پرداخت) ساده شوند
  zoneOrder: number[]; // ترتیب دستی نواحی (اندیس ناحیه‌ها) — آرایه خالی = ترتیب خودکار
  zoneBounds: number[]; // مرزهای دستی داخلی نواحی (Z) — آرایه خالی = تقسیم خودکار
  lineNumbers: boolean;
  ops: Op[]; // زنجیره عملیات تراش (استراتژی)
  format: CodeFormat; // سبک خروجی جی‌کد
  spreadG0: boolean; // گسترش G0 در جی‌کد: حرکت‌های سریع روی‌هم با گام ۳mm فقط به سمت بیرون باز می‌شوند (فیدرها عوض نمی‌شوند)
  split: SplitState; // نقطه تعیین‌کننده داخل/خارج (کاسه)
  holder2: Holder2State; // آفست‌های قابل تنظیم هلدر دوم
}

/* ---------------- مشخصات مهندسی ابزار ---------------- */

export type ToolType = "angle" | "round" | "groove";

/** دستهٔ تراش اینسرت V 35° — زاویه‌های استاندارد */
export type ToolHand = "center" | "left" | "right";

export const HAND_INFO: Record<ToolHand, { name: string; desc: string; k: number }> = {
  center: { name: "وسط‌تراش", desc: "متقارن — زاویه ۹۰°", k: 90 },
  right: { name: "راست‌تراش", desc: "لبهٔ اصلی راست — ۸۷°", k: 87 },
  left: { name: "چپ‌تراش", desc: "لبهٔ اصلی چپ — ۹۳°", k: 93 },
};

export interface ToolSpec {
  type: ToolType;
  hand: ToolHand; // دستهٔ تراش (فقط اینسرت V 35°)
  angle: number; // زاویهٔ اینسرت — ثابت ۳۵ درجه
  nose: number; // شعاع نوک اینسرت (mm)
  size: number; // طول لبه اینسرت (mm)
  radius: number; // شعاع اینسرت گرد (mm)
  width: number; // پهنای تیغه شیارزن (mm)
  corner: number; // شعاع گوشه شیارزن (mm)
  shank: number; // پهنای دنباله (mm)
}

export const INSERT_ANGLE = 35; // زاویهٔ اینسرت V — ثابت

export const DEFAULT_TOOL: ToolSpec = {
  type: "angle",
  hand: "center",
  angle: INSERT_ANGLE,
  nose: 0.2,
  size: 16,
  radius: 6,
  width: 3,
  corner: 0.2,
  shank: 12,
};

/** شعاع‌های نوک استاندارد ISO */
export const NOSE_RADII = [0.2, 0.4, 0.8, 1.2, 1.6];

export function normalizeTool(raw: unknown, legacyW?: number): ToolSpec {
  const base = { ...DEFAULT_TOOL };
  if (raw && typeof raw === "object") {
    const r = raw as Partial<ToolSpec>;
    if (r.type === "angle" || r.type === "round" || r.type === "groove") base.type = r.type;
    if (r.hand === "center" || r.hand === "left" || r.hand === "right") base.hand = r.hand;
    const nums: (keyof ToolSpec)[] = ["angle", "nose", "size", "radius", "width", "corner", "shank"];
    for (const k of nums) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) (base[k] as number) = v;
    }
    return base;
  }
  if (typeof legacyW === "number" && Number.isFinite(legacyW) && legacyW > 0) {
    base.type = "groove";
    base.width = legacyW;
  }
  return base;
}

/* پروفایل برشی ابزار: c(dz) = ارتفاع کف ابزار نسبت به نوک در فاصلهٔ محوری dz */
export interface ToolProfile {
  min: number;
  max: number;
  pts: [number, number][]; // [dz, c]
  height: number; // ارتفاع اینسرت برای ترسیم
}

export function toolProfile(t: ToolSpec): ToolProfile {
  const rad = (d: number) => (d * Math.PI) / 180;
  const pts: [number, number][] = [];
  let min = 0;
  let max = 1;
  let height = 6;
  const step = 0.2;

  if (t.type === "groove") {
    const w = Math.max(0.5, t.width);
    const rc = Math.min(Math.max(0, t.corner), w / 2);
    min = -w / 2;
    max = w / 2;
    height = Math.max(4, w * 1.6);
    void rad;
    for (let dz = min; dz <= max + 1e-9; dz += step) {
      const z = Math.min(max, dz);
      const edge = w / 2 - rc;
      const over = Math.abs(z) - edge;
      const c = over > 0 ? rc - Math.sqrt(Math.max(0, rc * rc - over * over)) : 0;
      pts.push([z, c]);
    }
    pts.push([max, pts[pts.length - 1][1]]);
  } else if (t.type === "round") {
    const R = Math.max(0.5, t.radius);
    min = -R;
    max = R;
    height = R * 2;
    for (let dz = -R; dz <= R + 1e-9; dz += step) {
      const z = Math.min(R, dz);
      pts.push([z, R - Math.sqrt(Math.max(0, R * R - z * z))]);
    }
    pts.push([R, R - Math.sqrt(Math.max(0, R * R - R * R))]);
  } else {
    /* اینسرت V 35° — زاویهٔ Included ثابت، جهت‌گیری بر اساس دستهٔ تراش      */
    /* هندسهٔ دقیق: دو لبهٔ صاف + کمان نوک که بر هر دو لبه مماس است            */
    const INC = INSERT_ANGLE;
    const S = Math.max(3, t.size);
    const Rn = Math.max(0, Math.min(t.nose, S / 4));
    /* زاویهٔ لبهٔ چپ (aL) و راست (aR) نسبت به محور Z — aL−aR = ۳۵° */
    let aL: number;
    let aR: number;
    if (t.hand === "center") {
      aL = 90 + INC / 2; // ۱۰۷.۵°
      aR = 90 - INC / 2; // ۷۲.۵°
    } else if (t.hand === "right") {
      aR = 87; // لبهٔ اصلی نزدیک قائم در سمت راست
      aL = aR + INC; // لبهٔ فرعی ۵۸° به سمت چپ
    } else {
      aL = 93; // لبهٔ اصلی نزدیک قائم در سمت چپ
      aR = aL - INC; // لبهٔ فرعی ۵۸° به سمت راست
    }
    const rL = rad(aL);
    const rR = rad(aR);
    const sL = Math.tan(rL); // منفی
    const sR = Math.tan(rR); // مثبت
    const lineC = (dz: number) => (dz < 0 ? dz * sL : dz * sR);

    /* مرکز کمان نوک: هم‌فاصلهٔ Rn از هر دو لبه (درون V) */
    let xc = 0;
    let yc = Rn;
    const det = Math.sin(rL - rR);
    if (Rn > 0 && Math.abs(det) > 1e-9) {
      xc = (Rn * (Math.cos(rR) + Math.cos(rL))) / det;
      yc = (Rn * (Math.sin(rL) + Math.sin(rR))) / det;
    }
    const arcC = (dz: number): number => {
      const dx = dz - xc;
      if (Rn <= 0 || Math.abs(dx) > Rn) return -Infinity;
      return yc - Math.sqrt(Rn * Rn - dx * dx);
    };

    min = S * Math.cos(rL);
    max = S * Math.cos(rR);
    height = Math.max(4, S * 0.95);
    for (let dz = min; dz <= max + 1e-9; dz += step) {
      const z = Math.min(max, dz);
      pts.push([z, Math.max(lineC(z), arcC(z))]);
    }
    pts.push([max, Math.max(lineC(max), arcC(max))]);
  }
  /* تضمین نمونهٔ دقیق در نوک ابزار (dz = 0) */
  if (pts.length >= 2 && pts[0][0] < -1e-9 && pts[pts.length - 1][0] > 1e-9) {
    let k = 0;
    while (k < pts.length - 1 && pts[k + 1][0] < 0) k++;
    const [z1, c1] = pts[k];
    const [z2, c2] = pts[k + 1];
    const c0 = c1 + (c2 - c1) * ((0 - z1) / (z2 - z1));
    pts.splice(k + 1, 0, [0, c0]);
  }
  return { min, max, pts, height };
}

export function toolDesc(t: ToolSpec): string {
  if (t.type === "round") return `ROUND INSERT R${t.radius}`;
  if (t.type === "groove") return `GROOVE TOOL W${t.width}`;
  return `V${INSERT_ANGLE} ${HAND_INFO[t.hand].name.toUpperCase()} INSERT NOSE R${t.nose}`;
}

export type CodeFormat = "modal" | "std";

export const RAPID_RATE = 2500; // mm/min

let opUid = 1;

/** گروه‌بندی عملیات برای انتخاب سریع «داخل / خارج / هردو» */
export const OUTER_OPS: OpType[] = ["round", "face", "rough-d", "rough-z", "copy", "offset", "finish"];
export const INNER_OPS: OpType[] = ["inner-rough", "inner-offset", "inner-finish", "bottom"];

/** هلدر پیش‌فرض هر عملیات: داخل‌تراشی با هلدر دوم، بقیه با هلدر اول */
export const DEFAULT_HOLDER: Record<OpType, 1 | 2> = {
  round: 1,
  face: 1,
  "rough-d": 1,
  "rough-z": 1,
  copy: 1,
  offset: 1,
  finish: 1,
  "inner-rough": 2,
  "inner-offset": 2,
  "inner-finish": 2,
  bottom: 2,
};

export const DEFAULT_PARAMS: Params = {
  blankD: 60,
  blankL: 200,
  blankShape: "square",
  doc: 3,
  offsetDist: 0.5,
  innerOffsetDist: 0.5,
  innerStartClearance: 2,
  innerEndTravel: 300,
  feedRough: 220,
  feedFinish: 110,
  rpm: 1500,
  tool: { ...DEFAULT_TOOL },
  safety: 2,
  roughMode: "zone",
  ramp: true,
  simpleFeed: true,
  zoneOrder: [],
  zoneBounds: [],
  lineNumbers: true,
  ops: makeOps(["round", "rough-d", "offset", "finish"]),
  format: "modal",
  spreadG0: false,
  split: { ...DEFAULT_SPLIT },
  holder2: { ...DEFAULT_HOLDER2 },
};

/* نرمال‌سازی پارامترهای ذخیره‌شده (سازگاری با نسخه‌های قبل) */
export function normalizeParams(
  raw: (Partial<Params> & { facing?: boolean; spring?: boolean; toolW?: number; finAllow?: number; zigzag?: boolean }) | undefined,
  legacy = false
): Params {
  const base: Params = {
    ...DEFAULT_PARAMS,
    ops: makeOps(STRATEGIES[0].types),
    tool: { ...DEFAULT_TOOL },
    split: { ...DEFAULT_SPLIT },
    holder2: { ...DEFAULT_HOLDER2 },
  };
  if (!raw) return base;
  const keys: (keyof Params)[] = ["blankD", "blankL", "doc", "offsetDist", "innerOffsetDist", "innerStartClearance", "innerEndTravel", "feedRough", "feedFinish", "rpm", "safety", "lineNumbers", "ramp", "simpleFeed", "spreadG0"];
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) (base[k] as number) = v as number;
    else if (typeof v === "boolean") (base[k] as boolean) = v as boolean;
  }
  base.innerStartClearance = Math.min(20, Math.max(0, base.innerStartClearance));
  base.innerEndTravel = Math.min(500, Math.max(300, base.innerEndTravel));
  /* مهاجرت «اضافه پرداخت» قدیمی به «فاصله آفست» */
  if (typeof raw.finAllow === "number" && Number.isFinite(raw.finAllow)) base.offsetDist = raw.finAllow;
  /* روش خشن‌تراشی + مهاجرت سوئیچ زیگزاگ قدیمی */
  if (raw.roughMode === "classic" || raw.roughMode === "zigzag" || raw.roughMode === "zone") base.roughMode = raw.roughMode;
  else if (typeof raw.zigzag === "boolean") base.roughMode = raw.zigzag ? "zigzag" : "classic";
  /* شکل مقطع خام */
  if (raw.blankShape === "circle" || raw.blankShape === "square" || raw.blankShape === "hex" || raw.blankShape === "octagon") {
    base.blankShape = raw.blankShape;
  }
  /* ترتیب دستی نواحی — فقط آرایه‌ای از اعداد معتبر پذیرفته می‌شود */
  if (Array.isArray(raw.zoneOrder) && raw.zoneOrder.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) {
    base.zoneOrder = [...raw.zoneOrder];
  }
  /* مرزهای دستی نواحی — مرتب، داخل قطعه و متمایز */
  if (Array.isArray(raw.zoneBounds) && raw.zoneBounds.every((v) => typeof v === "number" && Number.isFinite(v))) {
    base.zoneBounds = [...raw.zoneBounds].sort((a, b) => a - b);
  }
  const ops = normalizeOps(raw.ops, legacy);
  if (ops) base.ops = ops;
  if (raw.format === "modal" || raw.format === "std") base.format = raw.format;
  /* نقطه Split و هلدر دوم */
  if (raw.split && typeof raw.split === "object") {
    const s = raw.split as Partial<SplitState>;
    if (typeof s.enabled === "boolean") base.split.enabled = s.enabled;
    if (typeof s.z === "number" && Number.isFinite(s.z)) base.split.z = s.z;
    if (typeof s.r === "number" && Number.isFinite(s.r)) base.split.r = s.r;
  }
  if (raw.holder2 && typeof raw.holder2 === "object") {
    const h = raw.holder2 as Partial<Holder2State>;
    if (typeof h.xOff === "number" && Number.isFinite(h.xOff)) base.holder2.xOff = Math.max(MIN_HOLDER2_OFFSET, h.xOff);
    if (typeof h.yOff === "number" && Number.isFinite(h.yOff)) base.holder2.yOff = Math.max(MIN_HOLDER2_OFFSET, h.yOff);
  }
  base.tool = normalizeTool(raw.tool, raw.toolW);
  return base;
}

export interface Sample {
  z: number;
  r: number;
}

/* آفست نرمال واقعی (منحنی موازی): هر نمونه در جهت نرمال محلی به اندازه dist
   جابه‌جا می‌شود؛ outward=true یعنی سمت بیرون پروفیل (خارج‌تراشی) وگرنه سمت
   داخل (حفره). برخلاف r±OD شعاعی، فاصله عمودی از منحنی مرجع در تمام طول
   ثابت می‌ماند. */
export function normalOffset(pts: Sample[], dist: number, outward: boolean): Sample[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1 || dist === 0) return pts.map((s) => ({ z: s.z, r: s.r }));
  let zMin = Infinity, zMax = -Infinity;
  for (const s of pts) { if (s.z < zMin) zMin = s.z; if (s.z > zMax) zMax = s.z; }
  const zMid = (zMin + zMax) / 2;
  const out: Sample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const tl = Math.hypot(b.z - a.z, b.r - a.r);
    let nz: number, nr: number;
    if (tl < 1e-9) { nz = 0; nr = 1; } // نمونه تکراری: شعاعی
    else { const tz = (b.z - a.z) / tl, tr = (b.r - a.r) / tl; nz = -tr; nr = tz; }
    if (Math.abs(nr) < 1e-9) {
      // نرمال محوری (دیواره پیشانی): بیرون = دور از وسط پروفیل
      const sgn = pts[i].z >= zMid ? 1 : -1;
      nz = outward ? sgn : -sgn; nr = 0;
    } else if (outward ? nr < 0 : nr > 0) { nz = -nz; nr = -nr; }
    out[i] = { z: pts[i].z + dist * nz, r: pts[i].r + dist * nr };
  }
  return trimOffsetLoops(out);
}

/* تقاطع واقعی (داخلی-داخلی، نه سرهای مشترک) دو پاره‌خط */
function segCross(p1: Sample, p2: Sample, p3: Sample, p4: Sample): Sample | null {
  const dz1 = p2.z - p1.z, dr1 = p2.r - p1.r, dz2 = p4.z - p3.z, dr2 = p4.r - p3.r;
  const d = dz1 * dr2 - dr1 * dz2;
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p3.z - p1.z) * dr2 - (p3.r - p1.r) * dz2) / d;
  const u = ((p3.z - p1.z) * dr1 - (p3.r - p1.r) * dz1) / d;
  if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6)
    return { z: p1.z + t * dz1, r: p1.r + t * dr1 };
  return null;
}

/* حذف حلقه‌های خودتقاطعی آفست در کنج‌های مقعر: هر جا دو پاره غیرمجاور هم را
   قطع کنند، حلقه بین‌شان بریده و نقطه تقاطع جایگزین می‌شود؛ تا پاک‌شدن کامل */
function trimOffsetLoops(pts: Sample[]): Sample[] {
  let cur = pts;
  for (let pass = 0; pass < cur.length; pass++) {
    let cut = false;
    for (let i = 0; i < cur.length - 1 && !cut; i++) {
      const a1 = cur[i], a2 = cur[i + 1];
      const az0 = Math.min(a1.z, a2.z), az1 = Math.max(a1.z, a2.z);
      const ar0 = Math.min(a1.r, a2.r), ar1 = Math.max(a1.r, a2.r);
      for (let j = i + 2; j < cur.length - 1; j++) {
        const b1 = cur[j], b2 = cur[j + 1];
        if (Math.min(b1.z, b2.z) > az1 + 1e-9 || Math.max(b1.z, b2.z) < az0 - 1e-9) continue;
        if (Math.min(b1.r, b2.r) > ar1 + 1e-9 || Math.max(b1.r, b2.r) < ar0 - 1e-9) continue;
        const P = segCross(a1, a2, b1, b2);
        if (P) { cur = [...cur.slice(0, i + 1), P, ...cur.slice(j + 1)]; cut = true; break; }
      }
    }
    if (!cut) return cur;
  }
  return cur;
}

export type SegKind = "rapid" | "round" | "face" | "rough" | "roughz" | "copy" | "offset" | "finish" | "bore" | "boreoff" | "borefin" | "bottom";

/* ---------------- عملیات و استراتژی‌های تراش ---------------- */

export type OpType = "round" | "face" | "rough-d" | "rough-z" | "copy" | "offset" | "finish" | "inner-rough" | "inner-offset" | "inner-finish" | "bottom";

export interface Op {
  id: number;
  type: OpType;
  on: boolean;
  holder: 1 | 2; // هلدر مجری عملیات: ۱ = هلدر اصلی (خارج) ، ۲ = هلدر چرخیده (داخل)
}

export const OP_INFO: Record<OpType, { name: string; desc: string; color: string }> = {
  round: { name: "گرد کردن گوشه‌ها", desc: "برداشت قسمت اضافی مقطع تا استوانهٔ قطر واقعی", color: "#b48ee0" },
  face: { name: "پیشانی‌تراشی", desc: "تراش سطح سر قطعه تا شعاع طرح", color: "#e3a94e" },
  "rough-d": { name: "خشن شعاعی G71", desc: "لایه‌های قطری با حرکت طولی", color: "#45b394" },
  "rough-z": { name: "خشن محوری G72", desc: "فرورفتن شعاعی در گام‌های طولی", color: "#6ab0d8" },
  copy: { name: "کپی‌تراشی", desc: "مسیرهای موازی با خط طرح", color: "#a3c15c" },
  offset: { name: "آفست", desc: "خط موازی با طرح — مرجع مراحل خشن", color: "#f59a80" },
  finish: { name: "پرداخت نهایی", desc: "حرکت دقیق روی خط اصلی طرح", color: "#e0703c" },
  "inner-rough": { name: "خشن داخل (کاسه)", desc: "خالی‌کردن داخل کاسه با هلدر دوم", color: "#4cc9f0" },
  "inner-offset": { name: "افست داخل تراشی", desc: "مسیر موازی دیواره داخلی پیش از پرداخت", color: "#c77dff" },
  "inner-finish": { name: "پرداخت داخل", desc: "پرداخت دیواره داخلی با هلدر دوم", color: "#f72585" },
  bottom: { name: "کف‌تراشی", desc: "برداشت طول اضافی خام پشت صفحه دهانه با هلدر داخل‌تراشی", color: "#ffd166" },
};

export const ALL_OP_TYPES: OpType[] = ["round", "face", "rough-d", "rough-z", "copy", "offset", "finish", "inner-rough", "inner-offset", "inner-finish", "bottom"];

export interface Strategy {
  id: string;
  name: string;
  types: OpType[];
}

export const STRATEGIES: Strategy[] = [
  { id: "g71", name: "استاندارد شعاعی", types: ["round", "rough-d", "offset", "finish"] },
  { id: "g72", name: "محوری پله‌ای", types: ["round", "rough-z", "offset", "finish"] },
  { id: "copy", name: "کپی‌تراشی", types: ["round", "copy", "offset", "finish"] },
  { id: "bowl", name: "کاسه داخل+خارج", types: ["round", "face", "rough-d", "offset", "finish", "bottom", "inner-rough", "inner-offset", "inner-finish"] },
];

export function makeOps(types: OpType[]): Op[] {
  const ops = types.map((t) => ({ id: opUid++, type: t, on: true, holder: DEFAULT_HOLDER[t] }));
  /* پیش‌فرض: همیشه عملیات خارج‌تراشی اول و داخل‌تراشی بعد از آن (جابه‌جایی دستی با درگ/فلش آزاد است) */
  return outerFirstOps(ops);
}

/** مرتب‌سازی پایدار: بیرونی‌ها به ترتیب فعلی، سپس داخل‌ها به ترتیب فعلی */
export function outerFirstTypes(types: OpType[]): OpType[] {
  return [...types.filter((t) => !INNER_OPS.includes(t)), ...types.filter((t) => INNER_OPS.includes(t))];
}

export function outerFirstOps<T extends { type: OpType }>(ops: T[]): T[] {
  const outer: T[] = [];
  const inner: T[] = [];
  for (const o of ops) (INNER_OPS.includes(o.type) ? inner : outer).push(o);
  return [...outer, ...inner];
}

/** محل درج پیش‌فرضِ عملیات تازه: بیرونی ← انتهای بلوک بیرونی، داخلی ← انتهای زنجیره */
export function defaultOpInsertIndex(ops: { type: OpType }[], type: OpType): number {
  if (INNER_OPS.includes(type)) return ops.length;
  const firstInner = ops.findIndex((o) => INNER_OPS.includes(o.type));
  return firstInner === -1 ? ops.length : firstInner;
}

export function normalizeOps(raw: unknown, legacy = false): Op[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Op[] = [];
  for (const o of raw as { type?: unknown; on?: unknown; id?: unknown }[]) {
    if (!o || typeof o.type !== "string") continue;
    let t = o.type;
    if (legacy) {
      /* داده‌های پیش از نسخه ۲: «offset» کپی‌تراشی بود و «spring» پاس فنری */
      if (t === "offset") t = "copy";
      else if (t === "spring") t = "offset";
    }
    if ((ALL_OP_TYPES as string[]).includes(t)) {
      const hh = (o as { holder?: unknown }).holder;
      out.push({
        id: typeof o.id === "number" ? o.id : opUid++,
        type: t as OpType,
        on: o.on !== false,
        holder: hh === 2 ? 2 : hh === 1 ? 1 : DEFAULT_HOLDER[t as OpType],
      });
    }
  }
  /* مهاجرت زنجیره‌های کاسه ذخیره‌شده پیش از افزوده‌شدن آفست داخل‌تراشی. */
  if (out.some((o) => o.type === "inner-rough") && out.some((o) => o.type === "inner-finish") && !out.some((o) => o.type === "inner-offset")) {
    const roughAt = out.findIndex((o) => o.type === "inner-rough");
    const id = Math.max(0, ...out.map((o) => o.id)) + 1;
    out.splice(roughAt + 1, 0, { id, type: "inner-offset", on: true, holder: 2 });
  }
  if (legacy && out.length) {
    /* «آفست» (پاس فنری سابق) همیشه بعد از پرداخت بود؛ حالا باید قبل از آن باشد */
    const offsets = out.filter((o) => o.type === "offset");
    if (offsets.length) {
      const rest = out.filter((o) => o.type !== "offset");
      const fi = rest.findIndex((o) => o.type === "finish");
      if (fi >= 0) rest.splice(fi, 0, ...offsets);
      else rest.push(...offsets);
      return rest;
    }
  }
  return out.length ? out : null;
}

export interface Seg {
  motion: 0 | 1; // 0 = G0 سریع ، 1 = G1 برشی
  x1: number; // قطر شروع
  z1: number;
  x2: number; // قطر پایان
  z2: number;
  feed: number;
  feedOvr?: boolean; // فیدِ دستی ویرایش مسیر؛ از ساده‌سازی global feed مستثناست
  line: number; // اندیس خط در آرایه خطوط جی‌کد
  kind: SegKind;
  op: OpType | "sys"; // عملیات مولد این حرکت
  opId: number; // شناسه نمونه عملیات (برای نمایش ایزوله و خروجی تفکیکی) — حرکات سیستمی: 1-
  holder: 1 | 2; // هلدر مجری — مختصات هلدر ۲ در پس‌پردازنده تبدیل می‌شود
  note?: string[]; // کامنت‌های قبل از این حرکت (فقط فرمت استاندارد)
  fan?: number; // گسترش G0 این حرکت در جی‌کد (+قطر، فقط حرکت سریع طولی در/بالای رترکت؛ پیش‌فرض ۰)
  fanU?: number; // گسترش G0 در راستای محور (+طول، فقط بیرون قطعه یا رانش داخل‌خط تراورس؛ پیش‌فرض ۰)
  ovrKey?: string; // کلید پایدار خط برای «ویرایش مسیر» (عملیات:شماره‌خط در عملیات)
}

export interface GenResult {
  lines: string[];
  segs: Seg[];
  samples: Sample[];
  innerSamples: Sample[]; // دیواره داخلی کاسه (خالی وقتی Split غیرفعال است)
  cutLen: number;
  rapidLen: number;
  timeSec: number;
  volumeCm3: number;
  roughLayers: number;
  format: CodeFormat;
}

const f2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

/* ---------------- نمونه‌برداری از پروفایل (Catmull-Rom) ---------------- */

function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export function sampleProfile(points: PPoint[], blankR: number): Sample[] {
  const clampR = (r: number, R: number) => Math.min(Math.max(r, 0), R);
  const pts = [...points].sort((a, b) => a.z - b.z);
  const out: Sample[] = [];
  if (pts.length === 0) return out;
  if (pts.length === 1) return [{ z: pts[0].z, r: clampR(pts[0].r, blankR) }];

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const segLen = Math.hypot(p2.z - p1.z, p2.r - p1.r);
    const steps = Math.max(6, Math.ceil(segLen / 1.2));
    const smooth = p1.smooth && p2.smooth;
    const startJ = i === 0 ? 0 : 1;
    for (let j = startJ; j <= steps; j++) {
      const t = j / steps;
      let z: number, r: number;
      if (smooth) {
        z = cr(p0.z, p1.z, p2.z, p3.z, t);
        r = cr(p0.r, p1.r, p2.r, p3.r, t);
      } else {
        z = p1.z + (p2.z - p1.z) * t;
        r = p1.r + (p2.r - p1.r) * t;
      }
      out.push({ z, r: clampR(r, blankR) });
    }
  }
  out.sort((a, b) => a.z - b.z);
  return out;
}

/* ---------------- بازه‌های برش برای یک لایه خشن ---------------- */

function cutIntervals(samples: Sample[], layer: number) {
  const raw: { a: number; b: number }[] = [];
  let cur: { a: number; b: number } | null = null;
  for (const s of samples) {
    if (s.r < layer - 0.01) {
      if (!cur) cur = { a: s.z, b: s.z };
      else cur.b = s.z;
    } else if (cur) {
      raw.push(cur);
      cur = null;
    }
  }
  if (cur) raw.push(cur);
  // ادغام بازه‌های نزدیک به هم
  const merged: { a: number; b: number }[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.a - last.b < 0.9) last.b = iv.b;
    else merged.push({ ...iv });
  }
  return merged.filter((iv) => iv.b - iv.a > 0.3);
}

/* ---------------- نواحی قطعه برای خشن ناحیه‌ای ----------------          */
/* پروفایل بر اساس قله‌ها و دره‌های شعاعی به نواحی یکنواخت تقسیم می‌شود تا   */
/* ابزار هر ناحیه را به‌طور کامل (همهٔ لایه‌ها) با الگوی رفت‌وبرگشتی تراش    */
/* دهد و سپس به ناحیهٔ بعد برود — بدون جابه‌جایی‌های مکرر بین نواحی.         */
export function findZones(samples: Sample[]): { a: number; b: number }[] {
  const n = samples.length;
  const z0 = samples[0]?.z ?? 0;
  const z1 = samples[n - 1]?.z ?? 0;
  if (n < 7) return [{ a: z0, b: z1 }];
  // هموارسازی شعاع برای حذف نویز
  const rs: number[] = samples.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      s += samples[j].r;
      c++;
    }
    return s / c;
  });
  // پنجرهٔ تشخیص برحسب میلی‌متر (~۶mm) و آستانهٔ برجستگی نسبی به دامنهٔ شعاع
  const dz = (z1 - z0) / (n - 1);
  const W = Math.max(3, Math.round(6 / Math.max(0.2, dz)));
  let minR = Infinity;
  let maxR = -Infinity;
  for (const r of rs) {
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  const prom = Math.max(0.5, (maxR - minR) * 0.05);

  /* مرزها فقط روی نوک هر قله (بیشینهٔ شعاع) قرار می‌گیرند — دره‌ها مرز نیستند.   */
  /* برجستگی هر قله نسبت به دره‌های مجاورش سنجیده می‌شود تا هم قله‌های تیز و هم  */
  /* قله‌های پهن (مثل شکم گلدان) شناسایی شوند.                                  */
  const peaks: { z: number; r: number }[] = [];
  const valleys: { z: number; r: number }[] = [];
  for (let i = W; i < n - W; i++) {
    let isMax = true;
    let isMin = true;
    for (let j = i - W; j <= i + W; j++) {
      if (rs[j] > rs[i]) isMax = false;
      if (rs[j] < rs[i]) isMin = false;
    }
    if (isMax) peaks.push({ z: samples[i].z, r: rs[i] });
    else if (isMin) valleys.push({ z: samples[i].z, r: rs[i] });
  }
  // برجستگی کلاسیک: ارتفاع قله نسبت به بلندترین درهٔ مجاور (یا لبه‌ها)
  const peakBounds: { z: number; r: number }[] = [];
  for (const pk of peaks) {
    let leftR = rs[0];
    let rightR = rs[n - 1];
    let foundLeft = false;
    let foundRight = false;
    for (const v of valleys) {
      if (v.z < pk.z) {
        leftR = v.r;
        foundLeft = true;
      } else if (v.z > pk.z && !foundRight) {
        rightR = v.r;
        foundRight = true;
      }
    }
    if (!foundLeft) leftR = rs[0];
    if (!foundRight) rightR = rs[n - 1];
    const prominence = pk.r - Math.max(leftR, rightR);
    if (prominence > prom) peakBounds.push(pk);
  }
  // حذف قله‌های نزدیک به هم (کمتر از ۳ میلی‌متر) — بلندترین قلهٔ هر خوشه نگه داشته می‌شود
  const dedupPeak: { z: number; r: number }[] = [];
  for (const pk of peakBounds) {
    const last = dedupPeak[dedupPeak.length - 1];
    if (last && pk.z - last.z < 3) {
      if (pk.r > last.r) dedupPeak[dedupPeak.length - 1] = pk;
    } else {
      dedupPeak.push(pk);
    }
  }
  const dedup: number[] = dedupPeak.map((p) => p.z);
  const bounds: number[] = [z0, ...dedup, z1];
  bounds.sort((a, b) => a - b);
  // ساخت نواحی از کل بازهٔ قطعه (ابتدا، قله‌ها، انتها) و ادغام بخش‌های کوتاه
  const zones: { a: number; b: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 0.3) zones.push({ a: bounds[i], b: bounds[i + 1] });
  }
  const merged: { a: number; b: number }[] = [];
  for (const z of zones) {
    if (z.b - z.a < 4 && merged.length) merged[merged.length - 1].b = z.b;
    else merged.push({ ...z });
  }
  if (merged.length > 1 && merged[merged.length - 1].b - merged[merged.length - 1].a < 4) {
    merged[merged.length - 2].b = merged[merged.length - 1].b;
    merged.pop();
  }
  return merged.length ? merged : [{ a: z0, b: z1 }];
}

/* نواحی نهایی: اگر کاربر مرزهای دستی معتبر تعیین کرده باشد از آن استفاده می‌شود، */
/* در غیر این صورت تقسیم خودکار بر اساس قله‌ها و دره‌ها.                            */
export function resolveZones(samples: Sample[], manualBounds: number[], z0: number, z1: number): { a: number; b: number }[] {
  if (manualBounds.length) {
    const bounds = [...manualBounds]
      .filter((v) => v > z0 + 0.3 && v < z1 - 0.3)
      .sort((a, b) => a - b)
      .filter((v, i, arr) => i === 0 || v - arr[i - 1] >= 1);
    if (bounds.length) {
      const all = [z0, ...bounds, z1];
      const zones: { a: number; b: number }[] = [];
      for (let i = 0; i < all.length - 1; i++) {
        if (all[i + 1] - all[i] > 0.3) zones.push({ a: all[i], b: all[i + 1] });
      }
      if (zones.length) return zones;
    }
  }
  return findZones(samples);
}

/* ---------------- تولید مسیر ابزار و جی‌کد ---------------- */

export function generate(pts: PPoint[], p: Params, innerPts?: PPoint[]): GenResult {
  const R = p.blankD / 2;
  const samples = sampleProfile(pts, R);
  /* شاخه داخلی فقط وقتی معتبر است که Split فعال باشد و شاخه داخلی داده داشته باشد */
  const innerSamples = p.split.enabled && innerPts && innerPts.length >= 2 ? sampleProfile(innerPts, R) : [];
  const segs: Seg[] = [];
  const hasOuter = samples.length >= 2;
  const hasInner = innerSamples.length >= 2;

  if (!hasOuter && !hasInner) {
    return {
      lines: ["%", p.format === "modal" ? "M05" : "(NO PROFILE)", "M02", "%"],
      segs: [],
      samples,
      innerSamples,
      cutLen: 0,
      rapidLen: 0,
      timeSec: 0,
      volumeCm3: 0,
      roughLayers: 0,
      format: p.format,
    };
  }

  /* صفحهٔ جمع‌کردن باید خارج از پوشش دورانی باشد — برای مقاطع غیر دایره‌ای      */
  /* موادِ در حال چرخش تا قطر محیطی گسترده‌اند، نه فقط قطر واقعی.                */
  const envRot = rotationalEnvelope(p.blankD, p.blankShape);
  const envMaxRotD = envRot.maxRotD;
  /* تا وقتی گوشه‌های مقطع چندضلعی گرد نشده‌اند، همه جابه‌جایی‌ها باید بیرون از */
  /* پوشش دورانی (دورترین گوشه) بمانند — نه فقط بیرون قطر واقعی.               */
  let cornersCleared = !envRot.hasCorners;
  const home = { x: envMaxRotD + 20, z: p.blankL + 10 };
  const retractX = envMaxRotD + 2 * p.safety;
  let cur = { ...home };
  let curOp: OpType | "sys" = "sys";
  let curOpId = -1;
  let curHolder: 1 | 2 = 1;
  let notes: string[] = [];
  const note = (s: string) => notes.push(s);

  const pushSeg = (motion: 0 | 1, x: number, z: number, feed: number, kind: SegKind) => {
    segs.push({
      motion,
      x1: cur.x,
      z1: cur.z,
      x2: x,
      z2: z,
      feed: motion ? feed : RAPID_RATE,
      line: -1,
      kind,
      op: curOp,
      opId: curOpId,
      holder: curHolder,
      note: notes.length ? notes : undefined,
    });
    notes = [];
    cur = { x, z };
  };

  /* حرکت سریعِ امن — هر G0 به‌جای یک مسیر موربِ مستقیم (که می‌تواند از داخل      */
  /* قطعهٔ تراش‌خورده عبور کند و در اجرا باعث برخورد تیغ با طرح شود)، به سه       */
  /* حرکت محوریِ امن تجزیه می‌شود:                                              */
  /*   ۱) جمع‌کردن شعاعی تا فاصلهٔ امن (حرکت به بیرون — همیشه امن)                */
  /*   ۲) جابه‌جایی طولی در فاصلهٔ امن (X=فاصله امن > قطر قطعه)                   */
  /*   ۳) نزدیک‌شدن شعاعی تا نقطهٔ شروع برش (که خارج از قطعه انتخاب می‌شود)        */
  const mv = (motion: 0 | 1, x: number, z: number, feed: number, kind: SegKind) => {
    if (motion === 0) {
      const eps = 1e-9;
      if (cur.x < retractX - eps) pushSeg(0, retractX, cur.z, 0, "rapid");
      if (Math.abs(z - cur.z) > eps) pushSeg(0, Math.max(cur.x, retractX), z, 0, "rapid");
      if (Math.abs(x - cur.x) > eps) pushSeg(0, x, z, 0, "rapid");
      return;
    }
    pushSeg(1, x, z, feed, kind);
  };

  /* حرکت سریعِ مستقیم بدون تجزیهٔ امن — فقط برای جابه‌جایی‌های طولی‌ای استفاده   */
  /* می‌شود که امن‌بودنشان جداگانه با clearLongitudinal اثبات شده است (زیگزاگ)      */
  const rawRapid = (x: number, z: number) => pushSeg(0, x, z, 0, "rapid");

  /* ورود اولیه H2 مبنای واقعی جی‌کد کاسه است: از پایان آخرین عملیات H1 ابتدا
     در +Y تا فاصله امن، سپس در +X تا فاصله تنظیم‌شده جلوتر از شروع، و سرانجام
     در −Y تا محور ورود حرکت می‌کند. بازکُدگذاری cur هنگام تعویض هلدر باعث
     پیوستگی دقیق مختصات ماشین می‌شود و planBridges هیچ حرکت اضافه‌ای نمی‌سازد. */
  let firstInnerEntryDone = false;
  const enterFirstInner = (entryX: number, mouthX: number) => {
    if (firstInnerEntryDone) {
      mv(0, entryX, mouthX, 0, "rapid");
      return;
    }
    const lastHolder = segs.length ? segs[segs.length - 1].holder : 1;
    if (lastHolder === 1) {
      curHolder = 1;
      const safeD = Math.max(retractX, cur.x);
      if (safeD > cur.x + 1e-9) rawRapid(safeD, cur.z); // +Y
      const entryMachineX = mouthX + p.holder2.xOff;
      rawRapid(safeD, entryMachineX); // +X تا صفحه ورود H2
      const safeMachineY = safeD / 2;
      curHolder = 2;
      /* همان نقطه ماشین، این بار در قاب مختصات H2؛ هیچ بلوک حرکتی تولید نمی‌شود. */
      cur = { z: mouthX, x: 2 * (safeMachineY + p.holder2.yOff) };
      rawRapid(entryX, mouthX); // −Y و بلافاصله شروع عملیات
    } else {
      curHolder = 2;
      mv(0, entryX, mouthX, 0, "rapid");
    }
    firstInnerEntryDone = true;
  };
  const z0 = hasOuter ? samples[0].z : 0;
  const zEnd = hasOuter ? samples[samples.length - 1].z : p.blankL;
  const r0 = hasOuter ? samples[0].r : R;

  let minR = Infinity;
  for (const s of samples) if (s.r < minR) minR = s.r;

  /* خط آفست — موازی با خط اصلی طرح در فاصلهٔ offsetDist (مرجع مراحل خشن) */
  const OD = Math.max(0, p.offsetDist);
  const IOD = Math.max(0, p.innerOffsetDist);

  /* آخرین عملیات داخل‌تراشیِ واقعاً قابل اجرا؛ عملیات بی‌اثر (مثلاً کف‌تراشی
     بدون طول اضافه یا آفست صفر) نقطه پایان برنامه محسوب نمی‌شود. */
  const lastRunnableInnerOpId = [...p.ops].reverse().find((o) => {
    if (!o.on) return false;
    if (o.type === "bottom") return hasOuter && p.blankL - zEnd > 0.05;
    if (o.type === "inner-offset") return hasInner && IOD > 0.01;
    return hasInner && (o.type === "inner-rough" || o.type === "inner-finish");
  })?.id;
  let endedAtInnerEndpoint = false;
  const finishLastInner = (opId: number): boolean => {
    if (opId !== lastRunnableInnerOpId) return false;
    note(`FINAL INNER END +X ${f2(p.innerEndTravel)} MM`);
    rawRapid(cur.x, cur.z + p.innerEndTravel);
    endedAtInnerEndpoint = true;
    return true;
  };
  /* خط آفست یکنواخت: آفست نرمال واقعی (نه r+OD شعاعی) + سقف قطر خام */
  const offSamples: Sample[] = normalOffset(samples, OD, true).map((s) => ({ z: s.z, r: Math.min(R, s.r) }));
  const floorR = minR + OD;

  /* ردیابی سطحِ واقعی تراش‌خورده برای محاسبهٔ امنِ جابه‌جایی‌های زیگزاگ — همانند   */
  /* شبیه‌ساز، شعاع باقی‌ماندهٔ قطعه پس از هر برش به‌روز می‌شود تا شعاعِ عبورِ طولی  */
  /* همیشه بالاتر از موادِ موجود باشد.                                             */
  const NG = 600;
  const physR = new Float64Array(NG + 1).fill(envRot.outR);
  const physCut = (a: number, b: number, r: number) => {
    const i0 = Math.max(0, Math.round((Math.min(a, b) / p.blankL) * NG));
    const i1 = Math.min(NG, Math.round((Math.max(a, b) / p.blankL) * NG));
    for (let i = i0; i <= i1; i++) if (r < physR[i]) physR[i] = r;
  };
  const minSafeRadius = (zFrom: number, zTo: number): number => {
    const lo = Math.min(zFrom, zTo);
    const hi = Math.max(zFrom, zTo);
    const i0 = Math.max(0, Math.round((lo / p.blankL) * NG));
    const i1 = Math.min(NG, Math.round((hi / p.blankL) * NG));
    let mx = 0;
    for (let i = i0; i <= i1; i++) if (physR[i] > mx) mx = physR[i];
    return mx + p.safety; // حداقل فاصله امن (پارامتر فاصله امن) بالای مواد
  };

  const radiusAt = (z: number): number => {
    if (z <= samples[0].z) return samples[0].r;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].z >= z) {
        const a = samples[i - 1];
        const b = samples[i];
        const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
        return a.r + (b.r - a.r) * t;
      }
    }
    return samples[samples.length - 1].r;
  };

  /* شعاع خط آفست (پروفایل + اضافه پرداخت) در هر z — مواد زیر این خط نباید خشن شوند */
  const offsetRadiusAt = (z: number): number => {
    if (z <= offSamples[0].z) return offSamples[0].r;
    for (let i = 1; i < offSamples.length; i++) {
      if (offSamples[i].z >= z) {
        const a = offSamples[i - 1];
        const b = offSamples[i];
        const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
        return a.r + (b.r - a.r) * t;
      }
    }
    return offSamples[offSamples.length - 1].r;
  };

  /* ایمنی اتصال مورب (Ramp): خط مستقیم از (fromR,fromZ) به (toR,toZ) فقط وقتی       */
  /* مجاز است که در تمام طولش بالاتر از خط آفست بماند؛ در غیر این صورت با منحنی     */
  /* اصلی تداخل کرده و آن را می‌تراشد — پس باید به مسیر امن G0 بازگشت.             */
  const rampIsSafe = (fromZ: number, fromR: number, toZ: number, toR: number): boolean => {
    const loZ = Math.min(fromZ, toZ);
    const hiZ = Math.max(fromZ, toZ);
    const steps = Math.max(8, Math.ceil(Math.abs(hiZ - loZ) / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const z = fromZ + (toZ - fromZ) * t;
      const r = fromR + (toR - fromR) * t;
      if (z < offSamples[0].z - 0.01 || z > offSamples[offSamples.length - 1].z + 0.01) continue;
      if (r < offsetRadiusAt(z) - 0.05) return false;
    }
    return true;
  };

  const profilePath = (kind: SegKind, feed: number) => {
    mv(1, 2 * r0, z0, feed, kind);
    for (let i = 1; i < samples.length; i++) mv(1, 2 * samples[i].r, samples[i].z, feed, kind);
  };

  /* اجرای زنجیره عملیات (استراتژی تراش) */
  let innerCleared = false; // آیا حفره داخل با خشن‌کاری خالی شده است؟
  for (const op of p.ops) {
    if (!op.on) continue;
    curOpId = op.id;
    curHolder = op.holder;
    switch (op.type) {
      /* گرد کردن گوشه‌ها — برای مقاطع غیر دایره‌ای: برداشت قسمت اضافی از        */
      /* شعاع محیطی (دورترین گوشه) تا شعاع محاطی (قطر واقعی) تا مقطع دایره‌ای شود. */
      /* برای مقطع دایره‌ای این عملیات بی‌اثر است.                                */
      case "round": {
        curOp = "round";
        const envr = rotationalEnvelope(p.blankD, p.blankShape);
        if (envr.hasCorners && envr.outR > R + 0.02) {
          const shName = BLANK_SHAPES.find((b) => b.id === p.blankShape)?.name ?? p.blankShape;
          note(`ROUNDING CORNERS - ${f2(2 * envr.outR)} TO ${f2(2 * R)} (ZIGZAG)`);
          /* گرد کردنِ رفت‌وبرگشتی: جهت تراش در هر لایه معکوس می‌شود و ابزار     */
          /* به‌جای جمع‌کردن و بازگشت به نقطه شروع، فقط با یک فرورفتن شعاعی در     */
          /* انتهای همان مسیر، لایه بعد را در جهت مخالف ادامه می‌دهد.             */
          const roundLayers: number[] = [];
          let layer = envr.outR - p.doc;
          let guard = 0;
          while (layer > R + 1e-6 && guard < 40) {
            roundLayers.push(layer);
            layer -= p.doc;
            guard++;
          }
          roundLayers.push(R); // لایه پایانی دقیقاً روی قطر واقعی

          let dir: 1 | -1 = 1;
          let atZ = 0;
          for (let i = 0; i < roundLayers.length; i++) {
            const r = roundLayers[i];
            const startZ = dir === 1 ? 0 : p.blankL;
            const endZ = dir === 1 ? p.blankL : 0;
            note(`ROUND LAYER X${f2(r)}${dir === -1 ? " (RETURN)" : ""}`);
            if (i === 0) mv(0, retractX, startZ, 0, "rapid"); // موقعیت‌یابی امن اولیه
            mv(1, 2 * r, startZ, p.feedRough * 0.7, "round"); // فرورفتن شعاعی
            if (Math.abs(endZ - startZ) > 0.01) mv(1, 2 * r, endZ, p.feedRough, "round"); // تراش طولی
            atZ = endZ;
            dir = dir === 1 ? -1 : 1;
          }
          cornersCleared = true;
          physR.fill(R); // گوشه‌ها برداشته شد — سطح مبنا از این پس قطر واقعی است
          note(`ROUND DONE AT X${f2(R)} (${shName})`);
          mv(0, retractX, atZ, 0, "rapid"); // جمع‌کردن پایانی
        }
        break;
      }
      /* پیشانی‌تراشی */
      case "face": {
        curOp = "face";
        if (!hasOuter) break;
        if (R - r0 > 0.05) {
          note("FACING");
          /* نزدیک‌شدن در ارتفاع امن (بیرون پوشش دورانی + فاصله امن)، سپس فرورفتن با فیدر */
          mv(0, retractX, z0, 0, "face");
          mv(1, 2 * r0, z0, p.feedRough * 0.8, "face");
          mv(0, retractX, z0, 0, "rapid");
        }
        break;
      }
      /* کف‌تراشی — برداشت طول اضافی خام پشت صفحه دهانه (بین انتهای طرح و
         انتهای خام) با هلدر داخل‌تراشی؛ اگر خام بلندتر از طرح نباشد بی‌اثر
         است. هر گذر یک صفحه کامل از بیرون قطر تا نزدیک مرکز می‌تراشد. */
      case "bottom": {
        curOp = "bottom";
        if (!hasOuter) break;
        const excess = p.blankL - zEnd;
        if (excess > 0.05) {
          note(`BOTTOM FACING - EXCESS ${f2(excess)} (HOLDER ${op.holder})`);
          /* شروع بیرون پوشش دورانی (اگر گوشه‌ها هنوز گرد نشده‌اند) وگرنه بیرون قطر خام */
          const xStart = cornersCleared ? 2 * (R + p.safety) : 2 * (envRot.outR + p.safety);
          const xEnd = 1.2; // تا نزدیک مرکز (مثل ورود بور)
          const N = Math.max(1, Math.ceil(excess / p.doc - 1e-9));
          const firstBottomZ = N === 1 ? zEnd : p.blankL - p.doc;
          /* اگر کف‌تراشی وجود دارد، همین نقطه مبنای فاصله شروع داخل‌تراشی است. */
          enterFirstInner(xStart, firstBottomZ + p.innerStartClearance);
          for (let k = 1; k <= N; k++) {
            const zk = k === N ? zEnd : p.blankL - k * p.doc;
            if (k === 1) {
              /* حرکت فیدر از فاصله شروع تا صفحه نخست، خودِ آغاز عملیات است. */
              if (Math.abs(p.innerStartClearance) > 1e-9) mv(1, xStart, zk, p.feedRough * 0.8, "bottom");
            } else {
              mv(0, xStart, zk, 0, "rapid"); // موقعیت‌یابی امن در سطح بعد
            }
            mv(1, xEnd, zk, p.feedRough * 0.8, "bottom"); // کف‌تراشی تا مرکز
          }
          if (!finishLastInner(op.id)) mv(0, retractX, zEnd, 0, "rapid"); // جمع‌کردن پایانی
          physCut(zEnd, p.blankL, 0); // طول اضافی کاملاً برداشته شد
        }
        break;
      }
      /* خشن شعاعی — لایه‌های قطری با حرکت طولی (G71)                            */
      /* حالت رفت‌وبرگشتی (زیگزاگ): جهت تراش در هر برش معکوس می‌شود و ابزار پس از  */
      /* پایان یک مسیر، به‌جای جمع‌کردن کامل و بازگشت به نقطه شروع، با حداقل       */
      /* جابه‌جاییِ امنِ شعاعی (فقط تا بالای موادِ موجود) مستقیماً از انتهای همان    */
      /* مسیر، مسیر بعدی را در جهت مخالف ادامه می‌دهد.                              */
      case "rough-d": {
        curOp = "rough-d";
        if (!hasOuter) break;

        /* ------------------------------------------------------------------ */
        /* حالت رفت‌وبرگشتی (زیگزاگ) — مارپیچ دنبال‌کنندهٔ منحنی، فقط بازه‌های فعال:  */
        /* در هر گذر j فقط بازه‌هایی طی می‌شوند که هنوز به برش نیاز دارند (جایی که  */
        /* پروفایل+آفست از لایهٔ قبل پایین‌تر است)؛ نواحیِ تمام‌شده دوباره تراش      */
        /* نمی‌خورند. گذرِ رفت در یک جهت و گذرِ برگشت در جهت مخالف، هر دو باربرداری  */
        /* می‌کنند. درون هر بازه ابزار منحنی  C(z)=max(پروفایل+آفست، شعاع‌لایه) را   */
        /* دنبال می‌کند (نرم از روی قله و دره) و برای ردشدن از ناحیهٔ تمام‌شدهٔ بین */
        /* دو بازه، یک عبور امنِ کوتاه کمی بالاتر از پروفایل انجام می‌شود. چون هر   */
        /* گذر فقط به عمق «doc» برش می‌زند، نیروی برش پخش شده و برای چوب شکننده امن */
        /* است و از رفت‌وآمد تکراری روی نواحی تمام‌شده جلوگیری می‌شود.             */
        /* ------------------------------------------------------------------ */
        if (p.roughMode === "zigzag") {
          note("ROUGHING - CONTOUR SERPENTINE (ACTIVE REGIONS, CUTS BOTH WAYS)");
          const F = offSamples;
          let minF = Infinity;
          for (const s of F) if (s.r < minF) minF = s.r;
          const totalDepth = R - minF;
          if (totalDepth > 0.02) {
            const N = Math.max(1, Math.ceil(totalDepth / p.doc - 1e-9));
            /* بیشینهٔ پروفایل آفست در یک بازهٔ طولی — برای عبور امن از ناحیهٔ تمام‌شده */
            const maxFIn = (a: number, b: number) => {
              let mx = -Infinity;
              for (const s of F) if (s.z >= a - 0.01 && s.z <= b + 0.01 && s.r > mx) mx = s.r;
              return mx === -Infinity ? minF : mx;
            };
            /* جهت شروع: نزدیک‌تر به موقعیت فعلی ابزار (مثلاً پایان گرد کردن) */
            let forward = Math.abs(z0 - cur.z) <= Math.abs(zEnd - cur.z);
            let first = true;
            let lastEndZ = NaN;
            let lastEndR = 0;
            for (let j = 1; j <= N; j++) {
              const prevLayer = R - (j - 1) * p.doc;
              const layer = R - j * p.doc;
              /* بازه‌های فعال این گذر: جایی که هنوز به برش نیاز است */
              const activeRaw = cutIntervals(F, prevLayer);
              if (!activeRaw.length) break;
              note(`SERPENTINE PASS ${j}/${N} - X${f2(layer)}${forward ? "" : " (RETURN)"}`);
              /* گذرِ رفت چپ→راست و گذرِ برگشت راست→چپ؛ بازه‌ها هم در همان جهت طی می‌شوند */
              const active = forward ? activeRaw : [...activeRaw].reverse();
              for (const iv of active) {
                const startZ = forward ? iv.a : iv.b;
                const endZ = forward ? iv.b : iv.a;
                if (first) {
                  mv(0, retractX, startZ, 0, "rapid"); // موقعیت‌یابی اولیه
                  first = false;
                } else {
                  /* عبور امن از ناحیهٔ تمام‌شدهٔ بین دو بازه — با حداقل فاصله امن (+Y)   */
                  /* بالای خط آفست؛ اگر گوشه‌ها هنوز گرد نشده‌اند، بیرون پوشش دورانی. */
                  const loZ = Math.min(lastEndZ, startZ);
                  const hiZ = Math.max(lastEndZ, startZ);
                  const clearR = Math.max(maxFIn(loZ, hiZ) + p.safety, cornersCleared ? 0 : envRot.outR + p.safety);
                  const travelR = Math.max(lastEndR, clearR);
                  if (travelR > lastEndR + 1e-6) rawRapid(2 * travelR, lastEndZ);
                  rawRapid(2 * travelR, startZ);
                }
                /* فرورفتن تا منحنی لایه در نقطهٔ ورود و دنبال‌کردن منحنی درون بازه */
                const cStart = Math.max(offsetRadiusAt(startZ), layer);
                mv(1, 2 * cStart, startZ, p.feedRough * 0.7, "rough");
                const lo = Math.min(startZ, endZ);
                const hi = Math.max(startZ, endZ);
                const ptsIn = F.filter((s) => s.z > lo + 1e-6 && s.z < hi - 1e-6);
                const ordered = forward ? ptsIn : [...ptsIn].reverse();
                for (const s of ordered) mv(1, 2 * Math.max(s.r, layer), s.z, p.feedRough, "rough");
                const cEnd = Math.max(offsetRadiusAt(endZ), layer);
                if (Math.abs(endZ - startZ) > 0.01) mv(1, 2 * cEnd, endZ, p.feedRough, "rough");
                lastEndZ = endZ;
                lastEndR = cEnd;
              }
              forward = !forward; // گذر بعد در جهت مخالف
            }
            if (!Number.isNaN(lastEndZ)) mv(0, retractX, lastEndZ, 0, "rapid"); // جمع‌کردن پایانی
          }
          break;
        }

        note(
          p.roughMode === "zone"
            ? "ROUGHING - RADIAL LAYERS (BY ZONE)"
            : "ROUGHING - RADIAL LAYERS"
        );
        if (p.ramp) note("CONTINUOUS RAMP LINKS - NO G0 BETWEEN PASSES");

        /* فهرست برش‌ها — به ترتیب لایه (کلاسیک) یا به ترتیب ناحیه (ناحیه‌ای:      */
        /* همهٔ لایه‌های ناحیهٔ اول، سپس همهٔ لایه‌های ناحیهٔ دوم و …)                  */
        const cuts: { a: number; b: number; r: number }[] = [];
        if (p.roughMode === "zone") {
          /* نواحی: مرزهای دستی کاربر (در صورت اعتبار) جایگزین تقسیم خودکار می‌شوند؛ */
          /* سپس ترتیب دستی (در صورت اعتبار) روی همان نواحی اعمال می‌شود.            */
          let zones = resolveZones(offSamples, p.zoneBounds, z0, zEnd);
          const ord = p.zoneOrder;
          const isPerm =
            ord.length === zones.length &&
            ord.every((v) => v >= 0 && v < zones.length) &&
            new Set(ord).size === zones.length;
          if (isPerm) {
            zones = ord.map((i) => zones[i]);
          } else {
            /* بهینه‌سازی شروع: اگر ترتیب دستی تعیین نشده باشد، نواحی از سمتی       */
            /* پردازش می‌شوند که ابزار اکنون در آن‌جاست (مثلاً بعد از گرد کردن       */
            /* گوشه‌ها که ابزار در انتهای همان مسیر ایستاده) — نه همیشه از چپ.     */
            const mid = (z0 + zEnd) / 2;
            if (cur.z > mid) zones = [...zones].reverse();
          }
          for (const zone of zones) {
            let layer = R - p.doc;
            let guard = 0;
            while (layer > floorR + 1e-6 && guard < 80) {
              guard++;
              for (const iv of cutIntervals(offSamples, layer)) {
                const a = Math.max(iv.a, zone.a);
                const b = Math.min(iv.b, zone.b);
                if (b - a > 0.3) cuts.push({ a, b, r: layer });
              }
              layer -= p.doc;
            }
          }
        } else {
          let layer = R - p.doc;
          let guard = 0;
          while (layer > floorR + 1e-6 && guard < 80) {
            guard++;
            for (const iv of cutIntervals(offSamples, layer)) cuts.push({ a: iv.a, b: iv.b, r: layer });
            layer -= p.doc;
          }
        }

        if (p.roughMode === "classic") {
          /* روش کلاسیکِ یک‌طرفه */
          let nL = 0;
          let lastR = NaN;
          for (const c of cuts) {
            if (c.r !== lastR) {
              nL++;
              note(`LAYER ${nL} - X${f2(c.r)}`);
              lastR = c.r;
            }
            mv(0, retractX, c.a, 0, "rapid");
            mv(1, 2 * c.r, c.a, p.feedRough * 0.7, "rough");
            if (c.b - c.a > 0.01) mv(1, 2 * c.r, c.b, p.feedRough, "rough");
            mv(0, retractX, c.b, 0, "rapid");
          }
          break;
        }

        /* روش رفت‌وبرگشتی با انتخاب حریصانهٔ نزدیک‌ترین نقطهٔ ورود — ابزار همیشه   */
        /* از نزدیک‌ترین انتهای مسیرِ بعدی وارد می‌شود تا جابه‌جاییِ طولی حداقل شود  */
        /* و بدون بازگشت به نقطه شروع، مسیرها به‌صورت مارپیچ طی شوند.               */
        let curZ = NaN; // موقعیت طولی فعلی ابزار
        let curR = 0; // شعاع فعلی ابزار
        let nL = 0;
        let lastR = NaN;
        for (const c of cuts) {
          if (c.r !== lastR) {
            nL++;
            note(`LAYER ${nL} - X${f2(c.r)}`);
            lastR = c.r;
          }
          /* نزدیک‌ترین نقطهٔ ورود به مکان فعلی ابزار — برای اولین برش، موقعیت      */
          /* واقعی ابزار (cur.z) مرجع است؛ اگر عملیات قبلی (مثل گرد کردن گوشه‌ها)   */
          /* ابزار را در انتهای خاصی رها کرده باشد، از همان‌جا ادامه می‌یابد و به   */
          /* نقطهٔ خانه بازنمی‌گردد. در ابتدای برنامه cur همان نقطهٔ خانه است.      */
          const refZ = Number.isNaN(curZ) ? cur.z : curZ;
          const startZ = Math.abs(c.a - refZ) <= Math.abs(c.b - refZ) ? c.a : c.b;
          const endZ = startZ === c.a ? c.b : c.a;

          /* ایمنی اتصال مورب: اگر خط مستقیمِ بین انتهای مسیر قبل و ابتدای خط بعد   */
          /* با خط آفست (و در نتیجه منحنی اصلی) تداخل داشته باشد، اتصال پیوسته      */
          /* لغو و از مسیر امن G0 استفاده می‌شود تا شکل اصلی تراشیده نشود.          */
          const rampOk = p.ramp && rampIsSafe(curZ, curR, startZ, c.r);
          if (Number.isNaN(curZ)) {
            /* اولین برش — جابه‌جایی امن از موقعیت فعلی (خانه یا پایان عملیات قبل) */
            mv(0, retractX, startZ, 0, "rapid");
          } else if (!rampOk) {
            /* جابه‌جایی امن: شعاع عبور با حداقل فاصله امن بالای تمام موادِ مسیر است */
            const safeR = minSafeRadius(curZ, startZ);
            const travelR = Math.max(curR, safeR);
            if (travelR > curR + 1e-6) rawRapid(2 * travelR, curZ); // جمع شعاعیِ جزئی (در صورت نیاز)
            rawRapid(2 * travelR, startZ); // جابه‌جایی طولیِ امن — بدون بازگشت به شروع
          }
          /* در حالت اتصال پیوستهٔ امن (rampOk) هیچ G0 در میان نیست؛ حرکت برشیِ زیر */
          /* مستقیماً و به‌صورت مورب (Ramp) ابزار را از انتهای مسیر قبل به ابتدای   */
          /* خط بعد می‌رساند و سپس تراش طولی ادامه می‌یابد.                        */

          /* فرورفتن تا شعاع لایه و تراش طولی */
          mv(1, 2 * c.r, startZ, p.feedRough * 0.7, "rough");
          if (Math.abs(endZ - startZ) > 0.01) mv(1, 2 * c.r, endZ, p.feedRough, "rough");
          physCut(c.a, c.b, c.r); // به‌روزرسانی سطح تراش‌خورده

          curZ = endZ;
          curR = c.r;
        }
        if (!Number.isNaN(curZ)) mv(0, retractX, curZ, 0, "rapid"); // جمع‌کردن پایانی
        break;
      }
      /* خشن محوری — فرورفتن شعاعی در گام‌های طولی (G72) */
      case "rough-z": {
        curOp = "rough-z";
        if (!hasOuter) break;
        note("ROUGHING - AXIAL PEEL");
        const stepZ = Math.max(0.5, p.doc);
        let nP = 0;
        for (let z = z0; z <= zEnd + 1e-6; z += stepZ) {
          const target = offsetRadiusAt(z);
          if (target < R - 0.02) {
            if (nP === 0) note(`AXIAL STEP ${f2(stepZ)} MM`);
            nP++;
            mv(0, retractX, z, 0, "rapid");
            mv(1, 2 * target, z, p.feedRough * 0.8, "roughz");
            mv(0, retractX, z, 0, "rapid");
          }
        }
        break;
      }
      /* کپی‌تراشی — مسیرهای موازی با خط طرح */
      case "copy": {
        curOp = "copy";
        if (!hasOuter) break;
        note("ROUGHING - CONTOUR PARALLELS");
        const kMax = Math.floor((R - floorR - 1e-6) / p.doc);
        for (let k = kMax; k >= 1; k--) {
          const d = OD + k * p.doc;
          const ivs = cutIntervals(samples, R - d);
          if (!ivs.length) continue;
          note(`CONTOUR +${f2(d)} MM`);
          for (const iv of ivs) {
            const span = samples.filter((s) => s.z >= iv.a - 1e-6 && s.z <= iv.b + 1e-6);
            if (span.length < 2) continue;
            const stride = Math.max(1, Math.floor(span.length / 42));
            const pts = span.filter((_, i) => i % stride === 0 || i === span.length - 1);
            mv(0, retractX, pts[0].z, 0, "rapid");
            mv(1, 2 * (pts[0].r + d), pts[0].z, p.feedRough * 0.7, "copy");
            for (let i = 1; i < pts.length; i++) mv(1, 2 * (pts[i].r + d), pts[i].z, p.feedRough, "copy");
            mv(0, retractX, pts[pts.length - 1].z, 0, "rapid");
          }
        }
        break;
      }
      /* خشن داخل کاسه — خالی‌کردن پلکانی از دهانه به سمت کف                   */
      /* هر گذر: فرورفتن محوری کوتاه در مرکز + روتراشی تا دیواره داخلی. این       */
      /* عملیات با هلدر دوم اجرا می‌شود و مختصات آن در پس‌پردازنده با درنظرگرفتن */
      /* چرخش ‎−۹۰°‎ و آفست‌های هلدر دوم تبدیل می‌شود.                           */
      case "inner-rough": {
        curOp = "inner-rough";
        if (!hasInner) break;
        note(`INNER ROUGH - BOWL HOLLOWING (HOLDER ${op.holder})`);
        const IW = innerSamples;
        const zBot = IW[0].z;
        const zRim = IW[IW.length - 1].z;
        /* خط آفست یکنواخت داخل: آفست نرمال به سمت حفره (نه wallIn−OD شعاعی) */
        const innerOff = normalOffset(IW, IOD, false);
        const wallInOff = (z: number): number => {
          if (z <= innerOff[0].z) return innerOff[0].r;
          for (let i = 1; i < innerOff.length; i++) {
            if (innerOff[i].z >= z) {
              const a = innerOff[i - 1];
              const b = innerOff[i];
              const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
              return a.r + (b.r - a.r) * t;
            }
          }
          return innerOff[innerOff.length - 1].r;
        };
        const step = Math.max(0.5, p.doc);
        const depths: number[] = [];
        for (let z = zRim; z > zBot + 0.05; z -= step) depths.push(z);
        depths.push(zBot);
        note(`INNER DEPTHS ${depths.length} x ${f2(step)} MM`);
        const rEntry = 0.6; // ورود در امتداد محور
        /* نقطه ورود به‌اندازه فاصله تنظیم‌شده جلوتر (+X) از شروع اولین عملیات داخل‌تراشی است.
           mv پیش از آن ابتدا +Y تا صفحه امن، سپس +X و در پایان −Y را می‌سازد. */
        const mouthX = zRim + p.innerStartClearance;
        innerCleared = true;
        depths.forEach((zk, k) => {
          const target = Math.max(0.8, wallInOff(zk));
          if (k === 0) {
            enterFirstInner(2 * rEntry, mouthX); // ورود از دهانه
            mv(1, 2 * rEntry, zk, p.feedRough * 0.8, "bore"); // نشست روی صفحه دهانه
          } else {
            rawRapid(2 * rEntry, depths[k - 1]); // بازگشت شعاعی در فضای خالی‌شده
            rawRapid(2 * rEntry, mouthX); // خروج محوری به بیرون خط داخلی (+X امن)
            mv(1, 2 * rEntry, zk, p.feedRough * 0.7, "bore"); // فرورفتن با فیدر تا عمق بعد
          }
          if (target > rEntry + 0.05) mv(1, 2 * target, zk, p.feedRough, "bore"); // روتراشی تا دیواره
        });
        /* اگر این آخرین عملیات داخل است، بدون هیچ حرکت واسط مستقیماً +X می‌رود. */
        if (!finishLastInner(op.id)) {
          rawRapid(2 * rEntry, depths[depths.length - 1]);
          rawRapid(2 * rEntry, mouthX);
          mv(0, retractX, mouthX, 0, "rapid");
        }
        break;
      }
      /* آفست داخل‌تراشی — پاس خط‌چینِ موازی دیواره، بین خشن و پرداخت داخل */
      case "inner-offset": {
        curOp = "inner-offset";
        if (!hasInner || IOD <= 0.01) break;
        note(`INNER OFFSET PASS ${f2(IOD)} MM (HOLDER ${op.holder})`);
        const IW = innerSamples;
        const innerOff = normalOffset(IW, IOD, false);
        if (innerOff.length < 2) break;
        const zBot = innerOff[0].z;
        const zRimF = innerOff[innerOff.length - 1].z;
        const rEntry = 0.6;
        const mouthX = zRimF + p.innerStartClearance;
        enterFirstInner(2 * rEntry, mouthX);
        if (innerCleared) rawRapid(2 * rEntry, zBot);
        else mv(1, 2 * rEntry, zBot, p.feedRough * 0.6, "boreoff");
        mv(1, 2 * innerOff[0].r, innerOff[0].z, p.feedFinish, "boreoff");
        for (let i = 1; i < innerOff.length; i++) {
          mv(1, 2 * innerOff[i].r, innerOff[i].z, p.feedFinish, "boreoff");
        }
        if (!finishLastInner(op.id)) {
          if (innerCleared) {
            rawRapid(2 * rEntry, zRimF);
            rawRapid(2 * rEntry, mouthX);
          } else {
            for (let i = innerOff.length - 2; i >= 0; i--) {
              mv(1, 2 * innerOff[i].r, innerOff[i].z, p.feedFinish, "boreoff");
            }
            mv(1, 2 * rEntry, zBot, p.feedFinish, "boreoff");
            mv(1, 2 * rEntry, mouthX, p.feedRough * 0.6, "boreoff");
          }
          mv(0, retractX, mouthX, 0, "rapid");
        }
        break;
      }
      /* پرداخت داخل — دنبال‌کردن دیواره داخلی از کف تا دهانه با هلدر دوم */
      case "inner-finish": {
        curOp = "inner-finish";
        if (!hasInner) break;
        note(`INNER FINISH - BOWL WALL (HOLDER ${op.holder})`);
        const IW = innerSamples;
        const zBot = IW[0].z;
        const zRimF = IW[IW.length - 1].z;
        const rEntry = 0.6;
        /* ورود از صفحه امن، به‌اندازه فاصله تنظیم‌شده جلوتر از شروع مسیر داخل‌تراشی */
        const mouthX = zRimF + p.innerStartClearance;
        enterFirstInner(2 * rEntry, mouthX); // پشت دهانه، بیرون خط داخلی
        if (innerCleared) rawRapid(2 * rEntry, zBot); // حفره خالی است — ورود سریع
        else mv(1, 2 * rEntry, zBot, p.feedRough * 0.6, "borefin"); // بدون خشن‌کاری: ورود با فیدر
        for (let i = 0; i < IW.length; i++) mv(1, 2 * IW[i].r, IW[i].z, p.feedFinish, "borefin");
        if (!finishLastInner(op.id)) {
          if (innerCleared) {
            /* خروج سریع از حفره خالی: شعاعی به مرکز، سپس محوری به بیرون خط داخلی */
            rawRapid(2 * rEntry, zRimF);
            rawRapid(2 * rEntry, mouthX);
          } else {
            /* بدون خشن‌کاری حفره پر است: بازگشت با فیدر در شیار برش تا کف، سپس خروج */
            for (let i = IW.length - 2; i >= 0; i--) mv(1, 2 * IW[i].r, IW[i].z, p.feedFinish, "borefin");
            mv(1, 2 * rEntry, zBot, p.feedFinish, "borefin");
            mv(1, 2 * rEntry, mouthX, p.feedRough * 0.6, "borefin");
          }
          mv(0, retractX, mouthX, 0, "rapid");
        }
        break;
      }
      /* پرداخت نهایی روی خط اصلی طرح */
      case "finish": {
        curOp = "finish";
        if (!hasOuter) break;
        note("FINISHING - MAIN PROFILE");
        /* ورود کوتاه: سریع تا بالای نقطه شروع (جلوتر از صفحه پیشانی، بیرون از
           خط آفست با فاصله امن کامل)، سپس فرورفتن مورب کوتاه با فیدر.
           با گسترش G0 صفحه ورود ۳mm جلوتر است تا روی ورود آفست نیفتد. */
        {
          const apX = Math.min(z0 + p.safety + (p.spreadG0 ? 3 : 0), zEnd);
          const apR = Math.max(r0, radiusAt(apX)) + OD + p.safety;
          mv(0, 2 * apR, apX, 0, "rapid");
        }
        profilePath("finish", p.feedFinish);
        break;
      }
      /* آفست — خط موازی با طرح؛ مرجع مراحل خشن و نیمه‌پرداخت قبل از پرداخت */
      case "offset": {
        curOp = "offset";
        if (!hasOuter) break;
        if (OD > 0.01) {
          note(`OFFSET PASS +${f2(OD)} MM (PARALLEL TO PROFILE)`);
          /* ورود کوتاه: سریع تا بالای نقطه شروع (جلوتر از صفحه پیشانی)، سپس
             فرورفتن مورب کوتاه با فیدر — بدون فیدر طولانی روی صفحه تراش‌خورده */
          {
            const apX = Math.min(z0 + p.safety, zEnd);
            const apR = Math.max(offSamples[0].r, offsetRadiusAt(apX)) + p.safety;
            mv(0, 2 * apR, apX, 0, "rapid");
          }
          mv(1, 2 * offSamples[0].r, offSamples[0].z, p.feedFinish, "offset");
          for (let i = 1; i < offSamples.length; i++) mv(1, 2 * offSamples[i].r, offSamples[i].z, p.feedFinish, "offset");
          mv(0, retractX, zEnd, 0, "rapid");
        }
        break;
      }
    }
  }

  /* پایان: پس از پایان مستقیم عملیات داخلی، هیچ جابه‌جایی دیگری مجاز نیست. */
  curOp = "sys";
  curOpId = -1;
  if (!endedAtInnerEndpoint) {
    curHolder = 1;
    note("END OF PROGRAM");
    mv(0, retractX, p.blankL + 2 * p.safety, 0, "rapid");
    mv(0, home.x, home.z, 0, "rapid");
  }

  /* گسترش G0 در جی‌کد (همه‌جهته): حرکت‌های سریعِ طولیِ روی‌هم با گام ۳mm فقط
     به سمت بیرون (+قطر، ‎(k+1)*3‎، سقف ۳۳) باز می‌شوند تا در سیمکو هیچ دو خط
     G0 روی هم نیفتد؛ H1 همه، H2 فقط بیرون قطعه (در/بالای رترکت پست‌شده).
     فقط گروه‌های چندعضوی باز می‌شوند (تک‌خط‌ها سر جای واقعی می‌مانند).
     فیدرها، حرکات شعاعی/مورب، پله‌های پل و حرکات داخل حفره دست‌نخورده‌اند. */
  if (p.spreadG0) {
    const groups = new Map<string, number[]>();
    segs.forEach((s, i) => {
      if (s.motion !== 0) return;
      const a = machineUV(s.z1, s.x1, s.holder, p);
      const b = machineUV(s.z2, s.x2, s.holder, p);
      if (Math.hypot(b.u - a.u, b.v - a.v) < 1e-9) return; // صفر
      if (Math.abs(b.u - a.u) < 1e-9) return; // شعاعی/مورب: نه
      if (Math.abs(b.v - a.v) >= 1e-9) return; // فقط طولیِ محوری
      if (s.holder === 2 && a.v < retractX - p.holder2.yOff - 1e-9) return; // حفره: نه
      const key = b.v.toFixed(2);
      const arr = groups.get(key);
      if (arr) arr.push(i);
      else groups.set(key, [i]);
    });
    for (const arr of groups.values()) {
      if (arr.length < 2) {
        /* تک‌خط: ۳ واحد بیرون‌تر تا پله‌های ورود/خروج آن مورب شوند و روی هم
           نیفتند؛ کریدور دهانه حفره (تنها گذر امن) دست‌نخورده می‌ماند */
        if (arr.length === 1) {
          const sg = segs[arr[0]];
          const pa = machineUV(sg.z1, sg.x1, sg.holder, p);
          const funnelV = 1.2 - (sg.holder === 2 ? p.holder2.yOff : 0);
          if (Math.abs(pa.v - funnelV) >= 1.0) sg.fan = 3;
        }
        continue;
      }
      arr.forEach((si, k) => {
        segs[si].fan = Math.min((k + 1) * 3, 33);
      });
    }
    /* رانش داخل‌خط تراورس‌ها حذف شد (v2c): پله‌های ورود/خروج صاف و عمودی
       می‌مانند (درخواست کاربر)؛ پیشوندهای هم‌نقطه‌ شروع عملاً تک‌خط دیده
       می‌شوند و در داور معاف‌اند. fanU فقط برای شعاعی‌های بیرون قطعه است. */
    /* گسترش شعاعی‌های بیرون قطعه در راستای محور: ورود/خروج‌های روی‌هم‌خط
       (دهانه، صفحه پیشانی) با رتبه سراسری (k+1)*3 جابه‌جا می‌شوند تا هیچ دو
       خط اجراشده‌ای هم‌خط نماند (مرتب‌صعودی = خروجی اکیداً صعودی)؛
       شعاعی‌های داخل قطعه (پاس‌های خشنه، حفره) دست‌نخورده‌اند */
    const rad: { i: number; u: number }[] = [];
    segs.forEach((sg, i) => {
      if (sg.motion !== 0 || sg.fanU) return;
      const a = machineUV(sg.z1, sg.x1, sg.holder, p);
      const b = machineUV(sg.z2, sg.x2, sg.holder, p);
      if (Math.hypot(b.u - a.u, b.v - a.v) < 1e-9) return;
      if (Math.abs(b.u - a.u) >= 1e-9) return;
      const faceU = p.blankL + (sg.holder === 2 ? p.holder2.xOff : 0);
      if (a.u < faceU - 1e-9) return;
      /* استثنای پله ورود/خروج (درخواست کاربر): شعاعیِ زنجیره ورود/خروج
         (فیدر در فاصله ≤۲ سگمنت: پلانج/رترکت مستقیم یا کریدور دهانه پشت
         فانل) و حرکات sys دقیقاً مثل قبل (TRUE) می‌مانند تا پله‌ها محوری
         باشند؛ روی‌هم‌افتادن‌شان پذیرفته است */
      if (sg.op === "sys") return;
      for (let j = Math.max(0, i - 2); j <= Math.min(segs.length - 1, i + 2); j++) {
        if (segs[j].motion === 1) return;
      }
      /* شعاعیِ چسبیده به تراورسِ گسترش‌یافته هم معاف است، وگرنه پله ورود/خروج
         هم‌زمان Δu و Δv می‌گیرد و در CIMCO مورب دیده می‌شود (تراورس‌ها در پاس
         قبلی fan گرفته‌اند پس این آزمون نهایی است) */
      const nbFan = (j: number) => j >= 0 && j < segs.length && segs[j].motion === 0 && (segs[j].fan ?? 0) !== 0;
      if (nbFan(i - 1) || nbFan(i + 1)) return;
      rad.push({ i, u: a.u });
    });
    rad.sort((p2, q) => p2.u - q.u || p2.i - q.i);
    rad.forEach((e, k) => {
      segs[e.i].fanU = (k + 1) * 3;
    });
  }

  /* کلید پایدار هر خط (برای ویرایش مسیر): عملیات:شماره در آن عملیات */
  {
    const ctr = new Map<string, number>();
    for (const sg of segs) {
      const kk = sg.opId < 0 ? "sys" : String(sg.opId);
      const n = ctr.get(kk) ?? 0;
      ctr.set(kk, n + 1);
      sg.ovrKey = `${kk}:${n}`;
    }
  }

  /* قالب‌بندی خروجی بر اساس سبک انتخابی */
  const lines = p.format === "modal" ? buildModalLines(segs, p) : buildStdLines(segs, p);

  /* آمار */
  let cutLen = 0;
  let rapidLen = 0;
  let timeSec = 0;
  for (const s of segs) {
    const d = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    if (s.motion === 1) {
      cutLen += d;
      timeSec += (d / Math.max(1, s.feed)) * 60;
    } else {
      rapidLen += d;
      timeSec += (d / RAPID_RATE) * 60;
    }
  }
  let vol = 0;
  for (let i = 1; i < samples.length; i++) {
    const dz = samples[i].z - samples[i - 1].z;
    const rAvg = (samples[i].r + samples[i - 1].r) / 2;
    vol += Math.PI * (R * R - rAvg * rAvg) * dz;
  }
  /* حجم گوشه‌های برداشته‌شده برای مقاطع غیر دایره‌ای (بین شعاع محیطی و محاطی) */
  const envVol = rotationalEnvelope(p.blankD, p.blankShape);
  if (envVol.hasCorners && envVol.outR > R) {
    vol += Math.PI * (envVol.outR * envVol.outR - R * R) * p.blankL;
  }
  /* حجم حفره داخل کاسه */
  if (innerSamples.length > 1) {
    for (let i = 1; i < innerSamples.length; i++) {
      const dz = Math.abs(innerSamples[i].z - innerSamples[i - 1].z);
      const rAvg = (innerSamples[i].r + innerSamples[i - 1].r) / 2;
      vol += Math.PI * rAvg * rAvg * dz;
    }
  }

  return {
    lines,
    segs,
    samples,
    innerSamples,
    cutLen,
    rapidLen,
    timeSec,
    volumeCm3: vol / 1000,
    roughLayers: p.ops.filter((o) => o.on && (o.type === "rough-d" || o.type === "rough-z" || o.type === "offset" || o.type === "inner-rough" || o.type === "inner-offset")).length,
    format: p.format,
  };
}

/* فیدر بهینه: وقتی simpleFeed روشن است، فیدر هر حرکت به یکی از دو فیدر اصلی  */
/* (خشن برای عملیات‌های برداشت، پرداخت برای پرداخت و آفست) ساده می‌شود تا در  */
/* جی‌کد فقط دو F باقی بماند و G1/F های تکراری حذف شوند.                     */
const FINISH_KINDS: SegKind[] = ["finish", "offset", "boreoff", "borefin"];
function normFeed(sg: Seg, p: Params): number {
  if (sg.feedOvr || !p.simpleFeed) return sg.feed;
  return FINISH_KINDS.includes(sg.kind) ? p.feedFinish : p.feedRough;
}

/* ---------------- پل امن تعویض هلدر (پس‌پردازنده) ---------------- */
/* مختصات ماشین یک نقطه (با تبدیل هلدر دوم) — فضای مشترک هر دو فرمت:
   u = محور طولی (modal X / std Z)، v = محور قطری (modal Y / std X) */
/* خروجی شعاعی: Y = شعاع (مثل پیش‌نمایش و DXF)؛ آفست‌ها واحد ماشین‌اند و دست نمی‌خورند */
export function machineUV(zw: number, xw: number, holder: 1 | 2, p: Params): { u: number; v: number } {
  if (holder === 2) return { u: zw + p.holder2.xOff, v: xw / 2 - p.holder2.yOff };
  return { u: zw, v: xw / 2 };
}

/* مختصات اجراشده یک سر سگمنت = مختصات ماشین + گسترش G0 (اگر روشن باشد).
   پس‌پردازنده و پل‌ها همه با همین مختصات کار می‌کنند تا تداوم ماشین حفظ شود. */
export function execUV(s: Seg, end: boolean, p: Params): { u: number; v: number } {
  const m = machineUV(end ? s.z2 : s.z1, end ? s.x2 : s.x1, s.holder, p);
  if (!s.fan && !s.fanU) return m;
  return { u: m.u + (s.fanU ?? 0), v: m.v + (s.fan ?? 0) };
}

/* آستانه پرش: اگر نقطه پایان پست‌شده با نقطه شروع بعدی (در فضای ماشین)
   بیش از این فاصله داشته باشد، پل امن تعویض هلدر درج می‌شود. */
export const BRIDGE_MIN_JUMP = 10;

export interface PlannedBridge {
  atIndex: number; // پل قبل از سگمنت شماره چندم درج می‌شود
  fromH: 1 | 2;
  toH: 1 | 2;
  from: { u: number; v: number }; // نقطه شروع پل (= پایان پست‌شده قبلی)
  legs: { u: number; v: number }[]; // نقطه‌های میانی/پایانی (همه پله‌ها محوری)
  /* جذب: اگر سگمنت بعد از پل، سریعِ محوریِ طولی باشد، پله ورود حذف می‌شود و
     خودِ آن سگمنت (بلوک G0 خودش) مسیر ورود+سگمنت را یکجا طی می‌کند —
     بدون برگشت (نوک) و بدون افتادن دو خط روی هم */
  absorbed: boolean;
}

/* برنامه‌ریزی پل‌های امن: هر ناپیوستگی فضای ماشین (تعویض هلدر یا شروع
   دور از خانه) با پله‌های محوری از گوشه امن به هم وصل می‌شود:
   خروج در ارتفاع مبدأ تا بیرون همه محتوا، پیمایش در کریدور امن،
   ورود در ارتفاع مقصد — بدون هیچ حرکت مورب از فضای قطعه.
   سگمنت‌های صفر (بدون بلوک) در تشخیص ناپیوستگی نادیده گرفته می‌شوند. */
export function planBridges(segs: Seg[], p: Params): {
  tc: { u: number; v: number };
  home: { u: number; v: number };
  bridges: PlannedBridge[];
} {
  const n = segs.length;
  const starts: { u: number; v: number }[] = new Array(n);
  const ends: { u: number; v: number }[] = new Array(n);
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    starts[i] = execUV(s, false, p);
    ends[i] = execUV(s, true, p);
    if (starts[i].u > maxU) maxU = starts[i].u;
    if (starts[i].v > maxV) maxV = starts[i].v;
    if (ends[i].u > maxU) maxU = ends[i].u;
    if (ends[i].v > maxV) maxV = ends[i].v;
  }
  const homeV = rotationalEnvelope(p.blankD, p.blankShape).maxRotD + 20;
  /* شعاعی: نصفِ مجموع (مساوی نقطه خانه استراتژی) تا پله اضافه نیاید */
  const home = { u: p.blankL + 10, v: homeV / 2 };
  if (home.u > maxU) maxU = home.u;
  if (home.v > maxV) maxV = home.v;
  const tc = { u: maxU + p.safety, v: maxV + p.safety };
  const bridges: PlannedBridge[] = [];
  const jump = (a: { u: number; v: number }, b: { u: number; v: number }) => Math.hypot(a.u - b.u, a.v - b.v);
  const JMIN = BRIDGE_MIN_JUMP / 2; // آستانه در واحد فایل (شعاعی)
  const legsFor = (a: { u: number; v: number }, b: { u: number; v: number }, absorb: boolean, tcu: number, rd: number) => {
    /* پل جذب‌نشده با رمپ وارد می‌شود (از ۳×k_b بالاتر، دقیق روی شروع سگمنت)
       تا تراورس‌های ورود پل‌ها روی هم نیفتند؛ پل جذب‌شده دست‌نخورده است */
    const ty = absorb ? b.v : b.v + rd;
    const legs = [
      { u: tcu, v: a.v + rd },
      { u: tcu, v: ty },
      { u: b.u, v: b.v },
    ];
    return absorb ? legs.slice(0, 2) : legs;
  };
  /* جذب مجاز است فقط وقتی سگمنت هدف، یک حرکت سریعِ غیرصفرِ محوریِ طولی باشد؛
     در این صورت بلوک G0 خودش (از کریدور امن تا انتهای سگمنت) جای پله ورود
     می‌نشیند. فیدرها (برش!) و حرکات شعاعی هرگز جذب نمی‌شوند. */
  const absorbable = (j: number) =>
    segs[j].motion === 0 && Math.abs(ends[j].v - starts[j].v) < 1e-9;
  /* فقط سگمنت‌های غیرصفر (دارای بلوک) در تشخیص ناپیوستگی شرکت می‌کنند */
  const nz: number[] = [];
  for (let i = 0; i < n; i++) {
    if (jump(starts[i], ends[i]) > 1e-9) nz.push(i);
  }
  const mkBridge = (atIndex: number, fromH: 1 | 2, toH: 1 | 2, from: { u: number; v: number }) => {
    const b = starts[atIndex];
    const absorb = absorbable(atIndex);
    /* شماره پل k_b=bridges.length؛ با گسترش، کریدور هر پل k_b*3 جلوتر است تا
       تراورس‌های پل‌ها روی هم نیفتند (پل اول k_b=0 دقیق = TRUE نما) */
    const btcu = tc.u + (p.spreadG0 ? bridges.length * 3 : 0);
    const rd = p.spreadG0 ? bridges.length * 3 : 0;
    bridges.push({ atIndex, fromH, toH, from, legs: legsFor(from, b, absorb, btcu, rd), absorbed: absorb });
  };
  /* تشخیص ناپیوستگی روی مختصات پست‌شده (بدون گسترش): پل برای پرش قاب هلدر است؛
     اختلاف سطح گسترش (همان خط، چند میلی‌متر بالاتر) با پله محوری پوشش داده
     می‌شود نه با پل. پله‌های پل روی مختصات اجراشده (با گسترش) می‌نشینند. */
  const pstart = (j: number) => machineUV(segs[j].z1, segs[j].x1, segs[j].holder, p);
  const pend = (j: number) => machineUV(segs[j].z2, segs[j].x2, segs[j].holder, p);
  if (nz.length > 0 && jump(home, pstart(nz[0])) > JMIN) {
    mkBridge(nz[0], 1, segs[nz[0]].holder, home);
  }
  for (let k = 1; k < nz.length; k++) {
    const i = nz[k];
    const pv = nz[k - 1];
    if (jump(pend(pv), pstart(i)) > JMIN) {
      mkBridge(i, segs[pv].holder, segs[i].holder, ends[pv]);
    }
  }
  return { tc, home, bridges };
}

/* ---------------- پس‌پردازندهٔ استاندارد Fanuc ---------------- */

function buildStdLines(segs: Seg[], p: Params): string[] {
  const lines: string[] = [];
  let nWord = 0;
  const emit = (code: string) => {
    lines.push(p.lineNumbers ? `N${(nWord += 10)} ${code}` : code);
    return lines.length - 1;
  };
  lines.push("%");
  lines.push("O1001 (KHARRATKOD - 2 AXIS WOOD LATHE)");
  lines.push(`(STOCK D${p.blankD} x L${p.blankL} MM)`);
  lines.push(`(TOOL: ${toolDesc(p.tool)})`);
  lines.push(`(DOC ${p.doc} MM - OFFSET OUT ${p.offsetDist} MM - INNER ${p.innerOffsetDist} MM - INNER START ${p.innerStartClearance} MM - INNER END +X ${p.innerEndTravel} MM)`);
  const usesH2 = segs.some((s) => s.motion === 1 && s.holder === 2);
  if (usesH2) {
    lines.push(`(HOLDER2: XOFF ${p.holder2.xOff} YOFF ${p.holder2.yOff} ROT ${HOLDER2_ROT})`);
    lines.push(`(H2 MAP: Xm = Xw + XOFF , Ym = Yw/2 - YOFF)`);
  }
  emit("G21 G18 G40");
  const plan = planBridges(segs, p);
  const bridgeAt = new Map<number, PlannedBridge>();
  for (const b of plan.bridges) bridgeAt.set(b.atIndex, b);
  /* ردیابی موقعیت ماشین روی مختصات اجراشده (ماشین + گسترش G0) */
  /* با گسترشِ روشن، شروعِ اجراشده سگمنت اول با خانه فرق دارد پس ردیابی از خانه
     آغاز می‌شود تا پله خانه→شروع صادر شود؛ خاموش = رفتار legacy بایت‌به‌بایت */
  const fromHome = p.spreadG0 || !segs.length;
  let mu = fromHome ? plan.home.u : execUV(segs[0], false, p).u;
  let mv = fromHome ? plan.home.v : execUV(segs[0], false, p).v;
  let lastFeed = -1;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    const e1 = execUV(sg, false, p);
    const e2 = execUV(sg, true, p);
    const br = bridgeAt.get(i);
    if (br) {
      /* ناپیوستگی فضای ماشین (تعویض هلدر): پله‌های محوری از گوشه امن */
      lines.push(`(HOLDER ${br.fromH} -> ${br.toH})`);
      let pu = br.from.u;
      let pv = br.from.v;
      for (const leg of br.legs) {
        if (Math.hypot(leg.u - pu, leg.v - pv) < 1e-9) continue;
        emit(`G0 X${f2(leg.v)} Z${f2(leg.u)}`);
        pu = leg.u;
        pv = leg.v;
        mu = leg.u;
        mv = leg.v;
      }
    }
    /* پله گسترش: اگر شروع اجراشده با موقعیت ماشین فرق دارد (تغییر سطح گسترش)،
       اول با یک G0 به آن می‌رویم؛ بدون گسترش همیشه صفر است و بلوکی صادر نمی‌شود.
       برای سگمنت جذب‌شده پله نداریم — بلوک خودش از انتهای پل شروع می‌شود. */
    if (!(br && br.absorbed) && Math.hypot(e1.u - mu, e1.v - mv) > 1e-9) {
      emit(`G0 X${f2(e1.v)} Z${f2(e1.u)}`);
      mu = e1.u;
      mv = e1.v;
    }
    if (sg.note) for (const c of sg.note) lines.push(`(${c})`);
    if (sg.motion === 0) {
      sg.line = emit(`G0 X${f2(e2.v)} Z${f2(e2.u)}`);
    } else {
      const F = Math.max(1, Math.round(normFeed(sg, p)));
      /* در حالت فیدر بهینه، F فقط هنگام تغییر تکرار می‌شود وگرنه حذف می‌شود */
      const fWord = !p.simpleFeed || F !== lastFeed ? ` F${F}` : "";
      lastFeed = F;
      sg.line = emit(`G1 X${f2(e2.v)} Z${f2(e2.u)}${fWord}`);
    }
    mu = e2.u;
    mv = e2.v;
    if (i === 0) {
      emit(`M3 S${Math.round(p.rpm)}`);
      emit("G4 P2");
    }
  }
  emit("M5");
  emit("M30");
  lines.push("%");
  return lines;
}

/* ------------- پس‌پردازندهٔ فشرده Modal (سبک نمونهٔ کاربر) ------------- */
/* G90/G49 ، مختصات سه‌دهک، حذف G مودال در خطوط ادامه، تغییر فیدر در خط     */
/* جدا، پایان با M05/M02 — دستگاه مختصات XY (صفحه G17):                    */
/* X = طول قطعه (افقی) ، Y = قطر (عمودی) → نمای XY در CIMCO دقیقاً مطابق  */
/* پیش‌نمایش نرم‌افزار: قطعه افقی، پروفایل بالای محور طول                   */

function buildModalLines(segs: Seg[], p: Params): string[] {
  const lines: string[] = ["%", "G21 G40 G90", "G49", `M3 S${Math.round(p.rpm)}`];
  const usesH2 = segs.some((s) => s.motion === 1 && s.holder === 2);
  if (usesH2) {
    lines.push(`(HOLDER2 XOFF ${p.holder2.xOff} YOFF ${p.holder2.yOff} ROT ${HOLDER2_ROT} : Xm=Xw+XOFF Ym=Yw/2-YOFF)`);
  }
  const f3 = (v: number) => v.toFixed(3);
  let mode: -1 | 0 | 1 = -1;
  let mFeed = -1;
  let lastOp: OpType | "sys" = "sys";
  let lastHolder: 1 | 2 = 1;
  /* جست‌وجوی خانه با نقطه کامل: مختصات مودال دستگاه را صراحتاً روی نقطه خانه
     می‌نشاند تا موقعیت شروع اولین حرکت، هرگز از وضعیت قبلی دستگاه به ارث نرسد */
  const plan = planBridges(segs, p);
  const bridgeAt = new Map<number, PlannedBridge>();
  for (const b of plan.bridges) bridgeAt.set(b.atIndex, b);
  lines.push(`G0 X${f3(plan.home.u)} Y${f3(plan.home.v)}`);
  mode = 0;
  /* ردیابی موقعیت ماشین روی مختصات اجراشده (ماشین + گسترش G0) */
  let mu = plan.home.u;
  let mv = plan.home.v;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    const e1 = execUV(sg, false, p);
    const e2 = execUV(sg, true, p);
    if (sg.op !== lastOp || sg.holder !== lastHolder) lines.push("");
    lastOp = sg.op;
    lastHolder = sg.holder;
    const br = bridgeAt.get(i);
    if (br) {
      /* ناپیوستگی فضای ماشین (تعویض هلدر): پله‌های محوری از گوشه امن */
      lines.push(`(HOLDER ${br.fromH} -> ${br.toH})`);
      let pu = br.from.u;
      let pv = br.from.v;
      for (const leg of br.legs) {
        if (Math.hypot(leg.u - pu, leg.v - pv) < 1e-9) continue;
        lines.push(`G0 X${f3(leg.u)} Y${f3(leg.v)}`);
        pu = leg.u;
        pv = leg.v;
        mu = leg.u;
        mv = leg.v;
      }
      mode = 0;
    }
    /* پله گسترش: اگر شروع اجراشده با موقعیت ماشین فرق دارد (تغییر سطح گسترش)،
       اول با یک G0 به آن می‌رویم؛ بدون گسترش همیشه صفر است و بلوکی صادر نمی‌شود.
       برای سگمنت جذب‌شده پله نداریم — بلوک خودش از انتهای پل شروع می‌شود. */
    if (!(br && br.absorbed) && Math.hypot(e1.u - mu, e1.v - mv) > 1e-9) {
      const sw: string[] = [];
      if (Math.abs(e1.u - mu) > 1e-9) sw.push(`X${f3(e1.u)}`);
      if (Math.abs(e1.v - mv) > 1e-9) sw.push(`Y${f3(e1.v)}`);
      lines.push(`G0 ${sw.join(" ")}`);
      mode = 0;
      mu = e1.u;
      mv = e1.v;
    }
    const words: string[] = [];
    if (Math.abs(e2.u - mu) > 1e-9) words.push(`X${f3(e2.u)}`);
    if (Math.abs(e2.v - mv) > 1e-9) words.push(`Y${f3(e2.v)}`);
    if (words.length === 0) {
      sg.line = lines.length - 1;
      continue;
    }
    if (sg.motion === 0) {
      lines.push(`G0 ${words.join(" ")}`);
      mode = 0;
    } else {
      const F = Math.max(1, Math.round(normFeed(sg, p)));
      const fChanged = F !== mFeed;
      /* فیدر مودال است؛ فقط هنگام تغییر مقدار صادر می‌شود و به خط حرکت می‌چسبد — */
      /* در نتیجه G1/F های تکراری حذف و فقط دو F اصلی باقی می‌ماند.             */
      const gPrefix = mode !== 1 ? "G1 " : "";
      const fSuffix = fChanged ? ` F${F}` : "";
      lines.push(`${gPrefix}${words.join(" ")}${fSuffix}`);
      if (fChanged) mFeed = F;
      mode = 1;
    }
    sg.line = lines.length - 1;
    mu = e2.u;
    mv = e2.v;
  }
  lines.push("", "M05", "M02", "%");
  return lines;
}

/* ---------------- پیش‌تنظیم‌ها ---------------- */

export interface Preset {
  id: string;
  name: string;
  blankD: number;
  blankL: number;
  pts: [number, number, boolean][]; // z, r, smooth
  /** زنجیره دیواره کاسه به ترتیب مسیر: خارج → لبه → داخل (فقط پریست کاسه) */
  wall?: [number, number, boolean][];
  /** نقطه Split پیشنهادی روی دیواره */
  split?: { z: number; r: number };
  /** استراتژی پیشنهادی هنگام اعمال پریست */
  strategy?: string;
  /** شکل مقطع خام پیشنهادی */
  shape?: BlankShape;
}

export const PRESETS: Preset[] = [
  {
    id: "leg",
    name: "پایه مبل",
    blankD: 60,
    blankL: 200,
    pts: [
      [0, 22, false], [10, 22, false], [16, 29, true], [30, 29, true],
      [42, 17, true], [54, 17, true], [62, 27, true], [76, 27, true],
      [86, 13, true], [98, 13, true], [106, 24, true], [122, 24, true],
      [132, 15, true], [146, 15, true], [154, 27, true], [172, 27, true],
      [180, 19, true], [192, 19, true], [200, 22, false],
    ],
  },
  {
    id: "vase",
    name: "گلدان",
    blankD: 64,
    blankL: 200,
    pts: [
      [0, 9, true], [8, 14, true], [20, 24, true], [36, 30, true],
      [54, 27, true], [76, 15, true], [96, 10, true], [114, 11, true],
      [132, 19, true], [150, 26, true], [164, 24, true], [176, 15, true],
      [186, 9, true], [194, 7, true], [200, 8, false],
    ],
  },
  {
    id: "bowl",
    name: "پیاله",
    blankD: 150,
    blankL: 90,
    pts: [
      [0, 10, true], [12, 22, true], [30, 42, true], [52, 58, true],
      [70, 67, true], [82, 71, true], [90, 72, false],
    ],
  },
  {
    id: "bowl-both",
    name: "کاسه (داخل+خارج)",
    blankD: 150,
    blankL: 90,
    shape: "circle",
    strategy: "bowl",
    split: { z: 90, r: 68 },
    pts: [
      [0, 16, false], [8, 19, true], [18, 27, true], [32, 41, true], [48, 54, true],
      [62, 63, true], [74, 69, true], [84, 71.5, true], [90, 72, false],
    ],
    wall: [
      /* شاخه خارجی: از کف تا لبه بیرونی */
      [0, 16, false], [8, 19, true], [18, 27, true], [32, 41, true], [48, 54, true],
      [62, 63, true], [74, 69, true], [84, 71.5, true], [90, 72, false],
      /* ضخامت لبه */
      [90, 64, false],
      /* شاخه داخلی: از لبه داخلی تا کف حفره */
      [82, 61, true], [70, 55, true], [56, 45, true], [42, 32, true],
      [32, 20, true], [26, 10, true], [24, 4, false],
    ],
  },
  {
    id: "baluster",
    name: "ستون نرده",
    blankD: 70,
    blankL: 240,
    pts: [
      [0, 18, false], [8, 24, true], [18, 24, true], [26, 32, true],
      [40, 32, true], [50, 20, true], [62, 14, true], [76, 14, true],
      [86, 26, true], [100, 33, true], [116, 33, true], [126, 22, true],
      [138, 15, true], [152, 15, true], [162, 28, true], [178, 34, true],
      [194, 34, true], [204, 21, true], [216, 15, true], [228, 15, true],
      [234, 20, true], [240, 18, false],
    ],
  },
  {
    id: "bead",
    name: "مهره تسبیح",
    blankD: 40,
    blankL: 60,
    pts: [
      [0, 5, true], [8, 11, true], [18, 17, true], [30, 19, true],
      [42, 17, true], [52, 11, true], [60, 5, true],
    ],
  },
  {
    id: "cyl",
    name: "استوانه خام",
    blankD: 60,
    blankL: 180,
    pts: [
      [0, 30, false], [180, 30, false],
    ],
  },
];

let uid = 1000;
export const nextId = () => ++uid;

export function presetPoints(p: Preset): PPoint[] {
  return p.pts.map(([z, r, smooth]) => ({ id: nextId(), z, r, smooth }));
}

/* مسیر SVG برای بندانگشتی پیش‌تنظیم‌ها */
export function thumbPath(p: Preset, w: number, h: number): string {
  const R = p.blankD / 2;
  const sx = (z: number) => 3 + (z / p.blankL) * (w - 6);
  const sy = (r: number) => h / 2 - (r / R) * (h / 2 - 3);
  const loop = (pts: [number, number][]): string => {
    let d = `M ${sx(pts[0][0]).toFixed(1)} ${sy(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${sx(pts[i][0]).toFixed(1)} ${sy(pts[i][1]).toFixed(1)}`;
    for (let i = pts.length - 1; i >= 0; i--) d += ` L ${sx(pts[i][0]).toFixed(1)} ${(h - sy(pts[i][1])).toFixed(1)}`;
    return d + " Z";
  };
  /* کاسه: حلقه ماده + حلقه حفره (با fill-rule evenodd حفره خالی دیده می‌شود) */
  if (p.wall && p.split) {
    const wall2: [number, number][] = p.wall.map(([z, r]) => [z, r]);
    /* شروع شاخه داخلی = جایی که مسیر در Z برمی‌گردد (لبه)؛ وگرنه نزدیک‌ترین رأس */
    let bi = -1;
    for (let i = 0; i < wall2.length - 1; i++) {
      if (wall2[i + 1][0] < wall2[i][0] - 1e-6) {
        bi = i + 1;
        break;
      }
    }
    if (bi < 0) {
      let bd = Infinity;
      wall2.forEach(([z, r], i) => {
        const d = Math.hypot(z - p.split!.z, r - p.split!.r);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
    }
    const inner = wall2.slice(bi).map(([z, r]): [number, number] => [z, Math.max(0.5, r)]);
    if (inner.length >= 2) return `${loop(wall2)} ${loop(inner)}`;
    return loop(wall2);
  }
  const pts = p.pts;
  return loop(pts.map(([z, r]): [number, number] => [z, r]));
}

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m >= 60) return `${Math.floor(m / 60)}س ${m % 60}د`;
  return m > 0 ? `${m}د و ${s}ث` : `${s} ثانیه`;
}

/* ================= ویرایشِ خطوط جی‌کد (حالت ویرایش مسیر) =================
   هر خطِ خروجی کلیدِ ovrKey دارد؛ ویرایش‌ها به‌صورتِ مطلق (مختصات کارِ
   z/r با X قطری) روی همان کلید ذخیره و برنامه از نو ساخته می‌شود:
   - خطِ حذف‌شده (del) از برنامه بیرون می‌رود؛
   - اگر بعدِ ویرایش، سرِ یک حرکت بُرش از انتهای حرکت قبلی باز باشد،
     یک حرکتِ اتصالِ سریع (G0) خودکار تزریق می‌شود (اتصال ناقص نمی‌ماند)؛
   - حرکات صفرطول (نقاطِ هم‌مکان) حذف می‌شوند (خط/نقطهٔ اضافی نمی‌ماند). */

export interface GcodeOvrPt {
  z: number;
  x: number;
}
export interface GcodeOvr {
  s?: GcodeOvrPt;
  e?: GcodeOvrPt;
  /** نقاط میانی برای شکستن یک حرکت به چند Segment پیوسته */
  via?: GcodeOvrPt[];
  /** نوع حرکت و فید هر قطعه؛ هم‌ردیف با Segmentهای ساخته‌شده از s/via/e */
  moves?: { motion: 0 | 1; feed: number }[];
  del?: boolean;
}
export type GcodeOvrMap = Record<string, GcodeOvr>;

export function applyGcodeOvr(base: GenResult, ovr: GcodeOvrMap, p: Params): GenResult {
  if (!Object.keys(ovr).length) return base;
  const expanded: Seg[] = [];
  for (const sg0 of base.segs) {
    const o = sg0.ovrKey ? ovr[sg0.ovrKey] : undefined;
    if (o?.del) continue;
    const points = [o?.s ?? { z: sg0.z1, x: sg0.x1 }, ...(o?.via ?? []), o?.e ?? { z: sg0.z2, x: sg0.x2 }];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (Math.hypot(b.z - a.z, b.x - a.x) < 1e-6) continue;
      const move = o?.moves?.[i - 1];
      const motion = move?.motion ?? sg0.motion;
      const feed = motion === 0 ? RAPID_RATE : (move?.feed ?? sg0.feed);
      expanded.push({ ...sg0, motion, feed, feedOvr: !!move, z1: a.z, x1: a.x, z2: b.z, x2: b.x, note: i === 1 ? sg0.note : undefined });
    }
  }
  const kept: Seg[] = [];
  for (const sg0 of expanded) {
    const sg = { ...sg0 };
    const prev = kept[kept.length - 1];
    if (prev && sg.motion === 1 && (Math.abs(sg.z1 - prev.z2) > 1e-6 || Math.abs(sg.x1 - prev.x2) > 1e-6)) {
      if (prev.motion === 0) {
        prev.z2 = sg.z1;
        prev.x2 = sg.x1;
        if (Math.hypot(prev.z2 - prev.z1, prev.x2 - prev.x1) < 1e-6) kept.pop();
      } else {
        kept.push({ ...sg, motion: 0, feed: RAPID_RATE, kind: "rapid", opId: -1, op: "sys", note: undefined, fan: undefined, fanU: undefined, z1: prev.z2, x1: prev.x2, z2: sg.z1, x2: sg.x1, line: -1, holder: sg.holder, ovrKey: undefined });
      }
    }
    kept.push(sg);
  }
  const lines = p.format === "modal" ? buildModalLines(kept, p) : buildStdLines(kept, p);
  let cutLen = 0, rapidLen = 0, timeSec = 0;
  for (const sg of kept) {
    const d = Math.hypot(sg.x2 - sg.x1, sg.z2 - sg.z1);
    if (sg.motion === 1) { cutLen += d; timeSec += (d / Math.max(1, sg.feed)) * 60; }
    else { rapidLen += d; timeSec += (d / RAPID_RATE) * 60; }
  }
  return { ...base, segs: kept, lines, cutLen, rapidLen, timeSec };
}

/* ---------- بافرِ «ویرایش مسیر» — پلی‌لاینِ پیوسته با رأس‌های مشترک ----------
   مدل مثل بک‌پلات CIMCO: کل مسیر، یک زنجیرۀ یکپارچه است. نقاط (verts)
   موجودیت‌های مستقل‌اند و هر خط به دو رأس ارجاع می‌دهد؛ جابه‌جایی یک رأس
   خودبه‌خود همهٔ خطوطِ متصل را با خود می‌برد (بدای نقطهٔ دوم و بدون گسست)
   و حذفِ رأس، دو خطِ هم‌رس را در یک خط ادغام می‌کند. */

export interface EVert {
  id: number;
  z: number; // mm محوری
  x: number; // قطر (mm) — همان Xِ برنامه
}

export interface ELine {
  id: number;
  key: string; // ovrKeyِ خطِ پایه (پل‌های تزریق‌شده کلید واقعی ندارند)
  va: number; // رأس مبدأ
  vb: number; // رأس مقصد
  motion: 0 | 1;
  feed: number;
  feedOvr?: boolean;
  opId: number; // -۱ = سیستمی (نزدیک‌سازی/امنیت)
  kind: SegKind;
  holder: 1 | 2;
  note?: string[];
  fan?: number;
  fanU?: number;
}

/* patch روی منحنیِ افست — مستقل از پروفایل اصلی؛ مختصات در فضای پروفایل */
export interface OffPatch {
  a?: { z: number; r: number };
  b?: { z: number; r: number };
  c1?: { z: number; r: number };
  c2?: { z: number; r: number };
  via?: { z: number; r: number };
  del?: boolean;
}

export interface EditBuf {
  verts: EVert[];
  lines: ELine[]; // به همان ترتیب اجرای برنامه؛ همواره vb==vaِ خطِ بعد (زنجیرهٔ بسته)
  sketch: SketchSeg[]; // کپیِ کاریِ پروفایل (تأیید = انتقال به اسکچ اصلی)
  off: Record<number, OffPatch>; // ویرایش مستقل منحنی‌های افست (کلید = id قطعهٔ پروفایل)
  /** انتخاب Segment جزئی از تاریخچهٔ اصلی است تا Undo/Redo آن را نیز بازیابی کند. */
  selLines: number[];
  activeLine: number | null;
}

export type ELineXY = ELine & { z1: number; x1: number; z2: number; x2: number };

export function expandLines(verts: EVert[], lines: ELine[]): ELineXY[] {
  const m = new Map<number, EVert>();
  for (const v of verts) m.set(v.id, v);
  return lines.map((l) => {
    const a = m.get(l.va) ?? { z: 0, x: 0, id: -1 };
    const b = m.get(l.vb) ?? { z: 0, x: 0, id: -1 };
    return { ...l, z1: a.z, x1: a.x, z2: b.z, x2: b.x };
  });
}

/* زنجیره‌سازی: سرِ هر خط = انتهای خطِ پیشین اگر «تقریباً» یکی بودند → رأسِ مشترک؛
   وگرنه رأسِ تازه (شکافِ واقعی همان‌طور که در سیمکو هم خطِ وصل دیده می‌شود). */
export function seedGcodeEdit(segs: Seg[], p: Params): Pick<EditBuf, "verts" | "lines"> {
  const verts: EVert[] = [];
  const lines: ELine[] = [];
  const plan = planBridges(segs, p);
  const bridgeAt = new Map(plan.bridges.map((b) => [b.atIndex, b]));
  let current = { ...plan.home };
  let nextLineId = 1;
  const addV = (u: number, v: number) => { const id = verts.length; verts.push({ id, z: u, x: 2 * v }); return id; };
  let lastV = addV(current.u, current.v);
  const addLine = (to: { u: number; v: number }, meta: Omit<ELine, "id" | "va" | "vb">) => {
    if (Math.hypot(to.u - current.u, to.v - current.v) < 1e-7) return;
    const vb = addV(to.u, to.v);
    lines.push({ ...meta, id: nextLineId++, va: lastV, vb });
    lastV = vb;
    current = { ...to };
  };
  const bridgeMeta = (n: number): Omit<ELine, "id" | "va" | "vb"> => ({ key: `#bridge:${n}`, motion: 0, feed: RAPID_RATE, opId: -1, kind: "rapid", holder: 1 });
  segs.forEach((sg, i) => {
    const e1 = execUV(sg, false, p), e2 = execUV(sg, true, p);
    const br = bridgeAt.get(i);
    if (br) for (let j = 0; j < br.legs.length; j++) addLine(br.legs[j], bridgeMeta(i * 10 + j));
    if (!(br && br.absorbed)) addLine(e1, bridgeMeta(i * 10 + 8));
    addLine(e2, { key: sg.ovrKey ?? `#move:${i}`, motion: sg.motion, feed: sg.feed, feedOvr: sg.feedOvr, opId: sg.opId, kind: sg.kind, holder: sg.holder, note: sg.note, fan: sg.fan, fanU: sg.fanU });
  });
  return normalizeEditBuf(verts, lines);
}

/* نرمال‌سازیِ بافر بعد از هر تغییر (اعتبارسنجی خواستهٔ ۹):
   - خطِ صفرطول حذف و رأسِ مضاعف ادغام می‌شود؛
   - خط‌هایِ تکراریِ چسبیده یکی می‌شوند؛
   - رأس‌های بی‌استفاده (یتیم) پاک می‌شوند تا «نقطهٔ اضافی» نماند. */
export function normalizeEditBuf(verts: EVert[], lines: ELine[]): { verts: EVert[]; lines: ELine[]; dropped: number } {
  const byId = new Map(verts.map((v) => [v.id, v]));
  const kept: ELine[] = [];
  let dropped = 0;
  for (const original of lines) {
    const a = byId.get(original.va), b = byId.get(original.vb);
    if (!a || !b || Math.hypot(a.z - b.z, a.x - b.x) < 1e-7) { dropped++; continue; }
    const prev = kept[kept.length - 1];
    const line = prev ? { ...original, va: prev.vb } : { ...original };
    const aa = byId.get(line.va);
    if (!aa || Math.hypot(aa.z - b.z, aa.x - b.x) < 1e-7) { dropped++; continue; }
    kept.push(line);
  }
  const order: number[] = [];
  if (kept.length) { order.push(kept[0].va); for (const l of kept) order.push(l.vb); }
  const remap = new Map<number, number>();
  const vs: EVert[] = [];
  for (const old of order) if (!remap.has(old)) { remap.set(old, vs.length); vs.push({ ...byId.get(old)!, id: vs.length }); }
  const ls = kept.map((l, i) => ({ ...l, id: i + 1, va: remap.get(l.va)!, vb: remap.get(l.vb)! }));
  dropped += verts.length - vs.length;
  return { verts: vs, lines: ls, dropped };
}

/** حذف رأس‌های منفرد یا متوالی و اتصال مستقیم اولین همسایه معتبر به آخرین همسایه معتبر. */
export function deleteEditVertices(verts: EVert[], lines: ELine[], ids: number[]) {
  const remove = new Set(ids);
  if (!remove.size) return normalizeEditBuf(verts, lines);
  const keptVerts = verts.filter((v) => !remove.has(v.id));
  const keptLines: ELine[] = [];
  let pending: ELine | null = null;
  for (const l of lines) {
    const aGone = remove.has(l.va), bGone = remove.has(l.vb);
    if (!aGone && !bGone) { keptLines.push(l); pending = null; }
    else if (!aGone && bGone) pending = l;
    else if (aGone && !bGone && pending) { keptLines.push({ ...pending, vb: l.vb }); pending = null; }
  }
  return normalizeEditBuf(keptVerts, keptLines);
}

/** حذف Segment با ادغام دو سر آن در مرکز هندسی، بدون شکستن زنجیره. */
export function deleteEditLines(verts: EVert[], lines: ELine[], ids: number[]) {
  const remove = new Set(ids);
  const vs = verts.map((v) => ({ ...v }));
  const vm = new Map(vs.map((v) => [v.id, v]));
  const ls = lines.map((l) => ({ ...l }));
  for (let i = 0; i < ls.length; i++) {
    if (!remove.has(ls[i].id)) continue;
    let j = i;
    while (j + 1 < ls.length && remove.has(ls[j + 1].id)) j++;
    const first = ls[i], last = ls[j], a = vm.get(first.va), b = vm.get(last.vb);
    if (a && b) {
      const mz = (a.z + b.z) / 2, mx = (a.x + b.x) / 2;
      a.z = mz; a.x = mx; b.z = mz; b.x = mx;
      if (i > 0) ls[i - 1].vb = a.id;
      if (j + 1 < ls.length) ls[j + 1].va = a.id;
    }
    ls.splice(i, j - i + 1); i--;
  }
  return normalizeEditBuf(vs, ls);
}

/** درج رأس روی Segment و تقسیم آن به دو Segment با حفظ ترتیب و مشخصات حرکت. */
export function insertEditVertex(verts: EVert[], lines: ELine[], lineId: number, z: number, x: number) {
  const i = lines.findIndex((l) => l.id === lineId);
  if (i < 0) return normalizeEditBuf(verts, lines);
  const l = lines[i], a = verts.find((v) => v.id === l.va), b = verts.find((v) => v.id === l.vb);
  if (!a || !b || Math.hypot(z - a.z, x - a.x) < 1e-6 || Math.hypot(z - b.z, x - b.x) < 1e-6) return normalizeEditBuf(verts, lines);
  const id = Math.max(-1, ...verts.map((v) => v.id)) + 1;
  const nextVerts = [...verts, { id, z, x }];
  const nextLines = [...lines.slice(0, i), { ...l, vb: id }, { ...l, id: Math.max(0, ...lines.map((q) => q.id)) + 1, va: id }, ...lines.slice(i + 1)];
  return normalizeEditBuf(nextVerts, nextLines);
}

/* patches مطلق روی برنامهٔ پایه + حذف‌ها؛ کلیدهای پل (شروع #) نادیده (مجدداً تزریق می‌شوند) */
export function deriveGcodeOvr(verts: EVert[], lines: ELine[], baseSegs: Seg[], prev: GcodeOvrMap, p: Params): GcodeOvrMap {
  const exp = expandLines(verts, lines);
  const next: GcodeOvrMap = { ...prev };
  const byKey = new Map<string, Seg>();
  for (const sg of baseSegs) if (sg.ovrKey) byKey.set(sg.ovrKey, sg);
  const groups = new Map<string, ELineXY[]>();
  for (const l of exp) if (!l.key.startsWith("#")) {
    const g = groups.get(l.key); if (g) g.push(l); else groups.set(l.key, [l]);
  }
  const toWorld = (z: number, x: number, sg: Seg) => {
    const u = z - (sg.fanU ?? 0), v = x / 2 - (sg.fan ?? 0);
    return sg.holder === 2 ? { z: u - p.holder2.xOff, x: 2 * (v + p.holder2.yOff) } : { z: u, x: 2 * v };
  };
  for (const [key, group] of groups) {
    const b = byKey.get(key); if (!b) continue;
    const s0 = toWorld(group[0].z1, group[0].x1, b);
    const e0 = toWorld(group[group.length - 1].z2, group[group.length - 1].x2, b);
    const via = group.slice(0, -1).map((l) => toWorld(l.z2, l.x2, b));
    const o: GcodeOvr = {};
    if (Math.hypot(b.z1 - s0.z, b.x1 - s0.x) > 1e-8) o.s = s0;
    if (Math.hypot(b.z2 - e0.z, b.x2 - e0.x) > 1e-8) o.e = e0;
    if (via.length) o.via = via;
    const moves = group.map((l) => ({ motion: l.motion, feed: l.motion === 0 ? RAPID_RATE : l.feed }));
    if (moves.some((m) => m.motion !== b.motion || (m.motion === 1 && Math.abs(m.feed - b.feed) > 1e-8))) o.moves = moves;
    if (o.s || o.e || o.via || o.moves) next[key] = o; else delete next[key];
  }
  for (const sg of baseSegs) if (sg.ovrKey && !groups.has(sg.ovrKey)) next[sg.ovrKey] = { del: true };
  return next;
}
