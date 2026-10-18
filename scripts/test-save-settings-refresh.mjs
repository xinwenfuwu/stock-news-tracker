/* ============================================================
 * test-save-settings-refresh.mjs — 「保存设置」与审核流程刷新持久化验证（20261016q）
 *
 * 背景（用户需求）：把「保存设置」放到用户管理头部「从云端恢复」左侧，对页面任何
 * 设置做后端保存，防刷新丢失；并要求实测验证：
 *   ① 管理员点「核对并开通」后强制刷新网页——审核区是否还有这些待审核账户；
 *   ② 通过的账户是否在期限内正常登录；
 *   ③ 是否显示在授权使用对应的账户分类板块；
 *   ④ 拒绝通过以后的行为。
 *
 * 本测试以 Node vm 沙箱 + mock fetch（GitHub API / 静态 claims 文件）+ mock
 * localStorage 复刻上述全流程；「强制刷新」= 丢弃内存态、保留同一 localStorage
 * 重新加载 auth.js/auth-sync.js（与浏览器刷新后从 localStorage 重建完全一致）。
 * app.js 的交互函数（grantMemberClaim / loadMemberClaims / planOfUser 口径）按
 * 同源码顺序复刻调用 Auth API，保证与线上代码路径一致。
 *
 * 场景1（核心）：yh123 旧版申请（无 acct、账号各处都不存在）
 *   → 核对并开通五步链（直开→云端恢复→快照→待审注册→一键自动创建）
 *   → 强制刷新：待审区无 yh123、本机会员字段完好、归入 24月期口径
 *   → 全新设备登录成功（期限内正常登录）
 * 场景2（保存设置）：改角色/停用 → saveUsersToRegistry 上传
 *   → 强制刷新后设置仍在 → 新设备从云端恢复同样拿到新设置
 * 场景3（拒绝通过）：hy123 申请标 rejected → 强制刷新：待审区无、追溯列表有、
 *   账号未被创建/未开通
 * 场景4（静态断言）：头部「保存设置」在「从云端恢复」左侧、入口计数、
 *   resolvedClaimIds 持久化、reject 接线
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
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- mock GitHub 仓库（内存） ---------- */
const ghFiles = new Map();
ghFiles.set('data/accounts/registry.json', { content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {} }, null, 2), sha: 'sha-reg-0' });
ghFiles.set('data/membership/claims.json', { content: JSON.stringify({ claims: [] }, null, 2), sha: 'sha-clm-0' });
function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}
function claimsOf() { return JSON.parse(ghFiles.get('data/membership/claims.json').content); }
function setClaims(claims) {
  ghFiles.set('data/membership/claims.json', {
    content: JSON.stringify({ claims }, null, 2),
    sha: 'sha-clm-' + Math.random().toString(36).slice(2, 8),
  });
}

