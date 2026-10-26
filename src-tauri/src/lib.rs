// Not every crypto helper is used yet.
#[allow(dead_code)]
mod crypto;
mod db;

use crypto::{Envelope, Vault, KDF_DEFAULT};
use db::Note;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Auto-sync waits this long after the last edit, so a burst of typing is one sync.
const AUTOSYNC_DELAY: Duration = Duration::from_secs(120);
/// Secret name the Hive posting key is sealed under.
const HIVE_KEY: &str = "hive-posting";

struct Db(Mutex<Connection>);

/// Unlocked state. Lives only in memory: dropping it is what "lock" means.
#[derive(Default)]
struct Session {
    vault: Option<Vault>,
}
struct Sess(Mutex<Session>);

/// When the next auto-sync is due (None = nothing pending).
struct SyncTimer(Mutex<Option<Instant>>);

type Res<T> = Result<T, String>;

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn note_id(label: &str) -> Option<i64> {
    label.strip_prefix("note-")?.parse().ok()
}

fn db<'a>(d: &State<'a, Db>) -> MutexGuard<'a, Connection> {
    d.inner().0.lock().unwrap()
}

fn vault_of(s: &Session) -> Res<&Vault> {
    s.vault.as_ref().ok_or_else(|| "vault is locked".to_string())
}

fn uid_of(n: &Note) -> Res<&str> {
    n.uid.as_deref().ok_or_else(|| "note has no id yet".to_string())
}

/// A note as the UI sees it: decrypted text.
#[derive(Serialize)]
struct NoteView {
    id: i64,
    body: String,
    updated: i64,
}

fn view(n: &Note, s: &Session) -> Res<NoteView> {
    let v = vault_of(s)?;
    let body = if n.body.is_empty() { String::new() } else { v.open_note(uid_of(n)?, &n.body)? };
    Ok(NoteView { id: n.id, body, updated: n.updated })
}

fn changed(app: &AppHandle) {
    let _ = app.emit("notes-changed", ());
}

/// Note changes (not sync pulls) start the auto-sync countdown when auto-sync is on.
fn schedule_sync(app: &AppHandle) {
    let d = app.state::<Db>();
    let conn = db(&d);
    let on = db::meta_get(&conn, "hive_autosync").ok().flatten().as_deref() == Some("1")
        && db::meta_get(&conn, "hive_account").ok().flatten().is_some();
    if on {
        *app.state::<SyncTimer>().0.lock().unwrap() = Some(Instant::now() + AUTOSYNC_DELAY);
    }
}

/// Gives pre-uid notes an identity (and re-seals them to it) and makes sure a vault id exists.
fn migrate(conn: &Connection, v: &Vault) -> Res<()> {
    for n in db::list(conn).map_err(err)? {
        if n.uid.is_some() {
            continue;
        }
        let uid = crypto::new_id();
        let body = if n.body.is_empty() {
            String::new()
        } else {
            // Older notes were sealed against their numeric row id.
            v.seal_note(&uid, &v.open_note(&n.id.to_string(), &n.body)?)?
        };
        db::replace(conn, n.id, &uid, &body).map_err(err)?;
    }
    if db::meta_get(conn, "vault_id").map_err(err)?.is_none() {
        db::meta_set(conn, "vault_id", &crypto::new_id()).map_err(err)?;
    }
    Ok(())
}

// ---- vault ----

#[tauri::command]
fn vault_status(db_: State<Db>, sess: State<Sess>) -> Res<&'static str> {
    if sess.0.lock().unwrap().vault.is_some() {
        return Ok("unlocked");
    }
    let has = db::meta_get(&db(&db_), "passphrase_wrap").map_err(err)?.is_some();
    Ok(if has { "locked" } else { "none" })
}

