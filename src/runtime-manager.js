'use strict'

/**
 * runtime-manager — manages dsh runtime *installation state* only (validate,
 * lock, stage, atomically activate, rollback, purge). It does NOT manage the
 * dsh subprocess lifecycle — that is EngineManager's job.
 *
 * Layout under runtimeRoot (userData/dsh-runtimes):
 *   runtimes/<runtime-id>/   installed runtimes (complete.json marks readiness)
 *   staging/                 in-progress extraction
 *   downloads/               cached archives (used by the delivery layer later)
 *   active.json              currently active runtime
 *   previous.json            last known-good runtime (rollback target)
 *   pending.json             runtime being activated (pending health check)
 *   install.lock             cross-process install lock
 *
 * All JSON state files are written via temp-file + atomic rename. The active
 * runtime is never overwritten in place — a new runtime is staged then renamed
 * into its own versioned directory.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { unpackArchive, assertSafeLink } = require('./tar-util')

const LOCK_FILE = 'install.lock'
const ACTIVE_FILE = 'active.json'
const PREVIOUS_FILE = 'previous.json'
const PENDING_FILE = 'pending.json'
const COMPLETE_FILE = 'complete.json'

// ————————————————————————————————— util ————————————————————————————————————

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

/** reject absolute paths, `..` segments, backslashes and NUL — a safe relative path */
function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.indexOf('\0') !== -1) return false
  if (p.indexOf('\\') !== -1) return false
  if (path.isAbsolute(p)) return false
  const parts = p.split('/')
  for (const seg of parts) if (seg === '..' || seg === '') return false
  return true
}

/** minimal semver comparison (major.minor.patch with optional prerelease) */
function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1 // release > prerelease
  if (pb.pre === '') return -1
  return pa.pre < pb.pre ? -1 : 1
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, filePath)
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // exists but no permission to signal
  }
}

// ————————————————————————————————— lock —————————————————————————————————————

/**
 * Cross-process lock via O_EXCL file creation. Distinguishes:
 *  - an active lock (owner pid still alive) → wait/retry until timeout
 *  - a stale lock (owner pid gone) → remove and retry
 * Two processes installing the same runtime race on the same lock file.
 */
async function acquireLock(lockPath, { timeoutMs = 30000, pollMs = 100, logger } = {}) {
  const deadline = Date.now() + timeoutMs
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const owner = { pid: process.pid, hostname: require('node:os').hostname(), createdAt: new Date().toISOString() }

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, JSON.stringify(owner))
      fs.closeSync(fd)
      return () => {
        try {
          const cur = readJson(lockPath)
          if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath)
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const cur = readJson(lockPath)
      if (cur && cur.pid && !isAlive(cur.pid)) {
        log.warn(`[runtime] removing stale lock (pid ${cur.pid} gone)`)
        try { fs.unlinkSync(lockPath) } catch (e2) { /* raced, retry below */ }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`install lock timeout: another process (pid ${cur && cur.pid}) holds ${lockPath}`)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
}

// ————————————————————————————————— manifest —————————————————————————————————

/**
 * Validate a runtime manifest against the current platform/arch (and, when
 * provided, the running dshed version). Returns { valid, errors } rather than
 * throwing so callers can aggregate all problems.
 */
