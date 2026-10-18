/* ============================================================
 * test-admin-delete.mjs — 验证「管理员点删除 → 本机与云端后端一并删除」（20261018f）
 *
 * 根因（用户反馈）：审核区每行有「删除」按钮，但无 GitHub 令牌的设备上，
 *   Auth.Sync.deleteUser 直接 skip（只删本机），云端 registry.json 里的账号还在，
 *   下次打开用户管理时 recoverFromRegistry 又把它合并回本机 →「删了又出现」。
 *
 * 本测试在 node vm 沙箱加载【真实】js/auth.js + js/auth-sync.js（不整体替换 Auth.Sync），
 * 只 mock fetch，从而真实覆盖：
 *   - Auth.Sync.deleteUser（有令牌 → Contents API 直写删除）
 *   - Auth.Sync.adminDeleteRemoteViaWorker（无令牌 → Worker /auth/admin-delete 服务端删除）
 *   - Auth._deleteAccountFromCloud（上面两条路径的编排与回落）
 *
 * 场景：
 *   1) 无令牌 + 未配密钥 → 本机删除成功，云端【仍保留】，sync.ok=false（UI 告警）
 *   2) 无令牌 + 正确密钥 → 云端账号真正被删（Worker 通道）
 *   3) 有令牌 → 云端账号真正被删（Contents API 直写）
 *   4) 无令牌 + 错误密钥 → 云端仍保留，sync.ok=false
 *   5) 幂等：云端本就没有该账号 → 视为成功（deleted=false）
 *   6) 删除后 regOf().accounts 不再含该账号（后端确实消失）
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

const REAL_RESET_KEY = '6255e0e3c9632fe6ec8072e51caa58f3bcfd13db341f057c';

function hashFor(pw) {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(pw, salt, 150000, 32, 'sha256');
  return 'pbkdf2$150000$' + salt.toString('base64') + '$' + dk.toString('base64');
}

/* ---------- mock GitHub 仓库（内存） ---------- */
const ghFiles = new Map();
function resetCloud() {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2),
    sha: 'sha-reg-0',
  });
}
resetCloud();
function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function cloudAccount(name) { const r = regOf(); return r.accounts && r.accounts[name]; }
function setCloudReg(reg) {
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-' + Math.random().toString(36).slice(2, 8) });
}

/* mock Worker /auth/admin-delete（与 worker.js authAdminDelete 同口径） */
function mockAdminDelete(body) {
  const username = String(body.username || '').trim();
  const key = String(body.resetKey || '');
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  if (key !== REAL_RESET_KEY) return { status: 403, body: { error: '删除密钥不正确' } };
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const had = !!reg.accounts[username];
  delete reg.accounts[username];
  reg.updatedAt = Date.now();
  setCloudReg(reg);
  return { status: 200, body: { ok: true, deleted: had } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => { m.clear(); } };
}

function seedUser(storage, username, { role = 'user' } = {}) {
  const users = JSON.parse(storage.getItem('snt-auth-users-v1') || '[]');
  const hash = hashFor('OldPass@2026');
  users.push({
    username, role, hash, pwSeal: '', disabled: false, status: 'active',
    createdAt: Date.now(), updatedAt: Date.now(), registerDate: '2026-10-01', quotaMonths: 0,
    payMembershipUntil: 0, paidAt: 0, paidPlan: '', paidAmount: 0, paidClaimIds: [], logins: []
  });
  storage.setItem('snt-auth-users-v1', JSON.stringify(users));
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  reg.accounts[username] = {
    hash, role, status: 'active', disabled: false, trialUntil: 0, trialDays: 0, quotaMonths: 0,
    disableDate: '', registerDate: '2026-10-01', payMembershipUntil: 0, paidAt: 0, paidPlan: '', paidAmount: 0,
    paidClaimIds: [], placeholder: false, createdAt: Date.now(), updatedAt: Date.now()
  };
  setCloudReg(reg);
}

