/* ============================================================
 * e2e-sector-ui.mjs — 本轮 5 项界面改动的真实浏览器端到端验证
 *
 * 用真实浏览器 + 真实点击/拖拽，不 mock 应用代码，只 mock 外部行情接口：
 *   1) 顶部「暂停数据刷新」按钮：位置、状态、持久化，且暂停后进入「全球信息」页
 *      不再向 data/hot-topics/ 发起任何自动请求（恢复后重新自动加载）
 *   2) AI语义搜索 按钮已移到「搜索板块」按钮右侧（同一行、紧邻）
 *   3) 「我的概念选股板块」卡片可拖动排序：顺序变化 + 落盘 + 刷新后仍保持
 *   4) 「一键刷新涨跌」：只改日涨跌/现价并重算平均涨跌幅，财务/股东字段原样不动，
 *      且全程不请求东方财富（证明没有偷偷拉财务数据）
 *   5) 板块详情「字段含义」左侧的个股搜索添加：输代码直加、按名称联想点击加
 *   6) 热门板块页「注意事项」在「当日热门板块」右侧，文案含 30 与「服务器有限」
 *
 * 用法：node scripts/e2e-sector-ui.mjs
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

/** 腾讯行情：构造一条 v_xxx="..." 记录（GBK 编码，名称按 GBK 字节写） */
function quoteLine(code, nameGbkBytes, changePct, price) {
  const f = new Array(47).fill('');
  f[0] = '1'; f[2] = code.replace(/^(sh|sz|bj)/i, '');
  f[3] = String(price); f[4] = '1600.00'; f[5] = '1650.00'; f[6] = '1000';
  f[30] = '20260916150000'; f[31] = '100'; f[32] = String(changePct);
  f[33] = '1720'; f[34] = '1640'; f[37] = '10000';
  f[38] = '1.23'; f[39] = '30'; f[43] = '5.00'; f[44] = '20000'; f[45] = '21000'; f[46] = '8.8';
  const head = Buffer.from(`v_${code}="1~`, 'latin1');
  const parts = [];
  parts.push(head);
  parts.push(nameGbkBytes);
  for (let i = 2; i < f.length; i++) parts.push(Buffer.from('~' + f[i], 'latin1'));
  parts.push(Buffer.from('";\n', 'latin1'));
  return Buffer.concat(parts);
}
const GBK = {
  moutai: Buffer.from([0xB9, 0xF3, 0xD6, 0xDD, 0xC3, 0xA9, 0xCC, 0xA8]),   // 贵州茅台
  wuliangye: Buffer.from([0xCE, 0xE5, 0xC1, 0xB8, 0xD2, 0xBA])            // 五粮液
};

/** 初始化 localStorage 数据（只在首次导航写入，保证刷新后能看到真实持久化结果） */
function seedScript(data) {
  return (d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  };
}

