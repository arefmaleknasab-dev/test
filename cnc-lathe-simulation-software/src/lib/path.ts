/* ------------------------------------------------------------------ */
/*  ویرایش مسیر (Path Edit) — مدل Polyline پیوستهٔ مسیرِ جی‌کد          */
/* ------------------------------------------------------------------ */
/* مسیرِ اجراشدهٔ برنامه به یک زنجیرۀ یکپارچه تبدیل می‌شود: رأس‌ها   */
/* موجودیت مستقل‌اند و هر قلم (خط یا منحنی) به دو رأس ارجاع می‌دهد؛    */
/* انتهای هر قلم = ابتدای قلم بعدی (قانون ۸). همهٔ عملیاتِ ویرایش     */
/* (حذف قلم، حذف رأس، افزودن رأس، جابه‌جایی) پس از اجرا نرمال‌سازی و  */
/* اعتبارسنجی می‌شوند (قوانین ۱ تا ۱۰).                               */
/*                                                                    */
/* دقت: تا وقتی قلمی دست‌نخورده است، همان نقاطِ اصلیِ برنامه (pts)    */
/* عیناً صادر می‌شوند — پس فقط نقاطی که کاربر جابه‌جا کرده تغییر       */
/* می‌کنند و فاصلهٔ خطوط از هم همان‌قدر که بود می‌ماند.                */

import type { GenResult, Params, Seg, SegKind, OpType } from "./lathe";
import { buildProgram } from "./lathe";

export interface XY {
  z: number; // محور طولی (mm)
  x: number; // قطر (mm) — همان Xِ برنامه
}

/** رأسِ زنجیره — یا دستهٔ کنترلی منحنی؛ indexِ آرایه همان id است */
export interface PathVert {
  id: number;
  z: number;
  x: number;
}

/** یک قلم مسیر: خط راست یا منحنی بازیهٔ مکعبی (به همان ترتیب اجرا) */
export interface PathItem {
  id: number;
  va: number; // رأسِ ابتدا
  vb: number; // رأسِ انتها (= vaِ قلم بعدی در زنجیرۀ پیوسته)
  ha: number | null; // دستهٔ خروج از ابتدا (فقط منحنی)
  hb: number | null; // دستهٔ ورود به انتها (فقط منحنی)
  curve: boolean;
  pts: XY[] | null; // نقاط اصلی و دقیقِ همین قلم؛ تا وقتی دست‌نخورده است عیناً صادر می‌شود
  dirty: boolean; // ویرایش‌شده؟
  motion: 0 | 1; // 0 = G0 سریع ، 1 = G1 بُرش
  feed: number;
  kind: SegKind;
  op: OpType | "sys";
  opId: number;
  holder: 1 | 2;
  note?: string[];
  fan?: number;
  fanU?: number;
}

export interface PathBuf {
  verts: PathVert[];
  items: PathItem[]; // ترتیب آرایه = ترتیب اجرای برنامه (قانون ۷)
  nextI: number;
  rev: number; // شمارۀ نوبت — هر عملیاتِ ویرایش یکی اضافه می‌کند
}

const EPS = 1e-9;
const WELD = 1e-7; // هم‌مکانیِ رأس‌ها برای اشتراک‌گذاری در زنجیره
/* برازشِ نمایشی: چون تا وقتی قلم دست‌نخورده است نقاطِ اصلی صادر می‌شوند، این
   آستانه فقط «قِلبُکیِ منحنی روی بوم» را تعیین می‌کند (زیرِ دقتِ چاپِ جی‌کد) */
const FIT_TOL = 0.02;
const STRAIGHT_TOL = 0.006; // کمتر از این یعنی ران عملاً یک خطِ راست است
const TES_TOL = 0.003; // خطای نمونه‌برداری منحنی هنگام تولید مجدد (mm)
const RUN_MAX = 9; // بیشترین نقطه در هر قطعهٔ منحنی
const ANG_MAX = 0.3491; // ≈ ۲۰° — چرخش مجاز بین دو قلمِ یک ران

/* ---------------- ابزارهای کوچک ---------------- */

const d2 = (a: XY, b: XY) => Math.hypot(b.z - a.z, b.x - a.x);
const near = (a: XY, b: XY, tol = WELD) =>
  Math.abs(a.z - b.z) < tol && Math.abs(a.x - b.x) < tol;

/** فاصلۀ نقطه تا پاره‌خط */
export function distToPoly(p: XY, poly: XY[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const dz = b.z - a.z;
    const dx = b.x - a.x;
    const len2 = dz * dz + dx * dx;
    const t =
      len2 < EPS
        ? 0
        : Math.min(
            1,
            Math.max(0, ((p.z - a.z) * dz + (p.x - a.x) * dx) / len2),
          );
    const d = Math.hypot(p.z - (a.z + dz * t), p.x - (a.x + dx * t));
    if (d < best) best = d;
  }
  return best;
}

const bez = (p0: XY, p1: XY, p2: XY, p3: XY, t: number): XY => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    z: w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z,
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
  };
};

