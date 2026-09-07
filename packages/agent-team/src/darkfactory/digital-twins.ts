/**
 * Digital Twins (DF-09)
 *
 * Pinned contract fixture bundles, containerized/loopback HTTP stubs,
 * seeded test data, atomic loopback port binding, lifecycle deadline enforcement,
 * and explicit NOT_APPLICABLE recording when specs have no external dependencies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import { digestJson } from './json.ts'
import type { StageResultV1 } from './contracts/verification.ts'
import type { ArtifactRef } from './contracts/common.ts'

export interface TwinRouteDefinition {
  method: string
  path: string
  headers?: Record<string, string>
  bodyPattern?: string | Record<string, unknown>
  response: {
    status: number
    headers?: Record<string, string>
    body: unknown
  }
}

export interface TwinContractFixture {
  id: string
  serviceName: string
  version: string
  imageOrToolDigest: `sha256:${string}`
  seededData?: Record<string, unknown>
  routes: TwinRouteDefinition[]
  readinessCheck: {
    path: string
    expectedStatus: number
    timeoutMs?: number
    responseStatus?: number
  }
  lifecycleDeadlineMs?: number // Default: 300_000 (5 minutes)
}

export interface RecordedInteraction {
  timestamp: string
  method: string
  path: string
  headers: Record<string, string | string[]>
  body: unknown
  matchedRouteIndex: number
  statusSent: number
}

export interface DigitalTwinInstance {
  fixture: TwinContractFixture
  server: Server
  port: number
  baseUrl: string
  interactionLog: RecordedInteraction[]
  stop: () => Promise<void>
}

export interface TwinExecutionOptions {
  projectId: string
  policyRevision?: number
  attemptId: string
  generation: number
  spec: {
    id: string
    specDigest: `sha256:${string}`
    hasExternalDependencies: boolean
    requiredTwins?: TwinContractFixture[]
  }
  sandboxesDir?: string
  harness?: (twinUrls: Record<string, string>) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  signal?: AbortSignal
}

export interface TwinExecutionResult {
  stageResult: {
    id: string
    stage: 'twins'
    result: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE'
    definitionRevision: number
    startedAt: string
    endedAt: string
    exitCondition: string
    artifacts: ArtifactRef[]
  }
  decision: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_APPLICABLE'
  twinUrls: Record<string, string>
  reason?: string | undefined
}

/**
 * Start a local loopback Digital Twin HTTP server bound atomically to 127.0.0.1:0.
 */
