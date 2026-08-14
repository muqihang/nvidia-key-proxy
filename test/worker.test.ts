import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { UsageCounter } from '../src/index';
import { maskSecret } from '../src/security';

describe('usage counter', () => {
  it('increments atomically under concurrency', async () => {
    const stub = env.USAGE_COUNTERS.getByName('concurrent-customer');
    await Promise.all(Array.from({ length: 25 }, () => stub.increment()));

    expect(await stub.getCount()).toBe(25);
    await runInDurableObject(stub, async (instance: UsageCounter) => {
      expect(instance).toBeInstanceOf(UsageCounter);
    });
  });

  it('preserves a legacy KV count as the migration baseline', async () => {
    const stub = env.USAGE_COUNTERS.getByName('legacy-customer');
    await stub.ensureAtLeast(40);
    await stub.increment();

    expect(await stub.getCount()).toBe(41);
  });
});

describe('secret redaction', () => {
  it('never returns a reusable credential', () => {
    const secret = 'nvapi-abcdefghijklmnopqrstuvwxyz123456';
    const masked = maskSecret(secret);

    expect(masked).not.toBe(secret);
    expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(masked).toMatch(/^nvapi-\*+/);
    expect(masked).toContain('3456');
  });
});

describe('HTTP error contract', () => {
  it('returns an OpenAI-shaped authentication error', async () => {
    const response = await SELF.fetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const body = await response.json<{ error: Record<string, unknown> }>();

    expect(response.status).toBe(401);
    expect(body.error).toMatchObject({
      type: 'authentication_error',
      code: 'missing_api_key',
      param: null,
    });
    expect(typeof body.error.message).toBe('string');
  });

  it('returns malformed JSON and unknown models as client errors', async () => {
    const customerKey = 'sk-test-customer';
    await env.KEY_MAPPINGS.put(customerKey, JSON.stringify({
      nvidia_keys: ['nvapi-test-upstream'],
      created_at: new Date().toISOString(),
    }));
    const headers = {
      Authorization: `Bearer ${customerKey}`,
      'Content-Type': 'application/json',
    };
    const malformed = await SELF.fetch('https://example.com/v1/chat/completions', {
      method: 'POST', headers, body: '{not json',
    });
    const unknown = await SELF.fetch('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'unknown', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_json' } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: 'model_not_found', param: 'model' } });
  });

  it('returns CORS headers on errors and preflight responses', async () => {
    const error = await SELF.fetch('https://example.com/not-found');
    const preflight = await SELF.fetch('https://example.com/v1/chat/completions', { method: 'OPTIONS' });

    expect(error.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Max-Age')).toBe('86400');
  });
});

describe('admin key exposure', () => {
  it('never returns a reusable upstream key from create or list', async () => {
    const upstreamKey = 'nvapi-super-secret-upstream-value';
    const created = await SELF.fetch('https://example.com/admin/keys', {
      method: 'POST',
      headers: { 'X-Admin-Token': 'test-admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ nvidia_keys: [upstreamKey], note: 'customer' }),
    });
    const createdBody = await created.json<Record<string, unknown>>();
    const listed = await SELF.fetch('https://example.com/admin/keys?limit=1', {
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    const listedBody = await listed.json<{ data: Array<Record<string, unknown>> }>();

    expect(created.status).toBe(201);
    expect(typeof createdBody.customer_key).toBe('string');
    expect(JSON.stringify(createdBody)).not.toContain(upstreamKey);
    expect(JSON.stringify(listedBody)).not.toContain(upstreamKey);
    expect(listedBody.data[0].customer_key).not.toBe(createdBody.customer_key);
    expect(listedBody.data[0].customer_key_fingerprint).toMatch(/^[a-f0-9]{24}$/);
  });
});
