/* ============================================================
 * test-approved-zone-save.mjs — 验证「审核通过区 💾 保存」按钮
 * （20261016j：账号设置改动上传云端后端，刷新页面不丢失）
 *
 * 背景（用户需求）：管理员用户管理-待审核用户-审核通过区，刷新按钮左侧加「保存」。
 * 管理员对账户信息进行设置（典型：把某账号从管理员改成普通用户），点保存以后
 * 上传后端；刷新页面、重新打开页面，账号就是设置后的状态。
 *
 * 场景1（用户示例完整复现）：
 *   管理员本机把普通账号提成管理员 → 保存上传 → 注册表 role=admin
 *   模拟「刷新页面」（同 localStorage 全新 vm 上下文）→ 仍是管理员
 *   再改回普通用户 → 保存上传 → 注册表 role=user
 *   再模拟刷新 → 是普通用户（且 recoverFromRegistry 不会把本机状态回滚）
 * 场景2（脏检查口径）：registryKeyFields 本机 vs 云端 —— 改动即不等，保存后即相等
 * 场景3（无令牌）：saveUsersToRegistry 明确报错且不写注册表
 * 场景4（非管理员）：拒绝保存
 * 场景5（批量/健壮性）：多账号一次保存全部落地；空数组/不存在用户名安全返回
 * 场景6（静态断言）：app.js / index.html / css / auth.js 接线
 * 场景7（e2e 残留清理，20261016n）：recoverFromRegistry 剔除 eadm_<ts> 管理员残留，
 *   不误删形态相近的正常账号，幂等
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

/** app.js isAccountDirty 的同口径判定（JSON.stringify(registryKeyFields) 比较） */
function dirtyOf(Auth, localUserView, cloudAcc) {
  if (!cloudAcc) return true;
  return JSON.stringify(Auth.registryKeyFields(localUserView)) !== JSON.stringify(Auth.registryKeyFields(cloudAcc));
}

