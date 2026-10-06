import type { ReactNode } from "react";

interface P {
  className?: string;
}

const base = (props: P, children: ReactNode, filled = false) => (
  <svg
    className={props.className ?? "w-4 h-4"}
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke={filled ? "none" : "currentColor"}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const IconPlay = (p: P) => base(p, <path d="M7 4.5v15l13-7.5z" />, true);
export const IconPause = (p: P) =>
  base(p, <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>, true);
export const IconReset = (p: P) =>
  base(p, <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>);
export const IconDownload = (p: P) =>
  base(p, <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></>);
export const IconCopy = (p: P) =>
  base(p, <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const IconUndo = (p: P) =>
  base(p, <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>);
export const IconRedo = (p: P) =>
  base(p, <><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></>);
export const IconFit = (p: P) =>
  base(p, <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>);
export const IconPlus = (p: P) => base(p, <><path d="M12 5v14" /><path d="M5 12h14" /></>);
export const IconMinus = (p: P) => base(p, <path d="M5 12h14" />);
export const IconTrash = (p: P) =>
  base(p, <><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></>);
export const IconCode = (p: P) =>
  base(p, <><path d="m8 7-5 5 5 5" /><path d="m16 7 5 5-5 5" /><path d="m13 4-2 16" /></>);
export const IconPen = (p: P) =>
  base(p, <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>);
export const IconSim = (p: P) =>
  base(p, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>);
export const IconCheck = (p: P) => base(p, <path d="m4 12.5 5 5L20 6.5" />);
export const IconCurve = (p: P) =>
  base(p, <path d="M3 17c4 0 5-10 9-10s5 10 9 10" />);
export const IconCorner = (p: P) => base(p, <path d="M4 19V9l11-5v15" />);
export const IconMagnet = (p: P) =>
  base(p, <><path d="M5 9a7 7 0 0 0 14 0V3h-4v6a3 3 0 0 1-6 0V3H5z" /><path d="M5 3v3h4V3M15 3v3h4V3" /></>);
export const IconSpindle = (p: P) =>
  base(p, <><path d="M2 12h3" /><path d="M19 12h3" /><path d="M5 8c3 0 3 3 5.5 3S14 8 19 8v8c-5 0-8.5-3-11-3S8 16 5 16z" /><path d="M12 4v2M12 18v2" /></>);
export const IconWarn = (p: P) =>
  base(p, <><path d="M12 3 2.5 20h19z" /><path d="M12 9.5V14" /><path d="M12 17h.01" /></>);
export const IconLayers = (p: P) =>
  base(p, <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>);
export const IconGrid = (p: P) =>
  base(p, <><rect x="3" y="3" width="18" height="18" rx="1.5" /><path d="M9 3v18M15 3v18M3 9h18M3 15h18" /></>);
export const IconViewXY = (p: P) =>
  base(p, <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" /></>);
export const IconViewXZ = (p: P) =>
  base(p, <><rect x="2.5" y="7.5" width="19" height="9" rx="2" /><path d="M2.5 12h19" strokeDasharray="3 2.4" /><path d="M6.5 7.5v9M17.5 7.5v9" /></>);
export const IconEye = (p: P) =>
  base(p, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>);
export const IconEyeOff = (p: P) =>
  base(p, <><path d="M3 3l18 18" /><path d="M10.6 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4M6.6 6.6A16.9 16.9 0 0 0 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.8" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IconX = (p: P) => base(p, <path d="M18 6 6 18M6 6l12 12" />);
export const IconWindow = (p: P) =>
  base(p, <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9.5 4v16" /><path d="M3 9.5h6.5" /></>);
export const IconTool = (p: P) =>
  base(p, <><path d="M12 2.5 20.5 11 12 19.5 3.5 11z" /><circle cx="12" cy="11" r="2.6" /><path d="M12 19.5V23" /></>);
export const IconCursor = (p: P) =>
  base(p, <><path d="m5 3 14 8-6.5 1.8L9.5 19z" /></>);
export const IconLine = (p: P) =>
  base(p, <><path d="M5 19 19 5" /><circle cx="5" cy="19" r="2.2" /><circle cx="19" cy="5" r="2.2" /></>);
export const IconQuad = (p: P) =>
  base(p, <><path d="M4 19C4 9 14 5 20 5" /><circle cx="4" cy="19" r="2.2" /><circle cx="20" cy="5" r="2.2" /><path d="M4 19 4 7" strokeDasharray="2 2" /><circle cx="4" cy="6" r="1.6" /></>);
export const IconCubic = (p: P) =>
  base(p, <><path d="M3 18c4 0 4-11 9-11s5 11 9 11" /><circle cx="3" cy="18" r="2" /><circle cx="21" cy="18" r="2" /><circle cx="8" cy="7" r="1.5" /><circle cx="16" cy="7" r="1.5" /></>);
export const IconArc3 = (p: P) =>
  base(p, <><path d="M4 18a9 9 0 0 1 16 0" /><circle cx="4" cy="18" r="2.1" /><circle cx="20" cy="18" r="2.1" /><circle cx="12" cy="9" r="1.8" /></>);
export const IconMagnetSm = (p: P) =>
  base(p, <><path d="M6 4v7a6 6 0 0 0 12 0V4h-4v7a2 2 0 0 1-4 0V4z" /></>);
export const IconSplit = (p: P) =>
  base(p, <><circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" /><path d="M8.2 7.8 20 19M8.2 16.2 20 5" /><path d="M14 3.5v17" strokeDasharray="2.5 2.5" /></>);
export const IconBowl = (p: P) =>
  base(p, <><path d="M3 12h18" /><path d="M4 12a8 8 0 0 0 16 0" /><path d="M9 20h6" /></>);
export const IconHand = (p: P) =>
  base(p, <><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-5.5v-1a1.5 1.5 0 0 1 3 0V11m0-4.5a1.5 1.5 0 0 1 3 0V12m0-2.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.8a6 6 0 0 1-4.7-2.3L4 14.6a1.6 1.6 0 0 1 2.4-2.1L8 14" /></>);

export const IconMove = (p: P) =>
  base(p, <><path d="M12 2v20M2 12h20" /><path d="m8.5 5.5 3.5-3.5 3.5 3.5M8.5 18.5 12 22l3.5-3.5M5.5 8.5 2 12l3.5 3.5M18.5 8.5 22 12l-3.5 3.5" /></>);