/** تقسیم de Casteljau — دو بازیهٔ چپ و راست در پارامتر t */
const splitBez = (p0: XY, p1: XY, p2: XY, p3: XY, t: number): [XY[], XY[]] => {
  const u = 1 - t;
  const a = { z: u * p0.z + t * p1.z, x: u * p0.x + t * p1.x };
  const b = { z: u * p1.z + t * p2.z, x: u * p1.x + t * p2.x };
  const c = { z: u * p2.z + t * p3.z, x: u * p2.x + t * p3.x };
  const d = { z: u * a.z + t * b.z, x: u * a.x + t * b.x };
  const e = { z: u * b.z + t * c.z, x: u * b.x + t * c.x };
  const f = { z: u * d.z + t * e.z, x: u * d.x + t * e.x };
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
};

/** برازش کمترین‌مربعاتِ بازیهٔ مکعبی روی نقاط (پارامترسازی طولِکورد) */
function fitCubic(pts: XY[]): { p1: XY; p2: XY; maxDev: number } {
  const n = pts.length;
  if (n < 3) {
    const p0 = pts[0];
    const p3 = pts[n - 1];
    return {
      p1: { z: p0.z + (p3.z - p0.z) / 3, x: p0.x + (p3.x - p0.x) / 3 },
      p2: {
        z: p0.z + (2 * (p3.z - p0.z)) / 3,
        x: p0.x + (2 * (p3.x - p0.x)) / 3,
      },
      maxDev: 0,
    };
  }
  const p0 = pts[0];
  const p3 = pts[n - 1];
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + d2(pts[i - 1], pts[i]));
  const total = cum[n - 1] || 1;
  const ts = cum.map((c) => c / total);
  /* Σ(b1²) Σ(b1·b2) ; Σ(b1·b2) Σ(b2²) ] · [c1 c2]ᵀ = [Σ b1·r Σ b2·r] */
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  const r1: XY = { z: 0, x: 0 };
  const r2: XY = { z: 0, x: 0 };
  for (let i = 1; i < n - 1; i++) {
    const t = ts[i];
    const u = 1 - t;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b0 = u * u * u;
    const b3 = t * t * t;
    s11 += b1 * b1;
    s12 += b1 * b2;
    s22 += b2 * b2;
    r1.z += b1 * (pts[i].z - (b0 * p0.z + b3 * p3.z));
    r1.x += b1 * (pts[i].x - (b0 * p0.x + b3 * p3.x));
    r2.z += b2 * (pts[i].z - (b0 * p0.z + b3 * p3.z));
    r2.x += b2 * (pts[i].x - (b0 * p0.x + b3 * p3.x));
  }
  const det = s11 * s22 - s12 * s12;
  let c1: XY;
  let c2: XY;
  if (Math.abs(det) < 1e-9) {
    /* دستگاهِ تک‌معادله‌ای (مثلاً ۳ نقطه): پاسخِ کمینه‌نرم — با این کار منحنی
       از هر سه نقطه دقیقاً می‌گذرد و رأسِ میانی گم نمی‌شود */
    const tr = s11 + s22 + 1e-12;
    c1 = {
      z: (s11 * r1.z + s12 * r2.z) / tr,
      x: (s11 * r1.x + s12 * r2.x) / tr,
    };
    c2 = {
      z: (s12 * r1.z + s22 * r2.z) / tr,
      x: (s12 * r1.x + s22 * r2.x) / tr,
    };
  } else {
    c1 = {
      z: (s22 * r1.z - s12 * r2.z) / det,
      x: (s22 * r1.x - s12 * r2.x) / det,
    };
    c2 = {
      z: (s11 * r2.z - s12 * r1.z) / det,
      x: (s11 * r2.x - s12 * r1.x) / det,
    };
  }
  /* بیشترین خطای منحنیِ برازش‌شده نسبت به نقاط اصلی */
  let maxDev = 0;
  for (let k = 0; k <= 24; k++) {
    const q = bez(p0, c1, c2, p3, k / 24);
    const dd = distToPoly(q, pts);
    if (dd > maxDev) maxDev = dd;
  }
  return { p1: c1, p2: c2, maxDev };
}

/** نمونه‌برداریِ سازگار از بازیه — خطای حداکثری < tol */
function tessellate(p0: XY, p1: XY, p2: XY, p3: XY, tol = TES_TOL): XY[] {
  const len = d2(p0, p3);
  const aim = Math.max(4, Math.min(120, Math.ceil(len / 1.1)));
  let n = aim;
  const sample = (k: number): XY[] => {
    const out: XY[] = [];
    for (let i = 0; i <= k; i++) out.push(bez(p0, p1, p2, p3, i / k));
    return out;
  };
  let pts = sample(n);
  for (let guard = 0; guard < 6; guard++) {
    let dev = 0;
    for (let i = 0; i < n; i++) {
      const mid = bez(p0, p1, p2, p3, (i + 0.5) / n);
      const a = pts[i];
      const b = pts[i + 1];
      const mz = (a.z + b.z) / 2;
      const mx = (a.x + b.x) / 2;
      dev = Math.max(dev, Math.hypot(mid.z - mz, mid.x - mx));
    }
    if (dev <= tol) break;
    n = Math.min(240, n * 2);
    pts = sample(n);
  }
  /* سرِ مسیر باید دقیقاً روی رأسِ زنجیره باشد */
  pts[0] = { z: p0.z, x: p0.x };
  pts[pts.length - 1] = { z: p3.z, x: p3.x };
  return pts;
}

