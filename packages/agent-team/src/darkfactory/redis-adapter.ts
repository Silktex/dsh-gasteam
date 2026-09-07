import * as tls from 'node:tls'
import { createHash } from 'node:crypto'
import { resolveSecret } from './secrets.ts'
import type { SecretRef } from './contracts/common.ts'

export type PauseReason = 'manual' | 'safety' | 'budget' | 'quota' | 'catalog'

// --- Hash Tag & Cluster Affinity Utilities ---

export const FLEET_HASH_TAG_PREFIX = 'df:fleet:'

/**
 * Returns a standardized Redis key bound to the fleet cluster hash tag.
 * Format: {df:fleet:<fleetId>}:<suffix>
 */
export function fleetKey(fleetId: string, suffix: string): string {
  if (!fleetId || typeof fleetId !== 'string') {
    throw new Error('fleetKey requires a valid fleetId string')
  }
  if (!suffix || typeof suffix !== 'string') {
    throw new Error('fleetKey requires a valid suffix string')
  }
  return `{${FLEET_HASH_TAG_PREFIX}${fleetId}}:${suffix}`
}

/**
 * Extracts the Redis Cluster hash tag from a key.
 * According to the Redis Cluster specification:
 * - If key contains '{' followed by '}', the substring between the first '{'
 *   and the first '}' after it is the hash tag.
 * - If no braces exist, or '{}' is empty, returns null (meaning entire key is hashed).
 */
export function extractHashTag(key: string): string | null {
  const openBrace = key.indexOf('{')
  if (openBrace === -1) return null
  const closeBrace = key.indexOf('}', openBrace + 1)
  if (closeBrace === -1 || closeBrace === openBrace + 1) return null
  return key.slice(openBrace + 1, closeBrace)
}

/**
 * Asserts that all provided keys share the identical Redis Cluster hash slot tag.
 * If keys have different tags or mix tagged and untagged keys, throws RedisCrossSlotError.
 */
export function assertSameHashSlot(keys: readonly string[]): void {
  if (keys.length <= 1) return
  const firstKey = keys[0]
  if (firstKey === undefined) return
  const firstTag = extractHashTag(firstKey) ?? firstKey
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i]
    if (k === undefined) continue
    const tag = extractHashTag(k) ?? k
    if (tag !== firstTag) {
      throw new RedisCrossSlotError(
        [...keys],
        keys.map(key => (key !== undefined ? extractHashTag(key) : null)),
      )
    }
  }
}

// --- Error Classes Hierarchy ---

export class RedisAdapterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RedisAdapterError'
  }
}

export class RedisConnectionError extends RedisAdapterError {
  constructor(message: string) {
    super(message, 'REDIS_CONNECTION_ERROR')
    this.name = 'RedisConnectionError'
  }
}

export class RedisCommandTimeoutError extends RedisAdapterError {
  constructor(command: string, timeoutMs: number) {
    super(`Redis command '${command}' timed out after ${timeoutMs}ms`, 'REDIS_COMMAND_TIMEOUT')
    this.name = 'RedisCommandTimeoutError'
  }
}

export class RedisCrossSlotError extends RedisAdapterError {
  constructor(readonly keys: string[], readonly tags: (string | null)[]) {
    super(
      `CROSSSLOT Keys in request don't hash to the same slot: [${keys.join(', ')}]`,
      'REDIS_CROSS_SLOT',
    )
    this.name = 'RedisCrossSlotError'
  }
}

export class RedisScriptError extends RedisAdapterError {
  constructor(message: string) {
    super(message, 'REDIS_SCRIPT_ERROR')
    this.name = 'RedisScriptError'
  }
}

export class RedisNoScriptError extends RedisScriptError {
  constructor(readonly sha: string) {
    super(`NOSCRIPT No matching script for SHA: ${sha}. Please use EVAL.`)
    this.name = 'RedisNoScriptError'
  }
}

// --- Redis Client Interface ---

export interface RedisSetOptions {
  px?: number | undefined // expiration in milliseconds
  ex?: number | undefined // expiration in seconds
  nx?: boolean | undefined // only set if not exists
  xx?: boolean | undefined // only set if already exists
}

export interface RedisClientAdapter {
  eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>
  evalsha<T = unknown>(sha: string, keys: string[], args: (string | number)[]): Promise<T>
  scriptLoad(script: string): Promise<string>
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: RedisSetOptions): Promise<void>
  del(...keys: string[]): Promise<number>
  ping(): Promise<string>
  quit(): Promise<void>
}

// --- In-Memory Redis Context & Types ---

export interface InMemoryRedisContext {
  // String operations
  getString(key: string): string | null
  setString(key: string, value: string, ttlMs?: number | undefined): void
  delKey(...keys: string[]): number
  existsKey(key: string): boolean
  incr(key: string): number
  incrby(key: string, increment: number): number

  // Hash operations
  hget(key: string, field: string): string | null
  hset(key: string, field: string, value: string): number
  hdel(key: string, ...fields: string[]): number
  hgetall(key: string): Record<string, string>
  hincrby(key: string, field: string, increment: number): number
  hexists(key: string, field: string): boolean

  // Set operations
  sadd(key: string, ...members: string[]): number
  srem(key: string, ...members: string[]): number
  smembers(key: string): string[]
  sismember(key: string, member: string): boolean
  scard(key: string): number

  // Sorted Set operations
  zadd(key: string, score: number, member: string): number
  zrem(key: string, ...members: string[]): number
  zrangebyscore(key: string, min: number, max: number): Array<{ member: string; score: number }>
  zcard(key: string): number

  // Clock methods
  nowMs(): number
  nowIso(): string
}

export type ScriptHandler<T = unknown> = (
  ctx: InMemoryRedisContext,
  keys: string[],
  args: (string | number)[],
) => Promise<T> | T

export interface InMemoryRedisAdapterOptions {
  clock?: (() => number | string) | undefined
  enforceCrossSlot?: boolean | undefined
}

// --- Canonical Lua Scripts for Dark Factory DF-15 ---

