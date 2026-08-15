'use strict'

/**
 * verify — M1 smoke verification (pure Node, no Electron).
 *
 * Covers the locally verifiable M1 acceptance items:
 *  - engine start + port discovery (stdout regex) + GET / health check
 *  - auth proxy: no token / wrong token → 403; correct token → 200; API passes
 *  - forged Host still reachable through the proxy (proves Host rewrite works)
 *  - WS: wrong Origin → 403; correct Origin → allowed
 *  - lifecycle: SIGTERM graceful exit + port release
 *  - crash restart: kill -9 → auto restart on a new port
 */

const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { WebSocket } = require('ws')
const { EngineManager } = require('../src/engine-manager')
const { AuthProxy } = require('../src/auth-proxy')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`) }
  else { failed += 1; console.log(`  ❌ ${name}`) }
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers, timeout: 8000 }, (res) => {
      res.resume()
      res.on('end', () => resolve({ statusCode: res.statusCode }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

function httpGetHost(port, pathname, headers) {
  // connect to 127.0.0.1 but forge the Host header
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers, timeout: 8000 }, (res) => {
      res.resume()
      res.on('end', () => resolve({ statusCode: res.statusCode }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

function httpPost(port, pathname, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST', headers, timeout: 8000,
    }, (res) => {
      res.resume()
      res.on('end', () => resolve({ statusCode: res.statusCode }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

function portReleased(port, timeoutMs = 5000) {
  // poll until the port stops accepting connections; Windows releases socket
  // handles slower than macOS after a process stop
  const deadline = Date.now() + timeoutMs
  return (async function poll() {
    const released = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => {
        req.destroy()
        resolve(false)
      })
      req.on('error', () => resolve(true))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })
    if (released) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
    return poll()
  })()
}

function wsUpgrade(port, pathname, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers, handshakeTimeout: 6000 })
    const done = (r) => { try { ws.terminate() } catch (e) { /* ignore */ } resolve(r) }
    ws.on('open', () => done({ status: 'open' }))
    ws.on('unexpected-response', (req, res) => done({ status: 'http', statusCode: res.statusCode }))
    ws.on('error', () => done({ status: 'error' }))
  })
}

async function main() {
  const dshHome = path.join(os.tmpdir(), `dshed-verify-${Date.now()}`)
  console.log('=== M1 smoke verification ===')
  console.log(`DSH_HOME: ${dshHome}`)

  console.log('\n[1] engine start / port discovery / health check')
  const engine = new EngineManager({ dshHome })
  const port = await engine.start()
  ok(Number.isInteger(port) && port > 0, `port discovered: ${port}`)
  const health = await httpGet(port, '/')
  ok(health.statusCode === 200, `GET / health check 200 (got ${health.statusCode})`)

  console.log('\n[2] auth proxy (HTTP)')
  const proxy = new AuthProxy(port)
  const proxyPort = await proxy.start()

  const noToken = await httpGet(proxyPort, '/')
  ok(noToken.statusCode === 403, `no token → 403 (got ${noToken.statusCode})`)
  const badToken = await httpGet(proxyPort, '/', { 'X-dshed-Token': 'wrong-token' })
  ok(badToken.statusCode === 403, `wrong token → 403 (got ${badToken.statusCode})`)
  const goodToken = await httpGet(proxyPort, '/', { 'X-dshed-Token': proxy.token })
  ok(goodToken.statusCode === 200, `correct token → 200 (got ${goodToken.statusCode})`)
  const apiViaProxy = await httpGet(proxyPort, '/api/sessions', { 'X-dshed-Token': proxy.token })
  ok(apiViaProxy.statusCode !== 403, `API passes through proxy (got ${apiViaProxy.statusCode})`)
  const forgedHost = await httpGetHost(proxyPort, '/', { Host: 'evil.example.com', 'X-dshed-Token': proxy.token })
  ok(forgedHost.statusCode === 200, `forged Host rewritten by proxy → 200 (got ${forgedHost.statusCode}, proves Host rewrite)`)
  // POST regression: dsh enforces a CSRF Origin check on mutations
  // (Origin=evil → 403); the browser origin is the proxy origin, so the proxy
  // rewrites Origin to dsh's when forwarding (pickDirectory 403 fix, 2026-08)
  // pickDirectory depends on the native directory picker (GUI dialog); in a
  // headless CI env it hangs waiting for user interaction. Skip on CI — the
  // Origin-rewrite behavior is exercised locally where a real picker exists.
  if (!process.env.CI) {
    const postBody = JSON.stringify({ type: 'client-request', rpcId: 'verify-post', method: 'host.pickDirectory', payload: {} })
    const postOk = await httpPost(proxyPort, '/api/host.pickDirectory', {
      'X-dshed-Token': proxy.token,
      'Origin': `http://127.0.0.1:${proxyPort}`, // simulate the browser origin
      'content-type': 'application/json',
    }, postBody)
    ok(postOk.statusCode === 200, `POST /api/host.pickDirectory via proxy 200 (got ${postOk.statusCode}, Origin rewritten)`)
  }

  console.log('\n[3] auth proxy (WS)')
  const wsEvil = await wsUpgrade(proxyPort, '/api/events.mux', { Origin: 'http://evil.example.com', 'X-dshed-Token': proxy.token })
  ok(wsEvil.status === 'http' && wsEvil.statusCode === 403, `WS wrong Origin → 403 (got ${JSON.stringify(wsEvil)})`)
  const wsOk = await wsUpgrade(proxyPort, '/api/events.mux', { Origin: `http://127.0.0.1:${proxyPort}`, 'X-dshed-Token': proxy.token })
  ok(wsOk.status === 'open' || (wsOk.status === 'http' && wsOk.statusCode !== 403), `WS correct Origin → allowed (got ${JSON.stringify(wsOk)})`)

  console.log('\n[4] lifecycle: SIGTERM graceful exit + port release')
  await proxy.stop()
  await engine.stop()
  ok(await portReleased(port), `dsh port ${port} released after SIGTERM`)

  console.log('\n[5] crash restart: kill -9 → auto restart on a new port')
  const portA = await engine.start()
  // Windows has no process groups (engine is not detached there); kill the
  // pid directly. Unix uses the negative pid to signal the whole group.
  const killPid = process.platform === 'win32' ? engine.child.pid : -engine.child.pid
  process.kill(killPid, 'SIGKILL')
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('restart timeout')), 25000)
    engine.once('restarted', (p) => {
      clearTimeout(t)
      console.log(`  restarted on port: ${p}`)
      resolve()
    })
  })
  ok(engine.port !== portA, `port changed after restart (${portA} → ${engine.port})`)
  await engine.stop()
  ok(await portReleased(engine.port), 'port released after restart')

  console.log(`\n=== result: ${passed} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('verification failed:', e); process.exit(1) })
