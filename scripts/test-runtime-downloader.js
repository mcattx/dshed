'use strict'

/**
 * test-runtime-downloader — integration tests for RuntimeDownloader against a
 * local HTTP fixture server. Covers full download, Range resume, If-Range
 * mismatch, no-Range degradation, 416 completion, size/sha256 mismatch, retry,
 * cancellation and over-size rejection.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { download, httpTransport, parseContentRange } = require('../src/runtime-downloader')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dshed-dl-test-'))
function tmpdir(name) {
  const d = path.join(tmpRoot, name || `t-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** minimal AbortSignal-compatible object (Node 14 lacks global AbortController) */
function makeAbortSignal() {
  let aborted = false
  const listeners = new Set()
  return {
    get aborted() { return aborted },
    addEventListener(type, fn) { if (type === 'abort') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'abort') listeners.delete(fn) },
    abort() { if (!aborted) { aborted = true; for (const fn of listeners) fn() } },
  }
}

/**
 * fixture HTTP server. Options:
 *   supportRange  — advertise Accept-Ranges and honor Range (default true)
 *   etag          — ETag value (default '"v1"')
 *   failFirst     — destroy the first N requests (simulate network error)
 *   onRequest     — callback(req) per request
 */
function createServer({ supportRange = true, etag = '"v1"', failFirst = 0, onRequest } = {}) {
  const content = Buffer.from('0123456789abcdef'.repeat(256)) // 4096 bytes
  let failures = failFirst
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (onRequest) onRequest(req)
      if (failures > 0) { failures -= 1; req.socket.destroy(); return }
      const range = req.headers.range
      const ifRange = req.headers['if-range']
      const m = range && range.match(/^bytes=(\d+)-$/)
      if (supportRange && m) {
        const start = +m[1]
        if (start >= content.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${content.length}` })
          res.end()
          return
        }
        if (ifRange && etag && ifRange !== etag) {
          res.writeHead(200, { 'Content-Length': content.length, 'ETag': etag, 'Accept-Ranges': 'bytes' })
          res.end(content)
          return
        }
        const end = content.length - 1
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${content.length}`,
          'Content-Length': end - start + 1,
          'ETag': etag,
          'Accept-Ranges': 'bytes',
        })
        res.end(content.slice(start))
        return
      }
      res.writeHead(200, {
        'Content-Length': content.length,
        'ETag': etag,
        ...(supportRange ? { 'Accept-Ranges': 'bytes' } : {}),
      })
      res.end(content)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, content, port, url: `http://127.0.0.1:${port}/file`, etag })
    })
  })
}

