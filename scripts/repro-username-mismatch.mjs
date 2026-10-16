/* ============================================================
 * repro-username-mismatch.mjs — 复现并验证「普通用户注册后，管理员用户管理里用户名一致」
 * （20261016d 修复版验证）
 *
 * 场景1（管理员本机注册 → 任何设备可见）：
 *   设备A（管理员，带令牌）注册「测试用户甲」→ 云端注册表应立即有该账号（active+试用）
 *   设备B（另一台管理员设备）recoverFromRegistry → 以相同用户名恢复该账号
 *   设备B grantMembership → 成功（修复前：用户不存在）
 *
 * 场景2（跨设备用户 + 支付申请 → 核对并开通自动恢复）：
 *   设备U（普通用户手机，无令牌）注册「跨设备用户乙」→ 仅本机
 *   设备U 提交支付申请（Worker 写 claims.json）
 *   设备A（管理员）grantMemberClaim 逻辑：
 *     直接开通 → 用户不存在 → recoverFromRegistry → 重试 → 仍不存在 → 给出清晰指引
 *
 * 场景3（删除用户 → 云端同步删除，不会复活）：
 *   设备A removeUser → 注册表条目被删；设备B recoverFromRegistry 不再恢复它
 *
 * 场景4（登录回落）：
 *   注册表里有该用户但哈希是别的密码 → loginRemote 不再硬报错，回落本机校验成功
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
const regAccounts = () => Object.keys(JSON.parse(ghFiles.get('data/accounts/registry.json').content).accounts);

(async () => {
  const USER_NAME = '测试用户甲';
  const USER_PW = 'abc12345';

  /* ========== 场景1：管理员本机注册 → 云端 → 另一设备以相同用户名恢复并开通 ========== */
  console.log('\n[场景1] 管理员本机注册 → 云端注册表 → 另一台设备相同用户名恢复 + 开通');
  const aStore = makeStorage();
  const A = await loadAuthForDevice(aStore, { withToken: true });
  const AuthA = A.Auth;
  await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
  const reg = await AuthA.register(USER_NAME, USER_PW);
  check('管理员本机注册成功', reg.ok === true && reg.user && reg.user.username === USER_NAME, JSON.stringify(reg.user));
  await new Promise(r => setTimeout(r, 300)); // 等 fire-and-forget 的注册表写入落地
  check('注册表立即包含该用户（修复前：不写云端）', regAccounts().indexOf(USER_NAME) >= 0, JSON.stringify(regAccounts()));
  const regRec = JSON.parse(ghFiles.get('data/accounts/registry.json').content).accounts[USER_NAME] || {};
  check('注册表条目状态为 active（试用中可登录）', regRec.status === 'active' && regRec.trialUntil > Date.now(), JSON.stringify({ s: regRec.status, t: regRec.trialUntil }));

  // 设备B：另一台管理员设备（无本地账号）
  const bStore = makeStorage();
  const B = await loadAuthForDevice(bStore, { withToken: true });
  const AuthB = B.Auth;
  await AuthB.setup('admin', 'Admin@2026', 'Admin@2026');
  const rec = await AuthB.recoverFromRegistry();
  const names = AuthB.listUsersDetail().map(u => u.username);
  check('设备B 从云端恢复到该用户', names.indexOf(USER_NAME) >= 0, JSON.stringify(names));
  const recU = AuthB.listUsersDetail().find(u => u.username === USER_NAME);
  check('恢复后的用户名与注册时完全一致', !!recU && recU.username === USER_NAME, JSON.stringify(recU && recU.username));
  const g = AuthB.grantMembership(USER_NAME, 6, { paidAt: Date.now(), amount: 1000 });
  check('设备B 可直接开通会员（修复前：用户不存在）', g.ok === true, JSON.stringify(g));

  /* ========== 场景2：跨设备用户 + 支付申请 → 核对并开通（自动恢复/清晰指引） ========== */
  console.log('\n[场景2] 跨设备用户提交支付申请 → 管理员核对并开通');
  const uStore = makeStorage();
  const U = await loadAuthForDevice(uStore, { withToken: false });
  const AuthU = U.Auth;
  await AuthU.setup('admin', 'Admin@2026', 'Admin@2026'); // 用户设备先起个管理员占位（模拟已初始化站点）
  const regU = await AuthU.register('跨设备用户乙', 'xyz12345');
  check('用户设备注册成功（无令牌，不写云端）', regU.ok === true && regAccounts().indexOf('跨设备用户乙') < 0, JSON.stringify(regAccounts()));
  // 用户提交支付申请（Worker 逻辑：写 claims.json）
  {
    const f = ghFiles.get('data/membership/claims.json');
    const j = JSON.parse(f.content);
    j.claims.push({ id: 'clm_1', user: '跨设备用户乙', plan: '6m', ts: Date.now(), amount: 1000, resolved: false });
    ghFiles.set('data/membership/claims.json', { content: JSON.stringify(j, null, 2), sha: 'x' });
  }
  // 设备C：第三台管理员设备（本地没有任何用户）
  const cStore = makeStorage();
  const C = await loadAuthForDevice(cStore, { withToken: true });
  const AuthC = C.Auth;
  await AuthC.setup('admin', 'Admin@2026', 'Admin@2026');
  // 复刻 grantMemberClaim 的新逻辑
  let r = AuthC.grantMembership('跨设备用户乙', 6, { paidAt: Date.now(), amount: 1000 });
  check('直接开通报「用户不存在」（预期行为）', !r.ok && r.error === '用户不存在', JSON.stringify(r));
  let recovered = false;
  if ((!r || !r.ok) && r && r.error === '用户不存在') {
    const rec2 = await AuthC.recoverFromRegistry();
    recovered = !!(rec2 && rec2.ok && rec2.recovered > 0);
    if (recovered) r = AuthC.grantMembership('跨设备用户乙', 6, { paidAt: Date.now(), amount: 1000 });
  }
  const cNames = AuthC.listUsersDetail().map(u => u.username);
  check('自动恢复后目标用户仍不在本机（预期：该用户从未写云端）', cNames.indexOf('跨设备用户乙') < 0, JSON.stringify(cNames));
  check('仍报「用户不存在」→ 由调用方转为清晰指引（不静默失败）', !r.ok && r.error === '用户不存在', JSON.stringify(r));

  /* ========== 场景3：删除用户 → 云端同步删除，不会复活 ========== */
  console.log('\n[场景3] 删除用户 → 云端注册表同步删除');
  check('删除前注册表含有该用户', regAccounts().indexOf(USER_NAME) >= 0);
  const del = AuthA.removeUser(USER_NAME);
  check('removeUser 返回 sync Promise', !!del.sync && typeof del.sync.then === 'function');
  const delRes = await del.sync;
  check('云端删除成功', delRes.ok === true, JSON.stringify(delRes));
  check('注册表已不含该用户', regAccounts().indexOf(USER_NAME) < 0, JSON.stringify(regAccounts()));
  const rec3 = await AuthB.recoverFromRegistry();
  const namesAfter = AuthB.listUsersDetail().map(u => u.username);
  check('其他设备恢复时该用户不会复活（本地已有的不受影响）', namesAfter.indexOf(USER_NAME) >= 0, '本机已有则保留：' + JSON.stringify(namesAfter));
  // 全新设备再恢复 → 不应该出现
  const dStore = makeStorage();
  const D = await loadAuthForDevice(dStore, { withToken: true });
  const AuthD = D.Auth;
  await AuthD.setup('admin', 'Admin@2026', 'Admin@2026');
  await AuthD.recoverFromRegistry();
  check('全新设备恢复时已删除用户不出现', AuthD.listUsersDetail().map(u => u.username).indexOf(USER_NAME) < 0, JSON.stringify(AuthD.listUsersDetail().map(u => u.username)));

  /* ========== 场景4：注册表哈希不符 → 登录回落本机（不锁死用户） ========== */
  console.log('\n[场景4] 注册表旧哈希 → 登录回落本机校验');
  // 注册表现有 '跨设备用户乙' 的哈希与用户本机密码无关（模拟管理员手动添加过）
  {
    const f = ghFiles.get('data/accounts/registry.json');
    const j = JSON.parse(f.content);
    j.accounts['跨设备用户乙'] = { hash: 'pbkdf2$150000$AAAAAAAAAAAAAAAA$BBBB', role: 'user', status: 'active', createdAt: Date.now(), updatedAt: Date.now() };
    ghFiles.set('data/accounts/registry.json', { content: JSON.stringify(j, null, 2), sha: 'x' });
  }
  const loginU = await AuthU.login('跨设备用户乙', 'xyz12345', true);
  check('用户用本机正确密码仍可登录（修复前：被注册表旧哈希锁死）', loginU.ok === true, JSON.stringify(loginU));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('REPRO ERROR', e); process.exit(1); });
