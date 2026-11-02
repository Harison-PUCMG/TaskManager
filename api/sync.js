// Sincronização do TaskFlow na Vercel (plano Hobby).
//
// Armazenamento: Redis do Marketplace da Vercel (Upstash), acessado pela API REST
// — sem dependências. O plano gratuito cobre com folga o uso de um app pessoal
// (um documento pequeno por chave; leituras só com a aba visível, a cada 60 s).
// Variáveis lidas: KV_REST_API_URL/KV_REST_API_TOKEN ou UPSTASH_REDIS_REST_URL/_TOKEN,
// que a integração cria sozinha ao conectar o banco ao projeto.
//
// Autenticação: o cliente envia a chave de sincronização em X-Sync-Key. Os dados
// ficam sob o SHA-256 da chave, então a chave em si nunca é gravada. Ela é gerada
// no navegador com 192 bits de entropia, por isso não há senha de servidor.
//
// Contrato (formato igual ao do Gist, para o cliente reaproveitar o parsing):
//   GET  /api/sync -> 200 { files: { 'taskflow.json': { content }, ... } }  (ETag; 304 com If-None-Match)
//                     sem dados ainda: 200 { files: {} }
//   PUT  /api/sync   body { files } -> 200 { ok: true }  (ETag novo)
const crypto = require('crypto');

const MAX_BODY = 900 * 1024; // abaixo do limite de 1 MB por requisição do Upstash gratuito
const MIN_KEY = 24;
const ALLOWED_FILES = ['taskflow.json', 'taskflow.deleted.json'];

// A integração pode criar as variáveis com prefixo próprio (ex.: STORAGE_KV_REST_API_URL),
// então aceitamos qualquer nome terminando em REST_API_URL/REDIS_REST_URL e o token equivalente.
function findEnv(suffixes, exclude) {
  const name = Object.keys(process.env).find(k =>
    suffixes.some(s => k.endsWith(s)) && !(exclude && k.includes(exclude)) && process.env[k]);
  return name ? process.env[name] : undefined;
}
const REDIS_URL = findEnv(['REST_API_URL', 'REDIS_REST_URL']);
const REDIS_TOKEN = findEnv(['REST_API_TOKEN', 'REDIS_REST_TOKEN'], 'READ_ONLY');

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error || 'Redis HTTP ' + r.status);
  return body.result;
}

function send(res, status, payload) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(payload);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    const faltando = [!REDIS_URL && 'URL', !REDIS_TOKEN && 'TOKEN'].filter(Boolean).join(' e ');
    return send(res, 503, { error: `Armazenamento não configurado (falta ${faltando} do Redis). Conecte o Upstash Redis ao projeto, marque o ambiente em uso (Production) e faça um novo deploy.` });
  }
  const key = String(req.headers['x-sync-key'] || '');
  if (key.length < MIN_KEY || key.length > 256) return send(res, 401, { error: 'Chave de sincronização inválida.' });
  const redisKey = 'taskflow:sync:' + crypto.createHash('sha256').update(key).digest('hex');

  try {
    if (req.method === 'GET') {
      const raw = await redis(['GET', redisKey]);
      const doc = raw ? JSON.parse(raw) : { files: {}, rev: '0' };
      const etag = '"' + doc.rev + '"';
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).setHeader('Cache-Control', 'no-store').end();
      return send(res, 200, { files: doc.files });
    }

    if (req.method === 'PUT') {
      const body = readBody(req);
      if (!body || typeof body.files !== 'object' || body.files === null) return send(res, 400, { error: 'Corpo inválido.' });
      const files = {};
      for (const name of ALLOWED_FILES) {
        const f = body.files[name];
        if (f === undefined) continue;
        if (!f || typeof f.content !== 'string') return send(res, 400, { error: 'Arquivo inválido: ' + name });
        files[name] = { content: f.content };
      }
      if (!files['taskflow.json']) return send(res, 400, { error: 'taskflow.json é obrigatório.' });
      const rev = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const payload = JSON.stringify({ files, rev });
      if (Buffer.byteLength(payload) > MAX_BODY) return send(res, 413, { error: 'Dados grandes demais para a nuvem gratuita.' });
      await redis(['SET', redisKey, payload]);
      res.setHeader('ETag', '"' + rev + '"');
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, PUT');
    return send(res, 405, { error: 'Método não permitido.' });
  } catch (err) {
    console.error('sync error:', err.message);
    return send(res, 502, { error: 'Falha ao acessar o armazenamento.' });
  }
};
