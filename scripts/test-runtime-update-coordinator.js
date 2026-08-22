'use strict'

/**
 * test-runtime-update-coordinator — covers checkForUpdate upgrade rules,
 * downloadAndPrepare (download + extract + pending), and runBackgroundUpdate
 * success/failure paths (lastUpdateError on failure, active never touched).
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { packDirectory } = require('../src/tar-util')
const { httpTransport } = require('../src/runtime-downloader')
const {
  ensureRuntime, readRuntimeState, beginActivation, commitActivation,
} = require('../src/runtime-manager')
const { checkForUpdate, downloadAndPrepare, runBackgroundUpdate, classifyError } = require('../src/runtime-update-coordinator')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshed-cd-test-'))
function tmpdir(name) {
  const d = path.join(tmpRoot, name || `t-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const rtid = (v, b) => `dsh-${v}-${b}-${process.platform}-${process.arch}`

/** build a runtime source tree, pack it, and return { archive, archiveBytes, manifest } */
async function buildArtifactBundle(dshVersion, buildId) {
  const runtimeId = rtid(dshVersion, buildId)
  const src = tmpdir('src')
  const entryPath = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
  const entryAbs = path.join(src, entryPath)
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true })
  fs.writeFileSync(entryAbs, '#!/usr/bin/env node\nconsole.log("dsh")\n')
  const archive = path.join(tmpdir('archive'), `${runtimeId}.tar.gz`)
  const { fileCount, extractedSize } = await packDirectory(src, archive)
  const archiveBytes = fs.readFileSync(archive)
  return {
    archive,
    archiveBytes,
    manifest: {
      schemaVersion: 1,
      runtimeId,
      dshVersion,
      buildId,
      platform: process.platform,
      arch: process.arch,
      archive: `${runtimeId}.tar.gz`,
      sha256: sha256(archiveBytes),
      size: archiveBytes.length,
      extractedSize,
      extractedFileCount: fileCount,
      entry: entryPath,
      minimumDshedVersion: '0.1.0',
      releasedAt: '2026-08-22T00:00:00.000Z',
      releaseTag: `dsh-v${dshVersion}-${buildId}`,
      channel: 'stable',
    },
  }
}

/** build the matrix manifest (schemaVersion 2) for a candidate bundle */
function makeMatrix(bundle) {
  const m = bundle.manifest
  return {
    schemaVersion: 2,
    latest: {
      dshVersion: m.dshVersion,
      minimumDshedVersion: m.minimumDshedVersion,
      releasedAt: m.releasedAt,
      artifacts: [{
        platform: m.platform, arch: m.arch, runtimeId: m.runtimeId, buildId: m.buildId,
        releaseTag: m.releaseTag,
        archive: m.archive, sha256: m.sha256, size: m.size,
        extractedSize: m.extractedSize, extractedFileCount: m.extractedFileCount, entry: m.entry,
      }],
    },
  }
}

const { Readable } = require('node:stream')
function makeMatrixTransport(matrix) {
  return { request: async () => ({ statusCode: 200, headers: {}, stream: Readable.from([Buffer.from(JSON.stringify(matrix))]) }) }
}
function makeArtifactTransport(archiveBytes) {
  return { request: async () => ({ statusCode: 200, headers: { 'content-length': String(archiveBytes.length) }, stream: Readable.from([archiveBytes]) }) }
}

async function makeActive(root, bundle) {
  await ensureRuntime({ runtimeRoot: root, manifest: bundle.manifest, archivePath: bundle.archive, platform: process.platform, arch: process.arch })
  beginActivation({ runtimeRoot: root, runtimeId: bundle.manifest.runtimeId })
  commitActivation({ runtimeRoot: root, runtimeId: bundle.manifest.runtimeId })
}

