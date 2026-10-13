//! Vault crypto.
//!
//! A random 32-byte master key encrypts every note (AES-256-GCM). The master key is stored only
//! wrapped: once under the passphrase (Argon2id) and once under a 24-word recovery phrase, so
//! changing the passphrase re-wraps one key instead of re-encrypting history (which is permanent
//! once it is on Hive).//!
//! Everything is plain JSON with base64 fields so the PWA can read the same bytes with Web Crypto
//! (AES-GCM, SHA-256) plus an Argon2id library.

use aes_gcm::aead::{rand_core::RngCore, Aead, OsRng, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bip39::Mnemonic;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub type Res<T> = Result<T, String>;
type Key = Zeroizing<[u8; 32]>;

const VERSION: u8 = 1;
const MIN_PASSPHRASE_CHARS: usize = 8;
const AAD_WRAP_PASS: &[u8] = b"stickit/v1/wrap/passphrase";
const AAD_WRAP_RECOVERY: &[u8] = b"stickit/v1/wrap/recovery";

#[derive(Clone, Copy)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

/// Heavy on purpose: wrapped keys end up public on-chain, so offline guessing is unthrottled.
pub const KDF_DEFAULT: KdfParams = KdfParams { m_kib: 128 * 1024, t: 3, p: 1 };

#[derive(Serialize, Deserialize, Clone)]
pub struct Kdf {
    alg: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

/// One AES-GCM ciphertext. `kdf` is present only when the key is derived from a passphrase.
#[derive(Serialize, Deserialize, Clone)]
pub struct Envelope {
    v: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    kdf: Option<Kdf>,
    n: String,
    c: String,
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

fn seal_bytes(key: &[u8; 32], aad: &[u8], plain: &[u8], kdf: Option<Kdf>) -> Res<Envelope> {
    let nonce = random::<12>();
    let ct = Aes256Gcm::new_from_slice(key)
        .unwrap()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| "encryption failed")?;
    Ok(Envelope { v: VERSION, kdf, n: B64.encode(nonce), c: B64.encode(ct) })
}

fn open_bytes(key: &[u8; 32], aad: &[u8], e: &Envelope) -> Res<Zeroizing<Vec<u8>>> {
    if e.v != VERSION {
        return Err(format!("unsupported format version {}", e.v));
    }
    let nonce = B64.decode(&e.n).map_err(|_| "bad nonce")?;
    if nonce.len() != 12 {
        return Err("bad nonce".into());
    }
    let ct = B64.decode(&e.c).map_err(|_| "bad ciphertext")?;
    Aes256Gcm::new_from_slice(key)
        .unwrap()
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| "wrong passphrase or corrupted data".into())
}

fn to_key(bytes: Zeroizing<Vec<u8>>) -> Res<Key> {
    let mut k = Zeroizing::new([0u8; 32]);
    if bytes.len() != 32 {
        return Err("bad key length".into());
    }
    k.copy_from_slice(&bytes);
    Ok(k)
}

fn check_passphrase(pass: &str) -> Res<()> {
    if pass.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(format!("passphrase must be at least {MIN_PASSPHRASE_CHARS} characters"));
    }
    Ok(())
}

