/* ============================================================
 * e2e-batch6.mjs — 本轮 5 项改动的真实浏览器端到端验证
 *
 * 覆盖：
 *   1)「刷新后登录不上：加载超时 js/store.js」修复
 *      · 首屏不再依赖 unpkg CDN（Vue 已同源自托管），启动链路零第三方依赖
 *      · 脚本装载失败会自动重试（用 cache-buster 换新连接），重试成功后仍能正常进入
 *   2) 新闻追踪：搜索框改为「豆包联网搜索」——左侧按钮 + 关键词，点击/回车打开豆包，
 *      同时保留原有本页筛选能力
 *   3) 概念选股板块详情弹窗：筛选栏「固定筛选」左侧新增「产品业务」输入框，
 *      点「算相关度」按命中主营构成营收占比之和写入「相关度 / 命中主营业务」
 *   4) 成分股勾选弹窗：新增 现价 / 涨跌幅 / 总市值 / 相关度 / 命中主营业务 五列，
 *      并有独立的「产品业务」输入框（口径与选股板块一致）
 *   5) 热门板块：点击四个子版块内容后，先弹出「去除301/688/北交所/ST」选项，
 *      确认后才载入 —— 即内容出现前已完成剔除
 *
 * 只 mock 外部行情源（腾讯/东财），应用代码与 UI 交互全部为真实行为。
 * 用法：node scripts/e2e-batch6.mjs
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

/* ---------- 外部行情 mock ---------- */
/** 腾讯行情行（GBK 名称按字节写，避免转码） */
function quoteLine(code, nameGbk, changePct, price, cap) {
  // f[45] = 总市值(亿)，必须与 QUOTES 里每只股票的 cap 一致，否则「总市值」断言永远对不上
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

/** 板块列表（供 getAllSectors / searchSectors 用） */
const SECTOR_LIST = [
  { f12: 'BK0001', f14: '测试概念', f3: 3.30 },
  { f12: 'BK0002', f14: '测试行业', f3: 1.10 }
];
/** 成分股：BK0001 故意混入 301 / 688 / 北交所 / ST 各一只，用于验证「去除股票」 */
const CONSTITUENTS = {
  BK0001: [
    { f12: '600519', f14: '贵州茅台', f3: 5.55, f2: 1700 },
    { f12: '000858', f14: '五粮液', f3: -3.21, f2: 150 },
    { f12: '300750', f14: '宁德时代', f3: 2.10, f2: 260 },
    { f12: '301001', f14: '创业板测试', f3: 1.00, f2: 20 },
    { f12: '688001', f14: '科创测试', f3: 1.20, f2: 30 },
    { f12: '430001', f14: '北交所测试', f3: 0.90, f2: 10 },
    { f12: '000001', f14: 'ST测试', f3: -1.50, f2: 11.5 }
  ]
};
/** 主营构成（按产品，占比为百分数） */
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

/** 初始化 localStorage（只在首次导航写入，保证刷新后看到真实持久化结果） */
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
  const urls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => urls.push(r.url()));

  // 记录 window.open（不真的开新标签）
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = function (u) { window.__opened.push(String(u)); return { closed: false, focus() {} }; };
  });
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 腾讯实时行情（GBK）
  await page.route(u => /qt\.gtimg\.cn/.test(u.href), route => {
    const q = decodeURIComponent(route.request().url().split('q=')[1] || '');
    const codes = q.split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: Buffer.concat(codes.map(quoteFor)) });
  });
  await page.route(u => /smartbox\.gtimg\.cn/.test(u.href), route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'v_hint="";' }));
  /**
   * 东财：用一条统一路由覆盖全部东财域名。
   * 关键点：
   *  · 必须覆盖 push2 / push2delay / push2his（_eastFetch 会在这三个节点间轮询）
   *  · 未识别的东财接口直接返回「合法但空」的 JSON（而非 abort）——
   *    abort 会让代码走到 JSONP 兜底，每个请求白等 6~9 秒，测试会拖到几分钟
   *  · JSONP 请求（带 cb=）要按回调函数名包一层
   */
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
    // 其余东财接口：立即返回空结构，避免任何 JSONP 兜底等待
    return send({ rc: 0, data: { total: 0, diff: [] }, result: { data: [], count: 0 } });
  });
  // 其它外网直接断开（保证离线可跑）
  await page.route(u => /workers\.dev|vore\.top|ip\.sb/.test(u.href), route => route.abort());
  if (seedData) await page.addInitScript(seedScript(seedData), seedData);
  return { ctx, page, errors, urls };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load', timeout: 40000 });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
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
/** 取某个 ctx 表格里「指定表头」下、某只股票行的单元格文本 */
async function cellText(page, tableSel, code, headerLabel) {
  return await page.evaluate(([ts, cd, hl]) => {
    const table = document.querySelector(ts);
    if (!table) return null;
    const ths = [...table.querySelectorAll('thead th')];
    const idx = ths.findIndex(th => (th.textContent || '').trim().includes(hl));
    if (idx < 0) return null;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      const codeTxt = (tds[1] ? tds[1].textContent : '').trim();
      if (codeTxt.replace(/^(sh|sz|bj)/i, '') === cd.replace(/^(sh|sz|bj)/i, '')) {
        return (tds[idx] ? tds[idx].textContent : '').trim();
      }
    }
    return null;
  }, [tableSel, code, headerLabel]);
}

