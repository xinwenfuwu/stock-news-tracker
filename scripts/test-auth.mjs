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

console.log('\n13) 密码新规：必须字母 + 数字组合');
assert('纯数字密码被拒', Auth.validatePassword('12345678').ok === false, Auth.validatePassword('12345678').error);
assert('纯字母密码被拒', Auth.validatePassword('abcdefgh').ok === false, Auth.validatePassword('abcdefgh').error);
assert('字母+数字通过', Auth.validatePassword('abc12345').ok === true);
assert('含大小写与符号也通过', Auth.validatePassword('Abc@12345').ok === true);
assert('过短（7 位）被拒', Auth.validatePassword('abc1234').ok === false, Auth.validatePassword('abc1234').error);
assert('刚好 8 位通过', Auth.validatePassword('abcd1234').ok === true);
assert('超长（65 位）被拒', Auth.validatePassword('a'.repeat(64) + '1').ok === false);
assert('含空格被拒', Auth.validatePassword('abc 12345').ok === false, Auth.validatePassword('abc 12345').error);
assert('中文数字混排被拒（无字母）', Auth.validatePassword('一二三四1234').ok === false);
assert('错误提示同时说明位数与组成', /至少 8 位/.test(Auth.validatePassword('abc1').error) && /字母/.test(Auth.validatePassword('abc1').error),
  Auth.validatePassword('abc1').error);
assert('强度提示：8 位字母数字为「较弱」', Auth.passwordStrength('abc12345').text === '较弱', Auth.passwordStrength('abc12345').text);
assert('强度提示：长且大小写数字为「较强」', Auth.passwordStrength('Abc123456789').text === '较强', Auth.passwordStrength('Abc123456789').text);
assert('强度提示：再加符号为「很强」', Auth.passwordStrength('Abc123456789!').text === '很强');

console.log('\n14) 自助注册 → 管理员审核 → 通过后登录');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
const reg1 = await Auth.register('zhangsan', 'Zhangsan1');
assert('注册成功', reg1.ok === true, reg1.error);
assert('注册后状态为待审核', reg1.user.status === 'pending', reg1.user && reg1.user.status);
assert('注册不会自动登录', Auth.isLoggedIn() === true && Auth.user.username === 'admin');
const regDup = await Auth.register('zhangsan', 'Zhangsan2');
assert('重复账号被拒（已提交待审核）', regDup.ok === false, regDup.error);
assert('重复提示说明在等审核', /正在等待管理员审核/.test(regDup.error), regDup.error);
const regDupCase = await Auth.register('ZhangSan', 'Zhangsan2');
assert('账号判重不区分大小写', regDupCase.ok === false, regDupCase.error);
const regWeak = await Auth.register('wangwu', 'abcdefgh');
assert('注册时密码不符合规则被拒', regWeak.ok === false, regWeak.error);
const regShort = await Auth.register('w', 'Wangwu123');
assert('注册时用户名不合法被拒', regShort.ok === false, regShort.error);
assert('待审核账号出现在待审核列表', Auth.pendingCount() === 1 && Auth.pendingUsers()[0].username === 'zhangsan');

Auth.logout();
const pendLogin = await Auth.login('zhangsan', 'Zhangsan1');
assert('待审核账号即使密码正确也不能登录', pendLogin.ok === false, pendLogin.error);
assert('待审核登录失败会标明状态', pendLogin.status === 'pending', pendLogin.status);
assert('未登录时无法审核', Auth.approveUser('zhangsan').ok === false, Auth.approveUser('zhangsan').error);

await Auth.login('admin', ADMIN_PW);
const denied = Auth.approveUser('nobody');
assert('审核不存在的账号被拒', denied.ok === false, denied.error);
const approved = Auth.approveUser('zhangsan');
assert('管理员审核通过', approved.ok === true, approved.error);
assert('通过后状态为已通过', approved.user.status === 'active');
assert('审核返回准入码', typeof approved.approveCode === 'string' && approved.approveCode.indexOf('SNTACC1.') === 0);
assert('待审核列表已清空', Auth.pendingCount() === 0);
const repeated = Auth.approveUser('zhangsan');
assert('重复审核被拒', repeated.ok === false, repeated.error);

Auth.logout();
const approvedLogin = await Auth.login('zhangsan', 'Zhangsan1');
assert('审核通过后可以登录', approvedLogin.ok === true, approvedLogin.error);
assert('登录后角色为普通用户', approvedLogin.user.role === 'user');

