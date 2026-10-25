/* ============================================================
 * e2e-holder924.mjs — 「924散户 / 924散差」两个字段的真实浏览器端到端验证
 *
 * 覆盖点：
 *   1) 列头顺序：924散差 紧跟在 924涨跌 右侧；924散户 紧跟在 上期散户 右侧
 *   2) 924散差 数值 = 最新散户 − 924散户（296404 − 201582 = +94,822）
 *   3) 924散户 单元格正常显示（201,582）
 *   4) StockAPI.getFinance 真实取数逻辑：从东财 RPT_F10_EH_HOLDERNUM
 *      多期报告里取「报告期最接近 2024-09-24」的一期作为 924散户
 *   5) 列头排序可点击（924散差 sortable）
 *
 * 用法：node scripts/e2e-holder924.mjs
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

/** 东财 RPT_F10_EH_HOLDERNUM 多期股东户数夹具（END_DATE 降序） */
const HOLDER_ROWS = [
  { END_DATE: '2026-06-30 00:00:00', HOLDER_TOTAL_NUM: 296404 },
  { END_DATE: '2026-03-31 00:00:00', HOLDER_TOTAL_NUM: 243159 },
  { END_DATE: '2025-12-31 00:00:00', HOLDER_TOTAL_NUM: 230001 },
  { END_DATE: '2024-12-31 00:00:00', HOLDER_TOTAL_NUM: 210000 },
  { END_DATE: '2024-09-30 00:00:00', HOLDER_TOTAL_NUM: 201582 },
  { END_DATE: '2024-06-30 00:00:00', HOLDER_TOTAL_NUM: 180000 }
];
const EXPECT_924 = 201582;

function mkStock(code, name) {
  return {
    code, name, industry: '食品饮料',
    dailyChange: 5.55, amplitude: 4.2, capitalFlow: 1000000,
    shareholderCount: 296404, prevShareholderCount: 243159, shareholder924: EXPECT_924,
    profitYoY: 12.3, revenueYoY: 8.8,
    todayPrice: 1700, yearStartPrice: 1600, price924: 1500,
    yearChange: 6.25, change924: 13.33
  };
}
function mkSeed() {
  return {
    news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
    hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [],
    sectorPools: [{
      id: 'sp1', name: '板块A', bk: 'BK0001', type: '行业', createdAt: 1000,
      avgChange: 5.55, stocks: [mkStock('sh600519', '贵州茅台')]
    }],
    settings: { categories: ['主线实体', '个股实体', '主线概念', '个股概念', '利空概念'], proxyUrl: '', dataPaused: true }
  };
}

function seedScript(data) {
  return (d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  };
}

async function newPage(browser, seedData) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 东财接口：股东户数 → 夹具；其余财务接口 → 空数据（合法 JSON，避免报错）
  await page.route(u => /eastmoney\.com/.test(u.href), route => {
    const url = decodeURIComponent(route.request().url());
    if (/RPT_F10_EH_HOLDERNUM/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: HOLDER_ROWS, pages: 1 }, success: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] }, success: true }) });
  });
  // 腾讯行情：全量拦截，避免真实网络
  await page.route(u => /qt\.gtimg\.cn/.test(u.href), route => route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  await page.route(u => /smartbox\.gtimg\.cn/.test(u.href), route => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'v_hint="";' }));
  if (seedData) await page.addInitScript(seedScript(seedData), seedData);
  return { ctx, page, errors };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 45000 });
}
async function loginFresh(page) {
  await page.evaluate(async (pw) => {
    await Auth.setup('admin', pw, pw);
    AuthUI.enterApp();
  }, ADMIN_PW);
  await waitAppReady(page);
}

/** 打开概念选股板块详情弹窗，返回表头文本数组（按 DOM 顺序；剔除排序箭头 ⇅/↓/↑） */
async function openPoolDetailHeaders(page) {
  await page.locator('.pool-card').first().click();
  await page.waitForSelector('.sector-detail-modal table th', { timeout: 20000 });
  return page.$$eval('.sector-detail-modal table th',
    els => els.map(e => e.textContent.trim().replace(/[⇅↓↑]/g, '')));
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 1) 列头顺序 + 数值 ----------------
  console.log('1) 列头顺序与单元格数值（板块详情表）');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    const headers = await openPoolDetailHeaders(page);

    const i924chg = headers.indexOf('924涨跌');
    const i924diff = headers.indexOf('924散差');
    const iLatest = headers.indexOf('最新散户');
    const iPrev = headers.indexOf('上期散户');
    const i924cnt = headers.indexOf('924散户');
    check('存在「924散差」列头', i924diff >= 0, JSON.stringify(headers));
    check('存在「924散户」列头', i924cnt >= 0, JSON.stringify(headers));
    check('924散差 紧跟在 924涨跌 右侧', i924chg >= 0 && i924diff === i924chg + 1,
      `924涨跌@${i924chg} 924散差@${i924diff}`);
    check('924散户 紧跟在 上期散户 右侧', iPrev >= 0 && i924cnt === iPrev + 1,
      `上期散户@${iPrev} 924散户@${i924cnt}`);

    // 单元格数值：最新散户 296404，924散户 201582 → 924散差 = +94,822
    const rows = await page.$$eval('.sector-detail-modal table tbody tr', els => els.map(e => [...e.querySelectorAll('td')].map(t => t.textContent.trim())));
    const stockRow = rows.find(r => r.some(c => c.includes('贵州茅台') || c.includes('sh600519') || c.includes('600519')));
    check('详情表存在股票行', !!stockRow);
    if (stockRow) {
      check('924散户 单元格 = 201,582', stockRow[i924cnt] === '201,582', stockRow[i924cnt]);
      check('924散差 单元格 = +94,822（最新散户−924散户）', stockRow[i924diff] === '+94,822', stockRow[i924diff]);
    }

    // 排序可点击（924散差 sortable → th 可触发排序）
    const sortable = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('.sector-detail-modal table th')];
      const th = ths.find(t => t.textContent.trim().replace(/[⇅↓↑]/g, '') === '924散差');
      if (!th) return false;
      th.click();
      return true;
    });
    check('924散差 列头可点击排序', sortable);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 2) getFinance 取数逻辑（浏览器内 + 接口 mock）----------------
  console.log('\n2) StockAPI.getFinance：924散户取「报告期最接近 2024-09-24」的一期');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    const fin = await page.evaluate(async () => await StockAPI.getFinance('sh600519'));
    check('shareholderCount = 最新一期(2026-06-30) 296404', fin.shareholderCount === 296404, JSON.stringify(fin.shareholderCount));
    check('prevShareholderCount = 上一期(2026-03-31) 243159', fin.prevShareholderCount === 243159, JSON.stringify(fin.prevShareholderCount));
    check('shareholder924 = 2024-09-30 期 201582', fin.shareholder924 === EXPECT_924, JSON.stringify(fin.shareholder924));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
