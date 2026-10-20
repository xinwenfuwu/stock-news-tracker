/* ============================================================
 * test-membership-login-window.mjs — 「会员有效期内始终可登录、过期即拒」+ 自愈补传云端 专项回归（20261020）
 *
 * 用户要求：只要 hy123 在到期时间内（2027-04-16 之前）都能登录；过期后必须无法登录。
 * 另：线上实测「登录成功但云端仍空白占位」——自愈因直写失败未回落 Worker，需验证修复后 Worker 兜底生效。
 *
 * 覆盖：
 *   场景1 云端已含凭证 + 会员有效（now+180d）→ 全新设备（本机无账号）用密码登录成功（跨设备+有效期内）
 *   场景2 会员「刚好在有效期内（到期前 1 小时）」→ 仍可登录（近边界仍有效）
 *   场景3 边界：会员当天到期（pmu=now，即 2027-04-16 当天）→ 仍可登录（到期日当天不视为过期，天粒度过期）
 *   场景4 会员已过期（到期 -2 天）→ 登录被拒，且提示与会员/试用相关
 *   场景5 自愈健壮性：管理员设备令牌在但直写失败 → 回落 Worker 兜底，云端被补全 hash/pwSeal
 *   场景6 静态接线：_syncAccountToCloud 在任何直写失败都回落 Worker
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

const ghFiles = new Map();
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function regOf() { return JSON.parse(ghFiles.get('data/accounts/registry.json').content); }
function setRegistryAccounts(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}
/** 模拟 Worker（持 GH_PAT）把账号写进云端注册表：合并 hash/pwSeal，清占位标记 */
function mockWorkerWrite(body) {
  const uname = String(body && body.username || '');
  if (!uname) return;
  const reg = ghFiles.get('data/accounts/registry.json');
  const accs = reg && reg.accounts ? reg.accounts : {};
  const prev = accs[uname] || {};
  accs[uname] = Object.assign({}, prev, {
    hash: typeof body.hash === 'string' ? body.hash : (prev.hash || ''),
    pwSeal: (body.pwSeal !== undefined ? body.pwSeal : prev.pwSeal) || '',
    placeholder: false,
    role: prev.role || 'user',
    status: prev.status || 'active',
    payMembershipUntil: Number(body.payMembershipUntil) || Number(prev.payMembershipUntil) || 0,
    updatedAt: Date.now(),
  });
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts: accs }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}

setRegistryAccounts({});

function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
}

async function loadAuthForDevice(storage, { withToken = false, forceWriteFail = false } = {}) {
  const sandbox = {
    localStorage: storage, sessionStorage: makeStorage(),
    location: { hostname: 'xinwenfuwu.github.io', href: 'https://xinwenfuwu.github.io/stock-news-tracker/index.html' },
    navigator: { userAgent: 'Mozilla/5.0 (ReproNode)' },
    fetch: async (url, opt = {}) => {
      const u = String(url);
      // —— 模拟 Worker 写入通道（/auth/register、/auth/admin-reset）——
      if (/^https?:\/\//.test(u) && (u.includes('/auth/register') || u.includes('/auth/admin-reset'))) {
        try { mockWorkerWrite(JSON.parse(opt.body || '{}')); } catch (e) { /* ignore */ }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
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
          if (forceWriteFail) return { ok: false, status: 403, json: async () => ({ message: 'Resource access blocked (simulated)' }) };
          const body = JSON.parse(opt.body);
          const content = Buffer.from(body.content, 'base64').toString('utf8');
          ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 10) });
          return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
        }
      }
      // 其它外部请求（如 stock-edge 兜底通道在本测试未模拟）→ 视为不可用，交给 fetchFirstAvailable 试下一个
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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
async function seedHealedCloud(pmu) {
  const store = makeStorage();
  const A = await loadAuthForDevice(store, { withToken: true });
  await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
  const ar = await A.Auth.addUser('hy123', 'qq123456', { role: 'user' });
  if (ar && ar.sync) { try { await ar.sync; } catch (e) {} }
  const src = JSON.parse(store.getItem('snt-auth-users-v1') || '[]');
  const rec = src.find(x => x.username === 'hy123');
  setRegistryAccounts({ hy123: {
    hash: rec.hash, pwSeal: rec.pwSeal, placeholder: false, role: 'user', status: 'active', disabled: false,
    payMembershipUntil: pmu, paidAt: pmu - 180 * DAY, paidPlan: '6m', paidAmount: 1000,
    quotaMonths: 6, trialUntil: 0, trialDays: 0, registerDate: '2026-10-18', createdAt: 1, updatedAt: 1,
  } });
  return rec.hash;
}

function loginFailCheck(name, lg) {
  check(name + '：登录被拒（ok=false）', lg.ok === false, JSON.stringify(lg.ok));
  check(name + '：回执含会员/试用相关提示',
    /到期|过期|已失效|会员|试用|无法使用/.test(String(lg.error || '')), lg.error);
}

