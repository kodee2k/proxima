import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, generateText, tool, jsonSchema } from 'ai';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.GOOGLE_BASE_URL || process.env.BASE_URL || 'https://opencode.ai/inference/go/google/v1beta').replace(/\/$/, '');
const MODEL_ID = process.env.MODEL_ID || 'gemini-4-argon';
const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_FILE = path.join(LOG_DIR, 'proxima.jsonl');

fs.mkdirSync(LOG_DIR, { recursive: true });

function logEvent(event) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');
  } catch (e) {
    console.error('log write failed', e);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-opencode-session',
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function extractKey(req, body) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return process.env.PASSTHROUGH_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || '').join('');
  return content == null ? '' : String(content);
}

function convertUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part) };
    if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
    if (part.type === 'image_url') {
      const url = part.image_url && part.image_url.url;
      return { type: 'image', image: url };
    }
    if (part.type === 'image') return { type: 'image', image: part.image || part.url };
    return { type: 'text', text: JSON.stringify(part) };
  });
}

function toModelMessages(msgs) {
  const out = [];
  const toolNameById = new Map();
  for (const m of msgs || []) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.id && tc.function && tc.function.name) toolNameById.set(tc.id, tc.function.name);
      }
    }
  }
  for (const m of msgs || []) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: contentToText(m.content) });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: convertUserContent(m.content) });
    } else if (m.role === 'assistant') {
      const content = [];
      if (typeof m.content === 'string') {
        if (m.content) content.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p && p.type === 'text') content.push({ type: 'text', text: p.text ?? '' });
          else if (p) content.push(p);
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { args = tc.function && tc.function.arguments; }
          content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: args });
        }
      }
      out.push({ role: 'assistant', content: content.length ? content : (m.content ?? '') });
    } else if (m.role === 'tool') {
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const resolvedName = (m.name && m.name !== 'tool') ? m.name : (toolNameById.get(m.tool_call_id) || m.name || 'tool');
      out.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName: resolvedName, output: { type: 'text', value: txt } }],
      });
    }
  }
  return out;
}

function sanitizeSchema(schema) {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'title' || k === 'additionalProperties') continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

function convertTools(openaiTools) {
  if (!Array.isArray(openaiTools)) return undefined;
  const tools = {};
  for (const t of openaiTools) {
    if (!t || t.type !== 'function') continue;
    const f = t.function || {};
    if (!f.name) continue;
    tools[f.name] = tool({
      description: f.description,
      parameters: jsonSchema(sanitizeSchema(f.parameters || { type: 'object', properties: {} })),
    });
  }
  return Object.keys(tools).length ? tools : undefined;
}

function convertToolChoice(tc) {
  if (tc == null) return undefined;
  if (tc === 'none') return 'none';
  if (tc === 'auto') return 'auto';
  if (tc === 'required') return 'required';
  if (typeof tc === 'object' && tc.function && tc.function.name) return { type: 'tool', toolName: tc.function.name };
  return undefined;
}

function convertResponseFormat(rf) {
  if (!rf) return undefined;
  if (rf.type === 'text') return { type: 'text' };
  if (rf.type === 'json_object') return { type: 'json' };
  if (rf.type === 'json_schema') {
    const js = rf.json_schema || {};
    return { type: 'json', schema: js.schema, name: js.name, description: js.description };
  }
  return undefined;
}

function mapFinishReason(r) {
  if (r === 'tool-calls') return 'tool_calls';
  if (r === 'content-filter') return 'content_filter';
  if (r === 'length') return 'length';
  if (r === 'stop') return 'stop';
  if (r === 'error' || r === 'other') return 'stop';
  return r || 'stop';
}

function mapUsage(u) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
    total_tokens: u.totalTokens ?? ((u.inputTokens || 0) + (u.outputTokens || 0)),
    prompt_tokens_details: { cached_tokens: u.inputTokenDetails && u.inputTokenDetails.cacheReadTokens ? u.inputTokenDetails.cacheReadTokens : 0 },
    completion_tokens_details: { reasoning_tokens: u.outputTokenDetails && u.outputTokenDetails.reasoningTokens ? u.outputTokenDetails.reasoningTokens : 0 },
  };
}

