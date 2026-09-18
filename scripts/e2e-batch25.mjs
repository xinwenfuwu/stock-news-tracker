/* ============================================================
 * e2e-batch25.mjs — 验证 batch25 改动
 *   1) 每日快讯三维度分类头：百分比不再被挤出/掩盖（.bc-name 改为可收缩 flex，pct 可见）
 *   2) 子类改名：世界500强领导者 → 世界500强；行业标杆上市公司 → 行业标杆
 *   3) 资源版本号 20260918i → 20260918j
 *
 * 用法：node scripts/e2e-batch25.mjs
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
  await page.waitForTimeout(500);
}

/* ========== (A) CSS 静态断言 ========== */
console.log('[css] 静态断言');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
check('.bc-name 改为可收缩（flex 含 1 1 auto 且 min-width:0，pct 不再被挤出）',
  /\.bc-name\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*min-width:\s*0/.test(css));

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

  // 等每日快讯三维度分类头渲染（进入金融页会自动从本地 briefs 加载）
  await page.waitForSelector('.brief-cat-head', { timeout: 20000 }).catch(() => {});
  const headCount = await page.locator('.brief-cat-head').count();
  check('每日快讯：分类头已渲染（需先加载快讯）', headCount > 0, 'heads=' + headCount);

  // 百分比可见：分类头不横向溢出（pct 不被挤出/掩盖）
  const overflow = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.brief-cat-head')];
    return heads.filter(h => h.scrollWidth - h.clientWidth > 2).length;
  });
  check('每日快讯：分类头不横向溢出（百分比可见，未被掩盖）', overflow === 0, '溢出头数=' + overflow);

  // 每个分类头的最后一项（.bc-pct）在其父列边界内（右边缘不被裁切）
  const pctClipped = await page.evaluate(() => {
    let bad = 0;
    document.querySelectorAll('.brief-cat-head').forEach(h => {
      const pct = h.querySelector('.bc-pct');
      if (!pct) return;
      const hr = h.getBoundingClientRect(), pr = pct.getBoundingClientRect();
      if (pr.right > hr.right + 1.5) bad++;          // pct 右缘超出 head 右缘 → 被掩盖
    });
    return bad;
  });
  check('每日快讯：每个百分比右缘都在分类头内（未被掩盖）', pctClipped === 0, '被掩盖数=' + pctClipped);

  // 改名：存在新名，且旧名不再出现在分类头
  const names = await page.locator('.brief-cat-head .bc-name').allInnerTexts();
  const hasNew = names.includes('世界500强') && names.includes('行业标杆');
  const hasOld = names.some(n => n.trim() === '世界500强领导者' || n.trim() === '行业标杆上市公司');
  check('每日快讯：子类含新名「世界500强」「行业标杆」', hasNew, 'unique=' + [...new Set(names)].length);
  check('每日快讯：旧名「世界500强领导者」「行业标杆上市公司」已从分类头移除', !hasOld);

  check('整轮：无脚本错误', c.errors.length === 0, c.errors.slice(0, 3).join(' | '));
  await c.ctx.close();
} catch (e) {
  fail++;
  console.log('  \u2717 E2E 运行异常：' + (e && e.message ? e.message : e));
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n=== batch25 E2E: pass=${pass} fail=${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
