'use strict'

/**
 * runtime-downloader — downloads a dsh runtime artifact to a `.part` file with
 * HTTP Range + If-Range resume, then verifies size + SHA-256 and atomically
 * renames into place. Byte delivery only: no extraction, no activation.
 *
 * The network transport is dependency-injected: production injects an HTTPS
 * transport (enforcing https + host whitelist + redirect limit), tests inject a
 * plain-HTTP transport against a local fixture server. The downloader itself is
 * transport-agnostic and never trusts a URL path as a local filename.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')

const REDIRECT_LIMIT = 5
const ALLOWED_HOSTS = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
])

const DEFAULT_CONNECT_TIMEOUT = 10000
const DEFAULT_IDLE_TIMEOUT = 30000
const DEFAULT_MAX_RETRIES = 3

// ————————————————————————————————— util ————————————————————————————————————

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch (e) { return null }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** parse `Content-Range: bytes <start>-<end>/<total>` */
function parseContentRange(header) {
  if (typeof header !== 'string') return null
  const m = header.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/)
  if (!m) return null
  return { start: +m[1], end: +m[2], total: +m[3] }
}

// ————————————————————————————————— transport ————————————————————————————————

function checkUrl(urlObj) {
  if (urlObj.protocol !== 'https:') throw new Error(`non-HTTPS URL forbidden: ${urlObj.protocol}`)
  if (!ALLOWED_HOSTS.has(urlObj.hostname)) throw new Error(`host not allowed: ${urlObj.hostname}`)
  if (urlObj.username || urlObj.password) throw new Error('URL must not contain userinfo')
}

function httpsRequestOnce(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    checkUrl(u)
    const req = https.request(u, { method: 'GET', headers }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers, stream: res })
    })
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')))
    }
    req.end()
  })
}

/** HTTPS transport with host whitelist + redirect limit (production default) */
async function httpsTransportRequest(url, { headers, signal }) {
  let current = url
  for (let i = 0; i <= REDIRECT_LIMIT; i++) {
    const res = await httpsRequestOnce(current, { headers, signal })
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.stream.resume() // discard the redirect body
      current = new URL(res.headers.location, current).toString()
      checkUrl(new URL(current))
      continue
    }
    return res
  }
  throw new Error(`too many redirects (${REDIRECT_LIMIT})`)
}

function httpRequestOnce(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(u, { method: 'GET', headers }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers, stream: res })
    })
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')))
    }
    req.end()
  })
}

const httpsTransport = { request: httpsTransportRequest }
const httpTransport = { request: httpRequestOnce }

// ————————————————————————————————— download ——————————————————————————————————

/** write a response body to partPath (append when resumeFrom>0), enforcing size + idle timeout */
function writeResponseToPart(res, partPath, startFrom, expectedSize, { signal, idleTimeout, logger }) {
  const log = logger || { warn: () => {}, error: () => {} }
  return new Promise((resolve, reject) => {
    const flags = startFrom > 0 ? 'a' : 'w'
    const ws = fs.createWriteStream(partPath, { flags })
    let bytes = startFrom
    let idleTimer = null
    let settled = false

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      res.destroy()
      ws.destroy()
      reject(err)
    }
    const onAbort = () => fail(new Error('aborted'))
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(new Error('idle timeout')), idleTimeout)
    }

    if (signal) {
      if (signal.aborted) { fail(new Error('aborted')); return }
      signal.addEventListener('abort', onAbort)
    }

    res.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > expectedSize) { fail(new Error(`download exceeds expected size ${expectedSize}`)); return }
      ws.write(chunk)
      resetIdle()
    })
    res.on('end', () => {
      cleanup()
      ws.end(() => resolve(bytes))
    })
    res.on('error', fail)
    ws.on('error', fail)
    resetIdle()
  })
}

function isAbortError(err, signal) {
  return (signal && signal.aborted) || /aborted|abort/i.test(err && err.message)
}

function retryableError(err, signal) {
  // cancellation must never be retried; size/sha256 mismatch, over-size and
  // trust violations are fatal too. Only transient network/stream errors retry.
  if (isAbortError(err, signal)) return false
  return !/size mismatch|sha256 mismatch|exceeds expected size|not allowed|forbidden/i.test(err.message)
}

