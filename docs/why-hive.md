# Why Hive?

Stickit works fully offline. Hive is an *optional* way to back notes up and move them between your
devices without running a server or trusting a company with them.

## What Hive is, in one paragraph

[Hive](https://hive.io) is a public blockchain built for social content: posts and comments that
anyone can read and that no one can censor or switch off. Accounts are free to use, there are no
per-transaction fees, and writing is rate-limited by *Resource Credits* instead of money.

## Why it suits notes

- **No server, no subscription.** There is nothing to host, and nothing that can shut down and
  take your notes with it.
- **You own the account.** Your keys, your data. The project never sees either.
- **Sync for free.** Any device that knows the account and your passphrase can read and write.
- **Encrypted before it leaves.** Hive only ever receives scrambled text.

## How Stickit uses it

Everything lives under one Hive account:

```
@yournotes
 └─ stickit-vault-<id>        a root post: "Vault Container"
     │                          its metadata holds the wrapped (encrypted) vault key
     ├─ n-<note id>            a reply per note, body = the encrypted note
     ├─ n-<note id>
     └─ ...
```

Every post is published with payout declined and votes disabled, so it never shows up as
something to read or reward. Editing a note edits its reply; deleting removes it.

## Resource Credits

Each operation on Hive, including each note you back up, spends a little of the account's
Resource Credits (RC). RC refill by themselves over about five days.

- How many RC an account has depends on its **Hive Power** (HIVE locked up for that purpose).
  A brand-new account has very little, so it can only back up a handful of notes before sync
  pauses until RC refill.
- Stickit shows an RC meter, warns you below 20%, and pauses auto-sync at 5% so it can't run the
  account dry.
- **To get more:** buy HIVE and *power it up* on the notes account. More Hive Power means more
  RC. The HIVE stays yours; powering down takes a few weeks.
- Checking for changes from other devices only *reads* from Hive and costs no RC.

## Things to know before you rely on it

- **It is permanent.** Deleting a note removes it from Hive's current state, but old versions stay
  in the block history, still encrypted. A strong passphrase matters. See [security](security.md).
- **It is public.** Anyone can see the account name, how many notes there are, their sizes and
  when they changed. They cannot read the contents.
- **Size and rate limits.** A note must be under roughly 40 KB of text, and Hive allows a comment
  every three seconds, so a first big sync takes a while. Stickit paces itself.
- **Use a dedicated account** with only the posting key, so a mistake can never touch funds.