/* ---------------- ساخت بافر از برنامهٔ پایه ---------------- */

export function buildPathBuf(segs: Seg[]): PathBuf {
  const verts: PathVert[] = [];
  const items: PathItem[] = [];
  const addV = (p: XY): number => {
    verts.push({ id: verts.length, z: p.z, x: p.x });
    return verts.length - 1;
  };
  let lastV = -1;
  let nid = 1;
  for (const sg of segs) {
    const a: XY = { z: sg.z1, x: sg.x1 };
    const b: XY = { z: sg.z2, x: sg.x2 };
    const va = lastV < 0 ? addV(a) : near(verts[lastV], a) ? lastV : addV(a);
    const vb = near(verts[va], b) ? va : addV(b);
    if (va === vb) {
      lastV = vb;
      continue; // صفرطول (قانون ۹)
    }
    items.push({
      id: nid++,
      va,
      vb,
      ha: null,
      hb: null,
      curve: false,
      pts: null,
      dirty: false,
      motion: sg.motion,
      feed: sg.feed,
      kind: sg.kind,
      op: sg.op,
      opId: sg.opId,
      holder: sg.holder,
      note: sg.note,
      fan: sg.fan,
      fanU: sg.fanU,
    });
    lastV = vb;
  }
  return finishPath(groupRuns({ verts, items, nextI: nid, rev: 0 }), false);
}

/* ---------------- گروه‌بندی: خط‌های ریز و منحنی‌های پیوسته ---------------- */
/* ران = چند قلمِ بُرشِ متوالی از یک عملیات که زاویهٔ کمی دارند. رانِ کاملاً     */
/* هم‌راستا یک خط می‌شود و رانِ خمیده چند قطعهٔ منحنی — با نقاط اصلیِ ذخیره‌شده */
/* تا هندسهٔ دست‌نخورده دقیقاً همان نقاط قبلی صادر شود.                        */

function groupRuns(buf: PathBuf): PathBuf {
  const out: PathItem[] = [];
  const items = buf.items;
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const isRun = it.motion === 1 && !it.curve;
    let j = i;
    if (isRun) {
      while (j + 1 < items.length) {
        const a = items[j];
        const b = items[j + 1];
        if (b.motion !== 1 || b.curve) break;
        if (b.opId !== a.opId || b.kind !== a.kind || b.feed !== a.feed) break;
        if (b.note || b.fan || b.fanU) break; // کامنت/گسترش باید روی قلم خودش بماند
        if (a.vb !== b.va) break;
        /* چرخش در رأسِ مشترک */
        const prev = j > i ? pointBefore(items, buf, j) : null;
        const k = a.vb;
        if (prev) {
          const u = { z: buf.verts[k].z - prev.z, x: buf.verts[k].x - prev.x };
          const v = {
            z: buf.verts[b.vb].z - buf.verts[k].z,
            x: buf.verts[b.vb].x - buf.verts[k].x,
          };
          const lu = Math.hypot(u.z, u.x);
          const lv = Math.hypot(v.z, v.x);
          if (lu < EPS || lv < EPS) break;
          const cosang = (u.z * v.z + u.x * v.x) / (lu * lv);
          if (cosang < Math.cos(ANG_MAX)) break;
        }
        j++;
      }
    }
    if (j > i) {
      const run = items.slice(i, j + 1);
      const poly: XY[] = [
        { z: buf.verts[run[0].va].z, x: buf.verts[run[0].va].x },
      ];
      for (const r of run)
        poly.push({ z: buf.verts[r.vb].z, x: buf.verts[r.vb].x });
      const head = run[0];
      const notes = run.flatMap((r) => r.note ?? []);
      const base: Omit<
        PathItem,
        "id" | "va" | "vb" | "ha" | "hb" | "curve" | "pts"
      > = {
        motion: 1,
        feed: head.feed,
        kind: head.kind,
        op: head.op,
        opId: head.opId,
        holder: head.holder,
        note: notes.length ? notes : undefined,
        fan: head.fan,
        fanU: head.fanU,
        dirty: false,
      };
      /* هم‌راستا؟ → یک خط ساده */
      const chordDev = maxChordDev(poly);
      if (chordDev <= STRAIGHT_TOL) {
        out.push({
          ...base,
          id: buf.nextI++,
          va: run[0].va,
          vb: run[run.length - 1].vb,
          ha: null,
          hb: null,
          curve: false,
          pts: poly,
        });
      } else {
        const pieces = piecewise(poly, 0);
        let carry = run[0].va; // مفصلِ مشترکِ قطعه‌ها — یک رأس برای هر مفصل (قانون ۸)
        for (let pk = 0; pk < pieces.length; pk++) {
          const piece = pieces[pk];
          const s = piece.s;
          const e = piece.e;
          const sub = poly.slice(s, e + 1);
          const va = carry; // مفصلِ مشترک با قطعهٔ پیشین
          const last = pk === pieces.length - 1;
          const vb = last ? run[run.length - 1].vb : addVertAt(buf, poly[e]);
          carry = vb;
          if (va === vb) continue;
          if (sub.length < 3) {
            out.push({
              ...base,
              id: buf.nextI++,
              va,
              vb,
              ha: null,
              hb: null,
              curve: false,
              pts: sub.length >= 2 ? sub : null,
            });
            continue;
          }
          const fit = fitCubic(sub);
          if (fit.maxDev > FIT_TOL) {
            /* منحنیِ کوتاه‌تر از آن است که با دقتِ لازم بازیه شود → همان نقاطِ اصلی،
               به‌صورتِ یک قلمِ خط‌شکست (دقتِ کامل، بدون نقاطِ اضافی روی هم) */
            out.push({
              ...base,
              id: buf.nextI++,
              va,
              vb,
              ha: null,
              hb: null,
              curve: false,
              pts: sub,
            });
            continue;
          }
          const ha = addVertAt(buf, fit.p1);
          const hb = addVertAt(buf, fit.p2);
          out.push({
            ...base,
            id: buf.nextI++,
            va,
            vb,
            ha,
            hb,
            curve: true,
            pts: sub,
          });
        }
      }
      i = j + 1;
      continue;
    }
    out.push(it);
    i++;
  }
  return { ...buf, items: out };
}

