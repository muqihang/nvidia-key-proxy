import { DurableObject } from 'cloudflare:workers';
import { ApiError, invalidRequest, serviceUnavailable } from './errors';
import {
  createValidatedSseStream,
  injectIdentity,
  prefetchValidSse,
  raceModels,
  toApiError,
  validateChatRequest,
} from './protocol';
import { constantTimeEqual, maskSecret, secretFingerprint } from './security';
import type { ChatRequest, JsonObject, KeyMapping, ModelConfig } from './types';

export interface WorkerEnv extends Env {
  ADMIN_TOKEN: string;
}

const UPSTREAM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const MAX_ADMIN_PAGE_SIZE = 100;

const MODEL_CONFIGS: Readonly<Record<string, ModelConfig>> = {
  'deepseek-v4-flash': {
    identity: 'DeepSeek V4 Flash',
    fallback_chain: [
      'deepseek-ai/deepseek-v4-flash-0731',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'z-ai/glm-5.2',
      'minimaxai/minimax-m3',
    ],
  },
  'deepseek-v4-pro': {
    identity: 'DeepSeek V4 Pro',
    fallback_chain: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'deepseek-ai/deepseek-v4-flash-0731',
      'z-ai/glm-5.2',
      'minimaxai/minimax-m3',
    ],
  },
};

