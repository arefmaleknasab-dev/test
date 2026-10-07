import type { SketchSeg, SPoint } from "./sketch";

export interface AiBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface AiDocument { segments: SketchSeg[]; bounds: AiBounds; widthMm: number; heightMm: number; warnings: string[] }

const PT_TO_MM = 25.4 / 72;

/**
 * Reads Illustrator files saved with "Create PDF Compatible File" disabled / legacy EPS.
 * Modern PDF-compatible AI is detected explicitly so the UI can explain the limitation.
 */
export function parseIllustrator(text: string): AiDocument {
  if (text.slice(0, 1024).includes("%PDF-")) {
    throw new Error("این فایل AI بر پایه PDF است. در Illustrator آن را با فرمت Illustrator 8 (Legacy/EPS) ذخیره و دوباره وارد کنید.");
  }
  if (!text.includes("%!PS-Adobe") && !text.includes("Adobe Illustrator")) {
    throw new Error("ساختار فایل AI شناسایی نشد. فایل باید AI قدیمی مبتنی بر EPS باشد.");
  }

  const clean = text
    .replace(/%[^\r\n]*/g, " ")
    .replace(/\([^)]*\)/g, " ");
  const tokens = clean.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z*]+/g) ?? [];
  const stack: number[] = [];
  const segments: SketchSeg[] = [];
  const warnings: string[] = [];
  let id = 700000;
  let current: SPoint | null = null;
  let start: SPoint | null = null;
  const point = (x: number, y: number): SPoint => ({ z: x * PT_TO_MM, r: y * PT_TO_MM });
  const pop = (n: number) => stack.splice(Math.max(0, stack.length - n), n);

  for (const token of tokens) {
    const value = Number(token);
    if (Number.isFinite(value)) { stack.push(value); continue; }
    const op = token.toLowerCase();
    if (op === "m" || op === "moveto") {
      const a = pop(2); if (a.length === 2) { current = point(a[0], a[1]); start = { ...current }; }
    } else if (op === "l" || op === "lineto") {
      const a = pop(2); if (a.length === 2 && current) { const next = point(a[0], a[1]); segments.push({ id: ++id, kind: "line", a: current, b: next }); current = next; }
    } else if (op === "c" || op === "curveto") {
      const a = pop(6); if (a.length === 6 && current) { const c1 = point(a[0], a[1]), c2 = point(a[2], a[3]), next = point(a[4], a[5]); segments.push({ id: ++id, kind: "cubic", a: current, b: next, c1, c2 }); current = next; }
    } else if (op === "v" && current) {
      const a = pop(4); if (a.length === 4) { const c2 = point(a[0], a[1]), next = point(a[2], a[3]); segments.push({ id: ++id, kind: "cubic", a: current, b: next, c1: { ...current }, c2 }); current = next; }
    } else if (op === "y" && current) {
      const a = pop(4); if (a.length === 4) { const c1 = point(a[0], a[1]), next = point(a[2], a[3]); segments.push({ id: ++id, kind: "cubic", a: current, b: next, c1, c2: { ...next } }); current = next; }
    } else if ((op === "h" || op === "closepath") && current && start) {
      if (Math.hypot(current.z - start.z, current.r - start.r) > 1e-8) segments.push({ id: ++id, kind: "line", a: current, b: { ...start } });
      current = { ...start };
    } else if (["n", "s", "f", "b", "w", "j", "d", "g", "k", "rg", "re"].includes(op)) {
      stack.length = 0;
    } else if (stack.length > 64) stack.splice(0, stack.length - 16);
  }
  if (!segments.length) throw new Error("هیچ مسیر برداری قابل ویرایشی در فایل پیدا نشد. متن، تصویر Raster، Mask و Effect قابل وارد کردن نیستند.");

  const points = segments.flatMap((s) => [s.a, s.b, ...(s.c1 ? [s.c1] : []), ...(s.c2 ? [s.c2] : [])]);
  const bounds = { minX: Math.min(...points.map((p) => p.z)), minY: Math.min(...points.map((p) => p.r)), maxX: Math.max(...points.map((p) => p.z)), maxY: Math.max(...points.map((p) => p.r)) };
  if (segments.length > 4000) warnings.push("فایل دارای مسیرهای بسیار زیادی است و ممکن است ویرایش آن سنگین باشد.");
  return { segments, bounds, widthMm: bounds.maxX - bounds.minX, heightMm: bounds.maxY - bounds.minY, warnings };
}

export function transformAiSegments(doc: AiDocument, scaleX: number, scaleY = scaleX): SketchSeg[] {
  const mapPoint = (p: SPoint): SPoint => ({ z: (p.z - doc.bounds.minX) * scaleX, r: (doc.bounds.maxY - p.r) * scaleY / 2 });
  return doc.segments.map((s, index) => ({
    ...s,
    id: 800000 + index,
    a: mapPoint(s.a), b: mapPoint(s.b),
    c1: s.c1 ? mapPoint(s.c1) : undefined,
    c2: s.c2 ? mapPoint(s.c2) : undefined,
    via: s.via ? mapPoint(s.via) : undefined,
  }));
}
