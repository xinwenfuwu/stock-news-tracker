/* ============================================================
 * test-register-cloud-sync.mjs — 验证「注册用户必现审核通过区」（20261016k）
 *
 * 背景（用户需求）：所有注册的用户，注册申请以后，账户信息必须出现在
 * 管理员用户管理-待审核用户-审核通过区中。
 *
 * 根因：普通用户在自己设备（无 GitHub 令牌）注册只写本机 localStorage，
 * 从不进云端注册表 → 管理员在任意设备都看不到该账号。
 * 修复：注册时经 pay Worker /auth/register 代写云端注册表（Worker 持 GH_PAT）；
 * 管理员打开用户管理 / 点「待审核注册申请 → ↻ 刷新」时 recoverFromRegistry
 * （只读合并）把该账号并入本机列表，出现在「审核通过区」（status !== 'pending'）。
 *
 * 场景1（核心需求完整复现）：
 *   设备B（普通用户、无令牌）注册 xiaoming → Worker 代写云端注册表
 *   → 设备A（管理员、令牌）recoverFromRegistry → xiaoming 出现在审核通过区
 *   → 设备C（全新设备）用账号密码直接登录成功（免准入码）
 * 场景2（登录自愈）：注册时云端写失败（离线）→ 下次登录成功 → 自动补写云端
 * 场景3（哈希不符不补写）：云端已有同名但哈希不同 → 登录成功但不覆盖云端
 * 场景4（静态断言）：auth.js / auth-sync.js / app.js / index.html 接线
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

const workerCalls = [];   // 记录打到 /auth/register 的请求（断言客户端接线）

/** mock 的 Worker 端点：契约与 cloudflare-worker-prod/worker.js authRegister 一致 */
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
    // 与 cloudflare-worker-prod/worker.js authRegister 一致：同哈希（本人/管理员同步）允许覆盖更新；
    // 异哈希 + 管理员/付费/已激活 → 409 拒绝抢名。否则「管理员开通」拿不到 200，云端的会员永远写不上。
    if (!sameHash && (exist.role === 'admin' || paid || (exist.status || 'pending') === 'active')) {
      return { status: 409, body: { ok: false, error: '该用户名已被使用，请更换一个' } };
    }
  }
  const trialUntil = Number(body.trialUntil) || 0;
  // 忠实复制会员字段（与 cloudflare-worker-prod/worker.js authRegister 一致），否则测不出「开通传播」
  reg.accounts[username] = {
    hash, role: 'user', status: 'active', disabled: false,
    trialUntil, trialDays: Number(body.trialDays) || (trialUntil ? 1 : 0),
    quotaMonths: Number(body.quotaMonths) || 0, disableDate: '', registerDate: typeof body.registerDate === 'string' ? body.registerDate : '',
    payMembershipUntil: Number(body.payMembershipUntil) || 0, paidAt: Number(body.paidAt) || 0,
    paidPlan: typeof body.paidPlan === 'string' ? body.paidPlan : '', paidAmount: Number(body.paidAmount) || 0,
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
  if (withWorker) sandbox.__SNT_ACCEL__ = 'https://sichina.dpdns.org';   // 与 index.html 注入一致
  const ctx = vm.createContext(sandbox);
  for (const f of ['js/auth.js', 'js/auth-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  if (withToken) storage.setItem('snt-auth-admin-token', 'ghp_mocktoken');
  return { ctx, sandbox, Auth: sandbox.Auth };
}

const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ========== 场景1：核心需求——普通设备注册 → 云端 → 管理员审核通过区必现 ========== */
  console.log('\n[场景1] 设备B注册（无令牌、经 Worker 代写）→ 管理员审核通过区出现该账号');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});                       // 云端初始为空（模拟全新部署）
    // —— 设备B：普通用户，无令牌，注册即送 1 天试用 ——
    const bStore = makeStorage();
    const B = await loadAuthForDevice(bStore, { withToken: false, withWorker: true });
    const reg = await B.Auth.register('xiaoming', 'Xm@123456');
    check('设备B注册成功（本机 active + 1天试用）', reg.ok === true && reg.autoTrial === true, JSON.stringify(reg.error || 'ok'));
    await tick();                                  // 等云端代写（fire-and-forget）落地
    check('注册时向 Worker 发了 /auth/register', workerCalls.length === 1 && workerCalls[0].username === 'xiaoming', JSON.stringify(workerCalls));
    check('代写载荷带 pbkdf2 哈希与试用期', /^pbkdf2\$/.test(workerCalls[0].hash) && Number(workerCalls[0].trialUntil) > Date.now(), JSON.stringify(workerCalls[0]));
    const cloudXm = regOf().accounts['xiaoming'];
    check('云端注册表已有 xiaoming（active）', !!cloudXm && cloudXm.status === 'active', JSON.stringify(cloudXm || null));
    check('云端角色为普通用户', !!cloudXm && cloudXm.role === 'user', 'role=' + (cloudXm && cloudXm.role));

    // —— 设备A：管理员（有令牌），打开用户管理即 recoverFromRegistry 合并云端 ——
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const rec = await A.Auth.recoverFromRegistry();
    check('管理员从云端恢复账号成功', rec.ok === true && rec.recovered === 1, JSON.stringify(rec));
    const detail = A.Auth.listUsersDetail().find(u => u.username === 'xiaoming');
    check('xiaoming 出现在管理员账号列表', !!detail, 'not found');
    check('状态为 active → 会出现在「审核通过区」（status !== pending）', !!detail && detail.status !== 'pending', 'status=' + (detail && detail.status));
    check('试用期与云端一致（1 天）', !!detail && Number(detail.trialUntil) > Date.now(), 'trialUntil=' + (detail && detail.trialUntil));

    // —— 设备C：全新设备（无本机账号），用账号密码直接登录（免准入码） ——
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg = await C.Auth.login('xiaoming', 'Xm@123456');
    check('全新设备用账号密码直接登录成功', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后角色为普通用户（以云端注册表为准）', lg.ok === true && lg.user && lg.user.role === 'user', 'role=' + (lg.user && lg.user.role));
  }

  /* ========== 场景2：注册时离线没写上 → 下次登录自动补写 ========== */
  console.log('\n[场景2] 登录自愈：云端缺账号 → 本地登录成功 → 自动补写云端');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    // —— 设备B：注册时 Worker 不可达（离线）——
    const bStore = makeStorage();
    const B = await loadAuthForDevice(bStore, { withToken: false, withWorker: false });
    const reg = await B.Auth.register('offlineguy', 'Og@123456');
    check('离线注册本机成功', reg.ok === true, JSON.stringify(reg.error || 'ok'));
    await tick();
    check('云端暂无该账号（离线没写上）', !regOf().accounts['offlineguy'], 'leaked');

    // —— 恢复网络后登录一次：notFound → 本地登录成功 → 补写云端 ——
    const B2ctx = await loadAuthForDevice(bStore, { withToken: false, withWorker: true });
    const lg = await B2ctx.Auth.login('offlineguy', 'Og@123456');
    check('恢复网络后登录成功', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    await tick();
    check('登录后云端已补写该账号', !!regOf().accounts['offlineguy'], JSON.stringify(regOf().accounts));
    check('补写的状态为 active', regOf().accounts['offlineguy'] && regOf().accounts['offlineguy'].status === 'active', 'status=' + (regOf().accounts['offlineguy'] && regOf().accounts['offlineguy'].status));
  }

  /* ========== 场景3：云端哈希不同（另一套密码）→ 登录成功但不覆盖 ========== */
  console.log('\n[场景3] 云端已有同名但哈希不符 → 不覆盖（避免误改对方记录）');
  {
    workerCalls.length = 0;
    setRegistryAccounts({
      clash: { hash: 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo', role: 'user', status: 'active', createdAt: 1, updatedAt: 1 },
    });
    const store = makeStorage();
    const X = await loadAuthForDevice(store, { withToken: false, withWorker: true });
    // 本机造一个同名账号（模拟管理员本机添加 / 旧数据），密码与云端不同
    await X.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    await X.Auth.addUser('clash', 'Local@99999', { role: 'user' });
    await X.Auth.grantTrial('clash', 1);   // 门禁要求：无试用/会员的账号不能登录
    const lg = await X.Auth.login('clash', 'Local@99999');
    check('本机密码登录成功（回落本地校验）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    await tick();
    check('云端哈希未被覆盖', regOf().accounts['clash'].hash === 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo', 'hash=' + regOf().accounts['clash'].hash);
    check('未向 Worker 发补写请求（哈希不符不补写）', workerCalls.length === 0, JSON.stringify(workerCalls));
  }

  /* ========== 场景4：静态断言（接线） ========== */
  console.log('\n[场景4] 静态断言：注册/登录/刷新按钮接线');
  {
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    check('auth.js 新增 _syncAccountToCloud（直写→Worker 代写）', /_syncAccountToCloud: function/.test(auth));
    check('auth.js 注册走 _syncAccountToCloud', /self\._syncAccountToCloud\(u\)/.test(auth));
    check('auth.js 登录自愈走 _syncAccountToCloud', /self\._syncAccountToCloud\(full\)/.test(auth));
    check('auth.js 登录自愈只在 notFound 时触发', /r && r\.notFound/.test(auth));
    check('auth-sync.js 导出 registerRemoteViaWorker', /registerRemoteViaWorker: registerRemoteViaWorker/.test(sync));
    check('auth-sync.js loginRemote 缺账号返回 notFound', /return \{ notFound: true \}/.test(sync));
    check('auth-sync.js Worker 端点URL为 /auth/register', /fetchFirstAvailable\('\/auth\/register'/.test(sync));
    check('app.js 暴露 refreshPendingRegistrations', /refreshPendingRegistrations, refreshingPending/.test(app));
    check('app.js 刷新函数合并云端注册表（recoverFromRegistry）', /async function refreshPendingRegistrations[\s\S]*?A\.recoverFromRegistry/.test(app));
    // 待审核注册申请区的刷新按钮（按锚点定位，确保加在该区而不是别处）
    const anchor = html.indexOf('🔔 待审核注册申请');
    check('index.html 待审核注册申请区存在', anchor > 0);
    const headEnd = html.indexOf('</div>', anchor);
    const headSlice = html.slice(anchor, headEnd);
    check('该区标题行有 ↻ 刷新按钮', headSlice.includes('um-refresh-btn') && headSlice.includes('@click="refreshPendingRegistrations"'), headSlice.slice(0, 400));
    check('刷新按钮有禁用态（刷新中…）', headSlice.includes('refreshingPending'));
  }

  /* ========== 场景5：无令牌管理员「核对并开通」→ 云端 → 全新设备原密码带会员登录 ========== */
  console.log('\n[场景5] 打通数据反馈：无令牌管理员开通→云端→全新设备原密码登录带会员（20261018 CORS 修复验证）');
  {
    workerCalls.length = 0;
    setRegistryAccounts({});
    // —— 设备B：普通用户（无令牌）注册，经 Worker 代写云端 ——
    const bStore = makeStorage();
    const B = await loadAuthForDevice(bStore, { withToken: false, withWorker: true });
    const reg = await B.Auth.register('approved1', 'Ap@123456');
    check('设备B注册成功', reg.ok === true, JSON.stringify(reg.error || 'ok'));
    await tick();
    check('云端已有 approved1（active）', !!regOf().accounts['approved1'], JSON.stringify(regOf().accounts));
    const regHash = workerCalls.length ? workerCalls[0].hash : '';

    // —— 设备A：管理员（无令牌！）从云端恢复该账号并开通会员，再经 Worker 代写回云端 ——
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: false, withWorker: true });
    await A.Auth.setup('admin', 'Admin@2026', 'Admin@2026');
    const rec = await A.Auth.recoverFromRegistry();
    check('无令牌管理员也能从云端恢复 approved1', rec.ok === true && rec.recovered === 1, JSON.stringify(rec));
    const gm = A.Auth.grantMembership('approved1', 6, { paidAt: Date.now() - 2 * 86400000, amount: 1000 });
    check('无令牌管理员开通会员成功（本机）', gm.ok === true, JSON.stringify(gm.error || 'ok'));
    const prop = await A.Auth.syncAccountToCloud('approved1');
    check('开通后经 Worker 代写云端成功（无令牌路径，正是被 CORS 拦的链路）', prop && prop.ok === true, JSON.stringify(prop));
    const cloudAcc = regOf().accounts['approved1'];
    check('云端账号已带会员到期时间', !!cloudAcc && Number(cloudAcc.payMembershipUntil) > Date.now(), JSON.stringify(cloudAcc));
    check('云端哈希仍是用户注册时那份（原密码可登录，未变成随机密码）',
      !!cloudAcc && !!regHash && cloudAcc.hash === regHash, 'cloud=' + (cloudAcc && cloudAcc.hash) + ' reg=' + regHash);

    // —— 设备C：全新设备（无本机账号、无令牌）用原密码直接登录，应带会员 ——
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false, withWorker: true });
    const lg = await C.Auth.login('approved1', 'Ap@123456');
    check('全新设备用原密码登录成功（管理员→后端→用户端数据反馈打通）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后带会员（会员未过期，门禁放行）',
      lg.ok === true && lg.user && Number(lg.user.payMembershipUntil) > Date.now(), JSON.stringify(lg.user || {}));
  }

  /* ========== 场景6：Worker CORS 头必须含 POST（防 20261018 回归） ========== */
  console.log('\n[场景6] 静态断言：stock-edge Worker 的 CORS Allow-Methods 含 POST（否则浏览器跨域 POST 被预检拦截）');
  {
    const worker = fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8');
    check('withCors 允许方法含 POST', /Access-Control-Allow-Methods', '[^']*POST[^']*'/.test(worker), 'CORS 头未含 POST');
    check('withCors 允许方法含 OPTIONS（预检）', /Access-Control-Allow-Methods', '[^']*OPTIONS[^']*'/.test(worker));
    check('worker 处理 /auth/register 的 POST', /url\.pathname === '\/auth\/register'[\s\S]{0,80}request\.method === 'POST'/.test(worker));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
