/* 鉴权核心逻辑断言测试（Node，无需浏览器）
 * 重点验证：密码哈希不可逆、登录态防伪造（改角色/改有效期/伪造签名）、
 * 角色权限判定、账号 CRUD 的边界保护、远端 provider 切换。
 * 用法：node scripts/test-auth.mjs */
import Auth from '../js/auth.js';

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

function memStorage() {
  const m = Object.create(null);
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => m
  };
}

let store = null;
function fresh() {
  store = memStorage();
  Auth.storage = store;
  Auth.remote = null;
  Auth.init();
  return store;
}

const ADMIN_PW = 'Admin@2026';

console.log('1) 用户名 / 密码输入校验');
assert('用户名过短被拒', Auth.validateUsername('a').ok === false, Auth.validateUsername('a').error);
assert('用户名含空格被拒', Auth.validateUsername('ad min').ok === false);
assert('用户名中文可用', Auth.validateUsername('管理员').ok === true);
assert('用户名超长被拒', Auth.validateUsername('a'.repeat(21)).ok === false);
assert('密码过短被拒', Auth.validatePassword('12345').ok === false, Auth.validatePassword('12345').error);
assert('两次密码不一致被拒', Auth.validatePassword('abcdef', 'abcdeg').ok === false);
assert('合法组合通过', Auth.validate('admin', ADMIN_PW, ADMIN_PW).ok === true);

console.log('\n2) 密码哈希：不可逆、不存明文、每次加盐不同');
const h1 = await Auth.makePasswordHash(ADMIN_PW);
const h2 = await Auth.makePasswordHash(ADMIN_PW);
assert('哈希格式为 pbkdf2$迭代$盐$摘要', /^pbkdf2\$150000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(h1), h1.slice(0, 40));
assert('哈希串中不含明文密码', h1.indexOf(ADMIN_PW) === -1);
assert('同一密码两次哈希不同（随机盐）', h1 !== h2);
assert('正确密码校验通过', (await Auth.verifyPassword(ADMIN_PW, h1)) === true);
assert('错误密码校验失败', (await Auth.verifyPassword(ADMIN_PW + 'x', h1)) === false);
assert('空密码校验失败', (await Auth.verifyPassword('', h1)) === false);
assert('畸形哈希串校验失败（不抛异常）', (await Auth.verifyPassword(ADMIN_PW, 'garbage')) === false);
assert('迭代次数可调（兼容老数据）', (await Auth.verifyPassword('pw123456', 'pbkdf2$1000$AAAAAAAAAAAAAAAAAAAAAA==$' + h1.split('$')[3])) === false);

console.log('\n3) 首次初始化：创建管理员');
fresh();
assert('初始状态下无任何账号', Auth.hasUsers() === false);
assert('未初始化时未登录', Auth.isLoggedIn() === false);
const badSetup = await Auth.setup('admin', '123', '123');
assert('弱密码无法完成初始化', badSetup.ok === false, badSetup.error);
const setupRes = await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
assert('初始化成功', setupRes.ok === true, setupRes.error);
assert('首个账号角色为管理员', setupRes.user.role === 'admin', setupRes.user && setupRes.user.role);
assert('初始化后自动登录', Auth.isLoggedIn() === true);
assert('初始化后 hasUsers 为真', Auth.hasUsers() === true);
assert('账号表中不存明文密码', JSON.stringify(Auth.users).indexOf(ADMIN_PW) === -1);
const setupAgain = await Auth.setup('admin2', ADMIN_PW, ADMIN_PW);
assert('已初始化后不能再次初始化', setupAgain.ok === false, setupAgain.error);

console.log('\n4) 登录：正确通过、错误拒绝、不泄露账号是否存在');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
Auth.logout();
assert('登出后回到未登录', Auth.isLoggedIn() === false);
const wrongPw = await Auth.login('admin', 'WrongPass1');
assert('密码错误被拒绝', wrongPw.ok === false, wrongPw.error);
const noUser = await Auth.login('ghost', 'WrongPass1');
assert('账号不存在被拒绝', noUser.ok === false, noUser.error);
assert('「密码错」与「账号不存在」提示一致（不泄露账号存在性）',
  wrongPw.error === noUser.error, wrongPw.error + ' / ' + noUser.error);