function pointBefore(items: PathItem[], buf: PathBuf, idx: number): XY | null {
  const it = items[idx];
  if (!it) return null;
  if (it.pts && it.pts.length >= 2) return it.pts[it.pts.length - 2];
  if (it.curve && it.hb != null) return buf.verts[it.hb];
  return it.va !== it.vb ? buf.verts[it.va] : null;
}

function addVertAt(buf: PathBuf, p: XY): number {
  buf.verts.push({ id: buf.verts.length, z: p.z, x: p.x });
  return buf.verts.length - 1;
}

/** بیشترین فاصلهٔ نقاط از وترِ ابتدا-انتها */
function maxChordDev(poly: XY[]): number {
  const a = poly[0];
  const b = poly[poly.length - 1];
  let dev = 0;
  for (let i = 1; i < poly.length - 1; i++)
    dev = Math.max(dev, distToPoly(poly[i], [a, b]));
  return dev;
}

/** تقسیمِ سازگارِ ران: قطعه‌ها طوری انتخاب می‌شوند که بازیهٔ مکعبی، خطوطِ اصلی را
   با خطایِ کمتر از FIT_TOL بازتولید کند (تقسیم بر اساس طولِ تجمعی، پس گوشه‌های
   تیز هم قطعهٔ کوتاه می‌گیرند) و قطعهٔ ۳نقطه‌ای همیشه دقیق است. */
function piecewise(poly: XY[], depth: number): { s: number; e: number }[] {
  const n = poly.length - 1;
  if (n <= 3) return [{ s: 0, e: n }];
  /* طولِ تجمعی برای تقسیمِ متوازن */
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + d2(poly[i - 1], poly[i]));
  const solve = (a: number, b: number): { s: number; e: number }[] => {
    const len = b - a;
    if (len <= 3 || depth + 1 > 9) return [{ s: a, e: b }];
    const fit = fitCubic(poly.slice(a, b + 1));
    if (fit.maxDev <= FIT_TOL) return [{ s: a, e: b }];
    const half = (cum[b] - cum[a]) / 2;
    let m = a + 1;
    for (let k = a + 1; k < b; k++) if (cum[k] - cum[a] <= half) m = k;
    if (m <= a || m >= b) return [{ s: a, e: b }];
    return [...solve(a, m), ...solve(m, b)];
  };
  const out = solve(0, n);
  /* قطعه‌های بلندِ از قبل دقیق، کوتاه‌تر شوند تا تعداد قلم‌ها منطقی بماند */
  const flat: { s: number; e: number }[] = [];
  for (const pc of out) {
    let cur = pc.s;
    while (pc.e - cur > RUN_MAX) {
      const nx =
        cur + Math.ceil((pc.e - cur) / Math.ceil((pc.e - cur) / RUN_MAX));
      flat.push({ s: cur, e: nx });
      cur = nx;
    }
    flat.push({ s: cur, e: pc.e });
  }
  return flat.filter((pc) => pc.e > pc.s);
}

/* ---------------- نقاط و مسیرِ هندسیِ یک قلم ---------------- */

/** نقاطِ صادرشدهٔ قلم (مبنای همه‌چیز: خط‌کشی، تولید جی‌کد، اندازه‌گیری) */
export function itemPoints(buf: PathBuf, it: PathItem): XY[] {
  const A = buf.verts[it.va];
  const B = buf.verts[it.vb];
  if (!it.dirty && it.pts && it.pts.length >= 2) {
    /* نقاط اصلی — فقط سرها با موقعیتِ فعلیِ رأس‌ها هم‌راستا شوند */
    return it.pts;
  }
  if (it.curve && it.ha != null && it.hb != null) {
    const H1 = buf.verts[it.ha];
    const H2 = buf.verts[it.hb];
    return tessellate(A, H1, H2, B);
  }
  return [A, B];
}

