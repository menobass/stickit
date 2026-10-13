import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FONTS, getLook, setLook, type FontKey } from "./appearance";
import {
  connectAccount, getConfig, joinRemoteVault, notify, rcPercent, syncNow,
  RC_PAUSE_PCT, RC_WARN_PCT, type HiveConfig, type RemoteVault,
} from "./hive";

interface Note { id: number; body: string }

const win = getCurrentWindow();
const noteId = Number(new URLSearchParams(location.search).get("note")) || null;
const MIN_PASSPHRASE = 8;

function el<T extends HTMLElement = HTMLElement>(tag: string, props: object = {}, ...kids: Node[]) {
  const e = Object.assign(document.createElement(tag), props) as T;
  e.append(...kids);
  return e;
}

function bar(...buttons: HTMLElement[]) {
  const grow = el("div", { className: "grow" });
  grow.setAttribute("data-tauri-drag-region", "");
  return el("div", { className: "bar" }, grow, ...buttons);
}

function button(label: string, title: string, onclick: () => void) {
  return el<HTMLButtonElement>("button", { textContent: label, title, onclick });
}

function show(...kids: Node[]) {
  document.body.replaceChildren(...kids);
}

/** A small form: inputs + submit. Errors from `onSubmit` are shown under the fields. */
function form(intro: string, fields: { placeholder: string }[], submit: string, onSubmit: (v: string[]) => Promise<void>) {
  const inputs = fields.map((f) =>
    el<HTMLInputElement>("input", { placeholder: f.placeholder, type: "password", autocomplete: "off" }),
  );
  // Every secret field gets a show/hide toggle.
  const rows = inputs.map((input) => {
    const eye = el<HTMLButtonElement>("button", { type: "button", textContent: "👁", title: "Show / hide" });
    eye.onclick = () => {
      input.type = input.type === "password" ? "text" : "password";
      eye.style.opacity = input.type === "password" ? "0.6" : "1";
    };
    eye.style.opacity = "0.6";
    return el("div", { className: "pw" }, input, eye);
  });
  const error = el("p", { className: "err" });
  const go = el<HTMLButtonElement>("button", { type: "submit", textContent: submit, className: "primary" });
  const f = el<HTMLFormElement>("form", { className: "panel" }, el("p", { textContent: intro }), ...rows, error, go);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    error.textContent = "";
    go.disabled = true;
    go.textContent = "Working…";
    try {
      await onSubmit(inputs.map((i) => i.value));
    } catch (e) {
      error.textContent = String(e);
      go.disabled = false;
      go.textContent = submit;
    }
  };
  queueMicrotask(() => inputs[0]?.focus());
  return f;
}

function checkNew(pass: string, confirm: string) {
  if (pass.length < MIN_PASSPHRASE) throw `Use at least ${MIN_PASSPHRASE} characters. A few random words works well.`;
  if (pass !== confirm) throw "The two passphrases don't match.";
}

// ---- list window ----

let refreshList: (() => void) | null = null;
let showingRecovery = false;

