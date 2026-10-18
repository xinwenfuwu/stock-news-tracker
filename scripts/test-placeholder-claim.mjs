/* ============================================================
 * test-placeholder-claim.mjs — 验证「占位会员凭证 + 审核区永久去重」（20261018d）
 *
 * 背景（用户诉求）：
 *  A. 旧版无账号申请的孤儿单（如 huyun1 / hy123 / yh123：云端注册表没有、申请无 acct、
 *     本机/待审注册都没有）→ 管理员点「核对并开通」要能一键登记会籍，而不是只弹引导；
 *     且绝对不能生成/修改任何人的密码。
 *  B. 一旦某条申请被核对开通，无论 claims.json 的 resolved 偶发写失败、无论换设备/刷新，
 *     都不该再回到审核区——靠账号上的 paidClaimIds（本机+云端注册表）永久去重。
 *
 * 本测试在 node vm 沙箱里加载真实的 js/auth.js + js/auth-sync.js（与页面同口径），
 * 用内存版 GitHub 仓库 + mock Worker 验证底层原语，不依赖浏览器/Vue。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* ---------- mock GitHub 仓库（内存） ---------- */
const ghFiles = new Map();
ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8)
  });
}
function cloudAccount(name) { const r = regOf(); return r.accounts && r.accounts[name]; }

const workerCalls = [];

/* mock 的 Worker /auth/register 端点：与 cloudflare-worker-prod/worker.js authRegister 同口径，
 * 支持「占位凭证认领」（exist && !exist.hash）与空 hash 占位写入。 */
function mockAuthRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  // 20261018d：占位凭证（placeholder=true 且 hash 为空）允许；普通账号仍要求 pbkdf2$
  if (hash && (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4)) return { status: 400, body: { error: '密码哈希格式不正确' } };
  if (!hash && !body.placeholder) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  const claiming = !!(exist && !exist.hash);   // 占位凭证被同名注册认领
  reg.accounts[username] = {
    hash: hash,
    role: (exist && exist.role === 'admin') ? 'admin' : 'user',
    status: claiming ? 'active' : (body.status === 'pending' ? 'pending' : 'active'),
    disabled: false,
    trialUntil: claiming ? (Number(exist.trialUntil) || 0) : (Number(body.trialUntil) || 0),
    trialDays: claiming ? (Number(exist.trialDays) || 0) : (Number(body.trialDays) || 0),
    quotaMonths: claiming ? Math.max(Number(body.quotaMonths) || 0, Number(exist.quotaMonths) || 0) : (Number(body.quotaMonths) || 0),
    disableDate: '',
    registerDate: (claiming && exist.registerDate) ? exist.registerDate : (typeof body.registerDate === 'string' ? body.registerDate : ''),
    payMembershipUntil: claiming ? Math.max(Number(body.payMembershipUntil) || 0, Number(exist.payMembershipUntil) || 0) : (Number(body.payMembershipUntil) || 0),
    paidAt: claiming ? (Number(exist.paidAt) || Number(body.paidAt) || 0) : (Number(body.paidAt) || 0),
    paidPlan: claiming ? (exist.paidPlan || (typeof body.paidPlan === 'string' ? body.paidPlan : '')) : (typeof body.paidPlan === 'string' ? body.paidPlan : ''),
    paidAmount: claiming ? (Number(exist.paidAmount) || Number(body.paidAmount) || 0) : (Number(body.paidAmount) || 0),
    paidClaimIds: (claiming ? (exist.paidClaimIds || []).concat(body.paidClaimIds || []) : (body.paidClaimIds || [])).map(String).filter(Boolean),
    placeholder: claiming ? false : (!!body.placeholder),
    createdAt: Number(body.createdAt) || (exist && Number(exist.createdAt)) || Date.now(),
    updatedAt: Date.now()
  };
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify(reg, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8)
  });
  return { status: 200, body: { ok: true, created: true } };
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

