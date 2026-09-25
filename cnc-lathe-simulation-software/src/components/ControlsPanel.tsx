import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BlankShape, Op, OpType, Params, PPoint, Preset, Sample, ToolHand, ToolSpec, ToolType } from "../lib/lathe";
import { ALL_OP_TYPES, BLANK_SHAPES, HAND_INFO, HOLDER2_ROT, INNER_OPS, INSERT_ANGLE, MIN_HOLDER2_OFFSET, NOSE_RADII, OP_INFO, OUTER_OPS, PRESETS, ROUGH_MODES, STRATEGIES, defaultOpInsertIndex, findZones, machineUV, makeOps, normalOffset, outerFirstOps, outerFirstTypes, rotationalEnvelope, sampleProfile, thumbPath, toolProfile } from "../lib/lathe";
import { cn } from "../utils/cn";
import { IconBowl, IconCheck, IconCurve, IconEye, IconEyeOff, IconLayers, IconPlus, IconSpindle, IconSplit, IconTool, IconTrash } from "./icons";

interface Props {
  params: Params;
  onParams: (patch: Partial<Params>) => void;
  points: PPoint[];
  innerPoints: PPoint[];
  splitInfo: { outerDir: 1 | -1; innerDir: 1 | -1; at: { z: number; r: number } } | null;
  onAutoSplit: () => void;

  activePreset: string | null;
  onApplyPreset: (p: Preset) => void;

  onStrategy: (name: string) => void;
  isolatedOpId: number | null;
  onIsolate: (id: number | null) => void;
  onNotify: (msg: string) => void;
}

