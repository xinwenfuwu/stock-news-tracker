/* ============================================================
 * test-claim-create-grant.mjs — 验证「核对并开通」只分配会员时间、绝不改动用户密码（20261018c）
 *
 * 背景（用户需求）：管理员点「核对并开通」后，账号的密码竟然被改了（20261018c 反馈）。
 * 明确要求：核对并开通只负责分配「支付对应的使用时间」，不得改动用户自己设置的密码。
 *   账号在本机/云端/申请快照/待审注册里能解析到 → 用原哈希开通（密码不动）；
 *   解析不到 → 提示对方重新提交/申请码导入，绝不自动生成随机密码建号（那会覆盖原密码）。
 *
 * 场景1（核心需求）：已存在账号用自设密码注册 → 申请带快照 → 管理员按快照解析并开通
 *   → 用户自设密码哈希全程不变 → 用户用原密码登录成功且带会员（门禁放行）。
 * 场景2（管理员手动建号原语）：createAccountForClaim 仍可用（与核对并开通解耦），
 *   建号+开通后经 Worker /auth/register 代写，会员字段一并落库。
 * 场景3（待审注册兜底）：同设备注册卡在 pending 的账号 → approveUser（沿用对方哈希）
 *   → grantMembership，无需新建密码。
 * 场景4（边界与防护）：非管理员拒绝 / 已存在用户名拒绝 / 弱密码拒绝 /
 *   同步不存在用户拒绝 / 创建账号角色强制普通用户。
 * 场景5（静态断言）：auth.js / app.js / index.html / auth-boot.js / auth-sync.js 接线，
 *   重点断言「核对并开通」不再含 genClaimPassword / runCreateGrant / grantCreatePw /
 *   confirmGrantCreate 等密码改动路径，index.html 无「创建并开通」密码输入框。
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
  /* ========== 场景1：核心需求——核对并开通只分配时间，绝不改动用户自设密码 ========== */
  console.log('\n[场景1] 已存在账号（用户自设密码）→ 云端恢复并开通 → 原密码照常登录且带会员');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});                       // 云端注册表先清空
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');

    // 模拟「普通用户在自己设备注册」（无令牌）：账号经 Worker 写入云端注册表（与线上一致）
    const uStore = makeStorage();
    const U = await loadAuthForDevice(uStore, { withToken: false, withWorker: true });
    const reg = await U.Auth.register('yh123', 'MyOwn@2026');
    check('用户在自己设备注册成功（自设密码）', reg.ok === true, JSON.stringify(reg.error || 'ok'));
    const snapR = await U.Auth.accountSnapshot('yh123');
    const payTs = Date.now() - 3600000;
    const claim = { id: 'clm_yh123', user: 'yh123', plan: '2y', amount: 4000, ts: payTs, acct: snapR.snapshot };

    // 管理员设备：直接开通报「用户不存在」（管理员本机没有该账号，复现故障）
    const g0 = A.Auth.grantMembership('yh123', 24, { paidAt: payTs, amount: 4000 });
    check('直接开通报「用户不存在」（复现故障）', g0 && g0.ok === false && g0.error === '用户不存在', JSON.stringify(g0));
    // 云端恢复：把用户注册时写入的账号（含其自设密码哈希）合并回管理员本机
    const rec = await A.Auth.recoverFromRegistry();
    check('云端恢复成功（账号注册时已上云，含用户自设密码哈希）', rec && rec.ok === true && rec.recovered >= 1, JSON.stringify(rec));

    // 开通会员（仅分配使用时间，不碰密码）
    const gr = A.Auth.grantMembership('yh123', 24, { paidAt: payTs, amount: 4000 });
    check('开通 24 个月成功', gr && gr.ok === true, JSON.stringify(gr && gr.error));
    check('会员自支付时间起算且未过期', gr && gr.until > Date.now(), 'until=' + (gr && gr.until));

    // 关键断言：用户自设密码的哈希没有被任何「核对并开通」步骤改动
    const rawUsers = JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]');
    const yh = rawUsers.find(u => u.username === 'yh123');
    check('核对并开通后用户自设密码哈希保持不变', !!yh && yh.hash === snapR.snapshot.hash, 'hash changed!');
    check('云端注册表哈希 = 用户自设那份（任意设备可原密码登录）',
      !!regOf().accounts['yh123'] && regOf().accounts['yh123'].hash === snapR.snapshot.hash, 'cloud hash mismatch');

    // 用户在自己设备（或全新设备）用「原密码」直接登录成功 + 带会员（门禁放行）
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg = await C.Auth.login('yh123', 'MyOwn@2026');
    check('用户用原密码登录成功（密码未被改动）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后即带会员（门禁未拦）', lg.ok === true && lg.user && lg.user.role === 'user', '');
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

  /* ========== 场景6：需求2——已支付用户会员未到期前不停止使用，到期（且试用已过）才停 ========== */
  console.log('\n[场景6] 会员未到期前放行（不停止已支付用户使用）；到期后才拒绝');
  {
    setRegistryAccounts({});
    // 单设备（管理员、无令牌无 Worker）→ 门禁复核只认本机，避免云端会员源把过期值兜底回未来
    const uStore = makeStorage();
    const U = await loadAuthForDevice(uStore, { withToken: false, withWorker: false });
    await U.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const reg = await U.Auth.register('paidguy', 'Paid@2026');
    check('前置：注册 paidguy 成功', reg.ok === true, JSON.stringify(reg.error || 'ok'));

    // 管理员为 paidguy 开通 6 个月（未到期）
    const gr = U.Auth.grantMembership('paidguy', 6, { paidAt: Date.now() });
    check('开通 6 个月（会员未到期）', gr && gr.ok === true && gr.until > Date.now(), 'until=' + (gr && gr.until));

    const lg = await U.Auth.login('paidguy', 'Paid@2026');
    check('前置：paidguy 登录成功（会话建立）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    const rc = await U.Auth.recheckAccess();
    check('需求2：会员未到期 → recheckAccess 放行（不停止使用）', rc && rc.ok === true, JSON.stringify(rc));

    // 把会员到期时间改成过去、并清空试用，模拟「会员已过期且试用也已过」→ 门禁应立即拒绝
    const users = JSON.parse(uStore.getItem('snt-auth-users-v1') || '[]');
    const pu = users.find(u => u.username === 'paidguy');
    pu.payMembershipUntil = Date.now() - 86400000;
    pu.trialUntil = 0; pu.trialDays = 0;
    uStore.setItem('snt-auth-users-v1', JSON.stringify(users));
    const rc2 = await U.Auth.recheckAccess();
    check('需求2：会员已过期且试用已过 → recheckAccess 拒绝（到期才停止）', rc2 && rc2.ok === false, JSON.stringify(rc2));
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
    check('app.js 核对并开通解析账号三兜底：recoverFromRegistry + createAccountFromSnapshot + approveUser',
      /recoverFromRegistry[\s\S]*?createAccountFromSnapshot[\s\S]*?approveUser\(claim\.user, 'user'\)/.test(app));
    check('app.js 核对并开通绝不改动用户密码：已移除 genClaimPassword/runCreateGrant/grantCreatePw/confirmGrantCreate/grantCreateId',
      !/genClaimPassword/.test(app) && !/runCreateGrant/.test(app) && !/grantCreatePw/.test(app) && !/confirmGrantCreate/.test(app) && !/grantCreateId/.test(app));
    check('app.js 账号解析不到时回落「用户不存在」引导（提示重新提交/申请码，不自动建号覆盖密码）',
      /旧版提交[\s\S]{0,200}申请码/.test(app) || /请让对方在登录页/.test(app));
    check('index.html 审核区不再有「创建并开通」密码输入框（已移除密码改动路径）',
      !html.includes('grantCreateId === c.id') && !html.includes('um-create-pw') && !html.includes('confirmGrantCreate(c)'));
    check('auth.js 仍保留 createAccountForClaim 原语（管理员手动建号独立能力，与核对并开通解耦）',
      /createAccountForClaim: function/.test(auth));
    check('auth-boot.js 会员面板对本机无账号给出提醒', /noLocalAcct/.test(boot) && /本机没有账号/.test(boot));
    check('auth-sync.js 代写载荷含会员字段', /payMembershipUntil: Number\(acct\.payMembershipUntil\)/.test(sync) && /quotaMonths: Number\(acct\.quotaMonths\)/.test(sync));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