async function main() {
  console.log('=== runtime-update-coordinator tests ===')

  const rc6 = await buildArtifactBundle('0.1.0-rc.6', 'deadbeef')
  const rc8 = await buildArtifactBundle('0.1.0-rc.8', 'beef0000')

  console.log('\n[1] checkForUpdate: no active')
  {
    const root = tmpdir('no-active')
    const r = await checkForUpdate({ runtimeRoot: root, platform: process.platform, arch: process.arch, transport: makeMatrixTransport(makeMatrix(rc8)) })
    ok(r.updateAvailable === false && r.reason === 'no-active', 'no-active reports no update')
  }

  console.log('\n[2] checkForUpdate: same runtime')
  {
    const root = tmpdir('same')
    await makeActive(root, rc6)
    const r = await checkForUpdate({ runtimeRoot: root, platform: process.platform, arch: process.arch, transport: makeMatrixTransport(makeMatrix(rc6)) })
    ok(r.updateAvailable === false && r.reason === 'same-runtime', 'same runtimeId reports no update')
  }

  console.log('\n[3] checkForUpdate: newer version')
  {
    const root = tmpdir('newer')
    await makeActive(root, rc6)
    const r = await checkForUpdate({ runtimeRoot: root, platform: process.platform, arch: process.arch, transport: makeMatrixTransport(makeMatrix(rc8)) })
    ok(r.updateAvailable === true, 'newer version reports update available')
  }

  console.log('\n[4] checkForUpdate: older version (no downgrade)')
  {
    const root = tmpdir('older')
    await makeActive(root, rc8)
    const r = await checkForUpdate({ runtimeRoot: root, platform: process.platform, arch: process.arch, transport: makeMatrixTransport(makeMatrix(rc6)) })
    ok(r.updateAvailable === false && r.reason === 'older', 'older version reports no update')
  }

  console.log('\n[5] checkForUpdate: same version, different build')
  {
    const root = tmpdir('rebuild')
    await makeActive(root, rc6)
    const rc6b = await buildArtifactBundle('0.1.0-rc.6', 'beef9999') // same version, different buildId
    const r = await checkForUpdate({ runtimeRoot: root, platform: process.platform, arch: process.arch, transport: makeMatrixTransport(makeMatrix(rc6b)) })
    ok(r.updateAvailable === true, 'same version different build reports update available')
  }

  console.log('\n[6] downloadAndPrepare downloads, extracts, marks pending')
  {
    const root = tmpdir('prepare')
    await makeActive(root, rc6)
    const pending = await downloadAndPrepare({
      manifest: rc8.manifest, runtimeRoot: root, transport: makeArtifactTransport(rc8.archiveBytes),
    })
    ok(pending.runtimeId === rc8.manifest.runtimeId, 'returns pending runtime id')
    const s = readRuntimeState({ runtimeRoot: root })
    ok(s.pending && s.pending.runtimeId === rc8.manifest.runtimeId && s.pending.attemptCount === 0, 'pending set with attemptCount 0')
    ok(s.active.runtimeId === rc6.manifest.runtimeId, 'active unchanged after prepare')
    ok(fs.existsSync(path.join(root, 'runtimes', rc8.manifest.runtimeId, 'complete.json')), 'candidate installed')
  }

  console.log('\n[7] runBackgroundUpdate success end-to-end')
  {
    const root = tmpdir('success')
    await makeActive(root, rc6)
    const r = await runBackgroundUpdate({
      runtimeRoot: root, platform: process.platform, arch: process.arch,
      transport: makeMatrixTransport(makeMatrix(rc8)),
      downloadTransport: makeArtifactTransport(rc8.archiveBytes),
    })
    ok(r.updated === true && r.runtimeId === rc8.manifest.runtimeId, 'reports updated')
    const s = readRuntimeState({ runtimeRoot: root })
    ok(s.pending && s.pending.runtimeId === rc8.manifest.runtimeId, 'pending set after update')
    ok(s.active.runtimeId === rc6.manifest.runtimeId, 'active still rc6 (cold-start activation later)')
    ok(s.lastUpdateError === null, 'no lastUpdateError on success')
  }

  console.log('\n[8] runBackgroundUpdate manifest failure → lastUpdateError')
  {
    const root = tmpdir('manifest-fail')
    await makeActive(root, rc6)
    // invalid matrix (bad releaseTag) → fetchManifest throws
    const bad = makeMatrix(rc8)
    bad.latest.artifacts[0].releaseTag = 'v0.1.0-rc.8'
    const r = await runBackgroundUpdate({
      runtimeRoot: root, platform: process.platform, arch: process.arch,
      transport: makeMatrixTransport(bad),
      downloadTransport: makeArtifactTransport(rc8.archiveBytes),
    })
    ok(r.updated === false, 'reports not updated')
    const s = readRuntimeState({ runtimeRoot: root })
    ok(s.lastUpdateError && s.lastUpdateError.stage === 'manifest', 'lastUpdateError stage=manifest')
    ok(s.active.runtimeId === rc6.manifest.runtimeId, 'active unchanged on manifest failure')
  }

  console.log('\n[9] runBackgroundUpdate verify failure → lastUpdateError, active untouched')
  {
    const root = tmpdir('verify-fail')
    await makeActive(root, rc6)
    // artifact whose bytes do not match the manifest sha256
    const badArtifact = Buffer.from('not the real archive content')
    const r = await runBackgroundUpdate({
      runtimeRoot: root, platform: process.platform, arch: process.arch,
      transport: makeMatrixTransport(makeMatrix(rc8)),
      downloadTransport: makeArtifactTransport(badArtifact),
    })
    ok(r.updated === false, 'reports not updated')
    const s = readRuntimeState({ runtimeRoot: root })
    ok(s.lastUpdateError && s.lastUpdateError.stage === 'verify', 'lastUpdateError stage=verify')
    ok(s.active.runtimeId === rc6.manifest.runtimeId, 'active unchanged on verify failure')
    ok(s.pending === null || s.pending.runtimeId !== rc8.manifest.runtimeId, 'no pending set on failure')
  }

  console.log('\n[10] classifyError')
  {
    ok(classifyError(new Error('sha256 mismatch')) === 'verify', 'sha256 → verify')
    ok(classifyError(new Error('size mismatch')) === 'verify', 'size → verify')
    ok(classifyError(new Error('invalid releaseTag')) === 'manifest', 'releaseTag → manifest')
    ok(classifyError(new Error('connect timeout')) === 'download', 'network → download')
  }

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('test failed:', e); process.exit(1) })
