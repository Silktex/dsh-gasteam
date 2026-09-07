/**
 * Dark Factory Gate 3: Signed Deployment Bridge and Adapter (DF-12)
 *
 * Implements generic signed webhook deployment protocol over HTTP loopback (127.0.0.1:0),
 * HMAC-SHA256 and Ed25519 header signatures, monotonic fencing tokens, idempotent
 * operation lookups with conflict detection, retry backoff with jitter, baseline
 * deployment registration, and fault injection hooks.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { createHmac, timingSafeEqual, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto"
import type { AddressInfo } from "node:net"
import z from "zod"
import {
  deploymentRequestSchema,
  deploymentStatusSchema,
  deploymentCallbackSchema,
  type DeploymentRequestV1,
  type DeploymentStatusV1,
  type DeploymentCallbackV1,
} from "./contracts/release.ts"
import { idSchema, digestSchema, revisionSchema, timestampSchema } from "./contracts/common.ts"
import { canonicalJson, digestBytes, digestJson, parseStrictJson } from "./json.ts"

export const DEPLOYMENT_DOMAIN = "gasteam.darkfactory.deployment.v1"
export const DEPLOYMENT_HEADERS = {
  protocolVersion: "x-darkfactory-protocol-version",
  keyId: "x-darkfactory-key-id",
  timestamp: "x-darkfactory-timestamp",
  signature: "x-darkfactory-signature-256",
} as const

const hardPayloadBytes = 1048576 // 1MB
const FIVE_MINUTES_MS = 5 * 60 * 1000

export class DeploymentBridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? `Deployment bridge error: ${code} (${status})`)
    this.name = "DeploymentBridgeError"
  }
}

export interface DeploymentBridgeFaults {
  dropResponse?: boolean | undefined
  duplicateCallback?: boolean | undefined
  status429?: boolean | undefined
  simulateLatencyMs?: number | undefined
}

export interface BaselineDeployment {
  readonly deploymentId: string
  readonly commit: string
  readonly artifactDigest: string
  readonly observedAt: string
}

export interface DeploymentBridgeOptions {
  readonly keyRegistry?: Record<string, string | { privateKey?: KeyObject | string; publicKey?: KeyObject | string }> | undefined
  readonly defaultKeyId?: string | undefined
}

export function computeDeploymentSigningInput(method: string, path: string, keyId: string, timestamp: string, bodyDigest: string): string {
  return [DEPLOYMENT_DOMAIN, method.toUpperCase(), path, keyId, timestamp, bodyDigest].join("\n")
}

export function signDeploymentPayload(input: {
  method: string
  path: string
  keyId: string
  secretOrPrivateKey: string | KeyObject
  timestamp: string
  body: Uint8Array
}): string {
  const bodyDigest = digestBytes(input.body)
  const signingInput = Buffer.from(computeDeploymentSigningInput(input.method, input.path, input.keyId, input.timestamp, bodyDigest), "utf8")

  if (typeof input.secretOrPrivateKey === "string" && !input.secretOrPrivateKey.includes("BEGIN")) {
    return createHmac("sha256", input.secretOrPrivateKey).update(signingInput).digest("hex")
  }

  const priv = typeof input.secretOrPrivateKey === "string"
    ? createPrivateKey(input.secretOrPrivateKey)
    : input.secretOrPrivateKey
  return sign(null, signingInput, priv).toString("hex")
}

export function verifyDeploymentSignature(input: {
  method: string
  path: string
  keyId: string
  secretOrPublicKey: string | KeyObject
  timestamp: string
  signature: string
  body: Uint8Array
}): boolean {
  const bodyDigest = digestBytes(input.body)
  const signingInput = Buffer.from(computeDeploymentSigningInput(input.method, input.path, input.keyId, input.timestamp, bodyDigest), "utf8")

  if (typeof input.secretOrPublicKey === "string" && !input.secretOrPublicKey.includes("BEGIN")) {
    const expected = createHmac("sha256", input.secretOrPublicKey).update(signingInput).digest("hex")
    if (expected.length !== input.signature.length) return false
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(input.signature, "hex"))
  }

  const pub = typeof input.secretOrPublicKey === "string"
    ? createPublicKey(input.secretOrPublicKey)
    : input.secretOrPublicKey
  return verify(null, signingInput, pub, Buffer.from(input.signature, "hex"))
}

interface StoredOperation {
  request: DeploymentRequestV1
  status: DeploymentStatusV1
  createdAt: number
}

/**
 * Server implementing the DF-12 signed webhook deployment protocol.
 */