function validateManifest(manifest, context = {}) {
  const errors = []
  const add = (m) => errors.push(m)
  const { platform, arch, currentDshedVersion } = context

  if (!isObject(manifest)) return { valid: false, errors: ['manifest must be an object'] }

  if (manifest.schemaVersion !== 1) add(`schemaVersion must be 1 (got ${manifest.schemaVersion})`)

  for (const f of ['runtimeId', 'dshVersion', 'buildId', 'archive', 'sha256', 'entry', 'minimumDshedVersion', 'releasedAt']) {
    if (typeof manifest[f] !== 'string' || manifest[f].length === 0) add(`missing or empty string field: ${f}`)
  }
  for (const f of ['size', 'extractedSize', 'extractedFileCount']) {
    if (typeof manifest[f] !== 'number' || !Number.isFinite(manifest[f]) || manifest[f] < 0) add(`field ${f} must be a non-negative number`)
  }

  if (typeof manifest.runtimeId === 'string' && typeof manifest.buildId === 'string') {
    if (!manifest.runtimeId.includes(manifest.buildId)) add('runtimeId must contain buildId')
  }

  if (platform && manifest.platform !== platform) add(`platform mismatch: manifest=${manifest.platform} host=${platform}`)
  if (arch && manifest.arch !== arch) add(`arch mismatch: manifest=${manifest.arch} host=${arch}`)

  if (typeof manifest.sha256 === 'string' && !/^[0-9a-f]{64}$/.test(manifest.sha256)) add('sha256 must be 64 lowercase hex chars')

  if (typeof manifest.entry === 'string' && !isSafeRelativePath(manifest.entry)) add(`entry is not a safe relative path: ${manifest.entry}`)
  if (typeof manifest.archive === 'string' && !isSafeRelativePath(manifest.archive)) add(`archive is not a safe relative path: ${manifest.archive}`)

  if (currentDshedVersion && typeof manifest.minimumDshedVersion === 'string') {
    if (compareVersions(currentDshedVersion, manifest.minimumDshedVersion) < 0) {
      add(`dshed ${currentDshedVersion} is older than required ${manifest.minimumDshedVersion}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ————————————————————————————————— paths ————————————————————————————————————

function runtimePaths(runtimeRoot) {
  return {
    root: runtimeRoot,
    runtimes: path.join(runtimeRoot, 'runtimes'),
    staging: path.join(runtimeRoot, 'staging'),
    downloads: path.join(runtimeRoot, 'downloads'),
    active: path.join(runtimeRoot, ACTIVE_FILE),
    previous: path.join(runtimeRoot, PREVIOUS_FILE),
    pending: path.join(runtimeRoot, PENDING_FILE),
    lock: path.join(runtimeRoot, LOCK_FILE),
  }
}

function isReadyRuntime(runtimeDir) {
  return isObject(readJson(path.join(runtimeDir, COMPLETE_FILE)))
}

// ————————————————————————————————— ensure ————————————————————————————————————

/**
 * Install a runtime from a local archive. Returns { runtimeId, runtimeDir }.
 * Idempotent: an already-ready runtime is returned without re-extraction.
 * On any failure the staging dir is left clean and no ready runtime appears.
 */
async function ensureRuntime(options) {
  const { runtimeRoot, manifest, archivePath, platform, arch, logger } = options
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }
  const paths = runtimePaths(runtimeRoot)

  const check = validateManifest(manifest, { platform, arch })
  if (!check.valid) throw new Error(`invalid manifest: ${check.errors.join('; ')}`)

  const runtimeDir = path.join(paths.runtimes, manifest.runtimeId)
  if (isReadyRuntime(runtimeDir)) {
    log.info(`[runtime] ${manifest.runtimeId} already ready, skipping install`)
    return { runtimeId: manifest.runtimeId, runtimeDir }
  }

  if (!fs.existsSync(archivePath)) throw new Error(`archive not found: ${archivePath}`)

  const stat = fs.statSync(archivePath)
  if (manifest.size && stat.size !== manifest.size) {
    throw new Error(`archive size mismatch: expected ${manifest.size}, got ${stat.size}`)
  }

  const digest = await sha256File(archivePath)
  if (digest !== manifest.sha256) {
    throw new Error(`archive sha256 mismatch: expected ${manifest.sha256}, got ${digest}`)
  }

  const release = await acquireLock(paths.lock, { logger: log })
  try {
    const stagingDir = path.join(paths.staging, manifest.runtimeId)
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.mkdirSync(stagingDir, { recursive: true })

    try {
      const stats = await unpackArchive(archivePath, stagingDir)

      if (manifest.extractedFileCount && stats.fileCount !== manifest.extractedFileCount) {
        throw new Error(`extracted file count mismatch: expected ${manifest.extractedFileCount}, got ${stats.fileCount}`)
      }
      if (manifest.extractedSize && stats.extractedSize !== manifest.extractedSize) {
        throw new Error(`extracted size mismatch: expected ${manifest.extractedSize}, got ${stats.extractedSize}`)
      }

      const entryAbs = path.resolve(stagingDir, manifest.entry)
      if (!fs.existsSync(entryAbs)) throw new Error(`entry not found after extraction: ${manifest.entry}`)

      // complete.json is written last — its presence marks a ready runtime
      atomicWriteJson(path.join(stagingDir, COMPLETE_FILE), {
        formatVersion: 1,
        runtimeId: manifest.runtimeId,
        dshVersion: manifest.dshVersion,
        buildId: manifest.buildId,
        platform: manifest.platform,
        arch: manifest.arch,
        sha256: manifest.sha256,
        entry: manifest.entry,
        healthy: false,
        createdAt: new Date().toISOString(),
      })

      fs.mkdirSync(paths.runtimes, { recursive: true })
      fs.renameSync(stagingDir, runtimeDir)
      log.info(`[runtime] installed ${manifest.runtimeId} → ${runtimeDir}`)
      return { runtimeId: manifest.runtimeId, runtimeDir }
    } catch (e) {
      fs.rmSync(stagingDir, { recursive: true, force: true })
      throw e
    }
  } finally {
    release()
  }
}

// ————————————————————————————————— active/activate/rollback ——————————————————

function readState(paths) {
  return {
    active: readJson(paths.active),
    previous: readJson(paths.previous),
    pending: readJson(paths.pending),
  }
}

/**
 * Resolve the current active runtime. Cleans up a stale pending marker (an
 * interrupted activation must not block startup) and returns the runtime dir
 * plus manifest, or null when nothing is installed yet.
 */
function getActiveRuntime(options) {
  const { runtimeRoot, logger } = options
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readState(paths)

  if (state.pending) {
    log.warn(`[runtime] clearing stale pending runtime ${state.pending.runtimeId}`)
    try { fs.unlinkSync(paths.pending) } catch (e) { /* ignore */ }
  }

  if (state.active && state.active.runtimeId) {
    const dir = path.join(paths.runtimes, state.active.runtimeId)
    if (isReadyRuntime(dir)) {
      const complete = readJson(path.join(dir, COMPLETE_FILE))
      return { runtimeId: state.active.runtimeId, runtimeDir: dir, manifest: state.active, entry: complete && complete.entry }
    }
    log.warn(`[runtime] active runtime ${state.active.runtimeId} is not ready`)
  }
  return null
}

/**
 * Mark a ready runtime as the pending activation target (atomic). Returns the
 * runtime dir + entry so the caller can start it and health-check it.
 */
function activateRuntime(options) {
  const { runtimeRoot, runtimeId, logger } = options
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const runtimeDir = path.join(paths.runtimes, runtimeId)
  if (!isReadyRuntime(runtimeDir)) throw new Error(`runtime not ready: ${runtimeId}`)

  atomicWriteJson(paths.pending, { runtimeId, pendingAt: new Date().toISOString() })
  const complete = readJson(path.join(runtimeDir, COMPLETE_FILE))
  log.info(`[runtime] pending activation: ${runtimeId}`)
  return { runtimeId, runtimeDir, entry: complete && complete.entry }
}

/**
 * Called after a pending runtime passes its health check: promote it to active
 * and preserve the previous active as the rollback target. Atomic.
 */
function markRuntimeHealthy(options) {
  const { runtimeRoot, runtimeId, logger } = options
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readState(paths)

  const runtimeDir = path.join(paths.runtimes, runtimeId)
  const completePath = path.join(runtimeDir, COMPLETE_FILE)
  if (isReadyRuntime(runtimeDir)) {
    const complete = readJson(completePath) || {}
    atomicWriteJson(completePath, { ...complete, healthy: true })
  }

  if (state.active && state.active.runtimeId && state.active.runtimeId !== runtimeId) {
    atomicWriteJson(paths.previous, state.active)
  }
  atomicWriteJson(paths.active, { runtimeId, activatedAt: new Date().toISOString() })
  try { fs.unlinkSync(paths.pending) } catch (e) { /* ignore */ }
  log.info(`[runtime] activated ${runtimeId}`)
  return { runtimeId, runtimeDir }
}

/**
 * Roll back to the previous (last known-good) runtime after a pending runtime
 * fails to start. Returns the previous runtime's info, or null when there is
 * no previous runtime to fall back to.
 */
function rollbackRuntime(options) {
  const { runtimeRoot, logger } = options
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readState(paths)

  if (state.previous && state.previous.runtimeId) {
    atomicWriteJson(paths.active, state.previous)
    try { fs.unlinkSync(paths.previous) } catch (e) { /* ignore */ }
    try { fs.unlinkSync(paths.pending) } catch (e) { /* ignore */ }
    const dir = path.join(paths.runtimes, state.previous.runtimeId)
    const complete = readJson(path.join(dir, COMPLETE_FILE))
    log.warn(`[runtime] rolled back to ${state.previous.runtimeId}`)
    return { runtimeId: state.previous.runtimeId, runtimeDir: dir, entry: complete && complete.entry }
  }

  // no previous: drop pending and fall back to whatever active remains
  try { fs.unlinkSync(paths.pending) } catch (e) { /* ignore */ }
  if (state.active && state.active.runtimeId) {
    const dir = path.join(paths.runtimes, state.active.runtimeId)
    if (isReadyRuntime(dir)) {
      const complete = readJson(path.join(dir, COMPLETE_FILE))
      return { runtimeId: state.active.runtimeId, runtimeDir: dir, entry: complete && complete.entry }
    }
  }
  return null
}

// ————————————————————————————————— purge ————————————————————————————————————

/**
 * Purge install caches only: downloads, staging and non-active runtimes. The
 * active runtime and user data (sessions/settings/credentials/logs, which live
 * outside dsh-runtimes) are never touched.
 */
function purgeRuntimeCache(options) {
  const { runtimeRoot, logger } = options
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readState(paths)

  const keep = new Set()
  if (state.active && state.active.runtimeId) keep.add(state.active.runtimeId)
  if (state.previous && state.previous.runtimeId) keep.add(state.previous.runtimeId)

  fs.rmSync(paths.downloads, { recursive: true, force: true })
  fs.rmSync(paths.staging, { recursive: true, force: true })

  if (fs.existsSync(paths.runtimes)) {
    for (const name of fs.readdirSync(paths.runtimes)) {
      if (!keep.has(name)) {
        log.info(`[runtime] purging runtime ${name}`)
        fs.rmSync(path.join(paths.runtimes, name), { recursive: true, force: true })
      }
    }
  }

  return { kept: [...keep] }
}

module.exports = {
  validateManifest,
  ensureRuntime,
  getActiveRuntime,
  activateRuntime,
  markRuntimeHealthy,
  rollbackRuntime,
  purgeRuntimeCache,
  acquireLock,
  compareVersions,
  isSafeRelativePath,
  runtimePaths,
}
