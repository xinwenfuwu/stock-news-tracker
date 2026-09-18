/* ============================================================
 * e2e-batch23.mjs — 验证 batch23 改动
 *   1) 全球信息-每日快讯面板宽度 516px → 600px（再加宽）
 *   2) 关键词搜索下方那段说明文字（全部消息按「题材 / 概念 / 行业」…）
 *      已从 DOM 删除
 *   3) 三维度（题材/概念/行业）每个分类右侧的百分比（bc-pct）仍然存在且非零
 *   4) 三维度 .brief-dims 仍为三栏（随面板加宽而加宽）
 *
 * 用法：node scripts/e2e-batch23.mjs
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
console.log('[css] 静态宽度断言');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
check('每日快讯 .brief-panel 宽度 516 → 600px', /\.brief-panel\s*\{[^}]*width:\s*600px/.test(css));
check('每日快讯 .brief-panel 不再 sticky（随页面滚动）', !/\.brief-panel\s*\{[^}]*position:\s*sticky/.test(css));

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
  await goPage(page, 'finance');

  // 百分比 + 删除文本 + 面板宽度 + 三栏
  await page.waitForSelector('.brief-cat .bc-pct', { timeout: 20000 }).catch(() => {});
  const pctTexts = await page.locator('.brief-cat .bc-pct').allInnerTexts();
  const bad = pctTexts.filter(t => !/^\d+(\.\d+)?%$/.test((t || '').trim()));
  check('每日快讯：所有分类右侧百分比格式正确（数字%）', bad.length === 0, 'bad=' + JSON.stringify(bad.slice(0, 5)));
  const nonZero = pctTexts.filter(t => (t || '').trim() !== '0%').length;
  check('每日快讯：存在非零百分比（占比新闻总数）', nonZero > 0, 'nonZero=' + nonZero);

  const briefPos = await page.evaluate(() => {
    const el = document.querySelector('.brief-panel');
    const cs = getComputedStyle(el);
    return { position: cs.position, width: parseInt(cs.width, 10) };
  });
  check('每日快讯：面板不再 sticky', briefPos.position !== 'sticky', 'position=' + briefPos.position);
  check('每日快讯：面板宽度约 600px', Math.abs(briefPos.width - 600) <= 8, 'width=' + briefPos.width);

  const dimsCols = await page.evaluate(() => {
    const el = document.querySelector('.brief-dims');
    if (!el) return '';
    return getComputedStyle(el).gridTemplateColumns;
  });
  const colCount = dimsCols.split(' ').filter(s => parseFloat(s) > 0).length;
  check('每日快讯：三维度 .brief-dims 仍为三栏（随面板加宽）', colCount === 3, 'cols=' + dimsCols);

  const hasDeletedText = await page.evaluate(() => document.body.innerText.includes('全部消息按'));
  check('每日快讯：关键词搜索下方说明文字已从 DOM 删除', !hasDeletedText);

  check('整轮：无脚本错误', c.errors.length === 0, c.errors.slice(0, 3).join(' | '));
  await c.ctx.close();
} catch (e) {
  fail++;
  console.log('  \u2717 E2E 运行异常：' + (e && e.message ? e.message : e));
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n=== batch23 E2E: pass=${pass} fail=${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
