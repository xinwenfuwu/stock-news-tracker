/* ============================================================
 * e2e-influence-20261106e.mjs — 影响力事件（原「抖音搜索股票排名榜」改造）真实浏览器端到端验证
 * 需求：把原抖音搜索股票排名榜改为「影响力事件」，分 中国/美国/全世界 三个子版块，点击切换；
 *       20261108a 起双指标并存——「影响人数」A(生产生活全部相关人数，含股民) 与「影响股民数」S
 *       (投资该概念股票的股民)，A = max(区域人口基数 P × 生产生活触达率 r, S)，两者均可作为排序依据。
 * 用法：node scripts/e2e-influence-20261106e.mjs
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
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

async function newPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route('**/api.github.com/**', r => r.abort());
  await page.route('**github.io/**', r => r.abort());
  await page.route('**sichina.dpdns.org/**', r => r.abort());
  await page.route('**/data/**', r => r.abort());
  return { ctx, page, errors };
}

async function gotoApp(page, port) {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}
async function waitAppReady(page, ms) {
  const opt = { timeout: ms || 45000 };
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, opt);
  await page.waitForFunction(() => { const el = document.getElementById('app'); return !!(el && el.__vue_app__); }, null, opt);
}
async function loginFresh(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}
// 进入「热门板块」页（影响力事件面板所在页）
async function goHot(page) {
  await page.click('.nav-item:has-text("热门板块")');
  await page.waitForSelector('.infl-tabs', { timeout: 15000 });
  await page.waitForSelector('.infl-event-list', { timeout: 15000 });
}

// 读取当前区域事件列表：返回 [{rank, title, region, concept, people(影响人数), affected(影响股民数), share}]
function parseAffected(t) {
  const m = t.match(/([\d.]+)\s*(亿|万)/);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2] === '亿' ? v * 1e8 : v * 1e4;
}
async function readInflRows(page) {
  // 20261108i：影响力事件现分「左：影响力事件 / 中：未来事件」双面板，默认只读取左侧面板（第一个 .infl-event-list）
  return await page.evaluate(() => {
    const list = document.querySelectorAll('.infl-event-list')[0];
    if (!list) return [];
    const els = list.querySelectorAll('.infl-event');
    return Array.from(els).map(e => ({
      rank: (e.querySelector('.hot-rank') || {}).textContent.trim(),
      title: (e.querySelector('.infl-title') || {}).textContent.trim(),
      region: (e.querySelector('.infl-region') || {}).textContent.trim(),
      concept: (e.querySelector('.infl-concept') || { textContent: '' }).textContent.trim(),
      people: (e.querySelector('.infl-people') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      affected: (e.querySelector('.infl-affected:not(.infl-people)') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
      share: (e.querySelector('.infl-share') || { textContent: '' }).textContent.trim()
    }));
  });
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const { ctx, page, errors } = await newPage(browser);

  console.log('影响力事件面板（每区 20 条 + 内部滑条） + 同花顺行业/概念 Tab');
  await gotoApp(page, A.port);
  // 20261108c：预置同花顺热门板块缓存（离线测试会阻断外部接口），供行业/概念 Tab 切换断言使用
  await page.evaluate(() => {
    localStorage.setItem('stock-news-tracker-v1::admin', JSON.stringify({
      thsSectors: {
        industries: [
          { code: '881121', name: '半导体', type: '行业', order: 1, change: 2.35, heat: 99, hotTag: '热门', limitTag: '3涨停' },
          { code: '881155', name: '银行', type: '行业', order: 2, change: 0.82, heat: 88 }
        ],
        concepts: [
          { code: '885338', name: '人工智能', type: '概念', order: 1, change: 1.92, heat: 97, hotTag: '热门' }
        ]
      },
      // 20261108f：连板股票缓存（离线测试阻断外部接口）。
      //  isContinuous = 最新交易日仍涨停（未断板）；streakCount = 真实连续板数（断板强制 0）。
      //  已按 ztCount 降序（模拟 API 原始顺序）；首板 / 连板 / 断板混排，用于验证两种口径。
      hotStocks: [
        { name: '甲首板', code: 'sh600001', boardCount: 1, streakCount: 1, isContinuous: true,  ztCount: 9, change: 10.0, industry: '电子' },
        { name: '乙二板', code: 'sz000002', boardCount: 2, streakCount: 2, isContinuous: true,  ztCount: 7, change: 10.0, industry: '计算机' },
        { name: '丙五板', code: 'sh600003', boardCount: 5, streakCount: 5, isContinuous: true,  ztCount: 6, change: 10.0, industry: '传媒' },
        { name: '丁首板', code: 'sz000004', boardCount: 1, streakCount: 1, isContinuous: true,  ztCount: 5, change: 9.9,  industry: '医药' },
        { name: '戊三板', code: 'sh600005', boardCount: 3, streakCount: 3, isContinuous: true,  ztCount: 4, change: 10.0, industry: '通信' },
        { name: '己二板', code: 'sz000006', boardCount: 2, streakCount: 2, isContinuous: true,  ztCount: 3, change: 10.0, industry: '军工' },
        // 断板股：历史曾 8 / 4 连板，但最新交易日没涨停 → 连板数必须归零并从「连板」剔除
        { name: '庚断板', code: 'sz000007', boardCount: 8, streakCount: 0, isContinuous: false, ztCount: 2, change: -3.2, industry: '传媒' },
        { name: '辛断板', code: 'sh600008', boardCount: 4, streakCount: 0, isContinuous: false, ztCount: 1, change: 1.1,  industry: '电子' }
      ]
    }));
  });
  await loginFresh(page);
  await goHot(page);

  // 20261108j：影响力事件现分「左：影响力事件 / 中：未来事件（独立 突发/未来）」双面板，
  // 原影响力事件断言全部锁定到左面板，避免与中面板未来事件（同款 .infl-* 选择器）冲突触发 strict mode
  const inflPanel = page.locator('.hot-top-row > .hot-panel').nth(0);   // 左：影响力事件
  const futurePanel = page.locator('.hot-top-row > .hot-panel').nth(1); // 中：未来事件

  // 1) 默认「全世界」+ 默认按「影响股民数」排序；20261108a 起两个指标同时存在
  let rows = await readInflRows(page);
  console.log('   全世界 行:', JSON.stringify(rows.slice(0, 6)));
  const worldTop = parseAffected(rows[0].affected);
  check('默认进入「全世界」子版块', (await inflPanel.locator('.infl-region-tabs .infl-tab.active').innerText()).includes('全世界'));
  check('默认排序口径 = 按影响股民数', (await inflPanel.locator('.infl-sort-btn.active').innerText()).includes('影响股民数'));
  check('全世界共 20 条事件', rows.length === 20, String(rows.length));
  check('全世界 #1 = 特朗普中期选举失利', rows[0].title.includes('特朗普中期选举失利'));
  check('每条同时显示「影响人数」与「影响股民数」', rows.every(r => r.people.includes('影响人数') && r.affected.includes('影响股民数')), rows[0].people + ' | ' + rows[0].affected);
  check('全世界 #1 涉及概念 = AI / 算力', rows[0].concept.includes('AI / 算力'), rows[0].concept);
  check('全世界 #1 影响股民数 = 3.60 亿', rows[0].affected.includes('3.60 亿'), rows[0].affected);
  check('全世界 #1 影响人数 = 47.56 亿（P×r=82亿×0.58）', rows[0].people.includes('47.56 亿'), rows[0].people);
  check('包含关系 A ≥ S：全世界每条影响人数均 ≥ 影响股民数', rows.every(r => parseAffected(r.people) >= parseAffected(r.affected)), rows.map(r => r.people + '/' + r.affected).join(' | '));
  check('每条显示股民占比', rows.every(r => r.share && r.share.includes('占')), rows.map(r => r.share).join(' | '));
  check('全世界按影响股民数降序：#1 > #2', parseAffected(rows[0].affected) >= parseAffected(rows[1].affected), rows[0].affected + ' / ' + rows[1].affected);
  check('全世界 #20 影响股民数最小（2800.0 万）', rows[19].affected.includes('2800.0 万'), rows[19].affected);

  // 2) 切换排序口径为「按影响人数」：#1 应为触达率最高的能源事件（52.48 亿）
  await inflPanel.locator('.infl-sort-btn:has-text("按影响人数")').click();
  await page.waitForTimeout(200);
  rows = await readInflRows(page);
  console.log('   全世界(按影响人数) 行:', JSON.stringify(rows.slice(0, 2)));
  check('排序切换后按钮 active = 按影响人数', (await inflPanel.locator('.infl-sort-btn.active').innerText()).includes('影响人数'));
  check('按影响人数排序 #1 = 地缘冲突外溢(能源 52.48 亿)', rows[0].title.includes('地缘冲突外溢') && rows[0].people.includes('52.48 亿'), rows[0].title + ' / ' + rows[0].people);
  check('按影响人数降序：#1 > #2', parseAffected(rows[0].people) >= parseAffected(rows[1].people), rows[0].people + ' / ' + rows[1].people);

  // 3) 切回默认口径并进入「中国」：新增 AI 短剧审核监管事件（影响人数极大、股民极少）
  await inflPanel.locator('.infl-sort-btn:has-text("按影响股民数")').click();
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("中国")').click();
  await page.waitForTimeout(200);
  rows = await readInflRows(page);
  console.log('   中国 行:', JSON.stringify(rows.slice(0, 6)));
  check('切换到「中国」子版块', (await inflPanel.locator('.infl-region-tabs .infl-tab.active').innerText()).includes('中国'));
  check('中国共 20 条事件（含 AI 短剧监管）', rows.length === 20, String(rows.length));
  check('中国 #1 = 证监会活跃资本市场新规（按股民数）', rows[0].title.includes('证监会活跃资本市场'));
  check('中国 #1 影响股民数 = 1.90 亿 / 影响人数 = 4.51 亿', rows[0].affected.includes('1.90 亿') && rows[0].people.includes('4.51 亿'), rows[0].affected + ' | ' + rows[0].people);
  const drama = rows.find(r => r.title.includes('AI 短剧审核监管'));
  check('中国存在「AI 短剧审核监管」事件', !!drama);
  check('AI短剧：影响人数 = 9.87 亿（大量中国人看短剧）', !!drama && drama.people.includes('9.87 亿'), drama && drama.people);
  check('AI短剧：影响股民数仅 3500.0 万', !!drama && drama.affected.includes('3500.0 万'), drama && drama.affected);
  check('AI短剧：影响人数 > 影响股民数的 10 倍（生活触达远大于持股人群）', !!drama && parseAffected(drama.people) > parseAffected(drama.affected) * 10, drama && (drama.people + ' / ' + drama.affected));
  check('AI短剧：股民占比 3.5%', !!drama && drama.share.includes('3.5%'), drama && drama.share);
  check('中国 20 条每条 A ≥ S 且按股民数降序', rows.every(r => parseAffected(r.people) >= parseAffected(r.affected)) && parseAffected(rows[0].affected) >= parseAffected(rows[19].affected));
  check('三区域统一公式：全世界 #1 股民数 > 中国 #1 股民数', worldTop > parseAffected(rows[0].affected), worldTop + ' vs ' + parseAffected(rows[0].affected));

  // 中国按「影响人数」排序 → AI 短剧监管应升到 #1
  await inflPanel.locator('.infl-sort-btn:has-text("按影响人数")').click();
  await page.waitForTimeout(200);
  rows = await readInflRows(page);
  console.log('   中国(按影响人数) #1:', JSON.stringify(rows[0]));
  check('中国按影响人数排序 #1 = AI 短剧审核监管（9.87 亿）', rows[0].title.includes('AI 短剧审核监管') && rows[0].people.includes('9.87 亿'), rows[0].title + ' / ' + rows[0].people);
  await inflPanel.locator('.infl-sort-btn:has-text("按影响股民数")').click();

  // 4) 切换到「美国」：同一公式，影响人数 2.65 亿 > 影响股民数 9000 万
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("美国")').click();
  await page.waitForTimeout(200);
  rows = await readInflRows(page);
  console.log('   美国 行:', JSON.stringify(rows.slice(0, 5)));
  check('切换到「美国」子版块', (await inflPanel.locator('.infl-region-tabs .infl-tab.active').innerText()).includes('美国'));
  check('美国共 20 条事件', rows.length === 20, String(rows.length));
  check('美国 #1 = 美国债务上限危机', rows[0].title.includes('美国债务上限危机'));
  check('美国 #1 影响股民数 = 9000.0 万', rows[0].affected.includes('9000.0 万'), rows[0].affected);
  check('美国 #1 影响人数 = 2.65 亿（3.4亿×0.78）', rows[0].people.includes('2.65 亿'), rows[0].people);
  check('美国 20 条每条 A ≥ S 且按股民数降序', rows.every(r => parseAffected(r.people) >= parseAffected(r.affected)) && parseAffected(rows[0].affected) >= parseAffected(rows[19].affected));

  // 5) 三个区域互不影响：回到全世界仍是 6 条
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("全世界")').click();
  await page.waitForTimeout(200);
  rows = await readInflRows(page);
  check('回到全世界仍为 20 条', rows.length === 20, String(rows.length));

  // 6) 20261108b：口径说明左侧的「隐藏说明」按钮，点击后整段说明隐藏不显示（锁定左面板）
  const infoBtn = inflPanel.locator('.infl-info-btn');
  const infoText = inflPanel.locator('.infl-info-text');
  check('口径说明左侧存在隐藏按钮', (await infoBtn.count()) === 1 && (await infoBtn.innerText()).includes('隐藏说明'));
  check('默认显示口径说明（含公式 A = max）', await infoText.isVisible() && (await infoText.innerText()).includes('A = max(P × r, S)'));
  check('按钮确实位于说明文字左侧', await page.evaluate(() => {
    const panels = document.querySelectorAll('.hot-top-row > .hot-panel');
    const b = panels[0].querySelector('.infl-info-btn').getBoundingClientRect();
    const t = panels[0].querySelector('.infl-info-text').getBoundingClientRect();
    return b.width > 0 && t.width > 0 && b.right <= t.left + 1 && b.top < t.bottom;
  }));
  await infoBtn.click();
  await page.waitForTimeout(200);
  check('点击后说明文字隐藏不显示', !(await infoText.isVisible()) && !(await inflPanel.locator('.infl-info').innerText()).includes('A = max'));
  check('按钮切换为「显示说明」', (await infoBtn.innerText()).includes('显示说明'));
  check('隐藏状态写入 Store.data（可跨设备同步）', await page.evaluate(() => typeof Store !== 'undefined' && !!(Store.data && Store.data.inflInfoHidden === true)));
  const persisted = await page.waitForFunction(() => {
    try {
      const k = Object.keys(localStorage).find(k => k.indexOf('stock-news-tracker-v1') === 0);
      return !!k && JSON.parse(localStorage.getItem(k)).inflInfoHidden === true;
    } catch (e) { return false; }
  }, null, { timeout: 4000 }).then(() => true).catch(() => false);
  check('隐藏状态已持久化到 localStorage', persisted);
  check('隐藏说明不影响事件列表（全世界仍 20 条）', (await readInflRows(page)).length === 20);
  await infoBtn.click();
  await page.waitForTimeout(200);
  check('再点「显示说明」可恢复整段文字', await infoText.isVisible() && (await infoText.innerText()).includes('A = max(P × r, S)'));
  check('恢复后按钮回到「隐藏说明」', (await infoBtn.innerText()).includes('隐藏说明'));

  // 6b) 重新加载页面后隐藏状态仍保持（验证 Store 初始化恢复分支）
  await infoBtn.click();
  await page.waitForTimeout(200);
  await page.goto(`http://127.0.0.1:${A.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.getElementById('auth-gate') || !!(document.getElementById('app') && document.getElementById('app').__vue_app__), null, { timeout: 20000 });
  await page.evaluate(async (pw) => {
    try { if (typeof Auth !== 'undefined' && typeof Auth.login === 'function') await Auth.login('admin', pw, true); } catch (e) { /* 沿用已有会话 */ }
    if (typeof AuthUI !== 'undefined' && AuthUI.enterApp) AuthUI.enterApp();
  }, ADMIN_PW);
  await waitAppReady(page);
  await goHot(page);
  // 重新加载后重新锁定左面板 locator（旧 locator 仍指向同一 DOM，但显式重建更稳）
  const inflPanel2 = page.locator('.hot-top-row > .hot-panel').nth(0);
  const infoBtn2 = inflPanel2.locator('.infl-info-btn');
  const infoText2 = inflPanel2.locator('.infl-info-text');
  check('刷新页面后仍保持隐藏（持久化恢复）', !(await infoText2.isVisible()));
  await infoBtn2.click();
  await page.waitForTimeout(150);
  check('刷新后仍可用按钮恢复显示说明', await infoText2.isVisible());

  // 7) 20261108c：每区 20 条 + 列表内部下滑滑条 + 影响力事件板块框大小不变（锁定左面板）
  const listBox = await page.evaluate(() => {
    const l = document.querySelectorAll('.infl-event-list')[0];
    return { client: l.clientHeight, scroll: l.scrollHeight, overflow: getComputedStyle(l).overflowY };
  });
  check('全世界 20 条事件全部渲染', (await readInflRows(page)).length === 20);
  check('列表可下滑查看（scrollHeight > clientHeight）', listBox.scroll > listBox.client, JSON.stringify(listBox));
  check('列表高度固定 420px（卡片框不被 20 条撑大）', Math.abs(listBox.client - 420) <= 2 && listBox.overflow === 'auto', JSON.stringify(listBox));
  const panelH = async () => await page.evaluate(() => document.querySelectorAll('.infl-region-tabs')[0].closest('.hot-panel').getBoundingClientRect().height);
  const hWorld = await panelH();
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("中国")').click();
  await page.waitForTimeout(150);
  const hCn = await panelH();
  check('切到中国仍为 20 条', (await readInflRows(page)).length === 20);
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("美国")').click();
  await page.waitForTimeout(150);
  const hUs = await panelH();
  check('切到美国仍为 20 条', (await readInflRows(page)).length === 20);
  check('三区域切换后影响力事件框高度不变', Math.abs(hWorld - hCn) < 2 && Math.abs(hWorld - hUs) < 2, [hWorld, hCn, hUs].join(' / '));
  await page.evaluate(() => { const l = document.querySelectorAll('.infl-event-list')[0]; l.scrollTop = l.scrollHeight; });
  await page.waitForTimeout(150);
  const lastInView = await page.evaluate(() => {
    const l = document.querySelectorAll('.infl-event-list')[0];
    const lb = l.getBoundingClientRect(), eb = l.querySelector('.infl-event:last-child').getBoundingClientRect();
    return eb.height > 0 && eb.top >= lb.top - 2 && eb.bottom <= lb.bottom + 2;
  });
  check('下滑到底可见第 20 条事件', lastInView);
  await inflPanel.locator('.infl-region-tabs .infl-tab:has-text("全世界")').click();

  // 8) 20261108c：同花顺热门板块 —— 行业 / 概念 Tab 互斥切换（同影响力事件按钮样式）
  // 20261108i：顶行同花顺原件已被「未来事件」覆盖，仅剩三并排内的 .ths-tabs-copy 副本
  const thsTabs = page.locator('.ths-tabs-copy .infl-tab');
  check('同花顺出现两个 Tab（行业板块 / 概念板块）', (await thsTabs.count()) === 2 && (await thsTabs.nth(0).innerText()).includes('行业板块') && (await thsTabs.nth(1).innerText()).includes('概念板块'));
  check('两个板块复用影响力事件同一套 .infl-tab 按钮样式', await page.evaluate(() => {
    const first = document.querySelectorAll('.hot-top-row > .hot-panel')[0];
    return first.querySelectorAll('.infl-region-tabs .infl-tab').length === 3
      && document.querySelectorAll('.ths-tabs-copy .infl-tab').length === 2;
  }));
  check('默认激活「行业板块」', (await page.locator('.ths-tabs-copy .infl-tab.active').innerText()).includes('行业板块'));
  check('默认只显示行业板块列表', await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible() && !(await page.locator('.ths-sector-copy-list[data-kind="concept"]').isVisible()));
  check('行业列表渲染缓存数据（2 条）', (await page.locator('.ths-sector-copy-list[data-kind="industry"] .hot-item').count()) === 2);
  await page.click('.ths-tabs-copy .infl-tab:has-text("概念板块")');
  await page.waitForTimeout(150);
  check('点击后激活态切到「概念板块」', (await page.locator('.ths-tabs-copy .infl-tab.active').innerText()).includes('概念板块'));
  check('切换后只显示概念板块列表', await page.locator('.ths-sector-copy-list[data-kind="concept"]').isVisible() && !(await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible()));
  check('概念列表渲染缓存数据（1 条）', (await page.locator('.ths-sector-copy-list[data-kind="concept"] .hot-item').count()) === 1);
  check('Tab 选择持久化到 Store.data', await page.evaluate(() => typeof Store !== 'undefined' && !!(Store.data && Store.data.thsSectorTab === 'concept')));
  await page.click('.ths-tabs-copy .infl-tab:has-text("行业板块")');
  await page.waitForTimeout(150);
  check('可切回「行业板块」', await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible());

  // 8a) 20261108h：原「盘前热点板块」位置改为同花顺热门板块副本（顶行原件保留，两处共用同一份数据与 Tab 状态）
  const row3Titles = await page.locator('.hot-row-3 .hot-panel .panel-title').allInnerTexts();
  check('三并排第一格已是「同花顺热门板块」', /同花顺热门板块/.test(row3Titles[0] || ''), row3Titles.join('|'));
  check('原「盘前热点板块」已被覆盖（页面不再出现该标题）', !(await page.locator('.hot-stack').innerText()).includes('盘前热点板块'));
  const copyPanel = page.locator('.hot-panel.ths-sector-copy');
  check('副本面板只出现 1 次且位于三并排内', (await copyPanel.count()) === 1
    && await page.locator('.hot-row-3 .hot-panel.ths-sector-copy').count() === 1);
  const copyTabs = page.locator('.ths-tabs-copy .infl-tab');
  check('副本含行业 / 概念两个 Tab', (await copyTabs.count()) === 2
    && (await copyTabs.nth(0).innerText()).includes('行业板块')
    && (await copyTabs.nth(1).innerText()).includes('概念板块'));
  check('副本默认只显示行业列表', await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible()
    && !(await page.locator('.ths-sector-copy-list[data-kind="concept"]').isVisible()));
  check('副本行业列表渲染缓存数据（2 条）', (await page.locator('.ths-sector-copy-list[data-kind="industry"] .hot-item').count()) === 2);
  check('顶行同花顺原件已被「未来事件」覆盖（顶行不再含同花顺热门板块）', !(await page.locator('.hot-top-row .hot-panel .panel-title').allInnerTexts()).some(t => t.includes('同花顺热门板块')));
  await page.click('.ths-tabs-copy .infl-tab:has-text("概念板块")');
  await page.waitForTimeout(150);
  check('副本切到概念板块后自身列表切换', await page.locator('.ths-sector-copy-list[data-kind="concept"]').isVisible()
    && !(await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible()));
  check('副本概念列表渲染缓存数据（1 条）', (await page.locator('.ths-sector-copy-list[data-kind="concept"] .hot-item').count()) === 1);
  await page.click('.ths-tabs-copy .infl-tab:has-text("行业板块")');
  await page.waitForTimeout(150);
  check('副本可切回行业板块（自身状态独立维护）', await page.locator('.ths-sector-copy-list[data-kind="industry"]').isVisible()
    && !(await page.locator('.ths-sector-copy-list[data-kind="concept"]').isVisible()));

  // 8c) 20261108j：中间「未来事件」面板已与左侧「影响力事件」完全解耦，子版块为「突发 / 未来」
  //     突发 = 全球当前正在发生的大事件；未来 = 未来三个月内全球将要发生的大事件（显示日期 + 距今天数倒计时）
  check('顶行第二格标题 = 未来事件', (await futurePanel.locator('.panel-title').innerText()).includes('未来事件'));
  check('未来事件面板含「突发 / 未来」两个子版块（不再含中国/美国/全世界）',
    (await futurePanel.locator('.infl-region-tabs .infl-tab').count()) === 2
    && (await futurePanel.locator('.infl-region-tabs .infl-tab:has-text("突发")').count()) === 1
    && (await futurePanel.locator('.infl-region-tabs .infl-tab:has-text("未来")').count()) === 1);
  check('未来事件默认进入「突发」子版块', (await futurePanel.locator('.infl-region-tabs .infl-tab.active').innerText()).includes('突发'));
  check('突发子版块显示全球当前大事件（≥1 条，且含真实事件标题）',
    (await futurePanel.locator('.infl-event-list .infl-event').count()) >= 1
    && (await futurePanel.locator('.infl-event-list .infl-event .infl-title').first().innerText()).includes('反AI数据中心'));
  check('突发事件卡片含「🏷 标签」', await page.evaluate(() => {
    const p = document.querySelectorAll('.hot-top-row > .hot-panel')[1];
    const it = p.querySelector('.infl-event');
    return !!it && !!it.querySelector('.infl-concept');
  }));
  // 切到「未来」子版块
  await futurePanel.locator('.infl-region-tabs .infl-tab:has-text("未来")').click();
  await page.waitForTimeout(150);
  check('切到「未来」后子版块激活态转移', (await futurePanel.locator('.infl-region-tabs .infl-tab.active').innerText()).includes('未来'));
  const futCount = await futurePanel.locator('.infl-event-list .infl-event').count();
  check('未来子版块显示未来三个月内全球大事件（≥5 条）', futCount >= 5, String(futCount));
  check('未来事件卡片显示「📅 日期」与「⏳ 还有 N 天」倒计时', await page.evaluate(() => {
    const p = document.querySelectorAll('.hot-top-row > .hot-panel')[1];
    const it = p.querySelector('.infl-event-list .infl-event');
    return !!it && !!it.querySelector('.infl-meta') && /还有 \d+ 天/.test(it.querySelector('.infl-meta').textContent);
  }));
  check('未来事件按日期升序（最近/最临近的排前）', await page.evaluate(() => {
    const p = document.querySelectorAll('.hot-top-row > .hot-panel')[1];
    const ds = Array.from(p.querySelectorAll('.infl-event')).map(e => {
      const m = (e.querySelector('.infl-meta') || {}).textContent.match(/(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : null;
    }).filter(Boolean);
    for (let i = 1; i < ds.length; i++) if (ds[i] < ds[i-1]) return false;
    return ds.length > 1;
  }));
  check('未来事件含典型真实事件（G20 领导人峰会 / CES 2027 / 美联储FOMC）', await page.evaluate(() => {
    const p = document.querySelectorAll('.hot-top-row > .hot-panel')[1];
    const txt = p.innerText;
    return txt.includes('G20 领导人峰会') && txt.includes('CES 2027') && txt.includes('美联储FOMC');
  }));
  check('未来事件子版块选择持久化到 Store.data', await page.evaluate(() => typeof Store !== 'undefined' && Store.data && Store.data.futureRegion === 'future'));
  await futurePanel.locator('.infl-region-tabs .infl-tab:has-text("突发")').click();
  await page.waitForTimeout(150);

  // 8b) 20261108d：连板股票 —— 「10日内 / 连板」Tab 互斥切换（不显示说明文字）
  const lbPanel = page.locator('.lianban-tabs').locator('xpath=ancestor::div[contains(@class,"hot-panel")][1]');
  const lbTabs = page.locator('.lianban-tabs .infl-tab');
  const readLb = () => page.$$eval('.lianban-list .hot-item', els => els.map(e => ({
    name: (e.querySelector('.hot-name') || {}).textContent.trim(),
    val: (e.querySelector('.hot-val') || {}).textContent.replace(/\s+/g, ' ').trim()
  })));
  check('连板股票出现两个 Tab（10日内 / 连板）', (await lbTabs.count()) === 2
    && (await lbTabs.nth(0).innerText()).includes('10日内') && (await lbTabs.nth(1).innerText()).includes('连板'));
  check('Tab 复用影响力事件同款 .infl-tab 按钮样式', await page.evaluate(() => document.querySelectorAll('.lianban-tabs .infl-tab').length === 2));
  check('默认激活「10日内」', (await page.locator('.lianban-tabs .infl-tab.active').innerText()).includes('10日内'));
  check('连板面板不显示说明文字（无说明性 <p> 段落）', (await lbPanel.locator('p').count()) === 0
    && !(await lbPanel.innerText()).includes('近 10 个交易日内涨停次数最多'));
  let lbRows = await readLb();
  check('「10日内」逻辑不变：8 条全部显示（含首板与断板）', lbRows.length === 8, JSON.stringify(lbRows.map(r => r.name)));
  check('「10日内」保持原始涨停次数降序', lbRows.map(r => r.name).join(',') === '甲首板,乙二板,丙五板,丁首板,戊三板,己二板,庚断板,辛断板', lbRows.map(r => r.name).join(','));
  check('「10日内」每行显示「N板 + 10日M次」', lbRows[0].val.includes('1板') && lbRows[0].val.includes('10日9次'), lbRows[0].val);
  await page.click('.lianban-tabs .infl-tab:has-text("连板")');
  await page.waitForTimeout(150);
  check('点击后激活态切到「连板」', (await page.locator('.lianban-tabs .infl-tab.active').innerText()).includes('连板'));
  lbRows = await readLb();
  check('「连板」只保留未断板的连续涨停板（剔除 2 首板 + 2 断板，剩 4 条）', lbRows.length === 4, JSON.stringify(lbRows.map(r => r.name)));
  check('断板股被归零剔除（不再出现历史 8 板 / 4 板）', !lbRows.some(r => r.name.includes('断板')), JSON.stringify(lbRows.map(r => r.name)));
  check('「连板」按实际连板数从大到小排序（5→3→2→2）', lbRows.map(r => r.name).join(',') === '丙五板,戊三板,乙二板,己二板', lbRows.map(r => r.name).join(','));
  check('「连板」每行显示「N连板 + 连续涨停」', lbRows[0].val.includes('5连板') && lbRows[0].val.includes('连续涨停')
    && lbRows.every(r => r.val.includes('连板') && r.val.includes('连续涨停')), JSON.stringify(lbRows.map(r => r.val)));
  check('Tab 选择持久化到 Store.data', await page.evaluate(() => typeof Store !== 'undefined' && !!(Store.data && Store.data.lianbanTab === 'streak')));
  const lbPersisted = await page.waitForFunction(() => {
    try {
      const k = Object.keys(localStorage).find(k => k.indexOf('stock-news-tracker-v1') === 0);
      return !!k && JSON.parse(localStorage.getItem(k)).lianbanTab === 'streak';
    } catch (e) { return false; }
  }, null, { timeout: 4000 }).then(() => true).catch(() => false);
  check('Tab 选择已持久化到 localStorage', lbPersisted);
  await page.goto(`http://127.0.0.1:${A.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.getElementById('auth-gate') || !!(document.getElementById('app') && document.getElementById('app').__vue_app__), null, { timeout: 20000 });
  await page.evaluate(async (pw) => {
    try { if (typeof Auth !== 'undefined' && typeof Auth.login === 'function') await Auth.login('admin', pw, true); } catch (e) { /* 沿用已有会话 */ }
    if (typeof AuthUI !== 'undefined' && AuthUI.enterApp) AuthUI.enterApp();
  }, ADMIN_PW);
  await waitAppReady(page);
  await goHot(page);
  check('刷新页面后仍保持「连板」口径', (await page.locator('.lianban-tabs .infl-tab.active').innerText()).includes('连板') && (await readLb()).length === 4);
  await page.click('.lianban-tabs .infl-tab:has-text("10日内")');
  await page.waitForTimeout(150);
  check('可切回「10日内」并恢复全部 8 条', (await readLb()).length === 8);

  // 20261108f：不超过 50 个 —— 独立 context 预置 55 只未断板连板股，
  // 避免主流程的 Store autosave / 刷新时序覆盖注入数据
  const many = Array.from({ length: 55 }, (_, i) => ({
    name: '压力' + (i + 1), code: 'sh' + String(700000 + i),
    boardCount: 2 + (i % 6), streakCount: 2 + (i % 6), isContinuous: true,
    ztCount: 60 - i, change: 10, industry: '测试'
  }));
  const { ctx: ctx2, page: p2, errors: errors2 } = await newPage(browser);
  await gotoApp(p2, A.port);
  await p2.evaluate((rows) => {
    for (const k of ['stock-news-tracker-v1::admin', 'stock-news-tracker-v1']) {
      localStorage.setItem(k, JSON.stringify({ hotStocks: rows }));
    }
  }, many);
  await loginFresh(p2);
  await goHot(p2);
  await p2.click('.lianban-tabs .infl-tab:has-text("连板")');
  await p2.waitForTimeout(200);
  const capped = await p2.$$eval('.lianban-list .hot-item', els => els.map(e => ({
    name: (e.querySelector('.hot-name') || {}).textContent.trim(),
    val: (e.querySelector('.hot-val') || {}).textContent.replace(/\s+/g, ' ').trim()
  })));
  check('「连板」不超过 50 个（55 只候选被截断）', capped.length === 50, 'rows=' + capped.length);
  check('截断后仍按连板数降序（首位为 7 连板）', !!(capped[0] && capped[0].val.includes('7连板')), capped[0] && capped[0].val);
  check('独立场景无 JS 报错', errors2.length === 0, errors2.join(' | '));
  await ctx2.close();

  // 9) 无 JS 报错
  check('无 JS 报错', errors.length === 0, errors.join(' | '));

  await ctx.close();
  await browser.close();
  A.srv.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('e2e 运行异常:', e); process.exit(2); });
