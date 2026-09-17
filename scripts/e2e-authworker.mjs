/* ============================================================
 * e2e-authworker.mjs — 验证 batch18「跨设备免码登录」真实链路
 *
 * 用户诉求（本次要彻底实现的）：
 *   普通用户在自己的设备注册 → 管理员在「用户管理」里点「通过」→
 *   用户【不需要粘贴准入码】直接登录即可。
 *
 * 机制：纯静态站无服务端，加一个 Cloudflare Worker（KV 账号表）做跨设备共享。
 *   注册 → Worker 写 pending；管理员拉 /pending → 一键 /approve；
 *   用户登录 → /login 由服务端校验密码 + 状态，通过即直接进（前端免码）。
 * 本测试用 scripts/mock-auth-worker.mjs 在本地起同一套接口，无需 Cloudflare 账户。
 *
 * 覆盖：
 *   (1) 手机注册 → 本机 pending + Worker 也 pending
 *   (2) 管理员设置页配「鉴权后端地址 + 管理员密钥」→ 打开用户管理自动看到待审
 *   (3) 管理员点「通过」→ Worker 状态变 active
 *   (4) 手机【不粘准入码】直接登录成功
 *   (5) 离线兜底：不配 Worker 时，旧「申请码 / 准入码」流程仍可用
 *
 * 用法：node scripts/e2e-authworker.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockWorker, MOCK_ADMIN_TOKEN } from './mock-auth-worker.mjs';

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
  // 起本地鉴权后端（模拟 auth-worker）
  const mock = await createMockWorker();
  const MOCK_URL = `http://127.0.0.1:${mock.port}`;
  console.log(`[mock] 鉴权后端监听 ${MOCK_URL}  (ADMIN_TOKEN=${MOCK_ADMIN_TOKEN})`);

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

    // 手机先配置「鉴权后端地址」（模拟真实：用户在设置里填过，或注册前已配）
    // 这里直接写入本机键，等价于用户在设置页填了地址；Auth.Sync 每次读取都是最新值。
    await U.page.evaluate((url) => {
      localStorage.setItem('snt-auth-worker-url', url);
    }, MOCK_URL);

    // 手机走真实注册表单
    await U.page.fill('#reg-username', 'alice');
    await U.page.fill('#reg-password', USER_PW);
    await U.page.fill('#reg-confirm', USER_PW);
    await U.page.click('#auth-register-form button[type="submit"]');
    await U.page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });

    const phoneLocal = await U.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice');
      return { hasLocal: !!u, pending: u ? (u.status === 'pending') : false };
    });
    check('手机注册成功（本机写入待审核账号）', phoneLocal.hasLocal === true && phoneLocal.pending === true,
      JSON.stringify(phoneLocal));

    // 等 Worker 也收到注册（registerRemote fire-and-forget 落库）
    const remoteSeen = await U.page.waitForFunction(async () => {
      const r = await window.Auth.Sync.statusRemote('alice');
      return !!(r && r.status && r.status !== 'none');
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('🔴 注册已同步到鉴权后端（Worker 出现 alice / pending）', remoteSeen === true);

    /* ============ 管理员配置 + 拉跨设备待审 + 一键通过 ============ */
    // 管理员在「设置」里填「鉴权后端地址 + 管理员密钥」并保存（真实 UI 路径）
    await A.page.click('button[title="设置"]', { timeout: 15000 });
    await A.page.waitForSelector('input[placeholder*="snt-auth-worker"]', { timeout: 10000 });
    await A.page.fill('input[placeholder*="snt-auth-worker"]', MOCK_URL);
    await A.page.fill('input[placeholder*="ADMIN_TOKEN"]', MOCK_ADMIN_TOKEN);
    await A.page.getByRole('button', { name: '保存设置' }).click();

    // 通过真实 UI 打开「用户管理」面板（内部会自动 loadRemotePending）
    await A.page.click('.user-chip', { timeout: 15000 });
    await A.page.waitForSelector('.user-dd-item', { timeout: 10000 });
    await A.page.locator('.user-dd-item', { hasText: '用户管理' }).click();
    await A.page.waitForSelector('.um-pending', { timeout: 15000 });

    // 跨设备待审区应自动出现 alice
    await A.page.waitForSelector('.um-pending-item', { timeout: 20000 });
    const seenInAdmin = await A.page.evaluate(() => {
      const items = [...document.querySelectorAll('.um-pending-item')];
      return items.some(el => el.textContent.indexOf('alice') >= 0);
    });
    check('🔴 管理员面板自动出现「跨设备待审：alice」', seenInAdmin === true);

    // 管理员点「通过」
    await A.page.locator('.um-pending-item', { hasText: 'alice' })
      .getByRole('button', { name: '通过' }).click();

    // 等 Worker 状态变 active
    const approved = await A.page.waitForFunction(async () => {
      const r = await window.Auth.Sync.statusRemote('alice');
      return r && r.status === 'active';
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('🔴 管理员「通过」后 Worker 状态变 active', approved === true);

    /* ============ 手机【免准入码】直接登录 ============ */
    const phoneLogin = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('alice', pw, true);
      return { ok: r.ok, error: r.error || '', remote: !!r.remote };
    }, USER_PW);
    check('🔴 手机免准入码直接登录成功', phoneLogin.ok === true, JSON.stringify(phoneLogin));
    check('登录走的是鉴权后端（remote 标志）', phoneLogin.remote === true);

    // 确认登录态真的建立
    const phoneLoggedIn = await U.page.evaluate(() => !!(Auth.isLoggedIn() && Auth.user && Auth.user.username === 'alice'));
    check('手机登录态已建立（Auth.isLoggedIn）', phoneLoggedIn === true);

    // 确认没有「等待审核」残留：再调一次 login 仍成功（幂等，不弹码）
    const phoneLogin2 = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('alice', pw, true);
      return { ok: r.ok, status: r.status || '' };
    }, USER_PW);
    check('再次登录不再被拦（状态已 active）', phoneLogin2.ok === true && phoneLogin2.status !== 'pending',
      JSON.stringify(phoneLogin2));

    /* ============ 离线兜底：不配 Worker 时旧「申请码/准入码」流程仍可用 ============ */
    const C = await newCtx(browser); // 注意：本 context 不写 snt-auth-worker-url，模拟未部署
    await hardGoto(C.page, base, '#register');
    await waitAuthReady(C.page);

    await C.page.fill('#reg-username', 'bob');
    await C.page.fill('#reg-password', USER_PW);
    await C.page.fill('#reg-confirm', USER_PW);
    await C.page.click('#auth-register-form button[type="submit"]');
    await C.page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });

    // 取 bob 的申请码（本机）
    const bobReq = await C.page.evaluate(() => {
      const r = Auth.requestCodeFor('bob');
      return r.ok ? r.requestCode : '';
    });
    check('离线兜底：bob 注册并取到申请码', /^SNTREG1/.test(bobReq), bobReq.slice(0, 12));

    // 管理员导入申请码 + 通过 + 生成准入码（旧流程，不经过 Worker）
    const bobApprove = await A.page.evaluate((code) => {
      const im = Auth.applyRequestCode(code);
      if (!im.ok) return { ok: false, error: im.error };
      const ap = Auth.approveUser('bob', 'user');
      if (!ap.ok) return { ok: false, error: ap.error };
      const ac = Auth.approveCodeFor('bob');
      return { ok: ac.ok, error: ac.error || '', code: ac.approveCode || '' };
    }, bobReq);
    check('离线兜底：管理员导入+通过并生成准入码', bobApprove.ok === true, JSON.stringify(bobApprove));
    const bobApproveCode = bobApprove.code;

    // bob 登录（应被拦 → 引导 → 粘贴准入码 → 登录）
    await C.page.evaluate(() => { try { Auth.logout(); } catch (e) {} });
    await hardGoto(C.page, base);
    await waitAuthReady(C.page);
    await C.page.fill('#login-username', 'bob');
    await C.page.fill('#login-password', USER_PW);
    await C.page.click('#auth-login-form button[type="submit"]');
    await C.page.waitForTimeout(600);
    check('离线兜底：未配 Worker 时登录被拦并出现引导',
      (await C.page.locator('#auth-guide-code').count()) === 1);
    await C.page.click('#auth-guide-code');
    await C.page.waitForSelector('#auth-code-panel:not([hidden])', { timeout: 15000 });
    await C.page.fill('#auth-code-input', bobApproveCode);
    await C.page.click('#auth-code-submit');
    await C.page.waitForTimeout(600);
    const bobApplied = await C.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'bob');
      return !!u;
    });
    check('离线兜底：bob 粘贴准入码后本机账号已落地', bobApplied === true);

    await C.page.fill('#login-username', 'bob');
    await C.page.fill('#login-password', USER_PW);
    await C.page.click('#auth-login-form button[type="submit"]');
    await C.page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 30000 })
      .catch(() => ({}));
    const bobLoggedIn = await C.page.evaluate(() => Auth.isLoggedIn() && Auth.user && Auth.user.username === 'bob');
    check('离线兜底：bob 凭准入码登录成功（旧流程不退化）', bobLoggedIn === true);

    /* ============ 无 JS 运行时错误 ============ */
    check('无 JS 运行时错误（手机）', U.errors.length === 0, U.errors.join(' | '));
    check('无 JS 运行时错误（管理员）', A.errors.length === 0, A.errors.join(' | '));
    check('无 JS 运行时错误（离线兜底设备）', C.errors.length === 0, C.errors.join(' | '));

    await U.ctx.close();
    await C.ctx.close();
    await A.ctx.close();
  } catch (e) {
    fail++;
    console.log('\n!! 脚本异常: ' + (e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
    srv.close();
    mock.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
