import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { IconSettings, IconX } from "./icons";
import { cn } from "../utils/cn";

export interface AppPreferences {
  theme: "lathe" | "midnight" | "graphite";
  profileColor: string;
  selectedColor: string;
  guideColor: string;
  lineWidth: number;
  toolbarScale: number;
  /** نگه‌داری تغییرات تأییدنشده پس از خروج از ویرایش مسیر. */
  keepEditDraft: boolean;
  historyLimit: number;
  showHeaderImportAi: boolean;
  showHeaderExportDxf: boolean;
  showHeaderCopyGcode: boolean;
  showHeaderDownloadNc: boolean;
  shortcuts: Record<string, string>;
  postProcessor: "fanuc" | "linuxcnc" | "generic";
  gcodeUnits: "mm" | "inch";
  sequenceNumbers: boolean;
  gcodeFormat: "modal" | "std";
  continuousPaths: boolean;
  safeBottomInnerLink: boolean;
  optimizeFeeds: boolean;
  spreadRapid: boolean;
  spindleSpeed: number;
  operationFeeds: Record<string, number>;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "lathe", profileColor: "#e3a94e", selectedColor: "#45b394", guideColor: "#4cc9f0",
  lineWidth: 2, toolbarScale: 1, keepEditDraft: false, historyLimit: 40,
  showHeaderImportAi: true, showHeaderExportDxf: true, showHeaderCopyGcode: true, showHeaderDownloadNc: true,
  shortcuts: { select:"v", move:"m", rotate:"r", boxscale:"b", scale:"s", copy:"c", mirror:"i", fillet:"f", line:"l", polyline:"p", quad:"q", cubic:"u", arc:"a", split:"x" },
  postProcessor: "fanuc", gcodeUnits: "mm", sequenceNumbers: true, gcodeFormat: "modal", continuousPaths: true, safeBottomInnerLink: true, optimizeFeeds: true, spreadRapid: false, spindleSpeed: 1500,
  operationFeeds: { round:2000, face:100, rough:2000, roughz:2000, copy:2000, offset:500, finish:100, bottom:300, bore:300, boreoff:300, borefin:150 },
};

const FEED_LABELS: [string,string][] = [["round","گرد کردن گوشه‌ها"],["face","پیشانی‌تراشی"],["rough","خشن شعاعی"],["offset","آفست"],["finish","پرداخت نهایی"],["bottom","کف‌تراشی"],["bore","خشن داخل"],["boreoff","آفست داخل"],["borefin","پرداخت داخل"]];
const SHORTCUT_LABELS: Record<string,string> = { select:"انتخاب", move:"حرکت", rotate:"چرخش", boxscale:"مقیاس باکس", scale:"مقیاس مرجع", copy:"کپی", mirror:"آینه", fillet:"فیلت", line:"خط", polyline:"چندخطی", quad:"منحنی درجه دو", cubic:"منحنی بزیه", arc:"قوس", split:"تقسیم" };

