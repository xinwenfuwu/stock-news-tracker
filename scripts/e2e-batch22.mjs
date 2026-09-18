/* ============================================================
 * e2e-batch22.mjs — 验证 batch22 三项改动
 *   1) 全球信息-火热话题-每日话题：改用「统计时间段」模式（与快讯/统计分析同口径：15:00 换日、起止可改）+ 独立刷新按钮；刷新加载时间段内新闻
 *   2) 全球信息-每日快讯：三维度分类右侧显示占新闻总数百分比；每日快讯宽度 +20%；跨站重合榜宽度 -20%；每日快讯改为随页面滚动
 *   3) 尾盘买入法：叠加 AI 精准筛选（未配置 AI 时回退规则法）；当日热门股票与当日热门板块等宽
 *
 * 用法：node scripts/e2e-batch22.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- 静态服务 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
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

/* ================================================================== */
/* (A) CSS 静态断言（宽度 / 滚动 / 等宽）                              */
/* ================================================================== */
console.log('[css] 静态宽度与布局断言');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
check('每日快讯 .brief-panel 宽度 +20%（430 → 516px）', /\.brief-panel\s*\{[^}]*width:\s*516px/.test(css));
check('每日快讯 .brief-panel 不再 sticky（随页面滚动）', /\.brief-panel\s*\{[^}]*\}(?!\s*position:\s*sticky)/.test(css) && !/\.brief-panel\s*\{[^}]*position:\s*sticky/.test(css));
check('跨站重合榜 .ht-split 左列 -20%（1.35fr → 1.08fr）', /\.ht-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.08fr\)\s+minmax\(0,\s*1fr\)/.test(css));
check('当日热门股票与当日热门板块等宽（hot-top-row: 1fr 190px 1fr）', /\.hot-top-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+190px\s+minmax\(0,\s*1fr\)/.test(css));

