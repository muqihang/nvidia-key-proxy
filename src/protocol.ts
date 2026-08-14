import { ApiError, invalidRequest, serviceUnavailable } from './errors';
import { cleanIdentity, CrossChunkIdentitySanitizer } from './identity';
import type { ChatChoice, ChatCompletion, ChatMessage, ChatRequest, JsonObject } from './types';

const encoder = new TextEncoder();
const UPSTREAM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

type UpstreamCaller = (
  model: string,
  apiKey: string,
  body: JsonObject,
  signal: AbortSignal,
) => Promise<JsonObject>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject, field: string): string | undefined {
  return typeof value[field] === 'string' ? value[field] : undefined;
}

function assertNumberInRange(
  value: JsonObject,
  field: string,
  minimum: number,
  maximum: number,
  integer = false,
): void {
  const candidate = value[field];
  if (candidate === undefined) return;
  if (
    typeof candidate !== 'number'
    || !Number.isFinite(candidate)
    || candidate < minimum
    || candidate > maximum
    || (integer && !Number.isInteger(candidate))
  ) {
    const qualifier = integer ? 'integer ' : '';
    throw invalidRequest(
      `${field} must be a ${qualifier}between ${minimum} and ${maximum}.`,
      `invalid_${field}`,
      field,
    );
  }
}

export function validateChatRequest(value: unknown): ChatRequest {
  if (!isObject(value)) throw invalidRequest('Request body must be a JSON object.', 'invalid_json');
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw invalidRequest('model must be a non-empty string.', 'invalid_model', 'model');
  }
  if (!Array.isArray(value.messages)) {
    throw invalidRequest('messages must be an array.', 'invalid_messages', 'messages');
  }
  if (value.messages.length === 0) {
    throw invalidRequest('messages must contain at least one message.', 'invalid_messages', 'messages');
  }
  for (const [index, message] of value.messages.entries()) {
    if (!isObject(message) || typeof message.role !== 'string') {
      throw invalidRequest(`messages[${index}] must contain a role.`, 'invalid_message', `messages.${index}`);
    }
    if (!('content' in message) && !('tool_calls' in message)) {
      throw invalidRequest(`messages[${index}] must contain content or tool_calls.`, 'invalid_message', `messages.${index}`);
    }
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') {
    throw invalidRequest('stream must be a boolean.', 'invalid_stream', 'stream');
  }
  if (value.n !== undefined && (!Number.isInteger(value.n) || Number(value.n) < 1 || Number(value.n) > 8)) {
    throw invalidRequest('n must be an integer between 1 and 8.', 'invalid_n', 'n');
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw invalidRequest('tools must be an array.', 'invalid_tools', 'tools');
  }
  if (value.response_format !== undefined && !isObject(value.response_format)) {
    throw invalidRequest('response_format must be an object.', 'invalid_response_format', 'response_format');
  }
  if (value.stream_options !== undefined && !isObject(value.stream_options)) {
    throw invalidRequest('stream_options must be an object.', 'invalid_stream_options', 'stream_options');
  }
  if (value.logprobs !== undefined && typeof value.logprobs !== 'boolean') {
    throw invalidRequest('logprobs must be a boolean.', 'invalid_logprobs', 'logprobs');
  }
  if (value.stop !== undefined) {
    const stopIsValid = typeof value.stop === 'string'
      || (Array.isArray(value.stop)
        && value.stop.length <= 4
        && value.stop.every(stop => typeof stop === 'string'));
    if (!stopIsValid) throw invalidRequest('stop must be a string or an array of up to 4 strings.', 'invalid_stop', 'stop');
  }
  if (value.tool_choice !== undefined) {
    const choice = value.tool_choice;
    const validString = choice === 'none' || choice === 'auto' || choice === 'required';
    const validFunction = isObject(choice)
      && choice.type === 'function'
      && isObject(choice.function)
      && typeof choice.function.name === 'string';
    if (!validString && !validFunction) {
      throw invalidRequest('tool_choice is invalid.', 'invalid_tool_choice', 'tool_choice');
    }
  }
  assertNumberInRange(value, 'temperature', 0, 2);
  assertNumberInRange(value, 'top_p', 0, 1);
  assertNumberInRange(value, 'frequency_penalty', -2, 2);
  assertNumberInRange(value, 'presence_penalty', -2, 2);
  assertNumberInRange(value, 'max_tokens', 1, 1_000_000, true);
  assertNumberInRange(value, 'max_completion_tokens', 1, 1_000_000, true);
  assertNumberInRange(value, 'top_logprobs', 0, 20, true);
  if (value.top_logprobs !== undefined && value.logprobs !== true) {
    throw invalidRequest('top_logprobs requires logprobs=true.', 'invalid_top_logprobs', 'top_logprobs');
  }

  return {
    ...value,
    model: value.model,
    messages: value.messages as JsonObject[],
    stream: value.stream ?? false,
  };
}

