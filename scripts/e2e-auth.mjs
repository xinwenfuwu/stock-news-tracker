/* ============================================================
 * e2e-auth.mjs — 登录鉴权与角色权限的真实浏览器端到端验证
 *
 * 用真实的 UI 交互（填表单、点按钮、点菜单）走完整流程，不 mock 任何东西。
 * 覆盖：
 *   1) 未登录时业务脚本完全不加载，页面停在登录关卡
 *   2) 首次初始化：弱密码/两次不一致被拒，合法输入创建管理员并进入
 *   3) 刷新保持登录、退出登录回到关卡
 *   4) 密码错误被拒、正确放行
 *   5) 管理员与普通用户的界面差异 + 绕过 UI 直接调用接口仍被拒
 *   6) 篡改登录态（改角色提权）后刷新被踢回登录页
 *   7) 修改密码：改完当前登录保持、旧密码立即失效
 * 用法：node scripts/e2e-auth.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VUE_LOCAL = path.join(ROOT, '_repo_tmp', 'vue.global.prod.js');
const ADMIN_PW = 'Admin@2026';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function newPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  return { ctx, page, errors };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}

/**
 * 等到真的「进入系统」：#app 是静态 HTML，必须等 Vue mount 才算就绪。
 * 注意 playwright 的签名是 waitForFunction(fn, arg, options)，超时必须放第 3 个参数，
 * 否则 {timeout} 会被当成传给页面的 arg，超时退回默认 30s —— 出错时很难查。
 */
async function waitAppReady(page, ms) {
  const opt = { timeout: ms || 45000 };
  try {
    await page.waitForFunction(() => !document.getElementById('auth-gate'), null, opt);
  } catch (e) {
    const st = await page.evaluate(() => ({
      gate: !!document.getElementById('auth-gate'),
      vueMounted: !!(document.getElementById('app') && document.getElementById('app').__vue_app__),
      gateClass: (document.getElementById('auth-gate') || {}).className || '',
      visible: ['auth-login-form', 'auth-register-form', 'auth-setup-form', 'auth-code-panel', 'auth-reg-done']
        .filter(i => { const el = document.getElementById(i); return el && !el.hidden; }),
      msg: (document.querySelector('#auth-gate .auth-msg') || {}).textContent || '',
      sess: (localStorage.getItem('snt-auth-session-v1') || '').slice(0, 120)
    })).catch(() => null);
    throw new Error('等待进入系统超时（auth-gate 未消失）: ' + JSON.stringify(st));
  }
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, opt);
}

