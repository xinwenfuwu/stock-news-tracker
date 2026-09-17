/* ============================================================
 * worker/auth-worker.js — 股市信息分析系统 · 跨设备账号鉴权后端
 *
 * 为什么需要它：本站是纯静态 GitHub Pages，账号表只在各设备 localStorage，
 * 没有服务端就做不到「管理员通过 → 用户直接登录（无需转发准入码）」。
 * 这个 Worker 就是那块「跨设备共享账号表」的后端：
 *   · 用户注册 → 写进 KV（pending）
 *   · 管理员「用户管理」拉 /pending → 一键 /approve
 *   · 用户登录 → /login 由服务端校验密码 + 读取状态，通过后直接进
 *
 * 安全边界：
 *   · 密码只在 HTTPS 链路上以明文传给本 Worker，由服务端用 PBKDF2 校验，
 *     不落库明文；salt 与客户端一致（150k 迭代）。
 *   · 写状态（approve/reject/disable/pending 列表）需要 ADMIN_TOKEN（服务端 secret），
 *     不进前端 JS、不进仓库；普通用户只能 register / login / status。
 *   · 读 pending 需管理员密钥，避免任意访客枚举待审名单。
 *
 * 部署见同目录 wrangler.toml。本地 E2E 用 scripts/mock-auth-worker.mjs 模拟本接口。
 * ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    // CORS：优先用环境变量 ALLOW_ORIGIN（多个用逗号分隔，取第一个），否则反射请求来源
    const allowOrigin = (env.ALLOW_ORIGIN && env.ALLOW_ORIGIN.trim())
      ? env.ALLOW_ORIGIN.split(',')[0].trim()
      : (origin || '*');
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const respond = (body, status) => new Response(JSON.stringify(body), {
      status: status || 200,
      headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders)
    });
    try {
      const path = url.pathname;
      if (path === '/register' && request.method === 'POST') {
        return respond(await handleRegister(await readJson(request), env));
      }
      if (path === '/login' && request.method === 'POST') {
        return respond(await handleLogin(await readJson(request), env));
      }
      if (path === '/status' && request.method === 'GET') {
        return respond(await handleStatus(url.searchParams.get('u'), env));
      }
      if (path === '/pending' && request.method === 'GET') {
        const a = checkAdmin(request, env);
        if (!a.ok) return respond({ ok: false, error: a.error }, 401);
        return respond(await handlePending(env));
      }
      if (path === '/approve' && request.method === 'POST') {
        const a = checkAdmin(request, env);
        if (!a.ok) return respond({ ok: false, error: a.error }, 401);
        return respond(await handleApprove(await readJson(request), env));
      }
      if (path === '/reject' && request.method === 'POST') {
        const a = checkAdmin(request, env);
        if (!a.ok) return respond({ ok: false, error: a.error }, 401);
        return respond(await handleSetStatus(await readJson(request), 'rejected', env));
      }
      if (path === '/disable' && request.method === 'POST') {
        const a = checkAdmin(request, env);
        if (!a.ok) return respond({ ok: false, error: a.error }, 401);
        return respond(await handleSetStatus(await readJson(request), 'disabled', env));
      }
      return respond({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return respond({ ok: false, error: '服务器错误：' + (e && e.message ? e.message : e) }, 500);
    }
  }
};

/* ---------------- 存储适配 ---------------- */
const memStore = new Map(); // 仅 wrangler dev / 无 KV 绑定时兜底；生产必须绑 KV

function store(env) {
  if (env.SNT_ACCOUNTS) {
    return {
      get: (k) => env.SNT_ACCOUNTS.get(k).then(v => v ? JSON.parse(v) : null),
      put: (k, v) => env.SNT_ACCOUNTS.put(k, JSON.stringify(v))
    };
  }
  // 兜底内存实现
  return {
    get: (k) => Promise.resolve(memStore.has(k) ? memStore.get(k) : null),
    put: (k, v) => { memStore.set(k, v); return Promise.resolve(); }
  };
}

/* ---------------- 原语 ---------------- */
const ITER = 150000;
const SALT_BYTES = 16;

