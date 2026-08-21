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
 *   runtime-state.json       single versioned state file (active/previous/
 *                            pending/failed/lastUpdateError/channel/pinned)
 *   install.lock             cross-process install lock
 *
 * All JSON state files are written via temp-file + fsync + atomic rename. The
 * active runtime is never overwritten in place — a new runtime is staged then
 * renamed into its own versioned directory. `active` changes only through
 * commitActivation/commitRollback, both after a successful health check.
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
const STATE_FILE = 'runtime-state.json'
const STATE_SCHEMA_VERSION = 2

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

// a single, safe directory-name component: no separators, no traversal, no NUL
const SAFE_DIRNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** validate a runtimeId / buildId is a safe single directory-name component */
function isSafeDirName(name) {
  return typeof name === 'string' && SAFE_DIRNAME_RE.test(name)
}

const VALID_PLATFORMS = ['darwin', 'win32', 'linux']
const VALID_ARCHS = ['x64', 'arm64']

/** minimal semver comparison (major.minor.patch with optional prerelease) */
function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}

/** SemVer prerelease comparison: dot-separated identifiers, numeric vs numeric, numeric < alphanumeric */
function comparePrerelease(a, b) {
  if (a === b) return 0
  if (a === '') return 1 // release > prerelease
  if (b === '') return -1
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const nx = parseInt(x, 10)
      const ny = parseInt(y, 10)
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort before alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  return comparePrerelease(pa.pre, pb.pre)
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
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
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
  const owner = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    hostname: require('node:os').hostname(),
    createdAt: new Date().toISOString(),
  }

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, JSON.stringify(owner))
      fs.closeSync(fd)
      return () => {
        try {
          const cur = readJson(lockPath)
          // release only our own lock: match pid AND token so a reused pid that
          // happens to equal ours (or a foreign owner) can never be unlinked
          if (cur && cur.pid === process.pid && cur.token === owner.token) fs.unlinkSync(lockPath)
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const cur = readJson(lockPath)
      // stale only when the recorded pid no longer exists; EPERM means it exists
      // but we cannot signal it, so treat as alive (conservative). The token is
      // what makes release safe under pid reuse.
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

  if (typeof manifest.runtimeId === 'string' && !isSafeDirName(manifest.runtimeId)) {
    add(`runtimeId is not a safe directory name: ${manifest.runtimeId}`)
  }
  if (typeof manifest.buildId === 'string' && !isSafeDirName(manifest.buildId)) {
    add(`buildId is not a safe identifier: ${manifest.buildId}`)
  }
  if (typeof manifest.platform === 'string' && !VALID_PLATFORMS.includes(manifest.platform)) {
    add(`invalid platform: ${manifest.platform}`)
  }
  if (typeof manifest.arch === 'string' && !VALID_ARCHS.includes(manifest.arch)) {
    add(`invalid arch: ${manifest.arch}`)
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
    state: path.join(runtimeRoot, STATE_FILE),
    active: path.join(runtimeRoot, ACTIVE_FILE),
    previous: path.join(runtimeRoot, PREVIOUS_FILE),
    pending: path.join(runtimeRoot, PENDING_FILE),
    lock: path.join(runtimeRoot, LOCK_FILE),
  }
}

/** defensive guard: assert `child` resolves inside `parent` (blocks traversal) */
function assertInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c !== p && !c.startsWith(p + path.sep)) {
    throw new Error(`path escapes root: ${child} is outside ${parent}`)
  }
}

/**
 * Read and validate complete.json. Returns the parsed object, or null when
 * missing/corrupt/old-format. A runtime is only "ready" when its identity
 * fields are all present and well-formed.
 */
function readComplete(runtimeDir) {
  const complete = readJson(path.join(runtimeDir, COMPLETE_FILE))
  if (!isObject(complete)) return null
  if (complete.formatVersion !== 1) return null
  if (typeof complete.runtimeId !== 'string' || !isSafeDirName(complete.runtimeId)) return null
  if (typeof complete.buildId !== 'string' || !isSafeDirName(complete.buildId)) return null
  if (typeof complete.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(complete.sha256)) return null
  if (typeof complete.entry !== 'string' || !isSafeRelativePath(complete.entry)) return null
  if (complete.healthy !== undefined && typeof complete.healthy !== 'boolean') return null
  return complete
}