export async function startDigitalTwinServer(
  fixture: TwinContractFixture,
  options?: {
    attemptId?: string | undefined
    generation?: number | undefined
    sandboxesDir?: string | undefined
    signal?: AbortSignal | undefined
  },
): Promise<DigitalTwinInstance> {
  const lifecycleDeadlineMs = fixture.lifecycleDeadlineMs ?? 300_000 // 5 minutes
  const interactionLog: RecordedInteraction[] = []
  const sockets = new Set<import('node:net').Socket>()

  let lifecycleTimer: NodeJS.Timeout | undefined

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Deny external / foreign host headers or remote connections
    const remoteAddr = req.socket.remoteAddress
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'FORBIDDEN_EXTERNAL_ACCESS' }))
      return
    }

    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    const path = url.pathname

    // Read body if present
    let rawBody = ''
    for await (const chunk of req) {
      rawBody += chunk.toString()
    }

    let parsedBody: unknown
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }

    // Readiness check endpoint
    if (path === fixture.readinessCheck.path && method === 'GET') {
      const respStatus = fixture.readinessCheck.responseStatus ?? fixture.readinessCheck.expectedStatus
      res.writeHead(respStatus, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: respStatus === fixture.readinessCheck.expectedStatus ? 'healthy' : 'unhealthy',
          service: fixture.serviceName,
        }),
      )
      return
    }

    // Match route
    let matchedIndex = -1
    for (let i = 0; i < fixture.routes.length; i++) {
      const route = fixture.routes[i]!
      if (route.method.toUpperCase() !== method.toUpperCase()) continue
      if (route.path !== path) continue

      // If headers required, match them
      if (route.headers) {
        let headersMatch = true
        for (const [k, v] of Object.entries(route.headers)) {
          const reqHeader = req.headers[k.toLowerCase()]
          if (typeof reqHeader === 'string' && reqHeader.toLowerCase() !== v.toLowerCase()) {
            headersMatch = false
            break
          }
        }
        if (!headersMatch) continue
      }

      // If bodyPattern specified, match body
      if (route.bodyPattern !== undefined) {
        if (typeof route.bodyPattern === 'string') {
          if (rawBody !== route.bodyPattern) continue
        } else if (typeof route.bodyPattern === 'object' && route.bodyPattern !== null) {
          if (typeof parsedBody !== 'object' || parsedBody === null) continue
          let bodyMatch = true
          for (const [k, v] of Object.entries(route.bodyPattern)) {
            if ((parsedBody as Record<string, unknown>)[k] !== v) {
              bodyMatch = false
              break
            }
          }
          if (!bodyMatch) continue
        }
      }

      matchedIndex = i
      break
    }

    const sanitizedHeaders: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) sanitizedHeaders[k] = v
    }

    if (matchedIndex !== -1) {
      const route = fixture.routes[matchedIndex]!
      const status = route.response.status
      const headers = { 'content-type': 'application/json', ...(route.response.headers ?? {}) }
      interactionLog.push({
        timestamp: new Date().toISOString(),
        method,
        path,
        headers: sanitizedHeaders,
        body: parsedBody ?? null,
        matchedRouteIndex: matchedIndex,
        statusSent: status,
      })
      res.writeHead(status, headers)
      const respContent = typeof route.response.body === 'string'
        ? route.response.body
        : JSON.stringify(route.response.body)
      res.end(respContent)
    } else {
      interactionLog.push({
        timestamp: new Date().toISOString(),
        method,
        path,
        headers: sanitizedHeaders,
        body: parsedBody ?? null,
        matchedRouteIndex: -1,
        statusSent: 404,
      })
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'UNMATCHED_TWIN_INTERACTION', method, path }))
    }
  })

  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })

  // Bind atomically to loopback ephemeral port
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })

  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to obtain loopback address for digital twin server')
  }
  const port = addr.port
  const baseUrl = `http://127.0.0.1:${port}`

  // Persist ownership metadata if sandboxesDir provided
  if (options?.sandboxesDir) {
    const twinDir = join(options.sandboxesDir, `twin-${fixture.serviceName}-${port}`)
    await mkdir(twinDir, { recursive: true })
    await writeFile(
      join(twinDir, 'sandbox.json'),
      JSON.stringify({
        attemptId: options.attemptId ?? 'unknown',
        generation: options.generation ?? 1,
        pid: process.pid,
        port,
        service: fixture.serviceName,
        createdAt: new Date().toISOString(),
      }),
    )
  }

  let closed = false
  const stop = async () => {
    if (closed) return
    closed = true
    if (lifecycleTimer) clearTimeout(lifecycleTimer)
    for (const s of sockets) {
      s.destroy()
    }
    sockets.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  // 5-minute lifecycle deadline: automatically stop if exceeded
  lifecycleTimer = setTimeout(() => {
    stop().catch(() => {})
  }, lifecycleDeadlineMs)

  if (options?.signal) {
    options.signal.addEventListener('abort', () => {
      stop().catch(() => {})
    })
  }

  return {
    fixture,
    server,
    port,
    baseUrl,
    interactionLog,
    stop,
  }
}

/**
 * Execute the Dark Factory Digital Twins Verification Stage (DF-09).
 */
