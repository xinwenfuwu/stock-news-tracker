/* ============================================================
 * e2e-quant-panel.mjs — 导航「量化板块」独立页面（盘后 / 盘中）端到端验证
 *
 * 覆盖点：
 *   1) 左侧导航「量化板块」入口 → 独立页面 .quant-page（内含 .quant-board-wrap）
 *   2) 两个子版块 Tab：盘后板块 / 盘中板块，默认盘后
 *   3) 盘后：操作顺序 6 条；四大信号 Checklist 4 张表（情绪修复/资金持续/业绩兑现/板块拥挤度），
 *      表头 跟踪项/去哪看/好信号/警惕信号
 *   4) 当日打分：默认合计 4/8（档位 3–4 分）；全部选 2 → 合计 8/8（档位 7–8 分）
 *   5) 保存打分 → 历史表出现记录 + localStorage 持久化（D.quantScores）
 *   6) 切到盘中板块：信号文案变为 实时强弱/盘中资金/题材活跃度/风险温度
 *   7) 全程无 JS 报错
 *
 * 用法：node scripts/e2e-quant-panel.mjs
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

function mkSeed() {
  return {
    news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
    hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [],
    sectorPools: [{ id: 'sp1', name: '板块A', bk: 'BK0001', type: '行业', createdAt: 1000, avgChange: 5.55, stocks: [] }],
    quantScores: [],
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
  await page.route(u => /eastmoney\.com/.test(u.href), route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: [] }, success: true }) }));
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
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 量化板块渲染 + 盘后内容 ----------------
  console.log('1) 量化板块渲染（右侧栏 + 两个 Tab + 盘后内容）');
  const { ctx, page, errors } = await newPage(browser, mkSeed());
  await gotoApp(page, A.port, '#quant');
  await loginFresh(page);

  const dom = await page.evaluate(() => {
    const pageEl = document.querySelector('.quant-page');
    const wrap = document.querySelector('.quant-board-wrap');
    const tabs = [...document.querySelectorAll('.quant-tab')].map(t => t.textContent.trim());
    const activeTab = document.querySelector('.quant-tab.active')?.textContent.trim();
    const orderItems = document.querySelectorAll('.q-order li').length;
    const signalTitles = [...document.querySelectorAll('.q-signal-title')].map(e => e.textContent.replace(/\s+/g, ''));
    const firstTableHeaders = [...document.querySelectorAll('.q-table thead th')].slice(0, 4).map(e => e.textContent.trim());
    const totalText = document.querySelector('.q-score-total b')?.textContent.trim();
    const levelText = document.querySelector('.q-level')?.textContent.trim();
    return { hasPage: !!pageEl, hasWrap: !!wrap, tabs, activeTab, orderItems, signalTitles, firstTableHeaders, totalText, levelText };
  });
  check('量化板块独立页面 .quant-page 出现', dom.hasPage);
  check('页面内 .quant-board-wrap 出现', dom.hasWrap);
  check('两个 Tab：盘后/盘中', dom.tabs.length === 2 && dom.tabs.join(',').includes('盘后板块') && dom.tabs.join(',').includes('盘中板块'), JSON.stringify(dom.tabs));
  check('默认激活「盘后板块」', dom.activeTab === '📕 盘后板块', dom.activeTab);
  check('操作顺序 6 条', dom.orderItems === 6, String(dom.orderItems));
  check('四大信号 Checklist 标题齐全', ['信号1：情绪修复', '信号2：资金持续', '信号3：业绩兑现', '信号4：板块拥挤度'].every(t => dom.signalTitles.some(x => x.startsWith(t))), JSON.stringify(dom.signalTitles));
  check('信号表表头 = 跟踪项/去哪看/好信号/警惕信号', dom.firstTableHeaders.join('|') === '跟踪项|去哪看|好信号 · 可参与|警惕信号 · 减仓/观望', dom.firstTableHeaders.join('|'));
  check('默认合计 = 4/8', dom.totalText === '4', dom.totalText);
  check('默认档位含「3–4 分」', (dom.levelText || '').includes('3–4 分'), dom.levelText);

  // ---------------- 打分计算 + 保存持久化 ----------------
  console.log('\n2) 打分计算（全选 2 → 8/8）+ 保存持久化');
  const scoreInfo = await page.evaluate(async () => {
    const selects = [...document.querySelectorAll('.q-score-grid select')];
    selects.forEach(s => { s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await new Promise(r => setTimeout(r, 50));
    return {
      count: selects.length,
      total: document.querySelector('.q-score-total b')?.textContent.trim(),
      level: document.querySelector('.q-level')?.textContent.trim()
    };
  });
  check('打分表 4 个信号下拉', scoreInfo.count === 4, String(scoreInfo.count));
  check('全选 2 → 合计 8/8', scoreInfo.total === '8', scoreInfo.total);
  check('合计 8 → 档位含「7–8 分」', (scoreInfo.level || '').includes('7–8 分'), scoreInfo.level);

  // 保存
  await page.click('.q-score .btn-primary');
  await page.waitForTimeout(300);
  const afterSave = await page.evaluate(() => {
    const rows = document.querySelectorAll('.q-hist tbody tr').length;
    const trend = document.querySelectorAll('.q-trend-bar').length;
    let stored = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/stock-news-tracker-v1/.test(k)) {
        try { const v = JSON.parse(localStorage.getItem(k)); if (Array.isArray(v.quantScores)) stored = Math.max(stored, v.quantScores.length); } catch (e) {}
      }
    }
    return { rows, trend, stored };
  });
  check('保存后历史表出现 1 条记录', afterSave.rows === 1, String(afterSave.rows));
  check('保存后趋势条出现 1 条', afterSave.trend === 1, String(afterSave.trend));
  check('记录已持久化到 localStorage（quantScores=1）', afterSave.stored === 1, String(afterSave.stored));

  // ---------------- 切到盘中板块 ----------------
  console.log('\n3) 切换到「盘中板块」验证内容');
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.quant-tab')];
    tabs.find(t => t.textContent.includes('盘中板块')).click();
  });
  await page.waitForTimeout(150);
  const intraday = await page.evaluate(() => {
    const active = document.querySelector('.quant-tab.active')?.textContent.trim();
    const titles = [...document.querySelectorAll('.q-signal-title')].map(e => e.textContent.replace(/\s+/g, ''));
    const total = document.querySelector('.q-score-total b')?.textContent.trim();
    return { active, titles, total };
  });
  check('切换后激活「盘中板块」', intraday.active === '📗 盘中板块', intraday.active);
  check('盘中信号文案正确（实时强弱/盘中资金/题材活跃度/风险温度）', ['信号1：实时强弱', '信号2：盘中资金', '信号3：题材活跃度', '信号4：风险温度'].every(t => intraday.titles.some(x => x.startsWith(t))), JSON.stringify(intraday.titles));
  check('盘中默认合计 = 4/8', intraday.total === '4', intraday.total);

  check('全程无 JS 报错', errors.length === 0, errors.join(' | '));
  await ctx.close();

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