/** true when a complete.json identity matches the manifest being installed */
function completeMatches(complete, manifest) {
  return complete
    && complete.runtimeId === manifest.runtimeId
    && complete.buildId === manifest.buildId
    && complete.sha256 === manifest.sha256
}

/**
 * Resolve a runtime by id into { runtimeId, runtimeDir, complete }, enforcing a
 * safe dirname, root containment and readiness. Throws on any violation — this
 * is the single entry point all state APIs use so a malicious/invalid runtimeId
 * can never escape dsh-runtimes/runtimes/.
 */
function resolveReadyRuntime(runtimeRoot, runtimeId) {
  if (typeof runtimeId !== 'string' || !isSafeDirName(runtimeId)) {
    throw new Error(`invalid runtimeId: ${String(runtimeId)}`)
  }
  const paths = runtimePaths(runtimeRoot)
  const runtimeDir = path.join(paths.runtimes, runtimeId)
  assertInside(paths.runtimes, runtimeDir)
  const complete = readComplete(runtimeDir)
  if (!complete) throw new Error(`runtime not ready: ${runtimeId}`)
  return { runtimeId, runtimeDir, complete, entry: complete.entry }
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
  assertInside(paths.runtimes, runtimeDir)

  // fast path (no lock): already installed with a matching identity
  if (completeMatches(readComplete(runtimeDir), manifest)) {
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
    // re-check under the lock: another process may have installed while we
    // waited on it. Return if the identity now matches; refuse to overwrite a
    // mismatched (corrupt/conflicting) runtime.
    const existing = readComplete(runtimeDir)
    if (completeMatches(existing, manifest)) {
      log.info(`[runtime] ${manifest.runtimeId} installed by another process, skipping`)
      return { runtimeId: manifest.runtimeId, runtimeDir }
    }
    if (existing) {
      throw new Error(`runtime ${manifest.runtimeId} exists with mismatched identity (buildId=${existing.buildId}, sha256=${existing.sha256})`)
    }

    // runtimeDir exists but complete.json is invalid (corrupt/old-format):
    // atomically isolate it so the reinstall can rename a fresh directory into
    // place. The .failed-* dir is removed on success and left for diagnosis on
    // failure (it is also cleaned up by purge).
    let failedDir = null
    if (fs.existsSync(runtimeDir)) {
      failedDir = `${runtimeDir}.failed-${process.pid}-${Date.now()}`
      assertInside(paths.runtimes, failedDir)
      fs.renameSync(runtimeDir, failedDir)
      log.warn(`[runtime] isolating corrupt runtime ${manifest.runtimeId} → ${failedDir}`)
    }

    const stagingDir = path.join(paths.staging, manifest.runtimeId)
    assertInside(paths.staging, stagingDir)
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
        ...(typeof manifest.minimumDshedVersion === 'string' ? { minimumDshedVersion: manifest.minimumDshedVersion } : {}),
        ...(typeof manifest.releaseTag === 'string' ? { releaseTag: manifest.releaseTag } : {}),
        ...(typeof manifest.channel === 'string' ? { channel: manifest.channel } : {}),
        createdAt: new Date().toISOString(),
      })

      fs.mkdirSync(paths.runtimes, { recursive: true })
      fs.renameSync(stagingDir, runtimeDir)
      if (failedDir) fs.rmSync(failedDir, { recursive: true, force: true })
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

function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    active: null,
    previous: null,
    pending: null,
    failed: null,
    lastUpdateError: null,
    channel: 'stable',
    pinned: null,
    updatedAt: null,
  }
}

