/* ============================================================
 * test-admin-reset-pw.mjs — 验证「管理员重置密码必须落到云端注册表」（20261018e）
 *
 * 根因（用户反馈）：管理员给用户「重置密码」后，对方设备登录报「账号或密码错误」。
 *   会员能开通（/auth/register 的「同哈希覆盖」分支允许），但密码改了（哈希不同）→ 该端点对
 *   已激活账号的【不同哈希】一律 409（防抢名），故密码永远写不进云端；且原 changePassword
 *   只用 _syncUserToRegistry（需 GitHub 令牌）且吞掉结果，无令牌时静默失败。
 *
 * 本测试在 node vm 沙箱加载真实 js/auth.js + js/auth-sync.js，mock Worker 端点：
 *   - /auth/register：同口径复刻 worker 的 409（不同哈希 + 已激活 → 拒绝）；
 *   - /auth/admin-reset：仅 ADMIN_RESET_KEY 匹配才允许改哈希（新增专用通道）。
 * 验证：① 无令牌 + 未配重置密钥 → 本地改了、云端失败、changePassword 返回 cloud.ok=false（UI 告警）；
 *       ② 无令牌 + 配了重置密钥 → 云端注册表拿到新哈希（对方设备可用新密码登录）；
 *       ③ 有令牌 → 直写云端成功；
 *       ④「💾 保存设置」兜底：某次重置因密钥错未上云（pwSyncPending 滞留），之后配对密钥再保存即补传。
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

/* 生成与 auth.js makePasswordHash 同格式的合法 pbkdf2$ 哈希（仅用于 seed，不参与校验） */
function hashFor(pw) {
  const salt = randomBytes(16);
  const dk = pbkdf2Sync(pw, salt, 150000, 32, 'sha256');
  return 'pbkdf2$150000$' + salt.toString('base64') + '$' + dk.toString('base64');
}

/* ---------- mock GitHub 仓库（内存） ---------- */
const ghFiles = new Map();
ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function cloudAccount(name) { const r = regOf(); return r.accounts && r.accounts[name]; }

/* mock /auth/register：复刻 worker authRegister 的 409（不同哈希 + 已激活 → 拒绝） */
function mockAuthRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  if (hash && (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4)) return { status: 400, body: { error: '密码哈希格式不正确' } };
  if (!hash && !body.placeholder) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  const claiming = !!(exist && !exist.hash);
  if (exist && !claiming) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > Date.now() || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  reg.accounts[username] = {
    hash: hash, role: (exist && exist.role === 'admin') ? 'admin' : 'user',
    status: claiming ? 'active' : (body.status === 'pending' ? 'pending' : 'active'),
    disabled: false, trialUntil: 0, trialDays: 0, quotaMonths: 0, disableDate: '', registerDate: '',
    payMembershipUntil: claiming ? Math.max(Number(body.payMembershipUntil) || 0, Number(exist.payMembershipUntil) || 0) : (Number(body.payMembershipUntil) || 0),
    paidAt: 0, paidPlan: '', paidAmount: 0,
    paidClaimIds: (claiming ? (exist.paidClaimIds || []).concat(body.paidClaimIds || []) : (body.paidClaimIds || [])).map(String).filter(Boolean),
    placeholder: claiming ? false : (!!body.placeholder), createdAt: Date.now(), updatedAt: Date.now()
  };
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
  return { status: 200, body: { ok: true, created: true } };
}

/* mock /auth/admin-reset：仅 ADMIN_RESET_KEY 匹配才允许改哈希 */
function mockAdminReset(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  const key = String(body.resetKey || '');
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return { status: 400, body: { error: '密码哈希格式不正确' } };
  if (key !== REAL_RESET_KEY) return { status: 403, body: { error: '重置密钥不正确' } };
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  if (!exist) return { status: 404, body: { error: '账号不存在' } };
  exist.hash = hash; exist.placeholder = false;
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
  return { status: 200, body: { ok: true, updated: true } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => { m.clear(); } };
}

function seedUser(storage, username, { role = 'user', payMembershipUntil = 0 } = {}) {
  const users = JSON.parse(storage.getItem('snt-auth-users-v1') || '[]');
  const oldHash = hashFor('OldPass@2026');
  users.push({
    username, role, hash: oldHash, pwSeal: '', disabled: false, status: 'active',
    createdAt: Date.now(), updatedAt: Date.now(), registerDate: '2026-10-01', quotaMonths: 0,
    payMembershipUntil, paidAt: 0, paidPlan: '', paidAmount: 0, paidClaimIds: [], logins: []
  });
  storage.setItem('snt-auth-users-v1', JSON.stringify(users));
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  reg.accounts[username] = {
    hash: oldHash, role, status: 'active', disabled: false, trialUntil: 0, trialDays: 0, quotaMonths: 0,
    disableDate: '', registerDate: '2026-10-01', payMembershipUntil, paidAt: 0, paidPlan: '', paidAmount: 0,
    paidClaimIds: [], placeholder: false, createdAt: Date.now(), updatedAt: Date.now()
  };
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
}

