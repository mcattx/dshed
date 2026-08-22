'use strict'

/**
 * test-runtime-manifest-client — validates schema, platform/arch matching,
 * URL derivation and trust boundaries of the remote runtime manifest client
 * against a local HTTP fixture server.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  fetchManifest, validateMatrix, matchArtifact, deriveArtifactUrl, resolveArtifact,
  STABLE_MANIFEST_URL, PREVIEW_MANIFEST_URL, MAX_MANIFEST_BYTES, OWNER, REPO,
} = require('../src/runtime-manifest-client')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshed-mc-test-'))
function tmpdir(name) {
  const d = path.join(tmpRoot, name || `t-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

const ARTIFACT = {
  platform: 'darwin', arch: 'arm64',
  runtimeId: 'dsh-0.1.0-rc.8-a1435ba6f384-darwin-arm64',
  buildId: 'a1435ba6f384',
  releaseTag: 'dsh-v0.1.0-rc.8-a1435ba6f384',
  archive: 'dsh-0.1.0-rc.8-a1435ba6f384-darwin-arm64.tar.gz',
  sha256: 'a'.repeat(64),
  size: 100,
  extractedSize: 200,
  extractedFileCount: 10,
  entry: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
}

function makeMatrix(overrides = {}) {
  return Object.assign({
    schemaVersion: 2,
    latest: {
      dshVersion: '0.1.0-rc.8',
      minimumDshedVersion: '0.1.0',
      releasedAt: '2026-08-22T00:00:00.000Z',
      artifacts: [ARTIFACT],
    },
  }, overrides)
}

/** fake transport: records the requested URL and returns a canned body */
function makeFakeTransport(body, { statusCode = 200 } = {}) {
  const { Readable } = require('node:stream')
  const calls = []
  return {
    calls,
    request: async (url) => {
      calls.push(url)
      return { statusCode, headers: {}, stream: Readable.from([Buffer.from(body)]) }
    },
  }
}