/** normalize a parsed runtime-state.json into a well-formed state object */
function normalizeState(raw) {
  const s = defaultState()
  if (!isObject(raw)) return s
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) return s
  for (const key of ['active', 'previous']) {
    if (isObject(raw[key]) && typeof raw[key].runtimeId === 'string' && raw[key].runtimeId.length > 0) {
      s[key] = { runtimeId: raw[key].runtimeId, activatedAt: raw[key].activatedAt || null }
    }
  }
  if (isObject(raw.pending) && typeof raw.pending.runtimeId === 'string' && raw.pending.runtimeId.length > 0) {
    s.pending = {
      runtimeId: raw.pending.runtimeId,
      attemptCount: typeof raw.pending.attemptCount === 'number' ? raw.pending.attemptCount : 0,
      lastAttemptAt: raw.pending.lastAttemptAt || null,
      failureReason: raw.pending.failureReason || null,
    }
  }
  if (isObject(raw.failed) && typeof raw.failed.runtimeId === 'string' && raw.failed.runtimeId.length > 0) {
    s.failed = { runtimeId: raw.failed.runtimeId, failureReason: raw.failed.failureReason || null, failedAt: raw.failed.failedAt || null }
  }
  if (isObject(raw.lastUpdateError)) {
    s.lastUpdateError = { stage: raw.lastUpdateError.stage || null, message: raw.lastUpdateError.message || null, at: raw.lastUpdateError.at || null }
  }
  if (['stable', 'manual', 'preview', 'pinned'].includes(raw.channel)) s.channel = raw.channel
  if (isObject(raw.pinned) && typeof raw.pinned.runtimeId === 'string') s.pinned = { runtimeId: raw.pinned.runtimeId }
  s.updatedAt = raw.updatedAt || null
  return s
}

/** write the state file atomically, stamping updatedAt */
function writeState(paths, state) {
  state.updatedAt = new Date().toISOString()
  atomicWriteJson(paths.state, state)
}

/**
 * Read the current runtime state. Pure read — no migration, no pending cleanup,
 * no side effects. Returns a fully-normalized state object (defaults filled).
 */
function readRuntimeState({ runtimeRoot } = {}) {
  const paths = runtimePaths(runtimeRoot)
  return normalizeState(readJson(paths.state))
}

/**
 * One-time migration from Plan 1's three files (active/previous/pending.json)
 * into the single runtime-state.json. Writes the new file first, then removes
 * the old files only after a successful fsync + rename. On any failure the old
 * files and all runtime dirs are preserved.
 */