async function loadAuth(storage, { withToken = false, withWorker = false, resetKey = '' } = {}) {
  const sandbox = {
    localStorage: storage, sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      if (/^https?:/.test(u)) {
        if (u.includes('api.github.com')) {
          const m = (opt.method || 'GET').toUpperCase();
          if (m === 'GET') { const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]); const f = ghFiles.get(p); if (!f) return { ok: false, status: 404, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) }; }
          if (m === 'PUT') { const mm = /\/contents\/(.+?)(\?|$)/.exec(u); const p = decodeURIComponent(mm[1]); const body = JSON.parse(opt.body); const content = b64decode(body.content); ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 10) }); return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) }; }
        }
        if (/auth\/register$/.test(u) && withWorker) { const body = JSON.parse(opt.body || '{}'); const r = mockAuthRegister(body); return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }; }
        if (/auth\/admin-reset$/.test(u) && withWorker) { const body = JSON.parse(opt.body || '{}'); const r = mockAdminReset(body); return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }; }
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: (await import('node:crypto')).webcrypto,
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  sandbox.Auth.Sync = {
    isAdminConfigured: () => !!withToken,
    writeUser: (rec) => {
      if (!withToken) return Promise.resolve({ ok: false, skip: true, error: '未配置 GitHub 令牌' });
      const reg = regOf(); reg.accounts = reg.accounts || {};
      reg.accounts[rec.username] = {
        hash: rec.hash || '', role: rec.role || 'user', status: rec.status || 'active', disabled: !!rec.disabled,
        trialUntil: rec.trialUntil || 0, trialDays: rec.trialDays || 0, quotaMonths: rec.quotaMonths || 0, disableDate: '', registerDate: rec.registerDate || '',
        payMembershipUntil: rec.payMembershipUntil || 0, paidAt: Number(rec.paidAt) || 0, paidPlan: rec.paidPlan || '', paidAmount: Number(rec.paidAmount) || 0,
        paidClaimIds: rec.paidClaimIds || [], placeholder: !!rec.placeholder, createdAt: rec.createdAt || Date.now(), updatedAt: Date.now()
      };
      ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
      return Promise.resolve({ ok: true });
    },
    readRegistry: () => Promise.resolve(regOf()),
    registerRemoteViaWorker: (acct) => {
      const r = mockAuthRegister({ username: acct.username, hash: acct.hash, placeholder: !!acct.placeholder });
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300 && !!r.body.ok, status: r.status, error: r.body.error || '' });
    },
    adminResetRemoteViaWorker: (acct, key) => {
      const r = mockAdminReset({ username: acct.username, hash: acct.hash, resetKey: key });
      return Promise.resolve({ ok: r.status >= 200 && r.status < 300 && !!r.body.ok, status: r.status, error: r.body.error || '' });
    },
  };
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  if (resetKey) storage.setItem('snt-admin-reset-key', resetKey);
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const tick = () => new Promise(r => setTimeout(r, 30));

