/* ============================================================
 * test-claim-create-grant.mjs — 验证「核对并开通」兜底创建链路（20261016l）
 *
 * 背景（用户需求）：管理员对无账号信息的旧版支付申请点「核对并开通」，
 * 要能直接开通对应期限并把账号归类到相应板块——即使账号在本机、
 * 云端注册表、申请快照里都不存在（用户实测 yh123：¥4000/24月期申请
 * 无 acct，云端注册表也没有，点开通即报错）。
 *
 * 场景1（核心需求完整复现，与线上实况一致）：
 *   申请无 acct、云端注册表没有 yh123、管理员本机也没有
 *   → createAccountForClaim 创建账号（密码可改）
 *   → grantMembership 按支付时间开通 24 个月
 *   → syncAccountToCloud 令牌直写云端（账号+会员）
 *   → 全新设备用该密码登录成功（门禁放行，会员有效）
 * 场景2（无令牌设备）：创建+开通后经 Worker /auth/register 代写，
 *   会员字段一并落库（对方任意设备登录即带会员）
 * 场景3（待审注册兜底）：同设备注册卡在 pending 的账号 → approveUser
 *   （沿用对方密码哈希）→ grantMembership，无需新建密码
 * 场景4（边界与防护）：非管理员拒绝 / 已存在用户名拒绝 / 弱密码拒绝 /
 *   同步不存在用户拒绝 / 创建账号角色强制普通用户
 * 场景5（静态断言）：auth.js / app.js / index.html / auth-boot.js /
 *   auth-sync.js 接线
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
function b64utf8(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}

const workerCalls = [];   // 记录打到 /auth/register 的请求

/** mock 的 Worker 端点：契约与 cloudflare-worker-prod/worker.js authRegister（20261016l）一致 */
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
      // pay Worker：/auth/register 代写（withWorker=false 时模拟「Worker 不可达」）
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
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

