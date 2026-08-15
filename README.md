# dshed

> Run dsh like a desktop app.

dshed, pronounced “dee-shed”, is an independent desktop wrapper for the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

[简体中文](README.zh-CN.md) · [dshed.app](https://dshed.app) · [Releases](https://github.com/mcattx/dshed/releases) · [Issues](https://github.com/mcattx/dshed/issues)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

dsh is a full agent harness — sessions, workspaces, tools, multi-model routing — served as a web UI on localhost. dshed wraps that UI in an Electron shell: an embedded Node 22 runtime starts the engine, a token-authenticated local proxy keeps the app and the engine apart, and a tray lets you park it and come back. Install, launch, and the harness is on your screen.

The part that isn't like other wrappers: the security boundary is real, not cosmetic. Every request through the proxy is authenticated — a per-session token on HTTP/SSE, an Origin check on WebSocket — and the window only ever navigates to the proxy. The threat model in mind: malicious web pages, DNS rebinding, CSRF, and anything else that would try to reach your engine from outside.

## Install

Grab the installer for your platform from the [Releases](https://github.com/mcattx/dshed/releases) page:

| Platform | Artifact |
|---|---|
| macOS (Apple Silicon) | `dshed-*-mac-arm64.dmg` |
| macOS (Intel) | `dshed-*-mac-x64.dmg` |
| Windows | `dshed-*-win-x64.exe` |
| Linux | `dshed-*-linux-*.AppImage` / `.deb` |

> **Signing status**: Releases are **unsigned**. dshed is a community project without the budget for Apple Developer (USD 99/year) and Windows code-signing certificates. Consequences:
>
> - macOS: Gatekeeper shows "unidentified developer" on first launch — right-click → Open to run
> - Windows: SmartScreen may warn
> - Auto-update channel has no code-signature verification
>
> We will provide signed builds if community crowdfunding or a sponsor covers certificate costs — see [Security](SECURITY.md).

## Use

Launch the app. The dsh engine starts itself, its UI opens in the main window, and your credentials come along automatically — dshed picks up `DEEPSEEK_API_KEY` from your environment or `dsh auth` config, and never reads or stores your keys itself.

- Close the window on macOS: the app parks in the tray; click the icon to bring it back, right-click for Show / Quit.
- Start a second instance: it focuses the existing window instead of spawning a new one.
- The engine crashes: dshed restarts it and reconnects the proxy; repeated crashes land on an error page instead of a silent death.

## What it does

- **Zero configuration.** No `export`, no `--port`, no setup page. If the harness can see your credentials, dshed sees nothing to do.
- **A real security boundary.** The renderer talks only to the proxy; the proxy forwards to the engine on `127.0.0.1`, rewriting Host/Origin so the engine sees a same-origin caller. Requests without a token, with a mismatched Origin, or a forged Host are rejected. A navigation whitelist blocks anything outside the proxy origin.
- **Lifecycle management.** Port discovery, graceful shutdown (SIGTERM → wait → kill tree), crash restart with exponential backoff, and a port-release check on exit — no orphan processes, no leftover listeners.
- **A desktop citizen.** Dock icon, tray menu, window restore, single-instance lock, and a first-run migration that folds an existing `~/.dsh` into dshed's data directory without overwriting anything.
- **Update-ready.** electron-updater is wired with a zip artifact and `latest-mac.yml` metadata; a background check quietly stages a new version and asks before restarting.

## Build from source

```bash
npm install
npm run prepare:dsh   # download the dsh engine + bundled Node runtime
npm start             # dev mode
```

Smoke tests cover engine lifecycle, auth proxy, and crash restart: `npm test`.

## Roadmap

- [x] Engine lifecycle + auth proxy — verified end-to-end
- [x] macOS packaging (arm64 + x64) with auto-update metadata
- [x] Tray, window management, first-run migration
- [ ] Windows / Linux packaging validation
- [ ] Notarized, signed releases
- [ ] CI builds for all three platforms

## Contributing

Issues with repro steps, logs, and feature requests are all real project work. Keep changes scoped and run `npm test` before opening a PR.

## License

[MIT](LICENSE). An independent community project, not affiliated with DeepSeek.