/* ---------- 种子数据 ---------- */
const NEWS = [
  { id: 'n1', date: '2026-09-16', content: '苹果产业链迎来新一轮备货周期', category: '主线概念', customTag: '苹果概念', relatedStocks: '', conceptCategory: '利好消费电子', industryCategory: '利好：消费电子', owner: 'admin' },
  { id: 'n2', date: '2026-09-16', content: '某公司发布业绩预告', category: '业绩预告', customTag: '业绩超预期', relatedStocks: '', conceptCategory: '—', industryCategory: '—', owner: 'admin' },
  { id: 'n3', date: '2026-09-15', content: '新能源车销量创新高', category: '行业动态', customTag: '新能源', relatedStocks: '', conceptCategory: '—', industryCategory: '—', owner: 'admin' }
];

const POOLS = [{
  // 注意 bk 故意用 BK9999：搜索命中的是 BK0001，若这里也用 BK0001
  // 会触发「该板块已在列表中」的查重提示，弹不出勾选弹窗
  id: 'sp1', name: '测试概念板块', bk: 'BK9999', type: '概念', createdAt: 1000, avgChange: 1.0,
  stocks: [
    { code: 'sh600519', name: '贵州茅台', industry: '食品饮料', todayPrice: 1700, dailyChange: 5.55, totalMarketCap: 21000 },
    { code: 'sz300750', name: '宁德时代', industry: '电力设备', todayPrice: 260, dailyChange: 2.10, totalMarketCap: 11400 }
  ]
}];

function mkSeed(extra) {
  return Object.assign({
    news: NEWS, stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
    hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [],
    sectorPools: POOLS,
    settings: { categories: ['主线概念', '业绩预告', '行业动态'], proxyUrl: '', dataPaused: false }
  }, extra || {});
}

