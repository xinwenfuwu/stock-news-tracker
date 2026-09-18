/* ============================================================
 * e2e-batch24.mjs — 验证 batch24 改动
 *   1) 当日热门股票 与 当日热门板块 在顶行等宽（真浏览器实测像素）
 *   2) 尾盘买入法：筛选结果列表不再限高（max-height none），填充面板空白区
 *
 * 用法：node scripts/e2e-batch24.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
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
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com|vore\.top|ip\.sb|ipapi|unpkg\.com|toutiao\.com|openai\.com/.test(u.href), r => r.abort());
  return { ctx, page, errors };
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
async function goPage(page, key) {
  await page.evaluate((k) => { location.hash = k; }, key);
  await page.waitForTimeout(400);
}

/* ========== (A) CSS 静态断言 ========== */
console.log('[css] 静态断言');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
check('尾盘买入法结果列表不再限高（.hot-panel .tail-buy-list max-height:none 压过 .hot-list 的 360px）',
  /\.hot-panel\s+\.tail-buy-list\s*\{[^}]*max-height:\s*none/.test(css));
check('尾盘买入法结果列表不再保留 300px 限高', !/\.tail-buy-list\s*\{\s*max-height:\s*300px/.test(css));
check('顶行两外侧面板仍等宽（minmax(0,1fr) 190px minmax(0,1fr)）',
  /\.hot-top-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*190px\s*minmax\(0,\s*1fr\)/.test(css));

/* ========== (B) Playwright 真浏览器 ========== */
const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
try {
  const c = await newCtx(browser);
  const page = c.page;
  await page.addInitScript(() => {
    try { localStorage.setItem('snt-auth-users-v1', JSON.stringify([{ username: 'seed', role: 'user', hash: 'x', status: 'active', disabled: false, createdAt: 1, updatedAt: 1, logins: [] }])); } catch (e) {}
  });
  await page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await waitAuthReady(page);
  await bootAdmin(page);
  await goPage(page, 'hot');

  // 顶行两外侧面板（当日热门板块 / 当日热门股票）实测宽度
  await page.waitForSelector('.hot-top-row', { timeout: 20000 });
  await page.waitForTimeout(300);
  const w = await page.evaluate(() => {
    const row = document.querySelector('.hot-top-row');
    const panels = row.querySelectorAll(':scope > .hot-panel'); // [0]=当日热门板块, [1]=当日热门股票
    const get = el => el ? Math.round(parseFloat(getComputedStyle(el).width)) : -1;
    return { n: panels.length, board: get(panels[0]), stock: get(panels[1]) };
  });
  check('顶行存在两个外侧面板（板块 + 股票）', w.n === 2, 'n=' + w.n);
  check('当日热门股票宽度 == 当日热门板块宽度（实测像素差 ≤ 2px）',
    w.board > 0 && w.stock > 0 && Math.abs(w.board - w.stock) <= 2,
    `板块=${w.board}px 股票=${w.stock}px 差=${Math.abs(w.board - w.stock)}px`);

  // 尾盘买入法面板存在且结果区结构在 DOM 模板中（去限高后由 CSS 生效）
  const hasTailBuy = await page.evaluate(() => !!document.querySelector('.tail-buy-panel') && !!document.querySelector('.tail-buy-rubric'));
  check('尾盘买入法面板与 8 项规则区存在', hasTailBuy);

  check('整轮：无脚本错误', c.errors.length === 0, c.errors.slice(0, 3).join(' | '));
  await c.ctx.close();
} catch (e) {
  fail++;
  console.log('  \u2717 E2E 运行异常：' + (e && e.message ? e.message : e));
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n=== batch24 E2E: pass=${pass} fail=${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