export const RESERVE_SPEND_LUA_SCRIPT = `
-- [df:reserve_spend]
-- KEYS[1]: pauses set {df:fleet:<fleetId>}:pauses
-- KEYS[2]: epoch string {df:fleet:<fleetId>}:epoch
-- KEYS[3]: fencing counter {df:fleet:<fleetId>}:fencing
-- KEYS[4]: active reservations set {df:fleet:<fleetId>}:active_reservations
-- ARGV[1]: expectedEpoch
-- ARGV[2]: reservationId
-- ARGV[3]: projectId
-- ARGV[4]: hostId
-- ARGV[5]: purpose ('routine' | 'canary-recovery' | 'verified-p0-security' | 'production-invariant-recovery')
-- ARGV[6]: maxCostMicros
-- ARGV[7]: maxTokens
-- ARGV[8]: accountingDay (YYYY-MM-DD)
-- ARGV[9]: accountingMonth (YYYY-MM)
-- ARGV[10]: capsJson
-- ARGV[11]: routineWatermark (0.95)
-- ARGV[12]: reconcileBy
-- ARGV[13]: nowIso
-- ARGV[14]: baseReservationJson

local expectedEpoch = ARGV[1]
local reservationId = ARGV[2]
local projectId = ARGV[3]
local hostId = ARGV[4]
local purpose = ARGV[5]
local maxCostMicros = tonumber(ARGV[6]) or 0
local maxTokens = tonumber(ARGV[7]) or 0
local accountingDay = ARGV[8]
local accountingMonth = ARGV[9]
local caps = cjson.decode(ARGV[10])
local routineWatermark = tonumber(ARGV[11]) or 0.95
local reconcileBy = ARGV[12]
local nowIso = ARGV[13]
local baseReservationJson = ARGV[14]

-- Extract cluster hash tag
local tag = string.match(KEYS[1], "^(%b{})")
local prefix = ""
if tag then
  prefix = tag .. ":"
end

-- 1. Check Epoch
local activeEpoch = redis.call('GET', KEYS[2])
if not activeEpoch then
  redis.call('SET', KEYS[2], expectedEpoch)
elseif activeEpoch ~= expectedEpoch then
  return redis.error_reply("ERR_EPOCH_MISMATCH: expected " .. expectedEpoch .. ", active is " .. activeEpoch)
end

-- 2. Check Pauses
local pauseMembers = redis.call('SMEMBERS', KEYS[1])
local pauses = {}
local pauseList = {}
for _, p in ipairs(pauseMembers) do
  pauses[p] = true
  table.insert(pauseList, p)
end
local pauseStr = table.concat(pauseList, ",")

if pauses['manual'] or pauses['safety'] then
  return redis.error_reply("ERR_PAUSED_SAFETY_OR_MANUAL:" .. pauseStr)
end

local isRoutine = (purpose == 'routine')
if isRoutine and (pauses['budget'] or pauses['quota'] or pauses['catalog']) then
  return redis.error_reply("ERR_PAUSED_ROUTINE:" .. pauseStr)
end

-- Helper to read numeric counters
local function readCounter(key)
  local v = redis.call('GET', key)
  if v then
    return tonumber(v) or 0
  end
  return 0
end

-- Helper to check watermark/cap for a single scope and window
local function checkCap(spendKey, outstandingKey, proposed, capVal, scope, window, metric)
  if not capVal then return nil end
  local capNum = tonumber(capVal)
  if not capNum or capNum <= 0 then return nil end

  local settled = readCounter(spendKey)
  local out = readCounter(outstandingKey)
  local total = settled + out + proposed

  if isRoutine then
    local limit = math.floor(capNum * routineWatermark)
    if total > limit then
      redis.call('SADD', KEYS[1], 'budget')
      return "ERR_WATERMARK_BREACHED:" .. scope .. ":" .. window .. ":" .. metric .. ":" .. tostring(math.floor(total)) .. ":" .. tostring(limit)
    end
  else
    if total > capNum then
      return "ERR_CAP_EXCEEDED:" .. scope .. ":" .. window .. ":" .. metric .. ":" .. tostring(math.floor(total)) .. ":" .. tostring(math.floor(capNum))
    end
  end
  return nil
end

-- 3. Evaluate Caps (Fleet, Project, Host) across Money and Tokens
if caps.fleetCaps then
  local fc = caps.fleetCaps.caps or caps.fleetCaps
  local err = checkCap(prefix .. "spend:fleet:daily:" .. accountingDay .. ":cost", prefix .. "outstanding:fleet:cost", maxCostMicros, fc.dailyMoneyMicros, 'Fleet', 'Daily', 'money')
  if err then return redis.error_reply(err) end

  err = checkCap(prefix .. "spend:fleet:monthly:" .. accountingMonth .. ":cost", prefix .. "outstanding:fleet:cost", maxCostMicros, fc.monthlyMoneyMicros, 'Fleet', 'Monthly', 'money')
  if err then return redis.error_reply(err) end

  err = checkCap(prefix .. "spend:fleet:daily:" .. accountingDay .. ":tokens", prefix .. "outstanding:fleet:tokens", maxTokens, fc.dailyTokens, 'Fleet', 'Daily', 'tokens')
  if err then return redis.error_reply(err) end

  err = checkCap(prefix .. "spend:fleet:monthly:" .. accountingMonth .. ":tokens", prefix .. "outstanding:fleet:tokens", maxTokens, fc.monthlyTokens, 'Fleet', 'Monthly', 'tokens')
  if err then return redis.error_reply(err) end
end

-- Project Caps
if caps.projectCaps then
  for _, p in ipairs(caps.projectCaps) do
    if p.id == projectId then
      local pCaps = p.caps or p
      local err = checkCap(prefix .. "spend:project:" .. projectId .. ":daily:" .. accountingDay .. ":cost", prefix .. "outstanding:project:" .. projectId .. ":cost", maxCostMicros, pCaps.dailyMoneyMicros, 'Project', 'Daily', 'money')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:project:" .. projectId .. ":monthly:" .. accountingMonth .. ":cost", prefix .. "outstanding:project:" .. projectId .. ":cost", maxCostMicros, pCaps.monthlyMoneyMicros, 'Project', 'Monthly', 'money')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:project:" .. projectId .. ":daily:" .. accountingDay .. ":tokens", prefix .. "outstanding:project:" .. projectId .. ":tokens", maxTokens, pCaps.dailyTokens, 'Project', 'Daily', 'tokens')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:project:" .. projectId .. ":monthly:" .. accountingMonth .. ":tokens", prefix .. "outstanding:project:" .. projectId .. ":tokens", maxTokens, pCaps.monthlyTokens, 'Project', 'Monthly', 'tokens')
      if err then return redis.error_reply(err) end
    end
  end
end

-- Host Caps
if caps.hostCaps then
  for _, h in ipairs(caps.hostCaps) do
    if h.id == hostId then
      local hCaps = h.caps or h
      local err = checkCap(prefix .. "spend:host:" .. hostId .. ":daily:" .. accountingDay .. ":cost", prefix .. "outstanding:host:" .. hostId .. ":cost", maxCostMicros, hCaps.dailyMoneyMicros, 'Host', 'Daily', 'money')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:host:" .. hostId .. ":monthly:" .. accountingMonth .. ":cost", prefix .. "outstanding:host:" .. hostId .. ":cost", maxCostMicros, hCaps.monthlyMoneyMicros, 'Host', 'Monthly', 'money')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:host:" .. hostId .. ":daily:" .. accountingDay .. ":tokens", prefix .. "outstanding:host:" .. hostId .. ":tokens", maxTokens, hCaps.dailyTokens, 'Host', 'Daily', 'tokens')
      if err then return redis.error_reply(err) end

      err = checkCap(prefix .. "spend:host:" .. hostId .. ":monthly:" .. accountingMonth .. ":tokens", prefix .. "outstanding:host:" .. hostId .. ":tokens", maxTokens, hCaps.monthlyTokens, 'Host', 'Monthly', 'tokens')
      if err then return redis.error_reply(err) end
    end
  end
end

-- 4. Increment monotonic fencing token
local fencingToken = redis.call('INCR', KEYS[3])

-- 5. Update outstanding reserves
redis.call('INCRBY', prefix .. "outstanding:fleet:cost", maxCostMicros)
redis.call('INCRBY', prefix .. "outstanding:fleet:tokens", maxTokens)
redis.call('INCRBY', prefix .. "outstanding:project:" .. projectId .. ":cost", maxCostMicros)
redis.call('INCRBY', prefix .. "outstanding:project:" .. projectId .. ":tokens", maxTokens)
redis.call('INCRBY', prefix .. "outstanding:host:" .. hostId .. ":cost", maxCostMicros)
redis.call('INCRBY', prefix .. "outstanding:host:" .. hostId .. ":tokens", maxTokens)

-- 6. Store reservation record
pcall(function() cjson.encode_empty_table_as_object(false) end)
local reservation = cjson.decode(baseReservationJson)
reservation.id = reservationId
reservation.fencingToken = fencingToken
reservation.state = 'reserved'
reservation.createdAt = nowIso
reservation.reconcileBy = reconcileBy
reservation.settledCostMicros = 0
reservation.settledTokens = 0
reservation.reconciledCostMicros = 0
reservation.reconciledTokens = 0
reservation.lastReconciledSequence = 0

local encoded = cjson.encode(reservation)
local resKey = prefix .. "reservation:" .. reservationId
redis.call('SET', resKey, encoded)
if KEYS[4] and KEYS[4] ~= '' then
  redis.call('SADD', KEYS[4], reservationId)
end

return encoded
`

export const START_RESERVATION_LUA_SCRIPT = `
-- [df:start_reservation]
-- KEYS[1]: reservation key
-- KEYS[2]: epoch key
-- ARGV[1]: expectedFencingToken
-- ARGV[2]: expectedEpoch

local expectedFencingToken = tonumber(ARGV[1])
local expectedEpoch = ARGV[2]

if KEYS[2] and expectedEpoch and expectedEpoch ~= '' then
  local activeEpoch = redis.call('GET', KEYS[2])
  if activeEpoch and activeEpoch ~= expectedEpoch then
    return redis.error_reply("ERR_EPOCH_MISMATCH: active is " .. activeEpoch .. ", expected " .. expectedEpoch)
  end
end

local raw = redis.call('GET', KEYS[1])
if not raw then
  return redis.error_reply("ERR_RESERVATION_NOT_FOUND")
end

pcall(function() cjson.encode_empty_table_as_object(false) end)
local res = cjson.decode(raw)

if tonumber(res.fencingToken) ~= expectedFencingToken then
  return redis.error_reply("ERR_STALE_FENCING_TOKEN: current fencing token is " .. tostring(res.fencingToken) .. ", provided " .. tostring(expectedFencingToken))
end

if res.state ~= 'reserved' then
  return redis.error_reply("ERR_INVALID_TRANSITION: cannot start reservation in state " .. tostring(res.state))
end

res.state = 'started'
redis.call('SET', KEYS[1], cjson.encode(res))
return 'OK'
`

