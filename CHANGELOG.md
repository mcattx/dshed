# Changelog

All notable changes to dshed are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Engine lifecycle management: spawn, port discovery, health check, crash restart, graceful shutdown
- Token-authenticated local proxy (HTTP/SSE token + WebSocket Origin check + Host/Origin rewrite)
- Cross-platform packaging (macOS arm64/x64, Windows x64, Linux x64/arm64)
- Tray, window management, first-run migration (`~/.dsh` merge)
- Auto-update skeleton (electron-updater + zip metadata)
- Documentation: usage guide, development guide, contributing guidelines, security policy

### Changed
- Releases are unsigned (community project, no certificate budget) — see SECURITY.md

## [0.1.0] - 2026-08

Initial engineering milestone: core shell verified end-to-end (engine + auth proxy), macOS arm64 packaging.