/** مسیرِ SVG برای نمایش (منحنی‌ها واقعی‌اند، نه نقاطِฟشرده) */
export function itemSvgData(
  buf: PathBuf,
  it: PathItem,
  px: (p: XY) => [number, number],
): string {
  const A = buf.verts[it.va];
  const B = buf.verts[it.vb];
  const [ax, ay] = px(A);
  const [bx, by] = px(B);
  if (it.curve && it.ha != null && it.hb != null) {
    const [h1x, h1y] = px(buf.verts[it.ha]);
    const [h2x, h2y] = px(buf.verts[it.hb]);
    return `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${h1x.toFixed(1)} ${h1y.toFixed(1)}, ${h2x.toFixed(1)} ${h2y.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  if (!it.dirty && it.pts && it.pts.length > 2) {
    let d = `M ${ax.toFixed(1)} ${ay.toFixed(1)}`;
    for (let i = 1; i < it.pts.length - 1; i++) {
      const [x, y] = px(it.pts[i]);
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return `${d} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
  }
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} L ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

/* ---------------- نرمال‌سازی و اعتبارسنجی (قوانین ۸، ۹، ۱۰) ---------------- */

const cloneBuf = (buf: PathBuf): PathBuf => ({
  verts: buf.verts.map((v) => ({ ...v })),
  items: buf.items.map((i) => ({ ...i })),
  nextI: buf.nextI,
  rev: buf.rev,
});

/** اتصالِ رأس‌های هم‌مکان، حذف صفرطول‌ها، پاک‌کردن رأس‌های بی‌استفاده، شماره‌گذاری دوباره */
export function finishPath(buf: PathBuf, markRev = true): PathBuf {
  const next = cloneBuf(buf);
  /* سه پاک‌سازی روی هم اثر می‌گذارند (حذفِ صفرطول می‌تواند مفصلِ جدید بسازد) → تا پایداری */
  for (let pass = 0; pass < 4; pass++) {
    const before = next.items.length + next.verts.length;
    /* ۱) اشتراک‌گذاری رأس‌های هم‌مکان در مفصلِ زنجیره (قانون ۸) */
    for (let i = 0; i + 1 < next.items.length; i++) {
      const a = next.items[i];
      const b = next.items[i + 1];
      if (a.vb === b.va) continue;
      if (!near(next.verts[a.vb], next.verts[b.va])) continue;
      const drop = b.va;
      for (const it of next.items) {
        if (it.va === drop) it.va = a.vb;
        if (it.vb === drop) it.vb = a.vb;
        if (it.ha === drop) it.ha = a.vb;
        if (it.hb === drop) it.hb = a.vb;
      }
    }
    /* ۲) حذف قلم‌های صفرطول (قانون ۹) */
    next.items = next.items.filter(
      (it) =>
        it.va !== it.vb && !near(next.verts[it.va], next.verts[it.vb], EPS),
    );
    /* ۳) حذف قلم‌های تکراریِ چسبیده */
    const dedup: PathItem[] = [];
    for (const it of next.items) {
      const pv = dedup[dedup.length - 1];
      if (
        pv &&
        ((pv.va === it.va && pv.vb === it.vb) ||
          (pv.va === it.vb && pv.vb === it.va)) &&
        pv.motion === it.motion
      )
        continue;
      dedup.push(it);
    }
    next.items = dedup;
    if (next.items.length + next.verts.length === before) break;
  }
  /* ۴) حذف رأس‌های بی‌استفاده + شماره‌گذاری مجدد */
  const used = new Map<number, number>();
  for (const it of next.items) {
    for (const id of [it.va, it.vb, it.ha, it.hb])
      if (id != null) used.set(id, -1);
  }
  const remap = new Map<number, number>();
  const verts: PathVert[] = [];
  next.verts.forEach((v) => {
    if (!used.has(v.id)) return;
    remap.set(v.id, verts.length);
    verts.push({ id: verts.length, z: v.z, x: v.x });
  });
  next.verts = verts;
  for (const it of next.items) {
    it.va = remap.get(it.va) ?? it.va;
    it.vb = remap.get(it.vb) ?? it.vb;
    if (it.ha != null) it.ha = remap.get(it.ha) ?? null;
    if (it.hb != null) it.hb = remap.get(it.hb) ?? null;
  }
  if (markRev) next.rev++;
  return next;
}

export interface PathIssues {
  gaps: number[]; // اندیس مفصل‌هایی که رأسِ مشترک ندارند
  zero: number;
  orphan: number;
  bad: number; // مختصات نامعتبر
}

/** اعتبارسنجی پس از ویرایش (قانون ۱۰) */
export function pathIssues(buf: PathBuf): PathIssues {
  const gaps: number[] = [];
  let zero = 0;
  for (let i = 0; i < buf.items.length; i++) {
    const it = buf.items[i];
    const A = buf.verts[it.va];
    const B = buf.verts[it.vb];
    if (!A || !B) {
      zero++;
      continue;
    }
    if (near(A, B, EPS)) zero++;
    const nx = buf.items[i + 1];
    if (nx && it.vb !== nx.va) gaps.push(i);
  }
  const used = new Set<number>();
  for (const it of buf.items)
    for (const id of [it.va, it.vb, it.ha, it.hb]) if (id != null) used.add(id);
  const orphan = buf.verts.filter((v) => !used.has(v.id)).length;
  const bad = buf.verts.filter(
    (v) => !Number.isFinite(v.z) || !Number.isFinite(v.x),
  ).length;
  return { gaps, zero, orphan, bad };
}

export interface PathStats {
  items: number;
  curves: number;
  verts: number;
  changed: number;
  rapids: number;
}

