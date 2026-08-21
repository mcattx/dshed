'use strict'

/**
 * runtime-update-coordinator — orchestrates the background dsh update: check
 * for a newer runtime, download the artifact, verify + extract via ensureRuntime,
 * and prepare it as `pending` for the next cold start. It never touches `active`
 * and never interrupts the running Agent; failures are recorded to
 * `lastUpdateError` (never `failed`, which is reserved for cold-start failure).
 */

const path = require('node:path')
const { fetchManifest } = require('./runtime-manifest-client')
const { download } = require('./runtime-downloader')
const {
  ensureRuntime, readRuntimeState, resolveReadyRuntime, preparePending,
  recordLastUpdateError, compareVersions, runtimePaths,
} = require('./runtime-manager')

/**
 * Check whether a newer runtime is available for the current active runtime.
 * Upgrade rule: candidate.runtimeId !== active.runtimeId AND
 * candidate.dshVersion >= active.dshVersion (same version, different build
 * counts; stable never downgrades). Returns { updateAvailable, manifest, reason }.
 */
async function checkForUpdate(options) {
  const {
    runtimeRoot, platform, arch, currentDshedVersion,
    channel = 'stable', transport, signal, logger,
  } = options

  const manifest = await fetchManifest({ channel, platform, arch, currentDshedVersion, transport, signal, logger })
  const state = readRuntimeState({ runtimeRoot })
  const activeId = state.active && state.active.runtimeId

  if (!activeId) {
    // first install is handled by the bundled-rescue path, not the updater
    return { updateAvailable: false, manifest, reason: 'no-active' }
  }
  if (manifest.runtimeId === activeId) {
    return { updateAvailable: false, manifest, reason: 'same-runtime' }
  }

  let activeVersion
  try {
    activeVersion = resolveReadyRuntime(runtimeRoot, activeId).complete.dshVersion
  } catch (e) {
    return { updateAvailable: false, manifest, reason: 'active-not-ready' }
  }

  if (compareVersions(manifest.dshVersion, activeVersion) < 0) {
    return { updateAvailable: false, manifest, reason: 'older' }
  }
  return { updateAvailable: true, manifest }
}

/**
 * Download the artifact, verify + extract it via ensureRuntime, and prepare it
 * as pending for the next cold start. Returns the pending runtime info.
 */
async function downloadAndPrepare(options) {
  const { manifest, runtimeRoot, transport, signal, logger } = options
  const paths = runtimePaths(runtimeRoot)
  const downloadDir = path.join(paths.downloads, manifest.runtimeId)

  const downloaded = await download({
    url: manifest.artifactUrl,
    destDir: downloadDir,
    fileName: manifest.archive,
    expectedSize: manifest.size,
    expectedSha256: manifest.sha256,
    transport, signal, logger,
  })

  const installed = await ensureRuntime({
    runtimeRoot, manifest, archivePath: downloaded.filePath,
    platform: manifest.platform, arch: manifest.arch, logger,
  })

  return preparePending({ runtimeRoot, runtimeId: installed.runtimeId, logger })
}

/** classify a delivery failure stage for lastUpdateError */
function classifyError(err) {
  const m = err && err.message ? err.message : ''
  if (/sha256 mismatch|size mismatch|exceeds expected size/i.test(m)) return 'verify'
  if (/extract|entry not found|path escapes|file count|terminator|checksum|escape/i.test(m)) return 'extract'
  if (/manifest|schema|releaseTag|artifact|channel|older than required|not valid JSON|HTTP \d+/i.test(m)) return 'manifest'
  return 'download'
}

/**
 * Run one background update pass: check → download → verify → extract → pending.
 * Never throws; returns { updated, runtimeId?, reason? }. On any failure records
 * `lastUpdateError` and leaves `active` (and the running Agent) untouched.
 */
async function runBackgroundUpdate(options) {
  const {
    runtimeRoot, platform, arch, currentDshedVersion,
    channel = 'stable', transport, downloadTransport, signal, logger,
  } = options
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }
  const dlTransport = downloadTransport || transport

  let check
  try {
    check = await checkForUpdate({ runtimeRoot, platform, arch, currentDshedVersion, channel, transport, signal, logger })
  } catch (err) {
    recordLastUpdateError({ runtimeRoot, stage: 'manifest', message: err.message, logger })
    log.error(`[updater] manifest check failed: ${err.message}`)
    return { updated: false, reason: err.message }
  }

  if (!check.updateAvailable) {
    log.info(`[updater] no update available (${check.reason})`)
    return { updated: false, reason: check.reason }
  }

  try {
    const pending = await downloadAndPrepare({ manifest: check.manifest, runtimeRoot, transport: dlTransport, signal, logger })
    log.info(`[updater] prepared pending runtime ${pending.runtimeId} for next launch`)
    return { updated: true, runtimeId: pending.runtimeId }
  } catch (err) {
    const stage = classifyError(err)
    recordLastUpdateError({ runtimeRoot, stage, message: err.message, logger })
    log.error(`[updater] background update failed (${stage}): ${err.message}`)
    return { updated: false, reason: err.message }
  }
}

module.exports = { checkForUpdate, downloadAndPrepare, runBackgroundUpdate, classifyError }