fn derive(pass: &str, kdf: &Kdf) -> Res<Key> {
    // These come from public data, so bound them before allocating memory for them.
    if kdf.alg != "argon2id" || kdf.m > 512 * 1024 || kdf.t > 10 || kdf.p > 4 {
        return Err("unsupported key derivation parameters".into());
    }
    let salt = B64.decode(&kdf.salt).map_err(|_| "bad salt")?;
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pass.as_bytes(), &salt, &mut *out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn wrap_with_passphrase(key: &[u8; 32], pass: &str, p: KdfParams, aad: &[u8]) -> Res<Envelope> {
    check_passphrase(pass)?;
    let kdf = Kdf { alg: "argon2id".into(), m: p.m_kib, t: p.t, p: p.p, salt: B64.encode(random::<16>()) };
    let kek = derive(pass, &kdf)?;
    seal_bytes(&kek, aad, key, Some(kdf))
}

fn unwrap_with_passphrase(e: &Envelope, pass: &str, aad: &[u8]) -> Res<Key> {
    let kdf = e.kdf.as_ref().ok_or("missing key derivation parameters")?;
    let kek = derive(pass, kdf)?;
    to_key(open_bytes(&kek, aad, e)?)
}

/// The phrase already carries 256 bits of entropy, so no slow KDF is needed.
fn recovery_kek(entropy: &[u8]) -> Key {
    let mut h = Sha256::new();
    h.update(b"stickit/v1/recovery");
    h.update(entropy);
    Zeroizing::new(h.finalize().into())
}

/// A random 64-bit id as 16 lowercase hex chars (note uids, vault ids). Safe in a Hive permlink.
pub fn new_id() -> String {
    random::<8>().iter().map(|b| format!("{b:02x}")).collect()
}

pub struct Vault(Key);

pub struct NewVault {
    pub vault: Vault,
    pub passphrase_wrap: Envelope,
    pub recovery_wrap: Envelope,
    /// Show once; the user must write it down.
    pub recovery_phrase: String,
}

impl Vault {
    pub fn create(pass: &str, params: KdfParams) -> Res<NewVault> {
        let key = Zeroizing::new(random::<32>());
        let passphrase_wrap = wrap_with_passphrase(&key, pass, params, AAD_WRAP_PASS)?;
        let entropy = Zeroizing::new(random::<32>());
        let phrase = Mnemonic::from_entropy(&*entropy).map_err(|e| e.to_string())?;
        let recovery_wrap = seal_bytes(&recovery_kek(&*entropy), AAD_WRAP_RECOVERY, &*key, None)?;
        Ok(NewVault { vault: Vault(key), passphrase_wrap, recovery_wrap, recovery_phrase: phrase.to_string() })
    }

    pub fn unlock(wrap: &Envelope, pass: &str) -> Res<Vault> {
        unwrap_with_passphrase(wrap, pass, AAD_WRAP_PASS).map(Vault)
    }

    pub fn unlock_with_recovery(wrap: &Envelope, phrase: &str) -> Res<Vault> {
        let entropy = Zeroizing::new(Mnemonic::parse(phrase).map_err(|_| "invalid recovery phrase")?.to_entropy());
        to_key(open_bytes(&recovery_kek(&entropy), AAD_WRAP_RECOVERY, wrap)?).map(Vault)
    }

    /// New passphrase wrapper for the same master key. Notes stay untouched.
    pub fn rewrap(&self, new_pass: &str, params: KdfParams) -> Res<Envelope> {
        wrap_with_passphrase(&self.0, new_pass, params, AAD_WRAP_PASS)
    }

    /// The note's uid is authenticated, so a ciphertext can't be passed off as another note.
    pub fn seal_note(&self, uid: &str, plain: &str) -> Res<String> {
        self.seal_ctx(&format!("note/{uid}"), plain)
    }

    pub fn open_note(&self, uid: &str, sealed: &str) -> Res<String> {
        self.open_ctx(&format!("note/{uid}"), sealed)
    }

    /// Small named secrets (e.g. the Hive posting key) stored under the vault key.
    pub fn seal_secret(&self, name: &str, plain: &str) -> Res<String> {
        self.seal_ctx(&format!("secret/{name}"), plain)
    }

    pub fn open_secret(&self, name: &str, sealed: &str) -> Res<String> {
        self.open_ctx(&format!("secret/{name}"), sealed)
    }

    fn seal_ctx(&self, ctx: &str, plain: &str) -> Res<String> {
        let e = seal_bytes(&self.0, format!("stickit/v1/{ctx}").as_bytes(), plain.as_bytes(), None)?;
        serde_json::to_string(&e).map_err(|e| e.to_string())
    }

    fn open_ctx(&self, ctx: &str, sealed: &str) -> Res<String> {
        let e: Envelope = serde_json::from_str(sealed).map_err(|_| "not a sealed note")?;
        utf8(open_bytes(&self.0, format!("stickit/v1/{ctx}").as_bytes(), &e)?)
    }
}

fn utf8(bytes: Zeroizing<Vec<u8>>) -> Res<String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "note is not valid text".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fast parameters; production uses KDF_DEFAULT.
    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
    const PASS: &str = "correct horse battery";

    #[test]
    fn note_roundtrip_and_unlock() {
        let nv = Vault::create(PASS, FAST).unwrap();
        let sealed = nv.vault.seal_note("7", "hello 🗒").unwrap();
        assert!(!sealed.contains("hello"));
        let again = Vault::unlock(&nv.passphrase_wrap, PASS).unwrap();
        assert_eq!(again.open_note("7", &sealed).unwrap(), "hello 🗒");
    }

    #[test]
    fn wrong_passphrase_fails() {
        let nv = Vault::create(PASS, FAST).unwrap();
        assert!(Vault::unlock(&nv.passphrase_wrap, "not the right one!").is_err());
    }

    #[test]
    fn recovery_phrase_unlocks() {
        let nv = Vault::create(PASS, FAST).unwrap();
        assert_eq!(nv.recovery_phrase.split(' ').count(), 24);
        let sealed = nv.vault.seal_note("1", "x").unwrap();
        let v = Vault::unlock_with_recovery(&nv.recovery_wrap, &nv.recovery_phrase).unwrap();
        assert_eq!(v.open_note("1", &sealed).unwrap(), "x");
        let other = Vault::create(PASS, FAST).unwrap();
        assert!(Vault::unlock_with_recovery(&nv.recovery_wrap, &other.recovery_phrase).is_err());
    }

    #[test]
    fn changing_passphrase_keeps_old_notes_readable() {
        let nv = Vault::create(PASS, FAST).unwrap();
        let sealed = nv.vault.seal_note("1", "old note").unwrap();
        let wrap = nv.vault.rewrap("a brand new passphrase", FAST).unwrap();
        assert!(Vault::unlock(&wrap, PASS).is_err());
        let v = Vault::unlock(&wrap, "a brand new passphrase").unwrap();
        assert_eq!(v.open_note("1", &sealed).unwrap(), "old note");
    }

    #[test]
    fn sealed_note_is_bound_to_its_uid_and_tamper_evident() {
        let nv = Vault::create(PASS, FAST).unwrap();
        let sealed = nv.vault.seal_note("1", "secret").unwrap();
        assert!(nv.vault.open_note("2", &sealed).is_err());
        let mut e: Envelope = serde_json::from_str(&sealed).unwrap();
        let mut ct = B64.decode(&e.c).unwrap();
        ct[0] ^= 1;
        e.c = B64.encode(ct);
        assert!(nv.vault.open_note("1", &serde_json::to_string(&e).unwrap()).is_err());
    }

    #[test]
    fn weak_passphrases_and_hostile_kdf_params_are_rejected() {
        assert!(Vault::create("short", FAST).is_err());
        let nv = Vault::create(PASS, FAST).unwrap();
        let mut w = nv.passphrase_wrap.clone();
        w.kdf.as_mut().unwrap().m = u32::MAX;
        assert!(Vault::unlock(&w, PASS).is_err());
    }
}