export function pathStats(buf: PathBuf): PathStats {
  let curves = 0;
  let changed = 0;
  let rapids = 0;
  for (const it of buf.items) {
    if (it.curve) curves++;
    if (it.dirty) changed++;
    if (it.motion === 0) rapids++;
  }
  return {
    items: buf.items.length,
    curves,
    verts: buf.verts.length,
    changed,
    rapids,
  };
}

/* ---------------- عملیات‌های ویرایش ---------------- */

/** قانون ۵ — جابه‌جایی رأس (یا دسته): فقط همین رأس‌ها و قلم‌های متصلشان */
export function moveVerts(buf: PathBuf, pos: Record<number, XY>): PathBuf {
  const next = cloneBuf(buf);
  const ids = new Set<number>();
  for (const [k, v] of Object.entries(pos)) {
    const id = Number(k);
    if (!next.verts[id]) continue;
    next.verts[id].z = v.z;
    next.verts[id].x = v.x;
    ids.add(id);
  }
  touch(next, [...ids]); // نقاطِ اصلیِ قلم‌های دست‌خورده دیگر معتبر نیستند
  return finishPath(next);
}

/** قانون ۱ و ۳ — حذف قلم‌ها؛ دو سرِ باز می‌شوند و در تقاطع/مرکز هندسی جوش می‌خورند */
export function deleteItems(buf: PathBuf, ids: number[]): PathBuf {
  if (!ids.length) return buf;
  const kill = new Set(ids);
  if (kill.size >= buf.items.length) return buf; // حذف کل برنامه مجاز نیست
  const next = cloneBuf(buf);
  const kept = next.items.filter((it) => !kill.has(it.id));
  if (!kept.length) return buf;
  /* اتصالِ مجدد هر شکاف */
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i];
    const b = kept[i + 1];
    if (a.vb === b.va) continue;
    const pa = tailOf(next, a);
    const pb = headOf(next, b);
    const A = next.verts[a.vb];
    const B = next.verts[b.va];
    const m = joinPoint(A, pa, B, pb);
    next.verts[B.id] = { ...B, z: m.z, x: m.x }; // B می‌ماند، A بی‌استفاده و پاک می‌شود
    a.vb = B.id;
    touch(next, [B.id]); // هر قلمی که به این رأس وصل است دیگر نقاطِ اصلی را ندارد
  }
  next.items = kept;
  return finishPath(next);
}

function tailOf(buf: PathBuf, it: PathItem): XY {
  if (it.curve && it.hb != null) return buf.verts[it.hb];
  if (it.pts && it.pts.length >= 2) return it.pts[it.pts.length - 2];
  return buf.verts[it.va];
}
function headOf(buf: PathBuf, it: PathItem): XY {
  if (it.curve && it.ha != null) return buf.verts[it.ha];
  if (it.pts && it.pts.length >= 2) return it.pts[1];
  return buf.verts[it.vb];
}

/** تقاطعِ دو مماس، و اگر نمی‌رسیدند مرکز هندسیِ دو سر (قانون ۱) */
function joinPoint(A: XY, dA: XY, B: XY, dB: XY): XY {
  const u = { z: A.z - dA.z, x: A.x - dA.x };
  const v = { z: B.z - dB.z, x: B.x - dB.x };
  const lu = Math.hypot(u.z, u.x);
  const lv = Math.hypot(v.z, v.x);
  const mid: XY = { z: (A.z + B.z) / 2, x: (A.x + B.x) / 2 };
  if (lu < 1e-12 || lv < 1e-12) return mid;
  const cross = u.z * v.x - u.x * v.z;
  if (Math.abs(cross) < 1e-9 * lu * lv) return mid; // موازی → مرکز هندسی
  const w = { z: B.z - A.z, x: B.x - A.x };
  const t = (w.z * v.x - w.x * v.z) / cross;
  const s = (w.z * u.x - w.x * u.z) / cross;
  const p: XY = { z: A.z + u.z * t, x: A.x + u.x * t };
  const q: XY = { z: B.z + v.z * s, x: B.x + v.x * s };
  const m: XY = { z: (p.z + q.z) / 2, x: (p.x + q.x) / 2 };
  const far = Math.max(d2(m, A), d2(m, B));
  const reach = Math.max(lu, lv, d2(A, B)) * 4 + 2;
  if (!Number.isFinite(m.z) || !Number.isFinite(m.x) || far > reach) return mid; // پرشِ نامعقول → مرکز
  return m;
}

/** رأس جابه‌جا شد → قلم‌های متصلش دیگر نقاطِ اصلیِ معتبر ندارند (قانون ۵) */
function touch(buf: PathBuf, ids: number[]) {
  const set = new Set(ids);
  for (const it of buf.items) {
    if (![it.va, it.vb, it.ha, it.hb].some((id) => id != null && set.has(id)))
      continue;
    it.dirty = true;
    it.pts = null;
  }
}

/** قوانین ۲ و ۳ — حذف رأس: قلم‌های مجاور حذف و یک قلم تازه بین رأسِ قبلی و بعدی */
/**
 * حذف رأس (قانون ۲) و حذف چند رأسِ پی‌درپی (قانون ۳).
 * همه در یک‌پاس و روی همان آرایۀ قلم‌ها حساب می‌شود — چون finishPath رأس‌ها را
 * شماره‌گذاری دوباره می‌کند، حلقه‌به‌حذف‌کردنِ «رأس‌به‌رأس» شناسه‌های کهنه را
 * هدف می‌گیرد و رأسِ اشتباه را می‌برد.
 */
