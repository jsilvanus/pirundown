# systemd user unit

`pirundown.service` runs pirundown as a systemd user service.

Expected layout (relative to the service user's home, `%h`):

- app checkout (built, with `dist/`): `~/apps/pirundown`
- environment file: `~/apps/pirundown.env` (all settings and secrets live here, never in git)
- Node.js: `~/.local/bin/node`

Install:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/pirundown.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pirundown
loginctl enable-linger "$USER"   # once, so it runs without a login session
```

Status and logs: `systemctl --user status pirundown`, `journalctl --user -u pirundown -f`.
