import { syncNow } from "../../shared/hive";
import * as store from "./store";
import "./styles.css";

const app = document.getElementById("app")!;
const POLL_MS = 60_000;
/** Pushing costs Resource Credits, so wait until editing pauses (same as the desktop app). */
const PUSH_DELAY_MS = 120_000;

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> & Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props) as T;
  e.append(...kids);
  return e;
}

const show = (...kids: Node[]) => app.replaceChildren(...kids);
const btn = (label: string, title: string, onclick: () => void) => el("button", { textContent: label, title, onclick, type: "button" });

// ---- sync ----

let syncing = false;
let pushTimer: number | undefined;
let onSynced: (() => void) | null = null;
const statusLine = el("span", { className: "status" });

function paintStatus(extra = "") {
  const { lastSync, lastError } = store.status();
  statusLine.className = lastError ? "status err" : "status";
  statusLine.textContent = lastError
    ? `Sync failed: ${lastError}`
    : (lastSync ? `Synced ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not synced yet") + extra;
}

/** `push: false` only pulls: free, and what the one-minute poll uses. */
async function sync(push: boolean) {
  if (syncing || !store.isUnlocked() || !navigator.onLine) return;
  syncing = true;
  statusLine.textContent = "Syncing…";
  let extra = "";
  try {
    const r = await syncNow(store.syncStore, { push });
    if (r.rc !== null) extra = ` · RC ${r.rc.toFixed(0)}%`;
    if (r.warnings.length) extra += ` · ${r.warnings.join(" ")}`;
    onSynced?.();
  } catch {
    /* the message is stored and shown by paintStatus */
  }
  syncing = false;
  paintStatus(extra);
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => sync(true), PUSH_DELAY_MS);
}

setInterval(() => document.visibilityState === "visible" && sync(false), POLL_MS);
document.addEventListener("visibilitychange", () => {
  // Leaving the app is the last safe moment to push; coming back is when to catch up.
  if (document.visibilityState === "hidden") store.hasDirty() && sync(true);
  else sync(false);
});
addEventListener("online", () => sync(true));

// ---- screens ----

function field(placeholder: string, type = "password") {
  return el<HTMLInputElement>("input", { placeholder, type, autocomplete: "off", autocapitalize: "off", spellcheck: false });
}

function form(intro: string, inputs: HTMLInputElement[], submit: string, run: () => Promise<void>) {
  const err = el("p", { className: "err" });
  const go = el<HTMLButtonElement>("button", { type: "submit", textContent: submit, className: "primary" });
  const f = el<HTMLFormElement>("form", { className: "panel" }, el("p", { textContent: intro }), ...inputs, err, go);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    go.disabled = true;
    go.textContent = "Working…";
    try {
      await run();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      go.disabled = false;
      go.textContent = submit;
    }
  };
  return f;
}

function connectScreen() {
  const user = field("Hive username", "text");
  const key = field("Posting key (5…)");
  const pass = field("Vault passphrase");
  show(
    el("header", {}, el("h1", { textContent: "Stickit" })),
    form(
      "Sign in with the Hive account that holds your notes. Use its posting key and the vault passphrase from the desktop app. Your notes stay encrypted; the key is stored sealed in this browser.",
      [user, key, pass],
      "Connect",
      async () => {
        await store.connect(user.value, key.value, pass.value);
        await opened();
      },
    ),
  );
  user.focus();
}

function unlockScreen() {
  const pass = field("Vault passphrase");
  show(
    el("header", {}, el("h1", { textContent: "Stickit" })),
    form(`Notes for @${store.account()} are locked.`, [pass], "Unlock", async () => {
      await store.unlock(pass.value);
      await opened();
    }),
    el("button", {
      className: "link",
      textContent: "Use a different account",
      onclick: () => confirm("Remove this account and its notes from this browser? They stay on Hive.") && (store.disconnect(), connectScreen()),
    }),
  );
  pass.focus();
}

async function opened() {
  listScreen();
  await sync(true);
}

function listScreen() {
  onSynced = refresh;
  const search = el<HTMLInputElement>("input", { type: "search", placeholder: "Search notes…" });
  const ul = el("ul");

  async function refresh() {
    const notes = await store.list(search.value);
    ul.replaceChildren(
      ...(notes.length
        ? notes.map((n) => el("li", { textContent: n.body.split("\n").find((l) => l.trim()) || "(empty note)", onclick: () => editScreen(n.uid) }))
        : [el("li", { className: "empty", textContent: search.value ? "No matches" : "No notes yet" })]),
    );
  }
  search.oninput = refresh;

  show(
    el("header", {}, el("h1", { textContent: "Stickit" }), el("div", { className: "grow" }),
      btn("⟳", "Sync now", () => sync(true)),
      btn("🔒", "Lock", () => (store.lock(), onSynced = null, unlockScreen()))),
    search,
    ul,
    el("footer", {}, statusLine),
    el("button", { className: "fab", textContent: "+", title: "New note", onclick: () => editScreen(store.create()) }),
  );
  paintStatus();
  refresh();
}

async function editScreen(uid: string) {
  const body = await store.get(uid);
  if (body === null) return listScreen();
  const area = el<HTMLTextAreaElement>("textarea", { value: body, placeholder: "Write something…" });
  let timer: number | undefined;
  let pending = false;
  const save = async () => {
    clearTimeout(timer);
    if (!pending) return;
    pending = false;
    await store.update(uid, area.value);
    schedulePush();
  };
  area.oninput = () => {
    pending = true;
    clearTimeout(timer);
    timer = window.setTimeout(save, 300);
  };
  // A pull from another device can change this note while it's open; show it unless mid-edit.
  onSynced = async () => {
    if (pending) return;
    const fresh = await store.get(uid);
    if (fresh === null) return listScreen();
    if (fresh !== area.value) area.value = fresh;
  };
  show(
    el("header", {}, btn("←", "Back", async () => (await save(), listScreen())), el("div", { className: "grow" }),
      btn("🗑", "Delete note", () => {
        if (!confirm("Delete this note?")) return;
        clearTimeout(timer);
        pending = false;
        store.remove(uid);
        schedulePush();
        listScreen();
      })),
    area,
  );
  area.focus();
}

// ---- boot ----

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("sw.js");
store.account() ? unlockScreen() : connectScreen();
