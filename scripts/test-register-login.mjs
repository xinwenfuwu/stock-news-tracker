/* ============================================================
 * test-register-login.mjs — 复现并定位「注册成功 → 刷新后登录报密码不正确」
 *
 * 在 node vm 沙箱加载【真实】js/auth.js + js/auth-sync.js，mock fetch 覆盖：
 *   - 注册表读取（readRegistry，相对路径）
 *   - Worker /auth/register（镜像 worker.js authRegister 写入口径）
 *   - Worker /auth/admin-delete（无关，备用）
 *
 * 关键变量：writeWorkerUp（Worker 是否可达 → 注册时云端写入是否成功）
 *   场景 A（Worker 可用）：注册即写云端 → 同设备刷新登录、跨设备登录 都应成功
 *   场景 B（Worker 不可用）：注册只落本机 → 同设备刷新登录应成功（本机兜底），
 *                            跨设备登录应失败（报「用户名或密码不正确」）→ 复现用户故障
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

function hashFor(pw) {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(pw, salt, 150000, 32, 'sha256');
  return 'pbkdf2$150000$' + salt.toString('base64') + '$' + dk.toString('base64');
}

function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }

/* ---------- 内存云端注册表（模拟 GitHub 仓库） ---------- */
const ghFiles = new Map();
function resetCloud() {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2),
    sha: 'sha-reg-0',
  });
}
resetCloud();
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function cloudAccount(name) { const r = regOf(); return r.accounts && r.accounts[name]; }
function setCloudReg(reg) {
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-' + Math.random().toString(36).slice(2, 8) });
}

/* 模拟 Worker /auth/register（与 worker.js authRegister 同口径） */
function mockAuthRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const now = Date.now();
  let trialUntil = Number(body.trialUntil) || 0;
  const status = body.status === 'pending' ? 'pending' : 'active';
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  if (exist) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { error: '该用户名已被使用，请更换一个' } };
    }
  }
  reg.accounts[username] = {
    hash, role: 'user', status, disabled: false,
    trialUntil, trialDays: Number(body.trialDays) || (trialUntil ? 1 : 0),
    quotaMonths: Number(body.quotaMonths) || 0, disableDate: '',
    registerDate: typeof body.registerDate === 'string' ? body.registerDate : '',
    payMembershipUntil: Number(body.payMembershipUntil) || 0,
    paidAt: Number(body.paidAt) || 0, paidPlan: typeof body.paidPlan === 'string' ? body.paidPlan : '',
    paidAmount: Number(body.paidAmount) || 0, paidClaimIds: [], placeholder: false,
    createdAt: Number(body.createdAt) || now, updatedAt: now
  };
  reg.updatedAt = now;
  setCloudReg(reg);
  return { status: 200, body: { ok: true, created: true } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => { m.clear(); } };
}

/* 控制：Worker（写入通道）是否可达 */
let WRITE_WORKER_UP = true;

async function loadAuth(storage) {
  const sandbox = {
    localStorage: storage, sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      const m = (opt.method || 'GET').toUpperCase();
      if (/data\/accounts\/registry\.json/.test(u) && !/api\.github\.com/.test(u) && m === 'GET') {
        const f = ghFiles.get('data/accounts/registry.json');
        return { ok: true, status: 200, json: async () => JSON.parse(f.content) };
      }
      if (/^https?:/.test(u)) {
        if (u.includes('api.github.com')) {
          if (m === 'GET') {
            const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
            const p = decodeURIComponent(mm[1]);
            const f = ghFiles.get(p);
            if (!f) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
          }
          if (m === 'PUT') {
            const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
            const p = decodeURIComponent(mm[1]);
            const body = JSON.parse(opt.body);
            ghFiles.set(p, { content: b64decode(body.content), sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
            return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
          }
        }
        if (/auth\/register$/.test(u)) {
          if (!WRITE_WORKER_UP) return { ok: false, status: 502, json: async () => ({ error: 'Worker 不可用' }) };
          const r = mockAuthRegister(JSON.parse(opt.body || '{}'));
          return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
        }
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: (await import('node:crypto')).webcrypto,
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, sandbox, Auth: sandbox.Auth };
}

console.log('=== 场景 A：Worker 可用（注册即写云端） ===');
WRITE_WORKER_UP = true;
resetCloud();
{
  const devA = makeStorage();
  const A = await loadAuth(devA);
  const reg = await A.Auth.register('alice', 'Alice@2026');
  check('注册返回 ok', reg.ok === true, reg);
  check('注册即 1 天试用(autoTrial)', reg.autoTrial === true, reg);
  const localAfterReg = JSON.parse(devA.getItem('snt-auth-users-v1') || '[]');
  check('本机账号已落 localStorage', localAfterReg.some(u => u.username === 'alice'), localAfterReg.length);
  check('云端注册表已写入 alice', !!cloudAccount('alice'), regOf().accounts);
  check('云端 alice 状态=active', cloudAccount('alice') && cloudAccount('alice').status === 'active', cloudAccount('alice'));
  check('云端 alice hash 非空', cloudAccount('alice') && !!cloudAccount('alice').hash, cloudAccount('alice'));

  // 模拟刷新：用同一份 localStorage 新建 Auth 实例
  const A2 = await loadAuth(devA);
  const loginSame = await A2.Auth.login('alice', 'Alice@2026');
  check('同设备刷新后登录成功', loginSame.ok === true, loginSame);

  // 模拟跨设备：全新 localStorage，仅云端有账号
  const devB = makeStorage();
  const B = await loadAuth(devB);
  const loginCross = await B.Auth.login('alice', 'Alice@2026');
  check('跨设备(仅云端)登录成功', loginCross.ok === true, loginCross);
}

console.log('=== 场景 B：Worker 不可用（注册只落本机，云端没写入） ===');
WRITE_WORKER_UP = false;
resetCloud();
{
  const devA = makeStorage();
  const A = await loadAuth(devA);
  const reg = await A.Auth.register('bob', 'Bob@2026');
  check('注册返回 ok（前端不感知云端失败）', reg.ok === true, reg);
  const localAfterReg = JSON.parse(devA.getItem('snt-auth-users-v1') || '[]');
  check('本机账号已落 localStorage', localAfterReg.some(u => u.username === 'bob'), localAfterReg.length);
  check('云端注册表【未】写入 bob（根因：注册云端写入静默失败）', !cloudAccount('bob'), regOf().accounts);

  // 同设备刷新：本机兜底 → 应成功
  const A2 = await loadAuth(devA);
  const loginSame = await A2.Auth.login('bob', 'Bob@2026');
  check('同设备刷新后登录成功（本机兜底）', loginSame.ok === true, loginSame);

  // 跨设备：云端无、本机无 → 应失败「用户名或密码不正确」→ 复现用户故障
  const devB = makeStorage();
  const B = await loadAuth(devB);
  const loginCross = await B.Auth.login('bob', 'Bob@2026');
  check('跨设备登录失败（复现故障）', loginCross.ok === false, loginCross);
  check('失败文案=用户名或密码不正确', loginCross.ok === false && /用户名或密码不正确/.test(String(loginCross.error)), loginCross && loginCross.error);
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
