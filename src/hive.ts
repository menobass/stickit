// Desktop side of the Hive backup: binds the shared sync engine to the Rust-owned database.
// Connect/join stay here because they go through the Rust vault.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  findContainer, syncNow as runSync, verifyPostingKey,
  type HiveConfig, type RemoteVault, type Snapshot, type SyncResult, type SyncStore,
} from "../shared/hive";

export { rcPercent, RC_PAUSE_PCT, RC_WARN_PCT } from "../shared/hive";
export type { HiveConfig, RemoteVault, SyncResult };

const store: SyncStore = {
  config: () => invoke<HiveConfig>("hive_config"),
  set: (key, value) => invoke("hive_set", { key, value }),
  postingKey: () => invoke<string>("hive_posting_key"),
  snapshot: () => invoke<Snapshot>("sync_snapshot"),
  applyRemote: (uid, sealed, remoteTs) => invoke("sync_apply_remote", { uid, sealed, remoteTs }),
  conflictCopy: (uid, sealed, remoteTs) => invoke("sync_conflict_copy", { uid, sealed, remoteTs }),
  markPushed: (uid, remoteTs) => invoke("sync_mark_pushed", { uid, remoteTs }),
  deleteLocal: (uid) => invoke("sync_delete_local", { uid }),
  clearTombstone: (uid) => invoke("sync_clear_tombstone", { uid }),
};

export const getConfig = store.config;
export const syncNow = (opts?: { push?: boolean }) => runSync(store, opts);

export async function notify(title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}

export type ConnectOutcome = "ready" | { join: RemoteVault };

/** Checks the key, saves it (sealed under the vault), and looks for an existing vault. */
export async function connectAccount(rawAccount: string, wif: string): Promise<ConnectOutcome> {
  const account = rawAccount.trim().replace(/^@/, "").toLowerCase();
  if (!account) throw new Error("Enter your Hive username.");
  await verifyPostingKey(account, wif);
  await invoke("hive_connect", { account, postingKey: wif.trim() });
  const [remote, cfg] = await Promise.all([findContainer(account), store.config()]);
  if (!remote) return "ready";
  if (remote.vaultId === cfg.vault_id) {
    await store.set("container", remote.permlink);
    return "ready";
  }
  return { join: remote };
}

/** Adopt the vault already on Hive: local notes are re-encrypted under its key. */
export async function joinRemoteVault(remote: RemoteVault, passphrase: string) {
  await invoke("vault_join_remote", {
    vaultId: remote.vaultId,
    wrapPass: remote.wrapPass,
    wrapRec: remote.wrapRec,
    passphrase,
  });
  await store.set("container", remote.permlink);
}