/** fileName must be a single safe basename (no separators, no `..`, no NUL) */
function assertSafeFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0) throw new Error('invalid fileName')
  if (fileName.indexOf('\0') !== -1) throw new Error('fileName must not contain NUL')
  if (fileName.indexOf('/') !== -1 || fileName.indexOf('\\') !== -1) throw new Error('fileName must not contain path separators')
  if (fileName === '.' || fileName === '..' || fileName.includes('..')) throw new Error('fileName must not contain `..`')
  return fileName
}

/** assert child resolves inside parent (blocks traversal out of destDir) */
function assertInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c !== p && !c.startsWith(p + path.sep)) throw new Error(`path escapes destDir: ${child}`)
}

/**
 * Download `url` to `destDir/fileName` with resume, then verify size + sha256.
 * Returns { filePath, size, sha256 }. The transport is injected; production
 * passes the HTTPS transport, tests pass the local-HTTP transport.
 */
async function download(options) {
  const {
    url, destDir, fileName, expectedSize, expectedSha256,
    transport = httpsTransport, signal, logger,
    connectTimeout = DEFAULT_CONNECT_TIMEOUT,
    idleTimeout = DEFAULT_IDLE_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} }
  assertSafeFileName(fileName)
  fs.mkdirSync(destDir, { recursive: true })

  const partPath = path.join(destDir, `${fileName}.part`)
  const metaPath = path.join(destDir, `${fileName}.part.meta`)
  const finalPath = path.join(destDir, fileName)
  assertInside(destDir, partPath)
  assertInside(destDir, metaPath)
  assertInside(destDir, finalPath)

  // already downloaded + verified
  if (fs.existsSync(finalPath)) {
    const stat = fs.statSync(finalPath)
    if (stat.size === expectedSize && (await sha256File(finalPath)) === expectedSha256) {
      log.info(`[downloader] ${fileName} already downloaded and verified`)
      return { filePath: finalPath, size: stat.size, sha256: expectedSha256 }
    }
    log.warn(`[downloader] ${fileName} exists but invalid, redownloading`)
    fs.rmSync(finalPath, { force: true })
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const r = await downloadAttempt({
        url, partPath, metaPath, finalPath, fileName,
        expectedSize, expectedSha256, transport, signal, log, connectTimeout, idleTimeout,
      })
      return r
    } catch (err) {
      if (retryableError(err, signal) && attempt < maxRetries) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 8000)
        log.warn(`[downloader] attempt ${attempt + 1} failed (${err.message}), retrying in ${backoff}ms`)
        await sleep(backoff)
        continue
      }
      throw err
    }
  }
}

