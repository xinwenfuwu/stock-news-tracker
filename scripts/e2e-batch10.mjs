/* ============================================================
 * e2e-batch10.mjs — 真实浏览器验证「产品业务字段左右排列 + 筛选栏高度压缩」
 *
 * 背景（用户反馈 + 实测定位到的真实 bug）：
 *   `.biz-field` 只覆盖了 display，没有覆盖 `.filter-field` 的 flex-direction: column，
 *   于是「产品业务」标签在上、输入框居中、点「🔗 算相关度」按钮又在下 —— 上下三行。
 *   同时 `.cell-input` 自带 max-width:110px，把行内 style 的 width 也压掉了。
 *
 * 覆盖：
 *   1) 板块详情弹窗筛选栏：产品业务 标签 / 输入框 / 算相关度按钮 左右排列（同一行、顺序正确）
 *      且「算相关度」功能仍正常（命中主营构成段营收占比之和 = 85.7%）
 *   2) 筛选栏高度压缩：每个字段压成一行、控件变小，筛选栏高度显著下降，表格可视区能多显示股票
 *   3) 成分股勾选弹窗：产品业务同样左右排列、输入框宽度不再被压到 110px、
 *      工具栏 / 去重筛选行 / 列表行高压缩后一屏可见更多股票
 *
 * 只 mock 外部行情源（腾讯/东财），应用代码与 UI 交互全部为真实行为。
 * 用法：node scripts/e2e-batch10.mjs
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg',
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

/* ---------- 外部行情 mock（与 batch6 同口径） ---------- */
function quoteLine(code, nameGbk, changePct, price, cap) {
  const totalCap = cap != null ? cap : 21000;
  const f = new Array(47).fill('');
  f[0] = '1'; f[2] = code.replace(/^(sh|sz|bj)/i, '');
  f[3] = String(price); f[4] = '1600.00'; f[5] = '1650.00'; f[6] = '1000';
  f[30] = '20260916150000'; f[31] = '100'; f[32] = String(changePct);
  f[33] = '1720'; f[34] = '1640'; f[37] = '10000';
  f[38] = '1.23'; f[39] = '30'; f[43] = '5.00';
  f[44] = String(Math.round(totalCap * 0.95)); f[45] = String(totalCap); f[46] = '8.8';
  const parts = [Buffer.from(`v_${code}="1~`, 'latin1'), nameGbk];
  for (let i = 2; i < f.length; i++) parts.push(Buffer.from('~' + f[i], 'latin1'));
  parts.push(Buffer.from('";\n', 'latin1'));
  return Buffer.concat(parts);
}
const GBK = {
  moutai: Buffer.from([0xB9, 0xF3, 0xD6, 0xDD, 0xC3, 0xA9, 0xCC, 0xA8]),   // 贵州茅台
  wuliangye: Buffer.from([0xCE, 0xE5, 0xC1, 0xB8, 0xD2, 0xBA]),           // 五粮液
  catl: Buffer.from([0xC4, 0xFE, 0xB5, 0xC2, 0xCA, 0xB1, 0xB4, 0xFA]),     // 宁德时代
  pingan: Buffer.from([0xC6, 0xBD, 0xB0, 0xB2, 0xD2, 0xF8, 0xD0, 0xD0])    // 平安银行
};
const QUOTES = {
  sh600519: { gbk: GBK.moutai, chg: 5.55, price: 1700, cap: 21000 },
  sz000858: { gbk: GBK.wuliangye, chg: -3.21, price: 150, cap: 5800 },
  sz300750: { gbk: GBK.catl, chg: 2.10, price: 260, cap: 11400 },
  sz000001: { gbk: GBK.pingan, chg: 0.80, price: 11.5, cap: 2200 }
};
function quoteFor(code) {
  const q = QUOTES[code.toLowerCase()];
  if (q) return quoteLine(code, q.gbk, q.chg, q.price, q.cap);
  return quoteLine(code, Buffer.from('Stock-' + code, 'latin1'), 1.11, 100, 21000);
}

