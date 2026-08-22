'use strict'

/**
 * runtime-manifest-client — fetches the remote dsh runtime manifest from a fixed
 * HTTPS endpoint, validates its schema, and resolves the single artifact for
 * the current platform/arch into a fully-validated manifest plus a derived
 * artifact download URL.
 *
 * Trust model: the manifest URL is a fixed built-in endpoint (owner/repo
 * mcattx/dshed). The transport (dependency-injected) enforces HTTPS + host
 * whitelist + redirect limit; this client enforces a 64 KiB body cap and full
 * schema validation. The artifact URL is *derived* from `releaseTag + archive`
 * — a manifest can never point at an arbitrary host.
 */

const { URL } = require('node:url')
const { validateManifest, compareVersions } = require('./runtime-manager')
const { httpsTransport, ALLOWED_HOSTS } = require('./runtime-downloader')

const OWNER = 'mcattx'
const REPO = 'dshed'
const MANIFEST_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/dsh-runtime`
const STABLE_MANIFEST_URL = `${MANIFEST_BASE}/stable-manifest.json`
const PREVIEW_MANIFEST_URL = `${MANIFEST_BASE}/preview-manifest.json`

const MAX_MANIFEST_BYTES = 64 * 1024

// release tag is namespaced `dsh-v…` so it never collides with the shell's `v*` releases
const RELEASE_TAG_RE = /^dsh-v[A-Za-z0-9][A-Za-z0-9._-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

/** read a response body with a hard byte cap */
function readBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    stream.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) { settled = true; stream.destroy(); reject(new Error(`manifest exceeds ${maxBytes} bytes`)); return }
      chunks.push(chunk)
    })
    stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')) } })
    stream.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
  })
}

/** fetch and JSON-parse the manifest, enforcing the body cap */
async function fetchManifestJson(url, { transport, signal }) {
  const res = await transport.request(url, { headers: {}, signal })
  if (res.statusCode !== 200) {
    res.stream.resume()
    throw new Error(`manifest fetch HTTP ${res.statusCode}`)
  }
  const body = await readBody(res.stream, MAX_MANIFEST_BYTES)
  try { return JSON.parse(body) } catch (e) { throw new Error('manifest is not valid JSON') }
}

/** validate the matrix envelope (schemaVersion + latest + versions + artifacts) */
function validateMatrix(raw) {
  if (!isObject(raw)) throw new Error('manifest must be an object')
  if (raw.schemaVersion !== 2) throw new Error(`unsupported schemaVersion: ${raw.schemaVersion}`)
  if (!isObject(raw.latest)) throw new Error('manifest.latest must be an object')
  const latest = raw.latest
  if (typeof latest.dshVersion !== 'string' || !VERSION_RE.test(latest.dshVersion)) {
    throw new Error(`invalid dshVersion: ${latest.dshVersion}`)
  }
  if (typeof latest.minimumDshedVersion !== 'string' || !VERSION_RE.test(latest.minimumDshedVersion)) {
    throw new Error(`invalid minimumDshedVersion: ${latest.minimumDshedVersion}`)
  }
  if (typeof latest.releasedAt !== 'string' || latest.releasedAt.length === 0) {
    throw new Error('missing releasedAt')
  }
  if (!Array.isArray(latest.artifacts) || latest.artifacts.length === 0) {
    throw new Error('latest.artifacts must be a non-empty array')
  }
  return latest
}

/** find the unique artifact matching platform + arch */
function matchArtifact(artifacts, platform, arch) {
  const matches = artifacts.filter((a) => a.platform === platform && a.arch === arch)
  if (matches.length === 0) throw new Error(`no artifact for ${platform}/${arch}`)
  if (matches.length > 1) throw new Error(`multiple artifacts for ${platform}/${arch}`)
  return matches[0]
}

/** derive the artifact download URL from releaseTag + archive (host is fixed) */
function deriveArtifactUrl(releaseTag, archive) {
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/${releaseTag}/${archive}`
  const u = new URL(url)
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`artifact host not allowed: ${u.hostname}`)
  return url
}

/** build a single-artifact manifest (schemaVersion 1) and validate it */
function resolveArtifact(latest, artifact, channel) {
  // releaseTag is per-artifact (contains the platform-specific buildId)
  if (typeof artifact.releaseTag !== 'string' || !RELEASE_TAG_RE.test(artifact.releaseTag)) {
    throw new Error(`invalid artifact releaseTag: ${artifact.releaseTag}`)
  }
  const single = {
    schemaVersion: 1,
    runtimeId: artifact.runtimeId,
    dshVersion: latest.dshVersion,
    buildId: artifact.buildId,
    platform: artifact.platform,
    arch: artifact.arch,
    archive: artifact.archive,
    sha256: artifact.sha256,
    size: artifact.size,
    extractedSize: artifact.extractedSize,
    extractedFileCount: artifact.extractedFileCount,
    entry: artifact.entry,
    minimumDshedVersion: latest.minimumDshedVersion,
    releasedAt: latest.releasedAt,
  }
  const check = validateManifest(single, { platform: artifact.platform, arch: artifact.arch })
  if (!check.valid) throw new Error(`invalid artifact: ${check.errors.join('; ')}`)
  const artifactUrl = deriveArtifactUrl(artifact.releaseTag, artifact.archive)
  return { ...single, releaseTag: artifact.releaseTag, channel, artifactUrl }
}

/**
 * Fetch and resolve the runtime manifest for the current platform/arch.
 * Returns a single-artifact manifest plus `artifactUrl` (derived) and
 * `releaseTag`/`channel`. Throws on any trust/schema/compatibility violation.
 */
async function fetchManifest(options) {
  const {
    channel = 'stable',
    platform,
    arch,
    currentDshedVersion,
    transport = httpsTransport,
    signal,
    logger,
  } = options
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }

  if (channel !== 'stable' && channel !== 'preview') throw new Error(`unknown channel: ${channel}`)
  if (!platform || !arch) throw new Error('platform and arch are required')

  // the manifest endpoint is fixed and never caller-supplied: production always
  // hits the built-in stable/preview endpoint on the fixed owner/repo. Only the
  // transport is injectable (for tests); the URL is derived from `channel`.
  const manifestUrl = channel === 'preview' ? PREVIEW_MANIFEST_URL : STABLE_MANIFEST_URL
  log.info(`[manifest] fetching ${channel} manifest`)

  const raw = await fetchManifestJson(manifestUrl, { transport, signal })
  const latest = validateMatrix(raw)

  if (currentDshedVersion && compareVersions(currentDshedVersion, latest.minimumDshedVersion) < 0) {
    throw new Error(`dshed ${currentDshedVersion} is older than required ${latest.minimumDshedVersion}`)
  }

  const artifact = matchArtifact(latest.artifacts, platform, arch)
  return resolveArtifact(latest, artifact, channel)
}

module.exports = {
  fetchManifest,
  fetchManifestJson,
  validateMatrix,
  matchArtifact,
  deriveArtifactUrl,
  resolveArtifact,
  STABLE_MANIFEST_URL,
  PREVIEW_MANIFEST_URL,
  MAX_MANIFEST_BYTES,
  OWNER,
  REPO,
}