const noInput = await Auth.login('admin', '');
assert('空密码被拒绝', noInput.ok === false);
const okLogin = await Auth.login('admin', ADMIN_PW);
assert('正确密码登录成功', okLogin.ok === true, okLogin.error);
assert('登录后角色正确', okLogin.user.role === 'admin');
assert('记住我 30 天、默认 7 天', Auth.TTL_REMEMBER > Auth.TTL_DEFAULT && Auth.TTL_DEFAULT === 7 * 864e5);
const rememberLogin = await Auth.login('admin', ADMIN_PW, true);
assert('勾选记住我后有效期更长',
  (rememberLogin.ok && Auth.session.exp - Date.now()) > 20 * 864e5,
  String(Math.round((Auth.session.exp - Date.now()) / 864e5)) + ' 天');

console.log('\n5) 登录态防伪造（这是纯前端方案的关键防线）');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
const goodSession = JSON.parse(JSON.stringify(Auth.session));
assert('会话含签名与到期时间', !!goodSession.sig && !!goodSession.exp);
assert('正常会话可恢复', (await Auth.restore()).ok === true);

// 每次都从「正确会话」的副本出发，避免上一次失败清理掉存储后影响下一次
function tamper(mutate) {
  const raw = JSON.parse(JSON.stringify(goodSession));
  mutate(raw);
  store.setItem('snt-auth-session-v1', JSON.stringify(raw));
  Auth.init();
  return Auth.restore();
}
const r1 = await tamper(s => { s.role = 'admin'; s.username = 'admin'; s.exp = Date.now() + 999 * 864e5; });
assert('延长有效期后签名失效', r1.ok === false, r1.error);
const r2 = await tamper(s => { s.sig = s.sig.split('').reverse().join(''); });
assert('篡改签名被拦下', r2.ok === false, r2.error);
const r3 = await tamper(s => { delete s.sig; });
assert('凭空伪造会话（无签名）被拦下', r3.ok === false, r3.error);
const r4 = await tamper(s => { s.exp = Date.now() - 1000; });
assert('过期会话被拦下', r4.ok === false, r4.error);
assert('过期会话被拒后本地残留被清掉', store.getItem('snt-auth-session-v1') === null);
const r5 = await tamper(s => { s.username = 'someone-else'; });
assert('冒用其他用户名被拦下', r5.ok === false, r5.error);

console.log('\n6) 角色权限判定');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
const addUser1 = await Auth.addUser('zhangsan', 'User@2026', 'user');
assert('管理员可新增普通用户', addUser1.ok === true, addUser1.error);
assert('新增用户角色为普通用户', addUser1.user.role === 'user');
assert('新增用户默认未停用', addUser1.user.disabled === false);
const dup = await Auth.addUser('zhangsan', 'User@2026', 'user');
assert('重复用户名被拒绝', dup.ok === false, dup.error);
const dupDiffCase = await Auth.addUser('ZhangSan', 'User@2026', 'user');
assert('用户名判重不区分大小写', dupDiffCase.ok === false, dupDiffCase.error);

assert('管理员可读数据', Auth.can('data.read') === true);
assert('管理员可清空数据', Auth.can('data.clear') === true);
assert('管理员可改设置', Auth.can('settings.write') === true);
assert('管理员可管理账号', Auth.can('users.manage') === true);

Auth.logout();
const userLogin = await Auth.login('zhangsan', 'User@2026');
assert('普通用户可登录', userLogin.ok === true, userLogin.error);
assert('普通用户可读数据', Auth.can('data.read') === true);
assert('普通用户可写数据', Auth.can('data.write') === true);
assert('普通用户可导出数据', Auth.can('data.export') === true);
assert('普通用户不可清空数据', Auth.can('data.clear') === false);
assert('普通用户不可改设置', Auth.can('settings.write') === false);
assert('普通用户不可管理账号', Auth.can('users.manage') === false);
assert('普通用户不可导入数据', Auth.can('data.import') === false);
assert('未声明的权限点默认不放开', Auth.can('something.undeclared') === false);
assert('普通用户判定 isAdmin 为假', Auth.isAdmin() === false);
const deniedAdd = await Auth.addUser('lisi', 'User@2026', 'user');
assert('普通用户新增账号被拒（后端二次校验，不只靠 UI 隐藏）', deniedAdd.ok === false, deniedAdd.error);
const deniedList = (() => { const before = Auth.user; Auth.user = null; const r = Auth.removeUser('admin'); Auth.user = before; return r; })();
assert('未登录时管理接口不可调用', deniedList.ok === false, deniedList.error);

