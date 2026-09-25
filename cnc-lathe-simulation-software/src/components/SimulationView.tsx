import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { GenResult, Params, ToolProfile } from "../lib/lathe";
import { RAPID_RATE, rotationalEnvelope, toolProfile } from "../lib/lathe";
import { cn } from "../utils/cn";
import { IconPause, IconPlay, IconReset } from "./icons";

interface Props {
  gen: GenResult;
  params: Params;
  onActiveLine: (line: number) => void;
}

const GRID = 480;
const TIME_SCALE = 9; // سرعت نمایش نسبت به زمان واقعی

interface Chip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  life: number;
  max: number;
  c: string;
  w: number;
}

const CHIP_COLORS = ["#d8a86c", "#c9955a", "#a9743d", "#8a5a2e"];

/* شعاع اولیهٔ مدل مواد: برای مقاطع غیر دایره‌ای از شعاع محیطی (پوشش دورانی)    */
/* شروع می‌شود تا عملیات «گرد کردن» قسمت اضافی گوشه‌ها را بردارد؛ برای دایره    */
/* همان نصف قطر واقعی است.                                                     */
const initialRadius = (p: Params) => rotationalEnvelope(p.blankD, p.blankShape).outR;

const KIND_FA: Record<string, string> = {
  rapid: "حرکت سریع",
  round: "گرد کردن گوشه‌ها",
  rough: "خشن شعاعی",
  roughz: "خشن محوری",
  copy: "کپی‌تراشی",
  face: "پیشانی‌تراشی",
  finish: "پرداخت نهایی",
  offset: "آفست",
  bore: "خشن داخل (H2)",
  boreoff: "افست داخل تراشی (H2)",
  borefin: "پرداخت داخل (H2)",
  bottom: "کف‌تراشی (H2)",
};
const KIND_CLS: Record<string, string> = {
  rapid: "text-steel border-steel/40",
  round: "text-[#b48ee0] border-[#b48ee0]/50",
  rough: "text-teal border-teal/40",
  roughz: "text-[#6ab0d8] border-[#6ab0d8]/40",
  copy: "text-[#a3c15c] border-[#a3c15c]/40",
  face: "text-brass border-brass/40",
  finish: "text-copper border-copper/50",
  offset: "text-[#f59a80] border-[#f59a80]/50",
  bore: "text-[#4cc9f0] border-[#4cc9f0]/50",
  boreoff: "text-[#c77dff] border-[#c77dff]/50",
  borefin: "text-[#f72585] border-[#f72585]/50",
  bottom: "text-[#ffd166] border-[#ffd166]/50",
};