const SECTOR_LIST = [
  { f12: 'BK0001', f14: '测试概念', f3: 3.30 },
  { f12: 'BK0002', f14: '测试行业', f3: 1.10 }
];
/** 成分股：多放几只，用于验证压缩后一屏能显示更多股票 */
const CONSTITUENTS = {
  BK0001: [
    { f12: '600519', f14: '贵州茅台', f3: 5.55, f2: 1700 },
    { f12: '000858', f14: '五粮液', f3: -3.21, f2: 150 },
    { f12: '300750', f14: '宁德时代', f3: 2.10, f2: 260 },
    { f12: '000001', f14: '平安银行', f3: 0.80, f2: 11.5 },
    { f12: '301001', f14: '创业板测试', f3: 1.00, f2: 20 },
    { f12: '688001', f14: '科创测试', f3: 1.20, f2: 30 },
    { f12: '430001', f14: '北交所测试', f3: 0.90, f2: 10 },
    { f12: '000002', f14: 'ST测试', f3: -1.50, f2: 11.5 },
    { f12: '600036', f14: '招商银行', f3: 0.30, f2: 40 },
    { f12: '601318', f14: '中国平安', f3: 1.15, f2: 55 },
    { f12: '002594', f14: '比亚迪', f3: 2.42, f2: 300 },
    { f12: '600030', f14: '中信证券', f3: -0.60, f2: 26 }
  ]
};
const MAINOP = {
  '600519.SH': [{ ITEM_NAME: '茅台酒', MBI_RATIO: 85.7 }, { ITEM_NAME: '其他系列酒', MBI_RATIO: 14.3 }],
  '300750.SZ': [{ ITEM_NAME: '动力电池系统', MBI_RATIO: 70.0 }, { ITEM_NAME: '储能电池系统', MBI_RATIO: 20.0 }],
  '000858.SZ': [{ ITEM_NAME: '酒类', MBI_RATIO: 90.0 }],
  '000001.SZ': [{ ITEM_NAME: '利息收入', MBI_RATIO: 60.0 }]
};
function mainOpRows(secucode) {
  const rows = MAINOP[String(secucode).toUpperCase()] || [];
  return rows.map(r => ({
    REPORT_DATE: '2025-12-31 00:00:00', MAINOP_TYPE: '2',
    ITEM_NAME: r.ITEM_NAME, MBI_RATIO: r.MBI_RATIO
  }));
}

function seedScript(data) {
  return (d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  };
}

async function newPage(browser, seedData, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /qt\.gtimg\.cn/.test(u.href), route => {
    const q = decodeURIComponent(route.request().url().split('q=')[1] || '');
    const codes = q.split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: Buffer.concat(codes.map(quoteFor)) });
  });
  await page.route(u => /smartbox\.gtimg\.cn/.test(u.href), route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'v_hint="";' }));
  await page.route(u => /eastmoney\.com/.test(u.href), route => {
    const url = route.request().url();
    const cb = (/[?&]cb=([^&]+)/.exec(url) || [])[1];
    const send = (obj) => cb
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: cb + '(' + JSON.stringify(obj) + ');' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

    if (/\/api\/qt\/clist\/get/.test(url)) {
      const fs_ = decodeURIComponent((/[?&]fs=([^&]*)/.exec(url) || [])[1] || '');
      let diff = [];
      if (fs_.startsWith('b:')) diff = CONSTITUENTS[fs_.slice(2)] || [];
      else if (/m:90/.test(fs_)) diff = SECTOR_LIST;
      return send({ rc: 0, data: { total: diff.length, diff } });
    }
    if (/datacenter-web\.eastmoney\.com/.test(url)) {
      const sec = decodeURIComponent((/SECUCODE%3D%22([^%&"]+)/.exec(url) || [])[1] || '');
      if (/RPT_F10_FN_MAINOP/.test(url)) {
        const data = mainOpRows(sec);
        return send({ result: { data, count: data.length } });
      }
      if (/RPT_F10_ORG_BASICINFO/.test(url)) {
        return send({ result: { data: [{ BOARD_NAME_1LEVEL: '食品饮料' }], count: 1 } });
      }
      return send({ result: { data: [], count: 0 } });
    }
    return send({ rc: 0, data: { total: 0, diff: [] }, result: { data: [], count: 0 } });
  });
  await page.route(u => /workers\.dev|vore\.top|ip\.sb/.test(u.href), route => route.abort());
  if (seedData) await page.addInitScript(seedScript(seedData), seedData);
  return { ctx, page, errors };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load', timeout: 40000 });
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function loginFresh(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}

/** 取元素几何 + 布局信息（用于「左右排列 / 同一行」判定） */
const GEOM = ([sel, kidsSel]) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const cs = getComputedStyle(root);
  const r = root.getBoundingClientRect();
  const mid = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, cy: b.y + b.height / 2, right: b.x + b.width }; };
  return {
    display: cs.display,
    flexDir: cs.flexDirection,
    self: { x: r.x, y: r.y, w: r.width, h: r.height },
    kids: [...root.querySelectorAll(kidsSel || ':scope > *')].map(el => Object.assign({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 12) }, mid(el)))
  };
};

