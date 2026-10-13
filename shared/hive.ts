// Hive backup/sync engine, shared by the desktop app and the PWA. It only ever handles *sealed*
// notes; each app supplies a SyncStore that owns the local data and the decrypting.
//
// Layout on Hive, under one account:
//   root post   stickit-vault-<vaultId>   title = vault id, body "Vault Container",
//                                         json_metadata carries the (public) wrapped vault keys
//   comments    n-<noteUid>               reply to the root post, body = sealed note
// Every post/comment is published with payout declined and votes disabled.

import { Client, PrivateKey, type Operation } from "@hiveio/dhive";

const NODES = ["https://api.hive.blog", "https://api.openhive.network", "https://techcoderx.com", "https://rpc.mahdiyari.info", "https://api.c0ff33a.uk"];
const client = new Client(NODES, { timeout: 20000, failoverThreshold: 2 });

const APP = "stickit/0.1";
const CONTAINER_BODY = "Vault Container";
const DELETED_BODY = '{"deleted":true}';
/** Hive allows a comment every 3s; stay a little above that. */
const SEND_GAP_MS = 4000;
const RATE_LIMIT_WAIT_MS = 21000;
/** Extra pause between creating the container post and the first note reply. */
const NEW_CONTAINER_SETTLE_MS = 10000;
/** Sealed notes are base64-wrapped; stay well under Hive's ~64 KB comment body limit. */
const MAX_SEALED_CHARS = 60000;
export const RC_PAUSE_PCT = 5;
export const RC_WARN_PCT = 20;

export interface HiveConfig {
  account: string | null;
  container: string | null;
  autosync: boolean;
  last_sync: string | null;
  last_error: string | null;
  wrap_published: string | null;
  vault_id: string | null;
}

export interface SyncNote { uid: string; sealed: string; dirty: boolean; remote_ts: string }
export interface Snapshot {
  notes: SyncNote[];
  tombstones: string[];
  vault_id: string;
  wrap_pass: unknown;
  wrap_rec: unknown;
}

export interface RemoteVault {
  permlink: string;
  vaultId: string;
  wrapPass: unknown;
  wrapRec: unknown;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: number;
  warnings: string[];
  /** Resource Credits left, or null when this run was pull-only and didn't check. */
  rc: number | null;
}

/** Where an app keeps its notes. The engine calls these; it never touches storage itself. */
export interface SyncStore {
  config(): Promise<HiveConfig>;
  set(key: "container" | "autosync" | "last_sync" | "last_error" | "wrap_published", value: string | null): Promise<void>;
  postingKey(): Promise<string>;
  snapshot(): Promise<Snapshot>;
  /** Must reject a note that doesn't decrypt with this vault. */
  applyRemote(uid: string, sealed: string, remoteTs: string): Promise<void>;
  conflictCopy(uid: string, sealed: string, remoteTs: string): Promise<void>;
  markPushed(uid: string, remoteTs: string): Promise<void>;
  deleteLocal(uid: string): Promise<void>;
  clearTombstone(uid: string): Promise<void>;
}

// ---- helpers ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Turns chain/network errors into something a person can act on. */
function explain(e: unknown): string {
  const m = errText(e);
  if (/Please wait to transact|Bandwidth limit|insufficient RC/i.test(m))
    return "Not enough Resource Credits. Wait for them to regenerate, or power up some HIVE (see Help).";
  if (/Missing Posting Authority|missing required posting/i.test(m)) return "The saved key isn't this account's posting key.";
  if (/You may only post once every 5 minutes/i.test(m)) return "Hive limits root posts to one per 5 minutes. Try again shortly.";
  if (/fetch|network|timeout|ECONN|Failed to fetch/i.test(m)) return "Couldn't reach a Hive node. Check your connection.";
  return m;
}

// ---- reading ----

export async function rcPercent(account: string): Promise<number> {
  const r = await client.call("rc_api", "find_rc_accounts", { accounts: [account] });
  const a = r.rc_accounts?.[0];
  if (!a) return 0;
  const max = Number(a.max_rc);
  if (!max) return 0;
  const elapsed = Date.now() / 1000 - Number(a.rc_manabar.last_update_time);
  const current = Number(a.rc_manabar.current_mana) + (max * Math.max(0, elapsed)) / (5 * 24 * 3600);
  return Math.max(0, Math.min(100, (current / max) * 100));
}

/** Accepts only a posting key that belongs to `account`. */
export async function verifyPostingKey(account: string, wif: string): Promise<void> {
  let pub: string;
  try {
    pub = PrivateKey.fromString(wif.trim()).createPublic().toString();
  } catch {
    throw new Error("That isn't a valid Hive private key.");
  }
  const [acc] = await client.database.getAccounts([account]);
  if (!acc) throw new Error("Hive account not found.");
  const holds = (auth: { key_auths: [unknown, number][] }) => auth.key_auths.some(([k]) => String(k) === pub);
  if (holds(acc.posting)) return;
  if (holds(acc.owner) || holds(acc.active) || String(acc.memo_key) === pub)
    throw new Error("That's your owner, active or memo key. Stickit only needs the posting key — paste that one instead.");
  throw new Error("That key doesn't match this account's posting key.");
}