/** 直接以管理员身份进入（跳过表单，仅用于给后续断言准备环境） */
async function loginFresh(page) {
  await page.evaluate(async (pw) => {
    await Auth.setup('admin', pw, pw);
    AuthUI.enterApp();
  }, ADMIN_PW);
  await waitAppReady(page);
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const base = `http://127.0.0.1:${A.port}`;

  // ---------------- 1 ----------------
  console.log('1) 未登录：业务脚本完全不加载，页面停在登录关卡');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    check('显示登录关卡', await page.locator('#auth-gate').isVisible());
    check('首次使用显示「创建管理员」表单', await page.locator('#auth-setup-form').isVisible());
    check('登录表单此时不显示', !(await page.locator('#auth-login-form').isVisible()));

    const g = await page.evaluate(() => ({
      Store: typeof Store, StockAPI: typeof StockAPI,
      HotTopics: typeof HotTopics, CloudSync: typeof CloudSync,
      Auth: typeof Auth, Vue: typeof Vue
    }));
    check('业务模块 Store 未被加载', g.Store === 'undefined', g.Store);
    check('业务模块 StockAPI 未被加载', g.StockAPI === 'undefined', g.StockAPI);
    check('业务模块 HotTopics 未被加载', g.HotTopics === 'undefined', g.HotTopics);
    check('业务模块 CloudSync 未被加载', g.CloudSync === 'undefined', g.CloudSync);
    check('鉴权模块 Auth 已加载', g.Auth === 'object', g.Auth);
    check('Vue 已就绪（不涉及业务数据）', g.Vue === 'object', g.Vue);

    const covered = await page.evaluate(() => {
      const r = document.getElementById('auth-gate').getBoundingClientRect();
      return r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
    });
    check('关卡遮罩铺满全屏，应用界面不可见', covered);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // 深链同样要被拦住
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port, '#pools');
    check('未登录直接访问 #pools 深链仍停在登录关卡', await page.locator('#auth-gate').isVisible());
    check('深链下业务模块同样未加载', await page.evaluate(() => typeof Store === 'undefined'));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 2 ----------------
  console.log('\n2) 首次初始化：表单校验与创建管理员');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);

    await page.fill('#setup-username', 'admin');
    await page.fill('#setup-password', '123');
    await page.fill('#setup-confirm', '123');
    await page.click('#auth-setup-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    check('弱密码被拒并给出提示', /至少 8 位/.test(await page.locator('.auth-msg-error').innerText()));
    check('被拒后仍停留在关卡内', await page.locator('#auth-gate').isVisible());
    check('被拒后业务模块仍未加载', await page.evaluate(() => typeof Store === 'undefined'));

    await page.fill('#setup-password', ADMIN_PW);
    await page.fill('#setup-confirm', 'Admin@2027');
    await page.click('#auth-setup-form .auth-btn');
    await page.waitForFunction(() => {
      const m = document.querySelector('.auth-msg-error');
      return m && m.textContent.includes('不一致');
    }, null, { timeout: 15000 });
    check('两次密码不一致被拒', /不一致/.test(await page.locator('.auth-msg-error').innerText()));

    await page.fill('#setup-confirm', ADMIN_PW);
    await page.click('#auth-setup-form .auth-btn');
    await waitAppReady(page);

    check('合法输入后进入系统（关卡消失）', (await page.locator('#auth-gate').count()) === 0);
    const who = await page.evaluate(() => ({ u: Auth.user && Auth.user.username, r: Auth.user && Auth.user.role }));
    check('当前用户名为 admin 且角色为管理员', who.u === 'admin' && who.r === 'admin', JSON.stringify(who));
    check('进入后业务模块才被加载', await page.evaluate(() => typeof Store === 'object'));
    check('顶部显示当前用户名', (await page.locator('.user-chip').innerText()).includes('admin'));
    check('顶部显示角色徽标', (await page.locator('.user-role-tag').innerText()).includes('管理员'));

    const storedHash = await page.evaluate(() => JSON.parse(localStorage.getItem('snt-auth-users-v1'))[0].hash);
    check('密码以 PBKDF2 哈希存储', /^pbkdf2\$150000\$/.test(storedHash), storedHash.slice(0, 30));
    check('本地存储中不含明文密码', !storedHash.includes(ADMIN_PW));
    const rawDump = await page.evaluate(() => localStorage.getItem('snt-auth-users-v1'));
    check('整份账号表也不含明文密码', !rawDump.includes(ADMIN_PW));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 3 ----------------
  console.log('\n3) 刷新保持登录 / 退出登录');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);

    await page.reload({ waitUntil: 'load' });
    await waitAppReady(page);
    check('刷新后仍保持登录', await page.evaluate(() => !!(Auth && Auth.user)));
    check('刷新后直接进入，无需再次登录', (await page.locator('.user-chip').count()) === 1);

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown', { timeout: 10000 });
    check('用户菜单显示当前账号', (await page.locator('.user-dd-name').innerText()).includes('admin'));
    check('用户菜单显示登录有效期', /有效期至/.test(await page.locator('.user-dd-meta').innerText()));

    await page.click('.user-dd-item.is-danger');
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });
    check('退出后回到登录关卡', await page.locator('#auth-gate').isVisible());
    check('退出后显示的是登录表单（不再是初始化表单）', await page.locator('#auth-login-form').isVisible());
    check('退出后初始化表单不再出现', !(await page.locator('#auth-setup-form').isVisible()));
    check('退出后业务模块不再加载', await page.evaluate(() => typeof Store === 'undefined'));
    check('退出后本地会话已清除', await page.evaluate(() => localStorage.getItem('snt-auth-session-v1') === null));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 4 ----------------
  console.log('\n4) 登录：密码错误被拒、正确放行');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item.is-danger');
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });

    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'TotallyWrong1');
    await page.click('#auth-login-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    check('密码错误被拒', /用户名或密码不正确/.test(await page.locator('.auth-msg-error').innerText()));
    check('错误密码不会进入系统', await page.locator('#auth-gate').isVisible());
    check('错误密码后无会话残留', await page.evaluate(() => localStorage.getItem('snt-auth-session-v1') === null));

    await page.fill('#login-username', 'nobody');
    await page.fill('#login-password', 'TotallyWrong1');
    await page.click('#auth-login-form .auth-btn');
    await page.waitForTimeout(600);
    check('不存在的账号提示与密码错误一致（不泄露账号是否存在）',
      /用户名或密码不正确/.test(await page.locator('.auth-msg-error').innerText()));

    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', ADMIN_PW);
    await page.click('#auth-login-form .auth-btn');
    await waitAppReady(page);
    check('正确密码成功进入系统', (await page.locator('.user-chip').count()) === 1);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 5 ----------------
  console.log('\n5) 角色权限：管理员 vs 普通用户');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);

    check('管理员可见「设置」入口', (await page.locator('.header-actions button[title="设置"]').count()) === 1);
    check('管理员可见「导入数据」入口', (await page.locator('.header-actions label[title="导入数据"]').count()) === 1);

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    check('管理员菜单含「用户管理」', (await page.locator('.user-dd-item', { hasText: '用户管理' }).count()) === 1);

    await page.click('.user-dd-item:has-text("用户管理")');
    await page.waitForSelector('.um-table', { timeout: 15000 });
    check('打开用户管理弹窗', await page.locator('.modal-header h3:has-text("用户管理")').isVisible());
    check('账号表列出管理员自己', (await page.locator('.um-table tbody tr').count()) === 1);
    check('自己那行标了「当前登录」', (await page.locator('.um-self').innerText()).includes('当前登录'));

    await page.fill('.um-toolbar input[placeholder^="用户名"]', 'zhangsan');
    await page.fill('.um-toolbar input[placeholder^="初始密码"]', 'User@2026');
    await page.click('.um-toolbar button:has-text("添加")');
    await page.waitForFunction(() => document.querySelectorAll('.um-table tbody tr').length === 2, null, { timeout: 20000 });
    check('可通过界面添加普通用户', (await page.locator('.um-table tbody tr').count()) === 2);
    check('新用户角色为普通用户',
      (await page.locator('.um-table tbody tr').nth(1).locator('select').inputValue()) === 'user');

    await page.fill('.um-toolbar input[placeholder^="用户名"]', 'zhangsan');
    await page.fill('.um-toolbar input[placeholder^="初始密码"]', 'User@2026');
    await page.click('.um-toolbar button:has-text("添加")');
    await page.waitForFunction(() => {
      const t = document.querySelector('.toast');
      return t && t.textContent.includes('已存在');
    }, null, { timeout: 20000 });
    check('重复用户名被拒', true);

    await page.click('.modal-footer button:has-text("关闭")');
    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item.is-danger');
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });

    await page.fill('#login-username', 'zhangsan');
    await page.fill('#login-password', 'User@2026');
    await page.click('#auth-login-form .auth-btn');
    await waitAppReady(page);

    check('普通用户可正常登录', await page.evaluate(() => Auth.user.role === 'user'));
    check('普通用户看不到「设置」入口', (await page.locator('.header-actions button[title="设置"]').count()) === 0);
    check('普通用户看不到「导入数据」入口', (await page.locator('.header-actions label[title="导入数据"]').count()) === 0);
    check('普通用户仍能使用业务页面（导航可见）', await page.locator('.main-nav').isVisible());
    check('普通用户可以导出自己的数据', (await page.locator('.header-actions button[title="导出数据"]').count()) === 1);

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    check('普通用户菜单里没有「用户管理」', (await page.locator('.user-dd-item', { hasText: '用户管理' }).count()) === 0);
    check('普通用户菜单里有「修改密码」', (await page.locator('.user-dd-item', { hasText: '修改密码' }).count()) === 1);
    check('普通用户角色徽标显示为普通用户', (await page.locator('.user-role-tag').innerText()).includes('普通用户'));
    await page.evaluate(() => document.body.click());
    await page.waitForFunction(() => !document.querySelector('.user-dropdown'), null, { timeout: 10000 });
    check('点击菜单外可收起用户菜单', true);

    const denied = await page.evaluate(() => Auth.addUser('lisi', 'User@2026', 'user'));
    check('绕过界面直接调 addUser 仍被拒（逻辑层二次校验）', denied && denied.ok === false, JSON.stringify(denied));
    check('普通用户无清空数据权限', (await page.evaluate(() => Auth.can('data.clear'))) === false);
    check('普通用户无改设置权限', (await page.evaluate(() => Auth.can('settings.write'))) === false);
    check('普通用户仍有读写数据权限',
      (await page.evaluate(() => Auth.can('data.read') && Auth.can('data.write'))) === true);

    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('snt-auth-session-v1'));
      raw.role = 'admin';
      localStorage.setItem('snt-auth-session-v1', JSON.stringify(raw));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });
    check('篡改登录态把角色改成管理员后，刷新被踢回登录页',
      await page.locator('#auth-login-form').isVisible());
    check('被踢回后业务模块未加载', await page.evaluate(() => typeof Store === 'undefined'));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 6 ----------------
  console.log('\n6) 会话过期：过期后无法进入');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('snt-auth-session-v1'));
      raw.exp = Date.now() - 1000;
      localStorage.setItem('snt-auth-session-v1', JSON.stringify(raw));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });
    check('会话过期后刷新被拦在登录页', await page.locator('#auth-login-form').isVisible());
    check('过期时给出明确提示', /过期/.test(await page.locator('.auth-msg').innerText()));
    check('过期后本地残留会话被清理', await page.evaluate(() => localStorage.getItem('snt-auth-session-v1') === null));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 7 ----------------
  console.log('\n7) 修改密码：改完当前登录保持，旧密码立即失效');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item:has-text("修改密码")');
    await page.waitForSelector('.modal-header h3:has-text("修改密码")', { timeout: 15000 });
    check('打开修改密码弹窗', await page.locator('.um-field').first().isVisible());

    await page.fill('.um-field input[placeholder="请输入原密码"]', 'WrongOldPw');
    await page.fill('#pw-new', 'NewPw@2026');
    await page.fill('.um-field input[placeholder="再输入一次"]', 'NewPw@2026');
    await page.click('.modal-footer button:has-text("确认修改")');
    await page.waitForFunction(() => {
      const t = document.querySelector('.toast');
      return t && t.textContent.includes('原密码不正确');
    }, null, { timeout: 15000 });
    check('原密码错误时拒绝改密', true);
    check('改密失败后弹窗仍开着', await page.locator('.modal-overlay').isVisible());

    await page.fill('.um-field input[placeholder="请输入原密码"]', ADMIN_PW);
    await page.fill('#pw-new', 'NewPw@2026');
    await page.fill('.um-field input[placeholder="再输入一次"]', 'NewPw@2026');
    await page.click('.modal-footer button:has-text("确认修改")');
    await page.waitForFunction(() => !document.querySelector('.modal-overlay'), null, { timeout: 20000 });
    check('原密码正确则改密成功（弹窗关闭）', (await page.locator('.modal-overlay').count()) === 0);
    check('改完密码后当前登录保持有效', await page.evaluate(() => Auth.isLoggedIn()));

    await page.reload({ waitUntil: 'load' });
    await waitAppReady(page);
    check('改密后刷新依然保持登录（会话已重签）', (await page.locator('.user-chip').count()) === 1);

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item.is-danger');
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });

    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', ADMIN_PW);
    await page.click('#auth-login-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    check('旧密码已不可用', /用户名或密码不正确/.test(await page.locator('.auth-msg-error').innerText()));

    await page.fill('#login-password', 'NewPw@2026');
    await page.click('#auth-login-form .auth-btn');
    await waitAppReady(page);
    check('新密码可正常登录', (await page.locator('.user-chip').count()) === 1);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 8 ----------------
  console.log('\n8) 停用账号：被停用后无法登录');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.evaluate(() => Auth.addUser('lisi', 'User@2026', 'user'));

    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item:has-text("用户管理")');
    await page.waitForSelector('.um-table', { timeout: 15000 });
    await page.click('.um-table tbody tr:has-text("lisi") button:has-text("停用")');
    await page.waitForFunction(() => {
      const tr = Array.from(document.querySelectorAll('.um-table tbody tr'))
        .find(r => r.textContent.includes('lisi'));
      return tr && tr.textContent.includes('已停用');
    }, null, { timeout: 15000 });
    check('可通过界面停用账号', true);

    await page.click('.modal-footer button:has-text("关闭")');
    await page.click('.user-chip');
    await page.waitForSelector('.user-dropdown');
    await page.click('.user-dd-item.is-danger');
    await page.waitForSelector('#auth-login-form', { timeout: 30000 });

    await page.fill('#login-username', 'lisi');
    await page.fill('#login-password', 'User@2026');
    await page.click('#auth-login-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    check('被停用账号无法登录', /停用/.test(await page.locator('.auth-msg-error').innerText()));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  console.log('测试地址：' + base);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
