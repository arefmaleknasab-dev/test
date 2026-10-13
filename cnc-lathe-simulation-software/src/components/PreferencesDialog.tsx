import { useRef, useState } from "react";
import { IconSettings, IconX } from "./icons";
import { cn } from "../utils/cn";

export interface AppPreferences {
  theme: "lathe" | "midnight" | "graphite";
  profileColor: string;
  selectedColor: string;
  guideColor: string;
  lineWidth: number;
  toolbarScale: number;
  postProcessor: "fanuc" | "linuxcnc" | "generic";
  gcodeUnits: "mm" | "inch";
  sequenceNumbers: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "lathe", profileColor: "#e3a94e", selectedColor: "#45b394", guideColor: "#4cc9f0",
  lineWidth: 2, toolbarScale: 1, postProcessor: "fanuc", gcodeUnits: "mm", sequenceNumbers: false,
};

export default function PreferencesDialog({ value, snapTolerance, onChange, onSnapTolerance, onClose }: {
  value: AppPreferences; snapTolerance: number; onChange: (next: AppPreferences) => void;
  onSnapTolerance: (value: number) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<"snap" | "appearance" | "post">("snap");
  const [frame, setFrame] = useState(() => ({ x: Math.max(16, (window.innerWidth - 672) / 2), y: Math.max(16, (window.innerHeight - 470) / 2), w: Math.min(672, window.innerWidth - 32), h: Math.min(470, window.innerHeight - 32) }));
  const drag = useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const patch = (p: Partial<AppPreferences>) => onChange({ ...value, ...p });
  return <div className="pointer-events-none fixed inset-0 z-[100]" dir="rtl">
    <section className="anim-in pointer-events-auto absolute flex min-h-[360px] min-w-[480px] resize flex-col overflow-hidden rounded-xl border border-edge2 bg-panel/98 shadow-2xl shadow-black/70" style={{left:frame.x,top:frame.y,width:frame.w,height:frame.h,maxWidth:"calc(100vw - 16px)",maxHeight:"calc(100vh - 16px)"}} onPointerUp={e=>{if(drag.current){drag.current=null;} const r=e.currentTarget.getBoundingClientRect();setFrame(f=>({...f,w:r.width,h:r.height}));}}>
      <header className="flex cursor-move select-none items-center justify-between border-b border-edge bg-panel2/90 px-4 py-3" onPointerDown={e=>{if((e.target as HTMLElement).closest("button"))return;drag.current={x:e.clientX,y:e.clientY,left:frame.x,top:frame.y};e.currentTarget.setPointerCapture?.(e.pointerId);}} onPointerMove={e=>{const d=drag.current;if(!d)return;setFrame(f=>({...f,x:Math.max(0,Math.min(window.innerWidth-80,d.left+e.clientX-d.x)),y:Math.max(0,Math.min(window.innerHeight-40,d.top+e.clientY-d.y))}));}}>
        <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-lg border border-brass/35 bg-brass/10 text-brass2"><IconSettings className="h-4.5 w-4.5"/></span><div><h2 className="text-sm font-bold text-ink">Preferences</h2><p className="text-[9.5px] text-dim">تنظیمات عمومی خراط‌کد</p></div></div>
        <button onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md text-dim hover:bg-panel3 hover:text-ink"><IconX className="h-4 w-4"/></button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[145px_1fr] overflow-auto">
        <nav className="space-y-1 border-l border-edge bg-[#110e0a]/50 p-2">
          {[["snap","اسنپ و دقت"],["appearance","رنگ، خطوط و تم"],["post","پست‌پراسس جی‌کد"]].map(([id,label])=><button key={id} onClick={()=>setTab(id as typeof tab)} className={cn("w-full rounded-md px-3 py-2 text-right text-[11px] font-bold",tab===id?"bg-brass/15 text-brass2":"text-mute hover:bg-panel3 hover:text-ink")}>{label}</button>)}
        </nav>
        <div className="p-5">
          {tab==="snap" && <div><Title title="حساسیت اسنپ" text="فاصله تشخیص نقاط، تقاطع‌ها و محور بر حسب پیکسل" onReset={()=>onSnapTolerance(11)}/><div className="mt-6 rounded-lg border border-edge bg-panel2 p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs text-ink">حساسیت پیکسلی</span><b className="font-mono text-sm text-teal">{snapTolerance}px</b></div><input type="range" min={3} max={30} step={1} value={snapTolerance} onChange={e=>onSnapTolerance(Number(e.target.value))} className="w-full accent-[#45b394]"/><div className="mt-2 flex justify-between text-[9px] text-dim"><span>دقیق ۳px</span><span>حساس ۳۰px</span></div></div></div>}
          {tab==="appearance" && <div><Title title="ظاهر نرم‌افزار" text="رنگ خطوط، ضخامت و تم رابط کاربری" onReset={()=>patch({theme:DEFAULT_PREFERENCES.theme,profileColor:DEFAULT_PREFERENCES.profileColor,selectedColor:DEFAULT_PREFERENCES.selectedColor,guideColor:DEFAULT_PREFERENCES.guideColor,lineWidth:DEFAULT_PREFERENCES.lineWidth,toolbarScale:DEFAULT_PREFERENCES.toolbarScale})}/><label className="mt-5 block text-[10px] text-mute">تم برنامه<select value={value.theme} onChange={e=>patch({theme:e.target.value as AppPreferences["theme"]})} className="field-input mt-1"><option value="lathe">خراط‌کد (قهوه‌ای)</option><option value="midnight">نیمه‌شب</option><option value="graphite">گرافیت</option></select></label><div className="mt-4 grid grid-cols-3 gap-3">{[["profileColor","خط پروفایل"],["selectedColor","انتخاب"],["guideColor","راهنما"]].map(([key,label])=><label key={key} className="rounded-md border border-edge bg-panel2 p-2 text-[9.5px] text-mute">{label}<input type="color" value={value[key as keyof AppPreferences] as string} onChange={e=>patch({[key]:e.target.value})} className="mt-2 h-8 w-full cursor-pointer rounded border-0 bg-transparent"/></label>)}</div><label className="mt-4 block text-[10px] text-mute">ضخامت خطوط: <b className="text-ink">{value.lineWidth}px</b><input type="range" min={1} max={5} step={0.5} value={value.lineWidth} onChange={e=>patch({lineWidth:Number(e.target.value)})} className="mt-2 w-full accent-[#e3a94e]"/></label><label className="mt-4 block rounded-lg border border-edge bg-panel2 p-3 text-[10px] text-mute"><span className="flex items-center justify-between">اندازه دکمه‌های نوار ابزار چپ <b className="font-mono text-teal">{Math.round(value.toolbarScale*100)}٪</b></span><input type="range" min={0.75} max={1.5} step={0.05} value={value.toolbarScale} onChange={e=>patch({toolbarScale:Number(e.target.value)})} className="mt-3 w-full accent-[#45b394]"/><span className="mt-1 flex justify-between text-[8.5px] text-dim"><span>کوچک</span><span>بزرگ</span></span></label></div>}
          {tab==="post" && <div><Title title="پست‌پراسس جی‌کد" text="قالب خروجی متناسب با کنترلر دستگاه" onReset={()=>patch({postProcessor:DEFAULT_PREFERENCES.postProcessor,gcodeUnits:DEFAULT_PREFERENCES.gcodeUnits,sequenceNumbers:DEFAULT_PREFERENCES.sequenceNumbers})}/><label className="mt-5 block text-[10px] text-mute">پست‌پراسس<select value={value.postProcessor} onChange={e=>patch({postProcessor:e.target.value as AppPreferences["postProcessor"]})} className="field-input mt-1"><option value="fanuc">Fanuc / سازگار</option><option value="linuxcnc">LinuxCNC</option><option value="generic">Generic ISO</option></select></label><div className="mt-4 grid grid-cols-2 gap-3"><button onClick={()=>patch({gcodeUnits:"mm"})} className={cn("rounded-md border p-3 text-xs font-bold",value.gcodeUnits==="mm"?"border-brass/60 bg-brass/10 text-brass2":"border-edge text-mute")}>میلی‌متر (G21)</button><button onClick={()=>patch({gcodeUnits:"inch"})} className={cn("rounded-md border p-3 text-xs font-bold",value.gcodeUnits==="inch"?"border-brass/60 bg-brass/10 text-brass2":"border-edge text-mute")}>اینچ (G20)</button></div><label className="mt-4 flex items-center gap-2 rounded-md border border-edge bg-panel2 p-3 text-[11px] text-ink"><input type="checkbox" checked={value.sequenceNumbers} onChange={e=>patch({sequenceNumbers:e.target.checked})} className="accent-[#e3a94e]"/>افزودن شماره خط N به خروجی</label></div>}
        </div>
      </div>
      <footer className="flex justify-end border-t border-edge px-4 py-3"><button onClick={onClose} className="rounded-md bg-brass px-5 py-1.5 text-xs font-bold text-[#241a0c]">تأیید</button></footer>
    </section>
  </div>;
}
function Title({title,text,onReset}:{title:string;text:string;onReset:()=>void}) { return <div className="flex items-start justify-between gap-3"><div><h3 className="text-base font-bold text-ink">{title}</h3><p className="mt-1 text-[10px] text-dim">{text}</p></div><button type="button" onClick={onReset} className="shrink-0 rounded-md border border-edge bg-panel2 px-2.5 py-1.5 text-[9.5px] font-bold text-mute transition-colors hover:border-brass/50 hover:text-brass2" title="بازنشانی تنظیمات این بخش به مقدار پیش‌فرض">بازنشانی به پیش‌فرض</button></div>; }