interface BridgePost {
  author: string;
  permlink: string;
  parent_permlink: string;
  body: string;
  created: string;
  updated: string;
  json_metadata?: Record<string, unknown>;
}

const accountPosts = (sort: string, account: string, start?: BridgePost) =>
  client.call("bridge", "get_account_posts", {
    sort,
    account,
    limit: 20,
    ...(start ? { start_author: start.author, start_permlink: start.permlink } : {}),
  }) as Promise<BridgePost[] | null>;

/** The account's Stickit container post, if one exists (newest first). */
export async function findContainer(account: string): Promise<RemoteVault | null> {
  let start: BridgePost | undefined;
  for (let page = 0; page < 10; page++) {
    const posts = (await accountPosts("posts", account, start)) ?? [];
    for (const p of posts) {
      const m = p.json_metadata as { format?: string; vault?: { id: string; passphrase_wrap: unknown; recovery_wrap: unknown } } | undefined;
      if (p.author === account && m?.format === "stickit-vault" && m.vault) {
        return { permlink: p.permlink, vaultId: m.vault.id, wrapPass: m.vault.passphrase_wrap, wrapRec: m.vault.recovery_wrap };
      }
    }
    if (posts.length < 20) break;
    start = posts[posts.length - 1];
  }
  return null;
}

/** Account's notes under the container, keyed by note uid. */
async function fetchRemoteNotes(account: string, container: string) {
  const root = (await client
    .call("bridge", "get_post", { author: account, permlink: container })
    .catch(() => null)) as BridgePost | null;
  const out = new Map<string, { sealed: string; ts: string }>();
  let start: BridgePost | undefined;
  for (let page = 0; page < 200; page++) {
    const posts = (await accountPosts("comments", account, start)) ?? [];
    for (const p of posts) {
      if (p.author === account && p.parent_permlink === container && p.permlink.startsWith("n-")) {
        out.set(p.permlink.slice(2), { sealed: p.body, ts: p.updated });
      }
    }
    if (posts.length < 20) break;
    const last = posts[posts.length - 1];
    // Comments come newest first; nothing older than the container can belong to it.
    if (root && last.created < root.created) break;
    start = last;
  }
  return out;
}

// ---- writing ----

let lastSend = 0;

interface Chain {
  author: string;
  body: string;
  json_metadata: string;
  last_update: string;
}

/** dhive broadcasts asynchronously: the reply has no block number, only an id. So to know a post
 *  landed (and when), read it back until it shows our exact body and metadata. `last_update` is
 *  the block time, the same value Hive's bridge API reports as `updated`. */
async function confirmed(op: { author: string; permlink: string; body: string; json_metadata: string }): Promise<string> {
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const c = (await client.database.call("get_content", [op.author, op.permlink]).catch(() => null)) as Chain | null;
    if (c?.author && c.body === op.body && c.json_metadata === op.json_metadata) return c.last_update;
  }
  throw new Error("Posted, but Hive hasn't confirmed it yet. Sync again in a minute.");
}

/** Broadcasts and waits for inclusion. Returns the block time of the comment ("" for deletes). */
async function send(ops: Operation[], key: PrivateKey): Promise<string> {
  const wait = lastSend + SEND_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const attempt = () => client.broadcast.sendOperations(ops, key);
  try {
    await attempt();
  } catch (e) {
    // A rate-limited transaction is rejected outright, so retrying it once can't double-post.
    if (!/STEEMIT_MIN_REPLY_INTERVAL|HIVE_MIN_REPLY_INTERVAL|once every/i.test(errText(e))) throw e;
    await sleep(RATE_LIMIT_WAIT_MS);
    await attempt();
  }
  const comment = ops.find((o) => o[0] === "comment")?.[1] as Parameters<typeof confirmed>[0] | undefined;
  try {
    return comment ? await confirmed(comment) : "";
  } finally {
    // Hive's spam check counts from the block the post landed in, which is about now.
    lastSend = Date.now();
  }
}

const noDemands = (author: string, permlink: string): Operation => [
  "comment_options",
  {
    author,
    permlink,
    max_accepted_payout: "0.000 HBD",
    percent_hbd: 10000,
    allow_votes: false,
    allow_curation_rewards: false,
    extensions: [],
  },
];

function containerOps(account: string, permlink: string, snap: Snapshot, create: boolean): Operation[] {
  const meta = {
    app: APP,
    format: "stickit-vault",
    v: 1,
    tags: ["stickit"],
    vault: { id: snap.vault_id, passphrase_wrap: snap.wrap_pass, recovery_wrap: snap.wrap_rec },
  };
  const comment: Operation = [
    "comment",
    {
      parent_author: "",
      parent_permlink: "stickit",
      author: account,
      permlink,
      title: snap.vault_id,
      body: CONTAINER_BODY,
      json_metadata: JSON.stringify(meta),
    },
  ];
  return create ? [comment, noDemands(account, permlink)] : [comment];
}

