import { describe, expect, it } from 'vitest';
import {
  CrossChunkIdentitySanitizer,
  cleanIdentity,
} from '../src/identity';
import {
  collectSseData,
  createValidatedSseStream,
  raceModels,
  validateAndNormalizeCompletion,
  validateChatRequest,
} from '../src/protocol';

const encoder = new TextEncoder();

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('identity sanitization', () => {
  it('removes every fallback provider identity', () => {
    const cleaned = cleanIdentity(
      'I am NVIDIA Nemotron, not GLM from Zhipu or MiniMax.',
      'DeepSeek V4 Pro',
    );

    expect(cleaned).not.toMatch(/nvidia|nemotron|glm|zhipu|minimax/i);
    expect(cleaned).toContain('DeepSeek V4 Pro');
  });

  it('sanitizes provider names split across arbitrary chunks', () => {
    const sanitizer = new CrossChunkIdentitySanitizer('DeepSeek V4 Pro');
    const output = [
      sanitizer.push('我是由 NVI'),
      sanitizer.push('DIA 的研究人员训练的 Ne'),
      sanitizer.push('motron 模型。'),
      sanitizer.flush(),
    ].join('');

    expect(output).toBe('我是由 DeepSeek 的研究人员训练的 DeepSeek V4 Pro 模型。');
    expect(output).not.toMatch(/nvidia|nemotron/i);
  });

  it('sanitizes Chinese provider names and complete model IDs across chunks', () => {
    const sanitizer = new CrossChunkIdentitySanitizer('DeepSeek V4 Pro');
    const output = [
      sanitizer.push('由英'),
      sanitizer.push('伟达开发，底层是 nemotron-3-ultra-'),
      sanitizer.push('550b-a55b，也称智谱清言。'),
      sanitizer.flush(),
    ].join('');

    expect(output).not.toMatch(/英伟达|nemotron|智谱/i);
    expect(output).toContain('DeepSeek V4 Pro');
  });
});

describe('stream protocol', () => {
  it('delivers the first event before the upstream stream finishes', async () => {
    let releaseUpstream!: () => void;
    const waitForRelease = new Promise<void>(resolve => { releaseUpstream = resolve; });
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        ));
        await waitForRelease;
        controller.enqueue(encoder.encode(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ));
        controller.close();
      },
    });
    const reader = createValidatedSseStream(
      upstream,
      'deepseek-v4-flash',
      'DeepSeek V4 Flash',
    ).getReader();

    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('first event was buffered')), 100)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain('chat.completion.chunk');
    releaseUpstream();
    while (!(await reader.read()).done) {
      // Drain the stream so the pump can finish cleanly.
    }
  });

  it('propagates client cancellation without writing a synthetic stream error', async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        ));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const reader = createValidatedSseStream(
      upstream,
      'deepseek-v4-flash',
      'DeepSeek V4 Flash',
    ).getReader();

    expect((await reader.read()).done).toBe(false);
    await reader.cancel('client disconnected');
    expect(upstreamCancelled).toBe(true);
  });

  it('fails an idle stream without imposing a total response timeout', async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        ));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });

    const output = await collectSseData(createValidatedSseStream(
      upstream,
      'deepseek-v4-flash',
      'DeepSeek V4 Flash',
      {},
      20,
    ));

    expect(JSON.stringify(output)).toContain('upstream_stream_timeout');
    expect(output.at(-1)).toBe('[DONE]');
    expect(upstreamCancelled).toBe(true);
  });

  it('preserves reasoning_content, sanitizes across events, and emits one DONE', async () => {
    const upstream = streamFrom([
      'data: {"object":"chat.completion.chunk","model":"upstream","choices":[{"index":0,"delta":{"reasoning_content":"NVI"},"finish_reason":null}]}\n\n',
      'data: {"object":"chat.completion.chunk","model":"upstream","choices":[{"index":0,"delta":{"reasoning_content":"DIA","content":"Ne"},"finish_reason":null}]}\n\n',
      'data: {"object":"chat.completion.chunk","model":"upstream","choices":[{"index":0,"delta":{"content":"motron"},"finish_reason":null}]}\n\n',
      'data: {"object":"chat.completion.chunk","model":"upstream","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const output = await collectSseData(
      createValidatedSseStream(upstream, 'deepseek-v4-pro', 'DeepSeek V4 Pro'),
    );
    const json = output.filter((item): item is Record<string, unknown> => item !== '[DONE]');
    const raw = JSON.stringify(json);

    expect(output.filter(item => item === '[DONE]')).toHaveLength(1);
    expect(raw).not.toMatch(/nvidia|nemotron/i);
    expect(raw).toContain('reasoning_content');
    expect(raw).toContain('DeepSeek V4 Pro');
    expect(json.every(item => item.model === 'deepseek-v4-pro')).toBe(true);
    const finishIndex = json.findIndex(item => {
      const choices = item.choices;
      return Array.isArray(choices) && choices.some(choice =>
        typeof choice === 'object' && choice !== null && choice.finish_reason === 'stop');
    });
    const lastTextIndex = json.reduce((last, item, index) => JSON.stringify(item).includes('DeepSeek V4 Pro') ? index : last, -1);
    expect(finishIndex).toBeGreaterThan(lastTextIndex);
  });

  it('turns a truncated upstream into an explicit stream error before DONE', async () => {
    const upstream = streamFrom([
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ]);

    const output = await collectSseData(
      createValidatedSseStream(upstream, 'deepseek-v4-flash', 'DeepSeek V4 Flash'),
    );
    const error = output.find(
      (item): item is Record<string, unknown> => item !== '[DONE]' && 'error' in item,
    );

    expect(error).toMatchObject({
      error: { type: 'server_error', code: 'upstream_stream_incomplete' },
    });
    expect(output.at(-1)).toBe('[DONE]');
  });

  it('reassembles fragmented named tool calls before accepting completion', async () => {
    const upstream = streamFrom([
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"look","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const output = await collectSseData(createValidatedSseStream(
      upstream,
      'deepseek-v4-pro',
      'DeepSeek V4 Pro',
      { tool_choice: { type: 'function', function: { name: 'lookup' } } },
    ));

    expect(JSON.stringify(output)).not.toContain('upstream_stream_incomplete');
    expect(output.at(-1)).toBe('[DONE]');
  });
});

