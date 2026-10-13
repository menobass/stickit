# Stickit for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that controls
[Stickit](https://github.com/menobass/stickit), the encrypted floating sticky-notes app.

- **Click**: show or hide your notes list (starts Stickit if it isn't running).
- **Middle-click**: new note (or the list, if the vault is locked).

The widget holds no data and needs no network. It only launches `stickit --toggle` or
`stickit --new`, which Stickit forwards to the copy already running.

## Install

You need the Stickit desktop app installed and `stickit` on the shell's `PATH`.

```sh
omarchy plugin add https://github.com/menobass/omarchy-stickit.git --enable
```

Or by hand:

```sh
git clone https://github.com/menobass/omarchy-stickit.git \
  ~/.config/omarchy/plugins/io.github.menobass.stickit
omarchy plugin enable io.github.menobass.stickit right
```

## Settings

If `stickit` isn't on the shell's `PATH` (for example it lives in `~/.local/bin` and the shell
doesn't see that), set the full path on the widget's entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.menobass.stickit", "command": "/home/you/.local/bin/stickit" }
```

## Remove

```sh
omarchy plugin remove io.github.menobass.stickit
```

## Troubleshooting

- **Nothing happens on click:** check that `stickit` runs from a terminal, then see Settings
  above for the `command` path.
- **The list opens but the vault is locked:** that's expected after a restart; enter your
  passphrase.
- **Edited the plugin and nothing changed:** run `omarchy restart shell`.

## Publishing this folder as its own repo

`omarchy plugin add` installs a repo whose root contains `manifest.json`. Publish the
`omarchy-plugin/` folder of the Stickit repo as the root of its own repository.

## License

[MIT](LICENSE)
