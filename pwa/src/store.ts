// The PWA's local data: one JSON blob in localStorage holding sealed notes and the Hive account.
// The vault key lives only in memory, so a reload asks for the passphrase again.

import { newId, Vault, type Envelope } from "../../shared/crypto";
import { findContainer, verifyPostingKey, type HiveConfig, type Snapshot, type SyncStore } from "../../shared/hive";

const KEY = "stickit.pwa";
const HIVE_KEY = "hive-posting";

interface LocalNote { uid: string; sealed: string; dirty: boolean; remote_ts: string; updated: number }
interface State {
  account: string;
  container: string | null;
  vault_id: string;
  wrap_pass: Envelope;
  wrap_rec: unknown;
  sealed_key: string;
  last_sync: string | null;
  last_error: string | null;
  wrap_published: string | null;
  notes: LocalNote[];
  tombstones: string[];
}

export interface NoteView { uid: string; body: string; updated: number }

let state: State | null = load();
let vault: Vault | null = null;

function load(): State | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

const s = () => state!;
const v = () => vault ?? Promise.reject(new Error("vault is locked"));

export const account = () => state?.account ?? null;
export const isUnlocked = () => vault !== null;
export const hasDirty = () => !!state?.notes.some((n) => n.dirty && n.sealed) || !!state?.tombstones.length;

/** First run: check the key, find the account's vault on Hive, and open it with its passphrase. */
export async function connect(rawAccount: string, wif: string, passphrase: string) {
  const name = rawAccount.trim().replace(/^@/, "").toLowerCase();
  if (!name) throw new Error("Enter your Hive username.");
  await verifyPostingKey(name, wif);
  const remote = await findContainer(name);
  if (!remote) throw new Error("No Stickit vault on this account yet. Set up backup in the desktop app first.");
  const wrap = remote.wrapPass as Envelope;
  const opened = await Vault.unlock(wrap, passphrase);
  state = {
    account: name,
    container: remote.permlink,
    vault_id: remote.vaultId,
    wrap_pass: wrap,
    wrap_rec: remote.wrapRec,
    sealed_key: await opened.sealSecret(HIVE_KEY, wif.trim()),
    last_sync: null,
    last_error: null,
    wrap_published: JSON.stringify(wrap),
    notes: [],
    tombstones: [],
  };
  vault = opened;
  save();
}

export async function unlock(passphrase: string) {
  vault = await Vault.unlock(s().wrap_pass, passphrase);
}

export function lock() {
  vault = null;
}

export function disconnect() {
  vault = null;
  state = null;
  localStorage.removeItem(KEY);
}

// ---- notes ----

export async function list(query = ""): Promise<NoteView[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: NoteView[] = [];
  for (const n of s().notes) {
    const body = n.sealed ? await (await v()).openNote(n.uid, n.sealed).catch(() => "⚠ unreadable note") : "";
    if (words.every((w) => body.toLowerCase().includes(w))) out.push({ uid: n.uid, body, updated: n.updated });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export async function get(uid: string): Promise<string | null> {
  const n = s().notes.find((n) => n.uid === uid);
  if (!n) return null;
  return n.sealed ? (await v()).openNote(uid, n.sealed) : "";
}

export function create(): string {
  const uid = newId();
  s().notes.push({ uid, sealed: "", dirty: true, remote_ts: "", updated: Date.now() / 1000 });
  save();
  return uid;
}

export async function update(uid: string, body: string) {
  const n = s().notes.find((n) => n.uid === uid);
  if (!n) return;
  n.sealed = body ? await (await v()).sealNote(uid, body) : "";
  n.dirty = true;
  n.updated = Date.now() / 1000;
  save();
}

export function remove(uid: string) {
  const n = s().notes.find((n) => n.uid === uid);
  if (n && n.remote_ts !== "" && !s().tombstones.includes(uid)) s().tombstones.push(uid);
  s().notes = s().notes.filter((n) => n.uid !== uid);
  save();
}

// ---- sync ----

export const status = () => ({ lastSync: state?.last_sync ?? null, lastError: state?.last_error ?? null });

export const syncStore: SyncStore = {
  async config(): Promise<HiveConfig> {
    return {
      account: s().account,
      container: s().container,
      autosync: true,
      last_sync: s().last_sync,
      last_error: s().last_error,
      wrap_published: s().wrap_published,
      vault_id: s().vault_id,
    };
  },
  async set(key, value) {
    if (key !== "autosync") s()[key] = value;
    save();
  },
  async postingKey() {
    return (await v()).openSecret(HIVE_KEY, s().sealed_key);
  },
  async snapshot(): Promise<Snapshot> {
    return {
      notes: s().notes.filter((n) => n.sealed).map(({ uid, sealed, dirty, remote_ts }) => ({ uid, sealed, dirty, remote_ts })),
      tombstones: [...s().tombstones],
      vault_id: s().vault_id,
      wrap_pass: s().wrap_pass,
      wrap_rec: s().wrap_rec,
    };
  },
  async applyRemote(uid, sealed, remoteTs) {
    await (await v()).openNote(uid, sealed); // rejects anything that isn't ours
    const n = s().notes.find((n) => n.uid === uid);
    if (n) Object.assign(n, { sealed, remote_ts: remoteTs, dirty: false, updated: Date.now() / 1000 });
    else s().notes.push({ uid, sealed, dirty: false, remote_ts: remoteTs, updated: Date.now() / 1000 });
    save();
  },
  async conflictCopy(uid, sealed, remoteTs) {
    const vlt = await v();
    const plain = await vlt.openNote(uid, sealed);
    const copy = newId();
    s().notes.push({
      uid: copy,
      sealed: await vlt.sealNote(copy, `⚠ Conflict copy (edited elsewhere)\n${plain}`),
      dirty: true,
      remote_ts: "",
      updated: Date.now() / 1000,
    });
    const n = s().notes.find((n) => n.uid === uid);
    if (n) n.remote_ts = remoteTs;
    save();
  },
  async markPushed(uid, remoteTs) {
    const n = s().notes.find((n) => n.uid === uid);
    if (n) Object.assign(n, { dirty: false, remote_ts: remoteTs });
    save();
  },
  async deleteLocal(uid) {
    s().notes = s().notes.filter((n) => n.uid !== uid);
    save();
  },
  async clearTombstone(uid) {
    s().tombstones = s().tombstones.filter((t) => t !== uid);
    save();
  },
};
