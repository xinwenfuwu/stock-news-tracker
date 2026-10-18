/* ============================================================
 * test-register-cloud-fallback.mjs — 验证 20261018g 的「注册写入云端」兜底修复
 *
 * 根因（线上实测）：sichina.dpdns.org 的 DNS 停在 192.0.2.1 占位、未委派到 Cloudflare，
 * 其 Worker 路由永远不可达，导致注册写入云端静默失败 → 账号只落本机 →
 * 换设备/换入口登录报「用户名或密码不正确」、管理员在后端看不到。
 *
 * 修复：registerRemoteViaWorker 等写入通道改为「多地址兜底」——
 *   主：sichina.dpdns.org（国内可达，修复 DNS 后生效）
 *   兜底：stock-edge.hui-zhou.workers.dev（Worker 自身地址，始终可达）
 * 且 Auth.register 把云端写入结果带回 UI（cloudSync），不再静默吞错。
 *
 * 场景：
 *  1) sichina 死(502) + stock-edge 活 → 注册经兜底写云端成功 → 跨设备登录成功
 *  2) 两路都死 → 注册 cloudSync.ok=false（UI 告警），但本机登录仍成功（不丢账号）
 *  3) 主路活着(sichina 200) → 直接走主路写云端成功（不依赖兜底）
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

function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }

const ghFiles = new Map();
function resetCloud() {
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
}
resetCloud();
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function cloudAccount(name) { const r = regOf(); return r.accounts && r.accounts[name]; }

function mockAuthRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const now = Date.now();
  const status = body.status === 'pending' ? 'pending' : 'active';
  const reg = regOf(); reg.accounts = reg.accounts || {};
  reg.accounts[username] = {
    hash, role: 'user', status, disabled: false,
    trialUntil: Number(body.trialUntil) || 0, trialDays: Number(body.trialDays) || 0,
    quotaMonths: 0, disableDate: '', registerDate: '', payMembershipUntil: 0,
    paidAt: 0, paidPlan: '', paidAmount: 0, paidClaimIds: [], placeholder: false,
    createdAt: now, updatedAt: now
  };
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-' + Math.random().toString(36).slice(2, 8) });
  return { status: 200, body: { ok: true, created: true } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => { m.clear(); } };
}

// 控制两个写入通道的可用性
let SICHINA_UP = true;
let STOCKEDGE_UP = true;

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
            const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]);
            const f = ghFiles.get(p); if (!f) return { ok: false, status: 404, json: async () => ({}) };
            return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
          }
          if (m === 'PUT') {
            const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]);
            const body = JSON.parse(opt.body); ghFiles.set(p, { content: b64decode(body.content), sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
            return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
          }
        }
        if (/sichina\.dpdns\.org/.test(u)) {
          if (!SICHINA_UP) return { ok: false, status: 502, json: async () => ({}) };
          if (/auth\/register$/.test(u)) { const r = mockAuthRegister(JSON.parse(opt.body || '{}')); return { ok: r.status < 300, status: r.status, json: async () => r.body }; }
        }
        if (/stock-edge\.hui-zhou\.workers\.dev/.test(u)) {
          if (!STOCKEDGE_UP) return { ok: false, status: 502, json: async () => ({}) };
          if (/auth\/register$/.test(u)) { const r = mockAuthRegister(JSON.parse(opt.body || '{}')); return { ok: r.status < 300, status: r.status, json: async () => r.body }; }
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

console.log('=== 场景 1：sichina 死 + stock-edge 兜底活（线上当前真实情况） ===');
SICHINA_UP = false; STOCKEDGE_UP = true; resetCloud();
{
  const devA = makeStorage();
  const A = await loadAuth(devA);
  const reg = await A.Auth.register('carol', 'Carol@2026');
  check('注册返回 ok', reg.ok === true, reg);
  check('注册 cloudSync.ok=true（兜底通道写成功）', reg.cloudSync && reg.cloudSync.ok === true, reg.cloudSync);
  check('云端注册表经兜底写入 carol', !!cloudAccount('carol'), regOf().accounts);
  check('云端 carol hash 非空', cloudAccount('carol') && !!cloudAccount('carol').hash, cloudAccount('carol'));
  // 跨设备登录：仅云端有账号
  const devB = makeStorage();
  const B = await loadAuth(devB);
  const loginCross = await B.Auth.login('carol', 'Carol@2026');
  check('跨设备登录成功（兜底写入生效）', loginCross.ok === true, loginCross);
}

console.log('=== 场景 2：两路都死（极端断网） ===');
SICHINA_UP = false; STOCKEDGE_UP = false; resetCloud();
{
  const devA = makeStorage();
  const A = await loadAuth(devA);
  const reg = await A.Auth.register('dave', 'Dave@2026');
  check('注册仍返回 ok（本机创建成功）', reg.ok === true, reg);
  check('cloudSync.ok=false（UI 会告警，不再静默）', reg.cloudSync && reg.cloudSync.ok === false, reg.cloudSync);
  check('云端未写入（符合预期）', !cloudAccount('dave'), regOf().accounts);
  const localAfter = JSON.parse(devA.getItem('snt-auth-users-v1') || '[]');
  check('本机账号保留（不丢）', localAfter.some(u => u.username === 'dave'), localAfter.length);
  const same = await (await loadAuth(devA)).Auth.login('dave', 'Dave@2026');
  check('本机登录仍成功', same.ok === true, same);
}

console.log('=== 场景 3：主路 sichina 活（DNS 修复后） ===');
SICHINA_UP = true; STOCKEDGE_UP = true; resetCloud();
{
  const devA = makeStorage();
  const A = await loadAuth(devA);
  const reg = await A.Auth.register('erin', 'Erin@2026');
  check('注册 cloudSync.ok=true（主路生效）', reg.cloudSync && reg.cloudSync.ok === true, reg.cloudSync);
  check('云端写入 erin', !!cloudAccount('erin'), regOf().accounts);
  const devB = makeStorage();
  const loginCross = await (await loadAuth(devB)).Auth.login('erin', 'Erin@2026');
  check('跨设备登录成功', loginCross.ok === true, loginCross);
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