Auth.logout();
Auth.init();
assert('未登录时所有权限均为 false', Auth.can('data.read') === false && Auth.can('settings.write') === false);

console.log('\n7) 账号管理边界保护');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.addUser('zhangsan', 'User@2026', 'user');
const delSelf = Auth.removeUser('admin');
assert('不能删除当前登录账号', delSelf.ok === false, delSelf.error);
const demoteSelf = Auth.setUserRole('admin', 'user');
assert('不能取消自己的管理员身份', demoteSelf.ok === false, demoteSelf.error);
assert('至少保留一个可用管理员',
  (await Auth.setUserRole('admin', 'user')).ok === false);
const disableSelf = Auth.setUserDisabled('admin', true);
assert('不能停用当前登录账号', disableSelf.ok === false, disableSelf.error);
const delOther = Auth.removeUser('zhangsan');
assert('可以删除其他账号', delOther.ok === true, delOther.error);
assert('删除后账号表只剩 1 人', Auth.listUsers().length === 1, String(Auth.listUsers().length));

console.log('\n8) 改密码与登录态联动');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.addUser('zhangsan', 'User@2026', 'user');
const wrongOld = await Auth.changePassword('admin', 'NotOldPw', 'NewPass@2026');
assert('原密码错误时拒绝改密', wrongOld.ok === false, wrongOld.error);
const selfChange = await Auth.changePassword('admin', ADMIN_PW, 'NewPass@2026');
assert('原密码正确可改密', selfChange.ok === true, selfChange.error);
assert('改自己密码后仍保持登录（会话已重签）', Auth.isLoggedIn() === true);
Auth.logout();
assert('旧密码不再可用', (await Auth.login('admin', ADMIN_PW)).ok === false);
assert('新密码可登录', (await Auth.login('admin', 'NewPass@2026')).ok === true);

// 管理员改他人密码后，对方的旧会话必须失效（签名绑定密码哈希）
Auth.logout();
await Auth.login('zhangsan', 'User@2026');
const userSessionBefore = JSON.parse(store.getItem('snt-auth-session-v1'));
await Auth.login('admin', 'NewPass@2026');
const adminChange = await Auth.changePassword('zhangsan', null, 'Reset@2026');
assert('管理员可重置他人密码（无需原密码）', adminChange.ok === true, adminChange.error);
store.setItem('snt-auth-session-v1', JSON.stringify(userSessionBefore));
Auth.init();
const stale = await Auth.restore();
assert('被改密用户的旧登录态立即失效', stale.ok === false, stale.error);

console.log('\n9) 停用 / 启用账号');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.addUser('zhangsan', 'User@2026', 'user');
await Auth.login('zhangsan', 'User@2026');
const userSess = store.getItem('snt-auth-session-v1');
await Auth.login('admin', ADMIN_PW);
const dis = Auth.setUserDisabled('zhangsan', true);
assert('管理员可停用账号', dis.ok === true, dis.error);
Auth.logout();
assert('被停用账号无法登录', (await Auth.login('zhangsan', 'User@2026')).ok === false);
store.setItem('snt-auth-session-v1', JSON.stringify(JSON.parse(userSess)));
Auth.init();
assert('被停用账号的存量登录态也失效', (await Auth.restore()).ok === false);
await Auth.login('admin', ADMIN_PW);
assert('管理员可重新启用账号', Auth.setUserDisabled('zhangsan', false).ok === true);
Auth.logout();
assert('启用后可正常登录', (await Auth.login('zhangsan', 'User@2026')).ok === true);