async function main() {
  console.log('=== runtime-manifest-client tests ===')

  console.log('\n[1] validateMatrix')
  {
    ok(validateMatrix(makeMatrix()).dshVersion === '0.1.0-rc.8', 'valid matrix accepted')

    for (const [name, mutate] of [
      ['schemaVersion 1', (m) => { m.schemaVersion = 1 }],
      ['missing latest', (m) => { delete m.latest }],
      ['bad dshVersion', (m) => { m.latest.dshVersion = 'not-a-version' }],
      ['bad minimumDshedVersion', (m) => { m.latest.minimumDshedVersion = 'x' }],
      ['missing releasedAt', (m) => { delete m.latest.releasedAt }],
      ['empty artifacts', (m) => { m.latest.artifacts = [] }],
    ]) {
      const m = makeMatrix()
      mutate(m)
      let threw = false
      try { validateMatrix(m) } catch (e) { threw = true }
      ok(threw, `${name} rejected`)
    }
  }

  console.log('\n[2] matchArtifact')
  {
    const m = makeMatrix()
    ok(matchArtifact(m.latest.artifacts, 'darwin', 'arm64').runtimeId === ARTIFACT.runtimeId, 'matches platform/arch')

    let threw = false
    try { matchArtifact(m.latest.artifacts, 'linux', 'x64') } catch (e) { threw = true }
    ok(threw, 'no match rejected')

    const dup = makeMatrix()
    dup.latest.artifacts.push({ ...ARTIFACT })
    let threw2 = false
    try { matchArtifact(dup.latest.artifacts, 'darwin', 'arm64') } catch (e) { threw2 = true }
    ok(threw2, 'duplicate match rejected')
  }

  console.log('\n[3] deriveArtifactUrl + resolveArtifact')
  {
    const url = deriveArtifactUrl('dsh-v0.1.0-rc.8-a1435ba6f384', ARTIFACT.archive)
    ok(url === `https://github.com/${OWNER}/${REPO}/releases/download/dsh-v0.1.0-rc.8-a1435ba6f384/${ARTIFACT.archive}`, 'derives release download URL')

    const resolved = resolveArtifact(makeMatrix().latest, ARTIFACT, 'stable')
    ok(resolved.runtimeId === ARTIFACT.runtimeId, 'resolved runtimeId')
    ok(resolved.releaseTag === 'dsh-v0.1.0-rc.8-a1435ba6f384', 'resolved releaseTag')
    ok(resolved.channel === 'stable', 'resolved channel')
    ok(resolved.artifactUrl.startsWith('https://github.com/'), 'resolved artifactUrl')

    // unsafe archive / entry in an artifact must be rejected via validateManifest
    const bad = makeMatrix()
    bad.latest.artifacts = [{ ...ARTIFACT, archive: '../evil.tar.gz' }]
    let threw = false
    try { resolveArtifact(bad.latest, bad.latest.artifacts[0], 'stable') } catch (e) { threw = true }
    ok(threw, 'unsafe archive rejected')

    // releaseTag lives on the artifact and must carry the dsh-v prefix
    for (const tag of ['v0.1.0-rc.8', 'dsh-v../x', undefined]) {
      const bt = makeMatrix()
      bt.latest.artifacts = [{ ...ARTIFACT, releaseTag: tag }]
      let t = false
      try { resolveArtifact(bt.latest, bt.latest.artifacts[0], 'stable') } catch (e) { t = true }
      ok(t, `invalid releaseTag ${JSON.stringify(tag)} rejected`)
    }
  }

  console.log('\n[4] fetchManifest uses fixed endpoint + resolves artifact')
  {
    const t = makeFakeTransport(JSON.stringify(makeMatrix()))
    const r = await fetchManifest({ channel: 'stable', platform: 'darwin', arch: 'arm64', transport: t })
    ok(t.calls.length === 1 && t.calls[0] === STABLE_MANIFEST_URL, 'hits the fixed stable endpoint')
    ok(r.runtimeId === ARTIFACT.runtimeId, 'fetchManifest resolves artifact')
    ok(r.artifactUrl.startsWith('https://github.com/'), 'fetchManifest derives artifactUrl')
  }

  console.log('\n[4b] caller-supplied URL is not honored')
  {
    const t = makeFakeTransport(JSON.stringify(makeMatrix()))
    await fetchManifest({
      channel: 'stable', platform: 'darwin', arch: 'arm64', transport: t,
      url: 'https://evil.example.com/attacker/manifest.json',
    })
    ok(t.calls[0] === STABLE_MANIFEST_URL, 'injected url ignored, still uses fixed endpoint')
  }

  console.log('\n[4c] preview channel uses fixed preview endpoint')
  {
    const t = makeFakeTransport(JSON.stringify(makeMatrix()))
    await fetchManifest({ channel: 'preview', platform: 'darwin', arch: 'arm64', transport: t })
    ok(t.calls[0] === PREVIEW_MANIFEST_URL, 'preview channel hits the fixed preview endpoint')
  }

  console.log('\n[5] minimumDshedVersion enforced')
  {
    const m = makeMatrix()
    m.latest.minimumDshedVersion = '0.2.0'
    const t = makeFakeTransport(JSON.stringify(m))
    let threw = false
    try {
      await fetchManifest({ channel: 'stable', platform: 'darwin', arch: 'arm64', currentDshedVersion: '0.1.0', transport: t })
    } catch (e) { threw = true }
    ok(threw, 'older shell rejected')
  }

  console.log('\n[6] manifest body cap enforced')
  {
    const big = JSON.stringify(makeMatrix({ latest: { ...makeMatrix().latest, pad: 'x'.repeat(MAX_MANIFEST_BYTES) } }))
    const t = makeFakeTransport(big)
    let threw = false
    try {
      await fetchManifest({ channel: 'stable', platform: 'darwin', arch: 'arm64', transport: t })
    } catch (e) { threw = true }
    ok(threw, 'oversized manifest rejected')
  }

  console.log('\n[7] non-200 and invalid JSON rejected')
  {
    const t1 = makeFakeTransport('not found', { statusCode: 404 })
    let threw = false
    try { await fetchManifest({ channel: 'stable', platform: 'darwin', arch: 'arm64', transport: t1 }) } catch (e) { threw = true }
    ok(threw, 'non-200 rejected')

    const t2 = makeFakeTransport('{ not json')
    let threw2 = false
    try { await fetchManifest({ channel: 'stable', platform: 'darwin', arch: 'arm64', transport: t2 }) } catch (e) { threw2 = true }
    ok(threw2, 'invalid JSON rejected')
  }

  console.log('\n[8] unknown channel / missing platform rejected')
  {
    const t = makeFakeTransport(JSON.stringify(makeMatrix()))
    let threw = false
    try { await fetchManifest({ channel: 'beta', platform: 'darwin', arch: 'arm64', transport: t }) } catch (e) { threw = true }
    ok(threw, 'unknown channel rejected')

    let threw2 = false
    try { await fetchManifest({ channel: 'stable', transport: t }) } catch (e) { threw2 = true }
    ok(threw2, 'missing platform/arch rejected')
  }

  console.log('\n[9] fixed endpoints')
  {
    ok(STABLE_MANIFEST_URL === `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/dsh-runtime/stable-manifest.json`, 'stable URL fixed')
    ok(PREVIEW_MANIFEST_URL === `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/dsh-runtime/preview-manifest.json`, 'preview URL fixed')
  }

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('test failed:', e); process.exit(1) })
