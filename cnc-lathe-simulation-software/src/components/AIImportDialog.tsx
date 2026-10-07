import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  const sx = Math.max(.001, scaleX / 100), sy = Math.max(.001, scaleY / 100);
  const preview = useMemo(() => doc ? transformAiSegments(doc, sx, sy) : [], [doc, sx, sy]);
  const width = (doc?.widthMm ?? 0) * sx, height = (doc?.heightMm ?? 0) * sy;

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setError(""); setFileName(file.name);
    if (!file.name.toLowerCase().endsWith(".ai")) { setDoc(null); setError("فقط فایل Adobe Illustrator با پسوند .ai قابل انتخاب است."); return; }
    try { setDoc(parseIllustrator(await file.text())); setScaleX(100); setScaleY(100); setAnchor(ANCHORS[4]); }
    catch (e) { setDoc(null); setError(e instanceof Error ? e.message : "خواندن فایل AI ناموفق بود."); }
  };
  const setScale = (axis: "x" | "y", value: number) => {
    const safe = Math.min(10000, Math.max(.1, Number.isFinite(value) ? value : 100));
    if (axis === "x") { setScaleX(safe); if (locked) setScaleY(safe); }
    else { setScaleY(safe); if (locked) setScaleX(safe); }
  };
  const moveAnchor = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    /* preserveAspectRatio فضای letterbox می‌سازد؛ آن حاشیه و ۸٪ فضای viewBox
       هر دو حذف می‌شوند تا Origin هنگام Drag دقیقاً زیر نشانگر بماند. */
    const vbW = Math.max(1e-9, width * 1.16), vbH = Math.max(1e-9, height * 1.16);
    const renderScale = Math.min(rect.width / vbW, rect.height / vbH);
    const renderedW = vbW * renderScale, renderedH = vbH * renderScale;
    const offsetX = (rect.width - renderedW) / 2, offsetY = (rect.height - renderedH) / 2;
    const localX = (event.clientX - rect.left - offsetX) / renderScale + width * .08;
    const localY = (event.clientY - rect.top - offsetY) / renderScale + height * .08;
    setAnchor({ x: Math.min(1, Math.max(0, localX / width)), y: Math.min(1, Math.max(0, localY / height)), name: "دستی" });
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
              <label className="absolute top-1.5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded border border-teal/50 bg-[#071018]/95 px-1.5 py-1 text-[9px] text-teal shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
                W
                <input type="number" min={.001} step={.1} value={Number(width.toFixed(3))} onChange={(e) => setFinalDimension("width", Number(e.target.value))} className="w-16 bg-transparent text-center font-mono text-[10px] text-ink outline-none" dir="ltr" />
                mm
              </label>
              <label className="absolute top-1/2 right-1.5 z-20 flex -translate-y-1/2 items-center gap-1 rounded border border-brass/50 bg-[#071018]/95 px-1.5 py-1 text-[9px] text-brass2 shadow-lg" onPointerDown={(e) => e.stopPropagation()}>
                H
                <input type="number" min={.001} step={.1} value={Number(height.toFixed(3))} onChange={(e) => setFinalDimension("height", Number(e.target.value))} className="w-16 bg-transparent text-center font-mono text-[10px] text-ink outline-none" dir="ltr" />
                mm
              </label>
              <svg
                className="h-full min-h-[360px] w-full touch-none cursor-crosshair"
                viewBox={`${-width * .08} ${-height * .08} ${width * 1.16 || 1} ${height * 1.16 || 1}`}
                onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); moveAnchor(event); }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveAnchor(event); }}
                onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              >
                <rect width={width} height={height} fill="#111923" stroke="#334155" strokeWidth={Math.max(width, height) / 500} />
                {/* خط‌کش افقی عرض و خط‌کش عمودی ارتفاع؛ دو سر ضخیم، محدوده واقعی Bounding Box هستند. */}
                <g pointerEvents="none" fontFamily="ui-monospace, monospace" fontSize={Math.max(width, height) / 42}>
                  <line x1={0} y1={-height * .045} x2={width} y2={-height * .045} stroke="#28dfc2" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                  {[0, .25, .5, .75, 1].map((tick) => <g key={`rx${tick}`} transform={`translate(${width * tick} ${-height * .045})`}><line y1={-height * (tick === 0 || tick === 1 ? .025 : .015)} y2={height * .015} stroke="#28dfc2" strokeWidth={tick === 0 || tick === 1 ? 2 : 1} vectorEffect="non-scaling-stroke" /><text y={-height * .022} textAnchor={tick === 0 ? "start" : tick === 1 ? "end" : "middle"} fill="#84f5df">{(width * tick).toFixed(width < 10 ? 2 : 1)}</text></g>)}
                  <line x1={width * 1.045} y1={0} x2={width * 1.045} y2={height} stroke="#e3a94e" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                  {[0, .25, .5, .75, 1].map((tick) => <g key={`ry${tick}`} transform={`translate(${width * 1.045} ${height * tick})`}><line x1={-width * .015} x2={width * (tick === 0 || tick === 1 ? .025 : .015)} stroke="#e3a94e" strokeWidth={tick === 0 || tick === 1 ? 2 : 1} vectorEffect="non-scaling-stroke" /><text x={width * .018} y={height * .009} fill="#f3c26b">{(height * tick).toFixed(height < 10 ? 2 : 1)}</text></g>)}
                </g>
                <g fill="none" stroke="#46d7ba" strokeWidth={Math.max(width, height) / 350} vectorEffect="non-scaling-stroke">{preview.map((segment) => <path key={segment.id} d={pathOf({ ...segment, a: { z: segment.a.z, r: height - segment.a.r }, b: { z: segment.b.z, r: height - segment.b.r }, c1: segment.c1 ? { z: segment.c1.z, r: height - segment.c1.r } : undefined, c2: segment.c2 ? { z: segment.c2.z, r: height - segment.c2.r } : undefined })} />)}</g>
                <g transform={`translate(${anchor.x * width} ${anchor.y * height})`}><circle r={Math.max(width, height) / 45} fill="#ffcf66" stroke="#111" strokeWidth={2} vectorEffect="non-scaling-stroke" /><path d={`M${-Math.max(width,height)/25} 0H${Math.max(width,height)/25}M0 ${-Math.max(width,height)/25}V${Math.max(width,height)/25}`} stroke="#ffcf66" strokeWidth={2} vectorEffect="non-scaling-stroke" /></g>
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
              <div className="rounded-lg border border-edge p-2 text-[10px] text-mute"><div>ابعاد اصلی: <b dir="ltr" className="text-ink">{doc.widthMm.toFixed(2)} × {doc.heightMm.toFixed(2)} mm</b></div><div>ابعاد نهایی طرح: <b dir="ltr" className="text-teal">{width.toFixed(2)} × {height.toFixed(2)} mm</b></div><div>صفحه تراش L×D: <b dir="ltr" className="text-brass2">{width.toFixed(2)} × {(height * 2).toFixed(2)} mm</b></div><div>{doc.segments.length.toLocaleString("fa-IR")} مسیر قابل ویرایش</div></div>
              <div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-mute">Scale X %<input className="field-input mt-1" type="number" value={scaleX} min={.1} max={10000} onChange={(e) => setScale("x", Number(e.target.value))} /></label><label className="text-[10px] text-mute">Scale Y %<input className="field-input mt-1" type="number" value={scaleY} min={.1} max={10000} onChange={(e) => setScale("y", Number(e.target.value))} /></label></div>
              <button className={cn("chip-toggle w-full justify-center", locked ? "border-teal/50 text-teal" : "border-edge text-mute")} onClick={() => setLocked(!locked)}><IconCheck className="h-3 w-3" /> حفظ نسبت ابعاد</button>
              <div><div className="mb-1 text-[10px] font-bold text-mute">Origin / Anchor</div><div className="grid grid-cols-3 gap-1" dir="ltr">{ANCHORS.map((item) => <button key={item.name} title={item.name} className={cn("h-7 rounded border", Math.abs(anchor.x-item.x)<.001 && Math.abs(anchor.y-item.y)<.001 ? "border-brass bg-brass/15" : "border-edge bg-bg/40")} onClick={() => setAnchor(item)}><span className="mx-auto block h-1.5 w-1.5 rounded-full bg-brass2" /></button>)}</div></div>
              <div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-mute">Origin X %<input className="field-input mt-1" type="number" value={Number((anchor.x*100).toFixed(2))} onChange={(e) => setAnchor({ x: Math.min(1,Math.max(0,Number(e.target.value)/100)), y: anchor.y, name: "دستی" })} /></label><label className="text-[10px] text-mute">Origin Y %<input className="field-input mt-1" type="number" value={Number((anchor.y*100).toFixed(2))} onChange={(e) => setAnchor({ x: anchor.x, y: Math.min(1,Math.max(0,Number(e.target.value)/100)), name: "دستی" })} /></label></div>
              {doc.warnings.map((warning) => <div key={warning} className="text-[9px] text-brass">{warning}</div>)}
            </>}
          </aside>
        </div>
        <footer className="flex items-center justify-between border-t border-edge px-4 py-3"><span className="text-[9px] text-dim">AI Legacy/EPS · خطوط و Bézier به هندسه قابل ویرایش تبدیل می‌شوند</span><div className="flex gap-2"><button className="btn" onClick={onClose}>لغو</button><button className="btn btn-brass" disabled={!doc} onClick={() => doc && onImport(preview, Math.max(1,width), Math.max(1,height * 2))}>ایجاد صفحه و وارد کردن</button></div></footer>
      </div>
    </div>
  );
}
