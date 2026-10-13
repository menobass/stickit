# Security model

What Stickit protects, how, and where the limits are.

## The short version

Your notes are encrypted with a random 256-bit key on your device. That key is stored only
*wrapped*: once under your passphrase and once under your 24-word recovery phrase. Anything that
leaves the device (the backup on Hive) is ciphertext.

## Details

| Item | How |
|------|-----|
| Note encryption | AES-256-GCM, a fresh random nonce per save |
| Note identity | the note id is bound in as authenticated data, so a ciphertext can't be passed off as a different note |
| Passphrase → key | Argon2id, 128 MiB memory, 3 passes |
| Recovery phrase | 24 BIP-39 words (256 bits). It wraps the same key, so recovery doesn't depend on the passphrase |
| Changing the passphrase | re-wraps one key; notes aren't re-encrypted |
| Posting key | stored sealed under the vault key; never in plain text |
| Search | done in memory after unlocking; there is no plain-text index on disk |
| Locking | drops the key from memory and closes all note windows |

The same format is implemented twice (Rust on the desktop, Web Crypto in the PWA) so either can
open what the other wrote. The code is `src-tauri/src/crypto.rs` and `shared/crypto.ts`.

## What an attacker can learn

- **With your disk (desktop):** the database holds only ciphertext. Without the passphrase or the
  recovery phrase, nothing readable.
- **With the Hive account name (anyone):** that the account exists, how many notes it has, their
  approximate sizes and edit times, and the *wrapped* vault key.

## Your passphrase is the whole defence

The wrapped key is public on Hive. Anyone can download it and guess passphrases offline as fast
as their hardware allows. Argon2id makes each guess expensive, but it can't save a weak
passphrase. Because the backup is permanent, an attacker can also try *later*, with better
hardware.

- Minimum length is 8 characters, but **use more**: four or five unrelated words is a good
  default. Don't reuse a passphrase from elsewhere.
- Losing both the passphrase and the recovery phrase means the notes are gone for good.

## Keys

- Use **only the posting key** of a **dedicated** account. Stickit rejects owner, active and
  memo keys. A posting key can't move funds.
- In the PWA the posting key is stored (sealed) in the browser's local storage, so treat a
  shared or untrusted browser as unsafe, and use **Lock** or "use a different account" when done.
- A compromised posting key lets someone post or delete under that account, not read your notes.

## Reporting a problem

Please open an issue, or contact the maintainer privately for anything security-sensitive.
