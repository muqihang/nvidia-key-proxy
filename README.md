# NVIDIA Key Proxy

Cloudflare Workers API gateway that exposes two OpenAI-compatible chat models and routes requests to NVIDIA-hosted fallback models.

## Public API

| Public model | Fallback order |
|---|---|
| `deepseek-v4-flash` | DeepSeek V4 Flash -> Nemotron 3 Ultra -> GLM 5.2 -> MiniMax M3 |
| `deepseek-v4-pro` | Nemotron 3 Ultra -> DeepSeek V4 Flash -> GLM 5.2 -> MiniMax M3 |

Endpoints:

- `POST /v1/chat/completions`
- `GET /v1/models`
- `POST /admin/keys`
- `GET /admin/keys?limit=50&cursor=...`

The chat endpoint supports streaming and non-streaming responses, preserves `reasoning_content`, validates requested tool calls and JSON output, and normalizes responses to the public model ID.

## Reliability behavior

- Non-stream requests run all fallback models concurrently, retry each model with the next configured NVIDIA key when needed, return the first response that satisfies the requested contract, and abort remaining attempts.
- Stream requests try each model and configured NVIDIA key in order until one emits a valid first SSE event. After the stream is committed, incomplete upstream output becomes an explicit SSE error followed by one `[DONE]` marker.
- Identity filtering maintains state across SSE chunks, so provider names cannot bypass filtering by being split across events.
- Request counts use one SQLite Durable Object per customer key. KV remains the read-heavy credential mapping store.
- API errors use the OpenAI-style `error.message`, `error.type`, `error.code`, and `error.param` shape.

## Setup

```bash
npm install
npx wrangler secret put ADMIN_TOKEN
npm run check
```

`wrangler.toml` contains the existing KV binding and the `UsageCounter` Durable Object migration. The first deployment containing that migration provisions the SQLite-backed counter namespace.

Deploy only after the complete check passes:

```bash
npm run deploy
```

## Create a customer key

```bash
curl -X POST https://YOUR_WORKER.workers.dev/admin/keys \
  -H "X-Admin-Token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nvidia_keys": ["nvapi-xxxxxx", "nvapi-yyyyyy"],
    "note": "Customer A"
  }'
```

The reusable customer key is returned only by this create response. NVIDIA keys are always masked in API responses. The list endpoint returns masked keys, a stable customer-key fingerprint, usage count, and a cursor when more results exist.

## Client example

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-xxxxxx",
    base_url="https://YOUR_WORKER.workers.dev/v1",
)

stream = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

## Development

```bash
npm run dev
npm test
npm run typecheck
npm run check
```

`npm run check` verifies generated Worker binding types, runs strict TypeScript checking, executes Worker-runtime tests, and performs a Wrangler deployment dry run.
