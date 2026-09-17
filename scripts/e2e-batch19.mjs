/* ============================================================
 * e2e-batch19.mjs — 验证 batch19 两项 UI 改动
 *   (A) 热门板块：当日热门股票↔盘前热点板块互换；盘前热点板块与振幅板块之间
 *       插入「尾盘买入法」；盘前/尾盘买入法/振幅三栏并排。
 *   (B) 每日快讯：去掉单维度切换，改为「题材归类 / 概念归类 / 行业归类」三维度
 *       并排，各自按占比从大到小排序。
 *
 * 用法：node scripts/e2e-batch19.mjs
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

/* ---------------- (A) Node 单元：briefStats 降序排序 ---------------- */
await import(pathToFileURL(path.join(ROOT, 'js/hot-topics.js')).href);
const HotTopics = globalThis.HotTopics;
const synth = [];
for (let i = 0; i < 5; i++) synth.push({ text: '半导体板块再度大涨' + i });
for (let i = 0; i < 2; i++) synth.push({ text: '新能源政策落地' + i });
for (let i = 0; i < 9; i++) synth.push({ text: '人工智能应用爆发' + i });
for (let i = 0; i < 3; i++) synth.push({ text: '光伏装机创新高' + i });
console.log('\n[unit] 题材归类条数序列:', HotTopics.briefStats(synth, 'theme').map(t => t.name + ':' + t.count).join(' '));
for (const mode of ['theme', 'concept', 'industry']) {
  const list = HotTopics.briefStats(synth, mode);
  check(`briefStats(${mode}) 按条数降序`, list.every((t, i, a) => i === 0 || a[i - 1].count >= t.count), list.map(t => t.count).join(','));
}

/* ---------------- Playwright 真实浏览器 ---------------- */
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
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href), r => r.abort());
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

const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
try {
  const A = await newCtx(browser);
  await hardGoto(A.page, base);
  await waitAuthReady(A.page);
  await bootAdmin(A.page);
  console.log('\n[web] 管理员进入应用');

  /* ===== 热门板块布局 ===== */
  await A.page.locator('.nav-item', { hasText: '热门板块' }).click();
  await A.page.waitForSelector('.hot-stack', { timeout: 15000 });

  const tbRules = await A.page.locator('.tail-buy-rubric .tb-rule').count();
  check('尾盘买入法面板含 8 项筛选规则', tbRules === 8, tbRules);

  const row3 = await A.page.locator('.hot-row-3 .hot-panel .panel-title').allInnerTexts();
  check('三并排①=盘前热点板块', /盘前热点板块/.test(row3[0] || ''), row3.join('|'));
  check('三并排②=尾盘买入法', /尾盘买入法/.test(row3[1] || ''), row3.join('|'));
  check('三并排③=振幅板块', /振幅板块/.test(row3[2] || ''), row3.join('|'));

  const topText = await A.page.locator('.hot-top-row').innerText();
  check('顶行含「当日热门股票」（已与盘前热点板块互换）', /当日热门股票/.test(topText));
  check('顶行含「当日热门板块」', /当日热门板块/.test(topText));
  // 互换的判定：整页文档顺序上「当日热门股票」出现在「盘前热点板块」之前
  const stackText = await A.page.locator('.hot-stack').innerText();
  check('文档顺序：当日热门股票 在 盘前热点板块 之前（已互换）',
    stackText.indexOf('当日热门股票') < stackText.indexOf('盘前热点板块'));

  // 尾盘买入法按钮联动（空池 → 提示先加载成分股）
  await A.page.locator('.hot-row-3 .hot-panel.tail-buy-panel button').click();
  await A.page.waitForSelector('.toast', { timeout: 8000 }).catch(() => {});
  const toastTxt = await A.page.locator('.toast').innerText().catch(() => '');
  check('尾盘买入法按钮已联动（触发筛选逻辑）', /尾盘买入法|请先/.test(toastTxt), toastTxt);

  /* ===== 每日快讯三维度 ===== */
  await A.page.locator('.nav-item', { hasText: '全球信息' }).click();
  await A.page.waitForSelector('.brief-dims', { timeout: 15000 });
  const groups = await A.page.locator('.brief-cat-group').count();
  check('每日快讯含三个归类分组', groups === 3, groups);
  const heads = (await A.page.locator('.bcg-head').allInnerTexts()).join('|');
  check('分组标题含「题材归类」', /题材归类/.test(heads), heads);
  check('分组标题含「概念归类」', /概念归类/.test(heads), heads);
  check('分组标题含「行业归类」', /行业归类/.test(heads), heads);
  // 维度切换器已移除
  const seg = await A.page.locator('.brief-dim-seg').count();
  check('旧的单一维度切换器已移除', seg === 0, seg);

  const errs = A.errors.filter(e => !/gtimg|eastmoney|Failed to fetch|NetworkError/.test(e));
  check('页面无脚本错误', errs.length === 0, errs.join(' ; '));
} catch (e) {
  console.error('E2E 异常:', e);
  fail++;
} finally {
  await browser.close();
  srv.close();
}
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
