// One-off, read-only AI diagnostics. Never calls trading, bot, or order routes.
// Supply AURUM_DIAGNOSTIC_NVIDIA_KEY through a secret environment variable.
// The key is never written into reports, source files, URLs, or logs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { getAdminSettings } = require('../lib/firebase-admin');
const ROOT = path.resolve(__dirname, '..');
const APP = 'https://aurum-quant-ai.vercel.app';
const EDGE = 'https://aurum-quant-edge.aurum-quant-ai.workers.dev';
const NVIDIA = 'https://integrate.api.nvidia.com/v1';
const temporaryKey = String(process.env.AURUM_DIAGNOSTIC_NVIDIA_KEY || '').trim();
const results = [];
const redact = value => String(value || '').replace(/nvapi-[a-z0-9_-]+/gi, '[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 600);
function emit(value) {
  const safe = JSON.parse(redactJson(value));
  results.push(safe);
  console.log('[AURUM-AI-DIAG] ' + JSON.stringify(safe));
}
function redactJson(value) { return JSON.stringify(value).replace(/nvapi-[a-z0-9_-]+/gi, '[REDACTED]'); }
const visibleText = payload => {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.content;
  return typeof content === 'string' ? content.trim() : Array.isArray(content) ? content.map(x => x?.text || '').join('').trim() : '';
};
async function jsonRequest(url, options = {}, timeout = 20000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, ms: Date.now() - started, payload, cors: response.headers.get('access-control-allow-origin'), retryAfter: response.headers.get('retry-after') };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, payload: {}, error: redact(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message) };
  }
}
function modelEntries(settings) { return [...(Array.isArray(settings?.nvidiaModels) ? settings.nvidiaModels : []), ...(Array.isArray(settings?.debateModels) ? settings.debateModels : [])].filter(m => m && typeof m.id === 'string' && m.id.length < 180); }
function keyFor(settings) { return [settings?.globalNvidiaApiKey, ...(settings?.globalNvidiaApiKeys || []), ...modelEntries(settings).map(m => m.apiKey)].find(k => typeof k === 'string' && k.startsWith('nvapi-')) || ''; }
async function completion(id, key, budget = 256) {
  const payload = { model: id, temperature: 0, max_tokens: budget, stream: false, messages: [{ role: 'user', content: 'Reply with only the word OK. This is a connectivity test.' }] };
  if (budget > 256 && id.startsWith('openai/gpt-oss')) payload.reasoning_effort = 'low';
  const result = await jsonRequest(NVIDIA + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) }, 30000);
  const text = visibleText(result.payload);
  return { model: id, status: result.status, ms: result.ms, ok: result.status === 200 && Boolean(text), visibleChars: text.length, reasoningChars: String(result.payload?.choices?.[0]?.message?.reasoning_content || '').length, finishReason: result.payload?.choices?.[0]?.finish_reason || null, error: result.error || (result.status === 200 ? (text ? null : 'empty_visible_response') : redact(result.payload?.error?.message || result.payload?.message || `HTTP ${result.status}`)) };
}
async function backendProbe(name, url, body, timeout) {
  const result = await jsonRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: APP }, body: JSON.stringify(body) }, timeout);
  emit({ type: 'backend', name, status: result.status, ms: result.ms, cors: result.cors, visibleChars: visibleText(result.payload).length, fallbackUsed: Boolean(result.payload?.fallbackUsed || result.payload?.meta?.fallbackUsed), model: result.payload?.model || null, error: result.error || redact(result.payload?.message || result.payload?.fallbackReason || result.payload?.error?.message), debateAttempted: result.payload?.debateAttempted, debateSuccessful: result.payload?.debateSuccessful });
}
async function main() {
  if (!temporaryKey) throw new Error('Missing diagnostic key environment variable.');
  const local = JSON.parse(await fs.readFile(path.join(ROOT, 'data/settings.json'), 'utf8'));
  let timer;
  const stored = await Promise.race([getAdminSettings(), new Promise(resolve => { timer = setTimeout(() => resolve({}), 12000); })]);
  clearTimeout(timer);
  const edge = await jsonRequest(EDGE + '/settings');
  const edgeSettings = edge.payload?.settings || {};
  for (const [source, settings] of [['repository', local], ['vercel-settings', stored], ['worker-settings', edgeSettings]]) {
    emit({ type: 'inventory', source, defaultModelKey: settings.defaultModelKey || null, summaryCount: settings.nvidiaModels?.length || 0, debateCount: settings.debateModels?.length || 0, hasCredential: Boolean(keyFor(settings)), modelIds: [...new Set(modelEntries(settings).map(m => m.id))] });
  }
  const config = await jsonRequest(APP + '/api/chat');
  emit({ type: 'configuration', status: config.status, models: config.payload.models || [], configured: config.payload.configured });
  const preflight = await fetch(EDGE + '/ai-decision', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, signal: AbortSignal.timeout(10000) });
  emit({ type: 'cors', status: preflight.status, origin: preflight.headers.get('access-control-allow-origin'), methods: preflight.headers.get('access-control-allow-methods') });
  const prompt = 'Connectivity test only. No live market data is supplied. Return a short JSON analysis with direction Stay Flat, an explanation that market data is missing, and N/A for all prices. Do not execute or propose any order.';
  await Promise.all([
    backendProbe('production-chat', APP + '/api/chat', { messages: [{ role: 'user', content: 'Reply with OK.' }], settings: { style: 'concise', temperature: 0 } }, 75000),
    backendProbe('production-analysis', APP + '/api/ai-decision', { prompt, debateMode: 'fast', temperature: 0 }, 95000),
    backendProbe('worker-analysis', EDGE + '/ai-decision', { prompt, selectedModelKey: 'gpt-oss-default', model: 'openai/gpt-oss-120b', debateMode: 'fast', temperature: 0 }, 95000),
  ]);
  const catalog = await jsonRequest(NVIDIA + '/models', { headers: { Accept: 'application/json', Authorization: `Bearer ${temporaryKey}` } });
  const catalogIds = new Set((catalog.payload?.data || []).map(m => m.id));
  emit({ type: 'temporary-key-catalog', status: catalog.status, count: catalogIds.size, error: catalog.error || redact(catalog.payload?.error?.message || catalog.payload?.message) });
  if (catalog.status !== 200) return;
  const ids = [...new Set([...modelEntries(local), ...modelEntries(stored), ...modelEntries(edgeSettings), ...(config.payload.models || [])].map(m => m.id))];
  const preferred = ['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-20b', 'qwen/qwen3-next-80b-a3b-instruct'];
  for (const id of preferred) if (catalogIds.has(id) && !ids.includes(id)) ids.push(id);
  const modelResults = [];
  let next = 0;
  let nextStart = Date.now();
  async function runner() {
    while (next < ids.length) {
      const id = ids[next++];
      const start = nextStart; nextStart += 1600;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, start - Date.now())));
      let result = await completion(id, temporaryKey);
      if (result.status === 200 && !result.visibleChars) {
        const retry = await completion(id, temporaryKey, 2048);
        result = { ...retry, initialEmpty: true, initialMs: result.ms };
      }
      modelResults.push(result);
      emit({ type: 'model', ...result, listedInCatalog: catalogIds.has(id) });
    }
  }
  await Promise.all([runner(), runner(), runner()]);
  const working = modelResults.filter(r => r.ok).sort((a,b) => a.ms - b.ms);
  const credentialModel = preferred.find(id => working.some(r => r.model === id)) || working[0]?.model;
  if (credentialModel) {
    for (const [source, settings] of [['vercel-settings', stored], ['repository', local]]) {
      const key = keyFor(settings);
      if (key) emit({ type: 'stored-credential-check', source, ...await completion(credentialModel, key) });
    }
  }
  emit({ type: 'summary', configuredModelsChecked: ids.length, working: working.map(r => ({ model: r.model, ms: r.ms })), failed: modelResults.filter(r => !r.ok).map(r => ({ model: r.model, status: r.status, error: r.error })), temporaryKeyPersisted: false, tradesExecuted: false });
}
main().then(async () => {
  if (process.env.AURUM_DIAGNOSTIC_REPORT_PATH) await fs.writeFile(process.env.AURUM_DIAGNOSTIC_REPORT_PATH, JSON.stringify(results, null, 2));
  delete process.env.AURUM_DIAGNOSTIC_NVIDIA_KEY;
  await new Promise(resolve => process.stdout.write('[AURUM-AI-DIAG] complete\n', resolve));
  process.exit(0);
}).catch(error => { console.error('[AURUM-AI-DIAG] failed: ' + redact(error.message)); process.exit(1); });
