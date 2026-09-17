/* ============================================================
 * mock-auth-worker.mjs — 本地模拟鉴权后端（仅用于 E2E，不部署）
 *
 * 与 worker/auth-worker.js 完全一致的接口与字段，用内存 Map 当 KV，
 * 让 Playwright E2E 能在没有 Cloudflare 账户的情况下跑通「注册→管理员通过→用户免码登录」。
 * 启动后监听给定端口，导出 { close }。
 * ============================================================ */
import http from 'node:http';

const ITER = 150000;
const SALT_BYTES = 16;
const subtle = globalThis.crypto.subtle;

function bufToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
function b64ToBuf(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
async function pbkdf2(password, salt, iter) {
  const enc = new TextEncoder().encode(password);
  const key = await subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function makeHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const dk = await pbkdf2(password, salt, ITER);
  return 'pbkdf2$' + ITER + '$' + bufToB64(salt) + '$' + bufToB64(dk);
}
async function verifyHash(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  if (!iter || iter < 1) return false;
  const salt = b64ToBuf(parts[2]);
  const dk = await pbkdf2(password, salt, iter);
  return bufToB64(dk) === parts[3];
}
function localDateStr(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// use a fresh secret per run (E2E reads it via exported ADMIN_TOKEN)
const ADMIN_TOKEN = process.env.MOCK_ADMIN_TOKEN || 'test-admin-token';
const store = new Map();

const cors = (req) => ({
  'Access-Control-Allow-Origin': req.headers.origin || '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin'
});

function grantFields(u) {
  return {
    trialUntil: Number(u.trialUntil) || 0,
    trialDays: Number(u.trialDays) || 0,
    trialGrantedAt: Number(u.trialGrantedAt) || 0,
    registerDate: String(u.registerDate || ''),
    quotaMonths: Number(u.quotaMonths) || 0,
    disableDate: String(u.disableDate || '')
  };
}
function checkAdmin(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const t = m ? m[1].trim() : '';
  if (!t) return { ok: false, error: '缺少管理员密钥' };
  if (t !== ADMIN_TOKEN) return { ok: false, error: '管理员密钥错误' };
  return { ok: true };
}

export function createMockWorker() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = cors(req);
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    const send = (body, status = 200) => {
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers));
      res.end(JSON.stringify(body));
    };
    try {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (e) { body = {}; }
      }
      const key = (name) => 'acct:' + String(name || '').trim().toLowerCase();

      if (url.pathname === '/register' && req.method === 'POST') {
        const name = String(body.username || '').trim();
        const pw = body.password || '';
        if (name.length < 2 || name.length > 20) return send({ ok: false, error: '用户名不合法' }, 400);
        if (pw.length < 8) return send({ ok: false, error: '密码太短' }, 400);
        const k = key(name);
        const exist = store.get(k);
        if (exist && exist.status && exist.status !== 'pending') return send({ ok: false, error: '该用户名已被使用' }, 409);
        if (exist && exist.status === 'pending') return send({ ok: true, alreadySubmitted: true });
        const hash = await makeHash(pw);
        store.set(k, { username: name, hash, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() });
        return send({ ok: true });
      }

      if (url.pathname === '/login' && req.method === 'POST') {
        const name = String(body.username || '').trim();
        const u = store.get(key(name));
        if (!u) return send({ ok: false, error: '用户名或密码不正确' }, 401);
        if (u.status === 'pending') return send({ ok: false, status: 'pending', error: '等待审核' }, 200);
        if (u.status === 'disabled' || u.disabled) return send({ ok: false, status: 'disabled', error: '已停用' }, 200);
        const ok = await verifyHash(body.password || '', u.hash);
        if (!ok) return send({ ok: false, error: '用户名或密码不正确' }, 401);
        return send({ ok: true, grant: Object.assign({ status: 'active' }, grantFields(u)) });
      }

      if (url.pathname === '/status' && req.method === 'GET') {
        const u = store.get(key(url.searchParams.get('u')));
        if (!u) return send({ status: 'none' });
        return send(Object.assign({ status: (u.disabled || u.status === 'disabled') ? 'disabled' : u.status }, grantFields(u)));
      }

      if (url.pathname === '/pending' && req.method === 'GET') {
        const a = checkAdmin(req); if (!a.ok) return send({ ok: false, error: a.error }, 401);
        const list = [...store.values()].filter(r => r.status === 'pending')
          .map(r => ({ username: r.username, createdAt: r.createdAt || 0 }))
          .sort((x, y) => x.createdAt - y.createdAt);
        return send({ ok: true, list });
      }

      if (url.pathname === '/approve' && req.method === 'POST') {
        const a = checkAdmin(req); if (!a.ok) return send({ ok: false, error: a.error }, 401);
        const u = store.get(key(body.username)); if (!u) return send({ ok: false, error: '用户不存在' }, 404);
        const now = Date.now();
        u.status = 'active'; u.reviewedAt = now;
        const td = Number(body.trialDays) || 0;
        if (td > 0) { u.trialUntil = now + td * 86400000; u.trialDays = td; u.trialGrantedAt = now; }
        else { u.trialUntil = 0; u.trialDays = 0; }
        if (body.registerDate) u.registerDate = String(body.registerDate); else if (!u.registerDate) u.registerDate = localDateStr(now);
        if (body.quotaMonths) u.quotaMonths = Number(body.quotaMonths);
        if (body.disableDate) u.disableDate = String(body.disableDate);
        u.updatedAt = now; store.set(key(body.username), u);
        return send({ ok: true });
      }

      if ((url.pathname === '/reject' || url.pathname === '/disable') && req.method === 'POST') {
        const a = checkAdmin(req); if (!a.ok) return send({ ok: false, error: a.error }, 401);
        const u = store.get(key(body.username)); if (!u) return send({ ok: false, error: '用户不存在' }, 404);
        if (url.pathname === '/disable') { u.disabled = true; u.status = u.status === 'pending' ? 'pending' : 'active'; }
        else u.status = 'rejected';
        u.updatedAt = Date.now(); store.set(key(body.username), u);
        return send({ ok: true });
      }

      send({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      send({ ok: false, error: 'mock error: ' + (e && e.message ? e.message : e) }, 500);
    }
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, close: () => server.close() })));
}

export const MOCK_ADMIN_TOKEN = ADMIN_TOKEN;