(async () => {
  /* ========== 场景1：用户示例完整复现（管理员↔普通用户，保存后刷新不丢失） ========== */
  console.log('\n[场景1] 管理员改角色 → 💾保存上传 → 模拟刷新页面 → 状态保持');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    // 普通账号 tom（管理员本机添加，自动同步云端）
    const add = await AuthA.addUser('tom', 'Tom@12345', { role: 'user' });
    check('前置：本机添加普通用户 tom', add.ok === true, JSON.stringify(add.error || 'ok'));
    await add.sync;
    check('tom 已自动同步云端（role=user）', regOf().accounts['tom'] && regOf().accounts['tom'].role === 'user', JSON.stringify(regOf().accounts['tom'] || {}));

    // —— 打开面板时的快照：tom 与云端一致 → 没有未保存改动 ——
    const view0 = AuthA.listUsersDetail().find(u => u.username === 'tom');
    check('初始状态判定为「无改动」', dirtyOf(AuthA, view0, regOf().accounts['tom']) === false, 'unexpected dirty');

    // —— 管理员把 tom 提成管理员（本机立即生效 + 自动同步）——
    const rRole = AuthA.setUserRole('tom', 'admin');
    check('本机角色立即变为 admin', rRole.ok === true && rRole.user.role === 'admin', JSON.stringify(rRole));
    const syncRole = await rRole.sync;
    check('角色变更自动同步云端成功', syncRole && syncRole.ok === true, JSON.stringify(syncRole));
    check('注册表 role=admin', regOf().accounts['tom'].role === 'admin', 'role=' + regOf().accounts['tom'].role);

    // —— 模拟「刷新页面」：同 localStorage 全新 vm 上下文（localStorage 不随刷新丢失）——
    const A2 = await loadAuthForDevice(aStore, { withToken: true });
    const lg2 = await A2.Auth.login('admin', 'Admin@2026');
    check('刷新页面后管理员重新登录成功', lg2.ok === true, JSON.stringify(lg2.error || 'ok'));
    const view1 = A2.Auth.listUsersDetail().find(u => u.username === 'tom');
    check('刷新页面后 tom 仍是管理员', view1 && view1.role === 'admin', 'role=' + (view1 && view1.role));
    const rec = await A2.Auth.recoverFromRegistry();
    check('刷新后 recoverFromRegistry 不会回滚本机状态（skipped）', rec.ok === true && rec.recovered === 0, JSON.stringify(rec));
    const view1b = A2.Auth.listUsersDetail().find(u => u.username === 'tom');
    check('恢复云端后 tom 角色不被覆盖', view1b && view1b.role === 'admin', 'role=' + (view1b && view1b.role));

    // —— 再改回普通用户 → 显式点「💾 保存」上传 ——
    const rRole2 = A2.Auth.setUserRole('tom', 'user');
    check('本机角色改回普通用户', rRole2.ok === true && rRole2.user.role === 'user', JSON.stringify(rRole2));
    // 不依赖自动同步：直接用保存按钮的接口把「有改动的账号」上传
    const save1 = await A2.Auth.saveUsersToRegistry(['tom']);
    check('保存成功（1 个账号）', save1.ok === true && save1.saved.length === 1 && save1.saved[0] === 'tom', JSON.stringify(save1));
    check('注册表 role=user（已上传后端）', regOf().accounts['tom'] && regOf().accounts['tom'].role === 'user', 'role=' + (regOf().accounts['tom'] || {}).role);
    const view2 = A2.Auth.listUsersDetail().find(u => u.username === 'tom');
    check('保存后本机 vs 云端一致（不再有未保存改动）', dirtyOf(A2.Auth, view2, regOf().accounts['tom']) === false, 'still dirty');

    // —— 再模拟刷新：本机 + 云端都是普通用户 ——
    const A3 = await loadAuthForDevice(aStore, { withToken: true });
    const lg3 = await A3.Auth.login('admin', 'Admin@2026');
    check('再次刷新后管理员登录成功', lg3.ok === true, JSON.stringify(lg3.error || 'ok'));
    const view3 = A3.Auth.listUsersDetail().find(u => u.username === 'tom');
    check('再次刷新页面后 tom 是普通用户（用户要求的最终状态）', view3 && view3.role === 'user', 'role=' + (view3 && view3.role));
    check('云端注册表同样是普通用户（后端已保存）', regOf().accounts['tom'].role === 'user', 'role=' + regOf().accounts['tom'].role);

    // —— 试用字段同样走保存通道上传（此前试用只存本机）——
    const tr = A3.Auth.grantTrial('tom', 1);
    check('给 tom 开通 1 天试用', tr.ok === true, JSON.stringify(tr.error || 'ok'));
    const svT = await A3.Auth.saveUsersToRegistry(['tom']);
    check('试用期随保存上传云端', svT.ok === true && Number(regOf().accounts['tom'].trialUntil) > Date.now(), JSON.stringify(svT));

    // —— 全新设备（无本机账号）从云端登录，拿到的就是普通用户角色 + 试用期 ——
    const cStore = makeStorage();
    const C = await loadAuthForDevice(cStore, { withToken: false });
    const lg = await C.Auth.login('tom', 'Tom@12345');
    check('全新设备用账号密码直接登录成功（试用期内）', lg.ok === true, JSON.stringify(lg.error || 'ok'));
    check('登录后角色为普通用户（以云端注册表为准）', lg.ok === true && lg.user && lg.user.role === 'user', 'role=' + (lg.user && lg.user.role));
  }

  /* ========== 场景2：脏检查口径（哪些字段参与比较） ========== */
  console.log('\n[场景2] registryKeyFields 比较口径');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const add = await AuthA.addUser('jerry', 'Jerry@12345', { role: 'user' });
    await add.sync;
    const view = AuthA.listUsersDetail().find(u => u.username === 'jerry');
    const cloud = regOf().accounts['jerry'];
    check('刚同步完 → 无改动', dirtyOf(AuthA, view, cloud) === false, 'unexpected dirty');

    // 改一个「会参与比较」的字段：额度
    AuthA.setUserMembership('jerry', { quotaMonths: 12 });
    const view2 = AuthA.listUsersDetail().find(u => u.username === 'jerry');
    check('额度改动 → 判定为有未保存改动', dirtyOf(AuthA, view2, cloud) === true, 'not dirty');

    // updatedAt 不参与比较（每次写入都变，否则永远脏）
    const f1 = AuthA.registryKeyFields(view);
    const f2 = AuthA.registryKeyFields(Object.assign({}, view, { updatedAt: Date.now() + 99999 }));
    check('updatedAt 变化不影响脏判定', JSON.stringify(f1) === JSON.stringify(f2), 'updatedAt leaked into key fields');
    check('keyFields 不含 hash / username / createdAt / disableDate', !('hash' in f1) && !('username' in f1) && !('createdAt' in f1) && !('disableDate' in f1), Object.keys(f1).join(','));

    // 保存后重新一致
    const sv = await AuthA.saveUsersToRegistry(['jerry']);
    check('额度改动保存成功', sv.ok === true && sv.saved[0] === 'jerry', JSON.stringify(sv));
    const view3 = AuthA.listUsersDetail().find(u => u.username === 'jerry');
    check('保存后无改动', dirtyOf(AuthA, view3, regOf().accounts['jerry']) === false, 'still dirty');
    check('注册表额度月数=12', Number(regOf().accounts['jerry'].quotaMonths) === 12, 'quota=' + regOf().accounts['jerry'].quotaMonths);

    // 注册日期（此前只存本机的字段）也能通过保存上传
    AuthA.setUserMembership('jerry', { registerDate: '2026-09-01' });
    const sv2 = await AuthA.saveUsersToRegistry(['jerry']);
    check('注册日期保存成功', sv2.ok === true, JSON.stringify(sv2));
    check('注册表注册日期=2026-09-01', regOf().accounts['jerry'].registerDate === '2026-09-01', 'regDate=' + regOf().accounts['jerry'].registerDate);

    // 停用字段也参与比较与上传
    AuthA.setUserDisabled('jerry', true);
    const sv3 = await AuthA.saveUsersToRegistry(['jerry']);
    check('停用状态保存成功', sv3.ok === true, JSON.stringify(sv3));
    check('注册表 disabled=true', regOf().accounts['jerry'].disabled === true, 'disabled=' + regOf().accounts['jerry'].disabled);
  }

  /* ========== 场景3：无令牌 → 明确报错，不写注册表 ========== */
  console.log('\n[场景3] 无 GitHub 令牌 → 保存明确失败');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: false });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const before = JSON.stringify(regOf().accounts);
    const sv = await AuthA.saveUsersToRegistry(['admin']);
    check('无令牌 → ok=false 且提示去设置配令牌', sv.ok === false && /GitHub 令牌/.test(sv.error || ''), JSON.stringify(sv));
    check('无令牌 → 没有账号被写进去', sv.saved.length === 0, JSON.stringify(sv.saved));
    check('注册表未被改动', JSON.stringify(regOf().accounts) === before, 'registry changed');
  }

  /* ========== 场景4：非管理员不可保存 ========== */
  console.log('\n[场景4] 非管理员调用保存接口 → 拒绝');
  {
    const uStore = makeStorage();
    const U = await loadAuthForDevice(uStore, { withToken: false });
    await U.Auth.register('normalguy', 'abc12345');
    const sv = await U.Auth.saveUsersToRegistry(['normalguy']);
    check('非管理员 → ok=false 仅管理员', sv.ok === false && /仅管理员/.test(sv.error || ''), JSON.stringify(sv));
  }

  /* ========== 场景5：批量 / 健壮性 ========== */
  console.log('\n[场景5] 批量保存与边界');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    const a1 = await AuthA.addUser('batch1', 'Batch@12345', { role: 'user' });
    const a2 = await AuthA.addUser('batch2', 'Batch@12345', { role: 'user' });
    await a1.sync; await a2.sync;
    // 两个账号同时改角色，一次保存全部上传
    AuthA.setUserRole('batch1', 'admin');
    AuthA.setUserRole('batch2', 'admin');
    const sv = await AuthA.saveUsersToRegistry(['batch1', 'batch2']);
    check('批量保存全部成功', sv.ok === true && sv.saved.length === 2, JSON.stringify(sv));
    check('注册表两个账号 role=admin', regOf().accounts['batch1'].role === 'admin' && regOf().accounts['batch2'].role === 'admin',
      'b1=' + regOf().accounts['batch1'].role + ' b2=' + regOf().accounts['batch2'].role);
    // 用户名大小写不敏感
    const sv2 = await AuthA.saveUsersToRegistry(['BATCH1']);
    check('大小写不敏感（BATCH1 也能保存）', sv2.ok === true && sv2.saved.length === 1, JSON.stringify(sv2));
    // 空数组 / 不存在用户名：安全返回，不报错
    const sv3 = await AuthA.saveUsersToRegistry([]);
    check('空数组 → ok=true, total=0', sv3.ok === true && sv3.total === 0, JSON.stringify(sv3));
    const sv4 = await AuthA.saveUsersToRegistry(['ghost-user']);
    check('不存在的用户名 → ok=true, total=0（无副作用）', sv4.ok === true && sv4.total === 0, JSON.stringify(sv4));
    const sv5 = await AuthA.saveUsersToRegistry(null);
    check('null 参数 → 安全返回', sv5.ok === true && sv5.total === 0, JSON.stringify(sv5));
  }

  /* ========== 场景7：e2e 测试残留（eadm_<ts> 管理员）自动清理（20261016n） ========== */
  console.log('\n[场景7] recoverFromRegistry 清理 e2e 测试残留');
  {
    const aStore = makeStorage();
    const A = await loadAuthForDevice(aStore, { withToken: true });
    const AuthA = A.Auth;
    await AuthA.setup('admin', 'Admin@2026', 'Admin@2026');
    // 模拟污染：本机账号表混入 e2e 残留（eadm_<13位ts> + admin，形态与 2026-10-06
    // 线上事故完全一致——e2e_member_a-live.mjs 注册后改 localStorage 提权，清理不可靠）
    const users = JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]');
    const ts1 = 1791264090552, ts2 = 1791294636949;
    users.push({ username: 'eadm_' + ts1, role: 'admin', hash: 'pbkdf2$150000$c2FsdA==$ZHN0', status: 'active', disabled: false, createdAt: ts1, updatedAt: ts1, logins: [] });
    users.push({ username: 'eadm_' + ts2, role: 'admin', hash: 'pbkdf2$150000$c2FsdA==$ZHN0', status: 'active', disabled: false, createdAt: ts2, updatedAt: ts2, logins: [] });
    // 对照组：形态相近但不应被误删的账号
    users.push({ username: 'eadm_lookalike', role: 'user', hash: 'pbkdf2$150000$c2FsdA==$ZHN0', status: 'active', disabled: false, createdAt: 1, updatedAt: 1, logins: [] });      // eadm_ 前缀但是普通用户
    users.push({ username: 'adm_1791264090552', role: 'admin', hash: 'pbkdf2$150000$c2FsdA==$ZHN0', status: 'active', disabled: false, createdAt: 1, updatedAt: 1, logins: [] });    // 管理员但非 eadm_ 前缀
    aStore.setItem('snt-auth-users-v1', JSON.stringify(users));
    // 自带已知云端状态（避免被前面场景的同步污染）：云端只有一个普通账号 realuser
    ghFiles.set('data/accounts/registry.json', {
      content: JSON.stringify({ version: 1, updatedAt: 0, accounts: {
        realuser: { hash: 'pbkdf2$150000$c2FsdA==$ZHN0', role: 'user', status: 'active', disabled: false, trialUntil: 0, quotaMonths: 0, disableDate: '', registerDate: '2026-10-06', createdAt: 1, updatedAt: 1 }
      } }, null, 2),
      sha: 'sha-reg-s7'
    });
    const cloudCount = Object.keys(regOf().accounts).length;
    const rec = await AuthA.recoverFromRegistry();
    check('cleaned=2（两个 eadm_<ts> 管理员残留被剔除）', rec.ok === true && rec.cleaned === 2, JSON.stringify(rec));
    check('云端账号正常合入（recovered=1，本机均无）', rec.recovered === 1 && cloudCount === 1, 'recovered=' + rec.recovered + ' cloud=' + cloudCount);
    const after = JSON.parse(aStore.getItem('snt-auth-users-v1') || '[]').map(u => u.username);
    check('本机不再有 eadm_<ts> 残留', !after.some(n => /^eadm_\d{13}$/.test(n)), after.join(','));
    check('本机保留 eadm_ 前缀的普通用户（不误删）', after.includes('eadm_lookalike'), after.join(','));
    check('本机保留非 eadm_ 前缀的管理员（不误删）', after.includes('adm_1791264090552'), after.join(','));
    check('本机保留 admin 与合入的云端账号（realuser）', after.includes('admin') && after.includes('realuser'), after.join(','));
    // 幂等：再恢复一次 cleaned=0
    const rec2 = await AuthA.recoverFromRegistry();
    check('再次恢复 cleaned=0（幂等，不重复触发保存）', rec2.ok === true && rec2.cleaned === 0, JSON.stringify(rec2));
    // 管理员视图（listUsersDetail）里同样没有残留
    const names = AuthA.listUsersDetail().map(u => u.username);
    check('管理员视图无 eadm_<ts> 残留（审核通过区不再显示）', !names.some(n => /^eadm_\d{13}$/.test(n)), names.join(','));
  }

  /* ========== 场景6：静态断言（接线） ========== */
  console.log('\n[场景6] 接线静态断言');
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
    const auth = fs.readFileSync(path.join(ROOT, 'js/auth.js'), 'utf8');
    check('auth.js 定义 saveUsersToRegistry', /saveUsersToRegistry: function/.test(auth));
    check('auth.js 定义 registryKeyFields', /registryKeyFields: function/.test(auth));
    check('auth.js 保存接口仅管理员可调', /saveUsersToRegistry: function[\s\S]{0,200}isAdmin\(\)/.test(auth));
    check('auth.js 保存顺序写入防 409', /saveUsersToRegistry: function[\s\S]{0,900}顺序写入/.test(auth));
    check('auth.js 写入与脏检查共用 buildRegistryRecord 口径', /buildRegistryRecord\(u\);[\s\S]{0,80}rec\.updatedAt = Date\.now\(\)/.test(auth));
    check('auth.js recoverFromRegistry 定义 E2E_ADMIN_RE 残留识别', auth.includes('var E2E_ADMIN_RE = /^eadm_\\d{13}$/;'));
    check('auth.js 残留剔除条件：eadm_<ts> 且 role=admin', /E2E_ADMIN_RE\.test\(String\(cu\.username\)\) && cu\.role === ROLE\.ADMIN/.test(auth));
    check('auth.js recoverFromRegistry 返回 cleaned 计数', /return \{ ok: true, recovered: recovered, skipped: skipped, cleaned: cleaned \};/.test(auth));
    check('auth.js 有残留时也落盘（cleaned>0 触发 saveUsers）', /if \(recovered > 0 \|\| cleaned > 0\) \{ saveUsers\(self\.users\); \}/.test(auth));
    check('app.js 定义 saveApprovedZoneChanges', /async function saveApprovedZoneChanges\(\)/.test(app));
    check('app.js 定义 isAccountDirty', /function isAccountDirty\(u\)/.test(app));
    check('app.js 定义 dirtyAccountList', /const dirtyAccountList = computed\(/.test(app));
    check('app.js 定义 loadCloudRegistrySnapshot', /async function loadCloudRegistrySnapshot\(\)/.test(app));
    check('app.js 定义 markAccountSynced / dropSnapshotEntry', /function markAccountSynced\(username\)/.test(app) && /function dropSnapshotEntry\(username\)/.test(app));
    check('app.js openUserManage 拉云端快照', /refreshUserList\(\);\s*\n\s*\/\/ 20261016j：拉云端「已保存状态」快照[\s\S]{0,120}loadCloudRegistrySnapshot\(\);/.test(app));
    check('app.js 保存前校验 GitHub 令牌', /saveApprovedZoneChanges[\s\S]{0,700}isAdminConfigured\(\)\)\s*\n?\s*\{\s*\n\s*showToast\('请先在「设置」填写 GitHub 令牌/.test(app));
    check('app.js 无改动时提示且不上传', /没有需要保存的改动（所有账号已与云端一致）/.test(app));
    check('app.js 保存成功提示刷新不丢失', /已保存 ' \+ r\.saved\.length \+ ' 个账号的改动到云端，刷新页面不会丢失/.test(app));
    check('app.js 部分失败时列出失败账号', /\(r\.failed \|\| \[\]\)\.length \+ ' 个失败（/.test(app));
    check('app.js 角色变更同步成功后标记已保存', /markAccountSynced\(u\.username\);   \/\/ 20261016j：已自动上传/.test(app));
    check('app.js 会员传播成功后标记已保存', /refreshUserList\(\);\s*\n\s*markAccountSynced\(username\);/.test(app));
    check('app.js 删除后移除快照条目', /dropSnapshotEntry\(u\.username\);   \/\/ 20261016j：云端已删/.test(app));
    check('app.js return 暴露保存相关函数', /savingApproved, dirtyAccountList, isAccountDirty, saveApprovedZoneChanges,/.test(app));
    check('index.html 保存按钮在刷新按钮左侧', html.indexOf('@click="saveApprovedZoneChanges"') < html.indexOf('@click="refreshApprovedZone"') && html.indexOf('@click="saveApprovedZoneChanges"') > 0, 'save=' + html.indexOf('@click="saveApprovedZoneChanges"') + ' refresh=' + html.indexOf('@click="refreshApprovedZone"'));
    check('index.html 保存按钮调用 saveApprovedZoneChanges', /@click="saveApprovedZoneChanges"/.test(html));
    check('index.html 保存按钮有改动计数角标', /um-save-count" v-if="dirtyAccountList\.length > 0"/.test(html));
    check('index.html 保存中禁用防重复点击', /:disabled="savingApproved"/.test(html));
    check('index.html 未保存行标记 um-dirty-tag', /class="um-dirty-tag" v-if="isAccountDirty\(u\)"/.test(html));
    check('index.html 未保存行高亮 um-row-dirty', /'um-row-dirty': isAccountDirty\(u\)/.test(html));
    check('index.html 审核通过区说明提到保存上传', /点「💾 保存」上传到云端后端，刷新页面、换设备登录都不会丢失/.test(html));
    check('css 有保存按钮/角标/未保存标记/行高亮样式', css.includes('.um-save-btn') && css.includes('.um-save-count') && css.includes('.um-dirty-tag') && css.includes('.um-row-dirty td'));
    /* 20261016p：审核区申请列表小标题改名 + 两处「保存设置」按钮 */
    check('index.html 申请列表小标题改为「审核区域」', html.includes('<span>审核区域</span>'));
    check('index.html 审核区「保存设置」在「↻ 刷新」左侧', (() => {
      const head = html.slice(html.indexOf('<span>审核区域</span>'), html.indexOf('</div>', html.indexOf('<span>审核区域</span>')));
      return head.indexOf('@click="saveApprovedZoneChanges"') > 0 && head.indexOf('@click="saveApprovedZoneChanges"') < head.indexOf('@click="refreshMemberClaims"');
    })());
    check('index.html 「保存设置」按钮共 3 处（审核通过区表头 + 审核区 + 授权使用）', (html.match(/@click="saveApprovedZoneChanges"/g) || []).length === 3, 'count=' + (html.match(/@click="saveApprovedZoneChanges"/g) || []).length);
    check('index.html 授权使用面板也有「保存设置」', (() => {
      const panel = html.slice(html.indexOf("umTab==='auth'"), html.indexOf('um-table-head'));
      return panel.includes('@click="saveApprovedZoneChanges"');
    })());
    check('index.html 「保存设置」文案出现（非仅 💾 保存）', (html.match(/>保存设置</g) || []).length >= 2, 'count=' + (html.match(/>保存设置</g) || []).length);
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
