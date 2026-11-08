/* ============================================================
 * e2e-index-metric-20261108g.mjs — 真实浏览器验证「各市股指 → 指数指标」
 * 需求：行业归类下的「电子」子类不再混入指数类新闻；指数新闻全部归纳到「指数指标」。
 * 用法：node scripts/e2e-index-metric-20261108g.mjs
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
const TODAY = '2026-11-08';

const INDEX_NEWS = [
  '格隆汇11月8日｜上证指数收涨0.66%，深证成指涨1.2%，创业板指涨1.8%',
  'A股三大指数集体高开，半导体板块领涨',
  '恒生指数收跌0.5%，恒生科技指数跌1.2%',
  '美股三大指数收盘：道指涨0.3%，纳指涨1.1%，标普500涨0.7%',
  '科创50指数涨超2%，芯片股走强',
  '沪深300指数期货主力合约涨0.4%',
  '富时中国A50指数期货直线拉升，A股大盘翻红',
  '北证50指数涨3%，沪深两市成交额突破1.5万亿元',
  '日经225指数收盘涨0.8%，韩国KOSPI指数涨0.5%',
  '台湾加权指数收盘涨1.1%，台股电子股走强',
  '中证500指数涨0.9%，中证1000指数涨1.3%',
  '纳斯达克100指数期货跌0.4%',
  '德国DAX指数收涨0.6%，法国CAC40涨0.3%'
];
const INDUSTRY_NEWS = [
  '电子行业拉动明显 前8月规上工业企业利润继续较快增长',
  '半导体板块大涨，中芯国际涨超5%，芯片产业链走强',
  '据工信部消息，电子行业《多通道星网链信道仿真模拟器》等11项行业标准公示',
  '62家百亿私募集体调研！电子行业成香饽饽'
];
const BRIEFS = INDEX_NEWS.concat(INDUSTRY_NEWS).map((text, i) => ({
  text, time: TODAY + ' 10:' + String(i).padStart(2, '0'), id: 'g' + i
}));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};
function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('404'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

async function groupByName(page, name) {
  const groups = page.locator('.brief-cat-group:visible');
  const n = await groups.count();
  for (let i = 0; i < n; i++) {
    const h = await groups.nth(i).locator('.bcg-head').innerText();
    if (h.indexOf(name) >= 0) return groups.nth(i);
  }
  return null;
}
async function expandRow(page, group, label) {
  const names = (await group.locator('.bc-name').allInnerTexts()).map(s => s.trim());
  const i = names.indexOf(label);
  if (i < 0) return null;
  const row = group.locator('.brief-cat').nth(i);
  await row.locator('.bc-caret').click();
  await row.locator('.brief-news').waitFor({ timeout: 10000 });
  return {
    row,
    count: (await row.locator('.bc-count').innerText()).trim(),
    news: (await row.locator('.brief-news .brief-text').allInnerTexts()).map(s => s.trim())
  };
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // 外部依赖全部离线；unpkg 用本地 Vue 副本（避免网络抖动）
  await page.route(u => /github\.io|api\.github\.com|sichina\.dpdns\.org|eastmoney|gtimg|cls\.cn|stcn\.com|workers\.dev/.test(u.href), r => r.abort());
  await page.route('**unpkg.com/**', r => fs.existsSync(VUE_LOCAL)
    ? r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }) : r.abort());
  // 单一 handler 分发 data/hot-topics，避免多个 route 的逆注册顺序互相吞噬
  await page.route('**/data/hot-topics/**', r => {
    const u = r.request().url();
    if (/index\.json/.test(u)) {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ briefsDates: [TODAY], dates: [TODAY] }) });
    }
    if (/briefs-.*\.json/.test(u)) {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: BRIEFS }) });
    }
    return r.fulfill({ status: 404, body: '{}' });
  });

  console.log('「各市股指 → 指数指标」真实浏览器验证');
  await page.goto(`http://127.0.0.1:${A.port}/#news`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 45000 });
  await page.waitForFunction(() => { const el = document.getElementById('app'); return !!(el && el.__vue_app__); }, null, { timeout: 45000 });
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('.brief-cat-group')].filter(e => e.offsetParent !== null);
    return els.some(e => [...e.querySelectorAll('.bc-name')].some(n => n.textContent.trim() === '指数指标'));
  }, null, { timeout: 30000 });

  // 1) 三个归类分组的子类名
  // 新闻追踪页并排展示「概念归类 / 行业归类」两组；题材归类在「全球信息」页，稍后单独验证
  for (const label of ['概念归类', '行业归类']) {
    const g = await groupByName(page, label);
    check(`${label}分组存在`, !!g);
    if (!g) continue;
    const names = (await g.locator('.bc-name').allInnerTexts()).map(s => s.trim());
    check(`${label}显示新子类「指数指标」`, names.indexOf('指数指标') >= 0, names.join('/'));
    check(`${label}不再显示旧名「各市股指」`, names.indexOf('各市股指') < 0, names.join('/'));
  }

  // 2) 行业归类：指数指标 = 13 条，且含「半导体板块领涨」这条旧逻辑会误入电子的新闻
  const ind = await groupByName(page, '行业归类');
  if (ind) {
    const idx = await expandRow(page, ind, '指数指标');
    check('行业归类可展开「指数指标」子类', !!idx);
    if (idx) {
      check('指数指标条数 = 13', idx.count === '13', idx.count);
      check('指数指标展开 13 条快讯', idx.news.length === 13, idx.news.length);
      check('含「A股三大指数集体高开，半导体板块领涨」', idx.news.some(t => t.indexOf('三大指数集体高开') >= 0), idx.news.join(' | ').slice(0, 200));
      check('含境外指数（台湾加权 / 德国DAX / 纳斯达克100）',
        idx.news.some(t => t.indexOf('台湾加权') >= 0) && idx.news.some(t => t.indexOf('德国DAX') >= 0)
        && idx.news.some(t => t.indexOf('纳斯达克100') >= 0));
      check('指数指标里没有纯电子行业新闻', INDUSTRY_NEWS.every(t => !idx.news.some(n => n.indexOf(t.slice(0, 12)) >= 0)));
    }
    const ele = await expandRow(page, ind, '电子');
    check('行业归类可展开「电子」子类', !!ele);
    if (ele) {
      check('电子条数 = 4', ele.count === '4', ele.count);
      check('电子展开 4 条快讯', ele.news.length === 4, ele.news.length);
      check('电子子类不再含任何指数新闻', INDEX_NEWS.every(t => !ele.news.some(n => n.indexOf(t.slice(0, 12)) >= 0)), ele.news.join(' | '));
      check('电子子类仍含真实电子行业新闻', ele.news.some(t => t.indexOf('电子行业拉动明显') >= 0));
    }
  }

  // 3) 「全球信息」页：题材归类同样改名（三套维度口径一致）
  await page.click('.nav-item:has-text("全球信息")');
  await page.waitForTimeout(600);
  const themeG = await groupByName(page, '题材归类');
  check('全球信息页存在「题材归类」分组', !!themeG);
  if (themeG) {
    const names = (await themeG.locator('.bc-name').allInnerTexts()).map(s => s.trim());
    check('题材归类显示新子类「指数指标」', names.indexOf('指数指标') >= 0, names.join('/'));
    check('题材归类不再显示旧名「各市股指」', names.indexOf('各市股指') < 0, names.join('/'));
  }

  // 4) 浏览器内直接驱动已加载的分类引擎
  const engine = await page.evaluate(({ idx, elec }) => {
    const HT = window.HotTopics;
    const mk = a => a.map((text, i) => ({ text, time: '2026-11-08 10:' + String(i).padStart(2, '0') }));
    const all = mk(idx.concat(elec));
    const rows = HT.briefStats(all, 'industry');
    return {
      indexRow: (rows.find(r => r.name === '指数指标') || {}).count,
      elecRow: (rows.find(r => r.key === 'i_005') || {}).count,
      oldName: rows.some(r => r.name === '各市股指'),
      dims: HT.BRIEF_INDUSTRY_DIMS.filter(d => d.name === '指数指标').length
    };
  }, { idx: INDEX_NEWS, elec: INDUSTRY_NEWS });
  check('浏览器内引擎：指数指标 13 条', engine.indexRow === 13, engine.indexRow);
  check('浏览器内引擎：电子 4 条', engine.elecRow === 4, engine.elecRow);
  check('浏览器内引擎：无旧子类名', engine.oldName === false);
  check('浏览器内引擎：行业维度仅 1 个「指数指标」子类', engine.dims === 1, engine.dims);
  check('全程无 JS 报错', errors.length === 0, errors.join(' | '));

  await ctx.close(); await browser.close(); A.srv.close();
  console.log(`\nRESULT ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};
main().catch(e => { console.error('E2E_ERROR', e); process.exit(1); });