/// Creates the vault, encrypts any notes written before it existed, and returns the recovery
/// phrase (shown once).
#[tauri::command]
async fn create_vault(app: AppHandle, db_: State<'_, Db>, sess: State<'_, Sess>, passphrase: String) -> Res<String> {
    let conn = db(&db_);
    if db::meta_get(&conn, "passphrase_wrap").map_err(err)?.is_some() {
        return Err("a vault already exists".into());
    }
    let nv = Vault::create(&passphrase, KDF_DEFAULT)?;

    let migrate_all = || -> Res<()> {
        conn.execute_batch("BEGIN").map_err(err)?;
        for n in db::list(&conn).map_err(err)? {
            let uid = n.uid.clone().unwrap_or_else(crypto::new_id);
            db::replace(&conn, n.id, &uid, &nv.vault.seal_note(&uid, &n.body)?).map_err(err)?;
        }
        db::meta_set(&conn, "vault_id", &crypto::new_id()).map_err(err)?;
        db::meta_set(&conn, "passphrase_wrap", &serde_json::to_string(&nv.passphrase_wrap).map_err(err)?).map_err(err)?;
        db::meta_set(&conn, "recovery_wrap", &serde_json::to_string(&nv.recovery_wrap).map_err(err)?).map_err(err)?;
        conn.execute_batch("COMMIT").map_err(err)
    };
    if let Err(e) = migrate_all() {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    // Rewrite the file so old plaintext pages don't linger.
    let _ = conn.execute_batch("VACUUM");
    drop(conn);

    sess.0.lock().unwrap().vault = Some(nv.vault);
    let _ = app.emit("vault-changed", ());
    Ok(nv.recovery_phrase)
}

fn header(conn: &Connection, key: &str) -> Res<Envelope> {
    let json = db::meta_get(conn, key).map_err(err)?.ok_or("no vault yet")?;
    serde_json::from_str(&json).map_err(err)
}

#[tauri::command]
async fn unlock_vault(app: AppHandle, db_: State<'_, Db>, sess: State<'_, Sess>, passphrase: String) -> Res<()> {
    let wrap = header(&db(&db_), "passphrase_wrap")?;
    let vault = Vault::unlock(&wrap, &passphrase)?;
    migrate(&db(&db_), &vault)?;
    sess.0.lock().unwrap().vault = Some(vault);
    let _ = app.emit("vault-changed", ());
    Ok(())
}

/// Forgot the passphrase: the recovery phrase unlocks the vault and a new passphrase replaces it.
#[tauri::command]
async fn recover_vault(app: AppHandle, db_: State<'_, Db>, sess: State<'_, Sess>, phrase: String, new_passphrase: String) -> Res<()> {
    let wrap = header(&db(&db_), "recovery_wrap")?;
    let vault = Vault::unlock_with_recovery(&wrap, &phrase)?;
    let rewrapped = vault.rewrap(&new_passphrase, KDF_DEFAULT)?;
    let conn = db(&db_);
    db::meta_set(&conn, "passphrase_wrap", &serde_json::to_string(&rewrapped).map_err(err)?).map_err(err)?;
    migrate(&conn, &vault)?;
    drop(conn);
    sess.0.lock().unwrap().vault = Some(vault);
    let _ = app.emit("vault-changed", ());
    Ok(())
}

#[tauri::command]
fn lock_vault(app: AppHandle, sess: State<Sess>) {
    *sess.0.lock().unwrap() = Session::default();
    for (label, w) in app.webview_windows() {
        if note_id(&label).is_some() {
            let _ = w.destroy();
        }
    }
    let _ = app.emit("vault-changed", ());
}

// ---- notes ----

#[tauri::command]
fn list_notes(db_: State<Db>, sess: State<Sess>, query: String) -> Res<Vec<NoteView>> {
    let s = sess.0.lock().unwrap();
    vault_of(&s)?;
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut out = Vec::new();
    for n in db::list(&db(&db_)).map_err(err)? {
        let v = view(&n, &s).unwrap_or(NoteView { id: n.id, body: "⚠ unreadable note".into(), updated: n.updated });
        let hay = v.body.to_lowercase();
        if words.iter().all(|w| hay.contains(w)) {
            out.push(v);
        }
    }
    Ok(out)
}

#[tauri::command]
fn get_note(db_: State<Db>, sess: State<Sess>, id: i64) -> Res<Option<NoteView>> {
    let s = sess.0.lock().unwrap();
    let Some(n) = db::get(&db(&db_), id).map_err(err)? else { return Ok(None) };
    view(&n, &s).map(Some)
}

// The commands that build windows are async so they run off the main thread: on Windows,
// building a webview window from a sync command or event handler deadlocks (see Tauri's
// WebviewWindowBuilder docs).
#[tauri::command]
async fn create_note(app: AppHandle) -> Res<i64> {
    new_note(&app)
}

fn new_note(app: &AppHandle) -> Res<i64> {
    vault_of(&app.state::<Sess>().0.lock().unwrap())?;
    let id = db::create(&db(&app.state()), &crypto::new_id()).map_err(err)?;
    open_note(app, id)?;
    changed(app);
    Ok(id)
}

#[tauri::command]
fn update_note(app: AppHandle, db_: State<Db>, sess: State<Sess>, id: i64, body: String) -> Res<()> {
    let s = sess.0.lock().unwrap();
    let conn = db(&db_);
    let n = db::get(&conn, id).map_err(err)?.ok_or("note not found")?;
    db::set_body(&conn, id, &vault_of(&s)?.seal_note(uid_of(&n)?, &body)?).map_err(err)?;
    drop(conn);
    drop(s);
    changed(&app);
    schedule_sync(&app);
    Ok(())
}

#[tauri::command]
fn delete_note(app: AppHandle, db_: State<Db>, sess: State<Sess>, id: i64) -> Res<()> {
    vault_of(&sess.0.lock().unwrap())?;
    db::delete(&db(&db_), id).map_err(err)?;
    if let Some(w) = app.get_webview_window(&format!("note-{id}")) {
        let _ = w.destroy();
    }
    changed(&app);
    schedule_sync(&app);
    Ok(())
}

#[tauri::command]
async fn open_note_window(app: AppHandle, id: i64) -> Res<()> {
    open_note(&app, id)
}

fn open_note(app: &AppHandle, id: i64) -> Res<()> {
    vault_of(&app.state::<Sess>().0.lock().unwrap())?;
    let label = format!("note-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(err);
    }
    let note = db::get(&db(&app.state()), id).map_err(err)?.ok_or("note not found")?;
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html?note={id}").into()))
        .title("Stickit note")
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(err)?;
    // Sizes are logical pixels (same unit we save in on_window_event), so a note is the same
    // physical size on every display regardless of its scale factor (e.g. Retina on macOS).
    let _ = win.set_size(LogicalSize::new(note.w as f64, note.h as f64));
    // Wayland ignores client-side positioning; this only takes effect on X11.
    if let (Some(x), Some(y)) = (note.x, note.y) {
        let _ = win.set_position(LogicalPosition::new(x as f64, y as f64));
    }
    Ok(())
}

// ---- hive account + sync ----
//
// The sync engine itself lives in the frontend (src/hive.ts, shared with the PWA later). It only
// ever sees sealed notes; decryption stays here, and the posting key is handed over per sync.

#[derive(Serialize)]
struct HiveConfig {
    account: Option<String>,
    container: Option<String>,
    autosync: bool,
    last_sync: Option<String>,
    last_error: Option<String>,
    wrap_published: Option<String>,
    vault_id: Option<String>,
}

#[tauri::command]
fn hive_config(db_: State<Db>) -> Res<HiveConfig> {
    let conn = db(&db_);
    let get = |k: &str| db::meta_get(&conn, k).ok().flatten();
    Ok(HiveConfig {
        account: get("hive_account"),
        container: get("hive_container"),
        autosync: get("hive_autosync").as_deref() == Some("1"),
        last_sync: get("hive_last_sync"),
        last_error: get("hive_last_error"),
        wrap_published: get("hive_wrap_published"),
        vault_id: get("vault_id"),
    })
}

/// Stores the account and its posting key (sealed under the vault). The frontend has already
/// checked the key against the account's posting authority.
#[tauri::command]
fn hive_connect(db_: State<Db>, sess: State<Sess>, account: String, posting_key: String) -> Res<()> {
    let s = sess.0.lock().unwrap();
    let sealed = vault_of(&s)?.seal_secret(HIVE_KEY, &posting_key)?;
    let conn = db(&db_);
    db::meta_set(&conn, "hive_account", &account).map_err(err)?;
    db::meta_set(&conn, "hive_key", &sealed).map_err(err)
}

#[tauri::command]
fn hive_disconnect(app: AppHandle, db_: State<Db>) -> Res<()> {
    let conn = db(&db_);
    for k in ["hive_account", "hive_key", "hive_container", "hive_autosync", "hive_last_sync", "hive_last_error", "hive_wrap_published"] {
        db::meta_delete(&conn, k).map_err(err)?;
    }
    db::reset_sync(&conn).map_err(err)?;
    drop(conn);
    *app.state::<SyncTimer>().0.lock().unwrap() = None;
    Ok(())
}

/// Frontend-writable settings (the account and key go through `hive_connect`).
#[tauri::command]
fn hive_set(app: AppHandle, db_: State<Db>, key: String, value: Option<String>) -> Res<()> {
    if !["container", "autosync", "last_sync", "last_error", "wrap_published"].contains(&key.as_str()) {
        return Err("unknown setting".into());
    }
    let conn = db(&db_);
    let k = format!("hive_{key}");
    match value {
        Some(v) => db::meta_set(&conn, &k, &v).map_err(err)?,
        None => db::meta_delete(&conn, &k).map_err(err)?,
    }
    drop(conn);
    if key == "autosync" {
        *app.state::<SyncTimer>().0.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
fn hive_posting_key(db_: State<Db>, sess: State<Sess>) -> Res<String> {
    let s = sess.0.lock().unwrap();
    let sealed = db::meta_get(&db(&db_), "hive_key").map_err(err)?.ok_or("no Hive account connected")?;
    vault_of(&s)?.open_secret(HIVE_KEY, &sealed)
}

#[derive(Serialize)]
struct SyncNote {
    uid: String,
    sealed: String,
    dirty: bool,
    remote_ts: String,
}

#[derive(Serialize)]
struct Snapshot {
    notes: Vec<SyncNote>,
    tombstones: Vec<String>,
    vault_id: String,
    wrap_pass: serde_json::Value,
    wrap_rec: serde_json::Value,
}

#[tauri::command]
fn sync_snapshot(db_: State<Db>, sess: State<Sess>) -> Res<Snapshot> {
    vault_of(&sess.0.lock().unwrap())?;
    let conn = db(&db_);
    let json = |k: &str| -> Res<serde_json::Value> {
        let raw = db::meta_get(&conn, k).map_err(err)?.ok_or("no vault yet")?;
        serde_json::from_str(&raw).map_err(err)
    };
    let notes = db::list(&conn)
        .map_err(err)?
        .into_iter()
        // Notes that were never typed in have no ciphertext and aren't worth RC.
        .filter(|n| n.uid.is_some() && !n.body.is_empty())
        .map(|n| SyncNote { uid: n.uid.unwrap(), sealed: n.body, dirty: n.dirty, remote_ts: n.remote_ts })
        .collect();
    Ok(Snapshot {
        notes,
        tombstones: db::tombstones(&conn).map_err(err)?,
        vault_id: db::meta_get(&conn, "vault_id").map_err(err)?.unwrap_or_default(),
        wrap_pass: json("passphrase_wrap")?,
        wrap_rec: json("recovery_wrap")?,
    })
}

/// Accepts a note from Hive only if it decrypts with our vault under that uid, so stray or
/// hostile comments can't inject anything.
#[tauri::command]
fn sync_apply_remote(app: AppHandle, db_: State<Db>, sess: State<Sess>, uid: String, sealed: String, remote_ts: String) -> Res<()> {
    vault_of(&sess.0.lock().unwrap())?.open_note(&uid, &sealed)?;
    db::apply_remote(&db(&db_), &uid, &sealed, &remote_ts).map_err(err)?;
    changed(&app);
    Ok(())
}

/// Both sides changed: keep the local note, and save the remote text as a new note.
#[tauri::command]
fn sync_conflict_copy(app: AppHandle, db_: State<Db>, sess: State<Sess>, uid: String, sealed: String, remote_ts: String) -> Res<()> {
    let s = sess.0.lock().unwrap();
    let v = vault_of(&s)?;
    let plain = v.open_note(&uid, &sealed)?;
    let new_uid = crypto::new_id();
    let conn = db(&db_);
    let id = db::create(&conn, &new_uid).map_err(err)?;
    let body = v.seal_note(&new_uid, &format!("⚠ Conflict copy (edited elsewhere)\n{plain}"))?;
    db::set_body(&conn, id, &body).map_err(err)?;
    db::set_remote_ts(&conn, &uid, &remote_ts).map_err(err)?;
    drop(conn);
    drop(s);
    changed(&app);
    Ok(())
}

#[tauri::command]
fn sync_mark_pushed(db_: State<Db>, uid: String, remote_ts: String) -> Res<()> {
    db::mark_pushed(&db(&db_), &uid, &remote_ts).map_err(err)
}

/// The note was deleted from Hive by another device.
#[tauri::command]
fn sync_delete_local(app: AppHandle, db_: State<Db>, uid: String) -> Res<()> {
    let conn = db(&db_);
    if let Some(n) = db::get_by_uid(&conn, &uid).map_err(err)? {
        if let Some(w) = app.get_webview_window(&format!("note-{}", n.id)) {
            let _ = w.destroy();
        }
    }
    db::delete_by_uid(&conn, &uid).map_err(err)?;
    drop(conn);
    changed(&app);
    Ok(())
}

#[tauri::command]
fn sync_clear_tombstone(db_: State<Db>, uid: String) -> Res<()> {
    db::clear_tombstone(&db(&db_), &uid).map_err(err)
}

/// The Hive account already holds a vault made on another device. Re-encrypt local notes under
/// that vault's key (unlocked with its passphrase) and adopt its identity.
#[tauri::command]
async fn vault_join_remote(
    app: AppHandle,
    db_: State<'_, Db>,
    sess: State<'_, Sess>,
    vault_id: String,
    wrap_pass: serde_json::Value,
    wrap_rec: serde_json::Value,
    passphrase: String,
) -> Res<()> {
    let remote_wrap: Envelope = serde_json::from_value(wrap_pass.clone()).map_err(|_| "bad vault data on Hive")?;
    let remote = Vault::unlock(&remote_wrap, &passphrase)?;
    let mut s = sess.0.lock().unwrap();
    let conn = db(&db_);

    let rekey = || -> Res<()> {
        let local = vault_of(&s)?;
        conn.execute_batch("BEGIN").map_err(err)?;
        for n in db::list(&conn).map_err(err)? {
            let uid = uid_of(&n)?;
            if n.body.is_empty() {
                continue;
            }
            let sealed = remote.seal_note(uid, &local.open_note(uid, &n.body)?)?;
            db::replace(&conn, n.id, uid, &sealed).map_err(err)?;
        }
        if let Some(sealed) = db::meta_get(&conn, "hive_key").map_err(err)? {
            let key = local.open_secret(HIVE_KEY, &sealed)?;
            db::meta_set(&conn, "hive_key", &remote.seal_secret(HIVE_KEY, &key)?).map_err(err)?;
        }
        db::meta_set(&conn, "vault_id", &vault_id).map_err(err)?;
        db::meta_set(&conn, "passphrase_wrap", &wrap_pass.to_string()).map_err(err)?;
        db::meta_set(&conn, "recovery_wrap", &wrap_rec.to_string()).map_err(err)?;
        db::meta_set(&conn, "hive_wrap_published", &wrap_pass.to_string()).map_err(err)?;
        conn.execute_batch("COMMIT").map_err(err)
    };
    if let Err(e) = rekey() {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    s.vault = Some(remote);
    drop(conn);
    drop(s);
    changed(&app);
    Ok(())
}

fn toggle_list(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_list(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// New note, or the list when there's no unlocked vault to make one in. Called from the tray menu
/// and single-instance handlers, which run on the main thread, so the window is built elsewhere.
fn new_note_or_list(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if new_note(&app).is_err() {
            show_list(&app);
        }
    });
}

/// What a launch argument asks of the running app: `--new` for a note, `--toggle` for the list.
/// The Omarchy bar widget uses these; a plain second launch just toggles the list.
fn handle_args(app: &AppHandle, args: &[String]) {
    if args.iter().any(|a| a == "--new") {
        new_note_or_list(app);
    } else {
        toggle_list(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch forwards its arguments here and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| handle_args(app, &args)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db(Mutex::new(db::open(&dir.join("stickit.db"))?)));
            app.manage(Sess(Mutex::new(Session::default())));
            app.manage(SyncTimer(Mutex::new(None)));

            // Fires "sync-due" once the debounce deadline passes; the frontend does the sync.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let timer = handle.state::<SyncTimer>();
                let fire = {
                    let mut due = timer.0.lock().unwrap();
                    let fire = due.is_some_and(|d| Instant::now() >= d);
                    if fire {
                        *due = None;
                    }
                    fire
                };
                if fire {
                    let _ = handle.emit("sync-due", ());
                }
            });

            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "toggle", "Show / hide notes", true, None::<&str>)?,
                    &MenuItem::with_id(app, "new", "New note", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Stickit")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_list(app),
                    "new" => new_note_or_list(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_list(tray.app_handle());
                    }
                })
                .build(app)?;

            // Started by the bar widget (or `stickit --toggle`): come up visible, not just in the tray.
            let args: Vec<String> = std::env::args().skip(1).collect();
            if args.iter().any(|a| a == "--toggle" || a == "--new") {
                show_list(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                // Closing the list just hides it; the app lives in the tray.
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            let Some(id) = note_id(window.label()) else { return };
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                if let (Ok(scale), Ok(p), Ok(s)) = (window.scale_factor(), window.outer_position(), window.inner_size()) {
                    let p = p.to_logical::<i32>(scale);
                    let s = s.to_logical::<u32>(scale);
                    let db_ = window.state::<Db>();
                    let _ = db::set_geometry(&db(&db_), id, p.x, p.y, s.width, s.height);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            vault_status, create_vault, unlock_vault, recover_vault, lock_vault,
            list_notes, get_note, create_note, update_note, delete_note, open_note_window,
            hive_config, hive_connect, hive_disconnect, hive_set, hive_posting_key,
            sync_snapshot, sync_apply_remote, sync_conflict_copy, sync_mark_pushed,
            sync_delete_local, sync_clear_tombstone, vault_join_remote
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Keep running in the tray when the last window closes; only app.exit() quits.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_moves_legacy_notes_onto_uids() {
        let dir = std::env::temp_dir().join(format!("stickit-test-{}", crypto::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = db::open(&dir.join("t.db")).unwrap();
        let nv = Vault::create("correct horse battery", crypto::KdfParams { m_kib: 64, t: 1, p: 1 }).unwrap();

        // A note from before uids existed: row id 1, sealed against "1", no uid.
        conn.execute("INSERT INTO notes (id, body) VALUES (1, ?1)", [nv.vault.seal_note("1", "old note").unwrap()]).unwrap();
        migrate(&conn, &nv.vault).unwrap();

        let n = db::get(&conn, 1).unwrap().unwrap();
        let uid = n.uid.clone().expect("uid assigned");
        assert_eq!(nv.vault.open_note(&uid, &n.body).unwrap(), "old note");
        assert!(n.dirty);
        // Idempotent: a second run changes nothing.
        migrate(&conn, &nv.vault).unwrap();
        assert_eq!(db::get(&conn, 1).unwrap().unwrap().body, n.body);
        assert!(db::meta_get(&conn, "vault_id").unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }
}