export async function executeTwinsStage(options: TwinExecutionOptions): Promise<TwinExecutionResult> {
  const startedAt = new Date().toISOString()
  const {
    projectId,
    policyRevision = 1,
    attemptId,
    generation,
    spec,
    sandboxesDir,
    harness,
    signal,
  } = options

  const stageId = `twins-${attemptId}`

  // 1. If spec has no external dependencies, record explicit NOT_APPLICABLE result
  if (!spec.hasExternalDependencies) {
    const endedAt = new Date().toISOString()
    return {
      stageResult: {
        id: stageId,
        stage: 'twins',
        result: 'NOT_APPLICABLE',
        definitionRevision: policyRevision,
        startedAt,
        endedAt,
        exitCondition: 'NO_EXTERNAL_DEPENDENCY',
        artifacts: [],
      },
      decision: 'NOT_APPLICABLE',
      twinUrls: {},
      reason: 'Spec declares zero external dependencies; twins recorded NOT_APPLICABLE',
    }
  }

  // 2. If spec requires external dependencies, verify twin contracts are present and valid
  const requiredTwins = spec.requiredTwins ?? []
  if (requiredTwins.length === 0) {
    const endedAt = new Date().toISOString()
    return {
      stageResult: {
        id: stageId,
        stage: 'twins',
        result: 'FAILED',
        definitionRevision: policyRevision,
        startedAt,
        endedAt,
        exitCondition: 'MISSING_OR_STALE_CONTRACT',
        artifacts: [],
      },
      decision: 'FAILED',
      twinUrls: {},
      reason: 'Spec requires external dependencies but twin contracts are missing or stale',
    }
  }

  // 3. Start loopback digital twins
  const instances: DigitalTwinInstance[] = []
  const twinUrls: Record<string, string> = {}

  try {
    for (const fixture of requiredTwins) {
      const instance = await startDigitalTwinServer(fixture, {
        attemptId,
        generation,
        sandboxesDir,
        signal,
      })
      instances.push(instance)
      twinUrls[fixture.serviceName] = instance.baseUrl
    }

    // 4. Verify readiness checks
    for (const inst of instances) {
      const readinessUrl = `${inst.baseUrl}${inst.fixture.readinessCheck.path}`
      const timeoutMs = inst.fixture.readinessCheck.timeoutMs ?? 5000
      const start = Date.now()
      let healthy = false

      while (Date.now() - start < timeoutMs) {
        try {
          const res = await fetch(readinessUrl)
          if (res.status === inst.fixture.readinessCheck.expectedStatus) {
            healthy = true
            break
          }
        } catch {
          // Retry until timeout
        }
        await new Promise((r) => setTimeout(r, 50))
      }

      if (!healthy) {
        const endedAt = new Date().toISOString()
        return {
          stageResult: {
            id: stageId,
            stage: 'twins',
            result: 'FAILED',
            definitionRevision: policyRevision,
            startedAt,
            endedAt,
            exitCondition: 'READINESS_CHECK_TIMEOUT',
            artifacts: [],
          },
          decision: 'FAILED',
          twinUrls,
          reason: `Digital twin ${inst.fixture.serviceName} failed readiness check within ${timeoutMs}ms`,
        }
      }
    }

    // 5. Run test harness if provided
    let harnessExitCode = 0
    let harnessStdout = ''
    let harnessStderr = ''

    if (harness) {
      const harnessRes = await harness(twinUrls)
      harnessExitCode = harnessRes.exitCode
      harnessStdout = harnessRes.stdout
      harnessStderr = harnessRes.stderr
    }

    // 6. Check interaction compliance
    const artifacts: ArtifactRef[] = []
    let allInteractionsValid = harnessExitCode === 0

    for (const inst of instances) {
      const hasUnmatched = inst.interactionLog.some((l) => l.matchedRouteIndex === -1)
      if (hasUnmatched) {
        allInteractionsValid = false
      }

      const logPayload = {
        serviceName: inst.fixture.serviceName,
        interactions: inst.interactionLog,
        harnessStdout,
        harnessStderr,
      }
      artifacts.push({
        id: `twin-log-${inst.fixture.serviceName}`,
        projectId,
        mediaType: 'application/json',
        sizeBytes: 256,
        digest: digestJson(logPayload),
      })
    }

    const endedAt = new Date().toISOString()
    const result = allInteractionsValid ? 'PASSED' : 'FAILED'
    const exitCondition = allInteractionsValid ? 'passed' : 'interaction_failed'

    return {
      stageResult: {
        id: stageId,
        stage: 'twins',
        result,
        definitionRevision: policyRevision,
        startedAt,
        endedAt,
        exitCondition,
        artifacts,
      },
      decision: result,
      twinUrls,
      reason: allInteractionsValid ? undefined : 'One or more digital twin interactions failed or were unmatched',
    }
  } finally {
    // Clean shutdown of all twin instances
    await Promise.all(instances.map((inst) => inst.stop()))
  }
}