export function injectIdentity(messages: JsonObject[], identity: string): JsonObject[] {
  const cloned = messages.map(message => ({ ...message }));
  const note = `You are ${identity}. Always identify yourself as ${identity}. Never mention upstream providers or fallback models.`;
  const first = cloned[0];

  if (first?.role === 'system' && typeof first.content === 'string') {
    first.content = `${note}\n${first.content}`;
  } else {
    cloned.unshift({ role: 'system', content: note });
  }
  return cloned;
}

function validateToolCalls(toolCalls: unknown): boolean {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  return toolCalls.every(toolCall => {
    if (!isObject(toolCall) || toolCall.type !== 'function' || !isObject(toolCall.function)) return false;
    if (typeof toolCall.function.name !== 'string' || typeof toolCall.function.arguments !== 'string') return false;
    try {
      JSON.parse(toolCall.function.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

function requestedToolName(body: JsonObject): string | undefined {
  const choice = body.tool_choice;
  if (!isObject(choice) || !isObject(choice.function)) return undefined;
  return typeof choice.function.name === 'string' ? choice.function.name : undefined;
}

function messageCallsTool(message: ChatMessage, name: string): boolean {
  if (!Array.isArray(message.tool_calls)) return false;
  return message.tool_calls.some(toolCall =>
    isObject(toolCall)
    && isObject(toolCall.function)
    && toolCall.function.name === name);
}

function requiresToolCall(body: JsonObject): boolean {
  const choice = body.tool_choice;
  return choice === 'required' || (isObject(choice) && choice.type === 'function');
}

function requiresJson(body: JsonObject): boolean {
  return isObject(body.response_format)
    && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
}

export function validateAndNormalizeCompletion(
  raw: unknown,
  body: JsonObject,
  userModel: string,
  identity: string,
): ChatCompletion {
  if (!isObject(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new Error('Upstream returned no choices.');
  }
  const expectedChoices = typeof body.n === 'number' ? body.n : 1;
  if (raw.choices.length < expectedChoices) throw new Error('Upstream returned fewer choices than requested.');
  const requiredToolName = requestedToolName(body);

  const choices: ChatChoice[] = raw.choices.map((candidate, position) => {
    if (!isObject(candidate) || !isObject(candidate.message)) {
      throw new Error(`Upstream choice ${position} has no assistant message.`);
    }
    const upstreamMessage = candidate.message;
    const message: ChatMessage = {
      role: typeof upstreamMessage.role === 'string' ? upstreamMessage.role : 'assistant',
      content: upstreamMessage.content ?? null,
      ...(upstreamMessage.reasoning_content !== undefined
        ? { reasoning_content: upstreamMessage.reasoning_content }
        : {}),
      ...(upstreamMessage.refusal !== undefined ? { refusal: upstreamMessage.refusal } : {}),
      ...(upstreamMessage.tool_calls !== undefined ? { tool_calls: upstreamMessage.tool_calls } : {}),
      ...(upstreamMessage.function_call !== undefined ? { function_call: upstreamMessage.function_call } : {}),
    };
    const content = message.content;
    const reasoning = message.reasoning_content;
    const hasText = typeof content === 'string' || typeof reasoning === 'string';
    const hasTools = validateToolCalls(message.tool_calls);
    if (!hasText && !hasTools) throw new Error(`Upstream choice ${position} has no usable content.`);
    if (requiresToolCall(body) && !hasTools) throw new Error('Upstream ignored required tool_choice.');
    if (requiredToolName && !messageCallsTool(message, requiredToolName)) {
      throw new Error('Upstream called a different function than requested.');
    }
    if (body.logprobs === true && !Array.isArray(candidate.logprobs) && !isObject(candidate.logprobs)) {
      throw new Error('Upstream omitted requested logprobs.');
    }
    if (requiresJson(body) && typeof content === 'string') {
      try {
        JSON.parse(content);
      } catch {
        throw new Error('Upstream returned invalid JSON for response_format.');
      }
    }
    if (typeof content === 'string') message.content = cleanIdentity(content, identity);
    if (typeof reasoning === 'string') message.reasoning_content = cleanIdentity(reasoning, identity);
    if (typeof message.refusal === 'string') message.refusal = cleanIdentity(message.refusal, identity);

    return {
      index: typeof candidate.index === 'number' ? candidate.index : position,
      message,
      finish_reason: candidate.finish_reason ?? null,
      ...(candidate.logprobs !== undefined ? { logprobs: candidate.logprobs } : {}),
    };
  });

  return {
    id: typeof raw.id === 'string' ? raw.id : `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: typeof raw.created === 'number' ? raw.created : Math.floor(Date.now() / 1000),
    model: userModel,
    choices,
    ...(isObject(raw.usage) ? { usage: raw.usage } : {}),
    system_fingerprint: null,
  };
}

async function defaultUpstreamCaller(
  model: string,
  apiKey: string,
  body: JsonObject,
  signal: AbortSignal,
): Promise<JsonObject> {
  const response = await fetch(UPSTREAM_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model, stream: false }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Upstream ${model} returned HTTP ${response.status}.`);
  }
  const data: unknown = await response.json();
  if (!isObject(data)) throw new Error(`Upstream ${model} returned invalid JSON.`);
  return data;
}

export async function raceModels(
  models: string[],
  apiKeys: string[],
  body: JsonObject,
  userModel: string,
  identity: string,
  caller: UpstreamCaller = defaultUpstreamCaller,
): Promise<ChatCompletion> {
  if (apiKeys.length === 0) throw serviceUnavailable();
  const activeControllers = new Set<AbortController>();
  let settled = false;
  const attempts = models.map(async model => {
    for (const apiKey of apiKeys) {
      if (settled) throw new Error('Race already settled.');
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort('timeout'), 25_000);
      try {
        const raw = await caller(
          model,
          apiKey,
          { ...body, stream: false, stream_options: undefined },
          controller.signal,
        );
        return validateAndNormalizeCompletion(raw, body, userModel, identity);
      } catch (error) {
        if (settled) throw error;
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    }
    throw new Error(`All credentials failed for ${model}.`);
  });

  try {
    const result = await Promise.any(attempts);
    settled = true;
    return result;
  } catch {
    throw serviceUnavailable();
  } finally {
    settled = true;
    for (const controller of activeControllers) controller.abort('race settled');
  }
}

interface SseEvent {
  data: string;
}

class SseParser {
  private buffer = '';
  private dataLines: string[] = [];

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.processLine(line, events);
      newline = this.buffer.indexOf('\n');
    }
    return events;
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) this.processLine(this.buffer.replace(/\r$/, ''), events);
    this.buffer = '';
    if (this.dataLines.length > 0) this.emit(events);
    return events;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      if (this.dataLines.length > 0) this.emit(events);
      return;
    }
    if (line.startsWith(':')) return;
    if (line === 'data') this.dataLines.push('');
    else if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
  }

  private emit(events: SseEvent[]): void {
    events.push({ data: this.dataLines.join('\n') });
    this.dataLines = [];
  }
}

function sseData(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DOMException('Upstream stream idle timeout.', 'TimeoutError')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function streamError(code: string, message: string): JsonObject {
  return { error: { message, type: 'server_error', code, param: null } };
}

interface SanitizerState {
  sanitizer: CrossChunkIdentitySanitizer;
  choiceIndex: number;
  field: 'content' | 'reasoning_content' | 'refusal';
}

interface StreamToolCallState {
  name: string;
  arguments: string;
}

function transformChunk(
  chunk: JsonObject,
  userModel: string,
  identity: string,
  sanitizers: Map<string, SanitizerState>,
): JsonObject {
  const choices = Array.isArray(chunk.choices)
    ? chunk.choices.map((choice, position) => {
      if (!isObject(choice)) return choice;
      const upstreamDelta = isObject(choice.delta) ? choice.delta : {};
      const delta: JsonObject = {
        ...(upstreamDelta.role !== undefined ? { role: upstreamDelta.role } : {}),
        ...(upstreamDelta.content !== undefined ? { content: upstreamDelta.content } : {}),
        ...(upstreamDelta.reasoning_content !== undefined
          ? { reasoning_content: upstreamDelta.reasoning_content }
          : {}),
        ...(upstreamDelta.refusal !== undefined ? { refusal: upstreamDelta.refusal } : {}),
        ...(upstreamDelta.tool_calls !== undefined ? { tool_calls: upstreamDelta.tool_calls } : {}),
        ...(upstreamDelta.function_call !== undefined ? { function_call: upstreamDelta.function_call } : {}),
      };
      return {
        index: typeof choice.index === 'number' ? choice.index : position,
        delta,
        ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {}),
        finish_reason: choice.finish_reason ?? null,
      };
    })
    : [];
  const normalized: JsonObject = {
    id: typeof chunk.id === 'string' ? chunk.id : `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000),
    model: userModel,
    choices,
    ...(isObject(chunk.usage) ? { usage: chunk.usage } : {}),
    system_fingerprint: null,
  };
  if (!Array.isArray(normalized.choices)) return normalized;

  for (const [position, rawChoice] of normalized.choices.entries()) {
    if (!isObject(rawChoice) || !isObject(rawChoice.delta)) continue;
    const index = typeof rawChoice.index === 'number' ? rawChoice.index : position;
    for (const field of ['content', 'reasoning_content', 'refusal'] as const) {
      const value = rawChoice.delta[field];
      if (typeof value !== 'string') continue;
      const key = `${index}:${field}`;
      let state = sanitizers.get(key);
      if (!state) {
        state = { sanitizer: new CrossChunkIdentitySanitizer(identity), choiceIndex: index, field };
        sanitizers.set(key, state);
      }
      rawChoice.delta[field] = state.sanitizer.push(value);
    }
  }
  return normalized;
}

function flushSanitizers(
  sanitizers: Map<string, SanitizerState>,
  template: JsonObject | undefined,
  userModel: string,
  choiceIndex?: number,
): JsonObject[] {
  const chunks: JsonObject[] = [];
  for (const [key, state] of sanitizers) {
    if (choiceIndex !== undefined && state.choiceIndex !== choiceIndex) continue;
    const remainder = state.sanitizer.flush();
    sanitizers.delete(key);
    if (!remainder) continue;
    chunks.push({
      id: stringField(template ?? {}, 'id') ?? `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion.chunk',
      created: typeof template?.created === 'number' ? template.created : Math.floor(Date.now() / 1000),
      model: userModel,
      choices: [{ index: state.choiceIndex, delta: { [state.field]: remainder }, finish_reason: null }],
    });
  }
  return chunks;
}

