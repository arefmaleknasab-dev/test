import { useMemo, useRef, useState } from "react";
import { parseIllustrator, transformAiSegments, type AiDocument } from "../lib/ai";
import type { SketchSeg } from "../lib/sketch";
import { IconCheck, IconX } from "./icons";
import { cn } from "../utils/cn";

type Anchor = { x: number; y: number; name: string };
const ANCHORS: Anchor[] = [
  { x: 0, y: 0, name: "بالا چپ" }, { x: .5, y: 0, name: "بالا" }, { x: 1, y: 0, name: "بالا راست" },
  { x: 0, y: .5, name: "چپ" }, { x: .5, y: .5, name: "مرکز" }, { x: 1, y: .5, name: "راست" },
  { x: 0, y: 1, name: "پایین چپ" }, { x: .5, y: 1, name: "پایین" }, { x: 1, y: 1, name: "پایین راست" },
];

function pathOf(segment: SketchSeg) {
  const p = (q: { z: number; r: number }) => `${q.z},${q.r}`;
  if (segment.kind === "line") return `M${p(segment.a)} L${p(segment.b)}`;
  if (segment.kind === "cubic" && segment.c1 && segment.c2) return `M${p(segment.a)} C${p(segment.c1)} ${p(segment.c2)} ${p(segment.b)}`;
  if (segment.kind === "quad" && segment.c1) return `M${p(segment.a)} Q${p(segment.c1)} ${p(segment.b)}`;
  return `M${p(segment.a)} L${p(segment.b)}`;
}