export const RECORD_USAGE_LUA_SCRIPT = `
-- [df:record_usage]
-- KEYS[1]: reservation key
-- KEYS[2]: events hash (streamSequence -> eventDigest)
-- KEYS[3]: buffer sorted set (member=payloadJson, score=streamSequence)
-- KEYS[4]: optional active reservations set
-- ARGV[1]: streamSequence
-- ARGV[2]: eventDigest
-- ARGV[3]: billedCostMicros
-- ARGV[4]: totalTokens
-- ARGV[5]: payloadJson

local streamSequence = tonumber(ARGV[1]) or 0
local eventDigest = ARGV[2]
local billedCostMicros = tonumber(ARGV[3]) or 0
local totalTokens = tonumber(ARGV[4]) or 0
local payloadJson = ARGV[5]

local activeKey = KEYS[4]
if not activeKey or activeKey == '' then
  local tag = string.match(KEYS[1], "^(%b{})")
  if tag then
    activeKey = tag .. ":active_reservations"
  else
    activeKey = "active_reservations"
  end
end

local raw = redis.call('GET', KEYS[1])
if not raw then
  return redis.error_reply("ERR_RESERVATION_NOT_FOUND")
end

pcall(function() cjson.encode_empty_table_as_object(false) end)
local res = cjson.decode(raw)

if res.state ~= 'started' and res.state ~= 'reconciling' then
  return redis.error_reply("ERR_INVALID_TRANSITION: reservation is in state " .. tostring(res.state))
end

-- 1. Duplicate & Conflict Check
local existingDigest = redis.call('HGET', KEYS[2], tostring(streamSequence))
if existingDigest then
  if existingDigest == eventDigest then
    return cjson.encode({ status = 'duplicate_ignored', sequence = streamSequence })
  else
    res.state = 'withheld'
    res.quarantineReason = 'ERR_CONFLICTING_EVENT_DIGEST'
    redis.call('SET', KEYS[1], cjson.encode(res))
    redis.call('SREM', activeKey, res.id)
    return cjson.encode({ status = 'conflict_quarantined', sequence = streamSequence })
  end
end

-- Record digest
redis.call('HSET', KEYS[2], tostring(streamSequence), eventDigest)

-- 2. Sequence Continuity Check
local lastSeq = tonumber(res.lastReconciledSequence) or 0
if streamSequence == lastSeq + 1 then
  res.settledCostMicros = (tonumber(res.settledCostMicros) or 0) + billedCostMicros
  res.settledTokens = (tonumber(res.settledTokens) or 0) + totalTokens
  res.lastReconciledSequence = streamSequence

  -- Auto-drain contiguous buffered chunks
  while true do
    local nextSeq = res.lastReconciledSequence + 1
    local buffered = redis.call('ZRANGEBYSCORE', KEYS[3], nextSeq, nextSeq)
    if not buffered or #buffered == 0 then
      break
    end
    local itemStr = buffered[1]
    local item = cjson.decode(itemStr)
    res.settledCostMicros = (tonumber(res.settledCostMicros) or 0) + (tonumber(item.billedCostMicros) or 0)

    local itemTokens = 0
    if item.countingSemantics == 'exclusive-categories' then
      itemTokens = (tonumber(item.inputTokens) or 0) + (tonumber(item.cacheTokens) or 0) + (tonumber(item.outputTokens) or 0) + (tonumber(item.reasoningTokens) or 0)
    else
      itemTokens = (tonumber(item.inputTokens) or 0) + (tonumber(item.outputTokens) or 0)
    end
    res.settledTokens = (tonumber(res.settledTokens) or 0) + itemTokens

    res.lastReconciledSequence = nextSeq
    redis.call('ZREM', KEYS[3], itemStr)
  end

  local bufCount = redis.call('ZCARD', KEYS[3])
  if bufCount == 0 and res.state == 'reconciling' then
    res.state = 'started'
  end

  redis.call('SET', KEYS[1], cjson.encode(res))
  return cjson.encode({
    status = 'recorded',
    sequence = streamSequence,
    lastReconciledSequence = res.lastReconciledSequence
  })
elseif streamSequence > lastSeq + 1 then
  redis.call('ZADD', KEYS[3], streamSequence, payloadJson)
  res.state = 'reconciling'
  redis.call('SET', KEYS[1], cjson.encode(res))
  return cjson.encode({
    status = 'buffered_gap',
    sequence = streamSequence,
    lastReconciledSequence = lastSeq,
    missingSequence = lastSeq + 1
  })
else
  return redis.error_reply("ERR_STALE_SEQUENCE: sequence " .. tostring(streamSequence) .. " is already reconciled")
end
`

export const SETTLE_RESERVATION_LUA_SCRIPT = `
-- [df:settle_reservation]
-- KEYS[1]: reservation key
-- KEYS[2]: buffer sorted set
-- KEYS[3]: active reservations set
-- ARGV[1]: nowIso
-- ARGV[2]: actualCostMicros
-- ARGV[3]: actualTokens

local nowIso = ARGV[1]
local actualCost = tonumber(ARGV[2])
local actualToks = tonumber(ARGV[3])

local raw = redis.call('GET', KEYS[1])
if not raw then
  return redis.error_reply("ERR_RESERVATION_NOT_FOUND")
end

pcall(function() cjson.encode_empty_table_as_object(false) end)
local res = cjson.decode(raw)

if res.state == 'settled' or res.state == 'withheld' then
  return redis.error_reply("ERR_INVALID_TRANSITION: reservation is already " .. tostring(res.state))
end

-- Check buffer for unresolved gaps
local bufferCount = redis.call('ZCARD', KEYS[2])
if bufferCount > 0 then
  if nowIso < tostring(res.reconcileBy) then
    return redis.error_reply("ERR_UNRESOLVED_SEQUENCE_GAPS")
  else
    res.state = 'withheld'
    res.quarantineReason = 'ERR_RECONCILIATION_DEADLINE_EXPIRED'
    redis.call('SET', KEYS[1], cjson.encode(res))
    if KEYS[3] and KEYS[3] ~= '' then
      redis.call('SREM', KEYS[3], res.id)
    end
    return cjson.encode({ state = 'withheld', error = 'ERR_RECONCILIATION_DEADLINE_EXPIRED' })
  end
end

local tag = string.match(KEYS[1], "^(%b{})")
local prefix = ""
if tag then prefix = tag .. ":" end

local maxCost = tonumber(res.maxCostMicros) or 0
local maxToks = tonumber(res.maxTokens) or 0

-- Settle spend: if explicit override provided (>= 0), use it; otherwise retain accumulated stream spend!
local settledCost = 0
local settledToks = 0

if actualCost and actualCost >= 0 then
  settledCost = actualCost
else
  settledCost = tonumber(res.settledCostMicros) or 0
end
if actualToks and actualToks >= 0 then
  settledToks = actualToks
else
  settledToks = tonumber(res.settledTokens) or 0
end

-- Deduct reservation from outstanding
redis.call('INCRBY', prefix .. "outstanding:fleet:cost", -maxCost)
redis.call('INCRBY', prefix .. "outstanding:fleet:tokens", -maxToks)
redis.call('INCRBY', prefix .. "outstanding:project:" .. res.projectId .. ":cost", -maxCost)
redis.call('INCRBY', prefix .. "outstanding:project:" .. res.projectId .. ":tokens", -maxToks)
redis.call('INCRBY', prefix .. "outstanding:host:" .. res.hostId .. ":cost", -maxCost)
redis.call('INCRBY', prefix .. "outstanding:host:" .. res.hostId .. ":tokens", -maxToks)

-- Credit actual settled spend
redis.call('INCRBY', prefix .. "spend:fleet:daily:" .. res.accountingDay .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:fleet:daily:" .. res.accountingDay .. ":tokens", settledToks)
redis.call('INCRBY', prefix .. "spend:fleet:monthly:" .. res.accountingMonth .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:fleet:monthly:" .. res.accountingMonth .. ":tokens", settledToks)
redis.call('INCRBY', prefix .. "spend:project:" .. res.projectId .. ":daily:" .. res.accountingDay .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:project:" .. res.projectId .. ":daily:" .. res.accountingDay .. ":tokens", settledToks)
redis.call('INCRBY', prefix .. "spend:project:" .. res.projectId .. ":monthly:" .. res.accountingMonth .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:project:" .. res.projectId .. ":monthly:" .. res.accountingMonth .. ":tokens", settledToks)
redis.call('INCRBY', prefix .. "spend:host:" .. res.hostId .. ":daily:" .. res.accountingDay .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:host:" .. res.hostId .. ":daily:" .. res.accountingDay .. ":tokens", settledToks)
redis.call('INCRBY', prefix .. "spend:host:" .. res.hostId .. ":monthly:" .. res.accountingMonth .. ":cost", settledCost)
redis.call('INCRBY', prefix .. "spend:host:" .. res.hostId .. ":monthly:" .. res.accountingMonth .. ":tokens", settledToks)

res.state = 'settled'
res.settledCostMicros = settledCost
res.settledTokens = settledToks
redis.call('SET', KEYS[1], cjson.encode(res))
if KEYS[3] and KEYS[3] ~= '' then
  redis.call('SREM', KEYS[3], res.id)
end

return cjson.encode({
  reservationId = res.id,
  state = 'settled',
  settledCostMicros = settledCost,
  settledTokens = settledToks,
  refundedCostMicros = maxCost - settledCost,
  refundedTokens = maxToks - settledToks
})
`

export const WITHHOLD_RESERVATION_LUA_SCRIPT = `
-- [df:withhold_reservation]
-- KEYS[1]: reservation key
-- KEYS[2]: active reservations set
-- ARGV[1]: reason

local raw = redis.call('GET', KEYS[1])
if not raw then
  return redis.error_reply("ERR_RESERVATION_NOT_FOUND")
end

pcall(function() cjson.encode_empty_table_as_object(false) end)
local res = cjson.decode(raw)

if res.state == 'settled' or res.state == 'withheld' then
  return redis.error_reply("ERR_INVALID_TRANSITION: cannot withhold reservation in terminal state " .. tostring(res.state))
end

res.state = 'withheld'
res.quarantineReason = ARGV[1]

redis.call('SET', KEYS[1], cjson.encode(res))
if KEYS[2] and KEYS[2] ~= '' then
  redis.call('SREM', KEYS[2], res.id)
end

return 'OK'
`