(async () => {
  /* 场景1：云端含凭证 + 会员有效 → 全新设备登录成功（跨设备） */
  console.log('\n[场景1] 云端已含凭证 + 会员有效（约 6 个月后到期）→ 全新设备登录成功');
  {
    const now = Date.now();
    await seedHealedCloud(now + 180 * DAY);
    const B = await loadAuthForDevice(makeStorage(), {});
    const lg = await B.Auth.login('hy123', 'qq123456');
    check('全新设备登录成功（本机原本无 hy123）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('落地带会员到期时间', lg.ok && Number(lg.user && lg.user.payMembershipUntil) > now, JSON.stringify(lg.user && lg.user.payMembershipUntil));
  }

  /* 场景2：到期前 1 小时（仍在有效期内）→ 仍可登录 */
  console.log('\n[场景2] 会员「到期前 1 小时」仍在有效期内 → 可登录');
  {
    const now = Date.now();
    await seedHealedCloud(now + HOUR);
    const B = await loadAuthForDevice(makeStorage(), {});
    const lg = await B.Auth.login('hy123', 'qq123456');
    check('到期前 1 小时仍可登录', lg.ok === true, JSON.stringify(lg.error || 'ok'));
  }

  /* 场景3：边界——会员当天到期（pmu=now，即 2027-04-16 当天）→ 仍可登录（天粒度过期：到期日当天不视为过期） */
  console.log('\n[场景3] 会员当天到期（到期日当天）→ 仍可登录');
  {
    const now = Date.now();
    await seedHealedCloud(now);
    const B = await loadAuthForDevice(makeStorage(), {});
    const lg = await B.Auth.login('hy123', 'qq123456');
    check('到期日当天仍可登录（天粒度）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
  }

  /* 场景4：已过期（到期时间已过 2 天）→ 拒绝 */
  console.log('\n[场景4] 会员已过期（到期 -2 天）→ 登录被拒');
  {
    const now = Date.now();
    await seedHealedCloud(now - 2 * DAY);
    const B = await loadAuthForDevice(makeStorage(), {});
    const lg = await B.Auth.login('hy123', 'qq123456');
    loginFailCheck('过期后', lg);
  }

  /* 场景5：自愈健壮性——令牌在但直写失败 → Worker 兜底补全云端 */
  console.log('\n[场景5] 直写失败 → 回落 Worker 兜底，云端被补全');
  {
    const now = Date.now();
    setRegistryAccounts({ hy123: {
      hash: '', pwSeal: '', placeholder: true, role: 'user', status: 'active', disabled: false,
      payMembershipUntil: now + 180 * DAY, paidPlan: '6m', quotaMonths: 6, createdAt: 1, updatedAt: 1,
    } });
    // 管理员设备：有令牌但直写强制失败（模拟令牌无 contents:write 权限）
    const A = await loadAuthForDevice(makeStorage(), { withToken: true, forceWriteFail: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const ar = await A.Auth.addUser('hy123', 'qq123456', { role: 'user' });
    if (ar && ar.sync) { try { await ar.sync; } catch (e) {} }
    // addUser 只走 _syncUserToRegistry（直写），直写失败时不会回落 Worker —— 云端此时仍是空白占位
    const beforeC = regOf().accounts['hy123'];
    check('addUser 后云端仍是空白占位（仅直写失败、尚未自愈）', !!beforeC && !beforeC.hash, JSON.stringify({ hash: String((beforeC || {}).hash || '').slice(0, 8), placeholder: (beforeC || {}).placeholder }));
    const lg = await A.Auth.login('hy123', 'qq123456');
    check('本机有密码 → 登录成功（nocred 不再短路）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    // 登录内 self-heal 是 fire-and-forget，此处显式触发并 await 一次，确保云端被补全（模拟「再次保存/再次登录」落云）
    const srcUsers = JSON.parse(A.sandbox.localStorage.getItem('snt-auth-users-v1') || '[]');
    const fu = srcUsers.find(x => x.username === 'hy123');
    if (fu) { const r = await A.Auth._syncAccountToCloud(fu); void r; }
    const c = regOf().accounts['hy123'];
    check('云端被自愈补全（hash + pwSeal 非空）',
      !!c && /^pbkdf2\$/.test(String(c.hash || '')) && !!c.pwSeal,
      JSON.stringify({ hash: String((c || {}).hash || '').slice(0, 12), pwSeal: !!(c || {}).pwSeal }));
    check('占位标记已清除（placeholder=false）', !!c && c.placeholder === false, JSON.stringify((c || {}).placeholder));
  }

  /* 场景6：静态接线 */
  console.log('\n[场景6] 静态接线：自愈在任何直写失败都回落 Worker');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    check('auth.js 直写失败也回落 registerRemoteViaWorker', /registerRemoteViaWorker\(u\)/.test(auth));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})();
