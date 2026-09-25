/* ------------------------------------------------------------------ */
/*  خروجی DXF — فقط مسیر عملیات تراش (حرکات برشی)، به ترتیب استراتژی      */
/*  • لایهٔ CUTPATH: کل مسیر برشی به‌صورت یک خط یکپارچه                    */
/*  • لایهٔ مجزا برای هر عملیات: OP1-FACING ، OP2-ROUGH-D ، …             */
/*  دستگاه مختصات مطابق جی‌کد: X = طول قطعه ، Y = قطر (صفحه XY)           */
/* ------------------------------------------------------------------ */

import type { Op, OpType, Seg } from "./lathe";

/* رنگ‌های ACI متناسب با رنگ عملیات‌ها در نرم‌افزار */
const ACI: Record<OpType, number> = {
  round: 134, // بنفش — گرد کردن گوشه‌ها
  face: 2, // زرد — پیشانی‌تراشی
  "rough-d": 3, // سبز — خشن شعاعی
  "rough-z": 5, // آبی — خشن محوری
  copy: 4, // فیروزه‌ای — کپی‌تراشی
  offset: 1, // قرمز — آفست
  finish: 30, // نارنجی — پرداخت
  "inner-rough": 6, // سرخابی — خشن داخل
  "inner-offset": 202, // بنفش — آفست داخل‌تراشی
  "inner-finish": 96, // آبی روشن — پرداخت داخل
  bottom: 7, // سفید — کف‌تراشی
};

interface DxfLayer {
  name: string;
  color: number;
  runs: [number, number][][];
  closed: boolean;
}

export interface DxfResult {
  text: string;
  vertexCount: number; // نقاط خط یکپارچه
  opCount: number; // تعداد عملیات‌های دارای مسیر
}

const f = (v: number) => (Math.round(v * 10000) / 10000).toFixed(4);

export function buildDxf(segs: Seg[], ops: Op[], blankL: number, blankR: number): DxfResult {
  /* خط یکپارچهٔ کل مسیر برشی (به ترتیب اجرا) */
  const cut: [number, number][] = [];
  for (const s of segs) {
    if (s.motion !== 1) continue;
    if (!cut.length) cut.push([s.z1, s.x1 / 2]);
    cut.push([s.z2, s.x2 / 2]);
  }

  /* مسیر هر عملیات به تفکیک — شکسته‌شده در حرکات سریع */
  const runsByOp = new Map<number, [number, number][][]>();
  for (const o of ops) if (o.on) runsByOp.set(o.id, []);
  let cur: [number, number][] | null = null;
  let curId = -1;
  const flush = () => {
    if (cur && cur.length > 1 && runsByOp.has(curId)) runsByOp.get(curId)!.push(cur);
    cur = null;
  };
  for (const s of segs) {
    if (s.motion === 1) {
      if (!cur || curId !== s.opId) {
        flush();
        curId = s.opId;
        cur = [[s.z1, s.x1 / 2]];
      }
      cur.push([s.z2, s.x2 / 2]);
    } else flush();
  }
  flush();

  /* لایه‌ها */
  const layers: DxfLayer[] = [];
  if (cut.length > 1) layers.push({ name: "CUTPATH", color: 7, runs: [cut], closed: false });
  let idx = 0;
  for (const o of ops) {
    if (!o.on) continue;
    const runs = runsByOp.get(o.id) ?? [];
    if (!runs.length) continue;
    idx++;
    /* مختصات در فضای قطعه؛ عملیات هلدر دوم با پسوند H2 مشخص می‌شوند */
    layers.push({ name: `OP${idx}-${o.type.toUpperCase()}${o.holder === 2 ? "-H2" : ""}`, color: ACI[o.type], runs, closed: false });
  }

  /* محدوده ترسیم */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const L of layers)
    for (const run of L.runs)
      for (const [x, y] of run) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (!isFinite(minX)) {
    minX = 0;
    minY = -blankR;
    maxX = blankL;
    maxY = blankR;
  }

  const out: string[] = [];
  const w = (code: number, val: string | number) => {
    out.push(String(code), String(val));
  };

  /* HEADER */
  w(0, "SECTION");
  w(2, "HEADER");
  w(9, "$ACADVER");
  w(1, "AC1015");
  w(9, "$INSUNITS");
  w(70, 4); // میلی‌متر
  w(9, "$EXTMIN");
  w(10, f(minX));
  w(20, f(minY));
  w(30, 0);
  w(9, "$EXTMAX");
  w(10, f(maxX));
  w(20, f(maxY));
  w(30, 0);
  w(0, "ENDSEC");

  /* TABLES */
  w(0, "SECTION");
  w(2, "TABLES");
  w(0, "TABLE");
  w(2, "LAYER");
  w(70, layers.length);
  for (const L of layers) {
    w(0, "LAYER");
    w(2, L.name);
    w(70, 0);
    w(62, L.color);
    w(6, "CONTINUOUS");
  }
  w(0, "ENDTAB");
  w(0, "ENDSEC");

  /* ENTITIES */
  w(0, "SECTION");
  w(2, "ENTITIES");
  for (const L of layers) {
    for (const run of L.runs) {
      if (run.length < 2) continue;
      w(0, "LWPOLYLINE");
      w(8, L.name);
      w(90, run.length);
      w(70, L.closed ? 1 : 0);
      w(62, L.color);
      for (const [x, y] of run) {
        w(10, f(x));
        w(20, f(y));
      }
    }
  }
  w(0, "ENDSEC");
  w(0, "EOF");

  return { text: out.join("\n"), vertexCount: cut.length, opCount: idx };
}