export const MANAGE_PAUSES_LUA_SCRIPT = `
-- [df:manage_pauses]
-- KEYS[1]: pauses set
-- ARGV[1]: action ('pause' | 'resume')
-- ARGV[2]: reason

local action = ARGV[1]
local reason = ARGV[2]

if action == 'pause' then
  redis.call('SADD', KEYS[1], reason)
elseif action == 'resume' then
  redis.call('SREM', KEYS[1], reason)
end

return redis.call('SMEMBERS', KEYS[1])
`

export const GET_SPEND_METRICS_LUA_SCRIPT = `
-- [df:get_spend_metrics]
-- KEYS[1]: pauses set
-- KEYS[2]: fencing counter
-- KEYS[3]: epoch string

local pauses = redis.call('SMEMBERS', KEYS[1])
local fencingRaw = redis.call('GET', KEYS[2])
local epochRaw = redis.call('GET', KEYS[3])

local fencing = 0
if fencingRaw then
  fencing = tonumber(fencingRaw) or 0
end

local epoch = 'epoch-1'
if epochRaw then
  epoch = tostring(epochRaw)
end

local tag = string.match(KEYS[1], "^(%b{})")
local prefix = ""
if tag then prefix = tag .. ":" end

local outCost = tonumber(redis.call('GET', prefix .. "outstanding:fleet:cost") or 0) or 0
local outTokens = tonumber(redis.call('GET', prefix .. "outstanding:fleet:tokens") or 0) or 0

pcall(function() cjson.encode_empty_table_as_object(false) end)
return cjson.encode({
  pauses = pauses or {},
  fencing = fencing,
  fencingToken = fencing,
  epoch = epoch,
  authorityEpoch = epoch,
  outstandingCostMicros = outCost,
  outstandingTokens = outTokens
})
`


// --- Default Script Handlers for InMemoryRedisAdapter ---

export interface UnpackedCap {
  dailyMoneyMicros?: number | undefined
  monthlyMoneyMicros?: number | undefined
  dailyTokens?: number | undefined
  monthlyTokens?: number | undefined
}

export function unpackCap(entry: any): UnpackedCap | undefined {
  if (!entry) return undefined
  const c = entry.caps ?? entry
  return {
    dailyMoneyMicros: c.dailyMoneyMicros !== undefined ? Number(c.dailyMoneyMicros) : undefined,
    monthlyMoneyMicros: c.monthlyMoneyMicros !== undefined ? Number(c.monthlyMoneyMicros) : undefined,
    dailyTokens: c.dailyTokens !== undefined ? Number(c.dailyTokens) : undefined,
    monthlyTokens: c.monthlyTokens !== undefined ? Number(c.monthlyTokens) : undefined,
  }
}

