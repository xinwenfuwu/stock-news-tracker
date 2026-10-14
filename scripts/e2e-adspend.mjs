/* ============================================================
 * e2e-adspend.mjs — 验证「广告投放力度榜」（20261015 改版）
 *   旧：抖音/头条两个「广告排行榜」，按搜索引擎提及次数排名（已废弃，数据恒为 0/不准）
 *   新：单榜「广告投放力度榜」，按上市公司最新财报「销售费用」从大到小排名（免费·准确）
 *   数据源：Cloudflare Worker /rank/adspend（东财利润表 SALE_EXPENSE，已线上部署）
 *
 * 场景 A（确定性，mock /rank/adspend）：验证前端渲染——单榜、降序、亿格式化、
 *        报告期、参与公司数、旧双榜/「提及次数」文案彻底消失、0 JS 报错。
 * 场景 B（真实集成，直连线上 Worker）：验证 getAdSpend + 真实 DOM 渲染出真实公司。
 *
 * 用法：node scripts/e2e-adspend.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT = path.resolve(ROOT, '..', '_adspend_report.txt'); // 写在仓库外，避免误提交
const ADMIN_PW = 'Admin@2026';
const LIVE_RANK = 'https://sichina.dpdns.org/rank/adspend';

let pass = 0, fail = 0; const report = [];
function check(name, cond, extra) {
  const tag = cond ? '[OK]' : '[NG]';
  const line = `${tag} ${name}${extra !== undefined && extra !== '' ? '  -> ' + extra : ''}`;
  report.push(line);
  if (cond) pass++; else fail++;
}

// 与线上真实数据同形同值的 fixture（top 即真实名次与金额，单位：元）
const FIXTURE = {
  count: 4854,
  generatedAt: '2026-10-14T16:22:37.357Z',
  note: 'mock fixture',
  list: [
    { rank: 1, code: '600941.SH', name: '中国移动', saleExpense: 28340000000, operateIncome: 800000000000, reportDate: '2026-06-30' },
    { rank: 2, code: '600028.SH', name: '中国石化', saleExpense: 27880000000, operateIncome: null, reportDate: '2026-06-30' },
    { rank: 3, code: '601728.SH', name: '中国电信', saleExpense: 25280000000, operateIncome: null, reportDate: '2026-06-30' },
    { rank: 4, code: '600050.SH', name: '中国联通', saleExpense: 18060000000, operateIncome: null, reportDate: '2026-06-30' },
    { rank: 5, code: '600690.SH', name: '海尔智家', saleExpense: 16440000000, operateIncome: null, reportDate: '2026-06-30' },
    { rank: 6, code: '600887.SH', name: '伊利股份', saleExpense: 11400000000, operateIncome: null, reportDate: '2026-06-30' },
    { rank: 7, code: '601127.SH', name: '赛力斯',   saleExpense: 8500000000,  operateIncome: null, reportDate: '2026-06-30' }
  ]
};

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
  return new Promise(r => srv.listen(18080, '127.0.0.1', () => r({ srv, port: srv.address().port })));
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
async function gotoHot(page) {
  await page.locator('.nav-item', { hasText: '热门板块' }).first().click();
  await page.locator('.hot-panel', { hasText: '广告投放力度榜' }).first().waitFor({ state: 'visible', timeout: 20000 });
}
async function clickAdRefresh(page) {
  await page.locator('.hot-panel', { hasText: '广告投放力度榜' }).first()
    .locator('button', { hasText: '刷新数据' }).first().click();
}

const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
let MOCK = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 切掉无关三方源（sichina 不在列，保留以走真实 Worker）
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com|vore\.top|ip\.sb|unpkg\.com/.test(u.href), r => r.abort());
  // 广告投放力度榜：mock 时回 fixture，否则回落网络（真实集成）
  await page.route('**/rank/adspend', async r => {
    if (MOCK) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) });
    return r.fallback();
  });

  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await waitAuthReady(page);
  await bootAdmin(page);
  await gotoHot(page);

  // ---------- 场景 A：mock 确定性渲染 ----------
  await clickAdRefresh(page);
  await page.waitForSelector('.ad-spend-list .hot-item', { timeout: 20000 });
  await page.waitForTimeout(300);

  const titleText = await page.locator('.hot-panel', { hasText: '广告投放力度榜' }).first().locator('.panel-title').first().innerText();
  check('A1 面板标题为「广告投放力度榜」', /广告投放力度榜/.test(titleText), titleText.trim());

  const items = await page.locator('.ad-spend-list .hot-item').allInnerTexts();
  check('A2 渲染出榜单条目（=7）', items.length === 7, 'got=' + items.length);

  const first = items[0] || '';
  check('A3 第 1 名=中国移动 / 283.4 亿 / 2026-06-30', /中国移动/.test(first) && /283\.4\s*亿/.test(first) && /2026-06-30/.test(first), first.replace(/\s+/g, ' ').trim());

  const vals = items.map(t => { const m = t.match(/销售费用\s*([\d.]+)\s*亿/); return m ? parseFloat(m[1]) : NaN; });
  const allParsed = vals.every(v => !isNaN(v));
  const desc = vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  check('A4 所有条目都解析出「销售费用 X 亿」', allParsed, JSON.stringify(vals));
  check('A5 严格按销售费用从大到小（非递增）', desc, JSON.stringify(vals));

  const bodyText = await page.evaluate(() => document.body.innerText);
  check('A6 展示参与排名公司数（4854）', /4854/.test(bodyText));
  check('A7 展示榜单生成时间（2026-10-14）', /2026-10-14/.test(bodyText));
  check('A8 旧「抖音广告投放排行榜」已消失', !/抖音广告投放排行榜/.test(bodyText));
  check('A9 旧「头条广告投放排行榜」已消失', !/头条广告投放排行榜/.test(bodyText));
  check('A10 旧「提及 N 次」搜索口径文案已消失', !/提及\s*\d+\s*次/.test(bodyText));
  check('A11 新口径说明（财报销售费用）已展示', /销售费用/.test(bodyText) && /财报/.test(bodyText));
  check('A12 豆包联网搜索 Key 入口仍保留（独立分区，未误删）', await page.locator('.hot-panel', { hasText: '广告投放力度榜' }).first().locator('button', { hasText: '如何获取' }).count() === 1);

  // 直接验证 API 层（不经过 DOM）
  const api = await page.evaluate(async () => {
    const r = await StockAPI.getAdSpend();
    return { len: (r.list || []).length, count: r.count, first: (r.list || [])[0] || null };
  });
  check('A13 StockAPI.getAdSpend 返回 7 条 / count 4854', api.len === 7 && api.count === 4854, `len=${api.len} count=${api.count}`);
  check('A14 getAdSpend 首条=中国移动 283.4亿(元)', api.first && api.first.name === '中国移动' && Math.round(api.first.saleExpense / 1e8) === 283, api.first ? `${api.first.name} ${api.first.saleExpense}` : 'null');

  check('A15 场景 A 零 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---------- 场景 B：真实线上 Worker 集成 ----------
  // 关键：清「内存态」Store.data 而不只是 localStorage —— Store 有 beforeunload/pagehide
  // 落盘，reload 会把内存里场景 A 的 7 条 mock 又写回 localStorage，只清 localStorage 会被覆盖。
  MOCK = false;
  errors.length = 0;
  await page.evaluate(() => {
    Store.data.adSpend = []; Store.data.adDate = ''; Store.data.adCount = 0;
    Store.saveNow();
    const key = Store.STORAGE_KEY;
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    raw.adSpend = []; raw.adDate = ''; raw.adCount = 0;
    localStorage.setItem(key, JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await waitAppReady(page);
  await gotoHot(page);
  // 缓存已清空 → 此刻榜单应为空；点刷新后唯一数据源就是线上 Worker
  const beforeLive = await page.locator('.ad-spend-list .hot-item').count();
  check('B0 清缓存后刷新前榜单为空（排除旧缓存干扰）', beforeLive === 0, 'before=' + beforeLive);
  await clickAdRefresh(page);
  let liveItems = [];
  try {
    await page.waitForSelector('.ad-spend-list .hot-item', { timeout: 30000 });
    await page.waitForTimeout(300);
    liveItems = await page.locator('.ad-spend-list .hot-item').allInnerTexts();
  } catch (e) { /* 网络不通时保持空 */ }
  check('B1 直连线上 Worker 渲染出真实榜单', liveItems.length > 7, 'got=' + liveItems.length + '（mock 仅 7 条，>7 才证明来自线上 top50）');
  if (liveItems.length) {
    check('B2 真实首名=中国移动', /中国移动/.test(liveItems[0]), liveItems[0].replace(/\s+/g, ' ').trim());
    check('B3 真实榜单含「亿」与报告期', /亿/.test(liveItems[0]) && /20\d\d-\d\d-\d\d/.test(liveItems[0]), liveItems[0].replace(/\s+/g, ' ').trim());
  }
  check('B4 场景 B 零 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await ctx.close();
} catch (e) {
  check('运行异常（非断言失败）', false, e && e.message);
} finally {
  await browser.close();
  srv.close();
  fs.writeFileSync(REPORT, report.join('\n') + '\n', 'utf8');
  console.log(`\n===== RESULT: ${pass} OK / ${fail} NG =====`);
  console.log(report.filter(l => l.startsWith('[NG]')).join('\n') || '(all passed)');
  console.log('REPORT_FILE=' + REPORT);
  process.exit(fail ? 1 : 0);
}
