// Per-device look of the notes: font, window opacity and lined paper. Stored in localStorage,
// which every Stickit window shares, so a change shows up in open notes right away via the
// storage event.
import "@fontsource/caveat/latin-400.css";
import "@fontsource/eb-garamond/latin-400.css";

// `line` is the line height used on lined paper; the ruled lines are spaced to match it.
export const FONTS = {
  default: { label: "Default", family: "system-ui, sans-serif", size: "14px", line: "22px" },
  book: { label: "Old printed book", family: "'EB Garamond', Georgia, serif", size: "16px", line: "24px" },
  hand: { label: "Handwriting", family: "Caveat, 'Segoe Print', cursive", size: "19px", line: "26px" },
};
export type FontKey = keyof typeof FONTS;
export interface Look { font: FontKey; opacity: number; lines: boolean }

const KEY = "stickit.look";

export function getLook(): Look {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      font: l.font in FONTS ? l.font : "default",
      opacity: Math.min(100, Math.max(30, Number(l.opacity) || 80)),
      lines: l.lines === true,
    };
  } catch {
    return { font: "default", opacity: 80, lines: false };
  }
}

export function applyLook() {
  const { font, opacity, lines } = getLook();
  const root = document.documentElement;
  root.style.setProperty("--note-font", FONTS[font].family);
  root.style.setProperty("--note-size", FONTS[font].size);
  root.style.setProperty("--note-line", FONTS[font].line);
  root.style.setProperty("--alpha", String(opacity / 100));
  root.classList.toggle("lined", lines);
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
