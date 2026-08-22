'use strict'

/**
 * test-runtime-upgrade — real rc.6 → rc.8 upgrade acceptance: install rc.6 as
 * active (real bundled artifact + real engine start), prepare rc.8 as pending
 * (real artifact), cold-start activate it, then exercise a cold-start failure
 * and automatic rollback to rc.6. Uses the real six-state machine + real
 * EngineManager against the real bundled Node.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EngineManager } = require('../src/engine-manager')
const {
  ensureRuntime, readRuntimeState, recoverInterruptedTransition, selectStartupCandidate,
  beginActivation, commitActivation, failActivation, commitRollback, resolveReadyRuntime,
} = require('../src/runtime-manager')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }
const NODE_BIN = path.join(__dirname, '..', 'resources', 'node', 'bin', 'node')

const RC6_MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'dsh-runtimes', 'dsh-runtime-manifest.json'), 'utf8'))
const RC6_ARCHIVE = path.join(__dirname, '..', 'resources', 'dsh-runtimes', RC6_MANIFEST.archive)

const RC8_MANIFEST_PATH = path.join(__dirname, '..', 'dist', 'runtime', 'dsh-0.1.0-rc.8-795383b4ca58-darwin-arm64.tar.gz.manifest.json')
const RC8_MANIFEST = JSON.parse(fs.readFileSync(RC8_MANIFEST_PATH, 'utf8'))
const RC8_ARCHIVE = path.join(__dirname, '..', 'dist', 'runtime', RC8_MANIFEST.archive)

function tmpdir(name) {
  const d = path.join(os.tmpdir(), `dshed-upgrade-${name}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** start + health-check a runtime, then stop. returns { ok, port, error } */
async function tryStart(rt, dshHome) {
  const em = new EngineManager({ nodeBin: NODE_BIN, dshBin: path.join(rt.runtimeDir, rt.entry), dshHome, logger: noopLogger })
  try {
    const port = await em.start()
    await em.stop()
    return { ok: true, port }
  } catch (e) {
    await em.stop().catch(() => {})
    return { ok: false, error: e.message }
  }
}

/** one cold start: pending → active → previous → null (mirrors main.js ordering) */
async function coldStart(runtimeRoot, dshHome) {
  recoverInterruptedTransition({ runtimeRoot, logger: noopLogger })
  const c = selectStartupCandidate({ runtimeRoot })
  if (c.pending) {
    const rt = beginActivation({ runtimeRoot, runtimeId: c.pending, logger: noopLogger })
    const started = await tryStart(rt, dshHome)
    if (started.ok) { commitActivation({ runtimeRoot, runtimeId: c.pending, logger: noopLogger }); return { started: c.pending } }
    failActivation({ runtimeRoot, runtimeId: c.pending, reason: started.error, logger: noopLogger })
  }
  if (c.active) {
    const rt = resolveReadyRuntime(runtimeRoot, c.active)
    const started = await tryStart(rt, dshHome)
    if (started.ok) return { started: c.active }
  }
  if (c.previous) {
    const rt = resolveReadyRuntime(runtimeRoot, c.previous)
    const started = await tryStart(rt, dshHome)
    if (started.ok) { commitRollback({ runtimeRoot, runtimeId: c.previous, logger: noopLogger }); return { started: c.previous } }
  }
  return { started: null }
}