export class UsageCounter extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage_counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        request_count INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO usage_counter (singleton, request_count) VALUES (1, 0);
    `);
  }

  increment(): number {
    return this.ctx.storage.sql.exec<{ request_count: number }>(
      'UPDATE usage_counter SET request_count = request_count + 1 WHERE singleton = 1 RETURNING request_count',
    ).one().request_count;
  }

  ensureAtLeast(value: number): number {
    return this.ctx.storage.sql.exec<{ request_count: number }>(
      `UPDATE usage_counter
       SET request_count = MAX(request_count, ?)
       WHERE singleton = 1
       RETURNING request_count`,
      Math.max(0, Math.floor(value)),
    ).one().request_count;
  }

  getCount(): number {
    return this.ctx.storage.sql.exec<{ request_count: number }>(
      'SELECT request_count FROM usage_counter WHERE singleton = 1',
    ).one().request_count;
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        return await handleChatCompletion(request, env, ctx);
      }
      if (url.pathname === '/v1/models' && request.method === 'GET') return handleListModels();
      if (url.pathname === '/admin/keys' && request.method === 'POST') return await handleAdminCreateKey(request, env);
      if (url.pathname === '/admin/keys' && request.method === 'GET') return await handleAdminListKeys(request, env);
      throw new ApiError('Not found.', 404, 'invalid_request_error', 'not_found');
    } catch (error) {
      const apiError = toApiError(error);
      logError('request_failed', error, { method: request.method, path: url.pathname, status: apiError.status });
      return jsonResponse(apiError.toBody(), apiError.status);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleChatCompletion(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const customerKey = parseBearerToken(request.headers.get('Authorization'));
  const mapping = await loadKeyMapping(customerKey, env);

  // Check expiration for time-based cards
  if (mapping.expires_at && Date.now() > mapping.expires_at) {
    throw new ApiError(
      'API key has expired.',
      401,
      'authentication_error',
      'expired_api_key',
    );
  }

  // Check quota for request-count-based cards
  if (mapping.max_requests !== undefined) {
    const usageName = await secretFingerprint(customerKey);
    const currentCount = await env.USAGE_COUNTERS.getByName(usageName).getCount();
    
    if (currentCount >= mapping.max_requests) {
      throw new ApiError(
        `API key usage limit exceeded. Maximum ${mapping.max_requests} requests allowed.`,
        429,
        'rate_limit_error',
        'quota_exceeded',
      );
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    throw invalidRequest('Request body contains invalid JSON.', 'invalid_json');
  }
  const body = validateChatRequest(rawBody);
  const modelConfig = MODEL_CONFIGS[body.model];
  if (!modelConfig) {
    throw invalidRequest(
      `Model '${body.model}' not found. Available models: ${Object.keys(MODEL_CONFIGS).join(', ')}.`,
      'model_not_found',
      'model',
    );
  }

  const messages = injectIdentity(body.messages, modelConfig.identity);
  const upstreamBody: JsonObject = { ...body, messages };
  const nvidiaKeys = orderedNvidiaKeys(mapping.nvidia_keys, customerKey);
  const usageName = await secretFingerprint(customerKey);
  const usageCounter = env.USAGE_COUNTERS.getByName(usageName);
  ctx.waitUntil(
    (async () => {
      if (mapping.request_count !== undefined) await usageCounter.ensureAtLeast(mapping.request_count);
      await usageCounter.increment();
    })().catch(error => logError('usage_increment_failed', error, { customer: usageName })),
  );

  if (body.stream) {
    return streamWithFallback(
      modelConfig.fallback_chain,
      nvidiaKeys,
      upstreamBody,
      body,
      modelConfig.identity,
    );
  }

  const result = await raceModels(
    modelConfig.fallback_chain,
    nvidiaKeys,
    upstreamBody,
    body.model,
    modelConfig.identity,
  );
  return jsonResponse(result);
}

async function streamWithFallback(
  models: string[],
  apiKeys: string[],
  upstreamBody: JsonObject,
  clientBody: ChatRequest,
  identity: string,
): Promise<Response> {
  for (const model of models) {
    for (const [keyIndex, apiKey] of apiKeys.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('first event timeout'), FIRST_EVENT_TIMEOUT_MS);
      try {
        const response = await fetch(UPSTREAM_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...upstreamBody, model, stream: true }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          logWarning('stream_model_rejected', { model, key_index: keyIndex, status: response.status });
          continue;
        }

        const validated = await prefetchValidSse(response.body, controller.signal);
        clearTimeout(timer);
        const stream = createValidatedSseStream(validated, clientBody.model, identity, clientBody);
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            ...corsHeaders(),
          },
        });
      } catch (error) {
        logWarning('stream_model_failed_before_commit', {
          model,
          key_index: keyIndex,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw serviceUnavailable();
}

function handleListModels(): Response {
  const created = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: 'list',
    data: Object.keys(MODEL_CONFIGS).map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'deepseek',
      context_window: 1_048_576,
      max_output_tokens: 32_768,
    })),
  });
}

async function handleAdminCreateKey(request: Request, env: WorkerEnv): Promise<Response> {
  await requireAdmin(request, env);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidRequest('Request body contains invalid JSON.', 'invalid_json');
  }
  if (!isObject(body) || !Array.isArray(body.nvidia_keys)) {
    throw invalidRequest('nvidia_keys must be an array of one or two keys.', 'invalid_nvidia_keys', 'nvidia_keys');
  }
  const nvidiaKeys = body.nvidia_keys;
  if (
    nvidiaKeys.length < 1
    || nvidiaKeys.length > 2
    || nvidiaKeys.some(key => typeof key !== 'string' || key.trim().length < 8)
  ) {
    throw invalidRequest('nvidia_keys must contain one or two non-empty keys.', 'invalid_nvidia_keys', 'nvidia_keys');
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    throw invalidRequest('note must be a string.', 'invalid_note', 'note');
  }

  // Validate days parameter (1, 7, 15, 30)
  if (body.days !== undefined) {
    if (typeof body.days !== 'number' || ![1, 7, 15, 30].includes(body.days)) {
      throw invalidRequest('days must be one of: 1, 7, 15, 30.', 'invalid_days', 'days');
    }
  }

  // Validate max_requests parameter (2000, 5000)
  if (body.max_requests !== undefined) {
    if (typeof body.max_requests !== 'number' || ![2000, 5000].includes(body.max_requests)) {
      throw invalidRequest('max_requests must be one of: 2000, 5000.', 'invalid_max_requests', 'max_requests');
    }
  }

  const customerKey = `sk-${randomHex(24)}`;
  const mapping: KeyMapping = {
    nvidia_keys: nvidiaKeys.map(key => String(key).trim()),
    created_at: new Date().toISOString(),
    note: body.note?.slice(0, 500) ?? '',
  };

  // Set expiration for time-based cards
  if (typeof body.days === 'number') {
    mapping.expires_at = Date.now() + body.days * 86400000; // days to milliseconds
  }

  // Set quota for request-count-based cards
  if (typeof body.max_requests === 'number') {
    mapping.max_requests = body.max_requests;
  }

  await env.KEY_MAPPINGS.put(customerKey, JSON.stringify(mapping));
  return jsonResponse({
    customer_key: customerKey,
    created_at: mapping.created_at,
    expires_at: mapping.expires_at ? new Date(mapping.expires_at).toISOString() : null,
    max_requests: mapping.max_requests ?? null,
    note: mapping.note,
    nvidia_keys: mapping.nvidia_keys.map(maskSecret),
  }, 201);
}

async function handleAdminListKeys(request: Request, env: WorkerEnv): Promise<Response> {
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_ADMIN_PAGE_SIZE) {
    throw invalidRequest(`limit must be an integer between 1 and ${MAX_ADMIN_PAGE_SIZE}.`, 'invalid_limit', 'limit');
  }
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const list = await env.KEY_MAPPINGS.list({ limit: requestedLimit, cursor });
  const keys = await Promise.all(list.keys.map(async key => {
    const [mappingJson, fingerprint] = await Promise.all([
      env.KEY_MAPPINGS.get(key.name),
      secretFingerprint(key.name),
    ]);
    if (!mappingJson) return null;
    const mapping = parseKeyMapping(mappingJson);
    const requestCount = await env.USAGE_COUNTERS.getByName(fingerprint).getCount().catch(() => 0);
    return {
      customer_key: maskSecret(key.name),
      customer_key_fingerprint: fingerprint,
      nvidia_keys: mapping.nvidia_keys.map(maskSecret),
      created_at: mapping.created_at,
      note: mapping.note ?? '',
      request_count: requestCount,
    };
  }));

  return jsonResponse({
    object: 'list',
    data: keys.filter(key => key !== null),
    has_more: !list.list_complete,
    next_cursor: list.list_complete ? null : list.cursor,
  });
}

function parseBearerToken(header: string | null): string {
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError('Missing Authorization bearer token.', 401, 'authentication_error', 'missing_api_key');
  }
  const token = header.slice(7).trim();
  if (!token) throw new ApiError('Missing Authorization bearer token.', 401, 'authentication_error', 'missing_api_key');
  return token;
}

async function loadKeyMapping(customerKey: string, env: WorkerEnv): Promise<KeyMapping> {
  const mappingJson = await env.KEY_MAPPINGS.get(customerKey);
  if (!mappingJson) throw new ApiError('Invalid API key.', 401, 'authentication_error', 'invalid_api_key');
  try {
    return parseKeyMapping(mappingJson);
  } catch (error) {
    logError('invalid_key_mapping', error, { customer: await secretFingerprint(customerKey) });
    throw new ApiError('API key configuration is invalid.', 503, 'server_error', 'key_configuration_error');
  }
}

function parseKeyMapping(mappingJson: string): KeyMapping {
  const parsed: unknown = JSON.parse(mappingJson);
  if (
    !isObject(parsed)
    || !Array.isArray(parsed.nvidia_keys)
    || parsed.nvidia_keys.length < 1
    || parsed.nvidia_keys.some(key => typeof key !== 'string' || key.length === 0)
    || typeof parsed.created_at !== 'string'
  ) {
    throw new Error('Invalid key mapping.');
  }
  return {
    nvidia_keys: parsed.nvidia_keys as string[],
    created_at: parsed.created_at,
    note: typeof parsed.note === 'string' ? parsed.note : '',
    request_count: typeof parsed.request_count === 'number' && Number.isFinite(parsed.request_count)
      ? Math.max(0, Math.floor(parsed.request_count))
      : undefined,
    expires_at: typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at)
      ? Math.floor(parsed.expires_at)
      : undefined,
    max_requests: typeof parsed.max_requests === 'number' && Number.isFinite(parsed.max_requests)
      ? Math.max(0, Math.floor(parsed.max_requests))
      : undefined,
  };
}

async function requireAdmin(request: Request, env: WorkerEnv): Promise<void> {
  const provided = request.headers.get('X-Admin-Token') ?? '';
  if (!provided || !await constantTimeEqual(provided, env.ADMIN_TOKEN)) {
    throw new ApiError('Unauthorized.', 401, 'authentication_error', 'invalid_admin_token');
  }
}

function orderedNvidiaKeys(keys: string[], customerKey: string): string[] {
  if (keys.length === 1) return [...keys];
  const hash = [...customerKey].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const offset = (hash + Math.floor(Date.now() / 30_000)) % keys.length;
  return [...keys.slice(offset), ...keys.slice(0, offset)];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map(value => value.toString(16).padStart(2, '0')).join('');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function logWarning(event: string, fields: JsonObject): void {
  console.warn({ level: 'warning', event, ...fields });
}

function logError(event: string, error: unknown, fields: JsonObject): void {
  console.error({
    level: 'error',
    event,
    error: error instanceof Error ? error.name : 'unknown',
    ...fields,
  });
}