(async () => {
  /* ========== 场景1：核心需求——无快照申请 + 账号各处都不存在 → 创建并开通 ========== */
  console.log('\n[场景1] 旧版申请（无 acct）且账号不存在 → 创建账号 → 按支付时间开通 → 云端落库 → 新设备登录');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});                       // 云端注册表为空（与线上实况一致：yh123 不在册）
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');

    // 模拟线上那条申请：yh123 / 2y / ¥4000 / 无 acct（旧版提交）
    const claim = { id: 'clm_yh123', user: 'yh123', plan: '2y', amount: 4000, ts: Date.now() - 3600000 };
    const months = claim.plan === '2y' ? 24 : 12;
    const payTs = Number(claim.ts) || 0;

    // 复现故障：链前三步都找不到账号
    const g0 = A.Auth.grantMembership(claim.user, months, { paidAt: payTs, amount: claim.amount });
    check('直接开通报「用户不存在」（复现故障）', g0 && g0.ok === false && g0.error === '用户不存在', JSON.stringify(g0));
    const rec = await A.Auth.recoverFromRegistry();
    check('云端注册表也恢复不到（recovered=0）', rec && rec.ok === true && rec.recovered === 0, JSON.stringify(rec));

    // 管理员点「创建并开通」：创建账号（密码可改）→ 开通 → 云端落库
    const cr = await A.Auth.createAccountForClaim(claim.user, 'Yh@123456');
    check('createAccountForClaim 创建成功', cr && cr.ok === true, JSON.stringify(cr && cr.error));
    const gr = A.Auth.grantMembership(claim.user, months, { paidAt: payTs, amount: claim.amount });
    check('开通 24 个月成功', gr && gr.ok === true, JSON.stringify(gr && gr.error));
    const sr = await A.Auth.syncAccountToCloud(claim.user);
    check('云端落库成功（令牌直写）', sr && sr.ok === true, JSON.stringify(sr && sr.error));

    // 本机账号状态：会员自支付时间起算、归入 24 月期口径
    const detail = A.Auth.listUsersDetail().find(u => u.username === 'yh123');
    check('账号出现在本机列表（审核通过区可见）', !!detail, 'not found');
    check('会员到期 = 支付时间 + 24 个月', !!detail && Math.abs(Number(detail.payMembershipUntil) - (payTs + 24 * MONTH_MS)) < 60000, 'until=' + (detail && detail.payMembershipUntil));
    check('额度 24 个月', !!detail && detail.quotaMonths === 24, 'q=' + (detail && detail.quotaMonths));
    check('paidPlan=2y / 实付 4000 / 支付日期落库', !!detail && detail.paidPlan === '2y' && Number(detail.paidAmount) === 4000 && Number(detail.paidAt) === payTs, JSON.stringify({ p: detail && detail.paidPlan, a: detail && detail.paidAmount, t: detail && detail.paidAt }));
    check('角色为普通用户（防提权）', !!detail && detail.role === 'user', 'role=' + (detail && detail.role));

    // 云端注册表：账号 + 会员一起落库
    const cloud = regOf().accounts['yh123'];
    check('云端注册表有 yh123（active）', !!cloud && cloud.status === 'active', JSON.stringify(cloud || null));
    check('云端会员字段齐全（until/quota/plan/amount）', !!cloud && Number(cloud.payMembershipUntil) > Date.now() && cloud.quotaMonths === 24 && cloud.paidPlan === '2y' && cloud.paidAmount === 4000, JSON.stringify(cloud));
    check('云端哈希即新建密码那份（对方可登录）', !!cloud && /^pbkdf2\$/.test(cloud.hash), 'hash=' + (cloud && cloud.hash));

    // 全新设备：用「用户名 + 新密码」直接登录（门禁放行 = 会员有效）
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg = await C.Auth.login('yh123', 'Yh@123456');
    check('全新设备用新密码登录成功', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后即带会员（门禁未拦）', lg.ok === true && lg.user && lg.user.role === 'user', 'role=' + (lg.user && lg.user.role));
    // 新设备本机也落下会员到期时间（读原始存储：listUsersDetail 需管理员视角）
    const cUsers = JSON.parse(cStore.getItem('snt-auth-users-v1') || '[]');
    const cYh = cUsers.find(u => u.username === 'yh123');
    check('新设备本机也落下会员到期时间', !!cYh && Number(cYh.payMembershipUntil) > Date.now(), 'until=' + (cYh && cYh.payMembershipUntil));
  }

  /* ========== 场景2：无令牌设备——经 Worker 代写，会员一并落库 ========== */
  console.log('\n[场景2] 管理员无令牌：创建+开通 → Worker 代写（账号+会员一次落库）');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: false, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');

    const payTs = Date.now() - 7200000;
    const cr = await A.Auth.createAccountForClaim('notoken', 'Nt@123456');
    check('无令牌也能本机创建账号', cr && cr.ok === true, JSON.stringify(cr && cr.error));
    const gr = A.Auth.grantMembership('notoken', 24, { paidAt: payTs, amount: 4000 });
    check('开通成功', gr && gr.ok === true, JSON.stringify(gr && gr.error));
    const sr = await A.Auth.syncAccountToCloud('notoken');
    check('syncAccountToCloud 经 Worker 代写成功', sr && sr.ok === true, JSON.stringify(sr && sr.error));

    check('向 Worker 发了 /auth/register', workerCalls.length === 1 && workerCalls[0].username === 'notoken', JSON.stringify(workerCalls));
    const w = workerCalls[0] || {};
    check('代写载荷带 pbkdf2 哈希', /^pbkdf2\$/.test(w.hash || ''), 'hash=' + w.hash);
    check('代写载荷带会员字段（until/quota/plan/amount/paidAt）',
      Number(w.payMembershipUntil) > Date.now() && w.quotaMonths === 24 && w.paidPlan === '2y' && w.paidAmount === 4000 && Number(w.paidAt) === payTs,
      JSON.stringify({ u: w.payMembershipUntil, q: w.quotaMonths, p: w.paidPlan, a: w.paidAmount, t: w.paidAt }));
    const cloud = regOf().accounts['notoken'];
    check('云端注册表落库且带会员', !!cloud && cloud.status === 'active' && Number(cloud.payMembershipUntil) > Date.now() && cloud.quotaMonths === 24, JSON.stringify(cloud));
    check('云端角色为普通用户', !!cloud && cloud.role === 'user', 'role=' + (cloud && cloud.role));
  }

  /* ========== 场景3：待审注册兜底——同设备注册卡 pending 的账号免新建密码 ========== */
  console.log('\n[场景3] 本机待审注册申请里有该账号 → 审核通过（沿用密码哈希）→ 开通');
  {
    setRegistryAccounts({});
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    // 本机造一个「待审核」注册申请（同设备注册 / 申请码导入后的形态，带对方密码哈希）
    const FAKE_HASH = 'pbkdf2$150000$c2FsdHNhbHQ=$aGFzaGhhc2g';
    aStore.setItem('snt-auth-users-v1', JSON.stringify([
      { username: 'admin', role: 'admin', hash: 'pbkdf2$150000$c2FsdHNhbHQ=$YWRtaW5oYXNo', status: 'active', createdAt: 1, updatedAt: 1 },
      { username: 'penduser', role: 'user', hash: FAKE_HASH, status: 'pending', createdAt: 1, updatedAt: 1 },
    ]));
    const pend = A.Auth.pendingUsers().find(p => p.username === 'penduser');
    check('pendingUsers 能找到待审注册申请', !!pend, JSON.stringify(A.Auth.pendingUsers()));
    const ar = A.Auth.approveUser('penduser', 'user');
    check('审核通过成功（对应链中「待审注册兜底」）', ar && ar.ok === true, JSON.stringify(ar && ar.error));
    const gr = A.Auth.grantMembership('penduser', 24, { paidAt: Date.now() - 3600000, amount: 4000 });
    check('随后开通 24 个月成功', gr && gr.ok === true, JSON.stringify(gr && gr.error));
    const detail = A.Auth.listUsersDetail().find(u => u.username === 'penduser');
    check('账号 active 且带会员', !!detail && detail.status !== 'pending' && Number(detail.payMembershipUntil) > Date.now(), JSON.stringify(detail));
    // 读原始存储：listUsersDetail 不暴露哈希
    const rawUsers = JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]');
    const rawPend = rawUsers.find(u => u.username === 'penduser');
    check('密码哈希保持对方那份（未被覆盖）', !!rawPend && rawPend.hash === FAKE_HASH, 'hash=' + (rawPend && rawPend.hash));
  }

  /* ========== 场景4：边界与防护 ========== */
  console.log('\n[场景4] 边界：非管理员 / 已存在 / 弱密码 / 同步不存在用户');
  {
    setRegistryAccounts({});
    // 非管理员（未 setup 的设备）
    const nStore = makeStorage();
    const N = await loadAuthForDevice(nStore, { withToken: true, withWorker: true });
    const cr0 = await N.Auth.createAccountForClaim('someone', 'Ab@123456');
    check('非管理员调用被拒绝', cr0 && cr0.ok === false && /仅管理员/.test(cr0.error || ''), JSON.stringify(cr0));

    // 管理员设备
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await A.Auth.createAccountForClaim('dupuser', 'Du@123456');
    const crDup = await A.Auth.createAccountForClaim('dupuser', 'Du@123456');
    check('已存在用户名 → 拒绝（引导直接在用户表开通）', crDup && crDup.ok === false && /已存在/.test(crDup.error || ''), JSON.stringify(crDup));
    const crWeak = await A.Auth.createAccountForClaim('weakpw', '123');
    check('弱密码 → 校验拒绝', crWeak && crWeak.ok === false, JSON.stringify(crWeak));
    const sr0 = await A.Auth.syncAccountToCloud('nobody');
    check('同步不存在的用户 → 明确报错', sr0 && sr0.ok === false && /用户不存在/.test(sr0.error || ''), JSON.stringify(sr0));
    // 创建出来的账号角色必须是普通用户
    const d = A.Auth.listUsersDetail().find(u => u.username === 'dupuser');
    check('兜底创建的账号角色为普通用户', !!d && d.role === 'user', 'role=' + (d && d.role));
    check('兜底创建的账号状态 active', !!d && d.status !== 'pending', 'status=' + (d && d.status));
  }

  /* ========== 场景5：静态断言（接线） ========== */
  console.log('\n[场景5] 静态断言：auth/app/index/boot/sync 接线');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');

    check('auth.js 新增 createAccountForClaim', /createAccountForClaim: function/.test(auth));
    check('auth.js 新增 syncAccountToCloud（直写→Worker 代写）', /syncAccountToCloud: function[\s\S]*?_syncAccountToCloud\(u\)/.test(auth));
    check('auth.js createAccountForClaim 仅管理员', /createAccountForClaim: function[\s\S]*?仅管理员可执行该操作/.test(auth));
    check('auth.js createAccountForClaim 角色强制 user', /createAccountForClaim: function[\s\S]*?role: ROLE\.USER/.test(auth));
    check('app.js grantMemberClaim 含待审注册兜底（pendingUsers→approveUser）', /A\.pendingUsers\(\)[\s\S]*?A\.approveUser\(claim\.user, 'user'\)/.test(app));
    check('app.js grantMemberClaim 含创建确认触发（grantCreateId）', /grantCreateId\.value = claim\.id/.test(app));
    check('app.js 新增 confirmGrantCreate', /async function confirmGrantCreate/.test(app));
    check('app.js confirmGrantCreate 创建→开通→落库 顺序', /createAccountForClaim\(claim\.user, pw\)[\s\S]*?grantMembership\(claim\.user, months[\s\S]*?syncAccountToCloud\(claim\.user\)/.test(app));
    check('app.js confirmGrantCreate 弹密码面板（showApproveCodePanel）', /async function confirmGrantCreate[\s\S]*?showApproveCodePanel/.test(app));
    check('app.js 暴露 grantCreateId/grantCreatePw/confirmGrantCreate', /grantCreateId, grantCreatePw, confirmGrantCreate/.test(app));
    check('index.html 行内「创建并开通」确认区', html.includes('grantCreateId === c.id') && html.includes('confirmGrantCreate(c)'));
    check('index.html 创建确认含密码输入框', html.includes('um-create-pw') && html.includes('v-model="grantCreatePw"'));
    check('auth-boot.js 会员面板对本机无账号给出提醒', /noLocalAcct/.test(boot) && /本机没有账号/.test(boot));
    check('auth-sync.js 代写载荷含会员字段', /payMembershipUntil: Number\(acct\.payMembershipUntil\)/.test(sync) && /quotaMonths: Number\(acct\.quotaMonths\)/.test(sync));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
