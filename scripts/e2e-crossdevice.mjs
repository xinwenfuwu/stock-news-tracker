/* ============================================================
 * e2e-crossdevice.mjs — 复现并验证「跨设备注册→授权→登录」真实链路
 *
 * 用户报障（本次要彻底解决的）：
 *   手机注册 → 把申请码发给管理员 → 管理员导入并「授权三天」→
 *   用户登录却一直提示「该账号正在等待管理员审核」；
 *   用户又用电脑登录，结果又回到申请码、管理员再导入提示「已存在」，
 *   手机和电脑都登不进。
 *
 * 根因（已修）：
 *   PBKDF2 随机盐 → 同一密码在每台设备算出的 hash 都不同。
 *   旧的 importApproveCode 要求本机账号 hash === 准入码 hash，否则报错「不匹配」。
 *   管理员那边的准入码只带一份 hash（来自用户最初注册的手机），
 *   电脑注册的账号 hash 不同 → 电脑永远解不开锁。
 *
 *   修复：本机账号仍是「待审核、从未登录过」时，粘贴准入码直接用码里的权威
 *   hash 覆盖本机，用户用原密码即可登录（verifyPassword 对相同密码必为真）。
 *   这样同一串准入码在手机/电脑都生效。
 *
 * 本测试用 3 个独立 browser context 模拟「手机 / 管理员 / 电脑」三台设备，
 * 完整重演用户链路，断言电脑也能凭同一串准入码登录。
 *
 * 用法：node scripts/e2e-crossdevice.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const USER_PW = 'User@2026pass';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
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

async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  return { ctx, page, errors };
}

async function hardGoto(page, url, hash) {
  await page.goto(url + (hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function waitAuthReady(page) {
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForFunction(
    () => typeof window.Auth !== 'undefined' && typeof window.AuthUI !== 'undefined',
    null, { timeout: 60000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 90000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, { timeout: 90000 });
}
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}

(async () => {
  const { srv, port } = await serveStatic(ROOT);
  const base = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch();

  try {
    /* ============ 设备 A：管理员 ============ */
    const A = await newCtx(browser);
    await hardGoto(A.page, base);
    await waitAuthReady(A.page);
    await bootAdmin(A.page);
    console.log('\n[设备A] 管理员已起号并进入应用');

    /* ============ 设备 U：用户手机 ============ */
    const U = await newCtx(browser);
    await hardGoto(U.page, base, '#register');
    await waitAuthReady(U.page);

    // 手机走真实注册表单
    await U.page.fill('#reg-username', 'alice');
    await U.page.fill('#reg-password', USER_PW);
    await U.page.fill('#reg-confirm', USER_PW);
    await U.page.click('#auth-register-form button[type="submit"]');
    await U.page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });
    const reqCodeU = await U.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      const r = Auth.requestCodeFor('alice');
      return { hasLocal: !!u, code: r.ok ? r.requestCode : '' };
    });
    check('手机注册成功（本机待审核账号已写入）', reqCodeU.hasLocal === true);
    check('手机拿到申请码（SNTREG1 开头）', /^SNTREG1/.test(reqCodeU.code), reqCodeU.code.slice(0, 12));

    // 手机未拿准入码前登录 → 应被拦下
    const phoneLoginBefore = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('alice', pw, true);
      return { ok: r.ok, status: r.status || '' };
    }, USER_PW);
    check('手机审核前登录被拦下（pending）', !phoneLoginBefore.ok && phoneLoginBefore.status === 'pending',
      JSON.stringify(phoneLoginBefore));

    /* ============ 管理员导入申请码 + 授权三天 ============ */
    const adminImport = await A.page.evaluate((code) => {
      const im = Auth.applyRequestCode(code);
      if (!im.ok) return { ok: false, error: im.error };
      const g = Auth.grantTrial('alice', 3);
      return { ok: g.ok, error: g.error || '', until: g.untilText || '', code: g.approveCode || '' };
    }, reqCodeU.code);
    check('管理员导入申请码成功', adminImport.ok === true, JSON.stringify(adminImport));
    check('管理员开通三天试用并生成准入码（SNTACC1）', /^SNTACC1/.test(adminImport.code), adminImport.code.slice(0, 12));
    const approveCode = adminImport.code;

    /* ============ 手机：粘贴准入码 → 登录成功 ============ */
    // 先模拟「登录被拦 → 出现引导 → 点粘贴准入码 → 粘贴 → 回登录 → 用原密码登录」
    await U.page.evaluate(() => { try { Auth.logout(); } catch (e) {} });
    await hardGoto(U.page, base);
    await waitAuthReady(U.page);
    await U.page.fill('#login-username', 'alice');
    await U.page.fill('#login-password', USER_PW);
    await U.page.click('#auth-login-form button[type="submit"]');
    await U.page.waitForTimeout(600);
    check('手机登录被拦后出现「我去粘贴准入码」引导',
      (await U.page.locator('#auth-guide-code').count()) === 1);
    await U.page.click('#auth-guide-code');
    await U.page.waitForSelector('#auth-code-panel:not([hidden])', { timeout: 15000 });
    await U.page.fill('#auth-code-input', approveCode);
    await U.page.click('#auth-code-submit');
    await U.page.waitForTimeout(600);
    const phoneCodeApplied = await U.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      return { applied: !!u, trial: !!(u && u.trialUntil && u.trialUntil > Date.now()) };
    });
    check('🔴 手机粘贴准入码后本机带上试用期', phoneCodeApplied.applied && phoneCodeApplied.trial === true,
      JSON.stringify(phoneCodeApplied));

    // 用原密码登录
    await U.page.fill('#login-username', 'alice');
    await U.page.fill('#login-password', USER_PW);
    await U.page.click('#auth-login-form button[type="submit"]');
    await U.page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 30000 })
      .catch(() => ({}));
    const phoneLoggedIn = await U.page.evaluate(() => Auth.isLoggedIn() && Auth.user && Auth.user.username === 'alice');
    check('🔴 手机凭原密码登录成功（闭环打通）', phoneLoggedIn === true);

    /* ============ 设备 C：用户电脑（关键场景）============ */
    const C = await newCtx(browser);
    await hardGoto(C.page, base, '#register');
    await waitAuthReady(C.page);

    // 电脑同样用户名注册（同一密码 → 但 PBKDF2 随机盐 → 本机 hash 与手机不同）
    await C.page.fill('#reg-username', 'alice');
    await C.page.fill('#reg-password', USER_PW);
    await C.page.fill('#reg-confirm', USER_PW);
    await C.page.click('#auth-register-form button[type="submit"]');
    await C.page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });
    const compLocal = await C.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      return { hash: u ? u.hash : '', pending: u ? (u.status === 'pending') : false };
    });
    const phoneLocal = await U.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      return u ? u.hash : '';
    });
    check('电脑与手机的本机密码哈希不同（随机盐所致）',
      compLocal.hash && phoneLocal && compLocal.hash !== phoneLocal,
      'comp=' + (compLocal.hash || '').slice(-8) + ' phone=' + (phoneLocal || '').slice(-8));
    check('电脑账号仍为待审核', compLocal.pending === true);

    // 电脑登录 → 被拦 → 引导 → 粘贴【同一串】准入码
    await C.page.evaluate(() => { try { Auth.logout(); } catch (e) {} });
    await hardGoto(C.page, base);
    await waitAuthReady(C.page);
    await C.page.fill('#login-username', 'alice');
    await C.page.fill('#login-password', USER_PW);
    await C.page.click('#auth-login-form button[type="submit"]');
    await C.page.waitForTimeout(600);
    check('电脑登录被拦（pending 引导出现）', (await C.page.locator('#auth-guide-code').count()) === 1);
    await C.page.click('#auth-guide-code');
    await C.page.waitForSelector('#auth-code-panel:not([hidden])', { timeout: 15000 });
    await C.page.fill('#auth-code-input', approveCode);
    await C.page.click('#auth-code-submit');
    await C.page.waitForTimeout(600);

    // 这里是修复前会失败的关键断言：本机 hash 与码里 hash 不同，旧逻辑报「不匹配」；
    // 修复后：待审核账号直接用码里的 hash 覆盖，粘贴成功。
    const compCodeApplied = await C.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      return { applied: !!u, trial: !!(u && u.trialUntil && u.trialUntil > Date.now()) };
    });
    check('🔴 电脑粘贴【同一串】准入码成功（多设备 hash 不再拦）',
      compCodeApplied.applied && compCodeApplied.trial === true, JSON.stringify(compCodeApplied));

    // 电脑用原密码登录
    await C.page.fill('#login-username', 'alice');
    await C.page.fill('#login-password', USER_PW);
    await C.page.click('#auth-login-form button[type="submit"]');
    await C.page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 30000 })
      .catch(() => ({}));
    const compLoggedIn = await C.page.evaluate(() => Auth.isLoggedIn() && Auth.user && Auth.user.username === 'alice');
    check('🔴 电脑凭原密码登录成功（同一账号手机+电脑都能用）', compLoggedIn === true);

    // 反向回归：已通过（非待审核）账号遇到不匹配的码，仍应拒绝（不误覆盖正常账号）
    const rejectCase = await C.page.evaluate((code) => {
      // 伪造一个「用户名同名、但 hash 完全不同且已通过」的码不可行（码签名），
      // 这里只验证：给一个完全无关的码不会把 alice 顶掉
      const r = Auth.importApproveCode('SNTACC1.xxxx.yyy');
      return { ok: r.ok, error: r.error || '' };
    }, approveCode);
    check('乱码准入码被拒（不顶掉正常账号）', rejectCase.ok === false, JSON.stringify(rejectCase));

    check('无 JS 运行时错误（手机）', U.page.error === undefined ? U.errors.length === 0 : U.errors.length === 0, U.errors.join(' | '));
    check('无 JS 运行时错误（电脑）', C.errors.length === 0, C.errors.join(' | '));
    check('无 JS 运行时错误（管理员）', A.errors.length === 0, A.errors.join(' | '));

    await U.ctx.close();
    await C.ctx.close();
    await A.ctx.close();
  } catch (e) {
    fail++;
    console.log('\n!! 脚本异常: ' + (e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
