'use strict'

/**
 * engine-manager — lifecycle management for the dsh engine subprocess.
 *
 * Responsibilities:
 *  - resolve the node runtime and dsh entry (from the package.json bin field)
 *  - spawn `dsh --profile web --port 0 --host 127.0.0.1`
 *  - port discovery (stdout regex `dsh web: http://127.0.0.1:<port>`) + `GET /` health check
 *  - crash restart (distinguish exit reasons, exponential backoff + cooldown)
 *  - exit cleanup (SIGTERM → wait exit → kill tree on timeout → verify port released)
 */

const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

// stable dsh stdout protocol (verified P3): `dsh web: http://127.0.0.1:<port>`
const PORT_RE = /dsh web:\s+http:\/\/127\.0\.0\.1:(\d+)/
// Windows first run can be slow (Defender scans unsigned node.exe + engine
// initializes workers/sandbox); 30s was too tight and killed a healthy engine.
const STARTUP_TIMEOUT_MS = 120000
const HEALTH_TIMEOUT_MS = 2000
const GRACEFUL_TIMEOUT_MS = 3000
const MAX_CONSECUTIVE_CRASHES = 5

/** resolve dsh entry from @deepseek-ai/dsh/package.json bin field (P2, no hardcoded paths) */
function resolveDshBin(base) {
  const manifest = path.join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (!pkg.bin || !pkg.bin.dsh) throw new Error('dsh package.json missing bin.dsh field')
  return path.join(base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', pkg.bin.dsh)
}

/** node runtime executable (platform-specific) */
function resolveNodeBin(base) {
  // win node package layout: node.exe at top level (no bin/ subdir); unix in bin/
  if (process.platform === 'win32') return path.join(base, 'node', 'node.exe')
  return path.join(base, 'node', 'bin', 'node')
}

class EngineManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dshHome DSH_HOME directory (defaults to app userData/dsh)
   * @param {string} [opts.nodeBin] explicit node executable path (production)
   * @param {string} [opts.dshBin] explicit dsh entry path (production)
   * @param {string} [opts.base] resource base dir used to resolve node/dsh in dev
   *
   * Production callers pass nodeBin/dshBin explicitly (resolved by the runtime
   * manager + bundled node). Dev/test callers may pass `base` to resolve them.
   * There is NO implicit discovery of resources/dsh at runtime.
   */
  constructor({ dshHome, base, nodeBin, dshBin, logger } = {}) {
    super()
    this.dshHome = dshHome || path.join(process.env.HOME || '.', '.dshed', 'dsh')
    this.logger = logger || { info: () => {}, error: () => {} }
    this.child = null
    this.port = null
    this.stopping = false
    this.consecutiveCrashes = 0
    this.restartTimer = null
    this.nodeBin = nodeBin || (base ? resolveNodeBin(base) : null)
    this.dshBin = dshBin || (base ? resolveDshBin(base) : null)
  }

  /** Start the engine, resolves with the discovered port (Promise<number>) */
  start() {
    this.stopping = false
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.dshHome, { recursive: true, mode: 0o700 })
      if (!this.nodeBin) return reject(new Error('node runtime not configured (pass nodeBin or base)'))
      if (!this.dshBin) return reject(new Error('dsh entry not configured (pass dshBin or base)'))
      if (!fs.existsSync(this.nodeBin)) return reject(new Error(`node runtime not found: ${this.nodeBin}`))
      if (!fs.existsSync(this.dshBin)) return reject(new Error(`dsh entry not found: ${this.dshBin}`))

      const child = spawn(this.nodeBin, [
        this.dshBin, '--profile', 'web', '--port', '0', '--host', '127.0.0.1',
      ], {
        cwd: this.dshHome,
        env: { ...process.env, DSH_HOME: this.dshHome },
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      this.port = null
      this.logger.info(`[engine] spawn pid=${child.pid} node=${this.nodeBin}`)

      let settled = false
      let stdoutBuf = ''
      let stderrBuf = ''

      const fail = (err) => {
        if (settled) return
        settled = true
        if (child && !child.killed) { try { child.kill('SIGTERM') } catch (e) { /* ignore */ } }
        clearTimeout(this.restartTimer)
        reject(err)
      }

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString()
        this.logger.info(`[engine][stdout] ${chunk.toString().trim()}`)
        const m = stdoutBuf.match(PORT_RE)
        if (m && !settled) {
          const port = Number(m[1])
          this._confirmHealthy(port).then(() => {
            if (settled) return
            this.port = port
            this.consecutiveCrashes = 0
            settled = true
            clearTimeout(this.restartTimer)
            resolve(port)
          }).catch((e) => {
            // port appeared but health check failed — treat as startup failure
            this.logger.error(`[engine] health check failed: ${e.message}`)
            fail(new Error(`health check failed: ${e.message}`))
          })
        }
      })

      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString()
        this.logger.info(`[engine][stderr] ${chunk.toString().trim()}`)
      })

      child.on('error', (err) => {
        this.logger.error(`[engine] spawn error: ${err.message}`)
        fail(err)
      })

      child.on('exit', (code, signal) => {
        this.logger.info(`[engine] exit code=${code} signal=${signal}`)
        this.child = null
        this.port = null
        if (!settled) {
          settled = true
          reject(new Error(`dsh failed to start (exit code=${code} signal=${signal}, stderr=${stderrBuf.slice(-500)})`))
          return
        }
        // started successfully before; exits after this point are crash/stop handling
        this._onExit(code, signal)
      })

      // startup timeout
      this.restartTimer = setTimeout(() => {
        if (!settled) fail(new Error(`dsh startup timeout (no port within ${STARTUP_TIMEOUT_MS}ms, stdout=${stdoutBuf.slice(-500)})`))
      }, STARTUP_TIMEOUT_MS)
    })
  }

  /** Health check: GET / must return 200 (P4 verified /api is 404, unusable) */
  _confirmHealthy(port) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: HEALTH_TIMEOUT_MS }, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else reject(new Error(`GET / returned ${res.statusCode}`))
      })
      req.on('timeout', () => req.destroy(new Error('health check timeout')))
      req.on('error', reject)
    })
  }

  /** Exit handling after successful start: distinguish normal exit from crash, decide restart */
  _onExit(code, signal) {
    if (this.stopping) return
    const unexpected = code !== 0 || (signal && signal !== 'SIGTERM')
    if (!unexpected) {
      this.logger.info('[engine] normal exit, no restart')
      this.emit('exit', { code, signal })
      return
    }
    this.consecutiveCrashes += 1
    this.logger.error(`[engine] unexpected exit code=${code} signal=${signal} (crash #${this.consecutiveCrashes})`)
    if (this.consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      this.logger.error('[engine] consecutive crash limit reached, stop restarting')
      this.emit('crash-loop')
      return
    }
    const delay = Math.min(1000 * 2 ** (this.consecutiveCrashes - 1), 8000)
    this.logger.info(`[engine] restarting in ${delay}ms`)
    this.restartTimer = setTimeout(() => {
      this.start().then((port) => {
        this.emit('restarted', port)
      }).catch((err) => {
        this.emit('restart-failed', err)
      })
    }, delay)
  }

  /** Graceful stop: SIGTERM → wait exit → kill tree on timeout → verify port released */
  async stop() {
    if (!this.child) return
    this.stopping = true
    clearTimeout(this.restartTimer)
    const child = this.child
    const pid = child.pid
    const port = this.port

    this.logger.info(`[engine] stopping: SIGTERM pid=${pid}`)
    const exited = new Promise((resolve) => child.once('exit', resolve))

    if (process.platform === 'win32') {
      // Windows: SIGTERM is a hard TerminateProcess anyway and does not give
      // the engine a chance to clean up its child processes (workers/sandbox);
      // kill the whole tree and WAIT for taskkill to finish — main-process exit
      // alone does not mean every descendant is gone.
      await this._killTree(pid).catch((e) => this.logger.warn(`[engine] taskkill failed: ${e.message}`))
    } else {
      child.kill('SIGTERM')
    }

    const graceful = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((r) => setTimeout(() => r('timeout'), GRACEFUL_TIMEOUT_MS)),
    ])

    if (graceful === 'timeout') {
      this.logger.warn('[engine] SIGTERM timed out, force-killing process tree')
      await this._killTree(pid).catch(() => {})
      await exited.catch(() => {})
    }

    if (port) await this._waitForPortReleased(port, 15000)
    this.emit('stopped')
    this.logger.info('[engine] stopped')
  }

  /**
   * Force-kill the process tree. Returns a Promise that resolves when the
   * kill command itself has completed (not merely been spawned).
   * Windows: taskkill /T /F; Unix: kill the process group.
   */
  _killTree(pid) {
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL') } catch (e) {
        try { process.kill(pid, 'SIGKILL') } catch (e2) { /* ignore */ }
      }
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let stderr = ''
      let killer
      try {
        killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) { return reject(e) }
      killer.stderr.on('data', (c) => { stderr += c.toString() })
      killer.once('error', reject)
      killer.once('close', (code) => {
        // 128 = target process already gone; treat as success
        if (code === 0 || code === 128) resolve()
        else reject(new Error(`taskkill exit ${code}: ${stderr.trim()}`))
      })
    })
  }

  /** Poll until the port stops accepting connections; reject on timeout. */
  _waitForPortReleased(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const check = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
          res.resume()
          req.destroy()
          if (Date.now() >= deadline) return reject(new Error(`port ${port} still accepting connections`))
          setTimeout(check, 250)
        })
        req.once('error', () => resolve())
        req.once('timeout', () => { req.destroy(); if (Date.now() >= deadline) return reject(new Error(`port ${port} still accepting connections`)); setTimeout(check, 250) })
      }
      check()
    })
  }
}

module.exports = { EngineManager, resolveDshBin, resolveNodeBin }