export const defaultReserveSpendHandler: ScriptHandler = (ctx, keys, args) => {
  const pausesKey = keys[0] ?? ''
  const epochKey = keys[1] ?? ''
  const fencingKey = keys[2] ?? ''
  const activeKey = keys[3]

  const expectedEpoch = String(args[0] ?? '')
  const reservationId = String(args[1] ?? '')
  const projectId = String(args[2] ?? '')
  const hostId = String(args[3] ?? '')
  const purpose = String(args[4] ?? '')
  const maxCostMicros = Number(args[5] ?? 0)
  const maxTokens = Number(args[6] ?? 0)
  const accountingDay = String(args[7] ?? '')
  const accountingMonth = String(args[8] ?? '')
  const caps = JSON.parse(String(args[9] ?? '{}'))
  const routineWatermark = Number(args[10] ?? 0.95)
  const reconcileBy = String(args[11] ?? '')
  const nowIso = String(args[12] ?? '')
  const baseReservationJsonRaw = String(args[13] ?? '{}')

  const fleetId = extractHashTag(epochKey)?.replace(FLEET_HASH_TAG_PREFIX, '') ?? 'default'

  // 1. Check Epoch
  const activeEpoch = ctx.getString(epochKey)
  if (!activeEpoch) {
    ctx.setString(epochKey, String(expectedEpoch))
  } else if (activeEpoch !== String(expectedEpoch)) {
    throw new RedisScriptError(`ERR_EPOCH_MISMATCH: expected ${expectedEpoch}, active is ${activeEpoch}`)
  }

  // 2. Check Pauses
  const pauses = ctx.smembers(pausesKey)
  if (pauses.includes('manual') || pauses.includes('safety')) {
    throw new RedisScriptError(`ERR_PAUSED_SAFETY_OR_MANUAL:${pauses.join(',')}`)
  }
  const isRoutine = purpose === 'routine'
  if (isRoutine && (pauses.includes('budget') || pauses.includes('quota') || pauses.includes('catalog'))) {
    throw new RedisScriptError(`ERR_PAUSED_ROUTINE:${pauses.join(',')}`)
  }

  const readCounter = (key: string): number => {
    const val = ctx.getString(key)
    return val ? Number(val) : 0
  }

  const checkCap = (
    spendKey: string,
    outstandingKey: string,
    proposed: number,
    capValue: number | undefined,
    scope: string,
    window: string,
    metric: 'money' | 'tokens',
  ) => {
    if (capValue === undefined || capValue === null || isNaN(capValue) || capValue <= 0) {
      return
    }
    const settled = readCounter(spendKey)
    const out = readCounter(outstandingKey)
    const total = settled + out + proposed

    if (isRoutine) {
      const limit = Math.floor(capValue * routineWatermark)
      if (total > limit) {
        ctx.sadd(pausesKey, 'budget')
        throw new RedisScriptError(`ERR_WATERMARK_BREACHED:${scope}:${window}:${metric}:${total}:${limit}`)
      }
    } else {
      if (total > capValue) {
        throw new RedisScriptError(`ERR_CAP_EXCEEDED:${scope}:${window}:${metric}:${total}:${capValue}`)
      }
    }
  }

  // Unpack caps with full schema compatibility ({ id, caps } vs flat)
  const fleetCap = unpackCap(caps.fleetCaps)
  const projectCap = unpackCap(caps.projectCaps?.find((p: any) => p.id === projectId))
  const hostCap = unpackCap(caps.hostCaps?.find((h: any) => h.id === hostId))

  // 1. Fleet Caps (Daily & Monthly x Money & Tokens)
  if (fleetCap) {
    checkCap(
      fleetKey(fleetId, `spend:fleet:daily:${accountingDay}:cost`),
      fleetKey(fleetId, 'outstanding:fleet:cost'),
      maxCostMicros,
      fleetCap.dailyMoneyMicros,
      'Fleet',
      'Daily',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:fleet:daily:${accountingDay}:tokens`),
      fleetKey(fleetId, 'outstanding:fleet:tokens'),
      maxTokens,
      fleetCap.dailyTokens,
      'Fleet',
      'Daily',
      'tokens',
    )
    checkCap(
      fleetKey(fleetId, `spend:fleet:monthly:${accountingMonth}:cost`),
      fleetKey(fleetId, 'outstanding:fleet:cost'),
      maxCostMicros,
      fleetCap.monthlyMoneyMicros,
      'Fleet',
      'Monthly',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:fleet:monthly:${accountingMonth}:tokens`),
      fleetKey(fleetId, 'outstanding:fleet:tokens'),
      maxTokens,
      fleetCap.monthlyTokens,
      'Fleet',
      'Monthly',
      'tokens',
    )
  }

  // 2. Project Caps (Daily & Monthly x Money & Tokens)
  if (projectCap) {
    checkCap(
      fleetKey(fleetId, `spend:project:${projectId}:daily:${accountingDay}:cost`),
      fleetKey(fleetId, `outstanding:project:${projectId}:cost`),
      maxCostMicros,
      projectCap.dailyMoneyMicros,
      'Project',
      'Daily',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:project:${projectId}:daily:${accountingDay}:tokens`),
      fleetKey(fleetId, `outstanding:project:${projectId}:tokens`),
      maxTokens,
      projectCap.dailyTokens,
      'Project',
      'Daily',
      'tokens',
    )
    checkCap(
      fleetKey(fleetId, `spend:project:${projectId}:monthly:${accountingMonth}:cost`),
      fleetKey(fleetId, `outstanding:project:${projectId}:cost`),
      maxCostMicros,
      projectCap.monthlyMoneyMicros,
      'Project',
      'Monthly',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:project:${projectId}:monthly:${accountingMonth}:tokens`),
      fleetKey(fleetId, `outstanding:project:${projectId}:tokens`),
      maxTokens,
      projectCap.monthlyTokens,
      'Project',
      'Monthly',
      'tokens',
    )
  }

  // 3. Host Caps (Daily & Monthly x Money & Tokens)
  if (hostCap) {
    checkCap(
      fleetKey(fleetId, `spend:host:${hostId}:daily:${accountingDay}:cost`),
      fleetKey(fleetId, `outstanding:host:${hostId}:cost`),
      maxCostMicros,
      hostCap.dailyMoneyMicros,
      'Host',
      'Daily',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:host:${hostId}:daily:${accountingDay}:tokens`),
      fleetKey(fleetId, `outstanding:host:${hostId}:tokens`),
      maxTokens,
      hostCap.dailyTokens,
      'Host',
      'Daily',
      'tokens',
    )
    checkCap(
      fleetKey(fleetId, `spend:host:${hostId}:monthly:${accountingMonth}:cost`),
      fleetKey(fleetId, `outstanding:host:${hostId}:cost`),
      maxCostMicros,
      hostCap.monthlyMoneyMicros,
      'Host',
      'Monthly',
      'money',
    )
    checkCap(
      fleetKey(fleetId, `spend:host:${hostId}:monthly:${accountingMonth}:tokens`),
      fleetKey(fleetId, `outstanding:host:${hostId}:tokens`),
      maxTokens,
      hostCap.monthlyTokens,
      'Host',
      'Monthly',
      'tokens',
    )
  }

  // 3. Increment monotonic fencing token
  const fencingToken = ctx.incr(fencingKey)

  // 4. Update outstanding reserves
  ctx.incrby(fleetKey(fleetId, 'outstanding:fleet:cost'), maxCostMicros)
  ctx.incrby(fleetKey(fleetId, 'outstanding:fleet:tokens'), maxTokens)
  ctx.incrby(fleetKey(fleetId, `outstanding:project:${projectId}:cost`), maxCostMicros)
  ctx.incrby(fleetKey(fleetId, `outstanding:project:${projectId}:tokens`), maxTokens)
  ctx.incrby(fleetKey(fleetId, `outstanding:host:${hostId}:cost`), maxCostMicros)
  ctx.incrby(fleetKey(fleetId, `outstanding:host:${hostId}:tokens`), maxTokens)

  // 5. Store reservation record
  const resKey = fleetKey(fleetId, `reservation:${reservationId}`)
  const baseReservation = JSON.parse(baseReservationJsonRaw)
  const reservationRecord = {
    ...baseReservation,
    id: reservationId,
    fencingToken,
    state: 'reserved',
    createdAt: nowIso,
    reconcileBy,
    settledCostMicros: 0,
    settledTokens: 0,
    reconciledCostMicros: 0,
    reconciledTokens: 0,
    lastReconciledSequence: 0,
  }
  ctx.setString(resKey, JSON.stringify(reservationRecord))
  if (activeKey) ctx.sadd(activeKey, reservationId)

  return JSON.stringify(reservationRecord)
}

export const defaultStartReservationHandler: ScriptHandler = (ctx, keys, args) => {
  const resKey = keys[0] ?? ''
  const epochKey = keys[1]
  const expectedFencingToken = Number(args[0] ?? 0)
  const expectedEpoch = args[1] !== undefined ? String(args[1]) : undefined

  // Check epoch if provided
  if (epochKey && expectedEpoch) {
    const activeEpoch = ctx.getString(epochKey)
    if (activeEpoch && activeEpoch !== expectedEpoch) {
      throw new RedisScriptError(`ERR_EPOCH_MISMATCH: active is ${activeEpoch}, expected ${expectedEpoch}`)
    }
  }

  const raw = ctx.getString(resKey)
  if (!raw) throw new RedisScriptError('ERR_RESERVATION_NOT_FOUND')
  const res = JSON.parse(raw)

  if (res.fencingToken !== expectedFencingToken) {
    throw new RedisScriptError(
      `ERR_STALE_FENCING_TOKEN: current fencing token is ${res.fencingToken}, provided ${expectedFencingToken}`,
    )
  }
  if (res.state !== 'reserved') {
    throw new RedisScriptError(`ERR_INVALID_TRANSITION: cannot start reservation in state ${res.state}`)
  }

  res.state = 'started'
  ctx.setString(resKey, JSON.stringify(res))
  return 'OK'
}

export const defaultRecordUsageHandler: ScriptHandler = (ctx, keys, args) => {
  const resKey = keys[0] ?? ''
  const eventsKey = keys[1] ?? ''
  const bufferKey = keys[2] ?? ''
  const activeKey = keys[3]
  const streamSequence = Number(args[0] ?? 0)
  const eventDigest = String(args[1] ?? '')
  const billedCostMicros = Number(args[2] ?? 0)
  const totalTokens = Number(args[3] ?? 0)
  const payloadJson = String(args[4] ?? '{}')

  const raw = ctx.getString(resKey)
  if (!raw) throw new RedisScriptError('ERR_RESERVATION_NOT_FOUND')
  const res = JSON.parse(raw)

  if (res.state !== 'started' && res.state !== 'reconciling') {
    throw new RedisScriptError(`ERR_INVALID_TRANSITION: reservation is in state ${res.state}`)
  }

  // 1. Duplicate & Conflict Check
  const existingDigest = ctx.hget(eventsKey, String(streamSequence))
  if (existingDigest) {
    if (existingDigest === eventDigest) {
      return JSON.stringify({ status: 'duplicate_ignored', sequence: streamSequence })
    } else {
      res.state = 'withheld'
      res.quarantineReason = 'ERR_CONFLICTING_EVENT_DIGEST'
      ctx.setString(resKey, JSON.stringify(res))
      const activeReservationsKey = activeKey ?? (res.fleetId ? fleetKey(res.fleetId, 'active_reservations') : undefined)
      if (activeReservationsKey) {
        ctx.srem(activeReservationsKey, res.id)
      }
      return JSON.stringify({ status: 'conflict_quarantined', sequence: streamSequence })
    }
  }

  // Record digest in digests hash
  ctx.hset(eventsKey, String(streamSequence), eventDigest)

  // 2. Sequence Continuity Check
  const lastSeq = res.lastReconciledSequence ?? 0
  if (streamSequence === lastSeq + 1) {
    res.settledCostMicros = (res.settledCostMicros ?? 0) + billedCostMicros
    res.settledTokens = (res.settledTokens ?? 0) + totalTokens
    res.lastReconciledSequence = streamSequence

    // Auto-drain contiguous buffered chunks
    while (true) {
      const nextSeq = res.lastReconciledSequence + 1
      const buffered = ctx.zrangebyscore(bufferKey, nextSeq, nextSeq)
      const firstBuffered = buffered[0]
      if (firstBuffered === undefined) break
      const item = JSON.parse(firstBuffered.member)
      res.settledCostMicros += item.billedCostMicros ?? 0
      const itemTokens =
        item.countingSemantics === 'exclusive-categories'
          ? (item.inputTokens ?? 0) + (item.cacheTokens ?? 0) + (item.outputTokens ?? 0) + (item.reasoningTokens ?? 0)
          : (item.inputTokens ?? 0) + (item.outputTokens ?? 0)
      res.settledTokens += itemTokens
      res.lastReconciledSequence = nextSeq
      ctx.zrem(bufferKey, firstBuffered.member)
    }

    if (ctx.zcard(bufferKey) === 0 && res.state === 'reconciling') {
      res.state = 'started'
    }
    ctx.setString(resKey, JSON.stringify(res))
    return JSON.stringify({
      status: 'recorded',
      sequence: streamSequence,
      lastReconciledSequence: res.lastReconciledSequence,
    })
  } else if (streamSequence > lastSeq + 1) {
    ctx.zadd(bufferKey, streamSequence, payloadJson)
    res.state = 'reconciling'
    ctx.setString(resKey, JSON.stringify(res))
    return JSON.stringify({
      status: 'buffered_gap',
      sequence: streamSequence,
      lastReconciledSequence: lastSeq,
      missingSequence: lastSeq + 1,
    })
  } else {
    throw new RedisScriptError(`ERR_STALE_SEQUENCE: sequence ${streamSequence} is already reconciled`)
  }
}

export const defaultSettleReservationHandler: ScriptHandler = (ctx, keys, args) => {
  const resKey = keys[0] ?? ''
  const bufferKey = keys[1] ?? ''
  const activeKey = keys[2]
  const nowIso = String(args[0] ?? '')
  const rawCost = args[1] !== undefined ? Number(args[1]) : -1
  const rawTokens = args[2] !== undefined ? Number(args[2]) : -1
  const hasExplicitCost = rawCost >= 0
  const hasExplicitTokens = rawTokens >= 0

  const raw = ctx.getString(resKey)
  if (!raw) throw new RedisScriptError('ERR_RESERVATION_NOT_FOUND')
  const res = JSON.parse(raw)

  if (res.state === 'settled' || res.state === 'withheld') {
    throw new RedisScriptError(`ERR_INVALID_TRANSITION: reservation is already ${res.state}`)
  }

  // Check buffer for unresolved gaps
  const bufferCount = ctx.zcard(bufferKey)
  if (bufferCount > 0) {
    if (nowIso < res.reconcileBy) {
      throw new RedisScriptError('ERR_UNRESOLVED_SEQUENCE_GAPS')
    } else {
      res.state = 'withheld'
      res.quarantineReason = 'ERR_RECONCILIATION_DEADLINE_EXPIRED'
      ctx.setString(resKey, JSON.stringify(res))
      if (activeKey) ctx.srem(activeKey, res.id)
      return JSON.stringify({ state: 'withheld', error: 'ERR_RECONCILIATION_DEADLINE_EXPIRED' })
    }
  }

  const fleetId = res.fleetId ?? 'default'
  const maxCost = res.maxCostMicros ?? 0
  const maxToks = res.maxTokens ?? 0

  const settledCost = hasExplicitCost
    ? rawCost
    : (res.settledCostMicros ?? 0)
  const settledToks = hasExplicitTokens
    ? rawTokens
    : (res.settledTokens ?? 0)

  // Deduct reservation from outstanding
  ctx.incrby(fleetKey(fleetId, 'outstanding:fleet:cost'), -maxCost)
  ctx.incrby(fleetKey(fleetId, 'outstanding:fleet:tokens'), -maxToks)
  ctx.incrby(fleetKey(fleetId, `outstanding:project:${res.projectId}:cost`), -maxCost)
  ctx.incrby(fleetKey(fleetId, `outstanding:project:${res.projectId}:tokens`), -maxToks)
  ctx.incrby(fleetKey(fleetId, `outstanding:host:${res.hostId}:cost`), -maxCost)
  ctx.incrby(fleetKey(fleetId, `outstanding:host:${res.hostId}:tokens`), -maxToks)

  // Credit actual settled spend to spend counters
  ctx.incrby(fleetKey(fleetId, `spend:fleet:daily:${res.accountingDay}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:fleet:daily:${res.accountingDay}:tokens`), settledToks)
  ctx.incrby(fleetKey(fleetId, `spend:fleet:monthly:${res.accountingMonth}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:fleet:monthly:${res.accountingMonth}:tokens`), settledToks)
  ctx.incrby(fleetKey(fleetId, `spend:project:${res.projectId}:daily:${res.accountingDay}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:project:${res.projectId}:daily:${res.accountingDay}:tokens`), settledToks)
  ctx.incrby(fleetKey(fleetId, `spend:project:${res.projectId}:monthly:${res.accountingMonth}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:project:${res.projectId}:monthly:${res.accountingMonth}:tokens`), settledToks)
  ctx.incrby(fleetKey(fleetId, `spend:host:${res.hostId}:daily:${res.accountingDay}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:host:${res.hostId}:daily:${res.accountingDay}:tokens`), settledToks)
  ctx.incrby(fleetKey(fleetId, `spend:host:${res.hostId}:monthly:${res.accountingMonth}:cost`), settledCost)
  ctx.incrby(fleetKey(fleetId, `spend:host:${res.hostId}:monthly:${res.accountingMonth}:tokens`), settledToks)

  res.state = 'settled'
  res.settledCostMicros = settledCost
  res.settledTokens = settledToks
  ctx.setString(resKey, JSON.stringify(res))
  if (activeKey) ctx.srem(activeKey, res.id)

  return JSON.stringify({
    reservationId: res.id,
    state: 'settled',
    settledCostMicros: settledCost,
    settledTokens: settledToks,
    refundedCostMicros: maxCost - settledCost,
    refundedTokens: maxToks - settledToks,
  })
}

export const defaultWithholdReservationHandler: ScriptHandler = (ctx, keys, args) => {
  const resKey = keys[0] ?? ''
  const activeKey = keys[1]
  const reason = String(args[0] ?? '')
  const raw = ctx.getString(resKey)
  if (!raw) throw new RedisScriptError('ERR_RESERVATION_NOT_FOUND')
  const res = JSON.parse(raw)
  if (res.state === 'settled' || res.state === 'withheld') {
    throw new RedisScriptError(`ERR_INVALID_TRANSITION: cannot withhold reservation in terminal state ${res.state}`)
  }
  res.state = 'withheld'
  res.quarantineReason = reason
  ctx.setString(resKey, JSON.stringify(res))
  if (activeKey) ctx.srem(activeKey, res.id)
  return 'OK'
}

export const defaultManagePausesHandler: ScriptHandler = (ctx, keys, args) => {
  const pausesKey = keys[0] ?? ''
  const action = String(args[0] ?? '')
  const reason = String(args[1] ?? '')
  if (action === 'pause') {
    ctx.sadd(pausesKey, reason)
  } else if (action === 'resume') {
    ctx.srem(pausesKey, reason)
  }
  return ctx.smembers(pausesKey)
}

export const defaultGetSpendMetricsHandler: ScriptHandler = (ctx, keys) => {
  const pausesKey = keys[0] ?? ''
  const fencingKey = keys[1] ?? ''
  const epochKey = keys[2] ?? ''
  const activeKey = keys[3]

  const tag = extractHashTag(epochKey)
  const fleetId = tag ? tag.replace(FLEET_HASH_TAG_PREFIX, '') : 'default'

  const pauses = ctx.smembers(pausesKey) as PauseReason[]
  const fencing = Number(ctx.getString(fencingKey) ?? 0)
  const epoch = ctx.getString(epochKey) ?? 'epoch-1'

  const outCost = Number(ctx.getString(fleetKey(fleetId, 'outstanding:fleet:cost')) ?? 0)
  const outTokens = Number(ctx.getString(fleetKey(fleetId, 'outstanding:fleet:tokens')) ?? 0)

  return JSON.stringify({
    pauses,
    fencing,
    fencingToken: fencing,
    epoch,
    authorityEpoch: epoch,
    activeReservationsCount: activeKey ? ctx.scard(activeKey) : 0,
    outstandingCostMicros: outCost,
    outstandingTokens: outTokens,
  })
}

function fallbackScriptRunner(
  ctx: InMemoryRedisContext,
  script: string,
  keys: string[],
  args: (string | number)[],
): unknown {
  const trimmed = script.trim()
  if (trimmed === 'return 1' || trimmed === 'return 1;') return 1
  if (trimmed === 'return 0' || trimmed === 'return 0;') return 0
  if (trimmed.includes('PING')) return 'PONG'
  const key0 = keys[0] ?? ''
  if (script.includes('SISMEMBER')) return ctx.sismember(key0, String(args[0] ?? '')) ? 1 : 0
  if (script.includes('SMEMBERS')) return ctx.smembers(key0)
  if (script.includes('ZCARD')) return ctx.zcard(key0)
  if (script.includes('SADD')) return ctx.sadd(key0, ...args.map(String))
  if (script.includes('SREM')) return ctx.srem(key0, ...args.map(String))
  const matchCall = trimmed.match(/^return\s+redis\.call\s*\(\s*["'](\w+)["']\s*(?:,\s*(.+))?\)$/i)
  if (matchCall && matchCall[1] !== undefined) {
    const cmd = matchCall[1].toUpperCase()
    if (cmd === 'PING') return 'PONG'
    if (cmd === 'SISMEMBER') return ctx.sismember(key0, String(args[0] ?? '')) ? 1 : 0
    if (cmd === 'SMEMBERS') return ctx.smembers(key0)
    if (cmd === 'ZCARD') return ctx.zcard(key0)
    if (cmd === 'GET') {
      const keyExpr = matchCall[2]?.trim()
      const key = keyExpr === 'KEYS[1]' ? key0 : (keyExpr?.replace(/['"]/g, '') ?? '')
      return ctx.getString(key)
    }
  }
  return 'OK'
}

// --- InMemoryRedisAdapter Implementation ---

export class InMemoryRedisAdapter implements RedisClientAdapter, InMemoryRedisContext {
  private readonly strings = new Map<string, { value: string; expiresAt?: number | undefined }>()
  private readonly hashes = new Map<string, Map<string, string>>()
  private readonly sets = new Map<string, Set<string>>()
  private readonly sortedSets = new Map<string, Map<string, number>>()

  private readonly scriptRegistry = new Map<string, ScriptHandler>()
  private readonly scriptSourceMap = new Map<string, string>()

  private readonly clock: () => number
  private readonly enforceCrossSlot: boolean
  private closed = false

  constructor(options: InMemoryRedisAdapterOptions = {}) {
    const rawClock = options.clock ?? (() => Date.now())
    this.clock = () => {
      const val = rawClock()
      return typeof val === 'string' ? Date.parse(val) : val
    }
    this.enforceCrossSlot = options.enforceCrossSlot ?? true
    this.registerDefaultScriptHandlers()
  }

  // --- Clock Methods ---
  nowMs(): number {
    return this.clock()
  }

  nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  // --- RedisClientAdapter Interface ---

  async ping(): Promise<string> {
    this.assertNotClosed()
    return 'PONG'
  }

  async quit(): Promise<void> {
    this.closed = true
  }

  async get(key: string): Promise<string | null> {
    this.assertNotClosed()
    return this.getString(key)
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<void> {
    this.assertNotClosed()
    let ttlMs: number | undefined
    if (options?.px) ttlMs = options.px
    else if (options?.ex) ttlMs = options.ex * 1000
    this.setString(key, value, ttlMs)
  }

  async del(...keys: string[]): Promise<number> {
    this.assertNotClosed()
    if (this.enforceCrossSlot) assertSameHashSlot(keys)
    return this.delKey(...keys)
  }

  async scriptLoad(script: string): Promise<string> {
    this.assertNotClosed()
    const sha = this.computeSha(script)
    this.scriptSourceMap.set(sha, script)
    if (!this.scriptRegistry.has(sha)) {
      const handler = this.resolveScriptHandler(script)
      if (handler) {
        this.scriptRegistry.set(sha, handler)
      }
    }
    return sha
  }

  async evalsha<T = unknown>(sha: string, keys: string[], args: (string | number)[]): Promise<T> {
    this.assertNotClosed()
    if (this.enforceCrossSlot) assertSameHashSlot(keys)
    const normalizedSha = sha.toLowerCase()
    const handler = this.scriptRegistry.get(normalizedSha)
    if (!handler) {
      throw new RedisNoScriptError(normalizedSha)
    }
    const result = await handler(this, keys, args)
    return result as T
  }

  async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    this.assertNotClosed()
    if (this.enforceCrossSlot) assertSameHashSlot(keys)
    const sha = await this.scriptLoad(script)
    return this.evalsha<T>(sha, keys, args)
  }

  // --- Script Registration API ---

  registerScript(script: string, handler: ScriptHandler): string {
    const sha = this.computeSha(script)
    this.scriptRegistry.set(sha, handler)
    this.scriptSourceMap.set(sha, script)
    return sha
  }

  registerScriptBySha(sha: string, handler: ScriptHandler): void {
    this.scriptRegistry.set(sha.toLowerCase(), handler)
  }

  // --- InMemoryRedisContext Methods ---

  getString(key: string): string | null {
    const entry = this.strings.get(key)
    if (!entry) return null
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.nowMs()) {
      this.strings.delete(key)
      return null
    }
    return entry.value
  }

  setString(key: string, value: string, ttlMs?: number | undefined): void {
    const expiresAt = ttlMs !== undefined ? this.nowMs() + ttlMs : undefined
    this.strings.set(key, { value, expiresAt })
  }

  delKey(...keys: string[]): number {
    let count = 0
    for (const key of keys) {
      if (this.strings.delete(key)) count++
      if (this.hashes.delete(key)) count++
      if (this.sets.delete(key)) count++
      if (this.sortedSets.delete(key)) count++
    }
    return count
  }

  existsKey(key: string): boolean {
    return (
      this.getString(key) !== null ||
      this.hashes.has(key) ||
      this.sets.has(key) ||
      this.sortedSets.has(key)
    )
  }

  incr(key: string): number {
    return this.incrby(key, 1)
  }

  incrby(key: string, increment: number): number {
    const current = this.getString(key)
    const num = current ? parseInt(current, 10) : 0
    if (Number.isNaN(num)) {
      throw new RedisAdapterError('ERR value is not an integer or out of range', 'ERR_NAN')
    }
    const next = num + increment
    this.setString(key, String(next))
    return next
  }

  hget(key: string, field: string): string | null {
    const hash = this.hashes.get(key)
    return hash?.get(field) ?? null
  }

  hset(key: string, field: string, value: string): number {
    let hash = this.hashes.get(key)
    if (!hash) {
      hash = new Map()
      this.hashes.set(key, hash)
    }
    const isNew = !hash.has(field)
    hash.set(field, value)
    return isNew ? 1 : 0
  }

  hdel(key: string, ...fields: string[]): number {
    const hash = this.hashes.get(key)
    if (!hash) return 0
    let count = 0
    for (const f of fields) {
      if (hash.delete(f)) count++
    }
    if (hash.size === 0) this.hashes.delete(key)
    return count
  }

  hgetall(key: string): Record<string, string> {
    const hash = this.hashes.get(key)
    if (!hash) return {}
    const result: Record<string, string> = {}
    for (const [k, v] of hash.entries()) {
      result[k] = v
    }
    return result
  }

  hincrby(key: string, field: string, increment: number): number {
    const current = this.hget(key, field)
    const num = current ? parseInt(current, 10) : 0
    if (Number.isNaN(num)) {
      throw new RedisAdapterError('ERR hash value is not an integer', 'ERR_NAN')
    }
    const next = num + increment
    this.hset(key, field, String(next))
    return next
  }

  hexists(key: string, field: string): boolean {
    return this.hashes.get(key)?.has(field) ?? false
  }

  sadd(key: string, ...members: string[]): number {
    let set = this.sets.get(key)
    if (!set) {
      set = new Set()
      this.sets.set(key, set)
    }
    let added = 0
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m)
        added++
      }
    }
    return added
  }

  srem(key: string, ...members: string[]): number {
    const set = this.sets.get(key)
    if (!set) return 0
    let removed = 0
    for (const m of members) {
      if (set.delete(m)) removed++
    }
    if (set.size === 0) this.sets.delete(key)
    return removed
  }

  smembers(key: string): string[] {
    const set = this.sets.get(key)
    return set ? Array.from(set) : []
  }

  sismember(key: string, member: string): boolean {
    return this.sets.get(key)?.has(member) ?? false
  }

  scard(key: string): number {
    return this.sets.get(key)?.size ?? 0
  }

  zadd(key: string, score: number, member: string): number {
    let zset = this.sortedSets.get(key)
    if (!zset) {
      zset = new Map()
      this.sortedSets.set(key, zset)
    }
    const isNew = !zset.has(member)
    zset.set(member, score)
    return isNew ? 1 : 0
  }

  zrem(key: string, ...members: string[]): number {
    const zset = this.sortedSets.get(key)
    if (!zset) return 0
    let removed = 0
    for (const m of members) {
      if (zset.delete(m)) removed++
    }
    if (zset.size === 0) this.sortedSets.delete(key)
    return removed
  }

  zrangebyscore(key: string, min: number, max: number): Array<{ member: string; score: number }> {
    const zset = this.sortedSets.get(key)
    if (!zset) return []
    const results: Array<{ member: string; score: number }> = []
    for (const [member, score] of zset.entries()) {
      if (score >= min && score <= max) {
        results.push({ member, score })
      }
    }
    results.sort((a, b) => a.score - b.score)
    return results
  }

  zcard(key: string): number {
    return this.sortedSets.get(key)?.size ?? 0
  }

  flushall(): void {
    this.strings.clear()
    this.hashes.clear()
    this.sets.clear()
    this.sortedSets.clear()
  }

  private computeSha(script: string): string {
    return createHash('sha1').update(script.trim()).digest('hex').toLowerCase()
  }

  private assertNotClosed(): void {
    if (this.closed) throw new RedisConnectionError('Connection is closed')
  }

  private resolveScriptHandler(script: string): ScriptHandler | undefined {
    if (script.includes('[df:reserve_spend]')) return defaultReserveSpendHandler
    if (script.includes('[df:start_reservation]')) return defaultStartReservationHandler
    if (script.includes('[df:record_usage]')) return defaultRecordUsageHandler
    if (script.includes('[df:settle_reservation]')) return defaultSettleReservationHandler
    if (script.includes('[df:withhold_reservation]')) return defaultWithholdReservationHandler
    if (script.includes('[df:manage_pauses]')) return defaultManagePausesHandler
    if (script.includes('[df:get_spend_metrics]')) return defaultGetSpendMetricsHandler
    if (script.includes('[df:get_active_pauses]') || script.includes('[df:get_active_ids]')) {
      return (ctx, keys) => ctx.smembers(keys[0] ?? '')
    }
    if (script.includes('[df:check_buffer]')) {
      return (ctx, keys) => ctx.zcard(keys[0] ?? '')
    }

    // Fallback for simple Lua scripts used in testing
    return (ctx, keys, args) => fallbackScriptRunner(ctx, script, keys, args)
  }

  private registerDefaultScriptHandlers(): void {
    this.registerScript(RESERVE_SPEND_LUA_SCRIPT, defaultReserveSpendHandler)
    this.registerScript(START_RESERVATION_LUA_SCRIPT, defaultStartReservationHandler)
    this.registerScript(RECORD_USAGE_LUA_SCRIPT, defaultRecordUsageHandler)
    this.registerScript(SETTLE_RESERVATION_LUA_SCRIPT, defaultSettleReservationHandler)
    this.registerScript(WITHHOLD_RESERVATION_LUA_SCRIPT, defaultWithholdReservationHandler)
    this.registerScript(MANAGE_PAUSES_LUA_SCRIPT, defaultManagePausesHandler)
    this.registerScript(GET_SPEND_METRICS_LUA_SCRIPT, defaultGetSpendMetricsHandler)
  }
}

// --- RESP Encoding and Parsing Functions ---

export function encodeRespCommand(args: (string | number)[]): Buffer {
  const chunks: Buffer[] = []
  chunks.push(Buffer.from(`*${args.length}\r\n`, 'utf8'))
  for (const arg of args) {
    const str = typeof arg === 'string' ? arg : String(arg)
    const strBuf = Buffer.from(str, 'utf8')
    chunks.push(Buffer.from(`$${strBuf.length}\r\n`, 'utf8'))
    chunks.push(strBuf)
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  return Buffer.concat(chunks)
}

export interface RespParseResult {
  value: any
  bytesConsumed: number
  isError: boolean
}

export function parseResp(buf: Buffer): RespParseResult | null {
  if (buf.length === 0) return null
  const b0 = buf[0]
  if (b0 === undefined) return null
  const prefix = String.fromCharCode(b0)

  switch (prefix) {
    case '+': {
      const crlf = buf.indexOf('\r\n')
      if (crlf === -1) return null
      const value = buf.subarray(1, crlf).toString('utf8')
      return { value, bytesConsumed: crlf + 2, isError: false }
    }
    case '-': {
      const crlf = buf.indexOf('\r\n')
      if (crlf === -1) return null
      const value = buf.subarray(1, crlf).toString('utf8')
      return { value, bytesConsumed: crlf + 2, isError: true }
    }
    case ':': {
      const crlf = buf.indexOf('\r\n')
      if (crlf === -1) return null
      const numStr = buf.subarray(1, crlf).toString('utf8')
      const value = parseInt(numStr, 10)
      return { value, bytesConsumed: crlf + 2, isError: false }
    }
    case '$': {
      const crlf = buf.indexOf('\r\n')
      if (crlf === -1) return null
      const lenStr = buf.subarray(1, crlf).toString('utf8')
      const len = parseInt(lenStr, 10)
      if (len === -1) {
        return { value: null, bytesConsumed: crlf + 2, isError: false }
      }
      const dataStart = crlf + 2
      const dataEnd = dataStart + len
      if (buf.length < dataEnd + 2) return null
      const value = buf.subarray(dataStart, dataEnd).toString('utf8')
      return { value, bytesConsumed: dataEnd + 2, isError: false }
    }
    case '*': {
      const crlf = buf.indexOf('\r\n')
      if (crlf === -1) return null
      const countStr = buf.subarray(1, crlf).toString('utf8')
      const count = parseInt(countStr, 10)
      if (count === -1) {
        return { value: null, bytesConsumed: crlf + 2, isError: false }
      }
      let offset = crlf + 2
      const elements: any[] = []
      let firstError: RespParseResult | null = null
      for (let i = 0; i < count; i++) {
        const elemResult = parseResp(buf.subarray(offset))
        if (!elemResult) return null
        if (elemResult.isError && !firstError) {
          firstError = elemResult
        }
        elements.push(elemResult.value)
        offset += elemResult.bytesConsumed
      }
      if (firstError) {
        return { value: firstError.value, bytesConsumed: offset, isError: true }
      }
      return { value: elements, bytesConsumed: offset, isError: false }
    }
    default:
      throw new RedisAdapterError(`Unknown RESP prefix: ${prefix}`, 'REDIS_PROTOCOL_ERROR')
  }
}

// --- TlsRedisClientAdapter Implementation ---

export interface TlsRedisClientOptions {
  readonly endpoint: string // rediss://host:port
  readonly secretRef?: SecretRef | undefined
  readonly authPassword?: string | undefined
  readonly connectionTimeoutMs?: number | undefined
  readonly commandTimeoutMs?: number | undefined
  readonly rejectUnauthorized?: boolean | undefined
  readonly ca?: string | Buffer | undefined
  readonly cert?: string | Buffer | undefined
  readonly key?: string | Buffer | undefined
}

interface QueuedCommand {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class TlsRedisClientAdapter implements RedisClientAdapter {
  private socket: tls.TLSSocket | null = null
  private readonly commandQueue: QueuedCommand[] = []
  private rxBuffer: Buffer = Buffer.alloc(0)
  private connected = false
  private connectingPromise: Promise<void> | null = null
  private closed = false

  private readonly host: string
  private readonly port: number
  private readonly connectionTimeoutMs: number
  private readonly commandTimeoutMs: number
  private readonly rejectUnauthorized: boolean

  constructor(private readonly options: TlsRedisClientOptions) {
    const url = new URL(options.endpoint)
    if (url.protocol !== 'rediss:') {
      throw new RedisConnectionError(`TlsRedisClientAdapter requires rediss:// endpoint, received: ${url.protocol}`)
    }
    this.host = url.hostname
    this.port = url.port ? parseInt(url.port, 10) : 6379
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? 5000
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000
    this.rejectUnauthorized = options.rejectUnauthorized ?? true
  }

  async get(key: string): Promise<string | null> {
    return this.executeCommand(['GET', key]) as Promise<string | null>
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<void> {
    const args: (string | number)[] = ['SET', key, value]
    if (options?.px) args.push('PX', options.px)
    else if (options?.ex) args.push('EX', options.ex)
    if (options?.nx) args.push('NX')
    else if (options?.xx) args.push('XX')
    await this.executeCommand(args)
  }

  async del(...keys: string[]): Promise<number> {
    assertSameHashSlot(keys)
    return this.executeCommand(['DEL', ...keys]) as Promise<number>
  }

  async ping(): Promise<string> {
    return this.executeCommand(['PING']) as Promise<string>
  }

  async scriptLoad(script: string): Promise<string> {
    return this.executeCommand(['SCRIPT', 'LOAD', script]) as Promise<string>
  }

  async eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    assertSameHashSlot(keys)
    const cmdArgs: (string | number)[] = ['EVAL', script, keys.length, ...keys, ...args]
    return this.executeCommand(cmdArgs) as Promise<T>
  }

  async evalsha<T = unknown>(sha: string, keys: string[], args: (string | number)[]): Promise<T> {
    assertSameHashSlot(keys)
    const cmdArgs: (string | number)[] = ['EVALSHA', sha, keys.length, ...keys, ...args]
    return this.executeCommand(cmdArgs) as Promise<T>
  }

  async quit(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (this.connected && this.socket && !this.socket.destroyed) {
        await this.executeCommand(['QUIT'])
      }
    } catch {
      // Ignore errors on quit
    } finally {
      this.cleanup(new RedisConnectionError('Connection closed via quit()'))
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new RedisConnectionError('Redis client is closed')
    if (this.connected && this.socket && !this.socket.destroyed) return
    if (this.connectingPromise) return this.connectingPromise

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.cleanup(
            new RedisConnectionError(
              `Connection to ${this.host}:${this.port} timed out after ${this.connectionTimeoutMs}ms`,
            ),
          )
          reject(new RedisConnectionError(`Connection timeout to ${this.host}:${this.port}`))
        }
      }, this.connectionTimeoutMs)

      try {
        const socket = tls.connect({
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: this.rejectUnauthorized,
          ca: this.options.ca,
          cert: this.options.cert,
          key: this.options.key,
        })

        this.socket = socket

        socket.on('secureConnect', async () => {
          socket.setNoDelay(true)
          socket.setKeepAlive(true, 10_000)

          try {
            let password = this.options.authPassword
            if (!password && this.options.secretRef) {
              password = await resolveSecret(this.options.secretRef)
            }
            if (password) {
              await this.sendRawCommand(['AUTH', password])
            }
            this.connected = true
            clearTimeout(timeout)
            resolved = true
            resolve()
          } catch (authErr) {
            clearTimeout(timeout)
            resolved = true
            this.cleanup(authErr instanceof Error ? authErr : new Error(String(authErr)))
            reject(authErr)
          }
        })

        socket.on('data', (chunk: Buffer) => {
          this.rxBuffer = Buffer.concat([this.rxBuffer, chunk])
          this.processRxBuffer()
        })

        socket.on('error', err => {
          this.cleanup(new RedisConnectionError(`Socket error: ${err.message}`))
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            reject(err)
          }
        })

        socket.on('close', () => {
          this.cleanup(new RedisConnectionError('Socket closed by remote Redis server'))
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            reject(new RedisConnectionError('Connection closed before secureConnect'))
          }
        })
      } catch (err) {
        clearTimeout(timeout)
        resolved = true
        reject(err)
      }
    }).finally(() => {
      this.connectingPromise = null
    })

    return this.connectingPromise
  }

  private async executeCommand(args: (string | number)[]): Promise<unknown> {
    await this.ensureConnected()
    return this.sendRawCommand(args)
  }

  private sendRawCommand(args: (string | number)[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const commandStr = args[0] ? String(args[0]) : 'UNKNOWN'
      const timer = setTimeout(() => {
        const idx = this.commandQueue.findIndex(q => q.timer === timer)
        if (idx !== -1) {
          this.commandQueue.splice(idx, 1)
          reject(new RedisCommandTimeoutError(commandStr, this.commandTimeoutMs))
          this.cleanup(new RedisConnectionError(`Command ${commandStr} timed out; closing corrupted stream`))
        }
      }, this.commandTimeoutMs)

      this.commandQueue.push({ command: commandStr, resolve, reject, timer })
      const payload = encodeRespCommand(args)
      this.socket?.write(payload, err => {
        if (err) {
          clearTimeout(timer)
          const idx = this.commandQueue.findIndex(q => q.timer === timer)
          if (idx !== -1) this.commandQueue.splice(idx, 1)
          reject(new RedisConnectionError(`Failed to write command: ${err.message}`))
        }
      })
    })
  }

  private processRxBuffer(): void {
    while (this.rxBuffer.length > 0 && this.commandQueue.length > 0) {
      const parseResult = parseResp(this.rxBuffer)
      if (!parseResult) {
        break
      }
      this.rxBuffer = this.rxBuffer.subarray(parseResult.bytesConsumed)
      const queued = this.commandQueue.shift()!
      clearTimeout(queued.timer)

      if (parseResult.isError) {
        if (typeof parseResult.value === 'string' && parseResult.value.startsWith('NOSCRIPT')) {
          queued.reject(new RedisNoScriptError(parseResult.value))
        } else if (typeof parseResult.value === 'string' && parseResult.value.startsWith('CROSSSLOT')) {
          queued.reject(new RedisCrossSlotError([], []))
        } else {
          queued.reject(new RedisScriptError(String(parseResult.value)))
        }
      } else {
        queued.resolve(parseResult.value)
      }
    }
  }

  private cleanup(err: Error): void {
    this.connected = false
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy()
    }
    this.socket = null
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!
      clearTimeout(cmd.timer)
      cmd.reject(err)
    }
  }
}
