'use strict'

/**
 * test-runtime-manager — pure-Node tests for the Runtime Foundation:
 * manifest validation, tar safety, ensure/activate/rollback/purge, the
 * cross-process lock, and EngineManager explicit-path decoupling.
 *
 * Runs on any Node version (no external deps, no GUI, no Electron).
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const {
  validateManifest, ensureRuntime, getActiveRuntime, activateRuntime,
  markRuntimeHealthy, rollbackRuntime, purgeRuntimeCache, acquireLock,
  compareVersions, isSafeRelativePath, runtimePaths,
} = require('../src/runtime-manager')
const { packDirectory, unpackArchive, writeHeader, writeData, writeLongName, BLOCK } = require('../src/tar-util')
const { EngineManager } = require('../src/engine-manager')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshed-rt-test-'))

function tmpdir(name) {
  const d = path.join(tmpRoot, name || `t-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

function makeManifest(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    runtimeId: `dsh-0.1.0-rc.6-deadbeef-${process.platform}-${process.arch}`,
    dshVersion: '0.1.0-rc.6',
    buildId: 'deadbeef',
    platform: process.platform,
    arch: process.arch,
    archive: 'dsh-0.1.0-rc.6-deadbeef.tar.gz',
    sha256: 'a'.repeat(64),
    size: 0,
    extractedSize: 0,
    extractedFileCount: 0,
    entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    minimumDshedVersion: '0.1.0',
    releasedAt: '2026-08-21T00:00:00Z',
  }, overrides)
}

// build a real runtime dir + archive using the packer, returning { archive, manifest }
function buildRuntime(runtimeRootDir, entryPath, extraFiles = {}) {
  const src = tmpdir('src')
  const entryAbs = path.join(src, entryPath)
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true })
  fs.writeFileSync(entryAbs, '#!/usr/bin/env node\nconsole.log("dsh")\n')
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = path.join(src, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const archive = path.join(runtimeRootDir, 'dsh.tar.gz')
  return packDirectory(src, archive).then(({ fileCount, extractedSize }) => {
    const archiveBytes = fs.readFileSync(archive)
    return {
      archive,
      manifest: makeManifest({
        runtimeId: `dsh-0.1.0-rc.6-deadbeef-${process.platform}-${process.arch}`,
        archive: 'dsh.tar.gz',
        sha256: sha256(archiveBytes),
        size: archiveBytes.length,
        extractedSize,
        extractedFileCount: fileCount,
        entry: entryPath,
      }),
    }
  })
}

// build a raw (possibly malicious) tar.gz from explicit entries
function buildRawTarGz(outFile, entries) {
  const gzip = zlib.createGzip({ level: 3 })
  const chunks = []
  gzip.on('data', (c) => chunks.push(c))
  for (const e of entries) {
    const name = e.name
    let head
    if (Buffer.byteLength(name, 'utf8') > 100) gzip.write(writeLongName(name))
    head = writeHeader(name, e.typeflag, e.size || 0, e.linkname)
    gzip.write(head)
    if (e.data && e.data.length) gzip.write(writeData(e.data))
  }
  gzip.write(Buffer.alloc(BLOCK * 2))
  gzip.end()
  return new Promise((resolve, reject) => {
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    gzip.on('error', reject)
  }).then((buf) => fs.writeFileSync(outFile, buf))
}

async function main() {
  console.log('=== runtime-manager tests ===')

  // ————————————————— [1] validateManifest —————————————————
  console.log('\n[1] validateManifest')
  {
    const m = makeManifest()
    ok(validateManifest(m, { platform: process.platform, arch: process.arch }).valid, 'valid manifest passes')

    const badType = makeManifest({ size: 'not-a-number' })
    ok(!validateManifest(badType).valid, 'size must be a number')

    const badSchema = makeManifest({ schemaVersion: 2 })
    ok(!validateManifest(badSchema).valid, 'schemaVersion must be 1')

    const missingField = makeManifest({}); delete missingField.dshVersion
    ok(!validateManifest(missingField).valid, 'missing dshVersion rejected')

    const badSha = makeManifest({ sha256: 'xyz' })
    ok(!validateManifest(badSha).valid, 'malformed sha256 rejected')

    const noBuildId = makeManifest({ runtimeId: 'dsh-0.1.0-rc.6-darwin-arm64' })
    ok(!validateManifest(noBuildId).valid, 'runtimeId must contain buildId')

    const wrongPlatform = makeManifest({ platform: 'win32' })
    ok(!validateManifest(wrongPlatform, { platform: 'darwin', arch: process.arch }).valid, 'platform mismatch rejected')

    const wrongArch = makeManifest({ arch: 'x64' })
    ok(!validateManifest(wrongArch, { platform: process.platform, arch: 'arm64' }).valid, 'arch mismatch rejected')

    const absEntry = makeManifest({ entry: '/etc/passwd' })
    ok(!validateManifest(absEntry).valid, 'absolute entry path rejected')

    const traversalEntry = makeManifest({ entry: '../../etc/passwd' })
    ok(!validateManifest(traversalEntry).valid, 'entry path traversal rejected')

    const traversalArchive = makeManifest({ archive: '../evil.tar.gz' })
    ok(!validateManifest(traversalArchive).valid, 'archive path traversal rejected')

    // P0 regression: runtimeId is used as a directory name — must be a safe basename
    const traversalRuntimeId = makeManifest({ runtimeId: '../../escaped-build', buildId: 'escaped-build' })
    ok(!validateManifest(traversalRuntimeId).valid, 'runtimeId path traversal rejected')

    const slashRuntimeId = makeManifest({ runtimeId: 'a/b', buildId: 'a' })
    ok(!validateManifest(slashRuntimeId).valid, 'runtimeId with slash rejected')

    const dotRuntimeId = makeManifest({ runtimeId: '..', buildId: '' })
    ok(!validateManifest(dotRuntimeId).valid, 'runtimeId ".." rejected')

    const badBuildId = makeManifest({ buildId: '../evil' })
    ok(!validateManifest(badBuildId).valid, 'buildId traversal rejected')

    const badPlatformValue = makeManifest({ platform: 'freebsd' })
    ok(!validateManifest(badPlatformValue).valid, 'unknown platform value rejected')

    const badArchValue = makeManifest({ arch: 'ia32' })
    ok(!validateManifest(badArchValue).valid, 'unknown arch value rejected')

    const tooOld = makeManifest({ minimumDshedVersion: '0.2.0' })
    ok(!validateManifest(tooOld, { currentDshedVersion: '0.1.0', platform: process.platform, arch: process.arch }).valid, 'minimumDshedVersion older shell rejected')

    const newerOk = makeManifest({ minimumDshedVersion: '0.1.0' })
    ok(validateManifest(newerOk, { currentDshedVersion: '0.1.5', platform: process.platform, arch: process.arch }).valid, 'newer shell satisfies minimumDshedVersion')
  }

  // ————————————————— [2] version compare + safe path —————————————————
  console.log('\n[2] version compare / safe path')
  ok(compareVersions('0.1.0', '0.1.5') === -1, '0.1.0 < 0.1.5')
  ok(compareVersions('0.1.0', '0.1.0-rc.6') === 1, 'release > prerelease')
  ok(compareVersions('0.2.0', '0.1.9') === 1, '0.2.0 > 0.1.9')
  // P2 regression: prerelease identifiers must compare numerically, not lexically
  ok(compareVersions('0.1.0-rc.10', '0.1.0-rc.8') === 1, 'rc.10 > rc.8 (numeric prerelease)')
  ok(compareVersions('0.1.0-rc.2', '0.1.0-rc.10') === -1, 'rc.2 < rc.10')
  ok(compareVersions('0.1.0-rc.1', '0.1.0-rc.1') === 0, 'equal prerelease')
  ok(isSafeRelativePath('a/b/c.js') === true, 'safe relative path ok')
  ok(isSafeRelativePath('/abs') === false, 'absolute path unsafe')
  ok(isSafeRelativePath('../x') === false, 'traversal unsafe')
  ok(isSafeRelativePath('a\\b') === false, 'backslash unsafe')
  ok(isSafeRelativePath('') === false, 'empty unsafe')

  // ————————————————— [3] tar pack/unpack round-trip + safety —————————————————
  console.log('\n[3] tar pack/unpack')
  {
    const src = tmpdir('roundtrip')
    fs.mkdirSync(path.join(src, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
    fs.writeFileSync(path.join(src, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'console.log(1)')
    const longDir = path.join(src, 'some/very/deep/directory/structure/that/exceeds/one/hundred/characters/in/length/for/testing/longname/support/in/tar')
    fs.mkdirSync(longDir, { recursive: true })
    // large payload forces the unpacker to split the long-name entry across
    // multiple gzip chunks (regression: pendingLongName was reset too early)
    fs.writeFileSync(path.join(longDir, 'payload.txt'), Buffer.alloc(200 * 1024, 0x61))
    // relative symlink (like dsh's node_modules/.bin)
    fs.mkdirSync(path.join(src, 'node_modules/.bin'), { recursive: true })
    fs.symlinkSync('../../@deepseek-ai/dsh/lib/bin.js', path.join(src, 'node_modules/.bin', 'dsh'))
    const out = path.join(tmpdir('out'), 'r.tar.gz')
    const { fileCount, extractedSize } = await packDirectory(src, out)
    ok(fileCount === 2, `pack fileCount=2 (got ${fileCount})`)

    const dest = tmpdir('dest')
    const stats = await unpackArchive(out, dest)
    ok(stats.fileCount === 2, `unpack fileCount=2 (got ${stats.fileCount})`)
    ok(fs.existsSync(path.join(dest, 'node_modules/@deepseek-ai/dsh/lib/bin.js')), 'nested file extracted')
    ok(fs.existsSync(path.join(dest, longDir.replace(src, '').replace(/^\/+/, ''), 'payload.txt')), 'long-name file extracted')
    ok(fs.lstatSync(path.join(dest, 'node_modules/.bin/dsh')).isSymbolicLink(), 'symlink preserved')
    ok(stats.extractedSize === extractedSize, 'extractedSize round-trips')
  }

  console.log('\n[3b] tar path traversal + escaping symlink')
  {
    const malicious = path.join(tmpdir('evil'), 'evil.tar.gz')
    await buildRawTarGz(malicious, [
      { name: '../escape.txt', typeflag: '0', size: 5, data: Buffer.from('evil!') },
    ])
    const dest = tmpdir('evil-dest')
    let threw = false
    try { await unpackArchive(malicious, dest) } catch (e) { threw = true }
    ok(threw, 'archive path traversal rejected')
    ok(!fs.existsSync(path.join(path.dirname(dest), 'escape.txt')), 'no file escaped the root')

    const evilLink = path.join(tmpdir('evil2'), 'link.tar.gz')
    await buildRawTarGz(evilLink, [
      { name: 'pwn', typeflag: '2', size: 0, linkname: '../../../../etc/passwd' },
    ])
    const dest2 = tmpdir('evil2-dest')
    let threw2 = false
    try { await unpackArchive(evilLink, dest2) } catch (e) { threw2 = true }
    ok(threw2, 'escaping symlink rejected')

    const absLink = path.join(tmpdir('evil3'), 'abs.tar.gz')
    await buildRawTarGz(absLink, [
      { name: 'pwn', typeflag: '2', size: 0, linkname: '/etc/passwd' },
    ])
    let threw3 = false
    try { await unpackArchive(absLink, tmpdir('evil3-dest')) } catch (e) { threw3 = true }
    ok(threw3, 'absolute symlink target rejected')
  }

  console.log('\n[3c] missing tar terminator block rejected')
  {
    // gzip is valid and decompresses fully, but the tar stream lacks the two
    // zero terminator blocks — must be rejected, not silently accepted.
    const noTerm = path.join(tmpdir('no-term'), 'no-term.tar.gz')
    const gzip = zlib.createGzip()
    const chunks = []
    gzip.on('data', (c) => chunks.push(c))
    gzip.write(writeHeader('file.txt', '0', 2, null))
    gzip.write(writeData(Buffer.from('hi')))
    gzip.end() // intentionally no terminator blocks
    await new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject) })
    fs.writeFileSync(noTerm, Buffer.concat(chunks))
    let threw = false
    try { await unpackArchive(noTerm, tmpdir('no-term-dest')) } catch (e) { threw = true }
    ok(threw, 'missing terminator block rejected')
  }

  console.log('\n[3d] corrupt header checksum rejected')
  {
    const bad = path.join(tmpdir('bad-chksum'), 'bad-chksum.tar.gz')
    const hdr = writeHeader('file.txt', '0', 2, null)
    hdr[10] = hdr[10] ^ 0xff // corrupt a name byte without recomputing checksum
    const gzip = zlib.createGzip()
    const chunks = []
    gzip.on('data', (c) => chunks.push(c))
    gzip.write(hdr)
    gzip.write(writeData(Buffer.from('hi')))
    gzip.write(Buffer.alloc(BLOCK * 2))
    gzip.end()
    await new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject) })
    fs.writeFileSync(bad, Buffer.concat(chunks))
    let threw = false
    try { await unpackArchive(bad, tmpdir('bad-chksum-dest')) } catch (e) { threw = true }
    ok(threw, 'corrupt header checksum rejected')
  }

  // ————————————————— [4] ensureRuntime —————————————————
  console.log('\n[4] ensureRuntime')
  {
    const root = tmpdir('rt')
    const { archive, manifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const r = await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch })
    ok(r.runtimeId === manifest.runtimeId, 'ensureRuntime returns runtimeId')
    ok(fs.existsSync(path.join(r.runtimeDir, 'complete.json')), 'complete.json written')
    ok(fs.existsSync(path.join(r.runtimeDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')), 'entry extracted')
    ok(!fs.existsSync(path.join(root, 'staging', manifest.runtimeId)), 'staging cleaned after success')

    // idempotent
    const again = await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch })
    ok(again.runtimeDir === r.runtimeDir, 'ensureRuntime is idempotent')

    // sha256 mismatch
    const badArchive = path.join(root, 'bad.tar.gz')
    fs.writeFileSync(badArchive, 'corrupted')
    const badManifest = { ...manifest, runtimeId: manifest.runtimeId + '-bad', sha256: 'b'.repeat(64), size: 9 }
    let threw = false
    try { await ensureRuntime({ runtimeRoot: root, manifest: badManifest, archivePath: badArchive, platform: process.platform, arch: process.arch }) } catch (e) { threw = true }
    ok(threw, 'sha256 mismatch rejected before extract')
  }

  console.log('\n[4b] truncated archive does not produce ready runtime')
  {
    const root = tmpdir('trunc')
    const { archive, manifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    // truncate the gzip so extraction fails partway
    const bytes = fs.readFileSync(archive)
    fs.writeFileSync(archive, bytes.slice(0, Math.floor(bytes.length / 2)))
    let threw = false
    try { await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch }) } catch (e) { threw = true }
    ok(threw, 'truncated archive extraction fails')
    ok(!fs.existsSync(path.join(root, 'runtimes', manifest.runtimeId, 'complete.json')), 'no ready runtime from truncated archive')
    ok(!fs.existsSync(path.join(root, 'staging', manifest.runtimeId)), 'no incomplete staging left behind')

    // incomplete staging from a prior interrupted run is cleaned on next install
    const stagingDir = path.join(root, 'staging', manifest.runtimeId)
    fs.mkdirSync(stagingDir, { recursive: true })
    fs.writeFileSync(path.join(stagingDir, 'partial'), 'x')
    const { archive: freshArchive, manifest: freshManifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest: freshManifest, archivePath: freshArchive, platform: process.platform, arch: process.arch })
    ok(!fs.existsSync(path.join(root, 'staging', freshManifest.runtimeId, 'partial')), 'stale staging cleaned before reinstall')
  }

  console.log('\n[4c] corrupt/old-format complete.json is not treated as ready')
  {
    const root = tmpdir('corrupt')
    const { archive, manifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch })
    activateRuntime({ runtimeRoot: root, runtimeId: manifest.runtimeId })
    markRuntimeHealthy({ runtimeRoot: root, runtimeId: manifest.runtimeId })

    // corrupt complete.json (bad sha256) → active runtime no longer resolves as ready
    const completePath = path.join(root, 'runtimes', manifest.runtimeId, 'complete.json')
    const complete = JSON.parse(fs.readFileSync(completePath, 'utf8'))
    complete.sha256 = 'not-a-sha'
    fs.writeFileSync(completePath, JSON.stringify(complete))
    ok(getActiveRuntime({ runtimeRoot: root }) === null, 'corrupt complete.json makes active runtime not-ready')

    // old-format complete.json (missing fields) → not ready
    fs.writeFileSync(completePath, JSON.stringify({ formatVersion: 1 }))
    ok(getActiveRuntime({ runtimeRoot: root }) === null, 'incomplete complete.json is not ready')

    // a runtime directory with mismatched identity is refused, not overwritten
    fs.writeFileSync(completePath, JSON.stringify({ ...complete, sha256: manifest.sha256, buildId: 'deadbee' }))
    let threw = false
    try { await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch }) } catch (e) { threw = true }
    ok(threw, 'identity mismatch refuses reinstall instead of overwriting')
  }

  console.log('\n[4d] corrupt runtime is isolated and reinstalled')
  {
    const root = tmpdir('recover')
    const { archive, manifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch })

    // corrupt complete.json so readComplete() returns null but the dir still exists
    const completePath = path.join(root, 'runtimes', manifest.runtimeId, 'complete.json')
    fs.writeFileSync(completePath, JSON.stringify({ formatVersion: 1, runtimeId: manifest.runtimeId, buildId: manifest.buildId, sha256: 'not-a-sha', entry: manifest.entry }))

    const r = await ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: process.platform, arch: process.arch })
    ok(r.runtimeId === manifest.runtimeId, 'reinstalled after corruption')
    ok(fs.existsSync(path.join(r.runtimeDir, 'complete.json')), 'complete.json restored')
    ok(fs.existsSync(path.join(r.runtimeDir, manifest.entry)), 'entry restored after reinstall')
    const names = fs.readdirSync(path.join(root, 'runtimes'))
    ok(names.every((n) => !n.includes('.failed-')), 'no .failed-* left after successful reinstall')
  }

  // ————————————————— [5] lock —————————————————
  console.log('\n[5] cross-process lock')
  {
    const lockPath = path.join(tmpdir('lock'), 'install.lock')
    const release = await acquireLock(lockPath, { timeoutMs: 1000 })
    ok(fs.existsSync(lockPath), 'lock file created')

    // active lock: same process holds it → second acquire times out
    let timedOut = false
    try { await acquireLock(lockPath, { timeoutMs: 400, pollMs: 50 }) } catch (e) { timedOut = true }
    ok(timedOut, 'active lock blocks a second acquirer')
    release()
    ok(!fs.existsSync(lockPath), 'release removes lock')

    // stale lock: owner pid does not exist → acquired
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }))
    const rel2 = await acquireLock(lockPath, { timeoutMs: 2000 })
    ok(fs.existsSync(lockPath), 'stale lock replaced')
    rel2()
  }

  console.log('\n[5b] two-process install race')
  {
    const lockPath = path.join(tmpdir('race'), 'install.lock')
    const signalFile = path.join(tmpdir('race'), 'held.signal')
    const child = spawn(process.execPath, ['-e', `
      const { acquireLock } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'runtime-manager.js'))});
      (async () => {
        const rel = await acquireLock(${JSON.stringify(lockPath)}, { timeoutMs: 5000 });
        require('fs').writeFileSync(${JSON.stringify(signalFile)}, 'held');
        setTimeout(() => { rel(); process.exit(0); }, 1500);
      })();
    `], { stdio: 'ignore' })
    const childExit = new Promise((r) => child.on('exit', r))
    // wait until the child actually holds the lock
    while (!fs.existsSync(signalFile)) await new Promise((r) => setTimeout(r, 20))
    const start = Date.now()
    const rel = await acquireLock(lockPath, { timeoutMs: 5000 })
    const elapsed = Date.now() - start
    await childExit
    ok(elapsed >= 1000, `parent blocked while child held lock (${elapsed}ms)`)
    rel()
  }

  console.log('\n[5c] two concurrent ensureRuntime both succeed (idempotent)')
  {
    const root = tmpdir('concurrent')
    const { archive, manifest } = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const script = `
      const { ensureRuntime } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'runtime-manager.js'))});
      const root = process.env.RT_ROOT;
      const archive = process.env.RT_ARCHIVE;
      const manifest = JSON.parse(process.env.RT_MANIFEST);
      ensureRuntime({ runtimeRoot: root, manifest, archivePath: archive, platform: manifest.platform, arch: manifest.arch })
        .then(() => process.exit(0))
        .catch((e) => { console.error(e.message); process.exit(1); });
    `
    const env = {
      ...process.env,
      RT_ROOT: root,
      RT_ARCHIVE: archive,
      RT_MANIFEST: JSON.stringify(manifest),
    }
    const runInstall = () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', script], { env, stdio: 'ignore' })
      p.on('exit', (code) => resolve(code))
    })
    const [c1, c2] = await Promise.all([runInstall(), runInstall()])
    ok(c1 === 0 && c2 === 0, `both concurrent ensureRuntime succeed (codes ${c1}, ${c2})`)
    ok(fs.existsSync(path.join(root, 'runtimes', manifest.runtimeId, 'complete.json')), 'runtime installed exactly once')
  }

  // ————————————————— [6] activate / healthy / rollback —————————————————
  console.log('\n[6] activate / markHealthy / rollback')
  {
    const root = tmpdir('activate')
    const a = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const b = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    b.manifest = makeManifest({
      runtimeId: 'dsh-0.1.0-rc.7-beef001-beef001-beef001-beef001'.slice(0, 0) || `dsh-0.1.0-rc.7-deadbee-${process.platform}-${process.arch}`,
      buildId: 'deadbee',
      dshVersion: '0.1.0-rc.7',
      archive: 'dsh2.tar.gz',
      sha256: b.manifest.sha256, size: b.manifest.size,
      extractedSize: b.manifest.extractedSize, extractedFileCount: b.manifest.extractedFileCount,
      entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
    })
    await ensureRuntime({ runtimeRoot: root, manifest: a.manifest, archivePath: a.archive, platform: process.platform, arch: process.arch })
    await ensureRuntime({ runtimeRoot: root, manifest: b.manifest, archivePath: b.archive, platform: process.platform, arch: process.arch })

    // activate A (pending) then mark healthy → active, no previous yet
    activateRuntime({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    ok(readJson(path.join(root, 'pending.json')).runtimeId === a.manifest.runtimeId, 'pending written atomically')
    markRuntimeHealthy({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    ok(readJson(path.join(root, 'active.json')).runtimeId === a.manifest.runtimeId, 'A active after healthy')
    ok(!fs.existsSync(path.join(root, 'previous.json')), 'no previous on first activation')

    // activate B (pending) → mark healthy → previous preserved as A
    activateRuntime({ runtimeRoot: root, runtimeId: b.manifest.runtimeId })
    markRuntimeHealthy({ runtimeRoot: root, runtimeId: b.manifest.runtimeId })
    ok(readJson(path.join(root, 'active.json')).runtimeId === b.manifest.runtimeId, 'B active')
    ok(readJson(path.join(root, 'previous.json')).runtimeId === a.manifest.runtimeId, 'A preserved as previous')

    // rollback: pending B failed → return to previous A
    activateRuntime({ runtimeRoot: root, runtimeId: b.manifest.runtimeId })
    const rb = rollbackRuntime({ runtimeRoot: root })
    ok(rb.runtimeId === a.manifest.runtimeId, 'rollback returns previous runtime A')
    ok(readJson(path.join(root, 'active.json')).runtimeId === a.manifest.runtimeId, 'active restored to A after rollback')
  }

  console.log('\n[6b] getActiveRuntime clears stale pending')
  {
    const root = tmpdir('stale-pending')
    const a = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest: a.manifest, archivePath: a.archive, platform: process.platform, arch: process.arch })
    activateRuntime({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    markRuntimeHealthy({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    // simulate an interrupted activation
    fs.writeFileSync(path.join(root, 'pending.json'), JSON.stringify({ runtimeId: 'ghost', pendingAt: new Date().toISOString() }))
    const active = getActiveRuntime({ runtimeRoot: root })
    ok(active && active.runtimeId === a.manifest.runtimeId, 'active resolved despite stale pending')
    ok(!fs.existsSync(path.join(root, 'pending.json')), 'stale pending cleared')
  }

  console.log('\n[6c] markRuntimeHealthy rejects invalid states; malicious runtimeId cannot resolve')
  {
    const root = tmpdir('strict-healthy')
    const a = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest: a.manifest, archivePath: a.archive, platform: process.platform, arch: process.arch })

    // no pending → rejected, and no active.json written
    let threw = false
    try { markRuntimeHealthy({ runtimeRoot: root, runtimeId: a.manifest.runtimeId }) } catch (e) { threw = true }
    ok(threw, 'markRuntimeHealthy without pending rejected')
    ok(!fs.existsSync(path.join(root, 'active.json')), 'no active.json written on invalid markHealthy')

    // pending exists but points at a different runtime → rejected
    activateRuntime({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    const b = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    b.manifest = { ...b.manifest, runtimeId: `dsh-other-deadbee-${process.platform}-${process.arch}`, buildId: 'deadbee' }
    await ensureRuntime({ runtimeRoot: root, manifest: b.manifest, archivePath: b.archive, platform: process.platform, arch: process.arch })
    let threw2 = false
    try { markRuntimeHealthy({ runtimeRoot: root, runtimeId: b.manifest.runtimeId }) } catch (e) { threw2 = true }
    ok(threw2, 'markRuntimeHealthy with mismatched pending rejected')

    // nonexistent runtime → rejected
    let threw3 = false
    try { markRuntimeHealthy({ runtimeRoot: root, runtimeId: `dsh-nonexistent-deadbee-${process.platform}-${process.arch}` }) } catch (e) { threw3 = true }
    ok(threw3, 'markRuntimeHealthy for nonexistent runtime rejected')

    // unsafe runtimeId → rejected (no traversal)
    let threw4 = false
    try { markRuntimeHealthy({ runtimeRoot: root, runtimeId: '../../etc/passwd' }) } catch (e) { threw4 = true }
    ok(threw4, 'markRuntimeHealthy for unsafe runtimeId rejected')

    // active.json containing a malicious runtimeId must not resolve (no escape)
    fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ runtimeId: '../../escape', activatedAt: new Date().toISOString() }))
    ok(getActiveRuntime({ runtimeRoot: root }) === null, 'malicious active runtimeId does not resolve')
  }

  // ————————————————— [7] purge —————————————————
  console.log('\n[7] purgeRuntimeCache')
  {
    const root = tmpdir('purge')
    const a = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    await ensureRuntime({ runtimeRoot: root, manifest: a.manifest, archivePath: a.archive, platform: process.platform, arch: process.arch })
    activateRuntime({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })
    markRuntimeHealthy({ runtimeRoot: root, runtimeId: a.manifest.runtimeId })

    // a second non-active runtime + downloads + staging to be purged
    const b = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    b.manifest = { ...b.manifest, runtimeId: `dsh-old-deadbee-${process.platform}-${process.arch}`, buildId: 'deadbee' }
    await ensureRuntime({ runtimeRoot: root, manifest: b.manifest, archivePath: b.archive, platform: process.platform, arch: process.arch })

    // a third runtime marked pending must survive purge (it is about to start)
    const c = await buildRuntime(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    c.manifest = { ...c.manifest, runtimeId: `dsh-pending-deadbee-${process.platform}-${process.arch}`, buildId: 'deadbee' }
    await ensureRuntime({ runtimeRoot: root, manifest: c.manifest, archivePath: c.archive, platform: process.platform, arch: process.arch })
    activateRuntime({ runtimeRoot: root, runtimeId: c.manifest.runtimeId })

    fs.mkdirSync(path.join(root, 'downloads', 'x'), { recursive: true })
    fs.writeFileSync(path.join(root, 'downloads', 'x', 'partial.tar.gz'), 'x')
    fs.mkdirSync(path.join(root, 'staging', 'y'), { recursive: true })

    await purgeRuntimeCache({ runtimeRoot: root })
    ok(fs.existsSync(path.join(root, 'runtimes', a.manifest.runtimeId, 'complete.json')), 'active runtime preserved')
    ok(fs.existsSync(path.join(root, 'runtimes', c.manifest.runtimeId, 'complete.json')), 'pending runtime preserved')
    ok(!fs.existsSync(path.join(root, 'runtimes', b.manifest.runtimeId)), 'non-active runtime purged')
    ok(!fs.existsSync(path.join(root, 'downloads', 'x')), 'downloads purged')
    ok(!fs.existsSync(path.join(root, 'staging', 'y')), 'staging purged')
    ok(readJson(path.join(root, 'active.json')).runtimeId === a.manifest.runtimeId, 'active.json preserved')
  }

  // ————————————————— [8] EngineManager explicit paths —————————————————
  console.log('\n[8] EngineManager explicit paths')
  {
    const nodeBin = '/fake/node'
    const dshBin = '/fake/dsh/bin.js'
    const em = new EngineManager({ nodeBin, dshBin, dshHome: tmpdir('dsh-home') })
    ok(em.nodeBin === nodeBin, 'nodeBin passed through explicitly')
    ok(em.dshBin === dshBin, 'dshBin passed through explicitly')

    // without explicit paths, constructor must NOT silently resolve resources/dsh
    const em2 = new EngineManager({ dshHome: tmpdir('dsh-home2') })
    ok(em2.nodeBin === null && em2.dshBin === null, 'no implicit resource discovery in production')
  }

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

main().catch((e) => { console.error('test failed:', e); process.exit(1) })
