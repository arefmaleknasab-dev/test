import { useEffect, useMemo, useState } from "react";
import type { SketchSeg, SPoint } from "../lib/sketch";
import { segPoints } from "../lib/sketch";
import { IconX } from "./icons";

type Split = { enabled: boolean; z: number; r: number; swapped?: boolean };
const TAU = Math.PI * 2;

function profilePoints(segs: SketchSeg[]) {
  const out:SPoint[]=[];
  for (const seg of segs) {
    const pts=segPoints(seg, seg.kind === "line" ? 1 : 18);
    for (let i=0;i<pts.length;i++) if (!out.length || i>0 || Math.hypot(out[out.length-1].z-pts[i].z,out[out.length-1].r-pts[i].r)>1e-7) out.push(pts[i]);
  }
  return out;
}

export default function Lathe3DDialog({segs,split,onClose}:{segs:SketchSeg[];split:Split;onClose:()=>void}) {
  const [angle,setAngle]=useState(split.enabled?24:-18);
  const [auto,setAuto]=useState(split.enabled);
  const [zoom,setZoom]=useState(1);
  const points=useMemo(()=>profilePoints(segs),[segs]);
  useEffect(()=>{if(!auto)return;const id=window.setInterval(()=>setAngle(a=>(a+1.2)%360),30);return()=>window.clearInterval(id);},[auto]);
  const mesh=useMemo(()=>{
    if(points.length<2)return [] as {d:string;fill:string}[];
    const minZ=Math.min(...points.map(p=>p.z)),maxZ=Math.max(...points.map(p=>p.z));
    const maxR=Math.max(1,...points.map(p=>Math.abs(p.r)));
    const sx=330/Math.max(1,maxZ-minZ), sy=330/(maxR*2.2), scale=Math.min(sx,sy)*zoom;
    const cx=390,cy=220, a=angle*Math.PI/180;
    const project=(p:SPoint,t:number)=>{const q=t+a;const depth=p.r*Math.sin(q),height=p.r*Math.cos(q);return [cx+(p.z-(minZ+maxZ)/2)*scale+depth*scale*.42,cy-height*scale-depth*scale*.16] as [number,number]};
    const strips=[] as {d:string;fill:string}[];const n=32;
    for(let j=0;j<n;j++){
      const t0=TAU*j/n,t1=TAU*(j+1)/n;let d="";
      points.forEach((p,i)=>{const [x,y]=project(p,t0);d+=(i?"L":"M")+x.toFixed(1)+","+y.toFixed(1);});
      for(let i=points.length-1;i>=0;i--){const [x,y]=project(points[i],t1);d+=`L${x.toFixed(1)},${y.toFixed(1)}`;}d+="Z";
      const light=.38+.32*Math.max(0,Math.cos((t0+t1)/2+a));
      strips.push({d,fill:`hsl(174 58% ${Math.round(20+light*35)}%)`});
    }
    return strips;
  },[points,angle,zoom]);
  return <div className="fixed inset-0 z-[155] grid place-items-center bg-black/75 p-4" dir="rtl"><div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-edge2 bg-panel shadow-2xl"><header className="flex items-center justify-between border-b border-edge px-4 py-3"><div><h2 className="font-bold text-brass2">نمایش سه‌بعدی Lathe</h2><p className="text-[10px] text-mute">نمایش لحظه‌ای پروفایل به‌صورت قطعهٔ تراش‌خورده</p></div><button className="btn !p-2" onClick={onClose}><IconX className="h-4 w-4"/></button></header><div className="min-h-[460px] flex-1 bg-[#071019] p-3"><svg viewBox="0 0 780 440" className="h-full min-h-[440px] w-full rounded-lg border border-edge bg-[#08131d]"><defs><radialGradient id="latheGlow"><stop stopColor="#4be0c4" stopOpacity=".18"/><stop offset="1" stopColor="#071019" stopOpacity="0"/></radialGradient></defs><rect width="780" height="440" fill="url(#latheGlow)"/>{mesh.map((m,i)=><path key={i} d={m.d} fill={m.fill} stroke="#75ead2" strokeOpacity=".18" strokeWidth=".7"/>)}{!mesh.length&&<text x="390" y="220" textAnchor="middle" fill="#8b9aa7" fontSize="14">پروفایل قابل نمایش نیست</text>}</svg></div><footer className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-4 py-3"><div className="flex items-center gap-2 text-[10px] text-mute"><span>{split.enabled?"چرخش خودکار برای پروفایل Split فعال است":"پروفایل بدون Split"}</span><label className="flex items-center gap-1.5"><input type="range" min="0.65" max="1.45" step=".05" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/> بزرگ‌نمایی</label></div><div className="flex gap-2"><button className="btn" onClick={()=>setAngle(a=>(a+90)%360)}>چرخش ۹۰°</button><button className={`btn ${auto?"btn-brass":""}`} onClick={()=>setAuto(v=>!v)}>{auto?"توقف چرخش":"چرخش خودکار"}</button><button className="btn" onClick={onClose}>بستن</button></div></footer></div></div>;
}
