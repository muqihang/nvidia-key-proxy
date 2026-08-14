import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createValidatedSseStream, validateAndNormalizeCompletion } from '../src/protocol';

const encoder = new TextEncoder();

function upstreamStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('official OpenAI Node SDK compatibility', () => {
  it('parses normalized non-stream completions without losing reasoning_content', async () => {
    const completion = validateAndNormalizeCompletion({
      id: 'upstream-id',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          reasoning_content: 'NVIDIA reasoning',
          content: 'Nemotron answer',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }, {}, 'deepseek-v4-pro', 'DeepSeek V4 Pro');
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.test/v1',
      fetch: async () => new Response(JSON.stringify(completion), {
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    const result = await client.chat.completions.create({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const message = result.choices[0].message as typeof result.choices[0]['message'] & {
      reasoning_content?: string;
    };

    expect(result.model).toBe('deepseek-v4-pro');
    expect(message.reasoning_content).toBe('DeepSeek reasoning');
    expect(message.content).toBe('DeepSeek V4 Pro answer');
    expect(JSON.stringify(message)).not.toMatch(/nvidia|nemotron/i);
  });

  it('parses transformed SSE through DONE and preserves reasoning_content', async () => {
    const stream = createValidatedSseStream(upstreamStream([
      'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"NVI"},"finish_reason":null}]}\n\n',
      'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"DIA","content":"Nemotron answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'deepseek-v4-pro', 'DeepSeek V4 Pro');
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.test/v1',
      fetch: async () => new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      }),
    });

    const response = await client.chat.completions.create({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const chunk of response) chunks.push(chunk);
    const serialized = JSON.stringify(chunks);

    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop');
    expect(serialized).toContain('reasoning_content');
    expect(serialized).not.toMatch(/nvidia|nemotron/i);
    expect(serialized).toContain('DeepSeek V4 Pro');
  });

  it('turns the gateway error object into an SDK APIError', async () => {
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.test/v1',
      fetch: async () => new Response(JSON.stringify({
        error: {
          message: 'All upstream models are currently unavailable.',
          type: 'server_error',
          code: 'upstream_unavailable',
          param: null,
        },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    await expect(client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({
      status: 503,
      code: 'upstream_unavailable',
      type: 'server_error',
    });
  });

  it('throws an SDK APIError when an accepted stream ends incomplete', async () => {
    const stream = createValidatedSseStream(upstreamStream([
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ]), 'deepseek-v4-flash', 'DeepSeek V4 Flash');
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.test/v1',
      fetch: async () => new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      }),
    });
    const response = await client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });

    const consume = async () => {
      for await (const _chunk of response) {
        // Consume until the gateway emits its structured terminal error.
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: 'upstream_stream_incomplete',
      type: 'server_error',
    });
  });
});