/* ================================================================== */
/* (B) Playwright 真浏览器                                            */
/* ================================================================== */
const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
try {
  /* ---------- 1) 每日话题：时间段模式 + 独立刷新 ---------- */
  console.log('\n[web] 1) 每日话题：统计时间段模式 + 独立刷新');
  const c = await newCtx(browser);
  const page = c.page;
  await page.addInitScript(() => {
    try { localStorage.setItem('snt-auth-users-v1', JSON.stringify([{ username: 'seed', role: 'user', hash: 'x', status: 'active', disabled: false, createdAt: 1, updatedAt: 1, logins: [] }])); } catch (e) {}
  });
  await page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await waitAuthReady(page);
  await bootAdmin(page);
  await goPage(page, 'finance');

  // 旧的「日期」输入框应已移除，新的时间段栏应存在
  const oldDateCount = await page.locator('#ht-daily input[type="date"]').count();
  check('每日话题：旧的「日期」输入框已移除', oldDateCount === 0);
  const dailyWin = await page.locator('#daily-stat-win').count();
  check('每日话题：存在 #daily-stat-win 时间段栏', dailyWin === 1);
  const dtInputs = await page.locator('#daily-stat-win input[type="datetime-local"]').count();
  check('每日话题：时间段栏含起止两个 datetime-local', dtInputs === 2, 'count=' + dtInputs);
  const swBtns = await page.locator('#daily-stat-win button.sw-btn').count();
  check('每日话题：时间段栏含「刷新」「重置」按钮', swBtns >= 2, 'count=' + swBtns);
  const winText = (await page.locator('#daily-stat-win .sw-text').innerText().catch(() => '')).trim();
  check('每日话题：时间栏展示中文时间文案（15:00 换日）', /\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2} - \d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(winText), winText);

  // 点击「刷新」：加载时间段内新闻（本地快照 2026-09-17 / 2026-09-18 应命中）
  await page.locator('#daily-stat-win button.sw-btn', { hasText: '刷新' }).first().click();
  const cards = await page.locator('#ht-daily .source-grid .source-card').count();
  if (cards === 0) {
    try { await page.waitForSelector('#ht-daily .source-grid .source-card', { timeout: 15000 }); } catch (e) {}
  }
  const finalCards = await page.locator('#ht-daily .source-grid .source-card').count();
  check('每日话题：点击「刷新」后加载到源卡片（时间段内新闻）', finalCards > 0, 'cards=' + finalCards);
  check('每日话题：刷新过程中无脚本错误', c.errors.length === 0, c.errors.slice(0, 2).join(' | '));

  /* ---------- 2) 每日快讯：三维度百分比 + 宽度 + 滚动 ---------- */
  console.log('\n[web] 2) 每日快讯：百分比 / 宽度 / 滚动');
  // 快讯自动加载（autoLoadBriefs）；验证百分比文本
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
  check('每日快讯：面板不再 sticky（随页面滚动）', briefPos.position !== 'sticky', 'position=' + briefPos.position);
  check('每日快讯：面板宽度约 516px（+20%）', Math.abs(briefPos.width - 516) <= 6, 'width=' + briefPos.width);

  // 跨站重合榜宽度：切到统计分析页签并生成统计（.ht-split 在 analysisResult 渲染后才存在），查看网格列比例
  await page.locator('.ht-tab', { hasText: '统计分析' }).click();
  await page.waitForTimeout(200);
  await page.locator('#ht-analysis button', { hasText: '生成统计' }).click();
  await page.waitForSelector('.ht-split', { state: 'visible', timeout: 20000 }).catch(() => {});
  const splitCols = await page.evaluate(() => {
    const el = document.querySelector('.ht-split');
    if (!el || getComputedStyle(el).display === 'none') return '';
    return getComputedStyle(el).gridTemplateColumns;
  });
  const splitParts = splitCols.split(' ').map(s => parseFloat(s));
  const leftRightRatio = splitParts.length === 2 && splitParts[1] > 0 ? splitParts[0] / splitParts[1] : 0;
  check('跨站重合榜：.ht-split 为两列且左列略大于右列（左 1.08fr / 右 1fr ≈ 1.08）',
    splitParts.length === 2 && leftRightRatio > 1.0 && leftRightRatio < 1.2,
    'cols=' + splitCols + ' ratio=' + leftRightRatio.toFixed(3));

  /* ---------- 3) 尾盘买入法：AI 精准筛选提示 + 等宽 ---------- */
  console.log('\n[web] 3) 尾盘买入法：AI 提示 + 等宽');
  await goPage(page, 'hot');
  await page.locator('.tail-buy-panel').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const tailText = (await page.locator('.tail-buy-panel').innerText().catch(() => '')).trim();
  check('尾盘买入法：面板含筛选说明（AI 或未配置提示）', /筛选/.test(tailText), tailText.slice(0, 60));
  const startBtn = await page.locator('.tail-buy-panel button', { hasText: '开始筛选' }).count();
  check('尾盘买入法：存在「开始筛选」按钮', startBtn >= 1);

  const topRowCols = await page.evaluate(() => {
    const el = document.querySelector('.hot-top-row');
    if (!el) return '';
    return getComputedStyle(el).gridTemplateColumns;
  });
  const colParts = topRowCols.split(' ').map(s => parseFloat(s));
  check('当日热门股票与当日热门板块等宽（hot-top-row 第一列≈第三列）',
    colParts.length === 3 && Math.abs(colParts[0] - colParts[2]) <= 2,
    'cols=' + topRowCols);

  check('整轮：无脚本错误', c.errors.length === 0, c.errors.slice(0, 3).join(' | '));
  await c.ctx.close();
} catch (e) {
  fail++;
  console.log('  \u2717 E2E 运行异常：' + (e && e.message ? e.message : e));
} finally {
  await browser.close();
  srv.close();
}

console.log(`\n=== batch22 E2E: pass=${pass} fail=${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
