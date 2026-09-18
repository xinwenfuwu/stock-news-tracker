/* ============================================================
 * e2e-batch20.mjs — 验证「跨设备免码登录（GitHub 注册表后端，无 Cloudflare）」
 *   (A) Node 单元：auth-sync 的 loginRemote 映射、isConfigured、writeRegistry 无令牌守卫；
 *       用 mock fetch 模拟同源 registry.json 读取。
 *   (B) Playwright 真浏览器：
 *       - 设置面板出现「GitHub 令牌」、旧「鉴权后端地址」已移除；
 *       - 管理员配令牌后用户管理出现「📡 同步本机账号」按钮；
 *       - 跨设备读+登录：用 Node 生成的哈希写一份临时 registry.json，全新上下文
 *         仅输账号密码即可登录成功（无需准入码）；未知用户回落本地并报错。
 *       - 无脚本错误。
 *
 * 用法：node scripts/e2e-batch20.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'accounts', 'registry.json');
const ADMIN_PW = 'Admin@2026';
const TEST_PW = 'abc12345';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ------------------------------------------------------------------ */
/* (A) Node 单元：auth-sync.js 逻辑（mock fetch 模拟同源 registry 读取） */
/* ------------------------------------------------------------------ */
await import(pathToFileURL(path.join(ROOT, 'js/auth.js')).href);
const Auth = globalThis.Auth;
const hash = await Auth.makePasswordHash(TEST_PW);