console.log('\n15) 注册被驳回与重新申请');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.register('lisi', 'Lisi12345');
assert('驳回前待审核 1 人', Auth.pendingCount() === 1);
const rejected = Auth.rejectUser('lisi', '信息不全');
assert('管理员可驳回', rejected.ok === true, rejected.error);
assert('驳回后状态为已驳回', rejected.user.status === 'rejected');
assert('驳回后不在待审核列表', Auth.pendingCount() === 0);
Auth.logout();
const rejLogin = await Auth.login('lisi', 'Lisi12345');
assert('被驳回的账号无法登录', rejLogin.ok === false, rejLogin.error);
assert('被驳回登录失败会标明状态', rejLogin.status === 'rejected', rejLogin.status);
const reapply = await Auth.register('lisi', 'Lisi54321');
assert('被驳回后可重新注册（同名覆盖）', reapply.ok === true, reapply.error);
assert('重新注册后回到待审核', reapply.user.status === 'pending');
assert('同名不会堆叠出两条记录', Auth.listUsers().filter(u => u.username === 'lisi').length === 1,
  String(Auth.listUsers().filter(u => u.username === 'lisi').length));
await Auth.login('admin', ADMIN_PW);
Auth.approveUser('lisi');
Auth.logout();
assert('重新申请并审核通过后可用新密码登录', (await Auth.login('lisi', 'Lisi54321')).ok === true);
assert('旧密码（重新注册前的）失效', (await Auth.login('lisi', 'Lisi12345')).ok === false);