async function main() {
  console.log('=== rc.6 → rc.8 upgrade acceptance (real artifacts) ===')
  console.log(`  rc6: ${RC6_MANIFEST.runtimeId}`)
  console.log(`  rc8: ${RC8_MANIFEST.runtimeId}`)

  // ————————————————— scenario A: successful upgrade —————————————————
  console.log('\n[A] rc.6 active → download+prepare rc.8 → cold-start activate rc.8')
  {
    const root = tmpdir('upgrade')
    const dshHome = tmpdir('home')

    // rc.6 installed + activated (real bundled artifact, real start)
    await ensureRuntime({ runtimeRoot: root, manifest: RC6_MANIFEST, archivePath: RC6_ARCHIVE, platform: RC6_MANIFEST.platform, arch: RC6_MANIFEST.arch })
    beginActivation({ runtimeRoot: root, runtimeId: RC6_MANIFEST.runtimeId })
    const startA = await tryStart(resolveReadyRuntime(root, RC6_MANIFEST.runtimeId), dshHome)
    ok(startA.ok, `rc.6 starts healthy${startA.ok ? ` (port ${startA.port})` : `: ${startA.error}`}`)
    commitActivation({ runtimeRoot: root, runtimeId: RC6_MANIFEST.runtimeId })

    const sA1 = readRuntimeState({ runtimeRoot: root })
    ok(sA1.active.runtimeId === RC6_MANIFEST.runtimeId, 'rc.6 is active')
    ok(sA1.previous === null, 'no previous yet')

    // background prepare rc.8 (install + pending; active stays rc.6)
    await ensureRuntime({ runtimeRoot: root, manifest: RC8_MANIFEST, archivePath: RC8_ARCHIVE, platform: RC6_MANIFEST.platform, arch: RC6_MANIFEST.arch })
    const { preparePending } = require('../src/runtime-manager')
    preparePending({ runtimeRoot: root, runtimeId: RC8_MANIFEST.runtimeId })
    const sA2 = readRuntimeState({ runtimeRoot: root })
    ok(sA2.active.runtimeId === RC6_MANIFEST.runtimeId, 'active still rc.6 after prepare')
    ok(sA2.pending.runtimeId === RC8_MANIFEST.runtimeId && sA2.pending.attemptCount === 0, 'rc.8 pending (attemptCount 0)')

    // cold start activates rc.8; rc.6 becomes previous
    const res = await coldStart(root, dshHome)
    const sA3 = readRuntimeState({ runtimeRoot: root })
    ok(res.started === RC8_MANIFEST.runtimeId, `cold start activated rc.8`)
    ok(sA3.active.runtimeId === RC8_MANIFEST.runtimeId, 'rc.8 is active')
    ok(sA3.previous && sA3.previous.runtimeId === RC6_MANIFEST.runtimeId, 'rc.6 is previous')
    ok(sA3.pending === null, 'pending cleared after activation')
  }

  // ————————————————— scenario B: rc.8 cold-start fails → rollback to rc.6 —————————————————
  console.log('\n[B] rc.8 cold-start failure → auto rollback to rc.6')
  {
    const root = tmpdir('rollback')
    const dshHome = tmpdir('home')

    await ensureRuntime({ runtimeRoot: root, manifest: RC6_MANIFEST, archivePath: RC6_ARCHIVE, platform: RC6_MANIFEST.platform, arch: RC6_MANIFEST.arch })
    beginActivation({ runtimeRoot: root, runtimeId: RC6_MANIFEST.runtimeId })
    const startB = await tryStart(resolveReadyRuntime(root, RC6_MANIFEST.runtimeId), dshHome)
    ok(startB.ok, 'rc.6 starts healthy')
    commitActivation({ runtimeRoot: root, runtimeId: RC6_MANIFEST.runtimeId })

    // install rc.8 but sabotage its entry so the cold start fails immediately
    await ensureRuntime({ runtimeRoot: root, manifest: RC8_MANIFEST, archivePath: RC8_ARCHIVE, platform: RC6_MANIFEST.platform, arch: RC6_MANIFEST.arch })
    const entryAbs = path.join(root, 'runtimes', RC8_MANIFEST.runtimeId, RC8_MANIFEST.entry)
    fs.writeFileSync(entryAbs, 'process.exit(1)\n') // engine start fails immediately

    const { preparePending } = require('../src/runtime-manager')
    preparePending({ runtimeRoot: root, runtimeId: RC8_MANIFEST.runtimeId })

    const res = await coldStart(root, dshHome)
    const sB = readRuntimeState({ runtimeRoot: root })
    ok(res.started === RC6_MANIFEST.runtimeId, `cold start fell back to rc.6 (started ${res.started})`)
    ok(sB.active.runtimeId === RC6_MANIFEST.runtimeId, 'rc.6 is active again after rollback')
    ok(sB.failed && sB.failed.runtimeId === RC8_MANIFEST.runtimeId, 'rc.8 recorded as failed')
    ok(sB.pending === null, 'pending cleared after rollback')
    ok(sB.previous === null, 'previous cleared after rollback')
  }

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('test failed:', e); process.exit(1) })
