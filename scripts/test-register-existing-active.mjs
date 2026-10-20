/* ============================================================
 * test-register-existing-active.mjs — 验证「已注册账号再次提交注册申请」
 *
 * 需求（用户 2026-10-20）：注册 → 1 天试用 → 归「授权使用 → 试用非会员」；
 * 试用到期且未付费 → 系统自动归「未开通使用」。已注册账号再次点「注册申请」
 * 时不应再报「用户名已被使用」，而应识别为已有账号、返回其试用信息并重新同步云端。
 *
 * 场景1：全新用户注册（1 天试用）→ 同一设备同账号再次注册 → 返回 alreadyRegistered、
 *         trialActive=true、isMember=false（即归入「试用非会员」），且云端被重新同步。
 * 场景2：已注册但试用已结束、未付费的账号 → 再次注册 → alreadyRegistered=true、
 *         trialActive=false、isMember=false（即归入「未开通使用」）。
 * 场景3：已注册账号 + 错误密码再次注册 → 仍报「用户名已被使用」（不泄露账号存在）。
 * 场景4：静态断言 register() 已移除早期 ACTIVE 硬拒绝、改为识别分支。
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

/* ---------- mock GitHub 仓库（内存） + mock pay Worker /auth/register ---------- */
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
  if (exist && body.selfSet === true && exist.hash) {
    // 20261020c：本人设定密码 → 普通账号放行覆盖（与真实 Worker 同口径）
    if (exist.role === 'admin') return { status: 409, body: { ok: false, error: '管理员账号不能通过注册接口设置密码' } };
    exist.hash = hash;
    if (body.pwSeal) exist.pwSeal = body.pwSeal;
    exist.placeholder = false; exist.status = 'active';
    exist.payMembershipUntil = Math.max(Number(exist.payMembershipUntil) || 0, Number(body.payMembershipUntil) || 0);
    exist.updatedAt = now;
    setRegistryAccounts(reg.accounts);
    return { status: 200, body: { ok: true, updated: true, passwordSet: true } };
  }
  if (exist) {
    const sameHash = exist.hash === hash;
    const paid = (Number(exist.payMembershipUntil) || 0) > now || (Number(exist.quotaMonths) || 0) > 0;
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  const trialUntil = Number(body.trialUntil) || 0;
  reg.accounts[username] = {
    hash, role: 'user', status: 'active', disabled: false,
    trialUntil, trialDays: Number(body.trialDays) || (trialUntil ? 1 : 0),
    quotaMonths: Number(body.quotaMonths) || 0, disableDate: '', registerDate: '',
    payMembershipUntil: Number(body.payMembershipUntil) || 0, paidAt: 0, paidPlan: '', paidAmount: 0,
    createdAt: Number(body.createdAt) || now, updatedAt: now,
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
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

/* 复刻管理员「授权使用 → 试用非会员」板块的归类口径（app.js trialUsersList / registeredNoMemberList） */
function classify(u) {
  if (!u || u.role !== 'user') return 'admin-or-other';
  if (Number(u.payMembershipUntil) > Date.now()) return 'paid';
  if (u.trialActive) return 'trial';        // 试用非会员
  if (u.status === 'pending') return 'pending';
  return 'none';                            // 未开通使用
}

(async () => {
  /* ===== 场景1：全新注册(1天试用) → 同设备再次注册 → 归入试用非会员 ===== */
  console.log('\n[场景1] 注册(1天试用) → 同设备再次注册 → 归「试用非会员」并重新同步云端');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const store = makeStorage();
    const D = await loadAuthForDevice(store, { withToken: false, withWorker: true });
    const reg1 = await D.Auth.register('ming', 'Ming@123456');
    check('首次注册成功（autoTrial + 1天试用）', reg1.ok === true && reg1.autoTrial === true, JSON.stringify(reg1.error || 'ok'));
    await tick();

    const reg2 = await D.Auth.register('ming', 'Ming@123456');   // 同设备再点「注册申请」
    check('再次注册不报「用户名已被使用」', reg2.ok === true, JSON.stringify(reg2.error || 'ok'));
    check('返回 alreadyRegistered=true', reg2.alreadyRegistered === true, JSON.stringify(reg2));
    check('仍是试用中（trialActive=true）', reg2.trialActive === true, 'trialActive=' + reg2.trialActive);
    check('非付费会员（isMember=false）', reg2.isMember === false, 'isMember=' + reg2.isMember);
    check('归入「试用非会员」板块', classify(reg2.user) === 'trial', 'classify=' + classify(reg2.user));
    await tick();
    check('再次注册重新同步了云端（Worker 代写）', workerCalls.some(c => c.username === 'ming'), JSON.stringify(workerCalls.map(c => c.username)));
    // 管理员视角：本机列表里 ming 应处于试用、归入试用非会员
    const detail = D.Auth.listUsersDetail().find(u => u.username === 'ming');
    check('本机列表 ming 为试用非会员口径', !!detail && classify(detail) === 'trial', classify(detail));
  }

  /* ===== 场景2：已注册但试用已结束、未付费 → 再次注册 → 归「未开通使用」 ===== */
  console.log('\n[场景2] 试用已结束且未付费 → 再次注册 → 归「未开通使用」');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const store = makeStorage();
    const D = await loadAuthForDevice(store, { withToken: false, withWorker: true });
    const reg1 = await D.Auth.register('expired', 'Exp@123456');
    check('首次注册成功', reg1.ok === true, JSON.stringify(reg1.error || 'ok'));
    await tick();
    // 把本机账号的 trialUntil 拨到过去，模拟「试用已结束、未开通会员」
    const users = D.Auth.listUsers ? D.Auth.listUsers() : null;
    const all = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
    const me = all.find(u => u.username === 'expired');
    me.trialUntil = Date.now() - 24 * 60 * 60 * 1000;
    me.trialDays = 1;
    store.setItem('snt-auth-users-v1', JSON.stringify(all));
    const reg2 = await D.Auth.register('expired', 'Exp@123456');
    check('再次注册成功', reg2.ok === true, JSON.stringify(reg2.error || 'ok'));
    check('返回 alreadyRegistered=true', reg2.alreadyRegistered === true, JSON.stringify(reg2));
    check('试用已结束（trialActive=false）', reg2.trialActive === false, 'trialActive=' + reg2.trialActive);
    check('非付费会员', reg2.isMember === false, 'isMember=' + reg2.isMember);
    check('归入「未开通使用」板块', classify(reg2.user) === 'none', 'classify=' + classify(reg2.user));
  }

  /* ===== 场景3：已注册账号 + 新密码 → 密码更新为本次输入，可直接登录（20261020c） ===== */
  console.log('\n[场景3] 已注册账号 + 新密码再次注册 → 密码更新为本次输入并可登录');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    const store = makeStorage();
    const D = await loadAuthForDevice(store, { withToken: false, withWorker: true });
    await D.Auth.register('secure', 'Right@123456');   // 首次注册
    await tick();
    const reg = await D.Auth.register('secure', 'Brand@000000');   // 用新密码再次注册
    await tick();
    check('新密码再次注册 → 成功（不再报「用户名已被使用」）', reg.ok === true, JSON.stringify(reg.error || 'ok'));
    check('新密码再次注册 → 标记 passwordUpdated', reg.passwordUpdated === true, JSON.stringify(reg));
    check('新密码再次注册 → 重新同步了云端', workerCalls.some(c => c.username === 'secure' && c.selfSet === true), JSON.stringify(workerCalls.map(c => ({ u: c.username, s: c.selfSet }))));
    const lgNew = await D.Auth.login('secure', 'Brand@000000');
    check('用新密码登录成功', lgNew.ok === true, JSON.stringify(lgNew.error));
    const lgOld = await D.Auth.login('secure', 'Right@123456');
    check('旧密码不再可用', lgOld.ok === false, JSON.stringify(lgOld));
  }

  /* ===== 场景4：静态断言 register() 接线 ===== */
  console.log('\n[场景4] 静态断言：register() 统一为「注册即设定密码」');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    check('auth.js 已无「该用户名已被使用」硬拒绝', auth.indexOf("'该用户名已被使用，请换一个'") === -1);
    check('auth.js register 以本次密码重建凭证（hash + pwSeal）',
      /u\.hash = hash;/.test(auth) && /u\.pwSeal = sealPassword\(v\.password\)/.test(auth));
    check('auth.js register 重新同步云端（_syncAccountToCloud）并等待',
      /cloudSync = self\._syncAccountToCloud\(u\)/.test(auth));
    const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
    check('auth-boot.js 处理 alreadyRegistered（跳登录+提示）',
      /if \(r\.alreadyRegistered\)/.test(boot));
  }

  console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail === 0 ? 0 : 1);
})();