function ControlsPanel({
  params,
  onParams,
  points,
  innerPoints,
  splitInfo,
  onAutoSplit,

  activePreset,
  onApplyPreset,
  onStrategy,
  isolatedOpId,
  onIsolate,
  onNotify,
}: Props) {
  /* امضای استراتژی فعلی برای تشخیص پیش‌تنظیم فعال (با قاعدهٔ پیش‌فرض: بیرونی‌ها اول) */
  const sig = outerFirstOps(params.ops.filter((o) => o.on)).map((o) => o.type).join(",");
  const bowlStrategy = STRATEGIES.find((st) => st.id === "bowl")!;
  const bowlActive = sig === outerFirstTypes(bowlStrategy.types).join(",");

  /* درگ‌ودراپ برای جابه‌جایی عملیات‌ها (کنار فلش‌ها) */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<number | null>(null); // k = درج «قبل» از ردیف k (یا انتها اگر k=length)
  const gripRef = useRef<number | null>(null);

  const setOps = (ops: Op[]) => onParams({ ops });
  const toggleHolder = (id: number) =>
    setOps(params.ops.map((o) => (o.id === id ? { ...o, holder: o.holder === 2 ? 1 : 2 } : o)));
  /* انتخاب سریع نوع عملیات: فقط خارج / فقط داخل / هردو */
  const setOpGroup = (mode: "outer" | "inner" | "both") =>
    setOps(
      params.ops.map((o) => ({
        ...o,
        on: mode === "both" ? true : mode === "outer" ? OUTER_OPS.includes(o.type) : INNER_OPS.includes(o.type),
      }))
    );
  const outerActive = params.ops.some((o) => o.on && OUTER_OPS.includes(o.type));
  const innerActive = params.ops.some((o) => o.on && INNER_OPS.includes(o.type));
  const h2example = machineUV(80, 120, 2, params);
  const moveOp = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= params.ops.length) return;
    const ops = [...params.ops];
    [ops[i], ops[j]] = [ops[j], ops[i]];
    setOps(ops);
  };
  const toggleOp = (id: number) => setOps(params.ops.map((o) => (o.id === id ? { ...o, on: !o.on } : o)));
  const removeOp = (id: number) => setOps(params.ops.filter((o) => o.id !== id));
  const addOp = (type: OpType) => {
    const op = makeOps([type])[0];
    const ops = [...params.ops];
    ops.splice(defaultOpInsertIndex(ops, type), 0, op);
    setOps(ops);
  };
  /* درگ‌ودراپ: برداشتن از دسته، رها روی لبهٔ رویی/زیری هر ردیف */
  const reorderOps = (from: number, ins: number) => {
    if (from === ins || from + 1 === ins) return;
    const ops = [...params.ops];
    const [m] = ops.splice(from, 1);
    ops.splice(ins > from ? ins - 1 : ins, 0, m);
    setOps(ops);
  };
  const endDrag = () => {
    gripRef.current = null;
    setDragFrom(null);
    setDropEdge(null);
  };

  const onTool = (patch: Partial<ToolSpec>) => onParams({ tool: { ...params.tool, ...patch } });

  /* نمونه‌های پروفایل و تقسیم خودکار نواحی (نقطهٔ شروع برای مرزسازی دستی) */
  const { zoneSamples, autoZones } = useMemo(() => {
    const blankR = params.blankD / 2;
    const samples = sampleProfile(points, blankR);
    const off: Sample[] = normalOffset(samples, params.offsetDist, true).map((s) => ({ z: s.z, r: Math.min(blankR, s.r) }));
    return { zoneSamples: off, autoZones: findZones(off) };
  }, [points, params.blankD, params.offsetDist]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pl-0.5">
      {/* پیش‌تنظیم‌های طرح */}
      <Section title="پیش‌تنظیم‌های طرح" icon={<IconLayers className="h-3.5 w-3.5 text-brass" />}>
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => onApplyPreset(p)}
              className={cn(
                "group rounded-md border p-1.5 text-center transition-all hover:-translate-y-0.5",
                activePreset === p.id
                  ? "border-brass/70 bg-brass/10 shadow-[0_0_14px_rgba(227,169,78,0.15)]"
                  : "border-edge bg-panel2 hover:border-edge2"
              )}
              title={`خام ⌀${p.blankD} × ${p.blankL}`}
            >
              <svg viewBox="0 0 100 34" className="h-8 w-full">
                <line x1="0" y1="17" x2="100" y2="17" stroke="rgba(227,169,78,0.3)" strokeWidth="0.8" strokeDasharray="3 2" />
                <path d={thumbPath(p, 100, 34)} fill="rgba(201,149,90,0.25)" stroke="#e3a94e" strokeWidth="1.1" fillRule="evenodd" />
              </svg>
              <div className={cn("mt-1 text-[10.5px] font-semibold", activePreset === p.id ? "text-brass2" : "text-mute group-hover:text-ink")}>
                {p.name}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {/* استراتژی تراش */}
      <Section title="استراتژی تراش" icon={<IconCurve className="h-3.5 w-3.5 text-brass" />}>
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          {STRATEGIES.map((st) => {
            const on = sig === outerFirstTypes(st.types).join(",");
            return (
              <button
                key={st.id}
                onClick={() => {
                  onParams({
                    ops: makeOps(st.types),
                    ...(st.id === "bowl"
                      ? {
                          holder2: {
                            xOff: Math.max(MIN_HOLDER2_OFFSET, params.holder2.xOff),
                            yOff: Math.max(MIN_HOLDER2_OFFSET, params.holder2.yOff),
                          },
                        }
                      : {}),
                  });
                  onStrategy(st.name);
                }}
                className={cn(
                  "rounded-md border px-1 py-1.5 text-[10.5px] font-bold transition-all hover:-translate-y-0.5",
                  on ? "border-teal/70 bg-teal/10 text-teal" : "border-edge bg-panel2 text-mute hover:border-edge2 hover:text-ink"
                )}
              >
                {st.name}
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          {params.ops.map((op, i) => {
            const info = OP_INFO[op.type];
            const isolated = isolatedOpId === op.id;
            const dragging = dragFrom === i;
            return (
              <div
                key={op.id}
                draggable
                onDragStart={(e) => {
                  if (gripRef.current !== i) {
                    e.preventDefault();
                    return;
                  }
                  e.dataTransfer.effectAllowed = "move";
                  try {
                    e.dataTransfer.setData("text/plain", String(op.id));
                  } catch {
                    /* ignore */
                  }
                  setDragFrom(i);
                }}
                onDragOver={(e) => {
                  if (dragFrom == null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropEdge(e.clientY < r.top + r.height / 2 ? i : i + 1);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom != null && dropEdge != null) reorderOps(dragFrom, dropEdge);
                  endDrag();
                }}
                onDragEnd={endDrag}
                title={`${info.name} — ${info.desc}`}
                className={cn(
                  "group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 transition-all",
                  op.on ? "border-edge bg-panel2" : "border-edge/60 bg-panel opacity-50",
                  isolated && "border-teal/70 bg-teal/10 shadow-[0_0_12px_rgba(69,179,148,0.18)]",
                  dragging && "opacity-40"
                )}
              >
                {dragFrom != null && dropEdge === i && (
                  <span className="pointer-events-none absolute -top-[3px] right-0 left-0 h-[2px] rounded-full bg-teal shadow-[0_0_6px_rgba(69,179,148,0.9)]" />
                )}
                {dragFrom != null && dropEdge === i + 1 && i === params.ops.length - 1 && (
                  <span className="pointer-events-none absolute -bottom-[3px] right-0 left-0 h-[2px] rounded-full bg-teal shadow-[0_0_6px_rgba(69,179,148,0.9)]" />
                )}
                <button
                  type="button"
                  onPointerDown={() => {
                    gripRef.current = i;
                  }}
                  onPointerUp={() => {
                    if (dragFrom == null) gripRef.current = null;
                  }}
                  title="جابه‌جایی: ردیف را از اینجا بکشید"
                  className="grid h-4 w-2.5 shrink-0 cursor-grab touch-none place-items-center rounded text-dim/50 transition-colors hover:text-brass active:cursor-grabbing"
                >
                  <svg viewBox="0 0 4 12" className="h-3 w-1 fill-current">
                    <circle cx="1" cy="1" r="1" /><circle cx="3" cy="1" r="1" />
                    <circle cx="1" cy="5" r="1" /><circle cx="3" cy="5" r="1" />
                    <circle cx="1" cy="9" r="1" /><circle cx="3" cy="9" r="1" />
                  </svg>
                </button>
                <button
                  onClick={() => onIsolate(isolated ? null : op.id)}
                  disabled={!op.on}
                  title={isolated ? "خروج از نمای ایزوله" : "مشاهدهٔ ایزولهٔ مسیر این عملیات در بوم"}
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded border transition-all",
                    isolated
                      ? "border-teal/60 bg-teal/15 text-teal"
                      : "border-transparent text-dim hover:border-edge2 hover:text-teal",
                    !op.on && "cursor-not-allowed opacity-30 hover:border-transparent hover:text-dim"
                  )}
                >
                  {isolated ? <IconEyeOff className="h-3.5 w-3.5" /> : <IconEye className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => toggleHolder(op.id)}
                  title={op.holder === 2 ? "هلدر ۲ — داخل‌تراش — کلیک برای تغییر" : "هلدر ۱ — اصلی — کلیک برای تغییر"}
                  className={cn(
                    "grid h-6 w-7 shrink-0 place-items-center rounded border font-mono text-[9px] font-bold transition-all",
                    op.holder === 2
                      ? "border-[#4cc9f0]/60 bg-[#4cc9f0]/15 text-[#4cc9f0]"
                      : "border-edge text-dim hover:border-edge2 hover:text-ink"
                  )}
                >
                  H{op.holder}
                </button>
                <button onClick={() => toggleOp(op.id)} className="shrink-0" title={op.on ? "غیرفعال کردن" : "فعال کردن"}>
                  <span
                    className={cn(
                      "block h-4 w-7 rounded-full border p-0.5 transition-colors",
                      op.on ? "border-brass/60 bg-brass/25" : "border-edge2 bg-bg"
                    )}
                  >
                    <span
                      className={cn(
                        "block h-2.5 w-2.5 rounded-full transition-transform",
                        op.on ? "translate-x-0 bg-brass2" : "-translate-x-3 bg-dim"
                      )}
                    />
                  </span>
                </button>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: info.color }} />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-[11px] font-bold text-ink/90">{info.name}</div>
                  <div className="truncate text-[9.5px] text-dim">{info.desc}</div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <div className="flex flex-col gap-px">
                    <MiniBtn tight disabled={i === 0} onClick={() => moveOp(i, -1)} title="جلوتر">
                      <path d="M8 10 4 6l-4 4" transform="translate(4 1)" />
                    </MiniBtn>
                    <MiniBtn tight disabled={i === params.ops.length - 1} onClick={() => moveOp(i, 1)} title="عقب‌تر">
                      <path d="M0 4 4 8l4-4" transform="translate(4 1)" />
                    </MiniBtn>
                  </div>
                  <MiniBtn danger onClick={() => removeOp(op.id)} title="حذف عملیات">
                    <IconTrash className="h-3 w-3" />
                  </MiniBtn>
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-1.5 flex items-center gap-1.5 rounded-md bg-bg/50 px-2 py-1 text-[9.5px] text-dim">
          <IconEye className="h-3 w-3 shrink-0 text-teal" />
          جابه‌جایی: ردیف را از دستهٔ نقطه‌ای بکشید یا با فلش‌ها — چشم: نمایش ایزولهٔ مسیر
        </p>

        {/* افزودن عملیات */}
        <div className="relative mt-1.5">
          <IconPlus className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-mute" />
          <select
            className="field-input appearance-none pr-7 text-[11.5px]"
            value=""
            onChange={(e) => {
              if (e.target.value) addOp(e.target.value as OpType);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              افزودن عملیات به زنجیره…
            </option>
            {ALL_OP_TYPES.map((t) => (
              <option key={t} value={t}>
                {OP_INFO[t].name}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-2 space-y-1.5 border-t border-edge pt-2">
          <div>
            <span className="mb-1 block text-[10.5px] font-semibold text-mute">سبک خروجی جی‌کد</span>
            <div className="flex overflow-hidden rounded-md border border-edge">
              <button
                onClick={() => onParams({ format: "modal" })}
                className={cn(
                  "flex-1 px-1 py-1.5 text-[10.5px] font-bold transition-colors",
                  params.format === "modal" ? "bg-brass text-[#241a0c]" : "bg-panel2 text-mute hover:text-ink"
                )}
              >
                فشرده Modal
              </button>
              <button
                onClick={() => onParams({ format: "std" })}
                className={cn(
                  "flex-1 border-r border-edge px-1 py-1.5 text-[10.5px] font-bold transition-colors",
                  params.format === "std" ? "bg-brass text-[#241a0c]" : "bg-panel2 text-mute hover:text-ink"
                )}
              >
                استاندارد Fanuc
              </button>
            </div>
          </div>
          <Toggle label="شماره خط (N) — فقط Fanuc" on={params.lineNumbers} onChange={(v) => onParams({ lineNumbers: v })} />
          <Toggle label="گسترش G0 در جی‌کد (۳mm)" on={params.spreadG0} onChange={(v) => onParams({ spreadG0: v })} />
          {params.spreadG0 && (
            <p className="px-0.5 text-[10.5px] leading-5 text-mute">
              حرکت‌های سریعِ روی‌هم با گام ۳mm فقط به سمت بیرون باز می‌شوند تا در سیمکو جدا دیده شوند — فیدرها و برش عوض نمی‌شوند.
            </p>
          )}
        </div>
      </Section>

      {/* کاسه: نقطه Split + هلدر دوم */}
      <Section title="کاسه و هلدر دوم" icon={<IconBowl className="h-3.5 w-3.5 text-brass" />}>
        <Toggle
          label="حالت کاسه (نقطه Split)"
          on={params.split.enabled}
          onChange={(v) => onParams({ split: { ...params.split, enabled: v } })}
        />
        {params.split.enabled ? (
          <div className="anim-in mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Num label="X نقطه Split" unit="mm" value={params.split.z} min={0} max={params.blankL} step={1} onChange={(v) => onParams({ split: { ...params.split, z: v } })} />
              <Num label="⌀ نقطه Split" unit="mm" value={Math.round(params.split.r * 2 * 100) / 100} min={0} max={params.blankD} step={1} onChange={(v) => onParams({ split: { ...params.split, r: v / 2 } })} />
            </div>
            <button onClick={onAutoSplit} className="btn w-full justify-center !py-1.5 text-[11.5px]" title="قرار دادن خودکار نقطه روی لبه (بیشترین X زنجیره)">
              <IconSplit className="h-3.5 w-3.5" />
              Split خودکار روی لبه
            </button>
            <p className="rounded-md border border-dashed border-edge px-2 py-1 text-[9.5px] leading-4 text-dim">
              یا با ابزار <span className="font-bold text-[#f72585]">نقطه Split (کلید S)</span> مستقیم روی پروفیل در بوم کلیک کنید.
            </p>

            {splitInfo ? (
              <div className="rounded-md border border-edge bg-bg/50 px-2 py-1.5 text-[10px] leading-5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-brass2">شاخه خارجی</span>
                  <span className="font-mono text-mute" dir="ltr">{splitInfo.outerDir > 0 ? "+X" : "−X"} • {faNum(points.length)} نقطه</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#4cc9f0]">شاخه داخلی</span>
                  <span className="font-mono text-mute" dir="ltr">{splitInfo.innerDir > 0 ? "+X" : "−X"} • {faNum(innerPoints.length)} نقطه</span>
                </div>
              </div>
            ) : (
              <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[10px] leading-4 text-danger">
                شاخه‌ای ساخته نشد — پروفیل زنجیره‌ای (حداقل ۳ نقطه) ترسیم کنید.
              </p>
            )}
            {splitInfo && innerPoints.length < 2 && (
              <p className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[10px] leading-4 text-danger">
                شاخه داخلی خالی است — نقطه Split را روی پروفیل (نزدیک لبه) بگذارید.
              </p>
            )}

            {/* نوع عملیات */}
            <div>
              <span className="mb-1 block text-[10.5px] font-semibold text-mute">نوع عملیات</span>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  onClick={() => setOpGroup("outer")}
                  className={cn(
                    "rounded-md border px-1 py-1.5 text-[10px] font-bold transition-all",
                    outerActive && !innerActive ? "border-brass/70 bg-brass/10 text-brass2" : "border-edge bg-panel2 text-mute hover:text-ink"
                  )}
                >
                  خارج‌تراشی
                </button>
                <button
                  onClick={() => setOpGroup("inner")}
                  className={cn(
                    "rounded-md border px-1 py-1.5 text-[10px] font-bold transition-all",
                    innerActive && !outerActive ? "border-[#4cc9f0]/70 bg-[#4cc9f0]/10 text-[#4cc9f0]" : "border-edge bg-panel2 text-mute hover:text-ink"
                  )}
                >
                  داخل‌تراشی
                </button>
                <button
                  onClick={() => setOpGroup("both")}
                  className={cn(
                    "rounded-md border px-1 py-1.5 text-[10px] font-bold transition-all",
                    outerActive && innerActive ? "border-teal/70 bg-teal/10 text-teal" : "border-edge bg-panel2 text-mute hover:text-ink"
                  )}
                >
                  هردو
                </button>
              </div>
            </div>

            {/* هلدر دوم فقط پس از Split معتبر و با استراتژی کاسه داخل+خارج */}
            {bowlActive && splitInfo && (
            <div className="rounded-lg border border-[#4cc9f0]/30 bg-[#4cc9f0]/5 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-bold text-[#4cc9f0]">هلدر دوم (داخل‌تراش)</span>
                <span className="rounded-full border border-edge px-2 py-0.5 font-mono text-[9px] font-bold text-mute" dir="ltr">
                  ROT {HOLDER2_ROT}°
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Num label="X Offset (+X)" unit="mm" value={params.holder2.xOff} min={MIN_HOLDER2_OFFSET} step={0.5} onChange={(v) => onParams({ holder2: { ...params.holder2, xOff: Math.max(MIN_HOLDER2_OFFSET, v) } })} />
                <Num label="Y Offset (−Y)" unit="mm" value={params.holder2.yOff} min={MIN_HOLDER2_OFFSET} step={0.5} onChange={(v) => onParams({ holder2: { ...params.holder2, yOff: Math.max(MIN_HOLDER2_OFFSET, v) } })} />
              </div>
              <p className="mt-1.5 rounded-md bg-bg/60 px-2 py-1 font-mono text-[9px] leading-4 text-mute" dir="ltr">
                Xm = Xw + Xoff , Ym = Yw/2 − Yoff
                <br />
                ex: (80.0, 120.0) → ({h2example.u.toFixed(1)}, {h2example.v.toFixed(1)})
              </p>
              <p className="mt-1 text-[9px] leading-4 text-dim">
                هر آفست مستقیم روی محور خودش اثر می‌گذارد: X مثبت به سمت ‎+X‎ و Y مثبت به سمت ‎−Y‎. چرخش ‎−۹۰°‎ مربوط به جهت ابزار است. تبدیل فقط در جی‌کد اعمال می‌شود؛ شبیه‌سازی در مختصات قطعه است.
              </p>
            </div>
            )}
          </div>
        ) : (
          <p className="mt-1.5 rounded-md border border-dashed border-edge px-2 py-1.5 text-[10px] leading-5 text-dim">
            با فعال‌سازی، پروفیل در نقطه Split به دو شاخه داخل/خارج تقسیم می‌شود. نمونه آماده: <span className="font-bold text-brass2">«کاسه (داخل+خارج)»</span> از پیش‌تنظیم‌ها.
          </p>
        )}
      </Section>

      {/* ابزار تراش */}
      <Section title="ابزار تراش" icon={<IconTool className="h-3.5 w-3.5 text-brass" />}>
        <ToolPreview tool={params.tool} />
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {TOOL_TYPES.map((tt) => (
            <button
              key={tt.id}
              onClick={() => onTool({ type: tt.id })}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 transition-all hover:-translate-y-0.5",
                params.tool.type === tt.id
                  ? "border-brass/70 bg-brass/10 text-brass2 shadow-[0_0_12px_rgba(227,169,78,0.15)]"
                  : "border-edge bg-panel2 text-mute hover:border-edge2 hover:text-ink"
              )}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
                {tt.glyph}
              </svg>
              <span className="text-[9.5px] font-bold">{tt.name}</span>
            </button>
          ))}
        </div>
        {params.tool.type === "angle" && (
          <>
            {/* دسته‌های تراش استاندارد */}
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(Object.keys(HAND_INFO) as ToolHand[]).map((h) => {
                const on = params.tool.hand === h;
                return (
                  <button
                    key={h}
                    onClick={() => onTool({ hand: h })}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-md border px-1 py-2 transition-all hover:-translate-y-0.5",
                      on
                        ? "border-brass/70 bg-brass/10 text-brass2 shadow-[0_0_12px_rgba(227,169,78,0.15)]"
                        : "border-edge bg-panel2 text-mute hover:border-edge2 hover:text-ink"
                    )}
                  >
                    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
                      {HAND_GLYPHS[h]}
                    </svg>
                    <span className="text-[10px] font-bold">{HAND_INFO[h].name}</span>
                    <span className="font-mono text-[8.5px] text-dim">{HAND_INFO[h].desc}</span>
                  </button>
                );
              })}
            </div>
            {/* شعاع نوک — تنها پارامتر قابل تغییر */}
            <div className="mt-2">
              <span className="mb-1 block text-[10.5px] font-semibold text-mute">شعاع نوک اینسرت (Rε)</span>
              <div className="flex overflow-hidden rounded-md border border-edge" dir="ltr">
                {NOSE_RADII.map((r) => (
                  <button
                    key={r}
                    onClick={() => onTool({ nose: r })}
                    className={cn(
                      "flex-1 py-1.5 font-mono text-[11px] font-bold transition-colors",
                      Math.abs(params.tool.nose - r) < 1e-6
                        ? "bg-brass text-[#241a0c]"
                        : "bg-panel2 text-mute hover:bg-panel3 hover:text-ink"
                    )}
                  >
                    R{r}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1.5 rounded-md bg-bg/50 px-2 py-1 font-mono text-[9.5px] text-dim" dir="ltr">
              INSERT: V{INSERT_ANGLE}° • {HAND_INFO[params.tool.hand].k}° • R{params.tool.nose}
            </p>
          </>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          {params.tool.type === "round" && (
            <Num label="شعاع اینسرت (R)" unit="mm" value={params.tool.radius} min={1} max={15} step={0.5} onChange={(v) => onTool({ radius: v })} />
          )}
          {params.tool.type === "groove" && (
            <>
              <Num label="پهنای تیغه (W)" unit="mm" value={params.tool.width} min={1} max={10} step={0.5} onChange={(v) => onTool({ width: v })} />
              <Num label="شعاع گوشه" unit="mm" value={params.tool.corner} min={0} max={1} step={0.05} onChange={(v) => onTool({ corner: v })} />
            </>
          )}
          <Num label="پهنای دنباله" unit="mm" value={params.tool.shank} min={6} max={30} step={1} onChange={(v) => onTool({ shank: v })} />
        </div>
        <p className="mt-1.5 rounded-md bg-bg/50 px-2 py-1 text-[9.5px] leading-4 text-dim">
          شکل هندسی این ابزار دقیقاً همان هندسهٔ براده‌برداری در شبیه‌سازی است؛ لبهٔ برنده در پیش‌نمایش طلایی و در شبیه‌سازی هنگام تراش روشن می‌شود.
        </p>
      </Section>

      {/* ابعاد خام */}
      <Section title="قطعه خام" icon={<IconSpindle className="h-3.5 w-3.5 text-brass" />}>
        <BlankDims
          blankD={params.blankD}
          blankL={params.blankL}
          onApply={(d, l) => onParams({ blankD: d, blankL: l })}
        />

        {/* شکل مقطع خام */}
        <div className="mt-2.5">
          <span className="mb-1 block text-[10.5px] font-semibold text-mute">شکل مقطع خام</span>
          <div className="grid grid-cols-4 gap-1.5">
            {BLANK_SHAPES.map((sh) => {
              const on = params.blankShape === sh.id;
              return (
                <button
                  key={sh.id}
                  onClick={() => onParams({ blankShape: sh.id })}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md border px-0.5 py-1.5 transition-all hover:-translate-y-0.5",
                    on
                      ? "border-brass/70 bg-brass/10 text-brass2 shadow-[0_0_12px_rgba(227,169,78,0.15)]"
                      : "border-edge bg-panel2 text-mute hover:border-edge2 hover:text-ink"
                  )}
                  title={sh.sides === 0 ? "مقطع دایره‌ای — بدون گوشه" : `مقطع ${sh.name} — ${faNum(sh.sides)} گوشه`}
                >
                  <ShapeGlyph sides={sh.sides} />
                  <span className="text-[8.5px] font-bold leading-tight">{sh.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* پیش‌نمایش پوشش دورانی */}
        <RotationalEnvelopePreview
          blankD={params.blankD}
          shape={params.blankShape}
          rpm={params.rpm}
        />
      </Section>

      {/* پارامترهای تراش */}
      <Section title="پارامترهای برداشت">
        <div className="grid grid-cols-2 gap-2">
          <Num label="عمق بار / گام" unit="mm" value={params.doc} min={0.5} max={10} step={0.5} onChange={(v) => onParams({ doc: v })} />
          <Num label="فاصله آفست" unit="mm" value={params.offsetDist} min={0} max={3} step={0.1} onChange={(v) => onParams({ offsetDist: v })} />
          <Num label="فاصله آفست داخل تراش" unit="mm" value={params.innerOffsetDist} min={0} max={3} step={0.1} onChange={(v) => onParams({ innerOffsetDist: v })} />
          <Num label="فاصله شروع داخل تراشی" unit="mm" value={params.innerStartClearance} min={0} max={20} step={0.5} onChange={(v) => onParams({ innerStartClearance: Math.min(20, Math.max(0, v)) })} />
          <Num label="فاصله پایان داخل تراشی" unit="mm" value={params.innerEndTravel} min={300} max={500} step={10} onChange={(v) => onParams({ innerEndTravel: Math.min(500, Math.max(300, v)) })} />
          <Num label="فیدر خشن" unit="mm/min" value={params.feedRough} min={20} max={1500} step={10} onChange={(v) => onParams({ feedRough: v })} />
          <Num label="فیدر پرداخت" unit="mm/min" value={params.feedFinish} min={10} max={1000} step={10} onChange={(v) => onParams({ feedFinish: v })} />
          <Num label="دور دوک" unit="rpm" value={params.rpm} min={200} max={4000} step={100} onChange={(v) => onParams({ rpm: v })} />
          <Num label="فاصله امن" unit="mm" value={params.safety} min={1} max={20} step={1} onChange={(v) => onParams({ safety: v })} />
        </div>
        <p className="mt-1.5 rounded-md bg-bg/50 px-2 py-1 text-[9.5px] leading-4 text-dim">
          فاصله امن، حداقل فاصله همه جابه‌جایی‌های سریع (G0) است: بیرون ‎+Y‎ از خط خارجی و بیرون ‎+X‎ از خط داخلی.
        </p>
        <div className="mt-2">
          <span className="mb-1 block text-[10.5px] font-semibold text-mute">روش خشن‌تراشی</span>
          <div className="flex overflow-hidden rounded-md border border-edge" dir="ltr">
            {ROUGH_MODES.map((m, i) => (
              <button
                key={m.id}
                onClick={() => onParams({ roughMode: m.id })}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 px-0.5 py-2 transition-colors",
                  i > 0 && "border-l border-edge",
                  params.roughMode === m.id
                    ? m.id === "zone"
                      ? "bg-copper text-[#2a150a]"
                      : m.id === "zigzag"
                        ? "bg-teal text-[#0d201a]"
                        : "bg-brass text-[#241a0c]"
                    : "bg-panel2 text-mute hover:bg-panel3 hover:text-ink"
                )}
                title={
                  m.id === "zone"
                    ? "رفت‌وبرگشت درون هر ناحیه کامل می‌شود، سپس ناحیهٔ بعد — برای تمرکز بر هر ناحیه"
                    : m.id === "zigzag"
                      ? "رفت‌وبرگشت با دنبال‌کردن منحنی؛ هر گذر فقط نواحیِ باقی‌مانده را می‌تراشد و ناحیهٔ تمام‌شده دوباره تراش نمی‌خورد"
                      : "ابزار پس از هر مسیر جمع کرده و به نقطه شروع بازمی‌گردد"
                }
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  {m.id === "classic" && <path d="M4 8h13l-3-3M20 16H7l3 3" />}
                  {m.id === "zigzag" && <path d="M3 7h15l-2.5-2.5M21 12H6l2.5-2.5M3 17h15l-2.5-2.5" />}
                  {m.id === "zone" && (
                    <>
                      <rect x="3" y="6" width="7" height="12" rx="1" />
                      <rect x="14" y="6" width="7" height="12" rx="1" />
                      <path d="M10 12h4" strokeDasharray="1.5 1.5" />
                    </>
                  )}
                </svg>
                <span className="text-[9px] font-bold leading-tight">{m.name}</span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[9.5px] leading-4 text-dim">
            {params.roughMode === "zone"
              ? "ناحیه‌ای: رفت‌وبرگشت درون هر ناحیه کامل می‌شود، سپس ابزار به ناحیهٔ بعد می‌رود — مناسب وقتی می‌خواهید هر ناحیه پیش از بعدی تمام شود"
                : params.roughMode === "zigzag"
                ? "زیگزاگ: ابزار منحنی هر لایه را دنبال می‌کند و در هر گذر فقط بازه‌هایی را می‌تراشد که هنوز به برش نیاز دارند — ناحیه‌ای که تمام شده دوباره طی نمی‌شود (مثلاً وقتی عمق دره‌ها متفاوت است، گذرهای عمیق فقط درهٔ عمیق را می‌تراشند). گذر رفت و برگشت هر دو باربرداری می‌کنند و چون هر گذر فقط به عمق «بار» برش می‌زند، نیروی برش پخش شده و برای چوب شکننده امن است"
                : "کلاسیک: ابزار پس از هر مسیر جمع کرده و برای مسیر بعد به نقطه شروع بازمی‌گردد"}
          </p>
        </div>

        {params.roughMode === "zone" && (
          <div className="anim-in mt-2">
            <Toggle
              label="اتصال پیوستهٔ مسیرها (بدون G0)"
              on={params.ramp}
              onChange={(v) => onParams({ ramp: v })}
            />
            <p className="mt-1 text-[9.5px] leading-4 text-dim">
              {params.ramp
                ? "ابزار بین لایه‌های درون هر ناحیه مستقیم و با حرکت برشی (Ramp) به خط بعد فرور می‌رود — هیچ جابه‌جایی سریع G0 در میان نیست"
                : "بین لایه‌های درون هر ناحیه با جابه‌جایی سریع (G0) و حداقل فاصله امن به خط بعد می‌رود"}
            </p>
          </div>
        )}

        {params.roughMode === "zigzag" && (
          <p className="anim-in mt-2 flex items-start gap-1.5 rounded-md border border-teal/30 bg-teal/10 px-2 py-1.5 text-[9.5px] leading-4 text-teal">
            <IconCheck className="mt-0.5 h-3 w-3 shrink-0" />
            گذرهای رفت و برگشت هر دو با فیدر خشن باربرداری می‌کنند و ناحیهٔ تمام‌شده دوباره تراش نمی‌خورد؛ فقط برای پرش بین دو بازهٔ جدا، یک عبور امنِ کوتاه انجام می‌شود.
          </p>
        )}

        <div className="anim-in mt-2">
          <Toggle
            label="فیدر بهینه (حذف F های تکراری)"
            on={params.simpleFeed}
            onChange={(v) => onParams({ simpleFeed: v })}
          />
          <p className="mt-1 text-[9.5px] leading-4 text-dim">
            {params.simpleFeed
              ? "همهٔ فیدرها به دو F اصلی ساده می‌شوند — F فیدر خشن و F فیدر پرداخت — و G1/F های اضافه حذف می‌شوند"
              : "هر حرکت فیدر مخصوص خود را دارد (فرورفتن، خشن، پرداخت جدا)"}
          </p>
        </div>

        {params.roughMode === "zone" && (
          <div className="anim-in mt-2.5 border-t border-edge pt-2.5">
            <ZoneOrderEditor
              key={params.blankL + "|" + params.zoneBounds.join(",")}
              blankL={params.blankL}
              blankR={params.blankD / 2}
              samples={zoneSamples}
              autoZones={autoZones}
              committedBounds={params.zoneBounds}
              committedOrder={params.zoneOrder}
              onConfirm={({ bounds, order }) => {
                onParams({ zoneBounds: bounds, zoneOrder: order });
                onNotify("نواحی و ترتیب آن‌ها اعمال شد — جی‌کد به‌روز شد");
              }}
              onReset={({ defaults }) => {
                onParams({ zoneBounds: [], ...(defaults ? { zoneOrder: [] } : {}) });
              }}
            />
          </div>
        )}
      </Section>

      {/* راهنمای ابزار ترسیم */}
      <Section title="ابزار ترسیم پروفایل" icon={<IconCurve className="h-3.5 w-3.5 text-brass" />}>
        <p className="rounded-md border border-dashed border-edge px-2.5 py-2 text-[10.5px] leading-5 text-dim">
          ابزارهای <span className="text-teal">خط، منحنی، منحنی کنترلی و کمان</span> در نوار ابزار بالای بوم قرار دارند. برای ویرایش دقیق (طول، زاویه، شعاع و مختصات)، المان را انتخاب کنید تا پنجرهٔ مشخصات هندسی باز شود.
        </p>
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-copper/8 px-2 py-1.5 text-[10px] leading-4 text-copper/90">
          <span className="mt-0.5 font-bold">⌄</span>
          کشیدنِ خودِ المان فقط آن را جابه‌جا می‌کند (و نقاط متصل به خطوط دیگر را نمی‌برد). برای شکستنِ اتصالِ یک گوشهٔ مشترک، روی آن <span className="font-bold">راست‌کلیک</span> و «جداسازی» را بزنید.
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-1 font-mono text-[9px] text-dim" dir="ltr">
          <span>V — انتخاب</span>
          <span>L — خط</span>
          <span>C — منحنی</span>
          <span>B — منحنی کنترلی</span>
          <span>A — کمان</span>
          <span>Del — حذف</span>
          <span>Ctrl+A — همه</span>
          <span>Ctrl+I — معکوس</span>
        </div>
        <p className="mt-1.5 rounded-md border border-dashed border-edge px-2.5 py-2 text-[10px] leading-5 text-dim">
          باکس انتخابگر: درگ <span className="font-bold text-[#4aa3ff]">چپ‌به‌راست</span> فقط المان‌های کاملاً داخل باکس را می‌گیرد، درگ <span className="font-bold text-[#3faf5d]">راست‌به‌چپ</span> هر چه را با باکس برخورد کند؛ باکس <span className="font-bold text-brass2">نقاط انتهایی، نقطهٔ کمان و دسته‌های کنترل منحنی‌های فعال</span> را هم جداگانه انتخاب می‌کند؛ <span className="font-bold">Shift</span> افزودن، <span className="font-bold">Ctrl</span> حذف، <span className="font-bold">دابل‌کلیک</span> انتخاب زنجیرهٔ متصل، و پن با <span className="font-bold">Space</span> یا دکمهٔ وسط/راست.
        </p>
        <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-brass/8 px-2 py-1.5 text-[10px] leading-4 text-brass2/90">
          <span className="mt-0.5 font-bold">◉</span>
          انتخاب مستقل نقاط: روی نقاط شروع/پایان کلیک کنید تا <span className="font-bold">مستقل</span> انتخاب شوند؛ با این کار <span className="font-bold">دسته‌های کنترل منحنی</span> همان المان ظاهر و قابل انتخاب می‌شوند. سپس با گرفتن هرکدام، همهٔ نقاط انتخاب‌شده با هم جابه‌جا می‌شوند (Shift برای انتخاب چندتایی). با <span className="font-bold">Delete</span> نقطه حذف می‌شود و اگر بین دو المان باشد، آن دو در یک المان ادغام می‌شوند تا مسیر حفظ شود.
        </p>
      </Section>

      <p className="px-1 pb-2 text-[10.5px] leading-5 text-dim">
        عملیات‌ها به ترتیبِ فهرست اجرا می‌شوند؛ با جابه‌جایی، حذف و افزودن آن‌ها استراتژی شخصی خود را بسازید. فلش‌ها روی مسیر، جهت حرکت ابزار را نشان می‌دهند.
      </p>
    </div>
  );
}

/* جمع‌شدن باکس‌های تنظیمات با دابل‌کلیک روی عنوان — وضعیت در localStorage می‌ماند */
const COLLAPSED_SECTIONS_KEY = "xarat-code.sections-collapsed";
function loadCollapsedSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => !!loadCollapsedSections()[title]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      const map = loadCollapsedSections();
      if (next) map[title] = true;
      else delete map[title];
      localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(map));
    } catch {
      /* ignore */
    }
  };
  return (
    <section className={cn("rounded-lg border border-edge bg-panel transition-colors", collapsed ? "px-2.5 py-1.5" : "p-2.5")}>
      <h3
        onDoubleClick={toggle}
        title={collapsed ? "دابل‌کلیک: باز کردن بخش" : "دابل‌کلیک: جمع کردن بخش"}
        className={cn(
          "group/head flex cursor-pointer select-none items-center gap-1.5 font-display text-[14px] leading-none text-ink/95",
          !collapsed && "mb-2"
        )}
      >
        {icon}
        <span className="flex-1 truncate">{title}</span>
        <svg
          viewBox="0 0 12 12"
          className={cn("h-2.5 w-2.5 shrink-0 text-dim transition-transform group-hover/head:text-brass", collapsed && "-rotate-180")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 8l4-4 4 4" />
        </svg>
      </h3>
      {!collapsed && <div>{children}</div>}
    </section>
  );
}

function MiniBtn({
  children,
  onClick,
  disabled,
  danger,
  tight,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** نسخهٔ نیم‌قد برای ستون فلش‌های روی‌هم */
  tight?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "grid h-5.5 w-5.5 place-items-center rounded border border-transparent text-mute transition-colors",
        tight && "!h-[13px] py-0",
        danger ? "hover:border-danger/50 hover:text-danger" : "hover:border-edge2 hover:text-ink",
        disabled && "cursor-not-allowed opacity-25 hover:border-transparent hover:text-mute"
      )}
    >
      <svg viewBox="0 0 12 12" className={cn("h-3 w-3", tight && "h-2.5 w-2.5")} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/* گلیف کوچک شکل مقطع */
function ShapeGlyph({ sides }: { sides: number }) {
  if (sides === 0)
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4">
        <circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  const pts = Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * 2 * Math.PI + Math.PI / sides;
    return `${(10 + 7.2 * Math.cos(a)).toFixed(1)},${(10 + 7.2 * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4">
      <polygon points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/* پیش‌نمایش پوشش دورانی — چرخش مقطع و محدودهٔ جاروب‌شده توسط گوشه‌ها */
function RotationalEnvelopePreview({ blankD, shape, rpm }: { blankD: number; shape: BlankShape; rpm: number }) {
  const env = rotationalEnvelope(blankD, shape);
  const W = 240;
  const H = 196;
  const cx = 120;
  const cy = 88;
  const maxR = 56;
  const scale = maxR / env.outR;
  const inPx = env.inR * scale;
  const outPx = env.outR * scale;
  const n = env.sides;
  const dur = Math.min(6, Math.max(1.1, 900 / rpm));
  const phase = n ? Math.PI / n : 0;

  const poly = (R: number, ph: number) =>
    Array.from({ length: n }, (_, k) => {
      const a = (k / n) * 2 * Math.PI + ph;
      return `${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`;
    }).join(" ");

  const corners = n
    ? Array.from({ length: n }, (_, k) => {
        const a = (k / n) * 2 * Math.PI + phase;
        return { x: cx + outPx * Math.cos(a), y: cy + outPx * Math.sin(a) };
      })
    : [];

  const growthPct = env.growth > 0 ? (env.growth / blankD) * 100 : 0;

  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-edge bg-[#120e09]">
      <div className="flex items-center justify-between border-b border-edge/60 px-2.5 py-1.5">
        <span className="text-[10px] font-bold text-mute">پوشش دورانی — Rotational Envelope</span>
        <span className="font-mono text-[9px] text-dim" dir="ltr">
          {rpm} rpm
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <radialGradient id="envGlow" cx="50%" cy="50%" r="50%">
            <stop offset="72%" stopColor="rgba(69,179,148,0)" />
            <stop offset="100%" stopColor="rgba(69,179,148,0.2)" />
          </radialGradient>
        </defs>

        {/* ناحیهٔ جاروب‌شده هنگام چرخش */}
        <circle cx={cx} cy={cy} r={outPx} fill="url(#envGlow)" />
        {/* دایرهٔ پوشش — قطر مؤثر دوران */}
        <circle cx={cx} cy={cy} r={outPx} fill="none" stroke="#45b394" strokeWidth={1.7} />
        {/* دایرهٔ قطر واقعی — محاطی */}
        <circle cx={cx} cy={cy} r={inPx} fill="rgba(227,169,78,0.05)" stroke="#e3a94e" strokeWidth={1.2} strokeDasharray="4 3" />

        {/* مقطع در حال چرخش + گوشه‌ها */}
        {n > 0 ? (
          <g style={{ transformOrigin: `${cx}px ${cy}px`, animation: `spin360 ${dur}s linear infinite` }}>
            <polygon points={poly(outPx, phase - 0.55)} fill="rgba(201,149,90,0.07)" />
            <polygon points={poly(outPx, phase - 0.28)} fill="rgba(201,149,90,0.13)" />
            <polygon points={poly(outPx, phase)} fill="rgba(201,149,90,0.32)" stroke="#d8a86c" strokeWidth={1.2} strokeLinejoin="round" />
            {corners.map((c, i) => (
              <circle key={i} cx={c.x} cy={c.y} r={2.7} fill="#e0703c" stroke="#ffd489" strokeWidth={1} />
            ))}
          </g>
        ) : (
          <circle cx={cx} cy={cy} r={inPx} fill="rgba(201,149,90,0.32)" stroke="#d8a86c" strokeWidth={1.2} />
        )}

        {/* محور چرخش */}
        <circle cx={cx} cy={cy} r={2.2} fill="#f3c26b" />
        <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="#f3c26b" strokeWidth={0.8} opacity={0.5} />

        {/* برچسب بالای پوشش */}
        <text x={cx} y={cy - outPx - 12} textAnchor="middle" fontSize={10.5} fontWeight={800} fontFamily="Vazirmatn, sans-serif" fill="#45b394">
          ⌀ دوران {env.maxRotD.toFixed(1)}
        </text>
        {/* برچسب پایین قطر واقعی */}
        <text x={cx} y={cy + outPx + 20} textAnchor="middle" fontSize={10} fontWeight={700} fontFamily="Vazirmatn, sans-serif" fill="#e3a94e">
          ⌀ واقعی {faNum(blankD)}
        </text>
      </svg>

      {/* آمار تفکیک‌شده */}
      <div className="grid grid-cols-3 gap-px border-t border-edge/60 bg-edge/40 text-center">
        <div className="bg-[#120e09] px-1 py-1.5">
          <div className="text-[8.5px] font-semibold text-dim">قطر واقعی</div>
          <div className="font-mono text-[11px] font-bold text-brass2" dir="ltr">
            ⌀{faNum(blankD)}
          </div>
        </div>
        <div className="bg-[#120e09] px-1 py-1.5">
          <div className="text-[8.5px] font-semibold text-dim">قطر دوران</div>
          <div className="font-mono text-[11px] font-bold text-teal" dir="ltr">
            ⌀{env.maxRotD.toFixed(1)}
          </div>
        </div>
        <div className="bg-[#120e09] px-1 py-1.5">
          <div className="text-[8.5px] font-semibold text-dim">افزایش {n > 0 ? `(${faNum(n)} گوشه)` : ""}</div>
          <div className="font-mono text-[11px] font-bold text-copper" dir="ltr">
            {env.growth > 0 ? `+${env.growth.toFixed(1)} / ${growthPct.toFixed(0)}%` : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ابعاد خام با پیش‌نویس — فقط با کلیک روی «اعمال» روی قطعه و مسیر اثر می‌گذارد */
function BlankDims({
  blankD,
  blankL,
  onApply,
}: {
  blankD: number;
  blankL: number;
  onApply: (d: number, l: number) => void;
}) {
  const [d, setD] = useState(blankD);
  const [l, setL] = useState(blankL);

  /* اگر مقدار اعمال‌شده از جای دیگری (مثلاً پیش‌تنظیم) عوض شد، پیش‌نویس همگام شود */
  useEffect(() => setD(blankD), [blankD]);
  useEffect(() => setL(blankL), [blankL]);

  const dirty = d !== blankD || l !== blankL;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Num label="قطر خام" unit="mm" value={d} min={10} max={200} step={2} onChange={setD} />
        <Num label="طول خام" unit="mm" value={l} min={20} max={400} step={5} onChange={setL} />
      </div>
      <button
        onClick={() => onApply(d, l)}
        disabled={!dirty}
        className={cn(
          "btn w-full justify-center !py-2 text-[12.5px] font-bold transition-all",
          dirty && "btn-brass shadow-[0_0_16px_rgba(227,169,78,0.28)]"
        )}
      >
        <IconCheck className="h-4 w-4" />
        اعمال
      </button>
      {dirty && (
        <p className="anim-in text-center text-[10px] leading-4 text-brass2/80">
          ابعاد تغییر کرده — برای اثرگذاری روی «اعمال» کلیک کنید
        </p>
      )}
    </div>
  );
}

/* فیلد عددی با پیش‌نویس — تایپ روان، اعتبارسنجی زنده، بازگشت به مقدار معتبر هنگام خروج */
function Num({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min?: number;
  max?: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState<string>(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  /* اگر min/max داده نشده باشد، عدد هیچ محدودیتی ندارد */
  const clamp = (v: number) => {
    let r = Math.round(v * 100) / 100;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  const commit = (raw: string) => {
    const v = parseFloat(raw.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
    if (!Number.isNaN(v) && Number.isFinite(v)) {
      onChange(clamp(v));
    }
  };

  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-semibold text-mute">{label}</span>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          className="field-input pl-12"
          value={text}
          dir="ltr"
          style={{ textAlign: "right" }}
          onFocus={() => (focused.current = true)}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => {
            focused.current = false;
            setText(String(value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const v = clamp(value + step);
              onChange(v);
              setText(String(v));
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const v = clamp(value - step);
              onChange(v);
              setText(String(v));
            }
          }}
        />
        <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[9.5px] text-dim">{unit}</span>
      </div>
    </label>
  );
}

/* گلیف جهت‌گیری اینسرت V 35° */
const HAND_GLYPHS: Record<ToolHand, ReactNode> = {
  center: <><path d="M12 4.5 14.5 20H9.5Z" /><path d="M12 4.5 12 20" strokeDasharray="2 2" /></>,
  right: <><path d="M15 4.5 8 20H16.5Z" /><path d="M12 4.5v15.5" strokeDasharray="2 2" /></>,
  left: <><path d="M9 4.5 16 20H7.5Z" /><path d="M12 4.5v15.5" strokeDasharray="2 2" /></>,
};

const TOOL_TYPES: { id: ToolType; name: string; glyph: ReactNode }[] = [
  { id: "angle", name: "اینسرت زاویه‌دار", glyph: <><path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" /><circle cx="12" cy="12" r="2.4" /></> },
  { id: "round", name: "اینسرت گرد", glyph: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.4" /></> },
  { id: "groove", name: "تیغه شیارزن", glyph: <><path d="M4 8.5h16v7H4z" /><path d="M9.5 15.5v-3.5M14.5 15.5v-3.5" /></> },
];

/* پیش‌نمایش مهندسی ابزار — همان پروفایل براده‌برداری با اندازه‌گذاری */
function ToolPreview({ tool }: { tool: ToolSpec }) {
  const prof = useMemo(() => toolProfile(tool), [tool]);
  const W = 224;
  const H = 124;
  const spanX = Math.max(2, prof.max - prof.min);
  const s = Math.min((W - 72) / spanX, (H - 60) / Math.max(3, prof.height * 0.6 + 2));
  const tipX = 42 - prof.min * s;
  const tipY = H - 34;
  const P = (dz: number, c: number): [number, number] => [tipX + dz * s, tipY - c * s];

  let d = "";
  prof.pts.forEach(([dz, c], i) => {
    const [x, y] = P(dz, c);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  const [xMaxE, yMaxE] = P(prof.max, prof.pts[prof.pts.length - 1][1]);
  const [xMinE, yMinE] = P(prof.min, prof.pts[0][1]);
  const yTop = Math.min(yMaxE, yMinE) - Math.min(26, prof.height * s * 0.45);
  const midX = (xMinE + xMaxE) / 2;
  const shW = Math.max(12, tool.shank * 0.45 * s);

  const dim = (x1: number, y1: number, x2: number, y2: number, label: string, ly?: number) => {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = (x: number, y: number) =>
      `M${x.toFixed(1)} ${y.toFixed(1)} l${(-4.5 * Math.cos(ang - 0.42)).toFixed(1)} ${(-4.5 * Math.sin(ang - 0.42)).toFixed(1)} M${x.toFixed(1)} ${y.toFixed(1)} l${(-4.5 * Math.cos(ang + 0.42)).toFixed(1)} ${(-4.5 * Math.sin(ang + 0.42)).toFixed(1)} `;
    return (
      <g>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#8b7c5f" strokeWidth={1} />
        <path d={head(x1, y1) + head(x2, y2)} stroke="#8b7c5f" strokeWidth={1} fill="none" />
        <text
          x={(x1 + x2) / 2}
          y={ly ?? Math.min(y1, y2) - 4}
          textAnchor="middle"
          fontSize={9}
          fontWeight={700}
          fontFamily="JetBrains Mono, monospace"
          fill="#d8c49a"
          stroke="#120e09"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {label}
        </text>
      </g>
    );
  };

  const gridX: number[] = [];
  for (let z = Math.ceil(prof.min / 5) * 5; z <= prof.max; z += 5) gridX.push(z);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md border border-edge bg-[#120e09]">
      <defs>
        <linearGradient id="toolGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#aeb9c4" />
          <stop offset="0.55" stopColor="#7d8a95" />
          <stop offset="1" stopColor="#4f5b66" />
        </linearGradient>
      </defs>
      {/* شبکه */}
      {gridX.map((z) => (
        <line key={z} x1={tipX + z * s} y1={12} x2={tipX + z * s} y2={tipY + 6} stroke="rgba(209,183,134,0.08)" strokeWidth={1} />
      ))}
      {/* خط سطح قطعه */}
      <line x1={8} y1={tipY} x2={W - 8} y2={tipY} stroke="rgba(227,169,78,0.4)" strokeWidth={1} strokeDasharray="6 3 1.5 3" />
      <text x={W - 10} y={tipY + 11} textAnchor="end" fontSize={7.5} fill="#8b7c5f" fontFamily="JetBrains Mono, monospace">
        سطح قطعه
      </text>
      {/* دنباله */}
      <rect x={midX - shW / 2} y={yTop - 14} width={shW} height={16} fill="#333c45" stroke="#1d2329" strokeWidth={1} />
      {/* اینسرت */}
      <path d={`${d} L${xMaxE.toFixed(1)} ${yTop.toFixed(1)} L${xMinE.toFixed(1)} ${yTop.toFixed(1)} Z`} fill="url(#toolGrad)" stroke="rgba(0,0,0,0.45)" strokeWidth={1} />
      {/* لبه برنده */}
      <path d={d} fill="none" stroke="#f3c26b" strokeWidth={2} strokeLinecap="round" />
      {/* نوک */}
      <circle cx={tipX} cy={tipY} r={2.4} fill="#f3c26b" />

      {/* اندازه‌گذاری‌ها */}
      {tool.type === "angle" && (
        <g>
          {/* شعاع نوک — تنها پارامتر */}
          <circle cx={tipX} cy={tipY - tool.nose * s} r={Math.max(3, tool.nose * s)} fill="none" stroke="#f59a80" strokeWidth={1} strokeDasharray="2.5 2" />
          {dim(tipX, tipY, tipX, tipY - tool.nose * s, `R${tool.nose}`, tipY - tool.nose * s - 5)}
          {/* خط عمودی مبنا */}
          <line x1={tipX} y1={tipY} x2={tipX} y2={yTop} stroke="rgba(209,183,134,0.28)" strokeWidth={1} strokeDasharray="3 3" />
          {/* برچسب اینسرت و دسته */}
          <text x={midX} y={yTop + 13} textAnchor="middle" fontSize={9.5} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill="#2b333b">
            V{tool.angle}°
          </text>
          <text x={midX} y={yTop - 3} textAnchor="middle" fontSize={9.5} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill="#d8c49a" stroke="#120e09" strokeWidth={3} paintOrder="stroke">
            {HAND_INFO[tool.hand].name} {HAND_INFO[tool.hand].k}°
          </text>
        </g>
      )}
      {tool.type === "groove" && (
        <g>
          {dim(xMinE, tipY + 8, xMaxE, tipY + 8, `W ${tool.width}`, tipY + 22)}
          <text x={tipX + (prof.max - prof.min) * s + 8} y={tipY - 4} fontSize={8.5} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill="#d8c49a" stroke="#120e09" strokeWidth={3} paintOrder="stroke">
            R{tool.corner}
          </text>
        </g>
      )}
      {tool.type === "round" && (
        <g>
          {(() => {
            const [ax, ay] = P(tool.radius * 0.7, tool.radius - Math.sqrt(Math.max(0, tool.radius ** 2 - (tool.radius * 0.7) ** 2)));
            return dim(ax, ay, ax + 22, ay - 14, `R ${tool.radius}`, ay - 22);
          })()}
        </g>
      )}
    </svg>
  );
}

const faNum = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
const clampZ = (v: number, blankL: number) => Math.min(blankL, Math.max(0, v));

/* تولید نواحی از هر تقسیم‌بندی */
function zonesFromBounds(bounds: number[], blankL: number): { a: number; b: number }[] {
  const all = [0, ...bounds.sort((a, b) => a - b).filter((v) => v > 0.3 && v < blankL - 0.3), blankL];
  const zones: { a: number; b: number }[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i + 1] - all[i] > 0.3) zones.push({ a: all[i], b: all[i + 1] });
  }
  return zones.length ? zones : [{ a: 0, b: blankL }];
}

/* چیدمان کتروگرافی — ناحیهٔ محدود/محدود */
function ZoneOrderEditor({
  blankL,
  blankR,
  samples,
  autoZones,
  committedBounds,
  committedOrder,
  onConfirm,
  onReset,
}: {
  blankL: number;
  blankR: number;
  samples: Sample[];
  autoZones: { a: number; b: number }[];
  committedBounds: number[];
  committedOrder: number[];
  onConfirm: (p: { bounds: number[]; order: number[] }) => void;
  onReset: (p: { defaults: boolean }) => void;
}) {
  /* مرزهای اولیه: از مرزهای کاربر یا از نوک قله‌های تقسیم خودکار (انتهای هر       */
  /* ناحیه = نوک قلهٔ آن؛ با این روش آخرین قله نیز به‌درستی مرز می‌شود)           */
  const [bounds, setBounds] = useState<number[]>(
    (committedBounds.length ? committedBounds : autoZones.slice(0, autoZones.length - 1).map((z) => z.b)).map((v) => clampZ(v, blankL))
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const zones = useMemo(() => zonesFromBounds(bounds, blankL), [bounds, blankL]);
  const n = zones.length;

  /* اولویت‌ها */
  const validCommittedOrder =
    committedOrder.length === n &&
    committedOrder.every((v) => v >= 0 && v < n) &&
    new Set(committedOrder).size === n;
  const [order, setOrder] = useState<number[]>(validCommittedOrder ? committedOrder : []);

  /* هر بار تعداد نواحی تغییر کرد، فقط اولویت‌های معتبر نگه داشته می‌شوند */
  useEffect(() => {
    setOrder((p) => p.filter((v) => v < n));
  }, [n]);

  const W = 240;
  const H = 92;
  const PAD = 6;
  const YC = 40;
  const HALF = 28;
  const DIV_TOP = 14;
  const NUM_Y = H - 10;
  const X = (z: number) => PAD + (z / Math.max(0.001, blankL)) * (W - 2 * PAD);
  const Y = (r: number) => YC - (r / Math.max(0.001, blankR)) * HALF;
  const zFromX = (px: number) => clampZ(((px - PAD) / (W - 2 * PAD)) * blankL, blankL);

  const pointerToZ = (e: React.PointerEvent | React.MouseEvent) => {
    const el = svgRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return zFromX(((e.clientX - rect.left) / Math.max(1, rect.width)) * W);
  };

  const silhouette = useMemo(() => {
    if (samples.length < 2) return "";
    let d = `M ${X(samples[0].z).toFixed(1)} ${Y(samples[0].r).toFixed(1)}`;
    for (const s of samples) d += ` L ${X(s.z).toFixed(1)} ${Y(s.r).toFixed(1)}`;
    for (let i = samples.length - 1; i >= 0; i--) d += ` L ${X(samples[i].z).toFixed(1)} ${(2 * YC - Y(samples[i].r)).toFixed(1)}`;
    return d + " Z";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, blankL, blankR]);

  const snapBound = (z: number, idx: number) => {
    const lo = idx > 0 ? bounds[idx - 1] + 2 : 0.5;
    const hi = idx < bounds.length - 1 ? bounds[idx + 1] - 2 : blankL - 0.5;
    return Math.round(Math.min(hi, Math.max(lo, z)));
  };

  const onBgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragIdx != null) return;
    const z = Math.round(pointerToZ(e));
    // اگر به مرز فعلی نزدیک بود، جداکنندهٔ جدید اضافه نکن
    if (bounds.some((b) => Math.abs(b - z) < 3)) return;
    setBounds((bs) => [...bs, clampZ(z, blankL)].sort((a, b) => a - b));
  };

  const sortedBounds = JSON.stringify([...bounds].sort((a, b) => a - b));
  const dirtyBounds =
    !(bounds.length === 0 && committedBounds.length === 0) &&
    sortedBounds !== JSON.stringify([...committedBounds].sort((a, b) => a - b));

  const complete = order.length === n && n > 0;
  const dirtyOrder =
    (validCommittedOrder ? JSON.stringify(committedOrder) : "[]") !==
    (complete ? JSON.stringify(order) : "[]");
  const dirty = dirtyBounds || dirtyOrder;

  const toggle = (i: number) => setOrder((p) => (p.includes(i) ? p.filter((v) => v !== i) : [...p, i]));

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold text-mute">نواحی + ترتیب (دستی)</span>
        <span className="rounded-full border border-edge px-2 py-0.5 font-mono text-[9px] font-bold text-mute">
          {faNum(n)} ناحیه
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none touch-none rounded-md border border-edge bg-[#120e09]"
        style={{ cursor: dragIdx != null ? "ew-resize" : "crosshair" }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragIdx != null) {
            const z = snapBound(pointerToZ(e), dragIdx);
            setBounds((bs) => bs.map((b, i) => (i === dragIdx ? z : b)));
          }
        }}
        onPointerUp={() => setDragIdx(null)}
        onPointerLeave={() => {
          if (dragIdx == null) setHoverIdx(null);
          setDragIdx(null);
        }}
        onClick={onBgClick}
      >
        {/* سیلوئت قطعه */}
        <path d={silhouette} fill="rgba(201,149,90,0.18)" stroke="rgba(227,169,78,0.5)" strokeWidth={1} />

        {/* نواحی */}
        {zones.map((z, i) => {
          const pos = order.indexOf(i);
          const selected = pos >= 0;
          const xa = X(z.a);
          const xb = X(z.b);
          const cx = (xa + xb) / 2;
          return (
            <g key={i}>
              <rect
                x={xa}
                y={DIV_TOP}
                width={Math.max(0.5, xb - xa)}
                height={2 * YC + 6 - DIV_TOP}
                fill={selected ? "rgba(69,179,148,0.14)" : "transparent"}
              />
              {/* شماره اولویت */}
              <g onClick={(e) => { e.stopPropagation(); toggle(i); }} className="cursor-pointer">
                {selected ? (
                  <>
                    <circle cx={cx} cy={NUM_Y} r={9} fill="#e0703c" stroke="#120e09" strokeWidth={1.5} />
                    <text x={cx} y={NUM_Y + 3.5} textAnchor="middle" fontSize={10} fontWeight={800} fontFamily="Vazirmatn, sans-serif" fill="#fff7ec">
                      {faNum(pos + 1)}
                    </text>
                  </>
                ) : (
                  <g className="transition-opacity hover:opacity-100" opacity={0.55}>
                    <circle cx={cx} cy={NUM_Y} r={8.5} fill="none" stroke="#6f6047" strokeWidth={1} strokeDasharray="2.5 2" />
                    <text x={cx} y={NUM_Y + 3} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily="Vazirmatn, sans-serif" fill="#8b7c5f">
                      {faNum(i + 1)}
                    </text>
                  </g>
                )}
              </g>
            </g>
          );
        })}

        {/* خطوط تقسیم (قابل کشیدن) */}
        {bounds.map((b, i) => {
          const x = X(b);
          const active = dragIdx === i;
          const hov = hoverIdx === i;
          return (
            <g
              key={i}
              className="cursor-ew-resize"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDragIdx(i);
              }}
              onPointerEnter={() => setHoverIdx(i)}
              onPointerLeave={() => setHoverIdx(null)}
            >
              <rect x={x - 5} y={DIV_TOP - 4} width={10} height={2 * YC + 10} fill="transparent" />
              <line x1={x} y1={DIV_TOP} x2={x} y2={2 * YC + 6} stroke={active || hov ? "#f3c26b" : "#45b394"} strokeWidth={1.6} strokeDasharray="4 3" />
              {/* دستگیره بالای مرز */}
              <circle cx={x} cy={DIV_TOP} r={active ? 5 : hov ? 4.5 : 4} fill={active || hov ? "#f3c26b" : "#45b394"} stroke="#120e09" strokeWidth={1.5} />
              <text x={x} y={DIV_TOP - 8} textAnchor="middle" fontSize={8} fontFamily="JetBrains Mono, monospace" fill={active || hov ? "#f3c26b" : "#45b394"} fontWeight={700}>
                {Math.round(b)}
              </text>
              {/* دکمهٔ حذف مرز */}
              {(active || hov) && (
                <g
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBounds((bs) => bs.filter((_, j) => j !== i));
                  }}
                >
                  <circle cx={x + 10} cy={DIV_TOP} r={5.5} fill="#d95848" stroke="#120e09" strokeWidth={1.2} />
                  <text x={x + 10} y={DIV_TOP + 3} textAnchor="middle" fontSize={9} fontWeight={900} fill="#fff">
                    ×
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      <p className="mt-1 text-[9.5px] leading-4 text-dim">
        <span className="text-teal">مرزها را بکشید یا روی پس‌زمینه کلیک کنید تا جداکنندهٔ جدید شود</span>؛ برای حذف یک مرز، روی آن بروید و × را بزنید. سپس روی دایره‌های شماره کلیک کنید تا ترتیب تراش مشخص شود و در نهایت «تأیید» را بزنید.
      </p>

      <div className="mt-1.5 flex gap-1.5">
        <button
          onClick={() => onConfirm({ bounds: [...bounds].sort((a, b) => a - b), order: complete ? order : [] })}
          disabled={!dirty}
          className={cn("btn btn-brass flex-1 justify-center !py-2 text-[12px] font-bold", !dirty && "opacity-40")}
          title="اعمال نواحی و ترتیب و ساخت جی‌کد"
        >
          <IconCheck className="h-4 w-4" />
          تأیید و ساخت جی‌کد
        </button>
        <button
          onClick={() => {
            /* بازنشانی روی نوک قله‌های تقسیم خودکار (نه وسط نواحی/دره‌ها) */
            const bz = autoZones.slice(0, -1).map((z) => z.b);
            setBounds(bz.map((v) => clampZ(Math.round(v), blankL)));
            setOrder([]);
            onReset({ defaults: true });
          }}
          className="btn justify-center !py-2 text-[12px]"
          title="بازگشت به تقسیم خودکار بر اساس قله‌ها و دره‌ها"
        >
          خودکار
        </button>
      </div>
      {order.length > 0 && !complete && (
        <p className="mt-1 text-center text-[9.5px] text-copper">
          {faNum(order.length)} از {faNum(n)} ناحیه اولویت دارد — برای ترتیب کامل، همهٔ نواحی را انتخاب کنید
        </p>
      )}
    </div>
  );
}
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between rounded-md border border-edge bg-panel2 px-2.5 py-1.5 text-right transition-colors hover:border-edge2"
    >
      <span className="text-[11.5px] font-semibold text-ink/85">{label}</span>
      <span className={cn("relative h-4 w-8 shrink-0 rounded-full border transition-colors", on ? "border-brass/60 bg-brass/30" : "border-edge2 bg-bg")}>
        <span
          className={cn(
            "absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all",
            on ? "right-0.5 bg-brass2 shadow-[0_0_8px_rgba(243,194,107,0.6)]" : "right-[calc(100%-14px)] bg-dim"
          )}
        />
      </span>
    </button>
  );
}

/* memo: والد هنگام پخش شبیه‌سازی با هر خط جی‌کد رندر می‌شود؛ این پنل فقط با تغییر params/preset بازرندر شود */
export default memo(ControlsPanel);
