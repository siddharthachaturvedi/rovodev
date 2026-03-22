# RovoDev Hub

RovoDev Hub is a zero-admin launcher + GUI shell around Atlassian CLI (`acli`) for macOS.

The goal is simple:

> Click the **Rovo Dev Hub** icon in your Dock or on your Desktop. No Terminal needed after the first run.

Yes, we know. Bold promise. We like living dangerously.

## Quick Install

Preferred stable entrypoint:

```bash
bash <(curl -fsSL https://sidc.ai/rovodev/install)
```

Fallback (GitHub-hosted installer script):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/siddharthachaturvedi/rovodev/main/scripts/install.sh)
```

Local run from repo:

```bash
bash rovodev-launcher.command
```

## Promise Status

- **Current:** first run may still require one auth command (`acli rovodev auth login`) in some environments.
- **Target:** first-run wizard inside GUI handles auth checks, backend controls, and setup progress.
- **Definition of done:** open app icon, use Hub, never touch terminal for routine use.

## Experience Matrix

- **Terminal experience:** launches TUI (`acli rovodev tui`) or direct server mode (`serve`).
- **GUI experience:** runs local backend + Next.js UI at `http://127.0.0.1:<gui-port>`.
- **Session safety:** each session maps to `~/rovodev/workspace/sessions/<session_id>/`.

## Launcher Options

```bash
bash rovodev-launcher.command [options]
```

- `--experience terminal|gui` (default: `terminal`)
- `--mode tui|serve` (default: `tui`)
- `--port <number>` for terminal serve mode (default: `8123`)
- `--api-port <number>` for GUI backend (default: `8123`)
- `--gui-port <number>` for GUI web app (default: `3210`)
- `--no-shortcut` skip Desktop app creation
- `--no-dock` skip Dock pinning
- `--non-interactive` skip prompts and use safe defaults
- `-h`, `--help` show help

If a requested port is already occupied, launcher now auto-selects a nearby free fallback port and continues.

## What Install Does

- Installs `acli` into `~/rovodev/bin` (no `sudo`)
- Creates workspace in `~/rovodev/workspace`
- Seeds local skills into `~/.rovodev/skills`
- Optionally creates a Desktop app and Dock pin
- For GUI mode, installs web app files into `~/rovodev/gui`

## First-Run UX (GUI)

The onboarding flow is designed to guide:

1. Welcome and quick tour
2. Auth status check
3. Backend start/restart controls
4. Ready state

If auth is missing, the app gives you the exact command and a re-check button.

## Release-Based Packaging

Installer and uninstaller scripts resolve a release tag (or use `ROVODEV_VERSION` override), download that archive, and run the launcher/uninstaller from that version.

Useful env vars:

- `ROVODEV_VERSION=vX.Y.Z` to pin install version
- `ROVODEV_REPO=owner/repo` to target a fork
- `ROVODEV_RELEASE_REF=<tag|main>` for launcher archive fetch in GUI mode

## Troubleshooting

- **Auth says missing**
  - Run: `~/rovodev/bin/acli rovodev auth login`
- **Backend won’t start**
  - Check log: `~/rovodev/gui-backend.log`
- **GUI cannot connect**
  - Verify: `curl -sS http://127.0.0.1:8123/healthcheck`
- **Port conflict**
  - Launcher auto-falls back to a free nearby port.
  - To force specific ports anyway: `--api-port 8124 --gui-port 3211`
- **macOS says app cannot be verified**
  - One-time allow in **System Settings → Privacy & Security** (Open Anyway), then relaunch.
  - Or remove quarantine attribute manually: `xattr -dr com.apple.quarantine ~/rovodev`
- **Corporate restrictions**
  - Desktop/Dock setup may be skipped, launcher continues.

## Uninstall

Preferred stable entrypoint:

```bash
bash <(curl -fsSL https://sidc.ai/rovodev/uninstall)
```

Fallback (GitHub-hosted uninstaller script):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/siddharthachaturvedi/rovodev/main/scripts/uninstall.sh)
```

Local run from repo:

```bash
bash rovodev-uninstall.command
```

## Caution

`/yolo` can do real damage. Great for demos, terrifying for production.
