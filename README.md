# RovoDev Hub

Zero-admin launcher and GUI shell for Atlassian CLI (`acli`) on macOS.

> Product promise: after first-run setup, daily usage should not require Terminal.
>
> Origin story: I wanted this tool to exist, so I used RovoDev to build RovoDev Hub.

`macOS` • `no sudo` • `terminal + GUI` • `first-run onboarding`

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

- Terminal and GUI experiences from one launcher
- Session-scoped workspace safety (`~/rovodev/workspace/sessions/<session_id>/`)
- First-run onboarding for auth + backend readiness
- Graceful port conflict handling with auto-fallback
- No `sudo` required

## Promise Status

- **Current:** one auth command may still be required in some environments: `~/rovodev/bin/acli rovodev auth login`
- **Target:** GUI onboarding handles auth status + backend lifecycle
- **Done means:** click app icon and work, no routine Terminal usage

## Quick Start Flow

1. Run install command
2. Choose Option 1 / `--experience terminal` (Option 2 GUI is marked Coming Soon in launcher)
3. Complete onboarding (auth check, backend start)
4. Create thread and start building

## Launcher Options

```bash
bash rovodev-launcher.command [options]
```

| Option | Default | Purpose |
|---|---:|---|
| `--experience terminal|gui` | `terminal` | Choose TUI/server or GUI flow |
| `--mode tui|serve` | `tui` | Launch mode for terminal experience |
| `--port <n>` | `8123` | API port in terminal `serve` mode |
| `--api-port <n>` | `8123` | Backend API port for GUI mode |
| `--gui-port <n>` | `3210` | Web port for GUI app |
| `--no-shortcut` | off | Skip Desktop app shortcut |
| `--no-dock` | off | Skip Dock pin |
| `--non-interactive` | off | Safe defaults without prompts |
| `-h`, `--help` | - | Print usage |

If a selected port is occupied, launcher picks the next free fallback port and continues.

## First-Run Onboarding (GUI)

The onboarding modal walks through:

1. Welcome
2. Auth status
3. Backend start/restart
4. Ready

If auth is missing, it shows the exact command and supports re-check in-app.

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
- **Backend not starting**
  - Check `~/rovodev/gui-backend.log`
- **GUI cannot connect**
  - `curl -sS http://127.0.0.1:8123/healthcheck`
- **Port conflicts**
  - Auto-fallback is built in, or pass explicit ports:
  - `--api-port 8124 --gui-port 3211`
- **macOS Gatekeeper warning**
  - System Settings -> Privacy and Security -> Open Anyway
  - Or: `xattr -dr com.apple.quarantine ~/rovodev`

## Caution

`/yolo` can do real damage. Great for demos, terrifying for production.