export default function AIImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (segments: SketchSeg[], length: number, diameter: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<AiDocument | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [scaleX, setScaleX] = useState(100);
  const [scaleY, setScaleY] = useState(100);
  const [locked, setLocked] = useState(true);
  const [anchor, setAnchor] = useState<Anchor>(ANCHORS[4]);
  const [margin, setMargin] = useState(0);
  const sx = Math.max(.001, scaleX / 100), sy = Math.max(.001, scaleY / 100);
  const preview = useMemo(() => doc ? transformAiSegments(doc, sx, sy) : [], [doc, sx, sy]);
  const width = (doc?.widthMm ?? 0) * sx, height = (doc?.heightMm ?? 0) * sy;
  /* حاشیه در هر سمت margin است. Origin تعیین می‌کند فضای آزاد کل (۲×margin)
     در کدام سمت طرح قرار بگیرد: چپ/مرکز/راست و بالا/مرکز/پایین. */
  const canvasWidth = width + margin * 2;
  const canvasHeight = height + margin * 2;
  const designX = margin * 2 * anchor.x;
  const designY = margin * 2 * anchor.y;
  const importRShift = canvasHeight - designY - height;
  const imported = useMemo(() => preview.map((segment) => {
    const move = (point: { z: number; r: number }) => ({ z: point.z + designX, r: point.r + importRShift });
    return { ...segment, a: move(segment.a), b: move(segment.b), c1: segment.c1 ? move(segment.c1) : undefined, c2: segment.c2 ? move(segment.c2) : undefined, via: segment.via ? move(segment.via) : undefined };
  }), [preview, designX, importRShift]);

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setError(""); setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".ai")) { setDoc(null); setError("فقط فایل Adobe Illustrator با پسوند .ai قابل انتخاب است."); return; }
    try { setDoc(parseIllustrator(await file.text())); setScaleX(100); setScaleY(100); setAnchor(ANCHORS[4]); setMargin(0); }
    catch (e) { setDoc(null); setError(e instanceof Error ? e.message : "خواندن فایل AI ناموفق بود."); }
  };
  const setScale = (axis: "x" | "y", value: number) => {
    const safe = Math.min(10000, Math.max(.1, Number.isFinite(value) ? value : 100));
    if (axis === "x") { setScaleX(safe); if (locked) setScaleY(safe); }
    else { setScaleY(safe); if (locked) setScaleX(safe); }
  };
  const setFinalDimension = (axis: "width" | "height", value: number) => {
    if (!doc || !Number.isFinite(value) || value <= 0) return;
    if (axis === "width") {
      const percent = value / doc.widthMm * 100;
      setScaleX(percent); if (locked) setScaleY(percent);
    } else {
      const percent = value / doc.heightMm * 100;
      setScaleY(percent); if (locked) setScaleX(percent);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" dir="rtl" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-edge2 bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-edge px-4 py-3">
          <div><h2 className="font-bold text-brass2">وارد کردن Adobe Illustrator</h2><p className="text-[10px] text-mute">پیش‌نمایش، مقیاس و Origin پیش از ایجاد صفحه جدید</p></div>
          <button className="btn !p-2" onClick={onClose}><IconX className="h-4 w-4" /></button>
        </header>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-[1fr_260px]">
          <div className="relative min-h-[360px] overflow-hidden rounded-lg border border-edge bg-[#070b10]">
            {!doc ? <button className="absolute inset-0 m-auto h-24 w-60 rounded-lg border border-dashed border-teal/50 text-sm font-bold text-teal hover:bg-teal/10" onClick={() => inputRef.current?.click()}>انتخاب فایل AI</button> : (
              <>
              {/* مقادیر اصلی خط‌کش قابل ویرایش‌اند و مستقیماً Scale را تغییر می‌دهند. */}
              <label className="absolute top-1.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded border border-[#9aa7b4]/60 bg-[#071018]/95 px-1.5 py-1 text-[9px] text-[#9aa7b4] shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
                W
                <input type="number" min={.001} step={.1} value={Number(width.toFixed(3))} onChange={(e) => setFinalDimension("width", Number(e.target.value))} className="w-16 bg-transparent text-center font-mono text-[10px] text-ink outline-none" dir="ltr" />
                mm
              </label>
              <label className="absolute top-1/2 right-1.5 z-20 flex -translate-y-1/2 items-center gap-1 rounded border border-[#9aa7b4]/60 bg-[#071018]/95 px-1.5 py-1 text-[9px] text-[#9aa7b4] shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
                H
                <input type="number" min={.001} step={.1} value={Number(height.toFixed(3))} onChange={(e) => setFinalDimension("height", Number(e.target.value))} className="w-16 bg-transparent text-center font-mono text-[10px] text-ink outline-none" dir="ltr" />
                mm
              </label>
              <svg
                className="h-full min-h-[360px] w-full"
                viewBox={`${-canvasWidth * .08} ${-canvasHeight * .08} ${canvasWidth * 1.16 || 1} ${canvasHeight * 1.16 || 1}`}
              >
                <rect width={canvasWidth} height={canvasHeight} fill="#111923" stroke="#334155" strokeWidth={Math.max(canvasWidth, canvasHeight) / 500} />
                {/* خط‌کش افقی عرض و خط‌کش عمودی ارتفاع؛ دو سر ضخیم، محدوده واقعی Bounding Box هستند. */}
                <defs>
                  <marker id="ai-ruler-arrow-x" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0 8 4 0 8z" fill="#9aa7b4" /></marker>
                  <marker id="ai-ruler-arrow-y" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0 0 8 4 0 8z" fill="#9aa7b4" /></marker>
                </defs>
                <g pointerEvents="none">
                  <line x1={0} y1={-canvasHeight * .045} x2={canvasWidth} y2={-canvasHeight * .045} stroke="#9aa7b4" strokeWidth={1.2} markerStart="url(#ai-ruler-arrow-x)" markerEnd="url(#ai-ruler-arrow-x)" vectorEffect="non-scaling-stroke" />
                  <line x1={canvasWidth * 1.045} y1={0} x2={canvasWidth * 1.045} y2={canvasHeight} stroke="#9aa7b4" strokeWidth={1.2} markerStart="url(#ai-ruler-arrow-y)" markerEnd="url(#ai-ruler-arrow-y)" vectorEffect="non-scaling-stroke" />
                </g>
                <g fill="none" stroke="#46d7ba" strokeWidth={Math.max(canvasWidth, canvasHeight) / 350} vectorEffect="non-scaling-stroke">{preview.map((segment) => <path key={segment.id} d={pathOf({ ...segment, a: { z: designX + segment.a.z, r: designY + height - segment.a.r }, b: { z: designX + segment.b.z, r: designY + height - segment.b.r }, c1: segment.c1 ? { z: designX + segment.c1.z, r: designY + height - segment.c1.r } : undefined, c2: segment.c2 ? { z: designX + segment.c2.z, r: designY + height - segment.c2.r } : undefined })} />)}</g>
                <g transform={`translate(${designX + anchor.x * width} ${designY + anchor.y * height})`}><circle r={Math.max(canvasWidth, canvasHeight) / 90} fill="#ffcf66" stroke="#111" strokeWidth={2} vectorEffect="non-scaling-stroke" /><path d={`M${-Math.max(canvasWidth,canvasHeight)/50} 0H${Math.max(canvasWidth,canvasHeight)/50}M0 ${-Math.max(canvasWidth,canvasHeight)/50}V${Math.max(canvasWidth,canvasHeight)/50}`} stroke="#ffcf66" strokeWidth={1.25} vectorEffect="non-scaling-stroke" /></g>
              </svg>
              </>
            )}
          </div>
          <aside className="space-y-3">
            <input ref={inputRef} type="file" accept=".ai,application/postscript" className="hidden" onChange={(e) => chooseFile(e.target.files?.[0])} />
            <button className="btn btn-teal w-full" onClick={() => inputRef.current?.click()}>{doc ? "انتخاب فایل دیگر" : "انتخاب فایل AI"}</button>
            {fileName && <div className="truncate rounded border border-edge bg-bg/50 px-2 py-1 font-mono text-[10px] text-mute" dir="ltr">{fileName}</div>}
            {error && <div className="rounded border border-danger/40 bg-danger/10 p-2 text-[10px] leading-5 text-danger">{error}</div>}
            {doc && <>
              <div className="rounded-lg border border-edge p-2 text-[10px] text-mute"><div>ابعاد اصلی: <b dir="ltr" className="text-ink">{doc.widthMm.toFixed(2)} × {doc.heightMm.toFixed(2)} mm</b></div><div>ابعاد نهایی طرح: <b dir="ltr" className="text-teal">{width.toFixed(2)} × {height.toFixed(2)} mm</b></div><div>صفحه با حاشیه L×D: <b dir="ltr" className="text-brass2">{canvasWidth.toFixed(2)} × {(canvasHeight * 2).toFixed(2)} mm</b></div><div>{doc.segments.length.toLocaleString("fa-IR")} مسیر قابل ویرایش</div></div>
              <div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-mute">Scale X %<input className="field-input mt-1" type="number" value={scaleX} min={.1} max={10000} onChange={(e) => setScale("x", Number(e.target.value))} /></label><label className="text-[10px] text-mute">Scale Y %<input className="field-input mt-1" type="number" value={scaleY} min={.1} max={10000} onChange={(e) => setScale("y", Number(e.target.value))} /></label></div>
              <label className="block text-[10px] text-mute">حاشیه (mm)<input className="field-input mt-1" type="number" value={margin} min={0} max={200} step={1} onChange={(e) => setMargin(Math.min(200, Math.max(0, Number(e.target.value) || 0)))} /></label>
              <button className={cn("chip-toggle w-full justify-center", locked ? "border-teal/50 text-teal" : "border-edge text-mute")} onClick={() => setLocked(!locked)}><IconCheck className="h-3 w-3" /> حفظ نسبت ابعاد</button>
              <div><div className="mb-1 text-[10px] font-bold text-mute">Origin / Anchor</div><div className="grid grid-cols-3 gap-1" dir="ltr">{ANCHORS.map((item) => <button key={item.name} title={item.name} className={cn("h-7 rounded border", Math.abs(anchor.x-item.x)<.001 && Math.abs(anchor.y-item.y)<.001 ? "border-brass bg-brass/15" : "border-edge bg-bg/40")} onClick={() => setAnchor(item)}><span className="mx-auto block h-1.5 w-1.5 rounded-full bg-brass2" /></button>)}</div></div>
              <div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-mute">Origin X %<input className="field-input mt-1" type="number" value={Number((anchor.x*100).toFixed(2))} onChange={(e) => setAnchor({ x: Math.min(1,Math.max(0,Number(e.target.value)/100)), y: anchor.y, name: "دستی" })} /></label><label className="text-[10px] text-mute">Origin Y %<input className="field-input mt-1" type="number" value={Number((anchor.y*100).toFixed(2))} onChange={(e) => setAnchor({ x: anchor.x, y: Math.min(1,Math.max(0,Number(e.target.value)/100)), name: "دستی" })} /></label></div>
              {doc.warnings.map((warning) => <div key={warning} className="text-[9px] text-brass">{warning}</div>)}
            </>}
          </aside>
        </div>
        <footer className="flex items-center justify-between border-t border-edge px-4 py-3"><span className="text-[9px] text-dim">AI Legacy/EPS · خطوط و Bézier به هندسه قابل ویرایش تبدیل می‌شوند</span><div className="flex gap-2"><button className="btn" onClick={onClose}>لغو</button><button className="btn btn-brass" disabled={!doc} onClick={() => doc && onImport(imported, Math.max(1,canvasWidth), Math.max(1,canvasHeight * 2))}>ایجاد صفحه و وارد کردن</button></div></footer>
      </div>
    </div>
  );
}