async function main() {
  console.log('=== runtime-downloader tests ===')

  console.log('\n[1] full download (200) + sha256 verify')
  {
    const { server, content, url } = await createServer()
    const dir = tmpdir('full')
    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, 'downloaded full size')
    ok(fs.readFileSync(r.filePath).equals(content), 'downloaded bytes match')
    ok(!fs.existsSync(path.join(dir, 'artifact.tar.gz.part')), 'no .part left after success')
    ok(!fs.existsSync(path.join(dir, 'artifact.tar.gz.part.meta')), 'no .part.meta left after success')
    server.close()
  }

  console.log('\n[2] resume via 206 (pre-existing .part)')
  {
    const { server, content, url, etag } = await createServer()
    const dir = tmpdir('resume')
    const partPath = path.join(dir, 'artifact.tar.gz.part')
    const metaPath = path.join(dir, 'artifact.tar.gz.part.meta')
    // simulate a half-downloaded file + meta
    const half = content.slice(0, 2048)
    fs.writeFileSync(partPath, half)
    fs.writeFileSync(metaPath, JSON.stringify({ url, expectedSize: content.length, expectedSha256: sha256(content), etag }))

    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, 'resumed to full size')
    ok(fs.readFileSync(r.filePath).equals(content), 'resumed bytes match')
    server.close()
  }

  console.log('\n[3] 416 completion (already have full file as .part)')
  {
    const { server, content, url, etag } = await createServer()
    const dir = tmpdir('done')
    const partPath = path.join(dir, 'artifact.tar.gz.part')
    fs.writeFileSync(partPath, content)
    fs.writeFileSync(path.join(dir, 'artifact.tar.gz.part.meta'), JSON.stringify({ url, expectedSize: content.length, expectedSha256: sha256(content), etag }))

    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, '416 completion returns full size')
    ok(fs.existsSync(r.filePath), 'final file renamed into place')
    server.close()
  }

  console.log('\n[4] If-Range mismatch → 200 restart from zero')
  {
    const { server, content, url } = await createServer({ etag: '"v2"' })
    const dir = tmpdir('ifrange')
    const partPath = path.join(dir, 'artifact.tar.gz.part')
    // stale .part with old etag "v1"; server now has "v2"
    fs.writeFileSync(partPath, content.slice(0, 100))
    fs.writeFileSync(path.join(dir, 'artifact.tar.gz.part.meta'), JSON.stringify({ url, expectedSize: content.length, expectedSha256: sha256(content), etag: '"v1"' }))

    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, 'restarted from zero after If-Range mismatch')
    ok(fs.readFileSync(r.filePath).equals(content), 'bytes correct after restart')
    server.close()
  }

  console.log('\n[5] no Range support → full download')
  {
    const { server, content, url } = await createServer({ supportRange: false })
    const dir = tmpdir('norange')
    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, 'full download without Range support')
    server.close()
  }

  console.log('\n[6] size mismatch rejected')
  {
    const { server, content, url } = await createServer()
    const dir = tmpdir('size-mismatch')
    let threw = false
    try {
      await download({
        url, destDir: dir, fileName: 'artifact.tar.gz',
        expectedSize: content.length + 1, expectedSha256: sha256(content), transport: httpTransport,
      })
    } catch (e) { threw = true }
    ok(threw, 'size mismatch rejected')
    server.close()
  }

  console.log('\n[7] sha256 mismatch deletes .part and rejects')
  {
    const { server, content, url } = await createServer()
    const dir = tmpdir('sha-mismatch')
    let threw = false
    try {
      await download({
        url, destDir: dir, fileName: 'artifact.tar.gz',
        expectedSize: content.length, expectedSha256: sha256(Buffer.from('wrong')), transport: httpTransport,
      })
    } catch (e) { threw = true }
    ok(threw, 'sha256 mismatch rejected')
    ok(!fs.existsSync(path.join(dir, 'artifact.tar.gz.part')), '.part deleted on sha256 mismatch')
    ok(!fs.existsSync(path.join(dir, 'artifact.tar.gz')), 'no final file on sha256 mismatch')
    server.close()
  }

  console.log('\n[8] retry after transient network error')
  {
    const { server, content, url } = await createServer({ failFirst: 2 })
    const dir = tmpdir('retry')
    const r = await download({
      url, destDir: dir, fileName: 'artifact.tar.gz',
      expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport,
    })
    ok(r.size === content.length, 'retried after transient errors and succeeded')
    server.close()
  }

  console.log('\n[9] cancellation via signal')
  {
    const { server, content, url } = await createServer({ onRequest: (req) => { if (req.headers.range) return; signal.abort() } })
    const dir = tmpdir('cancel')
    const signal = makeAbortSignal()
    let threw = false
    try {
      await download({
        url, destDir: dir, fileName: 'artifact.tar.gz',
        expectedSize: content.length, expectedSha256: sha256(content), transport: httpTransport, signal,
      })
    } catch (e) { threw = true }
    ok(threw, 'download aborted throws')
    server.close()
  }

  console.log('\n[10] over-size content rejected')
  {
    const { server, content, url } = await createServer()
    const dir = tmpdir('oversize')
    let threw = false
    try {
      await download({
        url, destDir: dir, fileName: 'artifact.tar.gz',
        expectedSize: content.length - 10, expectedSha256: sha256(content), transport: httpTransport,
      })
    } catch (e) { threw = true }
    ok(threw, 'over-size content rejected')
    server.close()
  }

  console.log('\n[11] parseContentRange')
  {
    const c = parseContentRange('bytes 100-199/1000')
    ok(c && c.start === 100 && c.end === 199 && c.total === 1000, 'parses Content-Range')
    ok(parseContentRange('garbage') === null, 'rejects malformed Content-Range')
  }

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('test failed:', e); process.exit(1) })
