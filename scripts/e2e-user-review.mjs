/* ============================================================
 * e2e-user-review.mjs — 用户管理新增能力的真实浏览器端到端验证
 *
 * 覆盖本轮需求：
 *   1) 登录页自助注册：密码规则（字母+数字）、账号不可重复、表单校验
 *   2) 先注册 → 管理员审核通过 → 才能登录（未审核/被驳回一律拦住）
 *   3) 用户管理表格：密码显示/隐藏、登录 IP、登录时间、使用时长
 *   4) 登录记录展开：时间 / IP / 归属地 / 设备 / 本次在线
 *   5) 跨设备通道：申请码 → 管理员导入并审核 → 准入码 → 用户粘贴后登录
 *   6) 与「暂停数据刷新」既有约定的兼容：暂停时不再自动查询第三方 IP
 *
 * IP 接口一律用本地 route 伪造（203.0.113.9 / 广东省 深圳市 · 电信），
 * 保证断言确定、不依赖外网。
 * 用法：node scripts/e2e-user-review.mjs
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
const USER_PW = 'Zhangsan1';

const FAKE_IP = '203.0.113.9';
const FAKE_LOC = '广东省 深圳市 · 电信';

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

/** 新建浏览器上下文：伪造 Vue 与 IP 接口，并统计 IP 查询次数 */
async function newPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const counts = { ip: 0 };
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route('**/api.vore.top/**', r => {
    counts.ip++;
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ code: 200, ipinfo: { text: FAKE_IP }, ipdata: { info1: '广东省', info2: '深圳市', isp: '电信' } })
    });
  });
  await page.route('**/api.ip.sb/**', r => {
    counts.ip++;
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ip: FAKE_IP, isp: 'CT' }) });
  });
  return { ctx, page, errors, counts };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}

async function waitAppReady(page) {
  // 注意：waitForFunction 的签名是 (fn, arg, options)，options 必须放第 3 个参数，
  // 否则会被当成 arg 传进页面函数，超时时间退回到默认的 30 秒。
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, { timeout: 45000 });
}

/** 在登录表单里登录；失败时把界面上的错误提示与现场信息原样抛出来，便于定位 */
async function loginViaForm(page, username, password) {
  // 直接给 input 赋值并派发 input 事件：登录表单是原生表单，不走 v-model，
  // 这样写可以彻底避开「视图刚切换完、Playwright fill 的可操作性检查与 DOM 更新竞态」的问题。
  await page.evaluate(([u, p]) => {
    const ui = document.getElementById('login-username');
    const pi = document.getElementById('login-password');
    ui.value = u;
    pi.value = p;
    ui.dispatchEvent(new Event('input', { bubbles: true }));
    pi.dispatchEvent(new Event('input', { bubbles: true }));
  }, [username, password]);
  await page.click('#auth-login-form .auth-btn');
  await page.waitForFunction(() => {
    const gone = !document.getElementById('auth-gate');
    const err = document.querySelector('.auth-msg-error');
    return gone || !!err;
  }, null, { timeout: 40000 });
  const info = await page.evaluate(() => {
    const m = document.querySelector('.auth-msg-error');
    const ui = document.getElementById('login-username');
    return {
      err: m ? m.textContent : '',
      typedU: ui ? ui.value : '(gate 已移除)',
      inApp: typeof Auth !== 'undefined' && !!Auth.user
    };
  });
  if (info.err) {
    throw new Error('登录「' + username + '」失败：' + info.err
      + '（表单里的用户名=' + JSON.stringify(info.typedU) + '，已登录=' + info.inApp + '）');
  }
  await waitAppReady(page);
}

/** 直接建管理员并进入（跳过表单，用于准备环境） */
async function loginFresh(page, pw = ADMIN_PW) {
  await page.evaluate(async (p) => {
    await Auth.setup('admin', p, p);
    AuthUI.enterApp();
  }, pw);
  await waitAppReady(page);
}

async function logoutViaMenu(page) {
  await page.click('.user-chip');
  await page.waitForSelector('.user-dropdown', { timeout: 10000 });
  await page.click('.user-dd-item.is-danger');
  await page.waitForSelector('#auth-login-form', { timeout: 30000 });
}