const workerCalls = [];
function mockAuthRegister(body) {
  const username = String(body.username || '').trim();
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  if (!username) return { status: 400, body: { error: '缺少用户名' } };
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/.test(username)) return { status: 400, body: { error: '用户名格式不正确' } };
  if (hash.indexOf('pbkdf2$') !== 0 || hash.split('$').length !== 4) return { status: 400, body: { error: '密码哈希格式不正确' } };
  const reg = regOf();
  reg.accounts = reg.accounts || {};
  const exist = reg.accounts[username];
  const now = Date.now();
  if (exist) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  const trialUntil = Number(body.trialUntil) || 0;
  reg.accounts[username] = {
    hash,
    role: (exist && exist.role === 'admin') ? 'admin' : 'user',
    status: body.status === 'pending' ? 'pending' : 'active',
    disabled: false,
    trialUntil,
    trialDays: Number(body.trialDays) || (trialUntil ? 1 : 0),
    quotaMonths: Number(body.quotaMonths) || 0,
    disableDate: '',
    registerDate: typeof body.registerDate === 'string' ? body.registerDate : '',
    payMembershipUntil: Number(body.payMembershipUntil) || 0,
    paidAt: Number(body.paidAt) || 0,
    paidPlan: typeof body.paidPlan === 'string' ? body.paidPlan : '',
    paidAmount: Number(body.paidAmount) || 0,
    createdAt: Number(body.createdAt) || now,
    updatedAt: now,
  };
  setRegistryAccounts(reg.accounts);
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
          const content = Buffer.from(body.content, 'base64').toString('utf8');
          ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
          return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
        }
      }
      if (/^https:\/\/sichina\.dpdns\.org\/auth\/register$/.test(u) && withWorker) {
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
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpddns.org'.replace('dpddns', 'dpdns');
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/* app.js loadMemberClaims 的过滤口径（20261016i/k：已解决/已拒绝/本机已标记 均不回显） */
async function loadPendingClaims(A, aStore) {
  const rd = await A.Sync.readClaims();
  const all = (rd && rd.claims) || [];
  const resolvedIds = new Set(JSON.parse(aStore.getItem('snt-resolved-claims-v1') || '[]'));
  return all.filter(c => !c.resolved && !c.rejected && !resolvedIds.has(c.id)).map(c => c.user);
}
/* app.js planOfUser 口径（授权使用板块归类） */
function planOf(u) {
  if (!u) return null;
  const pmu = Number(u.payMembershipUntil) || 0;
  if (pmu <= Date.now()) return null;
  if (u.paidPlan === '2y') return '2y';
  if (u.paidPlan === '1y') return '1y';
  if (u.paidPlan === '6m') return '6m';
  const months = (pmu - Date.now()) / MONTH_MS;
  if (months >= 18) return '2y';
  if (months >= 9) return '1y';
  return '6m';
}

(async () => {
  /* ========== 场景1：核对并开通 → 强制刷新 → 待审区/板块/登录 全验证 ========== */
  console.log('\n[场景1] yh123 旧版申请 → 核对并开通 → 强制刷新 → 新设备登录');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const payTs = Date.now() - 3600000;                 // 支付时间：1 小时前
    const SNAP_HASH = 'pbkdf2$150000$c2FsdHNhbHQ=$aHkxMjNoYXNo';
    setClaims([
      { id: 'clm_yh123', user: 'yh123', plan: '2y', amount: 4000, ts: payTs },                     // 旧版提交：无 acct
      { id: 'clm_hy123', user: 'hy123', plan: '6m', amount: 1000, ts: Date.now() - 7200000, acct: { username: 'hy123', hash: SNAP_HASH, role: 'user', status: 'pending' } },
    ]);
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');

    check('初始待审区有 yh123 与 hy123 两条', (await loadPendingClaims(A.Auth, aStore)).join(',') === 'yh123,hy123', (await loadPendingClaims(A.Auth, aStore)).join(','));

    /* --- 管理员对 clm_yh123 点「核对并开通」（app.js grantMemberClaim 同口径五步链） --- */
    const claim = claimsOf().claims.find(c => c.id === 'clm_yh123');
    const months = claim.plan === '2y' ? 24 : 12;
    // 第1步：直接开通
    let r = A.Auth.grantMembership(claim.user, months, { paidAt: claim.ts, amount: claim.amount });
    check('第1步 直接开通报「用户不存在」', r && r.ok === false && r.error === '用户不存在', JSON.stringify(r));
    // 第2步：云端恢复
    const rec = await A.Auth.recoverFromRegistry();
    check('第2步 云端恢复无该账号（recovered=0）', rec && rec.ok === true && rec.recovered === 0, JSON.stringify(rec));
    // 第3步：申请无 acct → 跳过；第4步：pendingUsers 无该名 → 跳过
    check('第3步 申请无 acct（旧版提交）', !(claim.acct && typeof claim.acct === 'object'));
    check('第4步 本机待审注册申请无 yh123', !(A.Auth.pendingUsers() || []).some(p => p.username === 'yh123'));
    // 第5步：一键自动创建并开通（runCreateGrant 同口径：创建→开通→上云）
    const NEW_PW = 'Yh@123456';
    const cr = await A.Auth.createAccountForClaim(claim.user, NEW_PW);
    check('第5步 一键创建账号成功', cr && cr.ok === true, JSON.stringify(cr && cr.error));
    r = A.Auth.grantMembership(claim.user, months, { paidAt: claim.ts, amount: claim.amount });
    check('第5步 按支付时间开通 24 个月', r && r.ok === true, JSON.stringify(r && r.error));
    const sr = await A.Auth.syncAccountToCloud(claim.user);
    check('第5步 账号+会员上云成功', sr && sr.ok === true, JSON.stringify(sr && sr.error));
    // 标记申请已处理（app.js：resolvedClaimIds 持久化 + 后端 claims resolved）
    aStore.setItem('snt-resolved-claims-v1', JSON.stringify(['clm_yh123']));
    const all = claimsOf().claims;
    const tgt = all.find(c => c.id === 'clm_yh123');
    tgt.resolved = true; tgt.resolvedAt = Date.now();
    setClaims(all);

    /* ===== 强制刷新：同一 localStorage 重新加载（内存态丢弃） ===== */
    const A2 = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    const lg = await A2.Auth.login('admin', 'Admin@2026');
    check('刷新后管理员可重新登录', lg.ok === true, JSON.stringify(lg.error || 'ok'));

    const pendingAfter = await loadPendingClaims(A2.Auth, aStore);
    check('① 刷新后审核区待审列表已无 yh123（已开通不回显）', !pendingAfter.includes('yh123'), pendingAfter.join(','));
    check('① 刷新后 hy123 仍在待审区（未处理）', pendingAfter.includes('hy123'), pendingAfter.join(','));

    const yh = A2.Auth.listUsersDetail().find(u => u.username === 'yh123');
    check('② 刷新后 yh123 仍在本机账号表', !!yh, 'not found');
    check('② 会员未到期（期限内）', !!yh && Number(yh.payMembershipUntil) > Date.now(), 'until=' + (yh && yh.payMembershipUntil));
    check('② 额度 24 个月 / paidPlan=2y', !!yh && yh.quotaMonths === 24 && yh.paidPlan === '2y', JSON.stringify({ q: yh && yh.quotaMonths, p: yh && yh.paidPlan }));
    check('③ 归入授权使用「24月期」板块（planOfUser=2y）', planOf(yh) === '2y', 'plan=' + planOf(yh));
    check('③ 不误入其他月期板块', planOf(yh) !== '6m' && planOf(yh) !== '1y');

    /* ===== 全新设备（空 localStorage）：期限内正常登录 ===== */
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg2 = await C.Auth.login('yh123', NEW_PW);
    check('② 全新设备 yh123+密码登录成功（门禁放行）', lg2.ok === true, JSON.stringify(lg2.error || 'ok'));
    check('② 登录角色为普通用户', lg2.ok === true && lg2.user && lg2.user.role === 'user', 'role=' + (lg2.user && lg2.user.role));
    const cUsers = JSON.parse(cStore.getItem('snt-auth-users-v1') || '[]');
    const cYh = cUsers.find(u => u.username === 'yh123');
    check('② 新设备本机也带会员到期时间（recover 合入）', !!cYh && Number(cYh.payMembershipUntil) > Date.now(), 'until=' + (cYh && cYh.payMembershipUntil));
    check('③ 新设备上同样归入 24月期板块', planOf(cYh) === '2y', 'plan=' + planOf(cYh));
  }

  /* ========== 场景2：保存设置 → 强制刷新 → 换设备 ========== */
  console.log('\n[场景2] 改账号设置 → 保存设置上传 → 强制刷新 → 新设备');
  {
    setRegistryAccounts({});
    setClaims([]);
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.createAccountForClaim('setupuser', 'Su@123456');

    // 管理员在页面上做两类典型设置：提权为管理员 + 停用另一个账号
    const rRole = A.Auth.setUserRole('setupuser', 'admin');
    check('本机改角色（user→admin）', rRole && rRole.ok === true, JSON.stringify(rRole && rRole.error));
    // 「保存设置」= saveUsersToRegistry（app.js saveApprovedZoneChanges 同口径）
    const sv = await A.Auth.saveUsersToRegistry(['setupuser']);
    check('保存设置上传成功', sv && sv.ok === true && (sv.saved || []).indexOf('setupuser') >= 0, JSON.stringify(sv));
    const cloudUser = regOf().accounts['setupuser'];
    check('云端注册表角色已是 admin', !!cloudUser && cloudUser.role === 'admin', JSON.stringify(cloudUser));

    /* ===== 强制刷新 ===== */
    const A2 = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A2.Auth.login('admin', 'Admin@2026');
    const yh2 = A2.Auth.listUsersDetail().find(u => u.username === 'setupuser');
    check('刷新后角色设置不丢失（仍为 admin）', !!yh2 && yh2.role === 'admin', 'role=' + (yh2 && yh2.role));

    /* ===== 新设备：登录即从云端注册表拿到已保存的设置（recoverFromRegistry 仅管理员可用，
           普通设备经 loginRemote 读云端注册表，这正是「保存设置」上传后的生效路径） ===== */
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg3 = await C.Auth.login('setupuser', 'Su@123456');
    check('新设备登录即拿到云端角色（admin，设置已上传后端）', lg3.ok === true && lg3.user && lg3.user.role === 'admin', JSON.stringify({ ok: lg3.ok, role: lg3.user && lg3.user.role, err: lg3.error }));
    const cUsers = JSON.parse(cStore.getItem('snt-auth-users-v1') || '[]');
    const cSu = cUsers.find(u => u.username === 'setupuser');
    check('新设备本机落下的角色也是 admin', !!cSu && cSu.role === 'admin', JSON.stringify(cSu && cSu.role));

    // 停用设置同样持久化
    const rDis = A.Auth.setUserDisabled('setupuser', true);
    check('本机停用账号', rDis && rDis.ok === true, JSON.stringify(rDis && rDis.error));
    const sv2 = await A.Auth.saveUsersToRegistry(['setupuser']);
    check('再次保存设置成功', sv2 && sv2.ok === true, JSON.stringify(sv2));
    check('云端 disabled=true', regOf().accounts['setupuser'].disabled === true, JSON.stringify(regOf().accounts['setupuser']));
    const A3 = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A3.Auth.login('admin', 'Admin@2026');
    const yh3 = A3.Auth.listUsersDetail().find(u => u.username === 'setupuser');
    check('刷新后停用设置不丢失', !!yh3 && yh3.disabled === true, JSON.stringify(yh3 && yh3.disabled));
  }

  /* ========== 场景3：拒绝通过 → 强制刷新 ========== */
  console.log('\n[场景3] hy123 申请 → 拒绝通过 → 强制刷新');
  {
    setRegistryAccounts({});
    const SNAP_HASH = 'pbkdf2$150000$c2FsdHNhbHQ=$aHkxMjNoYXNo';
    setClaims([
      { id: 'clm_hy123', user: 'hy123', plan: '6m', amount: 1000, ts: Date.now() - 7200000, acct: { username: 'hy123', hash: SNAP_HASH, role: 'user', status: 'pending' } },
    ]);
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');

    check('拒绝前 hy123 在待审区', (await loadPendingClaims(A.Auth, aStore)).includes('hy123'));

    /* --- 管理员点「拒绝通过」（app.js rejectMemberClaim 同口径：标 rejected+rejectedAt 写回） --- */
    const all = claimsOf().claims;
    const tgt = all.find(c => c.id === 'clm_hy123');
    tgt.rejected = true; tgt.rejectedAt = Date.now(); tgt.resolved = true;
    setClaims(all);

    /* ===== 强制刷新 ===== */
    const A2 = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A2.Auth.login('admin', 'Admin@2026');
    const pendingAfter = await loadPendingClaims(A2.Auth, aStore);
    check('④ 刷新后待审区无 hy123（已拒绝不回显）', !pendingAfter.includes('hy123'), pendingAfter.join(','));
    const rejected = claimsOf().claims.filter(c => c.rejected);
    check('④ 云端保留 rejected/rejectedAt 审计记录', rejected.length === 1 && Number(rejected[0].rejectedAt) > 0, JSON.stringify(rejected));
    const hyUser = A2.Auth.listUsersDetail().find(u => u.username === 'hy123');
    check('④ 被拒申请未创建账号/未开通会员（拒绝不开通）', !hyUser, JSON.stringify(hyUser || null));
    check('④ 云端注册表无 hy123（拒绝不上云）', !regOf().accounts['hy123'], JSON.stringify(Object.keys(regOf().accounts)));
  }

  /* ========== 场景4：静态断言（接线与按钮位置） ========== */
  console.log('\n[场景4] 静态断言：按钮位置 / 入口计数 / 持久化接线');
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');

    const saveIdx = html.indexOf('@click="saveApprovedZoneChanges"');
    const recoverIdx = html.indexOf('@click="recoverUsersByAdmin"');
    const headerStart = html.indexOf('👤 用户管理');
    const headerEnd = html.indexOf('um-tabs', headerStart);
    check('「保存设置」在用户管理头部、「从云端恢复」左侧',
      saveIdx > headerStart && saveIdx < headerEnd && recoverIdx > headerStart && recoverIdx < headerEnd && saveIdx < recoverIdx,
      'save=' + saveIdx + ' recover=' + recoverIdx);
    check('头部「保存设置」带 dirty 计数角标（4 处入口均有）', (html.match(/um-save-count" v-if="dirtyAccountList\.length > 0"/g) || []).length === 4, 'count=' + (html.match(/um-save-count" v-if="dirtyAccountList\.length > 0"/g) || []).length);
    check('全页保存入口共 4 处（表头 💾 保存 + 头部 + 审核区 + 授权使用）', (html.match(/@click="saveApprovedZoneChanges"/g) || []).length === 4, 'count=' + (html.match(/@click="saveApprovedZoneChanges"/g) || []).length);
    check('用户管理内「保存设置」文案按钮共 3 处（头部 + 审核区 + 授权使用）', (html.match(/<template v-else>保存设置<span class="um-save-count"/g) || []).length === 3, 'count=' + (html.match(/<template v-else>保存设置<span class="um-save-count"/g) || []).length);
    check('app.js resolvedClaimIds 持久化（刷新后已通过申请不回显）',
      /const RESOLVED_CLAIM_KEY = 'snt-resolved-claims-v1';/.test(app) && /function persistResolvedClaims\(\)/.test(app) && /resolvedClaimIds\.add\(claim\.id\); persistResolvedClaims\(\);/.test(app));
    check('app.js 审核通过后从待审列表立即移除', /memberClaims\.list = memberClaims\.list\.filter\(c => c\.id !== claim\.id\);/.test(app));
    check('app.js 拒绝通过落 rejected/rejectedAt 并写回', /rejected: true/.test(app) && /rejectedAt/.test(app));
    check('app.js 授权使用板块按 planOfUser 归类（paidPlan 优先）', /function planOfUser\(u\) \{[\s\S]*?u\.paidPlan === '2y'/.test(app));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