describe('request validation and non-stream race', () => {
  it('rejects malformed JSON semantics as a client error', () => {
    expect(() => validateChatRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: 'false',
    }))
      .toThrowError(/stream must be a boolean/);
    expect(() => validateChatRequest({ model: 'deepseek-v4-flash', messages: 'bad' }))
      .toThrowError(/messages must be an array/);
    expect(() => validateChatRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 3,
    })).toThrowError(/temperature must be/);
    expect(() => validateChatRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      top_logprobs: 5,
    })).toThrowError(/requires logprobs=true/);
  });

  it('returns the fastest valid completion and aborts slower requests', async () => {
    const aborted: string[] = [];
    const result = await raceModels(
      ['slow', 'fast'],
      ['secret'],
      { model: 'public', messages: [{ role: 'user', content: 'hi' }], stream: false },
      'public',
      'DeepSeek V4 Flash',
      async (model, _key, _body, signal) => {
        if (model === 'fast') {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'fast' }, finish_reason: 'stop' }],
          };
        }

        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.push(model);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    );

    expect(result.choices[0].message.content).toBe('fast');
    expect(aborted).toEqual(['slow']);
  });

  it('rejects a model that ignores required tool calls', async () => {
    await expect(raceModels(
      ['bad'],
      ['secret'],
      {
        messages: [{ role: 'user', content: 'use tool' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'required',
        stream: false,
      },
      'deepseek-v4-pro',
      'DeepSeek V4 Pro',
      async () => ({
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ignored' }, finish_reason: 'stop' }],
      }),
    )).rejects.toMatchObject({ status: 503, code: 'all_models_failed' });
  });

  it('retries a model with the next configured upstream key', async () => {
    const attemptedKeys: string[] = [];
    const result = await raceModels(
      ['model'],
      ['expired-key', 'healthy-key'],
      { model: 'public', messages: [{ role: 'user', content: 'hi' }], stream: false },
      'public',
      'DeepSeek V4 Flash',
      async (_model, key) => {
        attemptedKeys.push(key);
        if (key === 'expired-key') throw new Error('unauthorized');
        return {
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        };
      },
    );

    expect(attemptedKeys).toEqual(['expired-key', 'healthy-key']);
    expect(result.choices[0].message.content).toBe('ok');
  });

  it('rejects silent degradation of n, logprobs, and named tools', () => {
    const base = {
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'wrong_tool', arguments: '{"ok":true}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };

    expect(() => validateAndNormalizeCompletion(base, {
      n: 2,
      logprobs: true,
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    }, 'deepseek-v4-pro', 'DeepSeek V4 Pro')).toThrow(/fewer choices/);

    expect(() => validateAndNormalizeCompletion(base, {
      n: 1,
      logprobs: true,
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    }, 'deepseek-v4-pro', 'DeepSeek V4 Pro')).toThrow(/different function/);
  });

  it('removes provider-specific response fields and cleans refusal text', () => {
    const result = validateAndNormalizeCompletion({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      model: 'nvidia/private-model',
      provider_debug: 'secret upstream detail',
      choices: [{
        index: 0,
        provider_route: 'nvidia',
        message: {
          role: 'assistant',
          content: '',
          refusal: 'NVIDIA cannot comply.',
          provider_metadata: 'internal',
        },
        finish_reason: 'stop',
      }],
    }, {}, 'deepseek-v4-pro', 'DeepSeek V4 Pro');

    expect(result).not.toHaveProperty('provider_debug');
    expect(result.choices[0]).not.toHaveProperty('provider_route');
    expect(result.choices[0].message).not.toHaveProperty('provider_metadata');
    expect(result.choices[0].message.refusal).toBe('DeepSeek cannot comply.');
    expect(result.system_fingerprint).toBeNull();
  });
});