/* ---------- 种子数据 ---------- */
const POOLS = [{
  // bk 故意用 BK9999：搜索命中的是 BK0001，若这里也用 BK0001 会触发查重提示，弹不出勾选弹窗
  id: 'sp1', name: '测试概念板块', bk: 'BK9999', type: '概念', createdAt: 1000, avgChange: 1.0,
  stocks: [
    { code: 'sh600519', name: '贵州茅台', industry: '食品饮料', todayPrice: 1700, dailyChange: 5.55, totalMarketCap: 21000 },
    { code: 'sz300750', name: '宁德时代', industry: '电力设备', todayPrice: 260, dailyChange: 2.10, totalMarketCap: 11400 }
  ]
}];

function mkSeed(extra) {
  return Object.assign({
    news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
    hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [],
    sectorPools: POOLS,
    settings: { categories: ['主线概念'], proxyUrl: '', dataPaused: false }
  }, extra || {});
}

/* ============================================================ */
const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ---------------- 1. 板块详情筛选栏：「产品业务」左右排列 ---------------- */
  console.log('1) 板块详情筛选栏：「产品业务 / 输入框 / 算相关度」左右排列（不再上下三行）');
  const shared = await newPage(browser, mkSeed());
  {
    const { page, errors } = shared;
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);
    await page.locator('.pool-card').first().click();
    await page.waitForSelector('.sector-detail-modal', { timeout: 15000 });
    await page.waitForTimeout(500);

    const g = await page.evaluate(GEOM, ['.sector-detail-modal .biz-field', ':scope > *']);
    check('详情页存在「产品业务」字段', !!g, 'missing');
    if (g) {
      const label = g.kids[0], input = g.kids.find(k => k.tag === 'INPUT'), btn = g.kids.find(k => k.tag === 'BUTTON');
      check('flex-direction 已是 row（此前被 .filter-field 的 column 覆盖 → 上下排列）',
        g.flexDir === 'row', g.flexDir);
      check('三个元素不再堆叠：任两者在同一行的判定为真',
        label && input && btn && Math.abs(label.cy - input.cy) <= 4 && Math.abs(input.cy - btn.cy) <= 4,
        JSON.stringify([label && label.cy, input && input.cy, btn && btn.cy]));
      check('标签在输入框左侧', !!(label && input) && label.right <= input.x + 1, `${label && label.right} vs ${input && input.x}`);
      check('输入框在「算相关度」按钮左侧', !!(input && btn) && input.right <= btn.x + 1, `${input && input.right} vs ${btn && btn.x}`);
      check('整块高度只占一行（≤ 32px，此前纵向排 3 行约 85px）', g.self.h <= 32, 'h=' + Math.round(g.self.h));
      check('按钮文字是「算相关度」', !!btn && /算相关度/.test(btn.text), btn && btn.text);
    }

    // 输入框宽度不再被 .cell-input 的 max-width:110px 压掉
    const inputW = await page.evaluate(() => {
      const el = document.querySelector('.sector-detail-modal .biz-field input');
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    });
    check('输入框宽度 > 110px（max-width 已放宽，占位提示不再被挤掉）', inputW > 110, 'w=' + inputW);

    // v-model 仍生效
    await page.locator('.sector-detail-modal .biz-field input').fill('茅台酒');
    check('输入后 v-model 已同步', await page.inputValue('.sector-detail-modal .biz-field input') === '茅台酒');

    // 功能未受影响：点「算相关度」→ 相关度 = 命中主营段占比之和
    await page.locator('.sector-detail-modal button:has-text("算相关度")').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('.sector-detail-modal .pool-detail-table');
      return t && /85\.7/.test(t.textContent || '');
    }, null, { timeout: 30000 });
    const relTxt = await page.evaluate(() => {
      const table = document.querySelector('.sector-detail-modal .pool-detail-table');
      const ths = [...table.querySelectorAll('thead th')];
      const idx = ths.findIndex(th => th.textContent.includes('相关度'));
      for (const tr of table.querySelectorAll('tbody tr')) {
        const tds = tr.querySelectorAll('td');
        if ((tds[1] ? tds[1].textContent : '').replace(/^(sh|sz|bj)/i, '').trim() === '600519') {
          return (tds[idx] ? tds[idx].textContent : '').trim();
        }
      }
      return null;
    });
    check('「算相关度」功能仍正常（贵州茅台 85.7%）', relTxt === '85.7%', String(relTxt));

    /* ---------------- 2. 筛选栏高度压缩 ---------------- */
    console.log('\n2) 筛选栏高度压缩：字段压成一行、控件变小 → 表格可视区多显示股票');
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.sector-detail-modal .sector-filter-bar');
      const r = b.getBoundingClientRect();
      const bs = getComputedStyle(b);
      // 各字段的垂直中线，去重后即「筛选栏视觉行数」
      const centers = [...b.querySelectorAll('.filter-field')].map(f => {
        const fr = f.getBoundingClientRect();
        return Math.round(fr.y + fr.height / 2);
      });
      const bands = [];
      centers.forEach(c => { if (!bands.some(b2 => Math.abs(b2 - c) <= 6)) bands.push(c); });
      const table = document.querySelector('.sector-detail-modal .table-scroll-x');
      const tr = table.getBoundingClientRect();
      const row = document.querySelector('.sector-detail-modal .pool-detail-table tbody tr');
      const rowH = row ? row.getBoundingClientRect().height : 0;
      return {
        barH: Math.round(r.height), barY: Math.round(r.y), padding: bs.padding, gap: bs.gap,
        bands: bands.length, cols: centers.length,
        tableH: Math.round(tr.height), rowH: Math.round(rowH),
        rowsVisible: Math.floor(tr.height / (rowH || 1))
      };
    });
    console.log('  · 筛选栏 = ' + JSON.stringify(bar));
    check('筛选栏高度已压到 100px 以内（改造前实测 176px）', bar.barH < 100, 'h=' + bar.barH);
    check('筛选栏整体不超过 3 个视觉行', bar.bands <= 3, 'bands=' + bar.bands);
    check('所有筛选字段都在场（未被压缩掉）', bar.cols >= 9, 'cols=' + bar.cols);
    check('每个区间字段也变成「标签在左、控件在右」一行',
      await page.evaluate(() => {
        const f = [...document.querySelectorAll('.sector-detail-modal .sector-filter-bar .filter-field')]
          .find(x => /市净比/.test(x.textContent));
        if (!f) return false;
        const lab = f.querySelector('label'), inp = f.querySelector('input');
        if (!lab || !inp) return false;
        return getComputedStyle(f).flexDirection === 'row' &&
          Math.abs((lab.getBoundingClientRect().y + lab.getBoundingClientRect().height / 2) -
            (inp.getBoundingClientRect().y + inp.getBoundingClientRect().height / 2)) <= 4;
      }));
    check('行业下拉仍可展开（压缩没有把下拉面板挤坏）',
      await page.evaluate(async () => {
        const t = document.querySelector('.sector-detail-modal .industry-dropdown-toggle');
        if (!t) return false;
        t.click();
        await new Promise(r => setTimeout(r, 200));
        const p = document.querySelector('.sector-detail-modal .industry-dropdown-panel');
        return !!p && p.getBoundingClientRect().height > 0;
      }));
    check('表格可视区一屏能看到 ≥10 只股票', bar.rowsVisible >= 10,
      `tableH=${bar.tableH} rowH=${bar.rowH} rows=${bar.rowsVisible}`);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  }

  /* ---------------- 3. 成分股勾选弹窗 ---------------- */
  console.log('\n3) 成分股勾选弹窗：「产品业务」左右排列 + 工具栏/列表压缩');
  {
    const { page, errors } = shared;
    await page.evaluate(() => { document.querySelector('.sector-detail-modal .modal-header .btn-icon').click(); });
    await page.waitForTimeout(400);
    await page.locator('.sector-search input').first().fill('测试概念');
    await page.locator('button:has-text("搜索板块")').click();
    await page.waitForSelector('.sector-result-item', { timeout: 20000 });
    await page.locator('.sector-result-item').first().click();
    await page.waitForSelector('.sector-pick-head', { timeout: 25000 });
    await page.waitForTimeout(600);

    const g = await page.evaluate(GEOM, ['.sector-pick-biz', ':scope > *']);
    check('勾选弹窗存在「产品业务」字段', !!g, 'missing');
    if (g) {
      const label = g.kids[0], input = g.kids.find(k => k.tag === 'INPUT'), btn = g.kids.find(k => k.tag === 'BUTTON');
      check('flex-direction = row', g.flexDir === 'row', g.flexDir);
      check('标签 / 输入框 / 算相关度 同一行（差 ≤ 4px）',
        !!label && !!input && !!btn && Math.abs(label.cy - input.cy) <= 4 && Math.abs(input.cy - btn.cy) <= 4,
        JSON.stringify([label && label.cy, input && input.cy, btn && btn.cy]));
      check('顺序为 标签 → 输入框 → 按钮',
        !!label && !!input && !!btn && label.right <= input.x + 1 && input.right <= btn.x + 1,
        JSON.stringify([label && label.right, input && input.x, btn && btn.x]));
      check('整块高度只占一行', g.self.h <= 32, 'h=' + Math.round(g.self.h));
    }

    const pick = await page.evaluate(() => {
      const bar = document.querySelector('.sector-pick-toolbar');
      const br = bar.getBoundingClientRect();
      const fl = document.querySelector('.sector-pick-filter');
      const fr = fl.getBoundingClientRect();
      const cbs = [...fl.querySelectorAll('input[type=checkbox]')].map(c => {
        const r = c.getBoundingClientRect(); return { cy: Math.round(r.y + r.height / 2), x: Math.round(r.x) };
      });
      const list = document.querySelector('.sector-pick-list');
      const lr = list.getBoundingClientRect();
      const item = document.querySelector('.sector-pick-item');
      const ir = item.getBoundingClientRect();
      const inp = document.querySelector('.sector-pick-biz input');
      return {
        barH: Math.round(br.height), filterH: Math.round(fr.height), filterDisplay: getComputedStyle(fl).display,
        cbRows: cbs.length ? cbs.map(c => c.cy).filter((v, i, a) => a.indexOf(v) === i).length : 0,
        cbCount: cbs.length,
        listH: Math.round(lr.height), itemH: Math.round(ir.height),
        rowsVisible: Math.floor(lr.height / ir.height),
        inputW: Math.round(inp.getBoundingClientRect().width)
      };
    });
    console.log('  · 弹窗 = ' + JSON.stringify(pick));
    check('工具栏高度已压缩（≤ 60px）', pick.barH <= 60, 'h=' + pick.barH);
    check('四个「去除」复选框排在同一行', pick.cbCount === 4 && pick.cbRows === 1,
      `cb=${pick.cbCount} rows=${pick.cbRows}`);
    check('产品业务输入框宽度 ≥ 180px（不再被压到 110px）', pick.inputW >= 180, 'w=' + pick.inputW);
    check('列表行高压缩后一屏可见 ≥8 只股票', pick.rowsVisible >= 8,
      `listH=${pick.listH} itemH=${pick.itemH} rows=${pick.rowsVisible}`);
    check('原有 4 个去除筛选都还在（功能未丢）',
      (await page.locator('.sector-pick-filter input[type=checkbox]').count()) === 4);
    check('「全选 / 全不选」仍在工具栏里',
      (await page.locator('.sector-pick-toolbar .checkbox-label').count()) >= 1);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  }

  await shared.ctx.close();
  await browser.close();
  A.srv.close();

  console.log('\n============================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('============================================');
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(2); });