function migrateLegacyState({ runtimeRoot, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  if (fs.existsSync(paths.state)) return false

  const hasLegacy = fs.existsSync(paths.active) || fs.existsSync(paths.previous) || fs.existsSync(paths.pending)
  if (!hasLegacy) return false

  const state = defaultState()
  const active = readJson(paths.active)
  const previous = readJson(paths.previous)
  const pending = readJson(paths.pending)
  if (isObject(active) && typeof active.runtimeId === 'string' && active.runtimeId.length > 0) {
    state.active = { runtimeId: active.runtimeId, activatedAt: active.activatedAt || null }
  }
  if (isObject(previous) && typeof previous.runtimeId === 'string' && previous.runtimeId.length > 0) {
    state.previous = { runtimeId: previous.runtimeId, activatedAt: previous.activatedAt || null }
  }
  if (isObject(pending) && typeof pending.runtimeId === 'string' && pending.runtimeId.length > 0) {
    state.pending = { runtimeId: pending.runtimeId, attemptCount: 0, lastAttemptAt: null, failureReason: null }
  }

  // write new first, then delete old — never destroy the recovery source
  atomicWriteJson(paths.state, state)
  for (const p of [paths.active, paths.previous, paths.pending]) {
    try { fs.unlinkSync(p) } catch (e) { /* ignore */ }
  }
  log.info('[runtime] migrated legacy state files → runtime-state.json')
  return true
}

/**
 * Idempotent recovery of interrupted transitions, run early at startup. Only
 * normalizes; does not make a startup decision. A pending pointing at a missing
 * or non-ready runtime dir is moved into `failed`.
 */
function recoverInterruptedTransition({ runtimeRoot, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readRuntimeState({ runtimeRoot })

  if (state.pending && state.pending.runtimeId) {
    let ready = false
    try { resolveReadyRuntime(runtimeRoot, state.pending.runtimeId); ready = true } catch (e) { /* not ready */ }
    if (!ready) {
      const runtimeId = state.pending.runtimeId
      state.failed = { runtimeId, failureReason: 'pending runtime dir missing or not ready', failedAt: new Date().toISOString() }
      state.pending = null
      writeState(paths, state)
      log.warn(`[runtime] pending runtime ${runtimeId} missing/not ready → failed`)
    }
  }
  return state
}

/**
 * Return ready startup candidates by role: pending (first), then active, then
 * previous. Read-only; a non-ready runtime is reported as null.
 */
function selectStartupCandidate({ runtimeRoot } = {}) {
  const state = readRuntimeState({ runtimeRoot })
  const ready = (runtimeId) => {
    if (!runtimeId) return null
    try { resolveReadyRuntime(runtimeRoot, runtimeId); return runtimeId } catch (e) { return null }
  }
  return {
    pending: ready(state.pending && state.pending.runtimeId),
    active: ready(state.active && state.active.runtimeId),
    previous: ready(state.previous && state.previous.runtimeId),
  }
}

/**
 * Mark a ready runtime as the pending activation target (atomic). Increments
 * attemptCount when re-attempting the same runtime. Does not touch active.
 */
function beginActivation({ runtimeRoot, runtimeId, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const rt = resolveReadyRuntime(runtimeRoot, runtimeId)
  const state = readRuntimeState({ runtimeRoot })

  const prevAttempt = (state.pending && state.pending.runtimeId === runtimeId) ? state.pending.attemptCount : 0
  state.pending = { runtimeId, attemptCount: prevAttempt + 1, lastAttemptAt: new Date().toISOString(), failureReason: null }
  writeState(paths, state)
  log.info(`[runtime] pending activation: ${runtimeId} (attempt ${state.pending.attemptCount})`)
  return { runtimeId, runtimeDir: rt.runtimeDir, entry: rt.complete.entry }
}

/**
 * Promote a pending runtime to active after a successful health check. Moves
 * the previous active to `previous`. Requires a matching pending marker; this
 * is the only way (besides commitRollback) that `active` changes.
 */
function commitActivation({ runtimeRoot, runtimeId, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const rt = resolveReadyRuntime(runtimeRoot, runtimeId)
  const state = readRuntimeState({ runtimeRoot })

  if (!state.pending || state.pending.runtimeId !== runtimeId) {
    throw new Error(`runtime ${runtimeId} is not pending activation`)
  }
  const entryAbs = path.resolve(rt.runtimeDir, rt.complete.entry)
  assertInside(rt.runtimeDir, entryAbs)
  if (!fs.existsSync(entryAbs)) throw new Error(`runtime entry not found: ${rt.complete.entry}`)

  atomicWriteJson(path.join(rt.runtimeDir, COMPLETE_FILE), { ...rt.complete, healthy: true })

  if (state.active && state.active.runtimeId && state.active.runtimeId !== runtimeId) {
    state.previous = state.active
  }
  state.active = { runtimeId, activatedAt: new Date().toISOString() }
  state.pending = null
  writeState(paths, state)
  log.info(`[runtime] activated ${runtimeId}`)
  return { runtimeId, runtimeDir: rt.runtimeDir }
}

/**
 * Move a failed pending runtime into `failed`. Only `pending` is cleared; the
 * current active is left untouched. `failed` is reserved for startup failure —
 * download/verify/extract failures never land here.
 */
function failActivation({ runtimeRoot, runtimeId, reason, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readRuntimeState({ runtimeRoot })

  state.failed = { runtimeId, failureReason: reason || null, failedAt: new Date().toISOString() }
  if (state.pending && state.pending.runtimeId === runtimeId) state.pending = null
  writeState(paths, state)
  log.warn(`[runtime] activation failed: ${runtimeId} (${reason || 'unknown'})`)
  return state.failed
}

/**
 * Promote `previous` back to `active` after it passed a health check. Requires
 * a matching previous marker; only runs post-health-check so a failed previous
 * leaves the current active pointer unchanged.
 */
function commitRollback({ runtimeRoot, runtimeId, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const rt = resolveReadyRuntime(runtimeRoot, runtimeId)
  const state = readRuntimeState({ runtimeRoot })

  if (!state.previous || state.previous.runtimeId !== runtimeId) {
    throw new Error(`runtime ${runtimeId} is not previous`)
  }
  state.active = { runtimeId, activatedAt: new Date().toISOString() }
  state.previous = null
  state.pending = null
  writeState(paths, state)
  log.warn(`[runtime] rolled back to ${runtimeId}`)
  return { runtimeId, runtimeDir: rt.runtimeDir }
}

/**
 * Re-queue a failed runtime as pending (attemptCount reset to 0) for a manual
 * retry.
 */
function retryFailedRuntime({ runtimeRoot, runtimeId, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const rt = resolveReadyRuntime(runtimeRoot, runtimeId)
  const state = readRuntimeState({ runtimeRoot })

  state.pending = { runtimeId, attemptCount: 0, lastAttemptAt: null, failureReason: null }
  state.failed = null
  writeState(paths, state)
  log.info(`[runtime] re-queued failed runtime ${runtimeId} for retry`)
  return { runtimeId, runtimeDir: rt.runtimeDir, entry: rt.complete.entry }
}

/**
 * Mark a ready runtime as the pending cold-start candidate without counting an
 * attempt (attemptCount stays 0). Used by the background update coordinator to
 * prepare a runtime for next launch; beginActivation is what actually counts an
 * attempt at startup. Does not touch active.
 */
function preparePending({ runtimeRoot, runtimeId, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const rt = resolveReadyRuntime(runtimeRoot, runtimeId)
  const state = readRuntimeState({ runtimeRoot })

  state.pending = { runtimeId, attemptCount: 0, lastAttemptAt: null, failureReason: null }
  writeState(paths, state)
  log.info(`[runtime] prepared pending runtime ${runtimeId} for next launch`)
  return { runtimeId, runtimeDir: rt.runtimeDir, entry: rt.complete.entry }
}

/**
 * Record the most recent delivery failure (manifest/download/verify/extract).
 * This is distinct from `failed` (which is reserved for a runtime's cold-start
 * failure) and never affects active.
 */
function recordLastUpdateError({ runtimeRoot, stage, message, logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)
  const state = readRuntimeState({ runtimeRoot })
  state.lastUpdateError = { stage: stage || null, message: message || null, at: new Date().toISOString() }
  writeState(paths, state)
  log.warn(`[runtime] update error (${stage}): ${message}`)
  return state.lastUpdateError
}

// ————————————————————————————————— purge ————————————————————————————————————

/**
 * Purge install caches only: downloads, staging and non-active/non-pending
 * runtimes. The active, previous and pending runtimes and all user data
 * (sessions/settings/credentials/logs, which live outside dsh-runtimes) are
 * never touched. Takes the install lock so it never races an in-flight install
 * or a pending activation.
 */
async function purgeRuntimeCache(options) {
  const { runtimeRoot, logger } = options
  const log = logger || { info: () => {}, warn: () => {} }
  const paths = runtimePaths(runtimeRoot)

  const release = await acquireLock(paths.lock, { logger: log })
  try {
    const state = readRuntimeState({ runtimeRoot })

    const keep = new Set()
    if (state.active && state.active.runtimeId) keep.add(state.active.runtimeId)
    if (state.previous && state.previous.runtimeId) keep.add(state.previous.runtimeId)
    if (state.pending && state.pending.runtimeId) keep.add(state.pending.runtimeId)

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
  } finally {
    release()
  }
}

module.exports = {
  validateManifest,
  ensureRuntime,
  purgeRuntimeCache,
  readRuntimeState,
  migrateLegacyState,
  recoverInterruptedTransition,
  selectStartupCandidate,
  beginActivation,
  commitActivation,
  failActivation,
  commitRollback,
  retryFailedRuntime,
  preparePending,
  recordLastUpdateError,
  resolveReadyRuntime,
  acquireLock,
  compareVersions,
  isSafeRelativePath,
  isSafeDirName,
  runtimePaths,
}
