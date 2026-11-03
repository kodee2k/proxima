# proxima

I wanted to use `gemini-4-argon` in my daily driver, but my client only speaks
OpenAI. So I built this tiny translation layer: an OpenAI-compatible proxy in
front of a Google Generative AI endpoint.

It exposes `/v1/chat/completions` (streaming and non-streaming) and `/v1/models`,
translating OpenAI requests to the Google Generative AI format using `@ai-sdk/google`.

Operating target (default, configurable via `GOOGLE_BASE_URL`/`MODEL_ID`): `https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon`

## Run

```bash
npm install
PASSTHROUGH_KEY=your_go_key npm start
```

The server listens on `http://0.0.0.0:8787` by default.

Use with any OpenAI-only client:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=$PASSTHROUGH_KEY
```

## Environment variables

- `PORT` (default `8787`)
- `HOST` (default `0.0.0.0`)
- `GOOGLE_BASE_URL` / `BASE_URL` (default `https://opencode.ai/inference/go/google/v1beta`)
- `MODEL_ID` (default `gemini-4-argon`)
- `PASSTHROUGH_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` (optional fallback API key)
- `LOG_DIR` (default `logs`) — JSONL request/response logs are written to `$LOG_DIR/proxima.jsonl`
- `OPENCODE_SESSION` (optional) — stable session id sent as `x-opencode-session` (auto-generated if unset)

The client's `Authorization: Bearer <token>` is also accepted and used as the Google key.

## Logging

Every request and response is appended as a JSON line to `logs/proxima.jsonl` for training.

## Credits

Built by [Leon Lehmann](https://empero.org) for [Empero](https://empero.org).