export class DeploymentWebhookBridge {
  private server: Server | null = null
  private sockets = new Set<import("node:net").Socket>()
  private port = 0
  private url = ""
  private faults: DeploymentBridgeFaults = {}
  private operations = new Map<string, StoredOperation>()
  private baselines = new Map<string, BaselineDeployment>()
  private highestFencingTokens = new Map<string, number>()
  private providerRevisions = new Map<string, number>()
  private callbacksReceived: DeploymentCallbackV1[] = []

  constructor(private readonly options: DeploymentBridgeOptions = {}) {}

  static async start(options: DeploymentBridgeOptions = {}): Promise<DeploymentWebhookBridge> {
    const bridge = new DeploymentWebhookBridge(options)
    await bridge.listen()
    return bridge
  }

  private async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch(err => {
          if (!res.headersSent) {
            const status = err instanceof DeploymentBridgeError ? err.status : 500
            res.writeHead(status, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: err.message, code: err instanceof DeploymentBridgeError ? err.code : "INTERNAL_ERROR" }))
          }
        })
      })

      this.server.on("connection", socket => {
        this.sockets.add(socket)
        socket.once("close", () => this.sockets.delete(socket))
      })

      this.server.on("error", reject)
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address() as AddressInfo
        this.port = addr.port
        this.url = `http://127.0.0.1:${this.port}`
        resolve()
      })
    })
  }

  getUrl(): string {
    if (!this.url) throw new Error("Bridge not listening")
    return this.url
  }

  injectFault(faults: DeploymentBridgeFaults): void {
    this.faults = { ...this.faults, ...faults }
  }

  clearFaults(): void {
    this.faults = {}
  }

  registerBaseline(environment: string, deployment: BaselineDeployment): void {
    this.baselines.set(environment, deployment)
  }

  getBaseline(environment: string): BaselineDeployment | undefined {
    return this.baselines.get(environment)
  }

  getReceivedCallbacks(): readonly DeploymentCallbackV1[] {
    return [...this.callbacksReceived]
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => (err ? reject(err) : resolve()))
      })
      this.server = null
    }
  }

  private getKeySecret(keyId: string): string | KeyObject {
    const key = this.options.keyRegistry?.[keyId]
    if (!key) {
      return "darkfactory-test-shared-deployment-secret"
    }
    if (typeof key === "string") return key
    return key.publicKey ?? key.privateKey ?? "darkfactory-test-shared-deployment-secret"
  }

  private async readBody(req: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > hardPayloadBytes) throw new DeploymentBridgeError(413, "PAYLOAD_TOO_LARGE")
      chunks.push(buf)
    }
    return new Uint8Array(Buffer.concat(chunks))
  }

  private authenticate(req: IncomingMessage, body: Uint8Array): { keyId: string; timestamp: string } {
    const keyId = req.headers[DEPLOYMENT_HEADERS.keyId]
    const timestamp = req.headers[DEPLOYMENT_HEADERS.timestamp]
    const signature = req.headers[DEPLOYMENT_HEADERS.signature]

    if (typeof keyId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
      throw new DeploymentBridgeError(401, "AUTHENTICATION_REQUIRED", "Missing signature headers")
    }

    const reqTime = Date.parse(timestamp)
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > FIVE_MINUTES_MS) {
      throw new DeploymentBridgeError(401, "TIMESTAMP_EXPIRED", "Timestamp beyond 5-minute freshness bound")
    }

    const secret = this.getKeySecret(keyId)
    const valid = verifyDeploymentSignature({
      method: req.method ?? "POST",
      path: req.url ?? "/",
      keyId,
      secretOrPublicKey: secret,
      timestamp,
      signature,
      body,
    })

    if (!valid) {
      throw new DeploymentBridgeError(401, "SIGNATURE_INVALID", "Cryptographic signature mismatch")
    }

    return { keyId, timestamp }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.faults.simulateLatencyMs && this.faults.simulateLatencyMs > 0) {
      await new Promise(r => setTimeout(r, this.faults.simulateLatencyMs))
    }

    if (this.faults.status429) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" })
      res.end(JSON.stringify({ error: "Rate limit exceeded", code: "RATE_LIMITED" }))
      return
    }

    if (this.faults.dropResponse) {
      req.destroy()
      return
    }

    const path = req.url ?? "/"
    const method = req.method?.toUpperCase() ?? "GET"

    if (method === "GET" && path.startsWith("/darkfactory/v1/deployment/status/")) {
      const operationId = path.slice("/darkfactory/v1/deployment/status/".length)
      const op = this.operations.get(operationId)
      if (!op) {
        throw new DeploymentBridgeError(404, "OPERATION_NOT_FOUND", `Operation ${operationId} not found`)
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(canonicalJson(op.status))
      return
    }

    const body = await this.readBody(req)
    this.authenticate(req, body)

    if (method === "POST" && path === "/darkfactory/v1/deployment/preflight") {
      const parsed = parseStrictJson(Buffer.from(body).toString("utf8"), hardPayloadBytes) as { environment: string; expectedPriorDeployment?: string }
      const baseline = this.baselines.get(parsed.environment)
      const healthy = !!baseline && (!parsed.expectedPriorDeployment || baseline.deploymentId === parsed.expectedPriorDeployment)

      res.writeHead(200, { "content-type": "application/json" })
      res.end(canonicalJson({
        status: healthy ? "ready" : "quarantined",
        environment: parsed.environment,
        baseline: baseline ?? null,
        capabilities: ["deployCanary", "promote", "withdrawCanary", "deployRollback"],
      }))
      return
    }

    if (method === "POST" && path === "/darkfactory/v1/deployment/operation") {
      const request = deploymentRequestSchema.parse(parseStrictJson(Buffer.from(body).toString("utf8"), hardPayloadBytes))

      // Check idempotency cache
      const existing = this.operations.get(request.operationId)
      if (existing) {
        if (canonicalJson(existing.request) !== canonicalJson(request)) {
          throw new DeploymentBridgeError(409, "OPERATION_CONFLICT", "Same operationId with different payload")
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(canonicalJson(existing.status))
        return
      }

      // Enforce monotonic fencing token per environment
      const envKey = `${request.projectId}:${request.environment}`
      const lastToken = this.highestFencingTokens.get(envKey) ?? 0
      if (request.fencingToken < lastToken) {
        throw new DeploymentBridgeError(409, "STALE_FENCING_TOKEN", `Fencing token ${request.fencingToken} is lower than current ${lastToken}`)
      }
      this.highestFencingTokens.set(envKey, request.fencingToken)

      // Provider revision increment
      const nextRev = (this.providerRevisions.get(envKey) ?? 0) + 1
      this.providerRevisions.set(envKey, nextRev)

      const status: DeploymentStatusV1 = deploymentStatusSchema.parse({
        schemaVersion: 1,
        id: `deploy-status-${request.operationId}`,
        projectId: request.projectId,
        policyRevision: request.policyRevision,
        environment: request.environment,
        releaseId: request.releaseId,
        operationId: request.operationId,
        fencingToken: request.fencingToken,
        commit: request.commit,
        artifactDigest: request.artifactDigest,
        protocolVersion: 1,
        providerRevision: nextRev,
        status: "succeeded",
        deploymentId: `dep-${request.operationId}`,
        requestDigest: digestJson(request),
        observedAt: new Date().toISOString(),
      })

      this.operations.set(request.operationId, {
        request,
        status,
        createdAt: Date.now(),
      })

      res.writeHead(200, { "content-type": "application/json" })
      res.end(canonicalJson(status))
      return
    }

    if (method === "POST" && path === "/darkfactory/v1/deployment/callback") {
      const callback = deploymentCallbackSchema.parse(parseStrictJson(Buffer.from(body).toString("utf8"), hardPayloadBytes))
      this.callbacksReceived.push(callback)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(canonicalJson({ acknowledged: true, callbackId: callback.id }))
      return
    }

    throw new DeploymentBridgeError(404, "NOT_FOUND", `Route ${method} ${path} not found`)
  }
}

