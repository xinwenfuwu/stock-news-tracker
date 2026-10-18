/* ============================================================
 * test-claim-auto-create.mjs — 验证「支付申请自带账号快照 + 核对并开通自动创建账号」
 * （20261016h 修复版验证）
 *
 * 背景（用户实测）：普通用户 yh123 在自己设备（无 GitHub 令牌）注册，账号只存本机、
 * 从不进云端注册表；管理员在「待审核用户 → 审核区」点「核对并开通」报
 * 「云端注册表里也没有『yh123』」。
 *
 * 场景1（完整闭环，yh123 复现 + 修复验证）：
 *   设备U（普通用户，无令牌）注册 yh123 → 仅本机，注册表仍为空
 *   设备U 导出账号快照并随支付申请提交
 *   设备A（管理员，带令牌）模拟「核对并开通」：
 *     直接开通 → 用户不存在 → recoverFromRegistry → 仍无 → createAccountFromSnapshot → 开通成功
 *   注册表出现 yh123（哈希=对方注册时那份 + 会员到期时间）
 *   设备C（全新设备）用原密码直接登录成功（跨设备免码）
 *
 * 场景2（旧版申请无快照）：不走创建分支，维持「重新提交 / 申请码导入」指引
 * 场景3（快照缺密码哈希）：拒绝创建半成品账号
 * 场景4（非管理员调用）：拒绝
 * 场景5（账号已存在）：保留本机哈希，不覆盖
 * 场景6（防提权）：快照 role=admin 也只创建普通用户
 * 场景7（静态断言）：app.js / auth-boot.js / auth.js 接线
 * 场景8（静态断言）：20261016i「拒绝通过」接线（app.js / index.html / worker.js / css）
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
function claimsOf() { return JSON.parse(ghFiles.get('data/membership/claims.json').content).claims; }

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

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  /* ========== 场景1：yh123 完整闭环 ========== */
  console.log('\n[场景1] 普通设备注册 yh123 → 申请带快照 → 管理员一键创建并开通 → 全新设备原密码登录');
  {
    // —— 设备U：普通用户自己的设备（无 GitHub 令牌）——
    const uStore = makeStorage();
    const U = await loadAuthForDevice(uStore, { withToken: false });
    const AuthU = U.Auth;
    const reg0 = await AuthU.register('yh123', 'abc12345');
    check('设备U 注册成功（自动 1 天试用）', reg0.ok === true, JSON.stringify(reg0.error || 'ok'));
    check('注册后云端注册表仍无 yh123（无令牌，符合既有设计）', !regOf().accounts['yh123'], 'registry keys=' + Object.keys(regOf().accounts));

    // 用户提交支付申请：按 app.js submitPaymentClaim 的口径附带账号快照
    // （真实流程里用户已登录；登录页续费面板则显式传用户名）
    const lgU = await AuthU.login('yh123', 'abc12345');
    check('设备U 登录成功（试用中）', lgU.ok === true, JSON.stringify(lgU.error || 'ok'));
    const snapR = AuthU.accountSnapshot();
    check('登录态可导出账号快照', snapR.ok === true && snapR.snapshot && snapR.snapshot.username === 'yh123', JSON.stringify(snapR.error || 'ok'));
    const snapByName = AuthU.accountSnapshot('yh123');
    check('显式用户名也可导出（登录页续费面板口径）', snapByName.ok === true && snapByName.snapshot.hash === snapR.snapshot.hash, JSON.stringify(snapByName.error || 'ok'));
    check('不存在的用户名 → 明确失败', AuthU.accountSnapshot('nobody').ok === false, 'unexpected ok');
    check('快照含真实密码哈希（pbkdf2 自包含）', /^pbkdf2\$/.test(snapR.snapshot.hash || ''), 'hash=' + String(snapR.snapshot.hash).slice(0, 24));
    const payTs = Date.now() - 2 * DAY;   // 两天前支付的（试用早过了，会员从支付时间起算仍在有效期内）
    const claim = {
      id: 'clm_test_yh123', user: 'yh123', plan: '6m', ts: payTs,
      amount: 1000, fee: 1000, resolved: false, acct: snapR.snapshot
    };
    ghFiles.set('data/membership/claims.json', { content: JSON.stringify({ claims: [claim] }, null, 2), sha: 'sha-clm-1' });

    // —— 设备A：管理员设备（带令牌），完整复现 grantMemberClaim 决策链 ——
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');

    // 1) 直接开通 → 用户不存在（复现用户报的故障）
    let r = AuthA.grantMembership('yh123', 6, { paidAt: payTs, amount: 1000 });
    check('直接开通报「用户不存在」（复现故障）', r.ok === false && r.error === '用户不存在', JSON.stringify(r));

    // 2) recoverFromRegistry → 恢复不到
    const rec = await AuthA.recoverFromRegistry();
    check('云端恢复不到 yh123（注册表确实没有）', rec.ok === true && rec.recovered === 0, JSON.stringify(rec));

    // 3) createAccountFromSnapshot → 用申请自带信息创建
    const cr = AuthA.createAccountFromSnapshot(claim.acct);
    check('按申请信息创建账号成功', cr.ok === true && cr.created === true, JSON.stringify(cr.error || 'ok'));
    check('创建的角色是普通用户（防提权）', cr.user && cr.user.role === 'user', 'role=' + (cr.user && cr.user.role));
    const syncRes = await cr.sync;
    check('创建后同步云端注册表成功', syncRes && syncRes.ok === true, JSON.stringify(syncRes));
    const regAcc = regOf().accounts['yh123'];
    check('注册表出现 yh123', !!regAcc, 'keys=' + Object.keys(regOf().accounts));
    check('注册表哈希 = 对方注册时那份（任何设备可原密码登录）', regAcc && regAcc.hash === snapR.snapshot.hash, 'hash mismatch');

    // 4) 再次开通 → 成功
    r = AuthA.grantMembership('yh123', 6, { paidAt: payTs, amount: 1000 });
    check('创建后开通成功', r.ok === true, JSON.stringify(r.error || 'ok'));
    check('会员自支付时间起算且未过期', r.until > Date.now(), 'until=' + r.until);
    const prop = await AuthA.syncUserToRegistry('yh123');
    check('会员同步云端注册表成功', prop && prop.ok === true, JSON.stringify(prop));
    const regAcc2 = regOf().accounts['yh123'];
    check('注册表会员到期时间已写入', regAcc2 && Number(regAcc2.payMembershipUntil) > Date.now(), 'until=' + (regAcc2 && regAcc2.payMembershipUntil));

    // —— 设备C：全新设备（无账号、无令牌），模拟用户换设备登录 ——
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false });
    const lg = await C.Auth.login('yh123', 'abc12345');
    check('全新设备用原密码直接登录成功（跨设备免码）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后即带会员（门禁放行）', lg.ok === true && lg.user && lg.user.username === 'yh123', '');
  }

  /* ========== 场景2：旧版申请（无快照）→ 不走创建分支，维持指引 ========== */
  console.log('\n[场景2] 旧版申请无账号快照 → 不开创建分支，提示重新提交/申请码导入');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const oldClaim = { id: 'clm_old', user: 'olduser', plan: '1y', ts: Date.now() - DAY, amount: 2000 };
    let r = AuthA.grantMembership(oldClaim.user, 12, { paidAt: oldClaim.ts, amount: 2000 });
    check('直接开通失败（用户不存在）', r.ok === false && r.error === '用户不存在', JSON.stringify(r));
    const rec = await AuthA.recoverFromRegistry();
    check('云端恢复不到 olduser（恢复的是别的账号，与本场景无关）',
      rec.ok === true && !JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]').some(u => u.username === 'olduser'),
      JSON.stringify(rec));
    const r2 = AuthA.grantMembership('olduser', 12, { paidAt: oldClaim.ts, amount: 2000 });
    check('恢复后开通 olduser 仍失败（用户不存在）', r2.ok === false && r2.error === '用户不存在', JSON.stringify(r2));
    // app.js 的守卫：!claim.acct → 不调 createAccountFromSnapshot，错误提示走「重新提交/申请码」文案
    check('无快照时 app.js 不会尝试创建（守卫存在）', !oldClaim.acct, 'claim has acct unexpectedly');
    // 快照缺失的调用也要能优雅拒绝（app.js 的 cr.error 分支）
    const cr = AuthA.createAccountFromSnapshot(null);
    check('无快照对象 → 明确拒绝', cr.ok === false && /没有账号信息/.test(cr.error || ''), JSON.stringify(cr));
  }

  /* ========== 场景3：快照缺密码哈希 → 拒绝创建半成品账号 ========== */
  console.log('\n[场景3] 快照缺密码哈希 → 拒绝创建');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const before = Object.keys(regOf().accounts).length;
    const cr = AuthA.createAccountFromSnapshot({ username: 'halfbaked', hash: '' });
    check('缺哈希 → 拒绝创建', cr.ok === false && /不完整/.test(cr.error || ''), JSON.stringify(cr));
    check('本机账号表未混入半成品账号', !JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]').some(u => u.username === 'halfbaked'), 'halfbaked leaked');
    const cr2 = AuthA.createAccountFromSnapshot({ username: 'halfbaked', hash: 'plaintext-not-pbkdf2' });
    check('非 pbkdf2 哈希 → 拒绝创建', cr2.ok === false, JSON.stringify(cr2));
    check('注册表未出现 halfbaked', Object.keys(regOf().accounts).length === before, 'registry changed');
  }

  /* ========== 场景4：非管理员不可调 ========== */
  console.log('\n[场景4] 非管理员调用创建接口 → 拒绝');
  {
    const uStore = makeStorage();
    const U = await loadAuthForDevice(uStore, { withToken: false });
    await U.Auth.register('normalguy', 'abc12345');
    const cr = U.Auth.createAccountFromSnapshot({ username: 'someone', hash: 'pbkdf2$1$aa$bb' });
    check('非管理员 → 拒绝', cr.ok === false && /仅管理员/.test(cr.error || ''), JSON.stringify(cr));
  }

  /* ========== 场景5：账号已存在 → 保留本机哈希，不覆盖 ========== */
  console.log('\n[场景5] 账号已存在 → 保留本机哈希（对方可能已改密）');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    // 管理员本机已有「dupuser」（哈希是本机的）
    const add = await AuthA.addUser('dupuser', 'LocalPw@123', { role: 'user' });
    check('前置：管理员本机已有 dupuser', add.ok === true, JSON.stringify(add.error || 'ok'));
    const localHashBefore = JSON.parse(aStore.getItem('snt-auth-users-v1')).find(u => u.username === 'dupuser').hash;
    // 申请里带的是一份不同的哈希（模拟对方设备注册时的那份）
    const cr = AuthA.createAccountFromSnapshot({ username: 'dupuser', hash: 'pbkdf2$150000$ZHN0$ZHN0', registerDate: '2026-10-01' });
    check('已存在 → 不报错，created=false', cr.ok === true && cr.created === false, JSON.stringify(cr));
    const localHashAfter = JSON.parse(aStore.getItem('snt-auth-users-v1')).find(u => u.username === 'dupuser').hash;
    check('本机哈希未被覆盖', localHashAfter === localHashBefore, 'hash overwritten');
    await cr.sync;
    const regHash = (regOf().accounts['dupuser'] || {}).hash;
    check('同步云端用的是本机哈希（与登录能力一致）', regHash === localHashBefore, 'registry hash=' + String(regHash).slice(0, 20));
  }

  /* ========== 场景6：防提权 —— 快照 role=admin 也只建普通用户 ========== */
  console.log('\n[场景6] 快照声称 admin → 仍只创建普通用户');
  {
    // 用全新注册表片段验证（不污染前面场景的注册表断言）
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const cr = AuthA.createAccountFromSnapshot({ username: 'sneaky', hash: 'pbkdf2$150000$ZHN0$ZHN0', role: 'admin' });
    check('创建成功但角色为普通用户', cr.ok === true && cr.user && cr.user.role === 'user', 'role=' + (cr.user && cr.user.role));
    const local = JSON.parse(aStore.getItem('snt-auth-users-v1')).find(u => u.username === 'sneaky');
    check('本机角色也是 user', local && local.role === 'user', 'role=' + (local && local.role));
  }

  /* ========== 场景7：静态断言（接线） ========== */
  console.log('\n[场景7] 接线静态断言');
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    check('auth.js 定义 accountSnapshot', /accountSnapshot: function/.test(auth));
    check('auth.js 定义 createAccountFromSnapshot', /createAccountFromSnapshot: function/.test(auth));
    check('auth.js 创建接口仅管理员可调', /createAccountFromSnapshot: function[\s\S]{0,320}isAdmin\(\)/.test(auth));
    check('auth.js 新建账号哈希必须 pbkdf2', /createAccountFromSnapshot: function[\s\S]{0,900}indexOf\('pbkdf2\$'\) !== 0/.test(auth));
    check('app.js 提交申请附带快照', /A\.accountSnapshot\(\)/.test(app) && /\.\.\.\(acct \? \{ acct: acct \} : \{\}\)/.test(app));
    check('app.js 拉取申请透传 acct', /acct: \(c\.acct && typeof c\.acct === 'object'\) \? c\.acct : null/.test(app));
    check('app.js 开通报错后用快照创建再重试', /claim\.acct && typeof A\.createAccountFromSnapshot === 'function'/.test(app));
    check('app.js 创建成功提示「账号已按申请信息创建」', /createdFromClaim[\s\S]{0,120}账号已按申请信息创建/.test(app));
    check('app.js 旧版申请提示引导重新提交/申请码', /旧版提交[\s\S]{0,200}申请码/.test(app));
    check('auth-boot.js 登录页续费提交也带快照', /Auth\.accountSnapshot\(uname\)/.test(boot));
    check('index.html 审核区徽标区分新旧申请', fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('um-claim-noacct'));
  }

  /* ========== 场景8：静态断言（20261016i「拒绝通过」接线） ========== */
  console.log('\n[场景8] 「拒绝通过」接线静态断言');
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const worker = fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8');
    check('app.js 定义 rejectMemberClaim', /async function rejectMemberClaim\(claim\)/.test(app));
    check('app.js 定义 resolveClaimOnCloud 共用拒绝落库助手', /async function resolveClaimOnCloud\(claimId, opts\)/.test(app));
    check('app.js 拒绝优先走后端 /pay/claims/resolve 且带 rejected', /resolveClaimOnCloud[\s\S]{0,400}\/pay\/claims\/resolve[\s\S]{0,140}JSON\.stringify\(\{ id: claimId, rejected \}\)/.test(app));
    const sync = fs.readFileSync(path.join(ROOT, 'js/auth-sync.js'), 'utf8');
    check('app.js 拒绝回落令牌直写（A.Sync.markClaimResolved）', /resolveClaimOnCloud[\s\S]{0,900}A\.Sync\.markClaimResolved\(claimId, \{ rejected \}\)/.test(app));
    check('auth-sync.js markClaimResolved 直写 resolved+rejected+rejectedAt', /function markClaimResolved\(id, opts\)[\s\S]{0,500}t\.resolved = true;\s*if \(rejected\) \{ t\.rejected = true; t\.rejectedAt = /.test(sync));
    check('app.js 拒绝先乐观移除再重拉（resolvedClaimIds + filter）', /resolvedClaimIds\.add\(claim\.id\); persistResolvedClaims\(\);[\s\S]{0,120}memberClaims\.list = memberClaims\.list\.filter/.test(app));
    check('app.js 收集已拒绝申请（rejected 列表）', /memberClaims\.rejected = raw\.filter\(c => c\.rejected\)/.test(app));
    check('app.js 待审列表排除已拒绝申请', /!c\.resolved && !c\.rejected && !resolvedClaimIds\.has\(c\.id\)/.test(app));
    check('app.js 暴露 rejectMemberClaim / rejectConfirmId', /grantMemberClaim, rejectMemberClaim, rejectConfirmId,/.test(app));
    check('index.html 审核区有「拒绝通过」按钮', /@click="rejectConfirmId = c\.id"[^>]*title="拒绝该申请/.test(html));
    check('index.html 行内二次确认（确认拒绝/取消）', /rejectConfirmId === c\.id[\s\S]{0,400}确认拒绝[\s\S]{0,200}取消/.test(html));
    check('index.html 底部「已拒绝的申请」列表', html.includes('已拒绝的申请（{{ memberClaims.rejected.length }}'));
    check('index.html 拒绝需二次确认防误点', /um-confirm-tip/.test(html));
    check('worker.js resolve 端点支持 rejected 标记', /payClaimResolve[\s\S]{0,700}const rejected = body\.rejected === true;[\s\S]{0,400}t\.rejected = true; t\.rejectedAt = Date\.now\(\)/.test(worker));
    check('css 有拒绝确认与已拒绝列表样式', fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8').includes('.um-rejected-toggle'));
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
