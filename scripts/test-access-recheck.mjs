/* ============================================================
 * test-access-recheck.mjs — 20261016f 验证：
 *   用户规范「会员/试用到期即无法使用」的**运行时**落地（会话存续期间）
 *
 * 覆盖（对照用户 4 条注意）：
 *   注意1：有效期内无需再次审核（recheckAccess 放行）；
 *          过了有效期账号无法使用（recheckAccess 踢会话 + 清登录态）；
 *          本地过期但云端有有效会员 → 不误踢（管理员刚在别的设备开通的场景）；
 *   注意3：注册送的 1 天试用到期 → 踢；
 *   注意4：状态字段与门禁一致（本地快判复用 accessDeny 同一口径）；
 *   附加：管理员永远放行；停用账号踢；数据被别的路径改过会重读（不拿旧快照误判）。
 *
 * 手法：vm 沙箱加载真实 js/auth.js + js/auth-sync.js（含 mock GitHub 仓库），
 *       通过 localStorage 直改账号字段构造「已过期会员 / 已过期试用」。
 * 用法：node scripts/test-access-recheck.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear() },
  };
}

async function loadAuthForDevice(storage, { withToken = false } = {}) {
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
      return { ok: false, status: 500, json: async () => ({}) };
    },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: (await import('node:crypto')).webcrypto,
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

/** 直改本机账号表字段（模拟「会员在会话存续期间到期」等状态变化） */
function patchLocalUser(storage, username, patch) {
  const users = JSON.parse(storage.getItem('snt-auth-users-v1') || '[]');
  const u = users.find(x => x.username === username);
  if (!u) throw new Error('local user not found: ' + username);
  Object.assign(u, patch);
  storage.setItem('snt-auth-users-v1', JSON.stringify(users));
}
/** 直改云端注册表字段（模拟「管理员刚在别的设备开通并同步上云」） */
function patchRegistryUser(username, patch) {
  const j = JSON.parse(ghFiles.get('data/accounts/registry.json').content);
  const acc = j.accounts[username] || {};
  Object.assign(acc, patch);
  j.accounts[username] = acc;
  ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(j, null, 2), sha: 'r' + Math.random() });
}

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  /* ========== 准备：一台「用户设备」注册普通账号并登录（带令牌，便于写云端注册表） ========== */
  console.log('\n[准备] 用户设备注册 + 登录（注册送 1 天试用 → 试用中）');
  const store = makeStorage();
  const { Auth } = await loadAuthForDevice(store, { withToken: true });
  await Auth.setup('admin', 'Admin@2026', 'Admin@2026');
  const USER = '到期测试用户';
  const reg = await Auth.register(USER, 'abc12345');
  check('注册成功（注意3：自动 1 天试用、无需管理员审核）', reg.ok === true && reg.autoTrial === true, JSON.stringify(reg));
  // 登录成为「会员用户」：管理员先给开 6 个月会员（未来）
  const g = await Auth.grantMembership(USER, 6, { paidAt: Date.now(), amount: 1000 });
  check('管理员开通 6 个月会员成功', g.ok === true, JSON.stringify(g));
  const lg = await Auth.login(USER, 'abc12345');
  check('会员有效 → 登录放行（注意1：有效期内正常使用）', lg.ok === true, JSON.stringify(lg.error || 'ok'));

  /* ========== T1 会员有效期内复查 → 放行（注意1：无需再次审核） ========== */
  console.log('\n[T1] 会员有效期内复查 → 放行');
  {
    const r = await Auth.recheckAccess();
    check('会员有效 → recheckAccess ok（无需再次审核）', r.ok === true, JSON.stringify(r));
    check('会话保留（未被踢）', !!Auth.session && Auth.session.username === USER, JSON.stringify(Auth.session && Auth.session.username));
  }

  /* ========== T2 会员在会话存续期间过期 → 踢 + 清登录态（注意1：过期无法使用） ========== */
  console.log('\n[T2] 会员过期（会话存续期间）→ 立即失效');
  {
    patchLocalUser(store, USER, { payMembershipUntil: Date.now() - DAY, paidPlan: '6m', trialUntil: 0, trialDays: 0, quotaMonths: 0 });
    patchRegistryUser(USER, { payMembershipUntil: Date.now() - DAY, trialUntil: 0, trialDays: 0, quotaMonths: 0 });   // 云端同样过期（自然到期）
    const r = await Auth.recheckAccess();
    check('会员过期 → recheckAccess 返回失效', r.ok === false && !!r.error, JSON.stringify(r));
    check('内存会话被清（Auth.session=null）', Auth.session === null, JSON.stringify(Auth.session));
    check('持久化会话被清（sessionsMap 无该账号）', (Auth.listSessions() || []).every(s => s.username !== USER), JSON.stringify(Auth.listSessions()));
  }

  /* ========== T3 本地过期但云端有有效会员 → 不误踢（管理员刚在别的设备开通） ========== */
  console.log('\n[T3] 本地过期 + 云端有效会员 → 不误踢');
  {
    // 云端有未来会员、本机过期（模拟：管理员刚在别的设备开通并同步上云，本机尚未收到）
    patchLocalUser(store, USER, { payMembershipUntil: Date.now() - DAY, trialUntil: 0, trialDays: 0, quotaMonths: 0 });
    patchRegistryUser(USER, { payMembershipUntil: Date.now() + 180 * DAY, paidPlan: '6m', trialUntil: 0, quotaMonths: 6 });
    const lg2 = await Auth.login(USER, 'abc12345');
    check('云端会员仍有效 → 登录放行', lg2.ok === true, JSON.stringify(lg2.error || 'ok'));
    // 登录后本机已被 applyGrant 置为未来；再把本机改过去（模拟本机数据被外部改坏），recheck 应走云端救回
    patchLocalUser(store, USER, { payMembershipUntil: Date.now() - DAY });
    const r = await Auth.recheckAccess();
    check('本地过期但云端有效 → recheckAccess ok（防误踢）', r.ok === true, JSON.stringify(r));
    check('会话保留', !!Auth.session && Auth.session.username === USER, '');
    check('云端会员已落本机（applyRemoteMembership 生效）', (() => {
      const users = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
      const u = users.find(x => x.username === USER);
      return !!u && Number(u.payMembershipUntil) > Date.now();
    })(), 'local payMembershipUntil not updated');
  }

  /* ========== T4 试用到期（注意3：注册送的 1 天试用到期未付费）→ 踢 ========== */
  console.log('\n[T4] 试用到期未付费 → 踢');
  {
    // 撤销会员（quotaMonths 清零路径太绕，直接改本机+云端都清零）
    patchLocalUser(store, USER, { payMembershipUntil: 0, paidPlan: '', quotaMonths: 0, trialUntil: Date.now() - DAY, trialDays: 1 });
    patchRegistryUser(USER, { payMembershipUntil: 0, trialUntil: Date.now() - DAY, quotaMonths: 0 });
    if (process.env.SNT_DEBUG) {
      const dbgUsers = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
      const dbgU = dbgUsers.find(x => x.username === USER);
      const dbgReg = JSON.parse(ghFiles.get('data/accounts/registry.json').content).accounts[USER] || {};
      console.log('    [dbg] local pmu=' + dbgU.payMembershipUntil + ' trialUntil=' + dbgU.trialUntil + ' | reg pmu=' + dbgReg.payMembershipUntil + ' trialUntil=' + dbgReg.trialUntil + ' now=' + Date.now());
    }
    const lg3 = await Auth.login(USER, 'abc12345');
    check('试用已到期 → 登录即被拦（accessDeny 门禁）', lg3.ok === false, JSON.stringify(lg3));
    // 构造「会话存续期间试用到期」：先给未来试用并登录（本机+云端同步改，loginRemote 以注册表为准），再把试用改过去
    patchLocalUser(store, USER, { trialUntil: Date.now() + 2 * DAY });
    patchRegistryUser(USER, { trialUntil: Date.now() + 2 * DAY, payMembershipUntil: 0 });
    const lg4 = await Auth.login(USER, 'abc12345');
    check('试用改未来 → 可登录', lg4.ok === true, JSON.stringify(lg4.error || 'ok'));
    patchLocalUser(store, USER, { trialUntil: Date.now() - 1000 });
    patchRegistryUser(USER, { trialUntil: Date.now() - 1000 });
    const r = await Auth.recheckAccess();
    check('试用在会话存续期间到期 → recheckAccess 踢', r.ok === false, JSON.stringify(r));
    check('会话已清', Auth.session === null, '');
  }

  /* ========== T5 管理员永远放行 ========== */
  console.log('\n[T5] 管理员 → 永远放行（无过期概念）');
  {
    const lg5 = await Auth.login('admin', 'Admin@2026');
    check('管理员登录成功', lg5.ok === true, JSON.stringify(lg5.error || 'ok'));
    const r = await Auth.recheckAccess();
    check('管理员 recheckAccess ok', r.ok === true, JSON.stringify(r));
  }

  /* ========== T6 停用账号 → 踢 ========== */
  console.log('\n[T6] 被停用账号 → 踢');
  {
    patchLocalUser(store, USER, { trialUntil: Date.now() + DAY, payMembershipUntil: 0, quotaMonths: 0 });
    patchRegistryUser(USER, { trialUntil: Date.now() + DAY, payMembershipUntil: 0 });
    const lg6 = await Auth.login(USER, 'abc12345');
    check('试用中可登录（前置）', lg6.ok === true, JSON.stringify(lg6.error || 'ok'));
    patchLocalUser(store, USER, { disabled: true });
    const r = await Auth.recheckAccess();
    check('停用 → recheckAccess 踢', r.ok === false && /停用/.test(r.error || ''), JSON.stringify(r));
  }

  /* ========== T7 app.js / auth-boot.js 接线静态断言 ========== */
  console.log('\n[T7] app.js / auth-boot.js 接线（静态断言）');
  {
    const src = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('auth:ready 里启动定时复查', /authUser\.value = \(A && A\.user\) \? A\.user : null;\s*\n\s*startAccessRecheck\(\);/.test(src));
    check('仅普通用户起定时器（管理员/游客跳过）', /function startAccessRecheck\(\) \{[\s\S]{0,240}authUser\.value\.role === 'admin'/.test(src));
    check('60 秒周期', /_accessRecheckTimer = setInterval\(async \(\) => \{[\s\S]{0,900}?await A\.recheckAccess\(\)[\s\S]{0,600}?\}, 60000\)/.test(src));
    check('失效即 toast + 刷新回登录页', /r\.ok === false[\s\S]{0,400}location\.reload\(\)/.test(src));
    check('recheckAccess 在 auth.js 中定义', /recheckAccess: function \(\)/.test(fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8')));
    // 20261016f：登录页「会员服务（开通/续费）」自助通道（过期用户被拦在登录外时的重新支付入口）
    check('登录页有会员服务入口按钮', /id="auth-to-renew"/.test(html) && /id="auth-renew"/.test(html));
    check('auth-boot 实现了续费面板逻辑', /function renewSubmitClaim/.test(boot) && /function renewCreateOrder/.test(boot) && /function bindRenewPanel/.test(boot));
    // 20261018b 回归：登录页「会员服务」必须直接显示静态收款码，不依赖未配置的商户接口（否则 503 无码）
    check('登录页续费收款码为静态微信码（不依赖后端下单）', /id="auth-renew-wx" src="assets\/wechat-pay-qr\.jpg"/.test(html));
    check('登录页续费二维码容器默认可见（非 hidden）', /id="auth-renew-qr"[^>]*>/.test(html) && !/id="auth-renew-qr"[^>]*\shidden/.test(html));
    check('auth-boot 定义了静态收款码常量并接线', /var RENEW_WX_QR = 'assets\/wechat-pay-qr\.jpg';/.test(boot) && /if \(elRenewWx\) elRenewWx\.src = RENEW_WX_QR;/.test(boot) && /if \(elRenewQr\) elRenewQr\.hidden = false;/.test(boot));
    check('bind() 里接线会员面板', /function bind\(\) \{\s*bindRenewPanel\(\);/.test(boot));
    check('门禁被拦时给出去会员服务的指引', /auth-guide-renew/.test(boot) && /试用已结束\|暂无有效\|无法使用\|已被停用/.test(boot));
    check('续费申请字段与主界面 submitPaymentClaim 同口径', /id: 'clm_' \+ startTs/.test(boot) && /user: uname/.test(boot) && /period: plan\.label/.test(boot));
    check('续费提交优先走后端 /pay/claim，回落 GitHub 写 claims', /\/pay\/claim/.test(boot) && /Auth\.Sync\.writeClaims/.test(boot));
  }

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