export interface DeploymentAdapterOptions {
  readonly bridgeUrl: string
  readonly keyId: string
  readonly secretOrPrivateKey: string | KeyObject
  readonly maxRetries?: number | undefined
  readonly requestTimeoutMs?: number | undefined
}

/**
 * Client adapter connecting to a signed deployment bridge (DF-12).
 */
export class DeploymentAdapter {
  private readonly maxRetries: number
  private readonly requestTimeoutMs: number

  constructor(private readonly options: DeploymentAdapterOptions) {
    this.maxRetries = options.maxRetries ?? 3
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  }

  private async fetchWithRetry(path: string, method: string, payload?: unknown): Promise<string> {
    const url = `${this.options.bridgeUrl}${path}`
    const backoffs = [1000, 5000, 25000]

    let attempt = 0
    while (attempt < this.maxRetries) {
      attempt++
      try {
        const bodyBytes = payload !== undefined ? Buffer.from(canonicalJson(payload), "utf8") : new Uint8Array()
        const timestamp = new Date().toISOString()
        const signature = signDeploymentPayload({
          method,
          path,
          keyId: this.options.keyId,
          secretOrPrivateKey: this.options.secretOrPrivateKey,
          timestamp,
          body: bodyBytes,
        })

        const headers: Record<string, string> = {
          "content-type": "application/json",
          [DEPLOYMENT_HEADERS.protocolVersion]: "1",
          [DEPLOYMENT_HEADERS.keyId]: this.options.keyId,
          [DEPLOYMENT_HEADERS.timestamp]: timestamp,
          [DEPLOYMENT_HEADERS.signature]: signature,
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

        const init: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        }
        if (payload !== undefined) {
          init.body = bodyBytes
        }
        const res = await fetch(url, init).finally(() => clearTimeout(timeout))

        if (res.ok) {
          return await res.text()
        }

        if (res.status === 409 || res.status === 401 || res.status === 400 || res.status === 404) {
          const errBody = await res.text()
          throw new DeploymentBridgeError(res.status, "CLIENT_ERROR", errBody)
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt >= this.maxRetries) {
            throw new DeploymentBridgeError(res.status, "MAX_RETRIES_EXCEEDED", `Failed after ${attempt} attempts: ${res.statusText}`)
          }
          const baseBackoff = backoffs[attempt - 1] ?? 5000
          const jitter = Math.floor(Math.random() * 500)
          await new Promise(r => setTimeout(r, baseBackoff + jitter))
          continue
        }

        throw new DeploymentBridgeError(res.status, "HTTP_ERROR", await res.text())
      } catch (err: any) {
        if (err instanceof DeploymentBridgeError && (err.status === 409 || err.status === 401 || err.status === 400)) {
          throw err
        }
        if (attempt >= this.maxRetries) {
          throw err
        }
        const baseBackoff = backoffs[attempt - 1] ?? 5000
        const jitter = Math.floor(Math.random() * 500)
        await new Promise(r => setTimeout(r, baseBackoff + jitter))
      }
    }