export function deleteVerts(buf: PathBuf, vids: number[]): PathBuf {
  if (!vids.length) return buf;
  const wanted = new Set(vids);
  const next = cloneBuf(buf);

  /* (الف) رأسِ دستۀ کنترلیِ منحنی → همان منحنی به خطِ راست برمی‌گردد */
  let handleTouched = false;
  for (const it of next.items) {
    if (
      (it.ha != null && wanted.has(it.ha)) ||
      (it.hb != null && wanted.has(it.hb))
    ) {
      it.curve = false;
      it.ha = null;
      it.hb = null;
      it.pts = null;
      it.dirty = true;
      handleTouched = true;
    }
  }

  /* (ب) رأس‌های زنجیره: بلوک‌های پی‌درپی از قلم‌های «آلوده» → هر بلوک یک قلمِ پل */
  const touched = next.items.map(
    (it) => wanted.has(it.va) || wanted.has(it.vb),
  );
  if (!touched.some(Boolean)) return handleTouched ? finishPath(next) : buf;
  const out: PathItem[] = [];
  let i = 0;
  while (i < next.items.length) {
    if (!touched[i]) {
      out.push(next.items[i++]);
      continue;
    }
    let e = i;
    while (e + 1 < next.items.length && touched[e + 1]) e++;
    const first = next.items[i];
    const last = next.items[e];
    const head = wanted.has(first.va) ? null : first.va;
    const tail = wanted.has(last.vb) ? null : last.vb;
    if (head != null && tail != null && head !== tail) {
      out.push({
        ...first,
        id: next.nextI++,
        va: head,
        vb: tail,
        ha: null,
        hb: null,
        curve: false,
        pts: null,
        dirty: true,
        note: first.note ?? last.note,
      });
    }
    i = e + 1;
  }
  next.items = out;
  /* نگهبان: زنجیره نباید به هیچ قلمِ برنده‌ای ختم شود */
  if (!out.length || !out.some((it) => it.motion === 1)) return buf;
  return finishPath(next);
}
export function splitItem(
  buf: PathBuf,
  itemId: number,
  at: XY,
): { buf: PathBuf; vid: number; added: boolean } {
  const idx = buf.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return { buf, vid: -1, added: false };
  const next = cloneBuf(buf);
  const it = next.items[idx];
  const A = next.verts[it.va];
  const B = next.verts[it.vb];
  const H1 = it.ha != null ? next.verts[it.ha] : null;
  const H2 = it.hb != null ? next.verts[it.hb] : null;
  const poly = itemPoints(next, it);
  const srcPts = it.pts && it.pts.length > 2 ? it.pts : null;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  /* نقطهٔ جاگذاری: نزدیک‌ترین نقطهٔ روی هندسهٔ قلم (شکلِ مسیر عوض نمی‌شود) */
  let j = -1;
  let pt: XY = at;
  let t = 0.5;
  if (srcPts) {
    /* اگر نقاطِ اصلی هست، روی همان‌ها قفل می‌کنیم → همان خطوطِ قبلی، بدون هیچ تغییرِ عددی */
    let bd = Infinity;
    srcPts.forEach((q, k) => {
      if (k === 0 || k === srcPts.length - 1) return;
      const d = d2(q, at);
      if (d < bd) {
        bd = d;
        j = k;
      }
    });
    if (j > 0) {
      pt = { z: srcPts[j].z, x: srcPts[j].x };
      t = j / (srcPts.length - 1);
    }
  }
  if (j < 0) {
    let bd = Infinity;
    for (let k = 0; k + 1 < poly.length; k++) {
      const a = poly[k];
      const b = poly[k + 1];
      const dz = b.z - a.z;
      const dx = b.x - a.x;
      const len2 = dz * dz + dx * dx;
      const tt =
        len2 < EPS
          ? 0
          : clamp(((at.z - a.z) * dz + (at.x - a.x) * dx) / len2, 0, 1);
      const q = { z: a.z + dz * tt, x: a.x + dx * tt };
      const d = Math.hypot(at.z - q.z, at.x - q.x);
      if (d < bd) {
        bd = d;
        pt = q;
        if (srcPts) j = k + (tt < 0.5 ? 0 : 1);
        t = poly.length > 2 ? (k + tt) / (poly.length - 1) : 0.5;
      }
    }
  }
  const exact = srcPts != null && j > 0 && j < srcPts.length - 1;
  const leftPts = exact ? srcPts!.slice(0, j + 1) : null;
  const rightPts = exact ? srcPts!.slice(j) : null;
  const midV = addVertAt(next, pt);

  let left: PathItem;
  let right: PathItem;
  if (it.curve && H1 && H2) {
    if (!exact) {
      /* پارامترِ تقسیم = نزدیک‌ترین نقطه روی خودِ منحنی */
      let bd = Infinity;
      for (let k = 0; k <= 60; k++) {
        const q = bez(A, H1, H2, B, k / 60);
        const d = d2(q, at);
        if (d < bd) {
          bd = d;
          t = k / 60;
        }
      }
      const [l0] = splitBez(A, H1, H2, B, clamp(t, 0.02, 0.98));
      pt = { z: l0[3].z, x: l0[3].x };
      next.verts[midV] = { id: midV, z: pt.z, x: pt.x };
    }
    const [l, r] = splitBez(A, H1, H2, B, clamp(t, 0.02, 0.98));
    const lha = addVertAt(next, l[1]);
    const lhb = addVertAt(next, l[2]);
    const rha = addVertAt(next, r[1]);
    const rhb = addVertAt(next, r[2]);
    left = {
      ...it,
      va: it.va,
      vb: midV,
      ha: lha,
      hb: lhb,
      pts: leftPts,
      dirty: exact ? it.dirty : true,
    };
    right = {
      ...it,
      id: next.nextI++,
      va: midV,
      vb: it.vb,
      ha: rha,
      hb: rhb,
      pts: rightPts,
      dirty: exact ? it.dirty : true,
      note: undefined,
    };
  } else {
    left = {
      ...it,
      va: it.va,
      vb: midV,
      ha: null,
      hb: null,
      curve: false,
      pts: leftPts ?? [A, pt],
      dirty: exact ? it.dirty : false,
    };
    right = {
      ...it,
      id: next.nextI++,
      va: midV,
      vb: it.vb,
      ha: null,
      hb: null,
      curve: false,
      pts: rightPts ?? [pt, B],
      dirty: exact ? it.dirty : false,
      note: undefined,
    };
  }
  next.items.splice(idx, 1, left, right);
  const out = finishPath(next);
  const lo = out.items.find((i) => i.id === left.id);
  const ro = out.items.find((i) => i.id === right.id);
  const vid = lo ? lo.vb : ro ? ro.va : -1;
  return { buf: out, vid, added: !!lo && !!ro };
}