function listView() {
  document.body.className = "list";
  listen("notes-changed", () => refreshList?.());
  listen("vault-changed", render);
  listen("sync-due", () => autoSync());
  setInterval(() => refreshList && autoSync(false, true), 60_000);
  render();

  async function render() {
    if (showingRecovery) return;
    refreshList = null;
    const status = await invoke<string>("vault_status");
    if (status === "none") return setupScreen();
    if (status === "locked") return unlockScreen();
    notesScreen();
    autoSync(true);
  }

  function setupScreen() {
    show(
      bar(button("–", "Hide to tray", () => win.close())),
      form(
        "Create your vault. This passphrase encrypts all your notes and can't be reset by anyone.",
        [{ placeholder: "Passphrase" }, { placeholder: "Repeat passphrase" }],
        "Create vault",
        async ([pass, again]) => {
          checkNew(pass, again);
          showingRecovery = true;
          let phrase: string;
          try {
            phrase = await invoke<string>("create_vault", { passphrase: pass });
          } catch (e) {
            showingRecovery = false;
            throw e;
          }
          recoveryScreen(phrase);
        },
      ),
    );
  }

  function recoveryScreen(phrase: string) {
    const words = el(
      "div",
      { className: "words" },
      ...phrase.split(" ").map((w, i) =>
        el("div", { className: "word" }, el("span", { className: "n", textContent: `${i + 1}` }), el("span", { textContent: w })),
      ),
    );
    show(
      bar(button("–", "Hide to tray", () => win.close())),
      el(
        "div",
        { className: "panel" },
        el("p", { textContent: "Write these 24 words down and keep them somewhere safe. They are the only way back in if you forget your passphrase, and they won't be shown again." }),
        words,
      ),
      el("button", {
        textContent: "I've written it down",
        className: "primary pinned",
        onclick: () => {
          showingRecovery = false;
          render();
        },
      }),
    );
  }

  function unlockScreen() {
    show(
      bar(button("–", "Hide to tray", () => win.close())),
      form("Notes are locked.", [{ placeholder: "Passphrase" }], "Unlock", ([pass]) =>
        invoke("unlock_vault", { passphrase: pass }),
      ),
      button("Forgot it? Use recovery phrase", "", recoveryForm),
    );
    document.body.lastElementChild!.className = "link";
  }

  /** 24 numbered boxes laid out like the screen the phrase was written down from. */
  function recoveryForm() {
    const inputs = Array.from({ length: 24 }, () =>
      el<HTMLInputElement>("input", { type: "text", autocomplete: "off", spellcheck: false }),
    );
    // Pasting the whole phrase (or several words) into any box spreads it across the boxes.
    inputs.forEach((input, i) => {
      input.onpaste = (ev) => {
        const words = (ev.clipboardData?.getData("text") ?? "").trim().toLowerCase().split(/\s+/);
        if (words.length < 2) return;
        ev.preventDefault();
        words.slice(0, 24 - i).forEach((w, k) => (inputs[i + k].value = w));
        inputs[Math.min(i + words.length, 23)].focus();
      };
      // Space moves to the next box instead of typing into this one.
      input.onkeydown = (ev) => {
        if (ev.key === " " && input.value) {
          ev.preventDefault();
          inputs[i + 1]?.focus();
        }
      };
    });
    const grid = el(
      "div",
      { className: "words entry" },
      ...inputs.map((input, i) => el("label", { className: "word" }, el("span", { className: "n", textContent: `${i + 1}` }), input)),
    );
    const fresh = form(
      "Enter your 24-word recovery phrase in order, then choose a new passphrase.",
      [{ placeholder: "New passphrase" }, { placeholder: "Repeat new passphrase" }],
      "Recover",
      async ([pass, again]) => {
        const words = inputs.map((i) => i.value.trim().toLowerCase());
        if (words.some((w) => !w)) throw "Fill in all 24 words.";
        checkNew(pass, again);
        await invoke("recover_vault", { phrase: words.join(" "), newPassphrase: pass });
      },
    );
    // Words first, then the passphrase fields and submit button.
    fresh.insertBefore(grid, fresh.children[1]);
    show(bar(button("←", "Back", render), button("–", "Hide to tray", () => win.close())), fresh);
    // form() queues its own focus; land after it.
    setTimeout(() => inputs[0].focus());
  }

  function notesScreen() {
    const search = el<HTMLInputElement>("input", { placeholder: "Search notes…", type: "search" });
    const ul = el("ul");
    const footer = el("div", { className: "footer" });

    async function refresh() {
      const notes = await invoke<Note[]>("list_notes", { query: search.value });
      ul.replaceChildren(
        ...(notes.length
          ? notes.map((n) =>
              el("li", {
                textContent: preview(n),
                onclick: () => invoke("open_note_window", { id: n.id }),
              }),
            )
          : [el("li", { className: "empty", textContent: search.value ? "No matches" : "No notes yet" })]),
      );
    }

    const syncBtn = button("⟳", "Sync now", async () => {
      if (!(await getConfig()).account) return hiveScreen(render);
      syncBtn.disabled = true;
      syncBtn.textContent = "…";
      try {
        await syncNow();
        await refresh();
        await fillFooter(footer);
      } catch (e) {
        footer.replaceChildren(el("p", { className: "err", textContent: `Sync failed: ${e instanceof Error ? e.message : e}` }));
      }
      syncBtn.disabled = false;
      syncBtn.textContent = "⟳";
    });

    search.oninput = refresh;
    refreshList = refresh;
    show(
      bar(
        button("+", "New note", () => invoke("create_note")),
        syncBtn,
        button("⚙", "Settings", () => settingsScreen(render)),
        button("🔒", "Lock vault", () => invoke("lock_vault")),
        button("–", "Hide to tray", () => win.close()),
      ),
      search,
      ul,
      footer,
    );
    refresh();
    fillFooter(footer);
  }
}

