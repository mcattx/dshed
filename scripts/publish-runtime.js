'use strict'

/**
 * publish-runtime — aggregate per-platform single-artifact manifests from
 * dist/runtime/ into the multi-platform matrix manifest (stable-manifest.json)
 * and emit the gh CLI commands to create releases and upload artifacts.
 *
 * Each artifact carries its own `releaseTag` (dsh-v<version>-<buildId>, where
 * buildId is platform-specific). The matrix `latest` carries only dshVersion /
 * minimumDshedVersion / releasedAt.
 *
 * Usage:
 *   node scripts/publish-runtime.js [--dry-run]
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'dist', 'runtime')
const OWNER = 'mcattx'
const REPO = 'dshed'

function log(msg) { console.log(`[publish] ${msg}`) }

/** read every *.manifest.json under dist/runtime and return their manifests */
function readArtifactManifests(outDir) {
  const manifests = []
  for (const name of fs.readdirSync(outDir)) {
    if (!name.endsWith('.manifest.json')) continue
    const m = JSON.parse(fs.readFileSync(path.join(outDir, name), 'utf8'))
    if (m.schemaVersion !== 1) throw new Error(`unexpected single-manifest schemaVersion in ${name}: ${m.schemaVersion}`)
    manifests.push(m)
  }
  if (manifests.length === 0) throw new Error(`no *.manifest.json found in ${outDir}`)
  return manifests
}

/**
 * Aggregate single-artifact manifests into the matrix envelope. All artifacts
 * must share the same dshVersion; minimumDshedVersion is the max across them.
 */
function buildMatrix(manifests) {
  const dshVersions = new Set(manifests.map((m) => m.dshVersion))
  if (dshVersions.size !== 1) throw new Error(`artifacts disagree on dshVersion: ${[...dshVersions].join(', ')}`)

  const minimumDshedVersion = manifests
    .map((m) => m.minimumDshedVersion)
    .sort().reverse()[0]

  const latest = {
    dshVersion: manifests[0].dshVersion,
    minimumDshedVersion,
    releasedAt: manifests.map((m) => m.releasedAt).sort().reverse()[0],
    artifacts: manifests.map((m) => ({
      platform: m.platform,
      arch: m.arch,
      runtimeId: m.runtimeId,
      buildId: m.buildId,
      releaseTag: m.releaseTag,
      archive: m.archive,
      sha256: m.sha256,
      size: m.size,
      extractedSize: m.extractedSize,
      extractedFileCount: m.extractedFileCount,
      entry: m.entry,
    })),
  }

  return { schemaVersion: 2, latest }
}

/** emit gh CLI commands to create a release per releaseTag and upload its artifacts */
function ghCommands(matrix) {
  const byTag = new Map()
  for (const a of matrix.latest.artifacts) {
    if (!byTag.has(a.releaseTag)) byTag.set(a.releaseTag, [])
    byTag.get(a.releaseTag).push(a)
  }
  const lines = []
  for (const [tag, arts] of byTag) {
    lines.push(`gh release create ${tag} --repo ${OWNER}/${REPO} --title "${tag}" --notes "dsh ${matrix.latest.dshVersion}"`)
    for (const a of arts) {
      lines.push(`gh release upload ${tag} --repo ${OWNER}/${REPO} "dist/runtime/${a.archive}"`)
    }
  }
  return lines
}

function main() {
  const manifests = readArtifactManifests(OUT)
  const matrix = buildMatrix(manifests)

  const matrixPath = path.join(OUT, 'stable-manifest.json')
  fs.writeFileSync(matrixPath, JSON.stringify(matrix, null, 2))
  log(`matrix manifest: ${matrixPath} (${matrix.latest.artifacts.length} artifacts)`)

  const commands = ghCommands(matrix)
  log('gh release commands:')
  for (const c of commands) console.log(`  ${c}`)
}

main()
