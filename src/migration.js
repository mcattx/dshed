'use strict'

/**
 * migration — first-run / upgrade migration.
 *
 * 1) First run: merge an existing ~/.dsh (dsh CLI data) into dshed's
 *    userData/dsh. Runs only when the target is empty (fresh install); copies
 *    missing files only, never overwrites; runs once (marker file).
 * 2) Version tracking: userData/dshed-state.json records the last run version;
 *    onUpgrade fires after an upgrade (currently a no-op hook, extend here when
 *    a future version needs structural migration).
 */

const fs = require('node:fs')
const path = require('node:path')

const LEGACY_NAME = '.dsh'
const MIGRATE_MARKER = '.dshed-migrated'
const STATE_FILE = 'dshed-state.json'

function dirHasContent(dir) {
  try {
    return fs.readdirSync(dir).length > 0
  } catch (e) {
    return false
  }
}

/** Recursively copy files missing from src to dst (never overwrite existing).
 *  Symlinks are recreated; sockets/fifos are skipped. */
function copyMissing(src, dst) {
  for (const name of fs.readdirSync(src)) {
    if (name === MIGRATE_MARKER) continue
    const s = path.join(src, name)
    const d = path.join(dst, name)
    const st = fs.lstatSync(s)
    if (st.isSymbolicLink()) {
      if (!fs.existsSync(d)) fs.symlinkSync(fs.readlinkSync(s), d)
    } else if (st.isDirectory()) {
      if (fs.existsSync(d)) copyMissing(s, d)
      else {
        fs.mkdirSync(d, { recursive: true, mode: st.mode & 0o777 })
        copyMissing(s, d)
      }
    } else if (st.isFile() && !fs.existsSync(d)) {
      fs.copyFileSync(s, d)
      fs.chmodSync(d, st.mode & 0o777)
    }
    // sockets / fifos are skipped (not needed by the engine)
  }
}

/**
 * First-run migration: ~/.dsh → dshHome.
 * @param {object} opts { dshHome, home, logger }
 */
function migrateLegacyDsh({ dshHome, home = process.env.HOME, logger }) {
  const log = logger || { info: () => {}, warn: () => {} }
  const legacy = path.join(home || '', LEGACY_NAME)
  if (!fs.existsSync(legacy)) return
  if (!fs.statSync(legacy).isDirectory()) return

  const marker = path.join(dshHome, MIGRATE_MARKER)
  if (fs.existsSync(marker)) return

  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  if (dirHasContent(dshHome)) {
    fs.writeFileSync(marker, `skipped: ${dshHome} already has data, ${legacy} not merged\n`)
    log.info('[dshed] engine data already exists, skipping ~/.dsh migration')
    return
  }
  copyMissing(legacy, dshHome)
  fs.writeFileSync(marker, `migrated from ${legacy} at ${new Date().toISOString()}\n`)
  log.info(`[dshed] merged legacy dsh data from ${legacy} into ${dshHome}`)
}

/**
 * Brand-rename migration: previous userData (harbor-desktop) → current userData.
 * Copies the engine data dir (dsh) when the new location is empty.
 * @param {object} opts { userData, legacyUserData, logger }
 */
function migrateLegacyUserData({ userData, legacyUserData, logger }) {
  const log = logger || { info: () => {}, warn: () => {} }
  if (!legacyUserData || legacyUserData === userData) return
  if (!fs.existsSync(legacyUserData)) return

  const legacyDsh = path.join(legacyUserData, 'dsh')
  const newDsh = path.join(userData, 'dsh')
  if (!fs.existsSync(legacyDsh)) return
  if (dirHasContent(newDsh)) {
    log.info('[dshed] new engine data already exists, skipping legacy userData migration')
    return
  }
  try {
    fs.mkdirSync(newDsh, { recursive: true, mode: 0o700 })
    copyMissing(legacyDsh, newDsh)
    log.info(`[dshed] migrated engine data from legacy userData ${legacyUserData}`)
  } catch (err) {
    // a failed migration must never block startup
    log.warn(`[dshed] legacy userData migration failed (continuing): ${err.message}`)
    try { fs.rmSync(newDsh, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  }
}

/** Read the state file */
function readState(userData) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, STATE_FILE), 'utf8'))
  } catch (e) {
    return {}
  }
}

/**
 * Version tracking + upgrade hook. Returns { upgraded, prevVersion, version }.
 * Fires onUpgrade on first run / version change (currently a no-op, extend for
 * future structural migrations).
 * @param {object} opts { userData, version, logger, onUpgrade }
 */
function recordVersion({ userData, version, logger, onUpgrade }) {
  const log = logger || { info: () => {} }
  const state = readState(userData)
  const prevVersion = state.version || null
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(
    path.join(userData, STATE_FILE),
    JSON.stringify({ version, prevVersion, lastRun: new Date().toISOString() }, null, 2),
  )
  if (prevVersion && prevVersion !== version && typeof onUpgrade === 'function') {
    log.info(`[dshed] version upgraded ${prevVersion} → ${version}`)
    onUpgrade({ prevVersion, version, userData })
  }
  return { upgraded: !!prevVersion && prevVersion !== version, prevVersion, version }
}

module.exports = { migrateLegacyDsh, migrateLegacyUserData, recordVersion, copyMissing }