// ---- hive backup ----

let lastAutoSync = 0;

/** Runs a background sync when auto-sync is on. `onUnlock` syncs at most once per 5 minutes.
 *  A `poll` only pulls (no RC spent) and stays quiet: it runs every minute to pick up notes
 *  written on another device, such as the PWA. */
async function autoSync(onUnlock = false, poll = false) {
  try {
    const cfg = await getConfig();
    if (!cfg.account || !cfg.autosync) return;
    if (onUnlock && Date.now() - lastAutoSync < 5 * 60_000) return;
    if (!poll) lastAutoSync = Date.now();
    const r = await syncNow({ push: !poll });
    const day = new Date().toDateString();
    if (r.rc !== null && r.rc < RC_WARN_PCT && localStorage.getItem("rcWarnDay") !== day) {
      localStorage.setItem("rcWarnDay", day);
      notify("Stickit: Resource Credits are low", `${r.rc.toFixed(0)}% left. Auto-sync pauses at ${RC_PAUSE_PCT}%. Open Hive backup for details.`);
    }
    refreshList?.();
  } catch (e) {
    if (poll) return;
    notify("Stickit: backup failed", String(e instanceof Error ? e.message : e));
  }
}

function rcBar(pct: number) {
  const fill = el("div", { className: "rc-fill" });
  fill.style.width = `${pct}%`;
  if (pct < RC_WARN_PCT) fill.classList.add("low");
  return el("div", { className: "rc" }, el("div", { className: "rc-track" }, fill), el("span", { textContent: `RC ${pct.toFixed(0)}%` }));
}

/** Small RC meter under the note list, only when a Hive account is connected. */
async function fillFooter(footer: HTMLElement) {
  try {
    const cfg = await getConfig();
    if (!cfg.account) return;
    footer.replaceChildren(rcBar(await rcPercent(cfg.account)));
  } catch {
    /* offline: leave the footer empty */
  }
}

const HELP: [string, string][] = [
  ["What are Resource Credits?", "Every action on Hive, including each note you back up, spends a little of an account's Resource Credits (RC). RC refill on their own over about 5 days."],
  ["Why can a new account only back up a few times?", "The amount of RC an account has depends on how much Hive Power it holds. A brand-new account has very little, so it can only do a limited number of backups before RC run out and sync pauses until they refill."],
  ["How do I get more?", "Buy HIVE and \"power it up\" (lock it as Hive Power) on the account. More Hive Power means more RC, so more notes and more frequent backups. The HIVE stays yours: powering down later takes a few weeks."],
  ["Is my data public?", "Notes are encrypted on your device before they are posted, so Hive only holds scrambled text. It is permanent, though: a deleted note disappears from Hive's current state but stays in the block history in encrypted form. Use a strong passphrase."],
];

function help() {
  const link = el("button", { className: "link", textContent: "Learn more at hive.io", onclick: () => openUrl("https://hive.io") });
  return el(
    "div",
    { className: "help" },
    ...HELP.map(([q, a]) => el("details", {}, el("summary", { textContent: q }), el("p", { textContent: a }))),
    link,
  );
}

function settingsScreen(back: () => void) {
  const look = getLook();
  const font = el<HTMLSelectElement>(
    "select",
    {},
    ...Object.entries(FONTS).map(([k, f]) => el("option", { value: k, textContent: f.label, selected: k === look.font })),
  );
  const opacity = el<HTMLInputElement>("input", { type: "range", min: "30", max: "100", value: String(look.opacity) });
  const pct = el("span", { className: "muted", textContent: `${look.opacity}%` });
  const save = () => {
    setLook({ font: font.value as FontKey, opacity: Number(opacity.value) });
    pct.textContent = `${opacity.value}%`;
  };
  font.onchange = save;
  opacity.oninput = save;
  show(
    bar(button("←", "Back", back), button("–", "Hide to tray", () => win.close())),
    el(
      "div",
      { className: "panel" },
      el("label", {}, el("span", { textContent: "Note font" }), font),
      el("p", { className: "sample", textContent: "The quick brown fox jumps over the lazy dog." }),
      el("label", {}, el("span", { textContent: "Window opacity" }), el("div", { className: "row" }, opacity, pct)),
      el("button", { className: "primary", textContent: "Hive backup", onclick: () => hiveScreen(() => settingsScreen(back)) }),
    ),
  );
}