function makeId() {
  return 'chatcmpl-' + (globalThis.crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
}

async function handleChatCompletions(req, res) {
  const started = Date.now();
  const reqId = (globalThis.crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  let body;
  try { body = await readJson(req); }
  catch (e) { sendJson(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }); return; }

  logEvent({ ts: new Date().toISOString(), type: 'request', id: reqId, method: req.method, path: '/v1/chat/completions', body });

  const apiKey = extractKey(req, body);
  const sessionId = req.headers['x-opencode-session'] || process.env.OPENCODE_SESSION || (globalThis.crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  res.setHeader('x-opencode-session', sessionId);
  if (!apiKey) {
    const err = { error: { message: 'Missing API key. Set PASSTHROUGH_KEY/GOOGLE_GENERATIVE_AI_API_KEY or pass Bearer token.', type: 'authentication_error' } };
    logEvent({ ts: new Date().toISOString(), type: 'response', id: reqId, status: 401, error: err });
    sendJson(res, 401, err);
    return;
  }

  const provider = createGoogleGenerativeAI({
    baseURL: BASE_URL,
    apiKey,
    headers: { Authorization: `Bearer ${apiKey}`, 'x-opencode-session': sessionId },
  });
  const model = provider.chat(MODEL_ID);

  const systemMessages = (body.messages || []).filter((m) => m && m.role === 'system');
  const systemText = systemMessages.map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  const messages = toModelMessages((body.messages || []).filter((m) => !m || m.role !== 'system'));
  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  const responseFormat = convertResponseFormat(body.response_format);

  const stopSequences = Array.isArray(body.stop) ? body.stop : (body.stop ? [body.stop] : undefined);

  const common = {
    model,
    messages,
    system: systemText || undefined,
    tools,
    toolChoice,
    temperature: body.temperature,
    topP: body.top_p,
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
    stopSequences,
    presencePenalty: body.presence_penalty,
    frequencyPenalty: body.frequency_penalty,
    seed: body.seed,
    responseFormat,
  };

  const stream = !!body.stream;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
  const completionId = makeId();
  const created = Math.floor(Date.now() / 1000);
  const echoModel = body.model || MODEL_ID;

  if (!stream) {
    try {
      const result = await generateText(common);
      const text = result.text || '';
      const toolCalls = (result.toolCalls || []).map((tc) => ({
        id: tc.toolCallId,
        type: 'function',
        function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
      }));
      const finishReason = mapFinishReason(result.finishReason);
      const usage = mapUsage(result.usage);
      const message = {
        role: 'assistant',
        content: text ? text : (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      const resp = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: echoModel,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      };
      logEvent({ ts: new Date().toISOString(), type: 'response', id: reqId, status: 200, stream: false, request: body, response: resp, duration_ms: Date.now() - started });
      sendJson(res, 200, resp);
    } catch (e) {
      console.error('generate error', e);
      const err = { error: { message: String(e && e.message ? e.message : e), type: 'server_error' } };
      logEvent({ ts: new Date().toISOString(), type: 'response', id: reqId, status: 500, stream: false, error: err, duration_ms: Date.now() - started });
      sendJson(res, 500, err);
    }
    return;
  }

  // streaming
  res.setHeader('x-opencode-session', sessionId);
  res.setHeader('X-Accel-Buffering', 'no');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...corsHeaders(),
  });
  res.flushHeaders();

  const sendChunk = (chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const makeChunk = (delta, finishReason, usage) => {
    const c = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: echoModel,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) c.usage = usage;
    return c;
  };

  let textContent = '';
  const toolCalls = [];
  const toolIndexById = new Map();
  let toolCounter = 0;
  let finished = false;
  let finishReason = 'stop';
  let usage;

  try {
    const result = streamText(common);
    // initial role chunk
    sendChunk(makeChunk({ role: 'assistant' }, null));

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          const t = part.text;
          if (!t) break;
          textContent += t;
          sendChunk(makeChunk({ content: t }, null));
          break;
        }
        case 'tool-input-start': {
          const idx = toolCounter++;
          toolIndexById.set(part.id, idx);
          toolCalls[idx] = { id: part.id, type: 'function', function: { name: part.toolName, arguments: '' } };
          sendChunk(makeChunk({ tool_calls: [{ index: idx, id: part.id, type: 'function', function: { name: part.toolName, arguments: '' } }] }, null));
          break;
        }
        case 'tool-input-delta': {
          const idx = toolIndexById.get(part.id);
          if (idx === undefined) break;
          const d = part.delta;
          if (!d) break;
          toolCalls[idx].function.arguments += d;
          sendChunk(makeChunk({ tool_calls: [{ index: idx, function: { arguments: d } }] }, null));
          break;
        }
        case 'tool-call': {
          const idx = toolIndexById.has(part.id) ? toolIndexById.get(part.id) : toolCounter++;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: part.id, type: 'function', function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) } };
            toolIndexById.set(part.id, idx);
          } else if (!toolCalls[idx].function.arguments) {
            toolCalls[idx].function.arguments = JSON.stringify(part.input ?? {});
          }
          break;
        }
        case 'finish': {
          finished = true;
          finishReason = mapFinishReason(part.finishReason);
          usage = mapUsage(part.totalUsage);
          sendChunk(makeChunk({}, finishReason, includeUsage ? usage : undefined));
          break;
        }
        case 'error': {
          console.error('stream part error', part.error);
          break;
        }
        default:
          break;
      }
    }

    if (!finished) {
      sendChunk(makeChunk({}, finishReason, includeUsage ? usage : undefined));
    }

    const assembledToolCalls = toolCalls.filter(Boolean);
    logEvent({
      ts: new Date().toISOString(),
      type: 'response',
      id: reqId,
      status: 200,
      stream: true,
      request: body,
      response: {
        id: completionId,
        object: 'chat.completion',
        created,
        model: echoModel,
        choices: [{ index: 0, message: { role: 'assistant', content: textContent || null, ...(assembledToolCalls.length ? { tool_calls: assembledToolCalls } : {}) }, finish_reason: finishReason }],
        usage,
      },
      duration_ms: Date.now() - started,
    });
  } catch (e) {
    console.error('stream error', e);
    const err = { error: { message: String(e && e.message ? e.message : e), type: 'server_error' } };
    logEvent({ ts: new Date().toISOString(), type: 'response', id: reqId, status: 500, stream: true, error: err, duration_ms: Date.now() - started });
    try { res.write(`data: ${JSON.stringify(err)}\n\n`); } catch {}
  } finally {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function handleModels(res) {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created, owned_by: 'proxima' }],
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, { status: 'ok', model: MODEL_ID, base_url: BASE_URL });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      handleModels(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChatCompletions(req, res);
      return;
    }
    sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  } catch (e) {
    console.error('unhandled', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(e && e.message ? e.message : e), type: 'server_error' } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`proxima listening on http://${HOST}:${PORT}`);
  console.log(`base_url=${BASE_URL} model=${MODEL_ID}`);
  console.log(`logs=${LOG_FILE}`);
});