(async () => {
  // ========== 场景 1：无令牌 + 未配重置密钥 → 本地改了、云端失败、需告警 ==========
  console.log('\n[场景1] 无令牌 + 未配重置密钥：密码本机更新，云端同步失败（UI 应告警）');
  {
    ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
    const store = makeStorage();
    const A = await loadAuth(store, { withToken: false, withWorker: true, resetKey: '' });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    seedUser(store, 'testuser');
    check('初始云端哈希已落库', cloudAccount('testuser') && /^pbkdf2\$/.test(cloudAccount('testuser').hash), cloudAccount('testuser'));
    const oldCloudHash = cloudAccount('testuser').hash;
    const r = await A.Auth.changePassword('testuser', null, 'NewPass@2026');
    check('changePassword 本机成功', r && r.ok === true, r);
    check('changePassword 返回 cloud.ok=false（无令牌无密钥）', r && r.cloud && r.cloud.ok === false, r && r.cloud);
    const rawLocal = JSON.parse(store.getItem('snt-auth-users-v1') || '[]').find(x => x.username === 'testuser');
    check('本机哈希已更新为新密码', rawLocal && rawLocal.hash && rawLocal.hash !== oldCloudHash, rawLocal && { hash: rawLocal.hash });
    check('云端哈希【未变】（验证失败根因：密码没上云）', cloudAccount('testuser').hash === oldCloudHash, cloudAccount('testuser'));
  }

  // ========== 场景 2：无令牌 + 配了重置密钥 → 云端拿到新哈希（对方可登录） ==========
  console.log('\n[场景2] 无令牌 + 配了 ADMIN_RESET_KEY：密码成功同步到云端注册表');
  {
    ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
    const store = makeStorage();
    const A = await loadAuth(store, { withToken: false, withWorker: true, resetKey: REAL_RESET_KEY });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    seedUser(store, 'testuser');
    const oldCloudHash = cloudAccount('testuser').hash;
    const r = await A.Auth.changePassword('testuser', null, 'NewPass@2026');
    check('changePassword 本机成功', r && r.ok === true, r);
    check('changePassword 返回 cloud.ok=true（经 admin-reset 上云）', r && r.cloud && r.cloud.ok === true, r && r.cloud);
    const rawLocal = JSON.parse(store.getItem('snt-auth-users-v1') || '[]').find(x => x.username === 'testuser');
    check('云端哈希已更新为新密码（≠ 旧哈希）', cloudAccount('testuser').hash === rawLocal.hash && cloudAccount('testuser').hash !== oldCloudHash, { cloud: cloudAccount('testuser').hash, local: rawLocal.hash });
    check('云端账号仍为 active、会员等字段未被洗掉', cloudAccount('testuser').status === 'active' && cloudAccount('testuser').placeholder === false, cloudAccount('testuser'));
  }

  // ========== 场景 3：有令牌 → 直写云端成功 ==========
  console.log('\n[场景3] 有 GitHub 令牌：changePassword 经 Contents API 直写云端');
  {
    ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
    const store = makeStorage();
    const A = await loadAuth(store, { withToken: true, withWorker: true, resetKey: '' });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    seedUser(store, 'testuser');
    const oldCloudHash = cloudAccount('testuser').hash;
    const r = await A.Auth.changePassword('testuser', null, 'NewPass@2026');
    check('changePassword 返回 cloud.ok=true（令牌直写）', r && r.cloud && r.cloud.ok === true, r && r.cloud);
    const rawLocal = JSON.parse(store.getItem('snt-auth-users-v1') || '[]').find(x => x.username === 'testuser');
    check('云端哈希更新为新密码', cloudAccount('testuser').hash === rawLocal.hash && cloudAccount('testuser').hash !== oldCloudHash, cloudAccount('testuser'));
  }

  // ========== 场景 4：💾 保存设置 兜底补传（某次重置因密钥错未上云，之后配对密钥再保存即补传） ==========
  console.log('\n[场景4] 「保存设置」兜底：重置时密钥错未上云（pwSyncPending 滞留），配对密钥后再保存即补传到云端');
  {
    ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
    const store = makeStorage();
    // 先用「错误密钥」加载：changePassword 的云端推送会因密钥不符失败，但本机哈希已改、pwSyncPending 滞留
    const A = await loadAuth(store, { withToken: false, withWorker: true, resetKey: 'WRONG-KEY' });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    seedUser(store, 'gamma');
    const oldCloudHash = cloudAccount('gamma').hash;
    const r1 = await A.Auth.changePassword('gamma', null, 'NewPass@2026');
    check('重置时密钥错 → cloud.ok=false', r1 && r1.cloud && r1.cloud.ok === false, r1 && r1.cloud);
    check('此时云端哈希【仍为空/未变】（未上云）', cloudAccount('gamma').hash === oldCloudHash, cloudAccount('gamma'));
    // 管理员发现后，在「设置」里把重置密钥改成正确值，再点「保存设置」
    store.setItem('snt-admin-reset-key', REAL_RESET_KEY);
    const sr = await A.Auth.saveUsersToRegistry(['gamma']);
    check('保存设置 把滞留的密码改动补传到云端', sr && sr.ok === true && (sr.saved || []).indexOf('gamma') >= 0, sr);
    const rawLocal = JSON.parse(store.getItem('snt-auth-users-v1') || '[]').find(x => x.username === 'gamma');
    check('补传后云端哈希 == 本机新哈希', cloudAccount('gamma').hash === rawLocal.hash && cloudAccount('gamma').hash !== oldCloudHash, { cloud: cloudAccount('gamma').hash, local: rawLocal.hash });
  }

  console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
