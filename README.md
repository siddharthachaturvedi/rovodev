# RovoDev Hub

Zero-admin launcher for Atlassian CLI (`acli`) on macOS, with an **alpha** web GUI in this repo for future use.

> Product promise: after first-run setup, daily usage should not require Terminal.
>
> Origin story: I wanted this tool to exist, so I used RovoDev to build RovoDev Hub.

`macOS` • `no sudo` • `terminal` (supported) • `alpha GUI` (not shipped via launcher)

## Why This Exists

The goal was simple: one command, clean setup, and a usable UI for daily work.
No mystery scripts, no brittle hand-holding, no "go read 11 docs first."

## Install (recommended)

```bash
bash <(curl -fsSL https://sidc.ai/rovodev)
```

Fallback (GitHub-hosted installer):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/siddharthachaturvedi/rovodev/main/scripts/install.sh)
```

Local from repo:

```bash
bash rovodev-launcher.command
```

## What You Get

- **Supported today:** Terminal experience (TUI or `serve` mode) from the launcher
- Session-scoped workspace safety (`~/rovodev/workspace/sessions/<session_id>/`)
- Graceful port conflict handling with auto-fallback
- No `sudo` required
- **`gui/` (alpha):** experimental Next.js app in the repo only; **not** offered by the official launcher until open issues are resolved

## Alpha GUI (not enabled in the launcher)

The web app under `gui/` is **alpha** and **intentionally blocked** in `rovodev-launcher.command` (GUI install is marked coming soon). The launcher will not enable it until quality and safety work is complete.

**YOLO-style risk:** In the current GUI, chat streaming can behave like **`/yolo` in the TUI** (tools may auto-continue; there is no full manual tool-approval UI). Treat it like `/yolo`: powerful for demos, dangerous for production or careless use.

If you run the GUI from a **local clone** for development, you are on your own regarding auth, backend lifecycle, and the risks above.

## Promise Status

- **Current:** one auth command may still be required in some environments: `~/rovodev/bin/acli rovodev auth login`
- **Target:** a supported GUI path with onboarding for auth + backend lifecycle (not shipped via launcher yet)
- **Done means:** click app icon and work, no routine Terminal usage

## Quick Start Flow (supported install)

1. Run install command
2. Use **Option 1** / `--experience terminal` (the launcher does not enable GUI)
3. Authenticate if prompted; use TUI or `serve` as you prefer
4. Create thread and start building

**Local clone + alpha GUI (developers only):** run and develop `gui/` yourself; first-run onboarding in that app covers welcome, auth status, backend start, and ready—only when you start the Next app manually.

## Launcher Options

```bash
bash rovodev-launcher.command [options]
```

| Option | Default | Purpose |
|---|---:|---|
| `--experience terminal|gui` | `terminal` | Terminal flow is supported; GUI is blocked until ready |
| `--mode tui|serve` | `tui` | Launch mode for terminal experience |
| `--port <n>` | `8123` | API port in terminal `serve` mode |
| `--api-port <n>` | `8123` | Reserved for future GUI + backend |
| `--gui-port <n>` | `3210` | Reserved for future GUI web port |
| `--no-shortcut` | off | Skip Desktop app shortcut |
| `--no-dock` | off | Skip Dock pin |
| `--non-interactive` | off | Safe defaults without prompts |
| `-h`, `--help` | - | Print usage |

If a selected port is occupied, launcher picks the next free fallback port and continues.

## Contributing (especially GUI)

The alpha GUI needs hardening before it ships. To help:

- **Email:** schaturvedi2 [at] atlassian.com  
- **Or:** clone this repo on GitHub, fix what you can, and **open a pull request** for review and merge.

## Release and Versioning

Install/uninstall scripts resolve a release tag automatically, with optional overrides:

- `ROVODEV_VERSION=vX.Y.Z` pin a release
- `ROVODEV_REPO=owner/repo` use a fork
- `ROVODEV_RELEASE_REF=<tag|main>` control launcher archive ref

## Uninstall

Hosted entrypoint:

```bash
bash <(curl -fsSL https://sidc.ai/rovodev/uninstall)
```

Fallback (GitHub-hosted uninstaller):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/siddharthachaturvedi/rovodev/main/scripts/uninstall.sh)
```

Local from repo:

```bash
bash rovodev-uninstall.command
```

## Troubleshooting

- **Auth missing**
  - `~/rovodev/bin/acli rovodev auth login`
- **Backend not starting** (alpha GUI / local dev)
  - Check `~/rovodev/gui-backend.log`
- **GUI cannot connect** (alpha / local dev)
  - `curl -sS http://127.0.0.1:8123/healthcheck`
- **Port conflicts**
  - Auto-fallback is built in, or pass explicit ports:
  - `--api-port 8124 --gui-port 3211`
- **macOS Gatekeeper warning**
  - System Settings -> Privacy and Security -> Open Anyway
  - Or: `xattr -dr com.apple.quarantine ~/rovodev`

## Caution

`/yolo` can do real damage. Great for demos, terrifying for production. The alpha GUI can behave similarly; use both with care.