/** «اتصال شکاف‌ها»: ابتدای قلمِ بعدی روی انتهای قلمِ پیشین جوش می‌خورد */
export function weldGaps(buf: PathBuf): PathBuf {
  const next = cloneBuf(buf);
  for (let i = 0; i + 1 < next.items.length; i++) {
    const a = next.items[i];
    const b = next.items[i + 1];
    if (a.vb === b.va) continue;
    const A = next.verts[a.vb];
    const B = next.verts[b.va];
    next.verts[B.id] = { ...B, z: A.z, x: A.x };
    touch(next, [B.id]);
  }
  return finishPath(next);
}

/** تبدیلِ منحنیِ انتخابی به خطِ straight (برای ساده‌سازی مسیر) */
export function straightenItems(buf: PathBuf, ids: number[]): PathBuf {
  const set = new Set(ids);
  const next = cloneBuf(buf);
  for (const it of next.items) {
    if (!set.has(it.id) || !it.curve) continue;
    it.curve = false;
    it.ha = null;
    it.hb = null;
    it.dirty = true;
    it.pts = null;
  }
  return finishPath(next);
}

/* ---------------- تولید مجددِ برنامه ---------------- */

/** قلم‌ها → آرایهٔ Seg (منحنی‌های ویرایش‌شده نمونه‌برداری می‌شوند) */
export function pathSegs(buf: PathBuf): Seg[] {
  const out: Seg[] = [];
  for (const it of buf.items) {
    const poly = itemPoints(buf, it);
    if (poly.length < 2) continue;
    for (let k = 0; k + 1 < poly.length; k++) {
      const a = poly[k];
      const b = poly[k + 1];
      if (near(a, b, EPS)) continue;
      out.push({
        motion: it.motion,
        x1: a.x,
        z1: a.z,
        x2: b.x,
        z2: b.z,
        feed: it.feed,
        line: -1,
        kind: it.kind,
        op: it.op,
        opId: it.opId,
        holder: it.holder,
        note: k === 0 ? it.note : undefined,
        fan: k === 0 ? it.fan : undefined,
        fanU: k === 0 ? it.fanU : undefined,
      });
    }
  }
  return out;
}

/** برنامه از نو: همان خطوطِ استاندارد/مودال و همان آمار — از روی بافرِ ویرایش‌شده */
export function emitPathProgram(
  buf: PathBuf,
  p: Params,
  base: GenResult,
): GenResult {
  const segs = pathSegs(buf);
  if (!segs.length) return base;
  const { lines, cutLen, rapidLen, timeSec } = buildProgram(segs, p);
  return { ...base, segs, lines, cutLen, rapidLen, timeSec };
}

/** تغییراتِ ثبت‌شده نسبت به برنامهٔ پایه (شمارش قلم‌های دست‌خورده) */
export function changedItemCount(buf: PathBuf, base: Seg[]): number {
  const mine = pathSegs(buf);
  if (mine.length !== base.length) return Math.max(1, pathStats(buf).changed);
  let n = 0;
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    const b = base[i];
    if (
      Math.abs(a.z1 - b.z1) > 1e-9 ||
      Math.abs(a.x1 - b.x1) > 1e-9 ||
      Math.abs(a.z2 - b.z2) > 1e-9 ||
      Math.abs(a.x2 - b.x2) > 1e-9
    )
      n++;
  }
  return n + pathStats(buf).changed;
}
