/* ============================================================
 * test-claim-durable-resolve.mjs — 「审核通过后永久不再回审核区」全链路回归（20261018h）
 *
 * 用户实况（截图）：审核区里 hy123 / huyun1(×2) 三条申请，管理员点了「核对并开通」，
 * 强制刷新网页后又全部出现。要求：
 *   ① 审核结果必须真正上传到云端，云端再反馈给登录者与管理员；
 *   ② 管理员刷新后审核区不再出现这些账号信息；
 *   ③ 管理员删除这些账号，整个系统（本机 + 云端）都删除，普通用户能重新注册。
 *
 * 本测试锁定的三个真实根因（均已实测确认）：
 *   A. 线上 Worker /auth/register 要求 pbkdf2$ 四段哈希，**拒绝占位会员凭证**（hash 为空）
 *      → 「核对并开通」建的占位账号 100% 上不了云 → 去重依据丢失 → 刷新/换设备即复发。
 *   B. 申请状态（resolved）只发一次请求，失败没有补偿 → claims.json 长期停在 resolved:false。
 *   C. 删除账号不清理该用户名下的待审申请 → 审核区永远挂一条「查无此人」的申请。
 *
 * 说明：vm 沙箱里加载真实的 js/auth.js + js/auth-sync.js；Worker 侧用内存 mock，
 * 其行为与 cloudflare-worker-prod/worker.js 本轮修改后的实现同口径（含 legacy 对照）。
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
const REG = 'data/accounts/registry.json';
const CLM = 'data/membership/claims.json';
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function b64decode(b) { return Buffer.from(b, 'base64').toString('utf8'); }
function regOf() { return JSON.parse(ghFiles.get(REG).content); }
function claimsOf() { return JSON.parse(ghFiles.get(CLM).content).claims; }
function setRegistry(accounts) { ghFiles.set(REG, { content: JSON.stringify({ version: 1, updatedAt: 0, accounts }, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) }); }
function setClaims(claims) { ghFiles.set(CLM, { content: JSON.stringify({ claims }, null, 2), sha: 'sha-clm-' + Math.random().toString(36).slice(2, 8) }); }
function cloudAccount(n) { const r = regOf(); return r.accounts && r.accounts[n]; }
function cloudClaim(id) { return claimsOf().find(c => c.id === id); }

const RESET_KEY = 'test-reset-key-2026';
const DEAD = 'https://dead.invalid';
let workerMode = 'new';          // new = 本轮修好的 Worker；legacy = 线上旧实现（拒绝占位凭证）
const workerHits = [];

/* ---------- Worker mock：/auth/register（new / legacy 两种口径） ---------- */
function wRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  const isPlaceholder = workerMode !== 'legacy' && body.placeholder === true && !hash;
  if (!isPlaceholder && (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4)) {
    return { status: 400, body: { error: '密码哈希格式不正确' } };   // legacy 即卡在这里
  }
  const now = Date.now();
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  const mergeIds = (a, b) => (a || []).concat(b || []).map(x => String(x || '')).filter((x, i, arr) => x && arr.indexOf(x) === i).slice(-30);
  // 占位凭证补会籍：绝不覆盖已有真实密码
  if (isPlaceholder && exist && exist.hash) {
    exist.paidClaimIds = mergeIds(exist.paidClaimIds, body.paidClaimIds);
    exist.payMembershipUntil = Math.max(Number(exist.payMembershipUntil) || 0, Number(body.payMembershipUntil) || 0);
    exist.quotaMonths = Math.max(Number(exist.quotaMonths) || 0, Number(body.quotaMonths) || 0);
    if (!Number(exist.paidAt) && Number(body.paidAt)) exist.paidAt = Number(body.paidAt);
    reg.accounts[username] = exist;
    ghFiles.set(REG, { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
    return { status: 200, body: { ok: true, merged: true, passwordKept: true } };
  }
  const claiming = !!(exist && !exist.hash);
  if (exist && !claiming) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  reg.accounts[username] = {
    hash,
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
    paidPlan: claiming ? (exist.paidPlan || body.paidPlan || '') : (body.paidPlan || ''),
    paidAmount: claiming ? (Number(exist.paidAmount) || Number(body.paidAmount) || 0) : (Number(body.paidAmount) || 0),
    paidClaimIds: mergeIds(claiming ? exist.paidClaimIds : [], body.paidClaimIds),
    placeholder: isPlaceholder,
    createdAt: Number(body.createdAt) || (exist && Number(exist.createdAt)) || now,
    updatedAt: now
  };
  ghFiles.set(REG, { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
  return { status: 200, body: { ok: true, created: true } };
}

/* ---------- Worker mock：/pay/claims、/pay/claims/resolve ---------- */
function wClaimsGet() {
  return { status: 200, body: { ok: true, configured: true, claims: claimsOf() } };
}
function wClaimResolve(body) {
  const id = String(body.id || '').trim();
  if (!id) return { status: 400, body: { error: '缺少 id' } };
  const claims = claimsOf();
  const t = claims.find(c => c.id === id);
  if (t) { t.resolved = true; t.resolvedAt = t.resolvedAt || Date.now(); if (body.rejected === true) { t.rejected = true; t.rejectedAt = Date.now(); } }
  ghFiles.set(CLM, { content: JSON.stringify({ claims }, null, 2), sha: 'sha-clm-' + Math.random().toString(36).slice(2, 8) });
  return { status: 200, body: { ok: true, rejected: body.rejected === true, found: !!t } };
}

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, clear: () => m.clear() };
}

async function loadDevice(storage, opts = {}) {
  const sandbox = {
    localStorage: storage,
    sessionStorage: makeStorage(),
    location: { hostname: opts.hostname || 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (DurableResolveTest)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      const isAbs = /^https?:/.test(u);
      if (!isAbs) {
        const p = u.split('?')[0].replace(/^\.?\//, '');
        const f = ghFiles.get(p);
        if (!f) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(f.content) };
      }
      if (u.includes('api.github.com')) {
        const m = (opt.method || 'GET').toUpperCase();
        const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
        const p = decodeURIComponent(mm[1]);
        if (m === 'GET') {
          const f = ghFiles.get(p);
          if (!f) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
        }
        const body = JSON.parse(opt.body);
        ghFiles.set(p, { content: b64decode(body.content), sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
        return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
      }
      // 死地址：模拟「设置里填了失效代理地址」
      if (u.startsWith(DEAD)) throw new TypeError('Failed to fetch (dead base)');
      // Worker 路由（任一可达域名都由同一 mock 处理）
      const p = u.replace(/^https?:\/\/[^/]+/, '');
      const body = opt.body ? JSON.parse(opt.body) : {};
      workerHits.push(p);
      let r;
      if (p === '/auth/register') r = wRegister(body);
      else if (p === '/pay/claims') r = wClaimsGet();
      else if (p === '/pay/claims/resolve') r = wClaimResolve(body);
      else if (p === '/auth/admin-delete') {
        if (String(body.resetKey || '') !== RESET_KEY) r = { status: 403, body: { error: '删除密钥不正确' } };
        else {
          const reg = regOf(); reg.accounts = reg.accounts || {};
          const had = !!reg.accounts[body.username];
          delete reg.accounts[body.username];
          ghFiles.set(REG, { content: JSON.stringify(reg, null, 2), sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8) });
          r = { status: 200, body: { ok: true, deleted: had } };
        }
      } else r = { status: 404, body: { error: 'not found' } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: (await import('node:crypto')).webcrypto,
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.__SNT_ACCEL__ = opts.accel || 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (opts.token) storage.setItem('snt-auth-admin-token', opts.token);
  if (opts.resetKey) storage.setItem('snt-admin-reset-key', opts.resetKey);
  return { Auth: sandbox.Auth };
}

const MONTH = 30 * 24 * 60 * 60 * 1000;

/* 复刻 app.js claimAlreadyApplied 的三口径（审核区过滤依据） */
function reviewListFrom(claims, reg) {
  const ids = new Set(), byUser = {};
  const accs = (reg && reg.accounts) || {};
  Object.keys(accs).forEach(k => {
    const a = accs[k] || {};
    (a.paidClaimIds || []).forEach(id => ids.add(String(id)));
    byUser[String(k).toLowerCase()] = { paidClaimIds: (a.paidClaimIds || []).map(String), paidAt: Number(a.paidAt) || 0 };
  });
  return claims.filter(c => {
    if (c.resolved || c.rejected) return false;
    if (ids.has(String(c.id))) return false;
    const r = byUser[String(c.user || '').toLowerCase()];
    if (r) {
      if (r.paidClaimIds.indexOf(String(c.id)) >= 0) return false;
      if (Number(c.ts) > 0 && r.paidAt === Number(c.ts)) return false;
    }
    return true;
  });
}

const TS_HY123 = Date.parse('2026-10-17T10:01:00+08:00');
const TS_HY1 = Date.parse('2026-10-18T18:46:00+08:00');
const TS_HY2 = Date.parse('2026-10-18T20:21:00+08:00');

(async () => {
  // ================= 场景 0：复现线上根因（旧 Worker 拒绝占位凭证） =================
  console.log('\n[场景0] 复现根因：旧 Worker 拒绝占位凭证 → 云端注册表没有该账号');
  {
    workerMode = 'legacy';
    setRegistry({});
    setClaims([{ id: 'c_hy123', user: 'hy123', plan: '6m', amount: 4000, ts: TS_HY123, resolved: false }]);
    const { Auth } = await loadDevice(makeStorage(), {});
    await Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const ph = await Auth.grantMembershipPlaceholder('hy123', 6, { paidAt: TS_HY123, amount: 4000, claimId: 'c_hy123' });
    check('旧 Worker：占位凭证本机登记成功（用户看到「已开通」）', ph && ph.ok === true, ph);
    check('旧 Worker：占位凭证未写入云端（synced=false）', ph && ph.synced === false, ph);
    check('旧 Worker：云端注册表确实没有 hy123（根因实证）', !cloudAccount('hy123'), cloudAccount('hy123') || null);
  }

  // ================= 场景 1：修复后占位凭证真正上云 =================
  console.log('\n[场景1] 修复后：核对并开通 → 占位会员凭证写入云端注册表');
  workerMode = 'new';
  const baseClaims = [
    { id: 'c_hy123', user: 'hy123', plan: '6m', amount: 4000, ts: TS_HY123, resolved: false },
    { id: 'c_huyun1_24', user: 'huyun1', plan: '2y', amount: 4000, ts: TS_HY1, resolved: false },
    { id: 'c_huyun1_12', user: 'huyun1', plan: '1y', amount: 2000, ts: TS_HY2, resolved: false }
  ];
  setRegistry({});
  setClaims(baseClaims.map(c => ({ ...c })));
  const storeAdmin = makeStorage();
  const admin = (await loadDevice(storeAdmin, {})).Auth;
  await admin.setup('admin', 'Admin@2026', 'Admin@2026');
  workerHits.length = 0;

  const g1 = await admin.grantMembershipPlaceholder('hy123', 6, { paidAt: TS_HY123, amount: 4000, claimId: 'c_hy123' });
  check('占位凭证登记成功', g1 && g1.ok === true, g1);
  check('占位凭证已同步云端（synced=true）', g1 && g1.synced === true, g1);
  const cHy123 = cloudAccount('hy123');
  check('云端注册表出现 hy123', !!cHy123, cHy123);
  check('云端占位账号 hash 为空（无密码，任何设备都登不进）', cHy123 && cHy123.hash === '', cHy123 && { hash: !!cHy123.hash });
  check('云端占位账号 placeholder=true', cHy123 && cHy123.placeholder === true, cHy123);
  check('云端占位账号 paidClaimIds 含 c_hy123', cHy123 && (cHy123.paidClaimIds || []).indexOf('c_hy123') >= 0, cHy123 && cHy123.paidClaimIds);
  check('云端会员到期 = 支付日 + 6 个月',
    cHy123 && Math.abs(Number(cHy123.payMembershipUntil) - (TS_HY123 + 6 * MONTH)) < 5000,
    cHy123 && { until: cHy123.payMembershipUntil, expect: TS_HY123 + 6 * MONTH });

  const g2 = await admin.grantMembershipPlaceholder('huyun1', 24, { paidAt: TS_HY1, amount: 4000, claimId: 'c_huyun1_24' });
  const cHy1 = cloudAccount('huyun1');
  check('huyun1 占位凭证上云成功', g2 && g2.synced === true && !!cHy1, { g2, cHy1: !!cHy1 });
  check('huyun1 云端 paidClaimIds 含 24 月申请', cHy1 && (cHy1.paidClaimIds || []).indexOf('c_huyun1_24') >= 0, cHy1 && cHy1.paidClaimIds);

  // 同一 huyun1 的第二条申请（12 月期）：合并 paidClaimIds，不重复建号（同名 placeholder 续期）
  const g3 = await admin.grantMembershipPlaceholder('huyun1', 12, { paidAt: TS_HY2, amount: 2000, claimId: 'c_huyun1_12' });
  const cHy1b = cloudAccount('huyun1');
  check('huyun1 二次登记仍是同一个账号（未重复建号）', !!cHy1b && cHy1b.hash === '', cHy1b && { hash: !!cHy1b.hash });
  check('huyun1 paidClaimIds 合并两条申请',
    cHy1b && (cHy1b.paidClaimIds || []).indexOf('c_huyun1_24') >= 0 && (cHy1b.paidClaimIds || []).indexOf('c_huyun1_12') >= 0,
    cHy1b && cHy1b.paidClaimIds);
  check('huyun1 会员到期取较长的 24 月期',
    cHy1b && Math.abs(Number(cHy1b.payMembershipUntil) - (TS_HY1 + 24 * MONTH)) < 5000,
    cHy1b && { until: cHy1b.payMembershipUntil, expect: TS_HY1 + 24 * MONTH });

  // ================= 场景 2：申请状态上云（多通道兜底，主地址失效也能成功） =================
  console.log('\n[场景2] 申请状态上云：配置的代理地址失效 → 自动走国内可达主域');
  {
    // 管理员本机把「代理地址」填成一个死地址（线上真实存在的失误场景）
    const bad = (await loadDevice(makeStorage(), { accel: DEAD })).Auth;
    await bad.setup('admin', 'Admin@2026', 'Admin@2026');
    workerHits.length = 0;
    const r1 = await bad.Sync.resolveClaimRemote('c_hy123', false);
    check('死地址下仍标记成功（自动切到备用主域）', r1 && r1.ok === true, r1);
    check('回执 found=true（云端确有该申请）', r1 && r1.found === true, r1);
    check('云端 c_hy123 已 resolved', cloudClaim('c_hy123') && cloudClaim('c_hy123').resolved === true, cloudClaim('c_hy123'));

    const r2 = await bad.Sync.resolveClaimRemote('c_huyun1_24', false);
    const r3 = await bad.Sync.resolveClaimRemote('c_huyun1_12', false);
    check('huyun1 两条申请均已 resolved',
      r2.found && r3.found && cloudClaim('c_huyun1_24').resolved === true && cloudClaim('c_huyun1_12').resolved === true,
      { r2, r3 });

    const r4 = await bad.Sync.resolveClaimRemote('c_not_exist_zzz', false);
    check('不存在的 id：ok=true 但 found=false（客户端可据此区分「假成功」）', r4 && r4.ok === true && r4.found === false, r4);
  }

  // ================= 场景 3：强制刷新 / 换设备后审核区为空 =================
  console.log('\n[场景3] 全新设备（空 localStorage）打开审核区：三条已通过申请不再出现');
  {
    const fresh = (await loadDevice(makeStorage(), {})).Auth;
    await fresh.setup('admin', 'Admin@2026', 'Admin@2026');
    const rec = await fresh.recoverFromRegistry();
    check('新设备从云端恢复到占位账号', rec && rec.ok === true && rec.recovered >= 2, rec);
    const hy = fresh.listUsers().find(u => u.username === 'huyun1');
    check('新设备看到 huyun1 的会籍（placeholder + 到期时间）',
      hy && hy.placeholder === true && Number(hy.payMembershipUntil) > Date.now(), hy);

    const rd = await fresh.Sync.readClaims();
    const review = reviewListFrom(rd.claims, await fresh.Sync.readRegistry());
    check('审核区为空（三条申请全部不再出现）', review.length === 0, review.map(c => c.user + ':' + c.id));

    // 双重兜底：即使云端 resolved 又被写回 false，账号上的 paidClaimIds 也能挡住
    const brokenClaims = baseClaims.map(c => ({ ...c }));
    const registry = await fresh.Sync.readRegistry();
    const review2 = reviewListFrom(brokenClaims, registry);
    check('云端 resolved 丢失时，靠 paidClaimIds 仍全部挡掉（防御纵深）', review2.length === 0, review2.map(c => c.id));
  }

  // ================= 场景 4：删除账号 → 全系统删除 + 同名可重新注册 =================
  console.log('\n[场景4] 管理员删除账号：本机 + 云端一并删除，普通用户可重新注册');
  {
    const delDev = (await loadDevice(makeStorage(), { resetKey: RESET_KEY })).Auth;
    await delDev.setup('admin', 'Admin@2026', 'Admin@2026');
    await delDev.recoverFromRegistry();
    check('删除前本机存在 hy123', !!delDev.listUsers().find(u => u.username === 'hy123'), null);
    const rm = delDev.removeUser('hy123');
    check('removeUser 成功', rm && rm.ok === true, rm);
    const dr = await rm.sync;
    check('云端注册表删除成功（via=worker）', dr && dr.ok === true, dr);
    check('云端注册表已无 hy123', !cloudAccount('hy123'), cloudAccount('hy123') || null);
    check('本机也已无 hy123', !delDev.listUsers().find(u => u.username === 'hy123'), null);

    // 同名重新注册：注册表已清空 → 正常创建（不再 409 抢名）
    const reReg = await delDev.Sync.registerRemoteViaWorker({
      username: 'hy123', hash: 'pbkdf2$200000$c2FsdA$aGFzaA', status: 'active',
      trialUntil: Date.now() + 86400000, trialDays: 1, registerDate: new Date().toISOString().slice(0, 10)
    });
    check('删除后同名重新注册成功（不报「用户名已被使用」）', reReg && reReg.ok === true, reReg);
    check('重新注册的是真实密码账号（placeholder=false）', cloudAccount('hy123') && cloudAccount('hy123').placeholder === false, cloudAccount('hy123'));
  }

  // ================= 场景 5：删号级联清理该用户的待审申请（静态接线校验） =================
  console.log('\n[场景5] 删号级联 + 队列接线（防止改回单次 resolve）');
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
    const worker = fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8');
    check('app.js 有持久重试队列键', app.indexOf('snt-claim-queue-v1') >= 0);
    check('app.js 有 flushClaimResolveQueue', app.indexOf('async function flushClaimResolveQueue') >= 0);
    check('开通成功后失败会入队', app.indexOf('if (!claimMarked) enqueueClaimResolve(claim.id, false)') >= 0);
    check('拒绝失败也会入队', app.indexOf('if (!marked) enqueueClaimResolve(claim.id, true)') >= 0);
    check('刷新按钮先补传再拉列表', /flushClaimResolveQueue\(\);[\s\S]{0,200}await loadMemberClaims\(\)/.test(app));
    check('开机 + 定时自动补传', app.indexOf("try { flushClaimResolveQueue(); } catch (e) {} }, 2500)") >= 0);
    check('删号级联清理申请', app.indexOf('cascadeResolveClaimsForUser') >= 0 && app.indexOf('const casc = cascadeResolveClaimsForUser') >= 0);
    check('保存设置也补传队列', /pendingIds[\s\S]{0,400}claimQueue\.map/.test(app));
    check('审核区读数多通道（配置地址 → 国内主域）', app.indexOf("readBases.push('https://sichina.dpdns.org')") >= 0);
    check('auth-sync 导出 resolveClaimRemote', sync.indexOf('resolveClaimRemote: resolveClaimRemote') >= 0);
    check('auth-sync 候选含国内主域', sync.indexOf("var PRIMARY_MEMBER_API = 'https://sichina.dpdns.org'") >= 0);
    check('Worker 允许占位凭证（hash 为空）', worker.indexOf('const isPlaceholder = body.placeholder === true && !hash;') >= 0);
    check('Worker 占位不覆盖真实密码', worker.indexOf('if (isPlaceholder && exist && exist.hash)') >= 0);
    check('Worker 占位如实落 placeholder 字段', worker.indexOf('placeholder: !!isPlaceholder') >= 0);
    check('Worker resolve 回执带 found', /found: !!t/.test(worker));
  }

  console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
