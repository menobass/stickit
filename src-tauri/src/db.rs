use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

/// A note row as stored: `body` is vault ciphertext (or empty), never plaintext.
#[derive(Serialize)]
pub struct Note {
    pub id: i64,
    /// Stable id shared across devices (also the Hive permlink suffix). NULL only before migration.
    pub uid: Option<String>,
    pub body: String,
    pub updated: i64,
    /// Changed locally since the last successful sync.
    pub dirty: bool,
    /// Hive's `updated` stamp the last time this note was in sync ("" = never synced).
    pub remote_ts: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub w: u32,
    pub h: u32,
}

const COLS: &str = "id, uid, body, updated, dirty, remote_ts, x, y, w, h";

fn from_row(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        uid: r.get(1)?,
        body: r.get(2)?,
        updated: r.get(3)?,
        dirty: r.get::<_, i64>(4)? != 0,
        remote_ts: r.get(5)?,
        x: r.get(6)?,
        y: r.get(7)?,
        w: r.get(8)?,
        h: r.get(9)?,
    })
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY,
            body TEXT NOT NULL DEFAULT '',
            updated INTEGER NOT NULL DEFAULT (unixepoch()),
            x INTEGER, y INTEGER,
            w INTEGER NOT NULL DEFAULT 280,
            h INTEGER NOT NULL DEFAULT 260
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tombstones (uid TEXT PRIMARY KEY);
        -- Earlier versions kept a plaintext search index; search now runs in memory.
        DROP TRIGGER IF EXISTS notes_ai;
        DROP TRIGGER IF EXISTS notes_ad;
        DROP TRIGGER IF EXISTS notes_au;
        DROP TABLE IF EXISTS notes_fts;",
    )?;
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(notes)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    for (name, ddl) in [
        ("uid", "ALTER TABLE notes ADD COLUMN uid TEXT"),
        ("dirty", "ALTER TABLE notes ADD COLUMN dirty INTEGER NOT NULL DEFAULT 1"),
        ("remote_ts", "ALTER TABLE notes ADD COLUMN remote_ts TEXT NOT NULL DEFAULT ''"),
    ] {
        if !cols.iter().any(|c| c == name) {
            conn.execute(ddl, [])?;
        }
    }
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS notes_uid ON notes(uid)", [])?;
    Ok(conn)
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Note>> {
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM notes ORDER BY updated DESC, id DESC"))?;
    let rows = st.query_map([], from_row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Note>> {
    conn.query_row(&format!("SELECT {COLS} FROM notes WHERE id = ?1"), [id], from_row).optional()
}

pub fn get_by_uid(conn: &Connection, uid: &str) -> rusqlite::Result<Option<Note>> {
    conn.query_row(&format!("SELECT {COLS} FROM notes WHERE uid = ?1"), [uid], from_row).optional()
}

pub fn create(conn: &Connection, uid: &str) -> rusqlite::Result<i64> {
    conn.execute("INSERT INTO notes (uid) VALUES (?1)", [uid])?;
    Ok(conn.last_insert_rowid())
}

pub fn set_body(conn: &Connection, id: i64, body: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET body = ?2, updated = unixepoch(), dirty = 1 WHERE id = ?1", params![id, body])?;
    Ok(())
}

/// Re-encrypts or assigns identity without touching the modified time (migrations).
pub fn replace(conn: &Connection, id: i64, uid: &str, body: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET uid = ?2, body = ?3, dirty = 1 WHERE id = ?1", params![id, uid, body])?;
    Ok(())
}

pub fn set_geometry(conn: &Connection, id: i64, x: i32, y: i32, w: u32, h: u32) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET x = ?2, y = ?3, w = ?4, h = ?5 WHERE id = ?1", params![id, x, y, w, h])?;
    Ok(())
}

/// Deletes locally; a note that was ever synced leaves a tombstone so the deletion reaches Hive.
pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO tombstones (uid) SELECT uid FROM notes WHERE id = ?1 AND uid IS NOT NULL AND remote_ts != ''",
        [id],
    )?;
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete_by_uid(conn: &Connection, uid: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notes WHERE uid = ?1", [uid])?;
    Ok(())
}

pub fn mark_pushed(conn: &Connection, uid: &str, remote_ts: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET dirty = 0, remote_ts = ?2 WHERE uid = ?1", params![uid, remote_ts])?;
    Ok(())
}

/// Stores a note received from Hive (insert or overwrite), already verified by the caller.
pub fn apply_remote(conn: &Connection, uid: &str, body: &str, remote_ts: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO notes (uid, body, remote_ts, dirty) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(uid) DO UPDATE SET body = excluded.body, remote_ts = excluded.remote_ts,
             dirty = 0, updated = unixepoch()",
        params![uid, body, remote_ts],
    )?;
    Ok(())
}

/// Records that the note's remote copy was seen at `remote_ts`, without marking it pushed.
pub fn set_remote_ts(conn: &Connection, uid: &str, remote_ts: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET remote_ts = ?2 WHERE uid = ?1", params![uid, remote_ts])?;
    Ok(())
}

pub fn tombstones(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare("SELECT uid FROM tombstones")?;
    let rows = st.query_map([], |r| r.get(0))?;
    rows.collect()
}

pub fn clear_tombstone(conn: &Connection, uid: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tombstones WHERE uid = ?1", [uid])?;
    Ok(())
}

/// Forget all sync state so a later connection uploads everything again.
pub fn reset_sync(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("UPDATE notes SET dirty = 1, remote_ts = ''", [])?;
    conn.execute("DELETE FROM tombstones", [])?;
    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn meta_delete(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])?;
    Ok(())
}