export function createValidatedSseStream(
  upstream: ReadableStream<Uint8Array>,
  userModel: string,
  identity: string,
  requestBody: JsonObject = {},
  idleTimeoutMs = 90_000,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const sanitizers = new Map<string, SanitizerState>();
  const toolCalls = new Map<string, StreamToolCallState>();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sawDone = false;
      const finishedChoices = new Set<number>();
      let sawLogprobs = false;
      let contentForJsonValidation = '';
      const expectedChoices = typeof requestBody.n === 'number' ? requestBody.n : 1;
      const requiredToolName = requestedToolName(requestBody);
      let lastChunk: JsonObject | undefined;
      const emit = (chunk: Uint8Array): boolean => {
        if (cancelled) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };

      const process = (events: SseEvent[]) => {
        for (const event of events) {
          if (event.data.trim() === '[DONE]') {
            sawDone = true;
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            throw new Error('Upstream emitted invalid SSE JSON.');
          }
          if (!isObject(parsed)) throw new Error('Upstream emitted an invalid SSE event.');
          const transformed = transformChunk(parsed, userModel, identity, sanitizers);
          lastChunk = transformed;
          const finishChunks: JsonObject[] = [];
          if (Array.isArray(transformed.choices)) {
            for (const choice of transformed.choices) {
              if (!isObject(choice)) continue;
              const finishReason = choice.finish_reason;
              if (finishReason !== null && finishReason !== undefined) {
                const index = typeof choice.index === 'number' ? choice.index : 0;
                finishedChoices.add(index);
                choice.finish_reason = null;
                finishChunks.push(...flushSanitizers(sanitizers, transformed, userModel, index));
                finishChunks.push({
                  ...transformed,
                  choices: [{ index, delta: {}, finish_reason: finishReason }],
                });
              }
              if (!isObject(choice.delta)) continue;
              if (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0) {
                for (const [toolPosition, toolCall] of choice.delta.tool_calls.entries()) {
                  if (!isObject(toolCall) || !isObject(toolCall.function)) continue;
                  const choiceIndex = typeof choice.index === 'number' ? choice.index : 0;
                  const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : toolPosition;
                  const key = `${choiceIndex}:${toolIndex}`;
                  const state = toolCalls.get(key) ?? { name: '', arguments: '' };
                  if (typeof toolCall.function.name === 'string') state.name += toolCall.function.name;
                  if (typeof toolCall.function.arguments === 'string') state.arguments += toolCall.function.arguments;
                  toolCalls.set(key, state);
                }
              }
              sawLogprobs ||= Array.isArray(choice.logprobs) || isObject(choice.logprobs);
              if (typeof choice.delta.content === 'string') contentForJsonValidation += choice.delta.content;
            }
          }
          emit(sseData(JSON.stringify(transformed)));
          for (const finishChunk of finishChunks) emit(sseData(JSON.stringify(finishChunk)));
        }
      };

      try {
        while (true) {
          if (cancelled) break;
          const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
          if (done) break;
          process(parser.push(decoder.decode(value, { stream: true })));
        }
        process(parser.push(decoder.decode()));
        process(parser.finish());
        for (const chunk of flushSanitizers(sanitizers, lastChunk, userModel)) {
          emit(sseData(JSON.stringify(chunk)));
        }
        const validToolCalls = [...toolCalls.values()].filter(toolCall => {
          if (!toolCall.name) return false;
          try {
            JSON.parse(toolCall.arguments);
            return true;
          } catch {
            return false;
          }
        });
        let invalidContract = !sawDone
          || finishedChoices.size < expectedChoices
          || (requiresToolCall(requestBody) && validToolCalls.length === 0)
          || (requiredToolName !== undefined && !validToolCalls.some(toolCall => toolCall.name === requiredToolName))
          || (requestBody.logprobs === true && !sawLogprobs);
        if (!invalidContract && requiresJson(requestBody)) {
          try {
            JSON.parse(contentForJsonValidation);
          } catch {
            invalidContract = true;
          }
        }
        if (invalidContract) {
          emit(sseData(JSON.stringify(streamError(
            'upstream_stream_incomplete',
            'The upstream stream ended before completion. Retry the request.',
          ))));
        }
      } catch (error) {
        if (!cancelled) {
          await reader.cancel(error).catch(() => undefined);
          for (const chunk of flushSanitizers(sanitizers, lastChunk, userModel)) {
            emit(sseData(JSON.stringify(chunk)));
          }
          emit(sseData(JSON.stringify(streamError(
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'upstream_stream_timeout'
              : 'upstream_stream_error',
            error instanceof DOMException && error.name === 'TimeoutError'
              ? 'The upstream stream stopped producing data. Retry the request.'
              : 'The upstream stream failed before completion. Retry the request.',
          ))));
        }
      } finally {
        if (!cancelled) {
          emit(sseData('[DONE]'));
          controller.close();
        }
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function collectSseData(stream: ReadableStream<Uint8Array>): Promise<Array<JsonObject | '[DONE]'>> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const result: Array<JsonObject | '[DONE]'> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      result.push(event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data) as JsonObject);
    }
  }
  for (const event of parser.finish()) {
    result.push(event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data) as JsonObject);
  }
  return result;
}

export async function prefetchValidSse(
  upstream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = 64 * 1024,
): Promise<ReadableStream<Uint8Array>> {
  const reader = upstream.getReader();
  const chunks: Uint8Array[] = [];
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let bytes = 0;

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes > maxBytes) break;
    const valid = parser.push(decoder.decode(value, { stream: true })).some(event => {
      if (event.data === '[DONE]') return false;
      try {
        const parsed: unknown = JSON.parse(event.data);
        return isObject(parsed)
          && Array.isArray(parsed.choices)
          && parsed.choices.some(choice => isObject(choice) && isObject(choice.delta));
      } catch {
        return false;
      }
    });
    if (valid) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            reader.releaseLock();
          } else controller.enqueue(next.value);
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => undefined);
        },
      });
    }
  }

  await reader.cancel().catch(() => undefined);
  if (signal.aborted) throw new DOMException('First SSE event timed out.', 'TimeoutError');
  throw new Error('Upstream did not emit a valid SSE event.');
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof SyntaxError) return invalidRequest('Request body contains invalid JSON.', 'invalid_json');
  return new ApiError('Internal server error.', 500, 'server_error', 'internal_error');
}
