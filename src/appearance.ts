// Per-device look of the notes: font and window opacity. Stored in localStorage, which every
// Stickit window shares, so a change shows up in open notes right away via the storage event.
import "@fontsource/caveat/latin-400.css";
import "@fontsource/eb-garamond/latin-400.css";

export const FONTS = {
  default: { label: "Default", family: "system-ui, sans-serif", size: "14px" },
  book: { label: "Old printed book", family: "'EB Garamond', Georgia, serif", size: "16px" },
  hand: { label: "Handwriting", family: "Caveat, 'Segoe Print', cursive", size: "19px" },
};
export type FontKey = keyof typeof FONTS;
export interface Look { font: FontKey; opacity: number }

const KEY = "stickit.look";

export function getLook(): Look {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      font: l.font in FONTS ? l.font : "default",
      opacity: Math.min(100, Math.max(30, Number(l.opacity) || 80)),
    };
  } catch {
    return { font: "default", opacity: 80 };
  }
}

export function applyLook() {
  const { font, opacity } = getLook();
  const s = document.documentElement.style;
  s.setProperty("--note-font", FONTS[font].family);
  s.setProperty("--note-size", FONTS[font].size);
  s.setProperty("--alpha", String(opacity / 100));
}

export function setLook(l: Look) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* private mode: applies for this session only */
  }
  applyLook();
}

applyLook();
window.addEventListener("storage", applyLook);