function hiveScreen(back: () => void) {
  const top = () => bar(button("←", "Back", back), button("–", "Hide to tray", () => win.close()));

  async function draw() {
    const cfg = await getConfig();
    if (!cfg.account) return connectView();
    connectedView(cfg);
  }

  function connectView() {
    show(
      top(),
      form(
        "Back up and sync notes through a Hive account. Use a dedicated account made just for notes, and its POSTING key. Notes are encrypted before they leave this device.",
        [{ placeholder: "Hive username" }, { placeholder: "Posting key (5…)" }],
        "Connect",
        async ([account, key]) => {
          const outcome = await connectAccount(account, key);
          if (outcome === "ready") return draw();
          joinView(outcome.join);
        },
      ),
      help(),
    );
  }

  function joinView(remote: RemoteVault) {
    show(
      top(),
      form(
        "This account already holds a Stickit vault. Enter that vault's passphrase to join it. Notes on this device are re-encrypted with its key and merged.",
        [{ placeholder: "Passphrase of the account's vault" }],
        "Join vault",
        async ([pass]) => {
          await joinRemoteVault(remote, pass);
          await draw();
        },
      ),
    );
  }

  async function connectedView(cfg: HiveConfig) {
    const status = el("p", { className: "muted" });
    const sync = el<HTMLButtonElement>("button", { className: "primary", textContent: "Sync now" });
    const auto = el<HTMLInputElement>("input", { type: "checkbox", checked: cfg.autosync });
    const rcSlot = el("div");
    const text = () => {
      status.textContent = cfg.last_error
        ? `Last attempt failed: ${cfg.last_error}`
        : cfg.last_sync
          ? `Last synced ${new Date(cfg.last_sync).toLocaleString()}`
          : "Not synced yet.";
      status.classList.toggle("err", !!cfg.last_error);
    };
    text();

    sync.onclick = async () => {
      sync.disabled = true;
      sync.textContent = "Syncing…";
      try {
        const r = await syncNow();
        const bits = [`${r.pushed} sent`, `${r.pulled} received`];
        if (r.deleted) bits.push(`${r.deleted} removed`);
        if (r.conflicts) bits.push(`${r.conflicts} conflict copies`);
        status.textContent = `Done: ${bits.join(", ")}.${r.warnings.length ? " " + r.warnings.join(" ") : ""}`;
        status.classList.remove("err");
      } catch (e) {
        status.textContent = `Failed: ${e instanceof Error ? e.message : e}`;
        status.classList.add("err");
      }
      sync.disabled = false;
      sync.textContent = "Sync now";
      fillFooter(rcSlot);
    };
    auto.onchange = () => invoke("hive_set", { key: "autosync", value: auto.checked ? "1" : "0" });

    show(
      top(),
      el(
        "div",
        { className: "panel" },
        el("p", { textContent: `Connected as @${cfg.account}` }),
        rcSlot,
        status,
        sync,
        el("label", { className: "row" }, auto, el("span", { textContent: `Auto-sync about 2 minutes after you stop editing` })),
        el("button", {
          className: "link",
          textContent: "Disconnect this account",
          onclick: async () => {
            await invoke("hive_disconnect");
            draw();
          },
        }),
      ),
      help(),
    );
    fillFooter(rcSlot);
  }

  draw();
}

function preview(n: Note) {
  return n.body.split("\n").find((l) => l.trim()) || "(empty note)";
}

// ---- note window ----

async function noteView(id: number) {
  const note = await invoke<Note | null>("get_note", { id });
  if (!note) return win.close();
  document.body.className = "note";
  const area = el<HTMLTextAreaElement>("textarea", { value: note.body, placeholder: "Write something…" });
  let timer: number;
  let pending = false;
  area.oninput = () => {
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(async () => {
      await invoke("update_note", { id, body: area.value });
      pending = false;
    }, 300);
  };
  // A sync from another device can change this note while it's open; show it unless mid-edit.
  listen("notes-changed", async () => {
    const fresh = await invoke<Note | null>("get_note", { id });
    if (!fresh) return win.close();
    if (!pending && fresh.body !== area.value) area.value = fresh.body;
  });
  const grip = el("div", { className: "grip" });
  grip.onmousedown = () => win.startResizeDragging("SouthEast");
  show(
    bar(
      button("+", "New note", () => invoke("create_note")),
      button("🗑", "Delete note", () => invoke("delete_note", { id })),
      button("✕", "Close", () => win.close()),
    ),
    area,
    grip,
  );
  area.focus();
}

noteId ? noteView(noteId) : listView();