    throw new DeploymentBridgeError(500, "UNREACHABLE", "All deployment bridge attempts failed")
  }

  async preflight(params: { environment: string; expectedPriorDeployment?: string }): Promise<{
    status: "ready" | "quarantined"
    environment: string
    baseline: BaselineDeployment | null
    capabilities: string[]
  }> {
    const raw = await this.fetchWithRetry("/darkfactory/v1/deployment/preflight", "POST", params)
    return parseStrictJson(raw, hardPayloadBytes) as any
  }

  async executeOperation(request: DeploymentRequestV1): Promise<DeploymentStatusV1> {
    const validated = deploymentRequestSchema.parse(request)
    const raw = await this.fetchWithRetry("/darkfactory/v1/deployment/operation", "POST", validated)
    return deploymentStatusSchema.parse(parseStrictJson(raw, hardPayloadBytes))
  }

  async deployCanary(request: DeploymentRequestV1): Promise<DeploymentStatusV1> {
    if (request.operation !== "deployCanary") throw new Error("Expected deployCanary operation")
    return this.executeOperation(request)
  }

  async promote(request: DeploymentRequestV1): Promise<DeploymentStatusV1> {
    if (request.operation !== "promote") throw new Error("Expected promote operation")
    return this.executeOperation(request)
  }

  async withdrawCanary(request: DeploymentRequestV1): Promise<DeploymentStatusV1> {
    if (request.operation !== "withdrawCanary") throw new Error("Expected withdrawCanary operation")
    return this.executeOperation(request)
  }

  async deployRollback(request: DeploymentRequestV1): Promise<DeploymentStatusV1> {
    if (request.operation !== "deployRollback") throw new Error("Expected deployRollback operation")
    return this.executeOperation(request)
  }

  async getStatus(operationId: string): Promise<DeploymentStatusV1> {
    const raw = await this.fetchWithRetry(`/darkfactory/v1/deployment/status/${encodeURIComponent(operationId)}`, "GET")
    return deploymentStatusSchema.parse(parseStrictJson(raw, hardPayloadBytes))
  }
}