/** one complete download pass (resume-aware), returns { filePath, size, sha256 } */
async function downloadAttempt(opts) {
  const { url, partPath, metaPath, finalPath, fileName, expectedSize, expectedSha256, transport, signal, log, connectTimeout, idleTimeout } = opts

  let meta = readJson(metaPath)
  let resumeFrom = 0
  if (meta && fs.existsSync(partPath)) {
    const partSize = fs.statSync(partPath).size
    if (meta.expectedSize === expectedSize && meta.expectedSha256 === expectedSha256 && partSize <= expectedSize) {
      resumeFrom = partSize
    } else {
      log.warn(`[downloader] stale .part for ${fileName}, restarting from zero`)
      fs.rmSync(partPath, { force: true })
      fs.rmSync(metaPath, { force: true })
      meta = null
      resumeFrom = 0
    }
  }

  const headers = {}
  if (resumeFrom > 0) {
    headers.Range = `bytes=${resumeFrom}-`
    if (meta && meta.etag) headers['If-Range'] = meta.etag
    else if (meta && meta.lastModified) headers['If-Range'] = meta.lastModified
  }

  const res = await requestWithConnectTimeout(transport, url, headers, signal, connectTimeout)

  // 416: range not satisfiable — if we already have the whole file, it is done
  if (res.statusCode === 416) {
    res.stream.resume()
    if (resumeFrom === expectedSize) {
      return verifyAndFinalize(partPath, finalPath, fileName, expectedSize, expectedSha256, log)
    }
    throw new Error(`unexpected 416 (resume ${resumeFrom}, expected ${expectedSize})`)
  }

  // 200: no range support, or If-Range mismatch — restart from zero
  if (res.statusCode === 200) {
    if (resumeFrom > 0) {
      res.stream.resume()
      fs.rmSync(partPath, { force: true })
      resumeFrom = 0
    }
    const total = res.headers['content-length'] ? +res.headers['content-length'] : null
    if (total != null && total !== expectedSize) {
      res.stream.resume()
      throw new Error(`size mismatch: expected ${expectedSize}, got ${total}`)
    }
    writeMeta(metaPath, { url, expectedSize, expectedSha256, etag: res.headers.etag, lastModified: res.headers['last-modified'] })
    await writeResponseToPart(res.stream, partPath, resumeFrom, expectedSize, { signal, idleTimeout, logger: log })
    return verifyAndFinalize(partPath, finalPath, fileName, expectedSize, expectedSha256, log)
  }

  // 206: partial content — verify Content-Range start matches our resume point
  if (res.statusCode === 206) {
    const cr = parseContentRange(res.headers['content-range'])
    if (!cr) { res.stream.resume(); throw new Error('missing Content-Range on 206') }
    if (cr.start !== resumeFrom) {
      res.stream.resume()
      throw new Error(`Content-Range start ${cr.start} != resume ${resumeFrom}, restarting`)
    }
    if (cr.total !== expectedSize) {
      res.stream.resume()
      throw new Error(`size mismatch: Content-Range total ${cr.total}, expected ${expectedSize}`)
    }
    writeMeta(metaPath, { url, expectedSize, expectedSha256, etag: res.headers.etag, lastModified: res.headers['last-modified'] })
    await writeResponseToPart(res.stream, partPath, resumeFrom, expectedSize, { signal, idleTimeout, logger: log })
    return verifyAndFinalize(partPath, finalPath, fileName, expectedSize, expectedSha256, log)
  }

  res.stream.resume()
  throw new Error(`unexpected HTTP status ${res.statusCode}`)
}

function writeMeta(metaPath, meta) {
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2))
}

async function verifyAndFinalize(partPath, finalPath, fileName, expectedSize, expectedSha256, log) {
  const size = fs.statSync(partPath).size
  if (size !== expectedSize) {
    throw new Error(`size mismatch: expected ${expectedSize}, got ${size}`)
  }
  const digest = await sha256File(partPath)
  if (digest !== expectedSha256) {
    fs.rmSync(partPath, { force: true })
    fs.rmSync(`${partPath}.meta`, { force: true })
    throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${digest}`)
  }
  fs.renameSync(partPath, finalPath)
  fs.rmSync(`${partPath}.meta`, { force: true })
  log.info(`[downloader] ${fileName} downloaded and verified (${size} bytes)`)
  return { filePath: finalPath, size, sha256: digest }
}

/** compose a user signal with a locally-abortable signal */
function createCancellableSignal(userSignal) {
  let aborted = false
  const listeners = new Set()
  const signal = {
    get aborted() { return aborted },
    addEventListener(type, fn) { if (type === 'abort') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'abort') listeners.delete(fn) },
    abort() { if (!aborted) { aborted = true; for (const fn of listeners) fn() } },
  }
  if (userSignal) {
    if (userSignal.aborted) signal.abort()
    else userSignal.addEventListener('abort', () => signal.abort())
  }
  return signal
}

/**
 * Request with a connect timeout that actually cancels the underlying request:
 * on timeout it aborts the composed signal (destroying the socket/stream) and
 * only then rejects, so no half-open request survives into the retry loop.
 */
function requestWithConnectTimeout(transport, url, headers, userSignal, connectTimeout) {
  const signal = createCancellableSignal(userSignal)
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal.abort() // destroy the in-flight request
      reject(new Error('connect timeout'))
    }, connectTimeout)

    transport.request(url, { headers, signal }).then(
      (res) => {
        if (settled) { if (res && res.stream) res.stream.destroy(); return }
        settled = true
        clearTimeout(timer)
        resolve(res)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

module.exports = {
  download,
  httpsTransport,
  httpTransport,
  parseContentRange,
  REDIRECT_LIMIT,
  ALLOWED_HOSTS,
}