async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
function bufToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
async function pbkdf2(password, salt, iter) {
  const enc = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
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
  let salt;
  try { salt = b64ToBuf(parts[2]); } catch (e) { return false; }
  const dk = await pbkdf2(password, salt, iter);
  return bufToB64(dk) === parts[3];
}
function checkAdmin(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1].trim() : '';
  if (!env.ADMIN_TOKEN) return { ok: false, error: '服务端未配置管理员密钥' };
  if (!token) return { ok: false, error: '缺少管理员密钥' };
  return constantTimeEq(token, env.ADMIN_TOKEN) ? { ok: true } : { ok: false, error: '管理员密钥错误' };
}
function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}
function validateUsername(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return { ok: false, error: '请输入用户名' };
  if (s.length < 2 || s.length > 20) return { ok: false, error: '用户名长度需为 2-20 个字符' };
  if (!/^[A-Za-z0-9_一-龥.-]+$/.test(s)) return { ok: false, error: '用户名只能包含中文、字母、数字、下划线、点或短横线' };
  return { ok: true, value: s };
}
function validatePassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (!s) return { ok: false, error: '请输入密码' };
  if (s.length < 8 || s.length > 64) return { ok: false, error: '密码至少 8 位、不超过 64 位' };
  if (/\s/.test(s)) return { ok: false, error: '密码不能包含空格' };
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return { ok: false, error: '密码必须同时包含字母和数字' };
  return { ok: true, value: s };
}
function localDateStr(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
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

/* ---------------- 端点处理 ---------------- */
async function handleRegister(body, env) {
  const v = validateUsername(body.username);
  if (!v.ok) return { ok: false, error: v.error };
  const vp = validatePassword(body.password);
  if (!vp.ok) return { ok: false, error: vp.error };
  const key = 'acct:' + v.value.toLowerCase();
  const s = store(env);
  const exist = await s.get(key);
  if (exist && exist.status && exist.status !== 'pending') {
    return { ok: false, error: '该用户名已被使用' };
  }
  if (exist && exist.status === 'pending') {
    // 幂等：同一设备重复提交（hash 因随机盐必然不同）直接返回 ok，不覆盖原哈希
    return { ok: true, alreadySubmitted: true };
  }
  const hash = await makeHash(vp.value);
  const rec = { username: v.value, hash, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
  await s.put(key, rec);
  return { ok: true };
}

async function handleLogin(body, env) {
  const name = String(body.username == null ? '' : body.username).trim();
  const password = body.password || '';
  const key = 'acct:' + name.toLowerCase();
  const s = store(env);
  const u = await s.get(key);
  if (!u) return { ok: false, error: '用户名或密码不正确' };
  if (u.status === 'pending') return { ok: false, status: 'pending', error: '该账号正在等待管理员审核，通过后即可直接登录' };
  if (u.status === 'disabled' || u.disabled) return { ok: false, status: 'disabled', error: '该账号已被停用，请联系管理员' };
  const ok = await verifyHash(password, u.hash);
  if (!ok) return { ok: false, error: '用户名或密码不正确' };
  return { ok: true, grant: Object.assign({ status: 'active' }, grantFields(u)) };
}

async function handleStatus(name, env) {
  if (!name) return { status: 'none' };
  const key = 'acct:' + String(name).trim().toLowerCase();
  const u = await store(env).get(key);
  if (!u) return { status: 'none' };
  return Object.assign({ status: u.status === 'disabled' || u.disabled ? 'disabled' : u.status }, grantFields(u));
}

async function handlePending(env) {
  const items = [];
  if (env.SNT_ACCOUNTS) {
    const { keys } = await env.SNT_ACCOUNTS.list();
    for (const k of keys) {
      const rec = await env.SNT_ACCOUNTS.get(k.name).then(v => v ? JSON.parse(v) : null);
      if (rec && rec.status === 'pending') items.push({ username: rec.username, createdAt: rec.createdAt || 0 });
    }
  } else {
    for (const [, rec] of memStore) {
      if (rec.status === 'pending') items.push({ username: rec.username, createdAt: rec.createdAt || 0 });
    }
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  return { ok: true, list: items };
}

async function handleApprove(body, env) {
  const name = String(body.username == null ? '' : body.username).trim();
  if (!name) return { ok: false, error: '缺少用户名' };
  const key = 'acct:' + name.toLowerCase();
  const s = store(env);
  const u = await s.get(key);
  if (!u) return { ok: false, error: '用户不存在' };
  const now = Date.now();
  u.status = 'active';
  u.reviewedAt = now;
  const td = Number(body.trialDays) || 0;
  if (td > 0) { u.trialUntil = now + td * 86400000; u.trialDays = td; u.trialGrantedAt = now; }
  else { u.trialUntil = 0; u.trialDays = 0; }
  if (body.registerDate) u.registerDate = String(body.registerDate);
  else if (!u.registerDate) u.registerDate = localDateStr(now);
  if (body.quotaMonths) u.quotaMonths = Number(body.quotaMonths);
  if (body.disableDate) u.disableDate = String(body.disableDate);
  u.updatedAt = now;
  await s.put(key, u);
  return { ok: true };
}

async function handleSetStatus(body, status, env) {
  const name = String(body.username == null ? '' : body.username).trim();
  if (!name) return { ok: false, error: '缺少用户名' };
  const key = 'acct:' + name.toLowerCase();
  const s = store(env);
  const u = await s.get(key);
  if (!u) return { ok: false, error: '用户不存在' };
  if (status === 'disabled') { u.disabled = true; u.status = u.status === 'pending' ? 'pending' : 'active'; }
  else u.status = status;
  u.updatedAt = Date.now();
  await s.put(key, u);
  return { ok: true };
}