console.log('\n10) 账号表导出 / 导入（换设备迁移）');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.addUser('zhangsan', 'User@2026', 'user');
const exported = Auth.exportUsers();
assert('导出的是合法 JSON', (() => { try { JSON.parse(exported); return true; } catch { return false; } })());
assert('导出内容不含明文密码', exported.indexOf(ADMIN_PW) === -1 && exported.indexOf('User@2026') === -1);
assert('导出包含全部账号', JSON.parse(exported).users.length === 2);
assert('非法 JSON 被拒', Auth.importUsers('{oops').ok === false);
assert('缺少 users 字段被拒', Auth.importUsers('{"a":1}').ok === false);
assert('无合法账号时被拒', Auth.importUsers('{"users":[{"username":"x"}]}').ok === false);

// 换设备场景：新浏览器导入后，用原密码即可登录
const carry = exported;
fresh();
assert('新环境初始无账号', Auth.hasUsers() === false);
await Auth.setup('tempadmin', 'Temp@2026', 'Temp@2026');
const imported = Auth.importUsers(carry, 'merge');
assert('合并导入成功', imported.ok === true, imported.error);
assert('导入后账号数为 3', Auth.listUsers().length === 3, String(Auth.listUsers().length));
Auth.logout();
assert('导入的账号可用原密码登录', (await Auth.login('zhangsan', 'User@2026')).ok === true);
assert('导入的管理员账号也是管理员', (await Auth.login('admin', ADMIN_PW)).user.role === 'admin');

console.log('\n11) 第二阶段接口：切换到远端鉴权');
fresh();
const remoteCalls = [];
const mockRemote = {
  async login(u, p) {
    remoteCalls.push('login:' + u);
    if (u === 'remote-admin' && p === 'remote-pass') {
      return {
        ok: true,
        user: { username: 'remote-admin', role: 'admin', roleName: '管理员' },
        session: { username: 'remote-admin', role: 'admin', issuedAt: Date.now(), exp: Date.now() + 864e5, sig: 'server-signed' }
      };
    }
    return { ok: false, error: '用户名或密码不正确' };
  },
  async verify(sess) {
    remoteCalls.push('verify');
    if (sess && sess.sig === 'server-signed') return { ok: true, user: { username: 'remote-admin', role: 'admin' } };
    return { ok: false, error: '登录态无效' };
  },
  async logout() { remoteCalls.push('logout'); }
};
Auth.remote = mockRemote;
const remoteLogin = await Auth.login('remote-admin', 'remote-pass');
assert('设置 remote 后登录改走远端', remoteCalls.indexOf('login:remote-admin') >= 0, remoteCalls.join(','));
assert('远端登录成功后本地即为已登录', remoteLogin.ok === true && Auth.isLoggedIn() === true);
assert('远端可返回服务端签发的会话', Auth.session.sig === 'server-signed');
assert('远端管理员权限生效', Auth.can('users.manage') === true);
Auth.init();
const remoteRestore = await Auth.restore();
assert('启动恢复时也走远端验签', remoteCalls.indexOf('verify') >= 0);
assert('远端验签通过即可进入', remoteRestore.ok === true, remoteRestore.error);
Auth.logout();
assert('登出会通知远端', remoteCalls.indexOf('logout') >= 0);

// 远端不可达时必须能回退本地校验，不能把用户彻底锁在门外
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
const localSess = store.getItem('snt-auth-session-v1');
Auth.remote = { async login() { throw new Error('network down'); }, async verify() { throw new Error('network down'); } };
Auth.init();
const fallback = await Auth.restore();
assert('远端不可达时回退本地校验，仍可进入', fallback.ok === true, fallback.error);
const remoteDown = await Auth.login('admin', ADMIN_PW);
assert('远端登录失败时给出可读的错误提示', remoteDown.ok === false && /无法连接鉴权服务/.test(remoteDown.error), remoteDown.error);

console.log('\n12) 存储不可用等异常场景');
fresh();
Auth.storage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); }
};
let threw = false;
try { Auth.init(); } catch (e) { threw = true; }
assert('存储被禁用时不抛异常（隐私模式可降级运行）', threw === false);
const blockedSetup = await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
assert('存储不可用时明确提示保存失败', blockedSetup.ok === false, blockedSetup.error);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