async function openUserManage(page) {
  await page.click('.user-chip');
  await page.waitForSelector('.user-dropdown', { timeout: 10000 });
  await page.click('.user-dd-item:has-text("用户管理")');
  await page.waitForSelector('.um-table, .um-empty', { timeout: 15000 });
}

/** 在登录关卡注册一个账号，返回申请码（自动适配「登录表单」或「首次使用直接显示注册表单」两种入口） */
async function registerAtGate(page, username, password) {
  if (await page.locator('#auth-login-form').isVisible()) {
    await page.click('#auth-to-register');
    await page.waitForSelector('#auth-register-form', { timeout: 10000 });
  } else {
    // 首次使用（无账号）：注册表单已直接展示，无需点入口
    await page.waitForSelector('#auth-register-form:not([hidden])', { timeout: 10000 });
  }
  await page.fill('#reg-username', username);
  await page.fill('#reg-password', password);
  await page.fill('#reg-confirm', password);
  await page.click('#auth-register-form .auth-btn');
  await page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });
  return await page.inputValue('#reg-code');
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 1 ----------------
  console.log('1) 登录页自助注册入口与密码规则');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await logoutViaMenu(page);

    check('登录表单上有「注册新账号」入口', await page.locator('#auth-to-register').isVisible());
    check('登录表单上有「粘贴准入码」入口', await page.locator('#auth-to-code').isVisible());
    check('默认不显示注册表单', !(await page.locator('#auth-register-form').isVisible()));

    await page.click('#auth-to-register');
    await page.waitForSelector('#auth-register-form', { timeout: 10000 });
    check('点击后进入注册表单', await page.locator('#auth-register-form').isVisible());
    check('进入注册表单后登录表单隐藏', !(await page.locator('#auth-login-form').isVisible()));
    check('注册表单有密码强度提示容器', (await page.locator('#reg-strength').count()) === 1);

    // 纯数字 / 纯字母 / 过短
    await page.fill('#reg-username', 'testuser');
    await page.fill('#reg-password', '12345678');
    await page.fill('#reg-confirm', '12345678');
    await page.check('#reg-remember').catch(() => {});
    await page.click('#auth-register-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    check('纯数字密码被拒', /字母/.test(await page.locator('.auth-msg-error').innerText()),
      await page.locator('.auth-msg-error').innerText());

    await page.fill('#reg-password', 'abcdefgh');
    await page.fill('#reg-confirm', 'abcdefgh');
    await page.click('#auth-register-form .auth-btn');
    await page.waitForFunction(() => {
      const m = document.querySelector('.auth-msg-error');
      return m && m.textContent.includes('数字');
    }, null, { timeout: 15000 });
    check('纯字母密码被拒', true);

    await page.fill('#reg-password', 'abc12345');
    await page.fill('#reg-confirm', 'abc1234');
    await page.click('#auth-register-form .auth-btn');
    await page.waitForFunction(() => {
      const m = document.querySelector('.auth-msg-error');
      return m && m.textContent.includes('不一致');
    }, null, { timeout: 15000 });
    check('两次密码不一致被拒', true);

    const strength = await page.evaluate(() => {
      const el = document.getElementById('reg-strength');
      return { hidden: el.hidden, cls: el.className, text: el.querySelector('span').textContent };
    });
    check('密码强度提示已实时显示', strength.hidden === false && /密码强度/.test(strength.text), JSON.stringify(strength));

    // 弱口令被拒后不应产生任何账号
    check('校验失败时不会写入账号', await page.evaluate(() => Auth.hasUsers() && Auth.listUsers().length === 1));
    check('校验失败时业务脚本仍未加载', await page.evaluate(() => typeof Store === 'undefined'));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 2 ----------------
  console.log('\n2) 注册 → 待审核 → 管理员通过 → 才能登录');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await logoutViaMenu(page);

    const code = await registerAtGate(page, 'zhangsan', USER_PW);
    check('注册后展示申请码面板', await page.locator('#auth-reg-done').isVisible());
    check('申请码带 SNTREG1 前缀', code.startsWith('SNTREG1.'), code.slice(0, 24));
    check('申请码里不含明文密码', code.indexOf(USER_PW) === -1);
    check('提到管理员审核的说明文案', /审核/.test(await page.locator('#auth-reg-done').innerText()));

    await page.click('#auth-reg-done-back');
    await page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 10000 });

    // 待审核：密码正确也进不去
    // 注：本机 6 个 context 连跑时，极少数情况下 fill 之后输入框的值会被还原成空
    //（表现为「请输入用户名和密码」，与功能无关）。这里填完立刻回读一次并补填，避免误报。
    await page.fill('#login-username', 'zhangsan');
    await page.fill('#login-password', USER_PW);
    const filled = await page.evaluate((pw) => {
      const u = document.getElementById('login-username');
      const p = document.getElementById('login-password');
      if (u.value !== 'zhangsan') { u.value = 'zhangsan'; u.dispatchEvent(new Event('input', { bubbles: true })); }
      if (p.value !== pw) { p.value = pw; p.dispatchEvent(new Event('input', { bubbles: true })); }
      return {
        u: u.value, p: p.value,
        regHidden: document.getElementById('auth-register-form').hidden,
        doneHidden: document.getElementById('auth-reg-done').hidden
      };
    }, USER_PW);
    await page.click('#auth-login-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    const pendMsg = await page.locator('.auth-msg-error').innerText();
    check('未审核账号登录被拒', /审核/.test(pendMsg), pendMsg + '　| 填表现场=' + JSON.stringify(filled));
    check('被拒后仍停在登录关卡', await page.locator('#auth-gate').isVisible());
    check('被拒后业务脚本未加载', await page.evaluate(() => typeof Store === 'undefined'));

    // 管理员登录 → 用户管理里看到待审核
    await loginViaForm(page, 'admin', ADMIN_PW);

    await openUserManage(page);
    check('用户管理出现「待审核注册申请」区', await page.locator('.um-pending').isVisible());
    check('待审核区列出 1 人', (await page.locator('.um-pending-item').count()) === 1);
    check('待审核条目显示用户名', (await page.locator('.um-pending-item .um-name').first().innerText()).includes('zhangsan'));
    check('待审核条目显示注册来源 IP', (await page.locator('.um-pending-item').first().innerText()).includes(FAKE_IP),
      await page.locator('.um-pending-item').first().innerText());
    check('待审核条目的状态徽标为「待审核」',
      (await page.locator('.um-table tbody tr').filter({ hasText: 'zhangsan' }).locator('.um-badge').innerText()).includes('待审核'),
      await page.locator('.um-table tbody tr').filter({ hasText: 'zhangsan' }).locator('.um-badge').innerText());

    // 通过
    page.once('dialog', d => d.accept());
    await page.click('.um-pending-item button:has-text("通过")');
    await page.waitForFunction(() => !document.querySelector('.um-pending'), null, { timeout: 15000 });
    check('通过后待审核区消失', (await page.locator('.um-pending').count()) === 0);
    check('通过后状态徽标变为「已通过」',
      (await page.locator('.um-table tbody tr').filter({ hasText: 'zhangsan' }).locator('.um-badge').innerText()).includes('已通过'),
      await page.locator('.um-table tbody tr').filter({ hasText: 'zhangsan' }).locator('.um-badge').innerText());

    // 退出 → 用注册时的密码登录
    await page.click('.modal-footer button:has-text("关闭")');
    await logoutViaMenu(page);
    await page.fill('#login-username', 'zhangsan');
    await page.fill('#login-password', USER_PW);
    await page.click('#auth-login-form .auth-btn');
    await waitAppReady(page);
    check('审核通过后用注册密码登录成功', (await page.locator('.user-chip').count()) === 1);
    check('普通用户看不到「用户管理」入口', await page.evaluate(async () => {
      document.querySelector('.user-chip').click();
      await new Promise(r => setTimeout(r, 200));
      const items = [...document.querySelectorAll('.user-dd-item')].map(e => e.textContent.trim());
      return !items.some(t => t.includes('用户管理'));
    }));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 3 ----------------
  console.log('\n3) 用户管理表格：密码显示 / 登录 IP / 登录时间 / 使用时长 / 登录记录');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.evaluate(async (pw) => { await Auth.addUser('lisi', pw, 'user'); }, USER_PW);
    await openUserManage(page);

    const heads = await page.locator('.um-table th').allInnerTexts();
    check('表头包含要求的 11 列（含会员额度三列）', heads.length === 11, heads.join('|'));
    check('表头含「密码」列', heads.includes('密码'));
    check('表头含「试用」列', heads.includes('试用'));
    check('表头不再有「登录IP」列（IP 改在「登录记录」里看）', !heads.includes('登录IP'));
    check('表头含「最近登录」列', heads.includes('最近登录'));
    check('表头含「使用时长」列', heads.includes('使用时长'));
    check('已去掉「创建时间」列', !heads.includes('创建时间'));

    // 密码列
    const rows = page.locator('.um-table tbody tr:not(.um-logrow)');
    const lisiRow = rows.filter({ hasText: 'lisi' });
    check('密码列默认打码', (await lisiRow.locator('.um-pw-text').innerText()).includes('••'), await lisiRow.locator('.um-pw-text').innerText());
    check('打码时不泄露明文', !(await lisiRow.innerText()).includes(USER_PW));
    await lisiRow.locator('button:has-text("显示")').click();
    await page.waitForTimeout(300);
    check('点「显示」后展示明文密码', (await lisiRow.locator('.um-pw-text').innerText()) === USER_PW,
      await lisiRow.locator('.um-pw-text').innerText());
    check('按钮变为「隐藏」', (await lisiRow.locator('.um-pw button').first().innerText()).includes('隐藏'));
    await lisiRow.locator('button:has-text("隐藏")').click();
    await page.waitForTimeout(200);
    check('点「隐藏」后重新打码', (await lisiRow.locator('.um-pw-text').innerText()).includes('••'));

    // 登录记录（admin 自己刚登录过）
    const adminRow = rows.filter({ hasText: 'admin' });
    check('最近登录列显示登录时间', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(await adminRow.locator('td').nth(8).innerText()),
      await adminRow.locator('td').nth(8).innerText());
    check('未登录过的账号显示「从未登录」', (await lisiRow.locator('td').nth(8).innerText()).includes('从未登录'));

    // 试用列（原「登录IP」列位置）：普通用户三档开通按钮，管理员显示「—」
    check('试用列有三档按钮', (await lisiRow.locator('.btn-trial').count()) === 3,
      String(await lisiRow.locator('.btn-trial').count()));
    check('试用三档文案为「试用一天 / 试用三天 / 试用一周」',
      (await lisiRow.locator('.btn-trial').allInnerTexts()).join(',') === '试用一天,试用三天,试用一周',
      (await lisiRow.locator('.btn-trial').allInnerTexts()).join(','));
    check('未开通试用时显示「未开通」', /未开通/.test(await lisiRow.locator('.um-trial-state').innerText()),
      await lisiRow.locator('.um-trial-state').innerText());
    check('管理员行不显示试用按钮（显示「—」）', (await adminRow.locator('.btn-trial').count()) === 0
      && (await adminRow.locator('td').nth(7).innerText()).trim() === '—',
      await adminRow.locator('td').nth(7).innerText());

    await adminRow.locator('button:has-text("登录记录")').click();
    await page.waitForSelector('.um-logrow', { timeout: 10000 });
    const logHeads = await page.locator('.um-log-table th').allInnerTexts();
    check('登录记录表头含时间/IP/归属地/设备/本次在线',
      logHeads.join(',') === '登录时间,登录 IP,归属地,设备,本次在线', logHeads.join(','));
    check('登录记录里有 1 条（本次登录）', (await page.locator('.um-log-table tbody tr').count()) === 1);
    const logTxt = await page.locator('.um-log-table tbody tr').first().innerText();
    check('登录记录写明 IP 与设备', logTxt.includes(FAKE_IP) && /Chrome|Firefox|WebKit|Safari/.test(logTxt), logTxt.replace(/\n/g, ' | '));
    await adminRow.locator('button:has-text("收起记录")').click();
    await page.waitForTimeout(200);
    check('再点可收起登录记录', (await page.locator('.um-logrow').count()) === 0);

    // 使用时长：先给会话心跳记 2 分钟，重开弹窗后应显示 2分钟
    check('初始使用时长未累计时显示占位', (await adminRow.locator('.um-usage').innerText()).trim() === '—',
      await adminRow.locator('.um-usage').innerText());
    await page.evaluate(() => Auth.touchSession(120));
    await page.click('.modal-footer button:has-text("关闭")');
    await openUserManage(page);
    const usage = await page.locator('.um-table tbody tr:not(.um-logrow)').filter({ hasText: 'admin' }).locator('.um-usage').innerText();
    check('心跳后使用时长显示为 2分钟', usage.trim() === '2分钟', usage);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 4 ----------------
  console.log('\n4) 驳回注册申请');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await logoutViaMenu(page);
    await registerAtGate(page, 'wangwu', 'Wangwu123');
    await page.click('#auth-reg-done-back');
    await page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 45000 });

    await loginViaForm(page, 'admin', ADMIN_PW);
    await openUserManage(page);

    page.once('dialog', d => d.accept('信息不全'));
    await page.click('.um-pending-item button:has-text("驳回")');
    await page.waitForFunction(() => !document.querySelector('.um-pending'), null, { timeout: 15000 });
    check('驳回后待审核区消失', (await page.locator('.um-pending').count()) === 0);
    const badge = await page.locator('.um-table tbody tr').filter({ hasText: 'wangwu' }).locator('.um-badge').innerText();
    check('驳回后状态徽标为「已驳回」', badge.includes('已驳回'), badge);

    await page.click('.modal-footer button:has-text("关闭")');
    await logoutViaMenu(page);
    await page.fill('#login-username', 'wangwu');
    await page.fill('#login-password', 'Wangwu123');
    await page.click('#auth-login-form .auth-btn');
    await page.waitForSelector('.auth-msg-error', { timeout: 15000 });
    const rejMsg = await page.locator('.auth-msg-error').innerText();
    check('被驳回的账号无法登录并说明原因', /未通过审核/.test(rejMsg), rejMsg);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 5 ----------------
  console.log('\n5) 跨设备：申请码 → 管理员导入并审核 → 准入码 → 用户粘贴后登录');
  {
    // 管理员设备
    const adminDev = await newPage(browser);
    await gotoApp(adminDev.page, A.port);
    await loginFresh(adminDev.page);
    await logoutViaMenu(adminDev.page);

    // 用户设备（另一个浏览器上下文 = 另一台设备）：全新环境，没有任何账号
    const userDev = await newPage(browser);
    await gotoApp(userDev.page, A.port);
    check('新设备首次打开直接显示注册表单（无需被迫当管理员）',
      await userDev.page.locator('#auth-register-form').isVisible());
    check('首次使用不再提供「创建管理员」入口',
      (await userDev.page.locator('#auth-setup-form').count()) === 0);

    const reqCode = await registerAtGate(userDev.page, 'zhaoliu', 'Zhaoliu123');
    check('用户设备生成申请码', reqCode.startsWith('SNTREG1.'));
    await userDev.page.click('#auth-reg-done-back');
    await userDev.page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 45000 });
    check('用户设备本机没有管理员，无法自行通过审核',
      await userDev.page.evaluate(() => !Auth.listUsers().some(u => u.role === 'admin')));

    // 管理员设备：登入 → 粘贴申请码
    await loginViaForm(adminDev.page, 'admin', ADMIN_PW);
    await openUserManage(adminDev.page);
    check('管理员设备此时没有待审核（账号表不共享）', (await adminDev.page.locator('.um-pending').count()) === 0);

    await adminDev.page.fill('.um-code-bar input', reqCode);
    await adminDev.page.click('.um-code-bar button:has-text("导入申请")');
    await adminDev.page.waitForSelector('.um-pending', { timeout: 15000 });
    check('粘贴申请码后出现待审核条目', (await adminDev.page.locator('.um-pending-item').count()) === 1);
    check('导入的申请用户名正确',
      (await adminDev.page.locator('.um-pending-item .um-name').first().innerText()).includes('zhaoliu'));

    // 错误内容应给出可读提示
    await adminDev.page.fill('.um-code-bar input', 'SNTREG1.not-a-real-code.zzz');
    await adminDev.page.click('.um-code-bar button:has-text("导入申请")');
    await adminDev.page.waitForFunction(() => {
      const t = document.querySelector('.toast');
      return t && /不正确|不合法|校验失败|格式/.test(t.textContent);
    }, null, { timeout: 10000 });
    check('乱填的申请码被拒并给出提示', true);
    const pendCount = await adminDev.page.locator('.um-pending-item').count();
    check('非法申请码不会污染待审核列表', pendCount === 1, String(pendCount));

    // 通过 → 弹窗里复制准入码（用 dialog 的 message 拿到码）
    let approveCode = '';
    adminDev.page.once('dialog', d => { approveCode = d.message(); d.dismiss(); });
    await adminDev.page.click('.um-pending-item button:has-text("通过")');
    await adminDev.page.waitForFunction(() => !document.querySelector('.um-pending'), null, { timeout: 15000 });
    check('通过后拿到准入码', approveCode.includes('SNTACC1.'), approveCode.slice(0, 40));

    // 用户设备：粘贴准入码 → 登录
    await userDev.page.click('#auth-to-code');
    await userDev.page.waitForSelector('#auth-code-panel:not([hidden])', { timeout: 10000 });
    await userDev.page.fill('#auth-code-input', 'SNTACC1.badcode.zzz');
    await userDev.page.click('#auth-code-submit');
    await userDev.page.waitForFunction(() => {
      const m = document.querySelector('.auth-msg-error');
      return m && m.textContent.length > 0;
    }, null, { timeout: 10000 });
    check('错误准入码被拒', true);

    const codeOnly = approveCode.split('\n').find(s => s.includes('SNTACC1.')) || approveCode;
    await userDev.page.fill('#auth-code-input', codeOnly.trim());
    await userDev.page.click('#auth-code-submit');
    await userDev.page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 10000 });
    check('粘贴准入码后回到登录页并提示成功',
      /准入码已生效/.test(await userDev.page.locator('.auth-msg').innerText()),
      await userDev.page.locator('.auth-msg').innerText());
    check('用户名已自动填入登录表单', (await userDev.page.inputValue('#login-username')) === 'zhaoliu');

    await userDev.page.fill('#login-password', 'Zhaoliu123');
    await userDev.page.click('#auth-login-form .auth-btn');
    await waitAppReady(userDev.page);
    check('用户设备用注册时的密码登录成功', (await userDev.page.locator('.user-chip').count()) === 1);
    check('准入码只写入自己的账号，不会把管理员账号表整份带过来',
      await userDev.page.evaluate(() => Auth.listUsers().map(u => u.username).join(',') === 'zhaoliu'),
      await userDev.page.evaluate(() => Auth.listUsers().map(u => u.username).join(',')));
    check('管理员设备无 JS 报错', adminDev.errors.length === 0, adminDev.errors.join(' | '));
    check('用户设备无 JS 报错', userDev.errors.length === 0, userDev.errors.join(' | '));
    await adminDev.ctx.close();
    await userDev.ctx.close();
  }

  // ---------------- 6 ----------------
  console.log('\n6) 与「暂停数据自动刷新」的兼容：暂停时不自动查询第三方 IP');
  {
    const { ctx, page, errors, counts } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    const firstIp = counts.ip;
    check('未暂停时进入系统会自动查询一次 IP', firstIp >= 1, String(firstIp));
    check('IP 已写入当前登录记录',
      (await page.evaluate(() => Auth.listUsersDetail()[0].lastIp)) === FAKE_IP,
      await page.evaluate(() => Auth.listUsersDetail()[0].lastIp));

    // 打开暂停开关后刷新：不应再发起任何 IP 查询
    await page.evaluate(() => { Store.data.settings.dataPaused = true; Store.saveNow(); });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('app') && document.getElementById('app').__vue_app__, null, { timeout: 45000 });
    await page.waitForTimeout(1200);
    check('暂停后刷新不再查询 IP', counts.ip === firstIp, `before=${firstIp} after=${counts.ip}`);
    check('暂停后仍保持登录可用', (await page.locator('.user-chip').count()) === 1);
    check('暂停状态下使用时长心跳照常（本地统计，不发请求）',
      await page.evaluate(() => { const before = Auth.listUsersDetail()[0].usageSec; Auth.touchSession(30); return Auth.listUsersDetail()[0].usageSec === before + 30; }));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  A.srv.close();
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