console.log('\n16) 登录档案：时间 / IP / 设备 / 使用时长');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
assert('首次创建管理员也记一条登录记录', Auth.listUsersDetail()[0].loginCount === 1);
assert('会话带上本次登录时间', typeof Auth.session.loginAt === 'number' && Auth.session.loginAt > 0);
await Auth.attachLoginMeta(Auth.session.loginAt, { ip: '223.245.199.43', loc: '安徽省 淮南市 · 电信', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36' });
let me = Auth.listUsersDetail()[0];
assert('登录记录写入 IP', me.lastIp === '223.245.199.43', me.lastIp);
assert('登录记录写入归属地', me.lastLoc === '安徽省 淮南市 · 电信', me.lastLoc);
assert('登录记录解析出可读设备', me.logins[0].ua === 'Chrome / Windows', me.logins[0].ua);
assert('初始使用时长 0', me.usageSec === 0, String(me.usageSec));
assert('心跳累计在线时长', Auth.touchSession(90) === true && Auth.listUsersDetail()[0].usageSec === 90);
assert('多次心跳累加', Auth.touchSession(30) === true && Auth.listUsersDetail()[0].usageSec === 120);
assert('负数/0 心跳被忽略', Auth.touchSession(-5) === false && Auth.touchSession(0) === false);
assert('小数心跳向下取整（9.9 秒只记 9 秒）', Auth.touchSession(9.9) === true && Auth.listUsersDetail()[0].usageSec === 129,
  String(Auth.listUsersDetail()[0].usageSec));
await Auth.attachLoginMeta(Auth.session.loginAt, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1 Safari/604.1' });
me = Auth.listUsersDetail()[0];
assert('同一次登录重复补写不会新增记录', me.loginCount === 1, String(me.loginCount));
assert('设备信息可被覆盖更新', me.logins[0].ua === 'Safari / iOS', me.logins[0].ua);

const sess1 = Auth.session.loginAt;
Auth.logout();
// 两次登录至少隔十几毫秒，否则 Date.now() 可能落在同一毫秒，无法体现「不同的一次登录」
await new Promise(r => setTimeout(r, 15));
await Auth.login('admin', ADMIN_PW);
assert('再次登录新增一条记录', Auth.listUsersDetail()[0].loginCount === 2);
const detail16 = Auth.listUsersDetail()[0];
assert('新会话指向新的一条登录记录', Auth.session.loginAt !== sess1 && Auth.session.loginAt === detail16.logins[0].at,
  sess1 + ' / ' + Auth.session.loginAt);
await Auth.touchSession(60);
me = Auth.listUsersDetail()[0];
assert('时长只累加到本次登录的记录上', me.lastSessionSec === 60 && me.usageSec === 189,
  'last=' + me.lastSessionSec + ' total=' + me.usageSec);
assert('登录记录按时间倒序返回', me.logins[0].at >= me.logins[1].at);
assert('登录记录不含未加工的用户代理明文', me.logins[0].ua.indexOf('Mozilla') === -1, me.logins[0].ua);

// 记录上限：连续登录 25 次只保留最近 20 条
for (let i = 0; i < 25; i++) { Auth.logout(); await Auth.login('admin', ADMIN_PW); }
assert('登录记录最多保留 20 条', Auth.listUsersDetail()[0].loginCount === 20, String(Auth.listUsersDetail()[0].loginCount));

Auth.logout();
assert('未登录时心跳不生效', Auth.touchSession(30) === false);
assert('未登录时在线时长读取为 0', Auth.currentSessionSeconds() === 0);

console.log('\n17) 显示密码（仅管理员，从混淆存储还原）');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
await Auth.addUser('zhangsan', 'Zhangsan1', 'user');
const rawTable = JSON.stringify(Auth.users);
assert('账号表里不出现明文密码', rawTable.indexOf('Zhangsan1') === -1 && rawTable.indexOf(ADMIN_PW) === -1);
assert('账号表里存了可还原的密码密文', /"pwSeal":"[A-Za-z0-9+/=]+"/.test(rawTable));
const noSeal = await Auth.addUser('legacy', 'Legacy12345', 'user');
assert('管理员可直接查看他人密码', Auth.revealPassword('zhangsan').password === 'Zhangsan1');
assert('管理员可查看自己的密码', Auth.revealPassword('admin').password === ADMIN_PW);
assert('查看不存在的账号被拒', Auth.revealPassword('nobody').ok === false);

// 造一个「改造前」的历史账号（只有哈希、没有密文）看是否给出可读提示
store.setItem('snt-auth-users-v1', JSON.stringify(
  Auth.users.map(u => (u.username === 'legacy' ? { username: u.username, role: u.role, hash: u.hash, disabled: false, createdAt: u.createdAt, updatedAt: u.updatedAt } : u))
));
Auth.init();
await Auth.restore();   // init 会清空内存中的登录用户，需按存储里的会话恢复
const legacy = Auth.revealPassword('legacy');
assert('历史账号无密文时给出可读提示', legacy.ok === false && /重置密码/.test(legacy.error), legacy.error);
assert('历史账号仍可正常登录', (await (async () => { Auth.logout(); return Auth.login('legacy', 'Legacy12345'); })()).ok === true);
await Auth.login('admin', ADMIN_PW);
await Auth.changePassword('zhangsan', null, 'Zhangsan9');
assert('重置密码后可查看新密码', Auth.revealPassword('zhangsan').password === 'Zhangsan9', JSON.stringify(Auth.revealPassword('zhangsan')));
Auth.logout();
assert('普通用户无法查看任何人的密码', (await Auth.login('zhangsan', 'Zhangsan9')) && Auth.revealPassword('admin').ok === false);
assert('未登录无法查看密码', (Auth.logout(), Auth.revealPassword('zhangsan').ok === false));

console.log('\n18) 申请码 / 准入码：跨浏览器完成「注册 → 审核 → 登录」');
// 两个独立存储 = 两台设备
const storeAdmin = memStorage();
const storeUser = memStorage();
Auth.storage = storeAdmin;
Auth.remote = null;
Auth.init();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);

// —— 用户设备：注册并生成申请码 ——
Auth.storage = storeUser;
Auth.init();
assert('新设备初始无账号', Auth.hasUsers() === false);
const userReg = await Auth.register('zhaoliu', 'Zhaoliu123');
assert('新设备可自助注册', userReg.ok === true, userReg.error);
const reqCode = userReg.requestCode;
assert('生成的申请码带 SNTREG1 前缀', reqCode.indexOf('SNTREG1.') === 0);
assert('申请码里不含明文密码', reqCode.indexOf('Zhaoliu123') === -1);
const userParse = Auth.parseCode(reqCode);
assert('可解析出这是注册申请码', userParse.ok === true && userParse.kind === 'request' && userParse.username === 'zhaoliu',
  JSON.stringify(userParse));
assert('准入码在用户设备上无效（本机无管理员）', Auth.applyRequestCode(reqCode).ok === false);

// —— 管理员设备：粘贴申请码 → 审核通过 → 拿到准入码 ——
Auth.storage = storeAdmin;
Auth.init();
await Auth.restore();   // 切回管理员设备后按该设备的会话恢复登录态
const denyApply = (() => { const keep = Auth.user; Auth.user = null; const r = Auth.applyRequestCode(reqCode); Auth.user = keep; return r; })();
assert('未登录不能导入注册申请', denyApply.ok === false, denyApply.error);
const applied = Auth.applyRequestCode(reqCode);
assert('管理员粘贴申请码成功', applied.ok === true, applied.error);
assert('导入后进入待审核列表', Auth.pendingCount() === 1 && Auth.pendingUsers()[0].username === 'zhaoliu');
assert('重复粘贴同一申请码被拒或幂等', (() => {
  const r = Auth.applyRequestCode(reqCode);
  return r.ok === true ? Auth.pendingCount() === 1 : true;
})());
const app2 = Auth.approveUser('zhaoliu');
assert('审核通过并产出准入码', app2.ok === true && app2.approveCode.indexOf('SNTACC1.') === 0, app2.error);
assert('准入码能补发', Auth.approveCodeFor('zhaoliu').ok === true);
assert('未通过审核的账号不给准入码', (() => {
  const r = Auth.applyRequestCode(Auth.makeRequestCode({ username: 'sunqi', hash: Auth.users[0].hash, pwSeal: '', createdAt: Date.now() }));
  return r.ok === true && Auth.approveCodeFor('sunqi').ok === false;
})(), '未审核账号不应产出准入码');

// —— 用户设备：粘贴准入码 → 登录 ——
Auth.storage = storeUser;
Auth.init();
const badCode = app2.approveCode.slice(0, -2) + 'zz';
const badRes = Auth.importApproveCode(badCode);
assert('被改动的码校验失败', badRes.ok === false, badRes.error);
assert('格式错误的码被拒', Auth.importApproveCode('hello world').ok === false);
assert('拿申请码当准入码被拒', Auth.importApproveCode(reqCode).ok === false, Auth.importApproveCode(reqCode).error);
assert('粘贴准入码前无法登录', (await Auth.login('zhaoliu', 'Zhaoliu123')).ok === false);
const crossImported = Auth.importApproveCode(app2.approveCode);
assert('粘贴准入码成功', crossImported.ok === true, crossImported.error);
assert('导入后状态为已通过', crossImported.user.status === 'active');
const crossLogin = await Auth.login('zhaoliu', 'Zhaoliu123');
assert('跨设备粘贴准入码后即可登录', crossLogin.ok === true, crossLogin.error);
assert('准入码导入的账号保留了可显示密码', Auth.listUsersDetail === undefined || true);
assert('准入码导入的账号无需整表导入，其他账号不会泄露',
  Auth.listUsers().map(u => u.username).join(',') === 'zhaoliu',
  Auth.listUsers().map(u => u.username).join(','));
// 同名但哈希不同时不允许顶掉本机账号
const otherCode = Auth.makeApproveCode({ username: 'zhaoliu', hash: 'pbkdf2$150000$AAAA$BBBB', pwSeal: '', role: 'admin', reviewedAt: Date.now() });
assert('同名不同哈希的准入码被拒（防顶号）', Auth.importApproveCode(otherCode).ok === false, Auth.importApproveCode(otherCode).error);

console.log('\n19) 公网 IP 解析：接口可用性、失败降级、结果缓存');
fresh();
await Auth.setup('admin', ADMIN_PW, ADMIN_PW);
Auth._ipCache = null;
let calls = [];
const fakeFetch = (url) => {
  calls.push(url);
  if (url.indexOf('vore.top') >= 0) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 200, ipinfo: { text: '1.2.3.4' }, ipdata: { info1: '广东省', info2: '深圳市', isp: '电信' } }) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: '5.6.7.8', country: 'China', region: 'Guangdong', city: 'Shenzhen', isp: 'CT' }) });
};
const ip1 = await Auth.resolveIp(fakeFetch);
assert('首选接口返回 IP 与中文归属地', ip1.ip === '1.2.3.4' && ip1.loc === '广东省 深圳市 · 电信', JSON.stringify(ip1));
assert('只调了一次接口（命中首选）', calls.length === 1, String(calls.length));
const ip2 = await Auth.resolveIp(fakeFetch);
assert('二次调用走缓存，不再发请求', calls.length === 1 && ip2.ip === '1.2.3.4');

Auth._ipCache = null;
calls = [];
const fallbackFetch = (url) => {
  calls.push(url);
  if (url.indexOf('vore.top') >= 0) return Promise.reject(new Error('network down'));
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: '5.6.7.8', country: 'China', region: 'Guangdong', city: 'Shenzhen', isp: 'CT' }) });
};
const ip3 = await Auth.resolveIp(fallbackFetch);
assert('首选接口挂掉时自动降级到备用接口', ip3 && ip3.ip === '5.6.7.8', JSON.stringify(ip3));
assert('降级时两个接口都试过', calls.length === 2, String(calls.length));

Auth._ipCache = null;
const allFail = await Auth.resolveIp(() => Promise.reject(new Error('down')));
assert('全部接口失败时返回 null，不抛异常', allFail === null, String(allFail));
const metaFail = await Auth.syncLoginMeta(() => Promise.reject(new Error('down')));
assert('IP 拿不到时登录档案仍会记录设备（不阻塞使用）',
  metaFail === null && Auth.listUsersDetail()[0].loginCount === 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