function noteOps(account: string, container: string, uid: string, sealed: string, create: boolean): Operation[] {
  const permlink = `n-${uid}`;
  const comment: Operation = [
    "comment",
    {
      parent_author: account,
      parent_permlink: container,
      author: account,
      permlink,
      title: "",
      body: sealed,
      json_metadata: JSON.stringify({ app: APP, format: "stickit-note", v: 1 }),
    },
  ];
  // Payout options can only be set when the comment is first published.
  return create ? [comment, noDemands(account, permlink)] : [comment];
}

// ---- sync ----

let running = false;

/** One full pull → reconcile → push cycle. Throws a readable Error on failure. */
export async function syncNow(store: SyncStore, opts: { push?: boolean } = {}): Promise<SyncResult> {
  const push = opts.push ?? true;
  if (running) throw new Error("A sync is already running.");
  running = true;
  try {
    const result = await runSync(store, push);
    await store.set("last_sync", new Date().toISOString());
    await store.set("last_error", null);
    return result;
  } catch (e) {
    const message = explain(e);
    await store.set("last_error", message).catch(() => {});
    throw new Error(message);
  } finally {
    running = false;
  }
}

async function runSync(store: SyncStore, push: boolean): Promise<SyncResult> {
  const cfg = await store.config();
  if (!cfg.account) throw new Error("No Hive account connected.");
  const account = cfg.account;
  // A pull-only run needs no key and spends no RC, so it never checks them.
  if (!push && !cfg.container) return { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, warnings: [], rc: null };
  const key = push ? PrivateKey.fromString(await store.postingKey()) : null;

  const rc = push ? await rcPercent(account) : null;
  if (rc !== null && rc < RC_PAUSE_PCT) {
    throw new Error(`Resource Credits are at ${rc.toFixed(0)}%. Sync is paused until they recover (see Help).`);
  }

  const snap = await store.snapshot();
  const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, warnings: [], rc };
  const wrapNow = JSON.stringify(snap.wrap_pass);

  // 1. Container: find or create, and keep its public key wrappers current.
  let container = cfg.container;
  if (!container) {
    const found = await findContainer(account);
    if (found) {
      if (found.vaultId !== snap.vault_id) {
        throw new Error("This account already holds a different Stickit vault. Disconnect and reconnect to join it.");
      }
      container = found.permlink;
    } else {
      container = `stickit-vault-${snap.vault_id}`;
      await send(containerOps(account, container, snap, true), key!);
      await store.set("wrap_published", wrapNow);
      cfg.wrap_published = wrapNow;
      // Let the new root post settle before replying to it.
      lastSend = Date.now() + NEW_CONTAINER_SETTLE_MS - SEND_GAP_MS;
    }
    await store.set("container", container);
  }
  if (push && cfg.wrap_published !== wrapNow) {
    await send(containerOps(account, container, snap, false), key!);
    await store.set("wrap_published", wrapNow);
  }

  // 2. Pull and reconcile.
  const remote = await fetchRemoteNotes(account, container);
  const local = new Map(snap.notes.map((n) => [n.uid, n]));
  const tombstones = new Set(snap.tombstones);
  const dirtyAfter = new Set(snap.notes.filter((n) => n.dirty).map((n) => n.uid));

  for (const [uid, r] of remote) {
    if (tombstones.has(uid)) continue;
    const mine = local.get(uid);
    try {
      if (!mine) {
        await store.applyRemote(uid, r.sealed, r.ts);
        result.pulled++;
      } else if (r.ts > mine.remote_ts) {
        if (mine.dirty) {
          await store.conflictCopy(uid, r.sealed, r.ts);
          result.conflicts++;
        } else {
          await store.applyRemote(uid, r.sealed, r.ts);
          result.pulled++;
        }
      }
    } catch {
      // Not ours (wrong vault, tombstoned "deleted" marker, or corrupt): ignore it.
    }
  }

  // Synced here once, now gone from Hive: another device deleted it.
  for (const n of snap.notes) {
    if (!remote.has(n.uid) && n.remote_ts !== "" && !n.dirty) {
      await store.deleteLocal(n.uid);
      result.deleted++;
      dirtyAfter.delete(n.uid);
    }
  }

  if (!push) return result;
  // 3. Push local changes.
  for (const n of snap.notes) {
    if (!dirtyAfter.has(n.uid)) continue;
    if (n.sealed.length > MAX_SEALED_CHARS) {
      result.warnings.push("A note is too large to back up (limit is roughly 40 KB of text).");
      continue;
    }
    const ts = await send(noteOps(account, container, n.uid, n.sealed, !remote.has(n.uid)), key!);
    await store.markPushed(n.uid, ts);
    result.pushed++;
  }

  // 4. Push deletions. Hive refuses to delete a comment that has replies; blank it instead.
  for (const uid of snap.tombstones) {
    if (remote.has(uid)) {
      try {
        await send([["delete_comment", { author: account, permlink: `n-${uid}` }]], key!);
      } catch (e) {
        if (!/Cannot delete|replies|votes/i.test(errText(e))) throw e;
        await send(noteOps(account, container, uid, DELETED_BODY, false), key!);
      }
    }
    await store.clearTombstone(uid);
  }

  return result;
}