async function loadAuth(storage, { withToken = false, resetKey = '' } = {}) {
  const sandbox = {
    localStorage: storage, sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      const m = (opt.method || 'GET').toUpperCase();
      // 同源静态注册表读取（readRegistry 用相对路径 + 时间戳）
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
        if (/auth\/admin-delete$/.test(u)) {
          const r = mockAdminDelete(JSON.parse(opt.body || '{}'));
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
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  if (resetKey) storage.setItem('snt-admin-reset-key', resetKey);
  return { ctx, sandbox, Auth: sandbox.Auth };
}

async function asAdmin(A) {
  await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
  A.Auth.user = { username: 'admin', role: 'admin' }; // 模拟管理员已登录
  return A;
}

const localHas = (store, name) => JSON.parse(store.getItem('snt-auth-users-v1') || '[]').some(x => x.username === name);

(async () => {
  // ========== 场景1：无令牌 + 未配密钥 → 只删本机，云端保留 ==========
  console.log('\n[场景1] 无令牌 + 未配密钥：本机删除成功，云端【仍保留】，sync.ok=false');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: false, resetKey: '' }));
    seedUser(store, 'cp130855');
    A.Auth.users = JSON.parse(store.getItem('snt-auth-users-v1'));
    const r = A.Auth.removeUser('cp130855');
    check('removeUser 本机删除成功', r && r.ok === true, r);
    check('本机已无 cp130855', !localHas(store, 'cp130855'));
    const sr = await r.sync;
    check('云端同步返回 ok=false', sr && sr.ok === false, sr);
    check('云端【仍保留】cp130855（验证失败根因）', !!cloudAccount('cp130855'), cloudAccount('cp130855'));
  }

  // ========== 场景2：无令牌 + 正确密钥 → 云端真正删除（Worker 通道） ==========
  console.log('\n[场景2] 无令牌 + ADMIN_RESET_KEY：云端账号被 Worker /auth/admin-delete 真正删除');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: false, resetKey: REAL_RESET_KEY }));
    seedUser(store, 'huyun2plus');
    A.Auth.users = JSON.parse(store.getItem('snt-auth-users-v1'));
    const r = A.Auth.removeUser('huyun2plus');
    check('removeUser 本机删除成功', r && r.ok === true, r);
    const sr = await r.sync;
    check('云端同步 ok=true（经 Worker 通道）', sr && sr.ok === true && sr.via === 'worker', sr);
    check('云端账号【已不存在】', !cloudAccount('huyun2plus'), cloudAccount('huyun2plus'));
  }

  // ========== 场景3：有令牌 → Contents API 直写删除 ==========
  console.log('\n[场景3] 有 GitHub 令牌：云端账号被 Contents API 直写删除');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: true, resetKey: '' }));
    seedUser(store, 'tokuser');
    A.Auth.users = JSON.parse(store.getItem('snt-auth-users-v1'));
    const r = A.Auth.removeUser('tokuser');
    const sr = await r.sync;
    check('云端同步 ok=true（令牌直写）', sr && sr.ok === true && sr.via === 'token', sr);
    check('云端账号【已不存在】', !cloudAccount('tokuser'), cloudAccount('tokuser'));
  }

  // ========== 场景4：无令牌 + 错误密钥 → 云端仍保留 ==========
  console.log('\n[场景4] 无令牌 + 错误密钥：云端删除被拒（403），云端【仍保留】');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: false, resetKey: 'WRONG-KEY' }));
    seedUser(store, 'wrongkey');
    A.Auth.users = JSON.parse(store.getItem('snt-auth-users-v1'));
    const r = A.Auth.removeUser('wrongkey');
    const sr = await r.sync;
    check('云端同步 ok=false', sr && sr.ok === false, sr);
    check('错误信息含「删除密钥不正确」', !!(sr && /删除密钥不正确/.test(sr.error || '')), sr);
    check('云端【仍保留】wrongkey', !!cloudAccount('wrongkey'), cloudAccount('wrongkey'));
  }

  // ========== 场景5：幂等 —— 云端本就没有该账号 → 视为成功 ==========
  console.log('\n[场景5] 幂等：账号只在本机、云端本来就没有 → 删除视为成功（deleted=false）');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: false, resetKey: REAL_RESET_KEY }));
    // 只在本地造账号，不写云端
    const users = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
    users.push({ username: 'localonly', role: 'user', hash: hashFor('X@2026'), pwSeal: '', disabled: false, status: 'active', createdAt: Date.now(), updatedAt: Date.now(), logins: [] });
    store.setItem('snt-auth-users-v1', JSON.stringify(users));
    A.Auth.users = users;
    check('前置：云端确无 localonly', !cloudAccount('localonly'));
    const r = A.Auth.removeUser('localonly');
    const sr = await r.sync;
    check('云端同步 ok=true（幂等）', sr && sr.ok === true, sr);
    check('deleted=false（云端本来就没有）', sr && sr.deleted === false, sr);
  }

  // ========== 场景6：删除后 registry 的 accounts 里确实不再含该账号 ==========
  console.log('\n[场景6] 后端校验：删除成功后 registry.accounts 的键集合不含该账号');
  {
    resetCloud();
    const store = makeStorage();
    const A = await asAdmin(await loadAuth(store, { withToken: false, resetKey: REAL_RESET_KEY }));
    seedUser(store, 'keepme');
    seedUser(store, 'deleteme');
    A.Auth.users = JSON.parse(store.getItem('snt-auth-users-v1'));
    const r = A.Auth.removeUser('deleteme');
    await r.sync;
    const keys = Object.keys(regOf().accounts || {});
    check('删后云端含 keepme', keys.indexOf('keepme') >= 0, keys);
    check('删后云端不含 deleteme', keys.indexOf('deleteme') < 0, keys);
  }

  console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