const REG = {
  version: 1, updatedAt: 123, accounts: {
    testuser: { hash, role: 'user', status: 'active', disabled: false, trialUntil: 0, quotaMonths: 0, disableDate: '', registerDate: '2026-09-18', createdAt: 1, updatedAt: 2 },
    pendingguy: { hash, role: 'user', status: 'pending', disabled: false },
    disabledguy: { hash, role: 'user', status: 'active', disabled: true }
  }
};
globalThis.fetch = async (url) => {
  if (String(url).indexOf('data/accounts/registry.json') >= 0) {
    return { ok: true, status: 200, json: async () => REG };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
await import(pathToFileURL(path.join(ROOT, 'js/auth-sync.js')).href);
const Sync = Auth.Sync;

check('isConfigured 恒为 true（同源读始终可用）', Sync.isConfigured() === true);

const r1 = await Sync.loginRemote('testuser', TEST_PW);
check('loginRemote 正确密码 + active → 返回 grant', r1.ok === true && r1.grant && r1.grant.registerDate === '2026-09-18', JSON.stringify(r1));
const r2 = await Sync.loginRemote('testuser', 'wrongpass');
check('loginRemote 错误密码 → 返回 error', r2.ok === false && /不正确/.test(r2.error || ''));
const r3 = await Sync.loginRemote('ghost', TEST_PW);
check('loginRemote 未知用户 → 返回 {}（回落本地）', Object.keys(r3).length === 0);
const r4 = await Sync.loginRemote('pendingguy', TEST_PW);
check('loginRemote pending → 返回 status=pending', r4.status === 'pending');
const r5 = await Sync.loginRemote('disabledguy', TEST_PW);
check('loginRemote disabled → 返回 status=disabled', r5.status === 'disabled');
const r6 = await Sync.fetchPending();
check('fetchPending 返回 1 个待审（pendingguy）', r6.ok === true && r6.list.length === 1 && r6.list[0].username === 'pendingguy', JSON.stringify(r6));
const w1 = await Sync.writeRegistry({ version: 1, updatedAt: null, accounts: {} });
check('writeRegistry 无令牌 → 返回错误（不泄露凭据）', w1.ok === false && /令牌/.test(w1.error || ''));
const w2 = await Sync.registerRemote('newone', TEST_PW);
check('registerRemote 无令牌 → 静默跳过（local:true）', w2 && w2.local === true);

/* ------------------------------------------------------------------ */
/* (B) Playwright 真实浏览器                                            */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
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
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href), r => r.abort());
  return { ctx, page, errors };
}
async function hardGoto(page, url, hash) {
  await page.goto(url + (hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function waitAuthReady(page) {
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForFunction(() => typeof window.Auth !== 'undefined' && typeof window.AuthUI !== 'undefined', null, { timeout: 60000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 90000 });
  await page.waitForFunction(() => { const el = document.getElementById('app'); return !!(el && el.__vue_app__); }, null, { timeout: 90000 });
}
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}
// 跨设备登录：全新上下文，仅用账号密码（读 registry.json），不走准入码
async function crossDeviceLogin(page, user, pw) {
  await waitAuthReady(page);
  const r = await page.evaluate(async (arg) => {
    const res = await Auth.login(arg.u, arg.p);
    if (res && res.ok) AuthUI.enterApp();
    return res;
  }, { u: user, p: pw });
  return r;
}

// 落盘一份临时 registry.json（含 testuser=active），供跨设备读取路径使用
const seeded = {
  version: 1, updatedAt: Date.now(), accounts: {
    testuser: { hash, role: 'user', status: 'active', disabled: false, trialUntil: 0, quotaMonths: 0, disableDate: '', registerDate: '2026-09-18', createdAt: 1, updatedAt: Date.now() }
  }
};
fs.writeFileSync(REG_PATH, JSON.stringify(seeded, null, 2));

const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
try {
  /* ===== 管理员：设置面板 + 同步按钮 ===== */
  const A = await newCtx(browser);
  await hardGoto(A.page, base);
  await bootAdmin(A.page);
  console.log('\n[web] 管理员进入应用');

  // 打开设置，校验新字段 + 旧字段已移除
  await A.page.locator('button[title="设置"]').first().click();
  await A.page.waitForSelector('.modal-overlay', { timeout: 10000 });
  const setText = await A.page.locator('.modal-overlay').innerText();
  check('设置面板含「GitHub 令牌」', /GitHub 令牌/.test(setText), setText.slice(0, 200));
  check('设置面板旧「鉴权后端地址」已移除', !/鉴权后端地址/.test(setText));
  check('设置面板旧「管理员密钥」文案已移除', !/管理员密钥/.test(setText));
  // 关闭设置
  await A.page.locator('.modal-overlay button[title="设置"]').count().catch(() => 0);
  await A.page.keyboard.press('Escape').catch(() => {});
  await A.page.locator('button', { hasText: '取消' }).first().click().catch(() => {});

  // 配令牌 → 打开设置（触发把令牌读入响应式变量）→ 关闭 → 打开用户管理 → 出现「同步本机账号」按钮
  await A.page.evaluate(() => { try { localStorage.setItem('snt-auth-admin-token', 'fake-test-token'); } catch (e) {} });
  await A.page.reload({ waitUntil: 'load', timeout: 40000 });
  await waitAppReady(A.page);
  await A.page.locator('button[title="设置"]').first().click();
  await A.page.waitForSelector('.modal-overlay', { timeout: 10000 });
  await A.page.locator('button', { hasText: '取消' }).first().click().catch(() => {});
  await A.page.locator('.user-chip').click();
  await A.page.locator('.user-dropdown .user-dd-item', { hasText: '用户管理' }).click();
  await A.page.waitForSelector('.um-pending', { timeout: 10000 }).catch(() => {});
  const umText = await A.page.locator('.um-pending').innerText().catch(() => '');
  check('用户管理出现「📡 同步本机账号」按钮（令牌已配）', /同步本机账号/.test(umText), umText.slice(0, 120));

  /* ===== 跨设备登录：全新上下文，仅账号密码 ===== */
  const B = await newCtx(browser);
  await B.page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await B.page.reload({ waitUntil: 'load', timeout: 40000 });
  const rLogin = await crossDeviceLogin(B.page, 'testuser', TEST_PW);
  check('跨设备：testuser/abc12345 登录成功', rLogin && rLogin.ok === true, JSON.stringify(rLogin));
  if (rLogin && rLogin.ok) {
    await waitAppReady(B.page);
    const entered = await B.page.evaluate(() => !!document.getElementById('app') && !document.getElementById('auth-gate'));
    check('跨设备：登录后应用已挂载（无需准入码）', entered === true);
  }

  /* ===== 回落：未知用户 → 报错且仍停在登录页 ===== */
  const C = await newCtx(browser);
  await C.page.goto(base, { waitUntil: 'load', timeout: 40000 });
  const rUnknown = await crossDeviceLogin(C.page, 'ghostuser', TEST_PW);
  check('跨设备：未知用户登录被拒（回落本地）', rUnknown && rUnknown.ok === false);
  const stillGate = await C.page.locator('#auth-gate').isVisible().catch(() => false);
  check('跨设备：未知用户仍停在登录页（auth-gate 可见）', stillGate === true);

  const errs = A.errors.concat(B.errors, C.errors).filter(e => !/gtimg|eastmoney|Failed to fetch|NetworkError|api\.github/.test(e));
  check('页面无脚本错误', errs.length === 0, errs.join(' ; '));
} catch (e) {
  console.error('E2E 异常:', e);
  fail++;
} finally {
  await browser.close();
  srv.close();
  // 还原 registry.json 为空表，避免把测试账号带进部署
  fs.writeFileSync(REG_PATH, JSON.stringify({ version: 1, updatedAt: null, accounts: {} }, null, 2));
  console.log('\n已还原 data/accounts/registry.json 为空表');
}
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