function SimulationView({ gen, params, onActiveLine }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);

  const camRef = useRef({ s: 1, ox: 0, oy: 0 });
  const radiiRef = useRef<Float64Array>(new Float64Array(GRID + 1));
  const cavRef = useRef<Float64Array>(new Float64Array(GRID + 1)); // شعاع حفره داخل کاسه
  const progRef = useRef(0);
  const cursorRef = useRef(0); // سگمنت‌هایی که کاملاً اعمال شده‌اند
  const appliedTRef = useRef(0); // پیشروی اعمال‌شده روی شعاع‌ها
  const playingRef = useRef(false);
  const speedRef = useRef(2);
  const chipsRef = useRef<Chip[]>([]);
  const lastLineRef = useRef(-1);
  const onActiveRef = useRef(onActiveLine);
  onActiveRef.current = onActiveLine;

  const xElRef = useRef<HTMLSpanElement>(null);
  const zElRef = useRef<HTMLSpanElement>(null);
  const fElRef = useRef<HTMLSpanElement>(null);
  const mmElRef = useRef<HTMLSpanElement>(null);
  const modeElRef = useRef<HTMLSpanElement>(null);
  /* اسکرابر سفارشی — بدون input بومی تا در RTL هم درست کار کند */
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);

  const paintScrub = (ratio: number) => {
    const pct = Math.max(0, Math.min(1, ratio)) * 100;
    if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    if (tipRef.current) tipRef.current.style.left = `${Math.max(7, Math.min(93, pct))}%`;
  };
  const showTipAt = (ratio: number) => {
    const el = tipRef.current;
    const totalL = totalRef.current;
    if (!el || totalL <= 0) return;
    el.textContent = `${(ratio * totalL).toFixed(0)} / ${totalL.toFixed(0)} mm`;
    el.style.opacity = "1";
  };
  const hideTip = () => {
    if (tipRef.current) tipRef.current.style.opacity = "0";
  };
  const ratioFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const lens = useMemo(() => gen.segs.map((s) => Math.hypot(s.x2 - s.x1, s.z2 - s.z1)), [gen]);
  const acc = useMemo(() => {
    const a: number[] = new Array(gen.segs.length);
    let t = 0;
    for (let i = 0; i < gen.segs.length; i++) {
      a[i] = t;
      t += lens[i];
    }
    return a;
  }, [gen.segs, lens]);
  const total = useMemo(() => acc.reduce((s, v, i) => Math.max(s, v + lens[i]), 0), [acc, lens]);
  const accRef = useRef(acc);
  accRef.current = acc;
  const lensRef = useRef(lens);
  lensRef.current = lens;
  const totalRef = useRef(total);
  totalRef.current = total;
  const genRef = useRef(gen);
  genRef.current = gen;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  /* پروفایل برشی ابزار مهندسی */
  const toolProf = useMemo(() => toolProfile(params.tool), [params.tool]);
  const toolProfRef = useRef<ToolProfile>(toolProf);
  toolProfRef.current = toolProf;

  /* بازنشانی هنگام تغییر برنامه، ابزار یا شکل مقطع */
  useEffect(() => {
    radiiRef.current = new Float64Array(GRID + 1).fill(initialRadius(params));
    cavRef.current = new Float64Array(GRID + 1);
    progRef.current = 0;
    cursorRef.current = 0;
    appliedTRef.current = 0;
    chipsRef.current = [];
    lastLineRef.current = -1;
    setPlaying(false);
    playingRef.current = false;
    onActiveLine(-1);
  }, [gen, params.blankD, params.blankShape, params.tool, onActiveLine]);

  /* اندازه و دوربین */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      const pad = 64;
      /* دوربین طوری تنظیم می‌شود که پوشش دورانی (دورترین گوشه) نیز جا شود */
      const envD = rotationalEnvelope(params.blankD, params.blankShape).maxRotD;
      const s = Math.min((r.width - pad * 2) / params.blankL, (r.height - pad * 2) / envD);
      camRef.current = { s, ox: (r.width - params.blankL * s) / 2, oy: r.height / 2 };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [params.blankL, params.blankD, params.blankShape]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size.w * dpr;
    cv.height = size.h * dpr;
  }, [size]);

  const setPlay = (v: boolean) => {
    if (v && progRef.current >= totalRef.current - 1e-6) {
      progRef.current = 0;
      cursorRef.current = 0;
      appliedTRef.current = 0;
      radiiRef.current.fill(initialRadius(paramsRef.current));
      cavRef.current.fill(0);
    }
    setPlaying(v);
    playingRef.current = v;
  };

  /* حلقه شبیه‌سازی */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const segIndexAt = (t: number) => {
      const a = accRef.current;
      const l = lensRef.current;
      let lo = 0;
      let hi = a.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] <= t) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (ans >= 0 && t >= a[ans] + l[ans]) ans = Math.min(a.length - 1, ans + 1);
      return ans;
    };

    /* خالی‌کردن حفره داخل: شعاع حفره = بیشترین شعاع نوک ابزار داخل‌تراش.
       با پنجره‌ای به پهنای نصف گام، فضای بین دو گذر پلکانی هم پر می‌شود تا
       حفره پیوسته دیده شود (پرداخت نهایی مرز دقیق دیواره را می‌نشاند). */
    const stampCavity = (z: number, r: number) => {
      const dzg = paramsRef.current.blankL / GRID;
      const idx = Math.round(z / dzg);
      const w = Math.max(1, Math.round((paramsRef.current.doc / 2 + 0.3) / dzg));
      const cav = cavRef.current;
      const rr = Math.min(r, paramsRef.current.blankD / 2);
      for (let k = -w; k <= w; k++) {
        const j = idx + k;
        if (j < 0 || j > GRID) continue;
        if (rr > cav[j]) cav[j] = rr;
      }
    };

    /* براده‌برداری با پروفایل واقعی ابزار: شعاع باقی‌مانده = نوک + ارتفاع کف ابزار */
    const stamp = (z: number, r: number) => {
      const dzg = paramsRef.current.blankL / GRID;
      const prof = toolProfRef.current.pts;
      const rad = radiiRef.current;
      for (let i = 0; i < prof.length; i++) {
        const idx = Math.round((z + prof[i][0]) / dzg);
        if (idx < 0 || idx > GRID) continue;
        const rr = r + prof[i][1];
        if (rr < rad[idx]) rad[idx] = rr;
      }
    };

    /* کف‌تراشی: هر گذر در صفحه zk لایه بالای خود (تا گام بعدی) را کامل برمی‌دارد؛
       پنجره فقط به سمت انتهای خام (+z) باز می‌شود تا هرگز زیر صفحه گذر
       (لبه/طرح) تراشیده نشود — پروفایل اینسرت برای این برش صفحه‌ای نامناسب است */
    const stampBottom = (z: number, r: number) => {
      const dzg = paramsRef.current.blankL / GRID;
      const rad = radiiRef.current;
      const win = paramsRef.current.doc + 0.5;
      const i0 = Math.max(0, Math.round(z / dzg));
      const i1 = Math.min(GRID, Math.round((z + win) / dzg));
      const rr = Math.min(r, paramsRef.current.blankD / 2);
      for (let i = i0; i <= i1; i++) if (rr < rad[i]) rad[i] = rr;
    };

    /* اعمال افزایشی سگمنت‌ها تا t (بازپخش کامل فقط هنگام اسکراب به عقب) */
    const advanceTo = (t: number) => {
      const g = genRef.current;
      const a = accRef.current;
      const l = lensRef.current;
      const dzg = paramsRef.current.blankL / GRID;
      for (let i = cursorRef.current; i < g.segs.length; i++) {
        const start = a[i];
        if (start >= t) {
          cursorRef.current = i;
          break;
        }
        const sg = g.segs[i];
        const frac = l[i] > 0 ? Math.min(1, (t - start) / l[i]) : 1;
        if (sg.motion === 1 && frac > 0) {
          const inner = sg.kind === "bore" || sg.kind === "boreoff" || sg.kind === "borefin";
          const n = Math.max(1, Math.ceil((l[i] * frac) / (dzg * 0.8)));
          for (let j = 1; j <= n; j++) {
            const tt = (j / n) * frac;
            const zz = sg.z1 + (sg.z2 - sg.z1) * tt;
            const rr = (sg.x1 + (sg.x2 - sg.x1) * tt) / 2;
            if (inner) stampCavity(zz, rr);
            else if (sg.kind === "bottom") stampBottom(zz, rr);
            else stamp(zz, rr);
          }
        }
        if (frac >= 1) cursorRef.current = i + 1;
        else {
          cursorRef.current = i;
          break;
        }
        if (i === g.segs.length - 1) cursorRef.current = g.segs.length;
      }
      appliedTRef.current = t;
    };

    const replayTo = (t: number) => {
      radiiRef.current.fill(initialRadius(paramsRef.current));
      cavRef.current.fill(0);
      cursorRef.current = 0;
      appliedTRef.current = 0;
      if (t > 1e-9) advanceTo(t);
    };

    const toolAt = (t: number) => {
      const g = genRef.current;
      const a = accRef.current;
      const l = lensRef.current;
      if (g.segs.length === 0) return { x: paramsRef.current.blankD + 20, z: paramsRef.current.blankL + 10, kind: "rapid" as string, feed: 0, line: -1, holder: 1 as 1 | 2 };
      const i = Math.max(0, segIndexAt(Math.min(t, totalRef.current - 1e-9)));
      const sg = g.segs[i];
      const tt = l[i] > 0 ? Math.min(1, Math.max(0, (t - a[i]) / l[i])) : 1;
      return {
        x: sg.x1 + (sg.x2 - sg.x1) * tt,
        z: sg.z1 + (sg.z2 - sg.z1) * tt,
        kind: sg.motion === 0 ? "rapid" : sg.kind,
        feed: sg.motion === 0 ? RAPID_RATE : sg.feed,
        line: sg.line,
        holder: sg.holder,
      };
    };

    /* همگام‌سازی DOM (نوار پیشرفت، DRO، خط فعال) — مستقل از رسم canvas */
    const syncDom = (tool: ReturnType<typeof toolAt>) => {
      if (xElRef.current) xElRef.current.textContent = tool.z.toFixed(2);
      if (zElRef.current) zElRef.current.textContent = tool.x.toFixed(2);
      if (fElRef.current) fElRef.current.textContent = String(Math.round(tool.feed));
      if (mmElRef.current)
        mmElRef.current.textContent = `${progRef.current.toFixed(0)} / ${totalRef.current.toFixed(0)} mm`;
      if (modeElRef.current) {
        const done = progRef.current >= totalRef.current - 1e-6 && totalRef.current > 0;
        modeElRef.current.textContent = done ? "پایان — M30" : KIND_FA[tool.kind] ?? "";
        modeElRef.current.className = cn(
          "rounded border px-1.5 py-0.5 text-[10px] font-bold",
          done ? "border-ok/50 text-ok" : KIND_CLS[tool.kind] ?? ""
        );
      }
      if (totalRef.current > 0 && !scrubbingRef.current) {
        const pct = (progRef.current / totalRef.current) * 100;
        if (fillRef.current) fillRef.current.style.width = `${pct}%`;
        if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
      }
      if (tool.line !== lastLineRef.current) {
        lastLineRef.current = tool.line;
        onActiveRef.current(tool.line);
      }
    };

    const draw = (dt: number, tool: ReturnType<typeof toolAt>) => {
      const cv = canvasRef.current;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = size.w;
      const h = size.h;
      const { s, ox, oy } = camRef.current;
      const p = paramsRef.current;
      const g = genRef.current;
      const X = (z: number) => ox + z * s;
      const Y = (r: number) => oy - r * s;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#120e09";
      ctx.fillRect(0, 0, w, h);

      /* شبکه */
      ctx.lineWidth = 1;
      for (let z = 0; z <= p.blankL + 0.01; z += 25) {
        ctx.strokeStyle = z % 50 === 0 ? "rgba(209,183,134,0.13)" : "rgba(209,183,134,0.05)";
        ctx.beginPath();
        ctx.moveTo(X(z), Y(p.blankD / 2));
        ctx.lineTo(X(z), Y(-p.blankD / 2));
        ctx.stroke();
        if (z % 50 === 0) {
          ctx.fillStyle = "#77684c";
          ctx.font = "10px 'JetBrains Mono', monospace";
          ctx.textAlign = "center";
          ctx.fillText(String(z), X(z), Y(-p.blankD / 2) + 16);
        }
      }

      /* خط محور */
      ctx.strokeStyle = "rgba(227,169,78,0.3)";
      ctx.setLineDash([10, 4, 2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, oy);
      ctx.lineTo(w, oy);
      ctx.stroke();
      ctx.setLineDash([]);

      /* محدوده خام */
      ctx.strokeStyle = "rgba(227,169,78,0.4)";
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(X(0), Y(p.blankD / 2), p.blankL * s, p.blankD * s);
      ctx.setLineDash([]);

      /* پوشش دورانی — فضای اشغال‌شده هنگام چرخش (دورترین گوشه از محور) */
      const env = rotationalEnvelope(p.blankD, p.blankShape);
      if (env.hasCorners) {
        ctx.strokeStyle = "rgba(69,179,148,0.45)";
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(X(0), Y(env.outR));
        ctx.lineTo(X(p.blankL), Y(env.outR));
        ctx.moveTo(X(0), Y(-env.outR));
        ctx.lineTo(X(p.blankL), Y(-env.outR));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.fillStyle = "rgba(69,179,148,0.6)";
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillText(`⌀${env.maxRotD.toFixed(1)}`, X(0) + 2, Y(env.outR) - 4);
      }

      /* silhouette هدف */
      if (g.samples.length > 1) {
        ctx.strokeStyle = "rgba(227,169,78,0.5)";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(X(g.samples[0].z), Y(g.samples[0].r));
        for (const sm of g.samples) ctx.lineTo(X(sm.z), Y(sm.r));
        for (let i = g.samples.length - 1; i >= 0; i--) ctx.lineTo(X(g.samples[i].z), Y(-g.samples[i].r));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* قطعه در حال تراش */
      const rad = radiiRef.current;
      const grad = ctx.createLinearGradient(0, Y(p.blankD / 2), 0, Y(-p.blankD / 2));
      grad.addColorStop(0, "#55361b");
      grad.addColorStop(0.18, "#8a5a2e");
      grad.addColorStop(0.38, "#c9955a");
      grad.addColorStop(0.5, "#d8a86c");
      grad.addColorStop(0.62, "#c08a4e");
      grad.addColorStop(0.85, "#7a4c24");
      grad.addColorStop(1, "#4a2e16");
      ctx.beginPath();
      ctx.moveTo(X(0), Y(rad[0]));
      for (let i = 1; i <= GRID; i++) ctx.lineTo(X((i / GRID) * p.blankL), Y(rad[i]));
      for (let i = GRID; i >= 0; i--) ctx.lineTo(X((i / GRID) * p.blankL), Y(-rad[i]));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();

      /* حفره داخل کاسه */
      const cav = cavRef.current;
      let hasCav = false;
      for (let i = 0; i <= GRID; i++) {
        if (cav[i] > 0.05) {
          hasCav = true;
          break;
        }
      }
      if (hasCav) {
        ctx.beginPath();
        ctx.moveTo(X(0), Y(cav[0]));
        for (let i = 1; i <= GRID; i++) ctx.lineTo(X((i / GRID) * p.blankL), Y(cav[i]));
        for (let i = GRID; i >= 0; i--) ctx.lineTo(X((i / GRID) * p.blankL), Y(-cav[i]));
        ctx.closePath();
        ctx.fillStyle = "#120e09";
        ctx.fill();
        ctx.strokeStyle = "rgba(76,201,240,0.65)";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* سیلوئت هدف دیواره داخلی */
      if (g.innerSamples.length > 1) {
        ctx.strokeStyle = "rgba(247,37,133,0.5)";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(X(g.innerSamples[0].z), Y(g.innerSamples[0].r));
        for (const sm of g.innerSamples) ctx.lineTo(X(sm.z), Y(sm.r));
        for (let i = g.innerSamples.length - 1; i >= 0; i--) ctx.lineTo(X(g.innerSamples[i].z), Y(-g.innerSamples[i].r));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* ابزار و موقعیت */
      const tx = X(tool.z);
      const ty = Y(tool.x / 2);

      /* تراشه‌ها */
      const chips = chipsRef.current;
      const cutting = playingRef.current && tool.kind !== "rapid";
      if (cutting && chips.length < 150) {
        for (let k = 0; k < 2; k++) {
          chips.push({
            x: tx + (Math.random() - 0.5) * 6,
            y: ty + (Math.random() - 0.5) * 6,
            vx: (Math.random() - 0.5) * 130,
            vy: 30 + Math.random() * 130,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 12,
            life: 0.5 + Math.random() * 0.45,
            max: 0.95,
            c: CHIP_COLORS[(Math.random() * CHIP_COLORS.length) | 0],
            w: 1.6 + Math.random() * 2.6,
          });
        }
      }
      for (let i = chips.length - 1; i >= 0; i--) {
        const c = chips[i];
        c.life -= dt;
        if (c.life <= 0) {
          chips.splice(i, 1);
          continue;
        }
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.vy += 460 * dt;
        c.rot += c.vr * dt;
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rot);
        ctx.globalAlpha = Math.min(1, c.life / 0.35);
        ctx.fillStyle = c.c;
        ctx.fillRect(-c.w / 2, -c.w / 4, c.w, c.w / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      /* خطوط راهنمای ابزار */
      ctx.strokeStyle = "rgba(227,169,78,0.28)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(X(0) - 6, ty);
      ctx.lineTo(tx, ty);
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx, Y(-p.blankD / 2) + 4);
      ctx.stroke();
      ctx.setLineDash([]);

      /* هاله برش */
      if (cutting) {
        const glow = ctx.createRadialGradient(tx, ty, 0, tx, ty, 16);
        glow.addColorStop(0, "rgba(255,190,90,0.55)");
        glow.addColorStop(1, "rgba(255,190,90,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(tx, ty, 16, 0, Math.PI * 2);
        ctx.fill();
      }

      if (tool.holder === 2) {
        /* هلدر دوم: میله داخل‌تراش چرخیده ‎−۹۰°‎ — افقی، از سمت دهانه وارد حفره می‌شود */
        const barL = Math.max(30, p.tool.shank * 1.6 * s);
        const barH = Math.max(7, p.tool.shank * 0.55 * s);
        ctx.save();
        ctx.fillStyle = "#333c45";
        ctx.strokeStyle = "#1d2329";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(tx, ty - barH / 2, barL, barH);
        ctx.fill();
        ctx.stroke();
        /* نوک برنده */
        ctx.fillStyle = cutting ? "#ffd489" : "#4cc9f0";
        ctx.beginPath();
        ctx.moveTo(tx, ty - barH / 2);
        ctx.lineTo(tx - 7, ty);
        ctx.lineTo(tx, ty + barH / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#4cc9f0";
        ctx.font = "bold 9px 'JetBrains Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillText("H2", tx + 4, ty - barH / 2 - 4);
        ctx.restore();
      } else {
      /* بدنه ابزار — اینسرت مهندسی با پروفایل واقعی (همان هندسهٔ براده‌برداری) */
      const prof = toolProfRef.current;
      const tz = tool.z;
      const tr = tool.x / 2;
      const bot: [number, number][] = prof.pts.map(([dz, c]) => [X(tz + dz), Y(tr + c)]);
      const xMin = X(tz + prof.min);
      const xMax = X(tz + prof.max);
      const cFirst = prof.pts[0][1];
      const cLast = prof.pts[prof.pts.length - 1][1];
      const yTopL = Y(tr + cFirst + prof.height);
      const yTopR = Y(tr + cLast + prof.height);
      const shankW = Math.max(6, p.tool.shank * 0.7) * s;
      const shankL = Math.max(14, p.tool.shank * 1.4) * s;
      const shMid = (xMin + xMax) / 2;
      const yTop = Math.min(yTopL, yTopR);
      ctx.save();
      /* دنباله */
      ctx.fillStyle = "#333c45";
      ctx.strokeStyle = "#1d2329";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(shMid - shankW / 2, yTop - shankL, shankW, shankL + 3);
      ctx.fill();
      ctx.stroke();
      /* اینسرت */
      const ig = ctx.createLinearGradient(0, yTop, 0, ty + 6);
      ig.addColorStop(0, "#9aa7b4");
      ig.addColorStop(0.55, "#78858f");
      ig.addColorStop(1, "#525e68");
      ctx.beginPath();
      ctx.moveTo(bot[0][0], bot[0][1]);
      for (const [bx, by] of bot) ctx.lineTo(bx, by);
      ctx.lineTo(xMax, yTopR);
      ctx.lineTo(xMin, yTopL);
      ctx.closePath();
      ctx.fillStyle = ig;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.stroke();
      /* یقهٔ اینسرت */
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(bot[0][0], bot[0][1]);
      for (const [bx, by] of bot) ctx.lineTo(bx, by);
      for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1] - 3);
      ctx.closePath();
      ctx.fill();
      /* لبه برنده (هایلایت) */
      ctx.beginPath();
      ctx.moveTo(bot[0][0], bot[0][1]);
      for (const [bx, by] of bot) ctx.lineTo(bx, by);
      ctx.strokeStyle = cutting ? "#ffd489" : "#f3c26b";
      ctx.lineWidth = 2;
      ctx.stroke();
      /* نوک */
      ctx.fillStyle = "#f3c26b";
      ctx.beginPath();
      ctx.arc(tx, ty, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      }
    };

    const step = (ts: number) => {
      const dt = Math.min(0.05, (ts - last) / 1000);
      last = ts;
      const totalL = totalRef.current;
      if (playingRef.current && totalL > 0) {
        const tool = toolAt(progRef.current);
        const rate = ((tool.feed || RAPID_RATE) / 60) * TIME_SCALE * speedRef.current;
        progRef.current = Math.min(totalL, progRef.current + rate * dt);
        if (progRef.current >= totalL) {
          playingRef.current = false;
          setPlaying(false);
        }
      }
      const tNow = progRef.current;
      if (tNow + 1e-9 < appliedTRef.current) replayTo(tNow);
      else if (tNow > appliedTRef.current + 1e-9) advanceTo(tNow);
      const toolNow = toolAt(progRef.current);
      draw(dt, toolNow);
      syncDom(toolNow);
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  /* --- تعامل اسکرابر --- */
  const seekToRatio = (ratio: number) => {
    progRef.current = Math.max(0, Math.min(1, ratio)) * totalRef.current;
    paintScrub(ratio);
    showTipAt(ratio);
  };

  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    scrubbingRef.current = true;
    setPlay(false);
    seekToRatio(ratioFromClientX(e.clientX));
  };
  const onTrackMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = ratioFromClientX(e.clientX);
    if (scrubbingRef.current) {
      seekToRatio(r);
    } else if (tipRef.current && totalRef.current > 0) {
      /* پیش‌نمایش موقعیت زیر نشانگر بدون جابه‌جایی انگشتانه */
      tipRef.current.style.left = `${Math.max(7, Math.min(93, r * 100))}%`;
      tipRef.current.textContent = `${(r * totalRef.current).toFixed(0)} / ${totalRef.current.toFixed(0)} mm`;
      tipRef.current.style.opacity = "1";
    }
  };
  const onTrackUp = () => {
    scrubbingRef.current = false;
    hideTip();
  };
  const onTrackKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const totalL = totalRef.current;
    if (totalL <= 0) return;
    const cur = progRef.current / totalL;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = cur + (e.shiftKey ? 0.1 : 0.01);
    else if (e.key === "ArrowLeft") next = cur - (e.shiftKey ? 0.1 : 0.01);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else return;
    e.preventDefault();
    setPlay(false);
    seekToRatio(next);
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-edge bg-[#120e09]">
      <div ref={wrapRef} className="absolute inset-0">
        <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} className="block" />
      </div>

      {/* DRO */}
      <div className="absolute top-2.5 right-2.5 rounded-lg border border-edge bg-panel/92 px-3.5 py-2.5 shadow-lg shadow-black/40 backdrop-blur-sm" dir="ltr">
        <div className="flex items-center gap-5">
          <div>
            <div className="text-[9.5px] font-bold tracking-widest text-mute">X LEN</div>
            <div className="font-mono text-[22px] font-bold leading-6 text-brass2" style={{ textShadow: "0 0 12px rgba(243,194,107,.45)" }}>
              <span ref={xElRef}>0.00</span>
            </div>
          </div>
          <div>
            <div className="text-[9.5px] font-bold tracking-widest text-mute">Y DIA</div>
            <div className="font-mono text-[22px] font-bold leading-6 text-brass2" style={{ textShadow: "0 0 12px rgba(243,194,107,.45)" }}>
              <span ref={zElRef}>0.00</span>
            </div>
          </div>
          <div>
            <div className="text-[9.5px] font-bold tracking-widest text-mute">F</div>
            <div className="font-mono text-[22px] font-bold leading-6 text-ink/80">
              <span ref={fElRef}>0</span>
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-edge pt-1.5" dir="rtl">
          <span ref={modeElRef} className="rounded border border-edge px-1.5 py-0.5 text-[10px] font-bold text-mute">
            آماده
          </span>
          <span ref={mmElRef} className="font-mono text-[10.5px] text-mute" dir="ltr">
            0 / 0 mm
          </span>
        </div>
      </div>

      {/* راهنمای تراشه */}
      <div className="absolute top-2.5 left-2.5 hidden items-center gap-2 rounded-full border border-edge bg-panel/85 px-3 py-1.5 text-[11px] text-mute backdrop-blur-sm sm:flex">
        <span className="dot-live inline-block h-2 w-2 rounded-full bg-ok" />
        شبیه‌سازی زنده — برداشت مواد همگام با جی‌کد
      </div>

      {/* نوار کنترل */}
      <div className="absolute right-2.5 bottom-2.5 left-2.5 flex items-center gap-2.5 rounded-lg border border-edge bg-panel/92 px-3 py-2.5 backdrop-blur-sm">
        <button className="btn btn-brass !px-3 !py-2" onClick={() => setPlay(!playing)} title={playing ? "توقف" : "پخش"}>
          {playing ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
        </button>
        <button
          className="btn !px-2.5 !py-2"
          title="شروع دوباره"
          onClick={() => {
            progRef.current = 0;
            cursorRef.current = 0;
            appliedTRef.current = 0;
            radiiRef.current.fill(initialRadius(paramsRef.current));
            cavRef.current.fill(0);
            chipsRef.current = [];
            setPlay(false);
          }}
        >
          <IconReset className="h-4 w-4" />
        </button>
        <div
          ref={trackRef}
          dir="ltr"
          role="slider"
          tabIndex={0}
          aria-label="نوار پیشرفت شبیه‌سازی"
          aria-valuemin={0}
          aria-valuemax={100}
          title="کلیک یا کشیدن برای جابه‌جایی در شبیه‌سازی"
          className="scrub-track min-w-0 flex-1"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
          onPointerLeave={() => {
            if (!scrubbingRef.current) hideTip();
          }}
          onKeyDown={onTrackKey}
        >
          <div className="scrub-rail">
            <div ref={fillRef} className="scrub-fill" />
            <div ref={thumbRef} className="scrub-thumb" />
          </div>
          <div ref={tipRef} className="scrub-tip" dir="ltr" />
        </div>
        <div className="flex overflow-hidden rounded-md border border-edge" dir="ltr">
          {[1, 2, 4, 8].map((v) => (
            <button
              key={v}
              onClick={() => {
                setSpeed(v);
                speedRef.current = v;
              }}
              className={cn(
                "px-2 py-1.5 font-mono text-[11px] font-bold transition-colors",
                speed === v ? "bg-brass text-[#241a0c]" : "bg-panel2 text-mute hover:text-ink"
              )}
            >
              {v}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* memo: حلقه پخش روی refهاست؛ رندر مجدد والد (هایلایت خط) این ویو را بازرندر نکند */
export default memo(SimulationView);