/* ============================================================ */
const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ---------------- 1. 启动链路：不再依赖 CDN + 失败自动重试 ---------------- */
  console.log('1) 刷新后登录不上（加载超时 js/store.js）修复');
  {
    // 1a 正常启动：零 unpkg 依赖
    const { page, errors, urls } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#news');
    await loginFresh(page);
    const hasUnpkg = urls.some(u => /unpkg\.com/.test(u));
    const hasLocalVue = urls.some(u => /\/js\/vue\.global\.prod\.js/.test(u));
    check('首屏不再请求 unpkg.com（Vue 已同源自托管）', !hasUnpkg, 'unpkg 请求=' + hasUnpkg);
    check('改为同源加载 js/vue.global.prod.js', hasLocalVue);
    check('登录后可正常进入应用', await page.evaluate(() => typeof Store === 'object'));
    check('页面无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await page.context().close();
  }
  {
    // 1b 首次下载 store.js 失败 → 自动换连接重试 → 仍能进入
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    let attempts = 0;
    const tried = [];
    await page.route('**/js/store.js*', route => {
      attempts++;
      tried.push(route.request().url());
      if (attempts === 1) return route.abort('failed');   // 模拟「连接建起来但拿不到数据」
      return route.continue();
    });
    await gotoApp(page, A.port, '#news');
    await loginFresh(page);
    check('store.js 首次失败后自动重试并成功进入', await page.evaluate(() => typeof Store === 'object'));
    check('重试请求带新的 cache-buster（换新连接）', tried.length >= 2 && /_r=2/.test(tried[1] || ''), tried.join(' | '));
    check('重试过程无未捕获 JS 报错', errors.filter(e => !/net::ERR/.test(e)).length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ---------------- 2. 新闻追踪：豆包联网搜索 ---------------- */
  console.log('2) 新闻追踪搜索框 → 豆包联网搜索');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#news');
    await loginFresh(page);

    const btn = page.locator('.web-search-btn');
    const inp = page.locator('.web-search-input');
    check('左侧「🫘 豆包搜索」按钮存在', await btn.count() === 1);
    check('按钮文案含「豆包搜索」', /豆包搜索/.test(await btn.textContent()));
    const bb = await btn.boundingBox();
    const ib = await inp.boundingBox();
    check('按钮在输入框左侧', bb && ib && bb.x + bb.width <= ib.x + 1, `btn=${bb && bb.x} input=${ib && ib.x}`);

    // 本页筛选能力保留
    await inp.fill('苹果概念');
    await page.waitForTimeout(200);
    const rowsAfterFilter = await page.locator('.news-table tbody tr').count();
    check('输入后仍在本页按「散户参考」筛选（命中 1 条）', rowsAfterFilter === 1, '行数=' + rowsAfterFilter);

    // 点击按钮 → 打开豆包
    await btn.click();
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => window.__opened);
    check('点击后新开豆包联网搜索', opened.length === 1 && opened[0] === 'https://www.doubao.com/chat/?q=' + encodeURIComponent('苹果概念'), JSON.stringify(opened));

    // 回车同样可触发
    await page.evaluate(() => { window.__opened = []; });
    await inp.press('Enter');
    await page.waitForTimeout(300);
    const opened2 = await page.evaluate(() => window.__opened);
    check('回车同样触发豆包搜索', opened2.length === 1 && /doubao\.com/.test(opened2[0]), JSON.stringify(opened2));
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ---------------- 3. 概念选股板块详情弹窗：产品业务输入框 ---------------- */
  console.log('3) 概念选股板块详情弹窗：固定筛选左侧的「产品业务」输入框');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);

    await page.locator('.pool-card').first().click();
    await page.waitForSelector('.sector-detail-modal', { timeout: 15000 });
    const bizInput = page.locator('.sector-detail-modal .biz-field input');
    const lockBtn = page.locator('.sector-detail-modal button:has-text("固定筛选")');
    check('详情筛选栏有「产品业务」输入框', await bizInput.count() === 1);
    const x1 = await bizInput.boundingBox();
    const x2 = await lockBtn.boundingBox();
    check('输入框位于「固定筛选」按钮左侧', x1 && x2 && x1.x + x1.width <= x2.x + 1, `biz=${x1 && x1.x} lock=${x2 && x2.x}`);
    check('「🔗 算相关度」按钮存在', await page.locator('.sector-detail-modal button:has-text("算相关度")').count() === 1);
    check('表格已有「命中主营业务」列', (await page.locator('.sector-detail-modal thead th', { hasText: '命中主营业务' }).count()) === 1);

    await bizInput.fill('茅台酒');
    await page.locator('.sector-detail-modal button:has-text("算相关度")').click();
    await page.waitForFunction(() => {
      const t = document.querySelector('.sector-detail-modal .pool-detail-table');
      return t && /85\.7/.test(t.textContent || '');
    }, null, { timeout: 30000 });

    const rel = await cellText(page, '.sector-detail-modal .pool-detail-table', 'sh600519', '相关度');
    const hit = await cellText(page, '.sector-detail-modal .pool-detail-table', 'sh600519', '命中主营业务');
    check('贵州茅台相关度 = 命中主营段营收占比之和 85.7%', rel === '85.7%', rel);
    check('命中主营业务显示明细「茅台酒 85.7%」', /茅台酒/.test(hit || '') && /85\.7%/.test(hit || ''), hit);
    const rel2 = await cellText(page, '.sector-detail-modal .pool-detail-table', 'sz300750', '相关度');
    check('未命中的股票相关度记 0.0%（不误命中）', rel2 === '0.0%', rel2);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ---------------- 4. 成分股勾选弹窗：五列字段 + 产品业务输入 ---------------- */
  console.log('4) 搜索点击后的成分股弹窗：现价/涨跌幅/总市值/相关度/命中主营业务');
  {
    const { ctx, page, errors } = await newPage(browser, mkSeed());
    await gotoApp(page, A.port, '#sector');
    await loginFresh(page);

    await page.locator('.sector-search input').first().fill('测试概念');
    await page.locator('button:has-text("搜索板块")').click();
    await page.waitForSelector('.sector-result-item', { timeout: 20000 });
    await page.locator('.sector-result-item').first().click();
    await page.waitForSelector('.sector-pick-head', { timeout: 20000 });

    const heads = await page.$$eval('.sector-pick-head > span', els => els.map(e => e.textContent.trim().replace(/^(sh|sz|bj)/i, '')));
    for (const h of ['现价', '涨跌幅', '总市值', '相关度', '命中主营业务']) {
      check(`弹框列「${h}」存在`, heads.includes(h), heads.join('|'));
    }
    check('原有去除301/688/北交所/ST 筛选保留',
      (await page.locator('.sector-pick-filter input[type=checkbox]').count()) === 4);

    const biz = page.locator('.sector-pick-biz input');
    check('弹框有独立「产品业务」输入框', await biz.count() === 1);
    await biz.fill('动力电池');
    await page.locator('.sector-pick-biz button:has-text("算相关度")').click();
    await page.waitForFunction(() => {
      const el = [...document.querySelectorAll('.sector-pick-item')]
        .find(x => /300750/.test(x.textContent || ''));
      return el && /70\.0%/.test(el.textContent || '');
    }, null, { timeout: 30000 });

    const row = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.sector-pick-item')].find(x => /300750/.test(x.textContent || ''));
      if (!el) return null;
      return {
        code: el.querySelector('.spc-code').textContent.trim(),
        name: el.querySelector('.spc-name').textContent.trim(),
        price: el.querySelectorAll('.spc-num')[0].textContent.trim(),
        chg: el.querySelectorAll('.spc-num')[1].textContent.trim(),
        cap: el.querySelectorAll('.spc-num')[2].textContent.trim(),
        rel: el.querySelector('.spc-rel').textContent.trim(),
        biz: el.querySelector('.spc-biz').textContent.trim()
      };
    });
    check('宁德时代 现价正确', row && row.price === '260.00', JSON.stringify(row));
    check('宁德时代 涨跌幅正确', row && row.chg === '+2.10%', row && row.chg);
    check('宁德时代 总市值正确', row && row.cap === '11400.00亿', row && row.cap);
    check('宁德时代 相关度 = 70.0%', row && row.rel === '70.0%', row && row.rel);
    check('宁德时代 命中主营业务 = 动力电池系统 70.0%', row && /动力电池系统/.test(row.biz), row && row.biz);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ---------------- 5. 热门板块：载入前先弹「去除股票」 ---------------- */
  console.log('5) 热门板块点击子版块后，先弹「去除股票」选项');
  {
    const seed = mkSeed({ hotBoards: [{ name: '测试热门板块', bk: 'BK0001', change: 3.30 }] });
    const { ctx, page, errors } = await newPage(browser, seed);
    await gotoApp(page, A.port, '#hot');
    await loginFresh(page);

    await page.locator('.hot-panel .hot-item').first().click();
    await page.waitForSelector('.hot-exclude-modal', { timeout: 15000 });
    const labels = await page.$$eval('.hot-exclude-opts label', els => els.map(e => e.textContent.trim().replace(/^(sh|sz|bj)/i, '')));
    for (const t of ['去除301', '去除688', '去除北交所', '去除ST']) {
      check(`弹窗含「${t}」选项`, labels.some(l => l.includes(t)), labels.join('|'));
    }
    // 空态时模板会渲染一行 .empty-row 占位，所以不能用「tbody tr 数 === 0」判断是否已载入，
    // 应判断「板块：xxx · N 只」这行汇总文案还没出现
    check('弹窗出现在内容出现之前（尚未载入任何板块明细）',
      (await page.locator('.hot-detail-board').count()) === 0
      && (await page.locator('.hot-stock-table .empty-row').count()) === 1);

    // 只除 688 → 应剩 6 只
    await page.locator('.hot-exclude-opts input').nth(1).check();
    await page.locator('.hot-exclude-modal button:has-text("应用并载入")').click();
    // 注意：模板里用的是全角括号「只）」，用半角 \)/ 会永远匹配不上而白等 60s
    await page.waitForFunction(() => /只）/.test((document.querySelector('.hot-detail-board') || {}).textContent || ''), null, { timeout: 60000 });
    // 等载入完成（loading 结束后才允许再次点击，否则会被 hotBoardLoading 拦掉）。
    // ⚠️ 加载提示是 h3 内的兄弟节点，不在 .hot-detail-board 里面，别写错选择器。
    await page.waitForFunction(
      () => !document.querySelector('.hot-detail-head h3 .muted.small'), null, { timeout: 90000 });
    let rows = await page.$$eval('.hot-stock-table tbody tr td:nth-child(2)', els => els.map(e => e.textContent.trim().replace(/^(sh|sz|bj)/i, '')));
    check('勾「去除688」后 688 股票被剔除', !rows.some(c => c.startsWith('688')) && rows.length === 6, rows.join(','));

    // 再点一次，四种全勾 → 剩 3 只（301001/688001/430001/000001 被剔除；
    // 300750 宁德时代属创业板 300 开头，不属「去除301」，应保留）
    await page.locator('.hot-panel .hot-item').first().click();
    await page.waitForSelector('.hot-exclude-modal', { timeout: 15000 });
    check('弹窗记住上次勾选（会话内共享规则）', await page.locator('.hot-exclude-opts input').nth(1).isChecked());
    for (const i of [0, 2, 3]) await page.locator('.hot-exclude-opts input').nth(i).check();
    await page.locator('.hot-exclude-modal button:has-text("应用并载入")').click();
    await page.waitForFunction(() => {
      const t = (document.querySelector('.hot-detail-board') || {}).textContent || '';
      return /3 只/.test(t);
    }, null, { timeout: 60000 });
    rows = await page.$$eval('.hot-stock-table tbody tr td:nth-child(2)', els => els.map(e => e.textContent.trim().replace(/^(sh|sz|bj)/i, '')));
    check('四种全勾后仅剩 3 只（301/688/北交所/ST 全被剔除）', rows.length === 3, rows.join(','));
    check('剩余股票为 600519 / 000858 / 300750（300 开头不误伤）',
      rows.every(c => ['600519', '000858', '300750'].includes(c)), rows.join(','));
    const filterRows = await page.locator('.filter-scroll:visible tbody tr').count();
    check('「筛选板块」同步为过滤后结果（同样 3 只）', filterRows === rows.length,
      `筛选板块=${filterRows} 明细=${rows.length}`);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
