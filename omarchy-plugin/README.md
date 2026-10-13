# Stickit for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that controls
[Stickit](https://github.com/menobass/stickit), the encrypted floating sticky-notes app.

- **Click**: show or hide your notes list (starts Stickit if it isn't running).
- **Middle-click**: new note (or the list, if the vault is locked).

The widget holds no data and needs no network. It only launches `stickit --toggle` or
`stickit --new`, which Stickit forwards to the copy already running.

## Install

You need the Stickit desktop app first, with `stickit` on the shell's `PATH`. Download the
`.deb`, `.rpm` or AppImage from the
[Stickit releases](https://github.com/menobass/stickit/releases/latest), or build it from source
(see the [Stickit README](https://github.com/menobass/stickit#install-the-desktop-app)). Linux only for now.

Then add the widget:

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

## License

[MIT](LICENSE)
