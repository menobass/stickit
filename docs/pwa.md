# The Stickit PWA

A browser/phone client for the same notes. It reads and writes the vault your desktop app created,
through Hive. It can't create a vault itself: set up Hive backup on the desktop first.

## Build and host

```sh
npm install
npm run pwa:build      # static files in pwa/dist
```

Serve `pwa/dist` from any static host **over HTTPS** (the service worker and installability need
it). With Caddy, for example:

```
notes.example.com {
    root * /srv/stickit
    file_server
}
```

Copy `pwa/dist/*` to that folder. A subfolder works too (the build uses relative paths).
For local development use `npm run pwa:dev` (http://localhost:5180).

No server code and no API proxy are needed: the app talks to public Hive nodes directly.

## Sign in

Enter:

1. the Hive **username** of the notes account,
2. its **posting key**,
3. the **vault passphrase** from the desktop.

The app finds the vault on Hive, unlocks it and pulls your notes. On later visits it asks for the
passphrase only.

Install it from the browser menu ("Add to Home screen" / "Install app") for a full-screen app.

## How it syncs

| Event | What happens |
|-------|--------------|
| open the app, press ⟳ | full sync: pull, then push your changes |
| every minute while open | pull only (free) |
| about 2 minutes after you stop typing | push |
| the app goes to the background | push, if there are unsent changes |

If the same note changed on both sides, the other version is kept as a *conflict copy* so nothing
is lost.

## What's stored in the browser

One entry in `localStorage` holding the account name, the encrypted notes, and the posting key
sealed under your vault key. The vault key itself is kept only in memory, so a reload asks for the
passphrase. Local storage is capped at a few MB, which is plenty for text notes.

## Limits

- Sign-in needs the desktop vault to exist already; there is no recovery-phrase entry or vault
  creation in the PWA.
- Unlocking runs the same memory-hard key derivation as the desktop (128 MiB). A very old phone
  may take several seconds or run out of memory.