export default function PreferencesDialog({ value, snapTolerance, onChange, onSnapTolerance, onClose }: {
  value: AppPreferences; snapTolerance: number; onChange: (next: AppPreferences) => void;
  onSnapTolerance: (value: number) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"general" | "snap" | "appearance" | "post" | "shortcuts">("general");
  const [query, setQuery] = useState("");
  const [frame, setFrame] = useState(() => ({ x: Math.max(16, (window.innerWidth - 672) / 2), y: Math.max(16, (window.innerHeight - 470) / 2), w: Math.min(672, window.innerWidth - 32), h: Math.min(470, window.innerHeight - 32) }));
  const drag = useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const resize = useRef<{edge:string;x:number;y:number;frame:typeof frame}|null>(null);
  const patch = (p: Partial<AppPreferences>) => onChange({ ...value, ...p });
  const moveFrame = (e: ReactPointerEvent<HTMLElement>) => {
    const d=drag.current;
    if(d) setFrame(f=>({...f,x:Math.max(0,Math.min(window.innerWidth-80,d.left+e.clientX-d.x)),y:Math.max(0,Math.min(window.innerHeight-40,d.top+e.clientY-d.y))}));
    const r=resize.current;if(!r)return;const dx=e.clientX-r.x,dy=e.clientY-r.y;let {x,y,w,h}=r.frame;
    if(r.edge.includes("e")) w=Math.max(480,Math.min(window.innerWidth-x,w+dx));
    if(r.edge.includes("s")) h=Math.max(360,Math.min(window.innerHeight-y,h+dy));
    if(r.edge.includes("w")){const nw=Math.max(480,w-dx);x=Math.max(0,x+w-nw);w=nw;}
    if(r.edge.includes("n")){const nh=Math.max(360,h-dy);y=Math.max(0,y+h-nh);h=nh;}
    setFrame({x,y,w,h});
  };
  const beginResize=(edge:string)=>(e:ReactPointerEvent<HTMLDivElement>)=>{e.preventDefault();e.stopPropagation();resize.current={edge,x:e.clientX,y:e.clientY,frame:{...frame}};(e.currentTarget.parentElement as HTMLElement).setPointerCapture?.(e.pointerId);};
  return <div className="pointer-events-none fixed inset-0 z-[100]" dir="rtl">
    <section dir="ltr" className="anim-in pointer-events-auto absolute flex min-h-[360px] min-w-[480px] flex-col overflow-hidden rounded-xl border border-edge2 bg-panel/98 shadow-2xl shadow-black/70" style={{left:frame.x,top:frame.y,width:frame.w,height:frame.h,maxWidth:"calc(100vw - 16px)",maxHeight:"calc(100vh - 16px)"}} onPointerMove={moveFrame} onPointerUp={()=>{drag.current=null;resize.current=null;}}>
      <div onPointerDown={beginResize("n")} className="absolute top-0 right-3 left-3 z-50 h-2 cursor-n-resize" />
      <div onPointerDown={beginResize("s")} className="absolute right-3 bottom-0 left-3 z-50 h-2 cursor-s-resize" />
      <div onPointerDown={beginResize("e")} className="absolute top-3 right-0 bottom-3 z-50 w-2 cursor-e-resize" />
      <div onPointerDown={beginResize("w")} className="absolute top-3 bottom-3 left-0 z-50 w-2 cursor-w-resize" />
      <div onPointerDown={beginResize("ne")} className="absolute top-0 right-0 z-[51] h-3 w-3 cursor-ne-resize" />
      <div onPointerDown={beginResize("nw")} className="absolute top-0 left-0 z-[51] h-3 w-3 cursor-nw-resize" />
      <div onPointerDown={beginResize("se")} className="absolute right-0 bottom-0 z-[51] h-3 w-3 cursor-se-resize" />
      <div onPointerDown={beginResize("sw")} className="absolute bottom-0 left-0 z-[51] h-3 w-3 cursor-sw-resize" />
      <header dir="rtl" className="flex cursor-move select-none items-center justify-between border-b border-edge bg-panel2/90 px-4 py-3" onPointerDown={e=>{if((e.target as HTMLElement).closest("button,input"))return;drag.current={x:e.clientX,y:e.clientY,left:frame.x,top:frame.y};e.currentTarget.setPointerCapture?.(e.pointerId);}}>
        <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg border border-brass/35 bg-brass/10 text-brass2"><IconSettings className="h-4.5 w-4.5"/></span><div><h2 className="text-sm font-bold text-ink">Preferences</h2><p className="text-[9.5px] text-dim">تنظیمات عمومی خراط‌کد</p></div></div>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="جست‌وجوی تنظیمات…" className="mx-4 h-8 min-w-0 flex-1 rounded-md border border-edge bg-bg/70 px-3 text-[11px] text-ink outline-none focus:border-teal" />
        <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-panel3 hover:text-ink"><IconX className="h-4 w-4"/></button>
      </header>
      <div dir="rtl" className="grid min-h-0 flex-1 grid-cols-[145px_1fr] overflow-auto">
        <nav className="space-y-1 border-l border-edge bg-[#110e0a]/50 p-2">
          {[["general","تنظیمات عمومی","پیش نویس ویرایش مسیر خروج تایید تغییرات"],["snap","اسنپ و دقت","حساسیت پیکسل نقاط تقاطع محور"],["appearance","رنگ، خطوط و تم","ظاهر ضخامت نوار ابزار دکمه اندازه"],["shortcuts","کلیدهای میانبر","کیبورد ابزار انتخاب حرکت چرخش مقیاس کپی"],["post","تنظیمات جی‌کد","سرعت فید عملیات فانوک لینوکس واحد میلیمتر اینچ شماره خط"]].filter(([,label,keywords])=>!query || `${label} ${keywords}`.includes(query.trim().toLowerCase())).map(([id,label])=><button key={id} onClick={()=>setTab(id as typeof tab)} className={cn("w-full rounded-md px-3 py-2 text-right text-[11px] font-bold",tab===id?"bg-brass/15 text-brass2":"text-mute hover:bg-panel3 hover:text-ink")}>{label}</button>)}
        </nav>
        <div className="p-5">
          {tab==="general" && <div><Title title="تنظیمات عمومی" text="رفتارهای عمومی نرم‌افزار" onReset={()=>patch({keepEditDraft:DEFAULT_PREFERENCES.keepEditDraft,historyLimit:DEFAULT_PREFERENCES.historyLimit,showHeaderImportAi:true,showHeaderExportDxf:true,showHeaderCopyGcode:true,showHeaderDownloadNc:true})}/><label className="mt-5 flex items-start gap-3 rounded-lg border border-edge bg-panel2 p-4 text-[11px] text-ink"><input type="checkbox" checked={value.keepEditDraft} onChange={e=>patch({keepEditDraft:e.target.checked})} className="mt-0.5 accent-[#e3a94e]"/><span><b className="block">حفظ پیش‌نویس ویرایش مسیر</b><small className="mt-1 block text-[9.5px] leading-5 text-dim">در حالت روشن، تغییرات تأییدنشده پس از خروج حفظ می‌شوند. در حالت خاموش، هنگام خروج درباره ذخیره یا حذف تغییرات سؤال می‌شود.</small></span></label><label className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-edge bg-panel2 p-3 text-[11px] text-ink"><span><b className="block">تعداد تغییرات Undo / Redo</b><small className="mt-1 block text-[9px] text-dim">حداکثر ۲۰۰ تغییر</small></span><input type="number" min={1} max={200} step={1} value={value.historyLimit} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))patch({historyLimit:Math.min(200,Math.max(1,Math.round(n)))});}} className="h-8 w-20 rounded border border-edge2 bg-bg px-2 text-center font-mono text-xs text-teal outline-none focus:border-teal"/></label><div className="mt-4"><div className="mb-2 text-[11px] font-bold text-ink">دکمه‌های نوار بالای نرم‌افزار</div><div className="grid grid-cols-2 gap-2">{[["showHeaderImportAi","ورود AI"],["showHeaderExportDxf","خروجی DXF"],["showHeaderCopyGcode","کپی جی‌کد"],["showHeaderDownloadNc","دانلود NC"]].map(([key,label])=><label key={key} className="flex items-center gap-2 rounded-md border border-edge bg-panel2 px-3 py-2 text-[10.5px] text-ink"><input type="checkbox" checked={Boolean(value[key as keyof AppPreferences])} onChange={e=>patch({[key]:e.target.checked})} className="accent-[#e3a94e]"/>{label}</label>)}</div></div></div>}
          {tab==="snap" && <div><Title title="حساسیت اسنپ" text="فاصله تشخیص نقاط، تقاطع‌ها و محور بر حسب پیکسل" onReset={()=>onSnapTolerance(11)}/><div className="mt-6 rounded-lg border border-edge bg-panel2 p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs text-ink">حساسیت پیکسلی</span><b className="font-mono text-sm text-teal">{snapTolerance}px</b></div><input type="range" min={3} max={30} step={1} value={snapTolerance} onChange={e=>onSnapTolerance(Number(e.target.value))} className="w-full accent-[#45b394]"/><div className="mt-2 flex justify-between text-[9px] text-dim"><span>دقیق ۳px</span><span>حساس ۳۰px</span></div></div></div>}
          {tab==="appearance" && <div><Title title="ظاهر نرم‌افزار" text="رنگ خطوط، ضخامت و تم رابط کاربری" onReset={()=>patch({theme:DEFAULT_PREFERENCES.theme,profileColor:DEFAULT_PREFERENCES.profileColor,selectedColor:DEFAULT_PREFERENCES.selectedColor,guideColor:DEFAULT_PREFERENCES.guideColor,lineWidth:DEFAULT_PREFERENCES.lineWidth,toolbarScale:DEFAULT_PREFERENCES.toolbarScale})}/><label className="mt-5 block text-[10px] text-mute">تم برنامه<select value={value.theme} onChange={e=>patch({theme:e.target.value as AppPreferences["theme"]})} className="field-input mt-1"><option value="lathe">خراط‌کد (قهوه‌ای)</option><option value="midnight">نیمه‌شب</option><option value="graphite">گرافیت</option></select></label><div className="mt-4 grid grid-cols-3 gap-3">{[["profileColor","خط پروفایل"],["selectedColor","انتخاب"],["guideColor","راهنما"]].map(([key,label])=><label key={key} className="rounded-md border border-edge bg-panel2 p-2 text-[9.5px] text-mute">{label}<input type="color" value={value[key as keyof AppPreferences] as string} onChange={e=>patch({[key]:e.target.value})} className="mt-2 h-8 w-full cursor-pointer rounded border-0 bg-transparent"/></label>)}</div><label className="mt-4 block text-[10px] text-mute">ضخامت خطوط: <b className="text-ink">{value.lineWidth}px</b><input type="range" min={1} max={5} step={0.5} value={value.lineWidth} onChange={e=>patch({lineWidth:Number(e.target.value)})} className="mt-2 w-full accent-[#e3a94e]"/></label><label className="mt-4 block rounded-lg border border-edge bg-panel2 p-3 text-[10px] text-mute"><span className="flex items-center justify-between">اندازه دکمه‌های نوار ابزار چپ <b className="font-mono text-teal">{Math.round(value.toolbarScale*100)}٪</b></span><input type="range" min={0.75} max={1.5} step={0.05} value={value.toolbarScale} onChange={e=>patch({toolbarScale:Number(e.target.value)})} className="mt-3 w-full accent-[#45b394]"/><span className="mt-1 flex justify-between text-[8.5px] text-dim"><span>کوچک</span><span>بزرگ</span></span></label></div>}
          {tab==="shortcuts" && <div><Title title="کلیدهای میانبر" text="برای تغییر، روی کادر کلید کلیک و کلید جدید را فشار دهید" onReset={()=>patch({shortcuts:{...DEFAULT_PREFERENCES.shortcuts}})}/><div className="mt-4 grid grid-cols-2 gap-2">{Object.entries(SHORTCUT_LABELS).filter(([,label])=>!query||label.includes(query)).map(([id,label])=><label key={id} className="flex items-center justify-between rounded-md border border-edge bg-panel2 px-3 py-2 text-[10.5px] text-ink"><span>{label}</span><input readOnly value={(value.shortcuts[id]??"").toUpperCase()} onKeyDown={e=>{e.preventDefault();e.stopPropagation();const key=e.key.toLowerCase();if(key.length!==1)return;const used=Object.entries(value.shortcuts).find(([other,k])=>other!==id&&k===key);if(used)return;patch({shortcuts:{...value.shortcuts,[id]:key}});}} onFocus={e=>e.currentTarget.select()} className="h-7 w-12 rounded border border-edge2 bg-bg text-center font-mono text-xs font-bold text-brass2 outline-none focus:border-teal" /></label>)}</div></div>}
          {tab==="post" && <div><Title title="تنظیمات جی‌کد" text="سرعت پیش‌فرض عملیات و قالب خروجی کنترلر" onReset={()=>patch({postProcessor:DEFAULT_PREFERENCES.postProcessor,gcodeUnits:DEFAULT_PREFERENCES.gcodeUnits,sequenceNumbers:DEFAULT_PREFERENCES.sequenceNumbers,gcodeFormat:DEFAULT_PREFERENCES.gcodeFormat,continuousPaths:DEFAULT_PREFERENCES.continuousPaths,safeBottomInnerLink:DEFAULT_PREFERENCES.safeBottomInnerLink,optimizeFeeds:DEFAULT_PREFERENCES.optimizeFeeds,spreadRapid:DEFAULT_PREFERENCES.spreadRapid,spindleSpeed:DEFAULT_PREFERENCES.spindleSpeed,operationFeeds:{...DEFAULT_PREFERENCES.operationFeeds}})}/><div className="mt-5"><span className="mb-1 block text-[10px] text-mute">سبک خروجی جی‌کد</span><div className="grid grid-cols-2 overflow-hidden rounded-md border border-edge"><button onClick={()=>patch({gcodeFormat:"modal"})} className={cn("py-2 text-[10.5px] font-bold",value.gcodeFormat==="modal"?"bg-brass text-[#241a0c]":"bg-panel2 text-mute")}>فشرده Modal</button><button onClick={()=>patch({gcodeFormat:"std"})} className={cn("border-r border-edge py-2 text-[10.5px] font-bold",value.gcodeFormat==="std"?"bg-brass text-[#241a0c]":"bg-panel2 text-mute")}>استاندارد Fanuc</button></div></div><div className="mt-3 grid gap-2">{[["continuousPaths","اتصال پیوسته مسیرها (بدون G0)"],["safeBottomInnerLink","اتصال امن کف‌تراشی به خشن داخل (+X، Y، −X)"],["optimizeFeeds","فیدر بهینه (حذف Fهای تکراری)"],["sequenceNumbers","شماره خط (N) — فقط Fanuc"],["spreadRapid","گسترش G0 در جی‌کد (۳mm)"]].map(([key,label])=><label key={key} className="flex items-center gap-2 rounded-md border border-edge bg-panel2 px-3 py-2 text-[10.5px] text-ink"><input type="checkbox" checked={Boolean(value[key as keyof AppPreferences])} onChange={e=>patch({[key]:e.target.checked})} className="accent-[#e3a94e]"/>{label}</label>)}</div><label className="mt-4 block text-[10px] text-mute">پست‌پراسس<select value={value.postProcessor} onChange={e=>patch({postProcessor:e.target.value as AppPreferences["postProcessor"]})} className="field-input mt-1"><option value="fanuc">Fanuc / سازگار</option><option value="linuxcnc">LinuxCNC</option><option value="generic">Generic ISO</option></select></label><div className="mt-4 grid grid-cols-2 gap-3"><button onClick={()=>patch({gcodeUnits:"mm"})} className={cn("rounded-md border p-3 text-xs font-bold",value.gcodeUnits==="mm"?"border-brass/60 bg-brass/10 text-brass2":"border-edge text-mute")}>میلی‌متر (G21)</button><button onClick={()=>patch({gcodeUnits:"inch"})} className={cn("rounded-md border p-3 text-xs font-bold",value.gcodeUnits==="inch"?"border-brass/60 bg-brass/10 text-brass2":"border-edge text-mute")}>اینچ (G20)</button></div><label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-edge bg-panel2 p-3 text-[11px] text-ink"><span>دور دوک <small className="text-dim">(rpm)</small></span><input type="number" min={0} max={20000} step={100} value={value.spindleSpeed} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))patch({spindleSpeed:Math.min(20000,Math.max(0,n))});}} className="h-8 w-24 rounded border border-edge2 bg-bg px-2 text-center font-mono text-xs text-teal outline-none focus:border-teal"/></label><div className="mt-4"><div className="mb-2 text-[11px] font-bold text-ink">سرعت پیش‌فرض عملیات <span className="font-normal text-dim">(mm/min)</span></div><div className="grid grid-cols-2 gap-2">{FEED_LABELS.map(([key,label])=><label key={key} className="flex items-center justify-between gap-2 rounded-md border border-edge bg-panel2 px-2.5 py-2 text-[9.5px] text-mute"><span>{label}</span><input type="number" min={1} max={20000} step={10} value={value.operationFeeds[key]} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n))patch({operationFeeds:{...value.operationFeeds,[key]:Math.min(20000,Math.max(1,n))}});}} className="h-7 w-20 rounded border border-edge2 bg-bg px-1 text-center font-mono text-[10px] text-teal outline-none focus:border-teal"/></label>)}</div></div></div>}
        </div>
      </div>
      <footer dir="rtl" className="flex justify-end border-t border-edge px-4 py-3"><button onClick={onClose} className="rounded-md bg-brass px-5 py-1.5 text-xs font-bold text-[#241a0c]">تأیید</button></footer>
    </section>
  </div>;
}
function Title({title,text,onReset}:{title:string;text:string;onReset:()=>void}) { return <div className="flex items-start justify-between gap-3"><div><h3 className="text-base font-bold text-ink">{title}</h3><p className="mt-1 text-[10px] text-dim">{text}</p></div><button type="button" onClick={onReset} className="shrink-0 rounded-md border border-edge bg-panel2 px-2.5 py-1.5 text-[9.5px] font-bold text-mute transition-colors hover:border-brass/50 hover:text-brass2" title="بازنشانی تنظیمات این بخش به مقدار پیش‌فرض">بازنشانی به پیش‌فرض</button></div>; }
