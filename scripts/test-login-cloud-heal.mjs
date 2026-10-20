/* ============================================================
 * test-login-cloud-heal.mjs — 「管理员设备有密码、云端空占位，却登不上」专项回归（20261020）
 *
 * 用户实况（截图）：管理员面板显示 hy123 密码 qq123456、会员 6 月期到 2027-04-16，
 * 但登录 hy123/qq123456 报「该账号会员已开通…但云端缺少登录密码」。
 *
 * 根因：`Auth.login` 里 `if (r && r.error) return {ok:false,error}` 位于 `_localLogin` 回退之前。
 * loginRemote 对「云端缺凭证」返回 { status:'nocred', error:'…云端缺少登录密码…' }，带 error →
 * 直接短路，永不回退本机校验。于是「本机明明有正确密码」的管理员设备也登不上，且云端永远拿不到补传。
 *
 * 修复：nocred 不再短路 → 回落本机校验；本机通过则放行，并把本机 hash/pwSeal 补传云端（自愈）。
 * 本机也没有密码时才显示「缺少登录密码」。此外「保存」前重拉云端快照，杜绝陈旧快照误判「与云端一致」。
 *
 * 覆盖：
 *   场景A 管理员设备：本机有密码 + 云端空占位 → 登录成功，且云端被自动补全 hash/pwSeal
 *   场景B 另换新设备（本机无账号）→ 用同一密码登录成功（云端已自愈）
 *   场景C 本机也没有密码 + 云端空占位 → 仍拒绝并明确「缺少登录密码」（安全不降级）
 *   场景D 静态接线：auth.js 不再对 nocred 短路；app.js 保存前重拉云端快照
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
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}
setRegistryAccounts({});

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); },
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
        const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
        const p = mm ? decodeURIComponent(mm[1]) : '';
        if (m === 'GET') {
          const f = ghFiles.get(p);
          if (!f) return { ok: false, status: 404, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
        }
        if (m === 'PUT') {
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

async function waitFor(pred, ms = 1200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)); }
  return pred();
}

const FUTURE = Date.now() + 180 * 24 * 3600 * 1000;   // ≈ 6 个月后
function emptyPlaceholder() {
  return { hy123: {
    hash: '', pwSeal: '', placeholder: true, role: 'user', status: 'active', disabled: false,
    payMembershipUntil: FUTURE, paidAt: Date.now() - 1000, paidPlan: '6m', paidAmount: 1000,
    quotaMonths: 6, trialUntil: 0, trialDays: 0, registerDate: '2026-10-18', createdAt: 1, updatedAt: 1,
  } };
}

(async () => {
  /* ===== 场景A：管理员设备本机有密码 + 云端空占位 → 登录成功，并自愈补传云端 ===== */
  console.log('\n[场景A] 本机有密码 + 云端空占位 → 登录成功，且云端被自动补全');
  {
    setRegistryAccounts(emptyPlaceholder());
    const store = makeStorage();
    const A = await loadAuthForDevice(store, { withToken: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const ar = await A.Auth.addUser('hy123', 'qq123456', { role: 'user' });
    check('管理员设备本机为 hy123 设好密码', ar.ok === true, JSON.stringify(ar.error || 'ok'));
    if (ar && ar.sync) { try { await ar.sync; } catch (e) { /* ignore */ } }
    // 模拟线上事故态：无论 addUser 是否顺手同步过，强制把云端还原成「空占位」
    setRegistryAccounts(emptyPlaceholder());
    check('前置：云端 hy123 确为空占位（无 hash/pwSeal）',
      !regOf().accounts.hy123.hash && !regOf().accounts.hy123.pwSeal);

    const lg = await A.Auth.login('hy123', 'qq123456');
    check('管理员设备用本机密码登录成功（此前会被 nocred 短路）', lg.ok === true, JSON.stringify(lg.error || 'ok'));

    const healed = await waitFor(() => {
      const c = regOf().accounts.hy123;
      return !!c && /^pbkdf2\$/.test(String(c.hash || '')) && !!c.pwSeal;
    });
    check('登录后云端被自愈补全（hash=pbkdf2… 且 pwSeal 非空）', healed,
      JSON.stringify({ hash: String((regOf().accounts.hy123 || {}).hash || '').slice(0, 12), pwSeal: !!(regOf().accounts.hy123 || {}).pwSeal }));

    /* ===== 场景B：另换新设备（本机无该账号）→ 用同一密码登录成功 ===== */
    console.log('\n[场景B] 云端已自愈 → 全新设备用同一密码登录成功');
    const B = await loadAuthForDevice(makeStorage(), {});
    const lgB = await B.Auth.login('hy123', 'qq123456');
    check('全新设备登录成功', lgB.ok === true, JSON.stringify(lgB.error || 'ok'));
    check('带会员到期时间落地', lgB.ok && Number(lgB.user && lgB.user.payMembershipUntil) === FUTURE,
      JSON.stringify(lgB.user && lgB.user.payMembershipUntil));
  }

  /* ===== 场景C：本机也没有密码 + 云端空占位 → 仍拒绝，明确「缺少登录密码」 ===== */
  console.log('\n[场景C] 本机无密码 + 云端空占位 → 仍拒绝，明确「缺少登录密码」（安全不降级）');
  {
    setRegistryAccounts(emptyPlaceholder());
    const C = await loadAuthForDevice(makeStorage(), {});
    const lg = await C.Auth.login('hy123', 'qq123456');
    check('登录仍失败（无任何凭证不得放行）', lg.ok === false, JSON.stringify(lg.ok));
    check('回执说明「缺少登录密码」', /缺少登录密码/.test(String(lg.error || '')), lg.error);
    check('回执指引「重置密码」', /重置密码/.test(String(lg.error || '')), lg.error);
    check('不再是笼统「用户名或密码不正确」', !/^用户名或密码不正确$/.test(String(lg.error || '')), lg.error);
  }

  /* ===== 场景D：静态接线 ===== */
  console.log('\n[场景D] 静态接线：登录不回退被 nocred 短路 / 保存前重拉快照');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    check('auth.js 仅对非 nocred 的错误短路', /r\.error && r\.status !== 'nocred'/.test(auth));
    check('auth.js 登录成功时对 notFound/nocred 都补传云端', /r\.notFound \|\| r\.status === 'nocred'/.test(auth));
    check('app.js 保存前重拉云端快照', /saveApprovedZoneChanges[\s\S]{0,400}await loadCloudRegistrySnapshot\(\)/.test(app));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})();