async function loadAuthForDevice(storage, { withToken = false, withWorker = false } = {}) {
  const sandbox = {
    localStorage: storage,
    sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      if (!/^https?:/.test(u)) {
        const p = u.split('?')[0].replace(/^\.?\//, '');
        const f = ghFiles.get(p);
        if (!f) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(f.content) };
      }
      if (u.includes('api.github.com')) {
        const m = (opt.method || 'GET').toUpperCase();
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
          const content = b64decode(body.content);
          ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
          return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
        }
      }
      if (/auth\/register$/.test(u) && withWorker) {
        const body = JSON.parse(opt.body || '{}');
        workerCalls.push(body);
        const r = mockAuthRegister(body);
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
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
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ========== 场景 A：孤儿申请（无 acct、云端注册表也没有）→ 占位会员凭证一键登记 ==========
  console.log('\n[场景A] 孤儿申请（huyun1）一键登记占位会员凭证，绝不改动密码');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const claim = { id: 'c_huyun1_001', user: 'huyun1', plan: '2y', amount: 4000, ts: Date.now() - 3600000 };
    const months = 24;
    const payTs = claim.ts;

    // 故障复现：常规开通报「用户不存在」
    const g0 = A.Auth.grantMembership(claim.user, months, { paidAt: payTs, amount: claim.amount });
    check('常规 grantMembership 报「用户不存在」（复现孤儿场景）', g0 && g0.ok === false && g0.error === '用户不存在', g0);

    // 占位凭证开通（grantMemberClaim 的第 5 兜底即走这里）
    const ph = await A.Auth.grantMembershipPlaceholder(claim.user, months, { paidAt: payTs, amount: claim.amount, claimId: claim.id });
    check('grantMembershipPlaceholder 成功', ph && ph.ok === true, ph);
    check('占位凭证标记 placeholder=true', ph && ph.placeholder === true, ph);
    // 直接读 localStorage 原始账号（listUsers 会经 publicUser 脱敏、不含 hash），验证占位凭证「无密码」真值
    const rawA = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
    const rawU = rawA.find(x => x.username === claim.user);
    check('占位凭证不生成密码（hash 为空）', rawU && rawU.hash === '' && rawU.placeholder === true, rawU || { missing: true });
    check('占位凭证会员到期时间自支付日起算（>= 24 个月）',
      ph && ph.until && ph.until >= payTs + 24 * MONTH_MS - 1000, ph && { until: ph.until, payTs });
    check('占位凭证记录 paidClaimIds 含申请 id',
      ph && ph.ok && (function () {
        const u = A.Auth.listUsers().find(x => x.username === claim.user);
        return u && Array.isArray(u.paidClaimIds) && u.paidClaimIds.indexOf(claim.id) >= 0;
      })(), null);
    // 云端注册表已写入占位凭证
    await tick();
    const cloud = cloudAccount(claim.user);
    check('占位凭证已写云端注册表', !!cloud, cloud);
    check('云端占位账号 placeholder=true', cloud && cloud.placeholder === true, cloud);
    check('云端占位账号 hash 为空', cloud && cloud.hash === '', cloud);
    check('云端占位账号 paidClaimIds 含申请 id', cloud && Array.isArray(cloud.paidClaimIds) && cloud.paidClaimIds.indexOf(claim.id) >= 0, cloud);
    check('云端占位账号 payMembershipUntil>0', cloud && Number(cloud.payMembershipUntil) > 0, cloud);
    // 原始持久化账号口径一致（buildRegistryRecord 为模块内私有函数，以下以原始持久化记录代替其断言）
    check('原始持久化记录含 paidClaimIds', rawU && Array.isArray(rawU.paidClaimIds) && rawU.paidClaimIds.indexOf(claim.id) >= 0, rawU);
    check('原始持久化记录 placeholder 标记', rawU && rawU.placeholder === true, rawU);

    // 占位账号无法用「任何密码」登录（因为没有哈希）——访问门禁按无会员/无密码处理
    const loginR = await A.Auth.login(claim.user, '随便猜的密码');
    check('占位账号任何密码都登录失败（无哈希，安全）', !loginR.ok, loginR);
  }

  // ========== 场景 B：普通会员开通记录 claimId 到 paidClaimIds ==========
  console.log('\n[场景B] 正常开通（账号存在）记录 paidClaimIds，供审核区去重');
  {
    setRegistryAccounts({});
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true, withWorker: false });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.register('realuser', 'Real@1234');
    const claim = { id: 'c_real_001', user: 'realuser', plan: '1y', amount: 2000, ts: Date.now() - 7200000 };
    const g = A.Auth.grantMembership(claim.user, 12, { paidAt: claim.ts, amount: claim.amount, claimId: claim.id });
    check('正常开通成功', g && g.ok === true, g);
    const u = A.Auth.listUsers().find(x => x.username === claim.user);
    check('payMembershipUntil 自支付日起算', u && Number(u.payMembershipUntil) >= claim.ts + 12 * MONTH_MS - 1000, u);
    check('paidClaimIds 含申请 id', u && Array.isArray(u.paidClaimIds) && u.paidClaimIds.indexOf(claim.id) >= 0, u);
    check('paidAt 等于申请 ts（去重第二口径）', u && Number(u.paidAt) === claim.ts, u);
    await A.Auth.syncAccountToCloud(claim.user);   // 真实 grantMemberClaim 会调 propagateMembershipGrant
    await tick();
    const cloud = cloudAccount(claim.user);
    check('云端 paidClaimIds 含申请 id', cloud && Array.isArray(cloud.paidClaimIds) && cloud.paidClaimIds.indexOf(claim.id) >= 0, cloud);
  }

  // ========== 场景 C：recoverFromRegistry 合并 paidClaimIds 并纳入占位账号 ==========
  console.log('\n[场景C] recoverFromRegistry 合并 paidClaimIds + 纳入占位账号');
  {
    // 云端：占位账号 huyun1（带 paidClaimIds），以及已开通的 realuser（带 paidClaimIds）
    setRegistryAccounts({
      huyun1: { hash: '', placeholder: true, role: 'user', status: 'active', disabled: false,
        payMembershipUntil: Date.now() + 24 * MONTH_MS, paidAt: Date.now() - 3600000, paidPlan: '2y',
        paidAmount: 4000, quotaMonths: 24, paidClaimIds: ['c_huyun1_001'], createdAt: Date.now() },
      realuser: { hash: 'pbkdf2$x', role: 'user', status: 'active', disabled: false,
        payMembershipUntil: Date.now() + 12 * MONTH_MS, paidAt: Date.now() - 7200000, paidPlan: '1y',
        paidAmount: 2000, quotaMonths: 12, paidClaimIds: ['c_real_001'], createdAt: Date.now() }
    });
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: false, withWorker: false });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    // 本机只有 realuser 且没 paidClaimIds
    const ru = A.Auth.listUsers().find(x => x.username === 'realuser');
    if (ru) ru.paidClaimIds = [];
    const rec = await A.Auth.recoverFromRegistry();
    check('recoverFromRegistry 成功', rec && rec.ok === true, rec);
    check('占位账号 huyun1 被合并回本机', !!A.Auth.listUsers().find(x => x.username === 'huyun1' && x.placeholder), null);
    const hu = A.Auth.listUsers().find(x => x.username === 'huyun1');
    check('合并后占位账号带 paidClaimIds', hu && Array.isArray(hu.paidClaimIds) && hu.paidClaimIds.indexOf('c_huyun1_001') >= 0, hu);
    const ru2 = A.Auth.listUsers().find(x => x.username === 'realuser');
    check('本机 realuser 合并云端 paidClaimIds', ru2 && Array.isArray(ru2.paidClaimIds) && ru2.paidClaimIds.indexOf('c_real_001') >= 0, ru2);
  }

  // ========== 场景 D：去重口径校验（复刻 app.js claimAlreadyApplied 依赖的数据） ==========
  console.log('\n[场景D] 去重数据口径：claim.id ∈ paidClaimIds / paidAt === claim.ts');
  {
    setRegistryAccounts({});
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true, withWorker: false });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.register('u_dedup', 'Dedup@1234');
    const claim = { id: 'c_dup_001', user: 'u_dedup', plan: '6m', amount: 1000, ts: Date.now() - 1000000 };
    A.Auth.grantMembership(claim.user, 6, { paidAt: claim.ts, amount: claim.amount, claimId: claim.id });
    await A.Auth.syncAccountToCloud(claim.user);   // 真实流程里由 propagateMembershipGrant 触发
    await tick();
    // 模拟审核区去重索引（只读云端，等价于 app.js claimAppliedIndex 的云端分支）
    const reg = await A.Auth.Sync.readRegistry();
    const acc = reg.accounts['u_dedup'];
    const ids = new Set((acc.paidClaimIds || []).map(String));
    const rec2 = { paidClaimIds: (acc.paidClaimIds || []).map(String), paidAt: Number(acc.paidAt) };
    const appliedById = ids.has(claim.id);
    const appliedByPaidAt = (rec2.paidClaimIds.indexOf(claim.id) >= 0) || (Number(rec2.paidAt) === Number(claim.ts));
    check('claim.id 命中 paidClaimIds → 判定已开通', appliedById === true, { ids: Array.from(ids) });
    check('paidAt === claim.ts → 判定已开通', appliedByPaidAt === true, rec2);
    // 续费新申请（不同 id，晚于原 paidAt）不应被旧 paidAt 误吞
    const renew = { id: 'c_dup_002', user: 'u_dedup', plan: '6m', ts: Date.now() };
    const appliedRenew = ids.has(renew.id) || (Number(renew.ts) > 0 && Number(rec2.paidAt) === Number(renew.ts));
    check('续费新申请（不同 id / 不同 paidAt）不被误吞', appliedRenew === false, { renewId: renew.id, paidAt: rec2.paidAt, renewTs: renew.ts });
  }

  console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