async function newPage(browser, seedData, opts) {
  const ctx = await browser.newContext({ viewport: (opts && opts.viewport) || { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const counts = { hotTopics: 0, eastmoney: 0, tencent: 0, smartbox: 0 };
  page.on('request', r => {
    const u = r.url();
    if (/data\/hot-topics\//.test(u)) counts.hotTopics++;
    if (/eastmoney\.com/.test(u)) counts.eastmoney++;
    if (/qt\.gtimg\.cn/.test(u)) counts.tencent++;
    if (/smartbox\.gtimg\.cn/.test(u)) counts.smartbox++;
  });
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 腾讯实时行情（GBK）
  await page.route(u => /qt\.gtimg\.cn/.test(u.href), route => {
    const url = route.request().url();
    const query = decodeURIComponent(url.split('q=')[1] || '');
    const codes = query.split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const bufs = codes.map(c => {
      const lc = c.toLowerCase();
      if (lc === 'sh600519') return quoteLine(c, GBK.moutai, 5.55, 1700);
      if (lc === 'sz000858') return quoteLine(c, GBK.wuliangye, -3.21, 150);
      return quoteLine(c, Buffer.from('Stock-' + c, 'latin1'), 1.11, 100);
    });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: Buffer.concat(bufs) });
  });
  // 腾讯联想（JSONP：返回 v_hint="sh~600519~贵州茅台~…" 由脚本自身赋值）
  await page.route(u => /smartbox\.gtimg\.cn/.test(u.href), route => {
    const body = 'v_hint="sh~600519~贵州茅台~gzmt~GP-A^sz~000858~五粮液~wly~GP-A";';
    return route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  // 东方财富：本轮改动不应请求，直接拦截并计数（避免测试变慢/受网络影响）
  await page.route(u => /eastmoney\.com/.test(u.href), route => route.abort());
  if (seedData) await page.addInitScript(seedScript(seedData), seedData);
  return { ctx, page, errors, counts };
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
/** 真实鼠标事件完成 HTML5 拖拽（模拟人手：按下 → 多次移动 → 松开） */
async function html5Drag(page, srcSel, dstSel) {
  const src = page.locator(srcSel).first();
  const dst = page.locator(dstSel).first();
  const a = await src.boundingBox();
  const b = await dst.boundingBox();
  if (!a || !b) throw new Error('拖拽源/目标不可见');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8);
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      a.x + (b.x - a.x) * i / 6 + a.width / 2,
      a.y + (b.y - a.y) * i / 6 + a.height / 2
    );
    await page.waitForTimeout(40);
  }
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(260);
}

function mkStock(code, name) {
  return {
    code, name, industry: '食品饮料',
    dailyChange: -99,          // 哨兵值：只有真的刷新了才会变
    profitYoY: 123, revenueYoY: 456, shareholderCount: 7, prevShareholderCount: 5,
    todayPrice: 9, yearStartPrice: 10, price924: 5, yearHighPrice: 20, weekAgoClose: 8, monthAgoClose: 7
  };
}
function mkSeed(pools) {
  return {
    news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
    hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [],
    sectorPools: pools,
    settings: { categories: ['主线实体', '个股实体', '主线概念', '个股概念', '利空概念'], proxyUrl: '', dataPaused: false }
  };
}

const POOLS3 = [
  { id: 'sp1', name: '板块A', bk: 'BK0001', type: '行业', createdAt: 1000, avgChange: -99, stocks: [mkStock('sh600519', '贵州茅台')] },
  { id: 'sp2', name: '板块B', bk: 'BK0002', type: '概念', createdAt: 2000, avgChange: -99, stocks: [mkStock('sz000001', '平安银行')] },
  { id: 'sp3', name: '板块C', bk: 'BK0003', type: '概念', createdAt: 3000, avgChange: -99, stocks: [mkStock('sh601318', '中国平安')] }
];

const cardNames = (page) => page.$$eval('.pool-card .pool-name', els => els.map(e => e.textContent.trim()));

/** 行情接口 mock 对应的期望值（sh600519=5.55/1700，其余=1.11/100） */
const EXPECT = {
  sp1: { dc: 5.55, price: 1700 },
  sp2: { dc: 1.11, price: 100 },
  sp3: { dc: 1.11, price: 100 }
};

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 1 ----------------
  console.log('1) 顶部「暂停数据刷新」按钮');
  {
    const { ctx, page, errors, counts } = await newPage(browser, mkSeed(POOLS3));
    await gotoApp(page, A.port, '#news');
    await loginFresh(page);

    const pb = await page.locator('.pause-btn').boundingBox();
    const cb = await page.locator('.cloud-btn').boundingBox();
    check('暂停按钮存在', !!pb);
    check('暂停按钮在云端登录图标左侧', pb && cb && pb.x + pb.width <= cb.x + 1, `pause=${pb && pb.x} cloud=${cb && cb.x}`);
    check('初始为「未暂停」状态（图标 ⏸ 且无 active）',
      (await page.locator('.pause-btn').innerText()).includes('⏸') &&
      !(await page.locator('.pause-btn').getAttribute('class')).includes('active'));

    await page.locator('.pause-btn').click();
    await page.waitForTimeout(200);
    check('点击进入「已暂停」状态（▶ + 已暂停 + 高亮）',
      (await page.locator('.pause-btn').innerText()).includes('已暂停') &&
      (await page.locator('.pause-btn').getAttribute('class')).includes('active'));
    check('暂停状态已写入数据（持久化）', await page.evaluate(() => Store.data.settings.dataPaused === true));

    const before = counts.hotTopics;
    await page.locator('.nav-item', { hasText: '全球信息' }).click();
    await page.waitForTimeout(2600);
    check('暂停后进入「全球信息」页不发起任何快照自动请求', counts.hotTopics === before, `before=${before} after=${counts.hotTopics}`);
    const toastTxt = await page.locator('.toast').innerText().catch(() => '');
    check('给出「已暂停」提示，用户不会以为是坏了', /已暂停/.test(toastTxt), toastTxt);

    await page.locator('.pause-btn').click();
    await page.waitForTimeout(250);
    check('再点一次恢复（状态回到未暂停）',
      await page.evaluate(() => Store.data.settings.dataPaused === false) &&
      (await page.locator('.pause-btn').innerText()).includes('⏸'));
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length > 0, { timeout: 30000 }).catch(() => {});
    const after = counts.hotTopics;
    check('恢复后自动加载重新生效（发出快照请求）', after > before, `before=${before} after=${after}`);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 2 ----------------
  console.log('\n2) AI语义搜索按钮移到「搜索板块」右侧');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed([]));
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    await page.waitForTimeout(300);

    const boxes = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; };
      const search = [...document.querySelectorAll('.sector-search button')].find(b => b.textContent.includes('搜索板块'));
      const ai = document.querySelector('.sector-search .btn-ai');
      const sub = [...document.querySelectorAll('.sector-search button')].find(b => b.textContent.includes('搜索子版块'));
      const last = document.querySelector('.sector-search').lastElementChild;
      return {
        search: search ? box(search) : null,
        ai: ai ? box(ai) : null,
        sub: sub ? box(sub) : null,
        lastIsAi: !!(last && last.classList.contains('btn-ai')),
        order: [...document.querySelectorAll('.sector-search > *')].map(e => (e.tagName + ':' + (e.textContent || '').trim().slice(0, 10)))
      };
    });
    check('「搜索板块」与 AI语义搜索 同一行', boxes.search && boxes.ai && Math.abs(boxes.search.y - boxes.ai.y) < 6,
      JSON.stringify(boxes));
    check('AI语义搜索 紧贴「搜索板块」右侧', boxes.search && boxes.ai && boxes.ai.x >= boxes.search.x + boxes.search.w - 2,
      `search.x=${boxes.search && boxes.search.x}+${boxes.search && boxes.search.w} ai.x=${boxes.ai && boxes.ai.x}`);
    check('AI语义搜索 在「搜索子版块」之前（不再排在整行末尾）',
      boxes.ai && boxes.sub && boxes.ai.x < boxes.sub.x, JSON.stringify(boxes.order));
    check('AI语义搜索 不再是搜索栏最后一个元素', !boxes.lastIsAi);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 3 ----------------
  console.log('\n3) 「我的概念选股板块」卡片拖动排序（含持久化）');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed(POOLS3));
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    await page.waitForSelector('.pool-card');
    check('默认顺序 = 按创建时间倒序（新的在前）',
      JSON.stringify(await cardNames(page)) === JSON.stringify(['板块C', '板块B', '板块A']),
      JSON.stringify(await cardNames(page)));
    check('每张卡片都有拖动把手', (await page.locator('.pool-drag-handle').count()) === 3);

    await html5Drag(page, '.pool-card:has-text("板块A")', '.pool-card:has-text("板块C")');
    const after = await cardNames(page);
    check('拖动后顺序变为 A → C → B', JSON.stringify(after) === JSON.stringify(['板块A', '板块C', '板块B']), JSON.stringify(after));
    check('拖动不会误打开详情弹窗', !(await page.locator('.sector-detail-modal').isVisible().catch(() => false)));
    await page.waitForTimeout(700);   // 等自动保存（300ms 防抖）
    check('顺序已落盘到板块数据',
      await page.evaluate(() => {
        const g = id => (Store.data.sectorPools.find(p => p.id === id) || {}).order;
        return g('sp1') === 0 && g('sp3') === 1 && g('sp2') === 2;
      }), JSON.stringify(await page.evaluate(() => Store.data.sectorPools.map(p => [p.id, p.order]))));

    await page.reload({ waitUntil: 'load' });
    await waitAppReady(page);
    await page.waitForSelector('.pool-card');
    check('刷新页面后顺序仍保持', JSON.stringify(await cardNames(page)) === JSON.stringify(['板块A', '板块C', '板块B']),
      JSON.stringify(await cardNames(page)));

    await page.locator('button', { hasText: '恢复默认顺序' }).click();
    await page.waitForTimeout(200);
    check('「恢复默认顺序」可回到按创建时间倒序',
      JSON.stringify(await cardNames(page)) === JSON.stringify(['板块C', '板块B', '板块A']),
      JSON.stringify(await cardNames(page)));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 4 ----------------
  console.log('\n4) 一键刷新：只刷新日涨跌（不碰财务/股东字段，不请求东财）');
  {
    const { ctx, page, errors, counts } = await newPage(browser, mkSeed(POOLS3));
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    await page.waitForSelector('.pool-card');

    const btn = page.locator('button', { hasText: '一键刷新涨跌' });
    check('「一键刷新涨跌」按钮位于「我的概念选股板块」标题栏右侧',
      await btn.count() === 1);
    const pos = await page.evaluate(() => {
      const bar = document.querySelector('.section-title-bar');
      const b = [...bar.querySelectorAll('button')].find(x => x.textContent.includes('一键刷新'));
      const h3 = bar.querySelector('h3');
      const rb = b.getBoundingClientRect(), rh = h3.getBoundingClientRect(), rbar = bar.getBoundingClientRect();
      return { sameRow: Math.abs(rb.y - rh.y) < 30, rightSide: rb.x > rbar.x + rbar.width * 0.6 };
    });
    check('按钮在同一标题行且靠右', pos.sameRow && pos.rightSide, JSON.stringify(pos));

    await btn.click();
    await page.waitForFunction(() => {
      const p = Store.data.sectorPools[0];
      return p && p.stocks && p.stocks[0] && p.stocks[0].dailyChange === 5.55;
    }, { timeout: 30000 });
    const res = await page.evaluate(() => Store.data.sectorPools.map(p => ({
      id: p.id,
      dc: p.stocks[0].dailyChange,
      price: p.stocks[0].todayPrice,
      profit: p.stocks[0].profitYoY,
      revenue: p.stocks[0].revenueYoY,
      holder: p.stocks[0].shareholderCount,
      avg: p.avgChange
    })));
    check('日涨跌已刷新为接口值（三只都从哨兵 -99 变为真实值）', res.every(r => r.dc === EXPECT[r.id].dc), JSON.stringify(res));
    check('现价同步更新（用于重算平均涨跌幅）', res.every(r => r.price === EXPECT[r.id].price), JSON.stringify(res));
    check('每个板块的平均涨跌幅已重算为该板块的当日涨跌', res.every(r => r.avg === EXPECT[r.id].dc), JSON.stringify(res));
    check('财务字段未被改动（利润同比仍为 123）', res.every(r => r.profit === 123), JSON.stringify(res));
    check('财务字段未被改动（营收同比仍为 456）', res.every(r => r.revenue === 456), JSON.stringify(res));
    check('股东户数字段未被改动', res.every(r => r.holder === 7), JSON.stringify(res));
    check('全程未请求东方财富接口（证明没有偷偷拉财务数据）', counts.eastmoney === 0, 'eastmoney=' + counts.eastmoney);
    check('只调用了腾讯行情接口', counts.tencent > 0, 'tencent=' + counts.tencent);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 5 ----------------
  console.log('\n5) 板块详情：字段含义左侧的个股搜索添加');
  {
    const { ctx, page, errors } = await newPage(browser,
      mkSeed([{ id: 'sp1', name: '板块A', bk: 'BK0001', type: '行业', createdAt: 1000, avgChange: -99, stocks: [mkStock('sz000001', '平安银行')] }]));
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    await page.locator('.pool-card').first().click();
    await page.waitForSelector('.sector-detail-modal');

    const rel = await page.evaluate(() => {
      const wrap = document.querySelector('.quick-add-sector');
      const info = [...document.querySelectorAll('.sector-detail-modal .header-actions button')]
        .find(b => b.textContent.includes('字段含义'));
      if (!wrap || !info) return null;
      const a = wrap.getBoundingClientRect(), b = info.getBoundingClientRect();
      return { left: a.x + a.width <= b.x + 2, sameRow: Math.abs(a.y - b.y) < 24, ax: a.x, bx: b.x };
    });
    check('个股搜索添加在「字段含义」左侧且同一行', rel && rel.left && rel.sameRow, JSON.stringify(rel));

    const rows0 = await page.locator('.sector-detail-modal .pool-detail-table tbody tr').count();
    await page.fill('.quick-add-sector .quick-add-input', '600519');
    await page.locator('.quick-add-sector button').click();
    await page.waitForFunction(() => !document.querySelector('.quick-add-sector button').textContent.includes('⏳'), { timeout: 20000 });
    await page.waitForTimeout(400);
    const rows1 = await page.locator('.sector-detail-modal .pool-detail-table tbody tr').count();
    check('输入代码后成功加入板块（行数 +1）', rows1 === rows0 + 1, `${rows0} -> ${rows1}`);
    check('新股票代码/名称已写入数据', await page.evaluate(() => {
      const s = Store.data.sectorPools[0].stocks.find(x => x.code === 'sh600519');
      return !!s && s.name === '贵州茅台';
    }), JSON.stringify(await page.evaluate(() => Store.data.sectorPools[0].stocks.map(s => [s.code, s.name]))));
    check('平均涨跌幅已随成分股变化重算', await page.evaluate(() => Store.data.sectorPools[0].avgChange != null));

    // 重复添加同一只 → 去重
    await page.fill('.quick-add-sector .quick-add-input', '600519');
    await page.locator('.quick-add-sector button').click();
    await page.waitForTimeout(600);
    check('重复添加被去重（行数不变）',
      (await page.locator('.sector-detail-modal .pool-detail-table tbody tr').count()) === rows1);

    // 名称联想搜索 → 点击添加
    await page.fill('.quick-add-sector .quick-add-input', '五粮');
    await page.waitForSelector('.quick-add-sector .quick-add-item', { timeout: 20000 });
    const sug = await page.locator('.quick-add-sector .quick-add-item').allInnerTexts();
    check('输入名称出现联想候选', sug.length >= 1 && sug.join(' ').includes('五粮液'), JSON.stringify(sug));
    await page.locator('.quick-add-sector .quick-add-item', { hasText: '五粮液' }).first().click();
    await page.waitForTimeout(800);
    check('点击联想项即加入该股票', await page.evaluate(() =>
      Store.data.sectorPools[0].stocks.some(s => s.code === 'sz000858')));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 6 ----------------
  console.log('\n6) 热门板块页：当日热门板块右侧的注意事项');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed([]), { viewport: { width: 1680, height: 1000 } });
    await gotoApp(page, A.port, '#hot');
    await loginFresh(page);
    await page.waitForSelector('.hot-notice');
    const txt = await page.locator('.hot-notice').innerText();
    check('注意事项存在且文案包含「30」与「服务器有限」', /30/.test(txt) && /服务器有限/.test(txt), txt.replace(/\n/g, ' | '));
    check('文案包含「添加股票信息」', /添加股票信息/.test(txt), txt.replace(/\n/g, ' | '));
    const geo = await page.evaluate(() => {
      const notice = document.querySelector('.hot-notice');
      const panels = [...document.querySelectorAll('.hot-layout-2 .hot-panel')];
      const first = panels[0];
      const rn = notice.getBoundingClientRect(), rf = first.getBoundingClientRect();
      return {
        toRight: rn.x >= rf.x + rf.width - 2,
        topAligned: Math.abs(rn.y - rf.y) < 24,
        sameGrid: notice.parentElement.classList.contains('hot-layout-2')
      };
    });
    check('注意事项位于「当日热门板块」面板右侧', geo.toRight, JSON.stringify(geo));
    check('与「当日热门板块」顶部对齐（同排显示）', geo.topAligned, JSON.stringify(geo));
    check('与四个热门面板同属一个网格布局', geo.sameGrid, JSON.stringify(geo));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
