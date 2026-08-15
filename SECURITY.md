# Security

How dshed approaches security, what the current limits are, and how to report issues.

## Threat model (short version)

dshed renders the dsh engine's web UI in a desktop window and guards it with a local authentication proxy:

- The window only ever navigates to the proxy origin (whitelist enforced on navigation and redirects)
- Every request through the proxy is authenticated: a per-session token on HTTP/SSE, an Origin check on WebSocket upgrades
- The proxy rewrites Host/Origin when forwarding, so the engine sees a same-origin caller; requests with a missing token, mismatched Origin, or forged Host are rejected
- API credentials are managed by dsh itself (environment or `$DSH_HOME/.credentials.yaml`); dshed never reads or stores them

This defends against malicious web pages, DNS rebinding, and CSRF. It does **not** defend against malware running with the same OS-level privileges as the user (no sandbox escapes that guarantee).

## Known limits you should know

### Unsigned releases

dshed is a community project without budget for code-signing certificates. All releases are **unsigned**:

| Consequence | Detail |
|---|---|
| macOS Gatekeeper | "unidentified developer" on first launch (right-click → Open to run) |
| Windows SmartScreen | may show a warning on install |
| Auto-update channel | update packages have **no code-signature verification** |

**Signed builds will be provided if community crowdfunding or a sponsor covers certificate costs** (Apple Developer ~USD 99/year + a Windows code-signing cert).

### Auto-update trust

Updates are distributed as archives with SHA-512 hashes (`latest-mac.yml` etc.). Without a code signature, an attacker who can tamper with the update channel could replace both the manifest and the archive. In practice:

- Update checks run in the background; a tampered update is **not** installed automatically — the app asks before restarting
- The app itself is not sandboxed (by design: it must spawn subprocesses and listen on localhost)

If you distribute dshed inside a high-security environment, disable auto-update or pin a trusted version.

## Privacy / telemetry

The dsh engine generates an **anonymous random UUID** (`$DSH_HOME/.anonymous-user-id`, e.g. `dshed.app/Contents/Resources/dsh` data dir). Per the upstream dsh documentation:

- It is sent with session telemetry (OpenTelemetry) and DeepSeek provider requests as the header `x-deepseek-harness-user-id`
- It is never derived from hostname, network address, or other identifying sources
- Delete the file to reset the identity
- Set `DSH_TELEMETRY_DISABLED=1` to stop telemetry export (this does not disable the provider request header)

dshed itself does not collect telemetry, analytics, or crash reports.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

- **Email: [security@dshed.app](mailto:security@dshed.app)** — the primary channel (forwarded privately to the maintainer)
- Alternative: GitHub's **Private Vulnerability Reporting** for this repository (Settings → Security → Private vulnerability reporting)
- Include: affected version, platform, reproduction steps, and impact
- We aim to respond within 7 days and coordinate disclosure after a fix is released

## Reporting a non-security bug

Open a regular [issue](https://github.com/mcattx/dshed/issues) following [CONTRIBUTING.md](CONTRIBUTING.md).
