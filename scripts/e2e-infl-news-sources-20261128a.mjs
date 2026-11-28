/* ============================================================
 * e2e-infl-news-sources-20261128a.mjs — 验证影响力事件新闻集合新增同花顺快讯 + 今日头条新闻
 *
 * 改动：inflEnsureNews 在 11 平台每日快照之外，并行加载
 *   ① 同花顺 7×24 实时快讯（StockAPI.fetchThsLiveBriefs）
 *   ② 今日头条新闻（briefs-今日头条-日期.json）
 * 三者合并后按「正文 + 分钟级时间」去重，继续供首报锚定 / 自动事件聚类 / 近 N 交易日筛选使用。
 *
 * 覆盖：
 *   1) 静态接线：app.js 含两类来源加载与去重，index.html 说明文案同步
 *   2) 真实浏览器：拦截两类来源注入唯一测试新闻，刷新影响力事件后卡片可见且来源标签正确
 *   3) 版本戳 20261128a
 *   4) 无 JS 报错
 *
 * 用法：node scripts/e2e-infl-news-sources-20261128a.mjs
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
const VER = '20261128a';
const DAY = '2026-11-28';
const THS_TITLE = '工信部发布同花顺快讯测试专项行动方案';
const TT_TITLE = '国家发改委印发今日头条测试专项行动方案';

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

async function main() {
  console.log('0) 静态接线检查');
  const appTxt = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const indexTxt = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const authTxt = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
  const tags = [...new Set([...indexTxt.matchAll(/\?v=([0-9a-z]+)/g)].map(m => m[1]))];
  check('版本戳统一为 ' + VER, tags.length > 0 && tags.every(t => t === VER), JSON.stringify(tags));
  check('auth-boot ASSET_V=' + VER, authTxt.includes("var ASSET_V = '" + VER + "'"));
  check('app.js 已接入同花顺快讯', appTxt.includes('fetchThsLiveBriefs({ maxPages: 12'));
  check('app.js 已接入今日头条新闻文件', appTxt.includes("briefs-' + encodeURIComponent('今日头条') + '-' + d"));
  check('app.js 已按正文+分钟去重', appTxt.includes('seenNews') && appTxt.includes('slice(0, 16)'));
  check('页面说明已补充两类来源', indexTxt.includes('同花顺快讯 + 今日头条新闻'));

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // 先注册通用拦截，再注册专用路由（Playwright 后注册的优先）
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /^(https?:)?\/\/(gtimg\.cn|eastmoney\.com|workers\.dev)/.test(u.href), r => r.abort());
  await page.route(u => /news\.10jqka\.com\.cn\/tapp\/news\/push\/stock\//.test(u.href), async r => {
    const url = new URL(r.request().url());
    const pageNo = Number(url.searchParams.get('page') || 1);
    if (pageNo !== 1) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { list: [] } }) });
    const ctime = Math.floor(new Date(DAY + 'T10:00:00+08:00').getTime() / 1000) - 8 * 3600;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          list: [
            { id: 'ths-test-1', title: THS_TITLE, digest: THS_TITLE, ctime, url: 'https://news.10jqka.com.cn/test/1', tag: '快讯' },
            { id: 'ths-test-2', title: THS_TITLE, digest: THS_TITLE, ctime: ctime + 60, url: 'https://news.10jqka.com.cn/test/2', tag: '快讯' }
          ]
        }
      })
    });
  });
  await page.route(u => {
    try { return decodeURIComponent(new URL(r0(u)).pathname).includes('briefs-今日头条-' + DAY + '.json'); }
    catch (e) { return false; }
  }, r => {
    const items = [
      { id: 'tt-test-1', time: DAY + ' 10:10', text: TT_TITLE, url: '', stocks: [], subjects: [], cat: '财经' },
      { id: 'tt-test-2', time: DAY + ' 10:11', text: TT_TITLE, url: '', stocks: [], subjects: [], cat: '财经' }
    ];
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ date: DAY, source: 'toutiao', sourceName: '今日头条', generatedAt: new Date().toISOString(), total: items.length, items })
    });
  });
  function r0(u) { return typeof u === 'string' ? u : u.href; }

  console.log('1) 进入系统并打开「热门板块 → 影响力事件」');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '热门板块' }).click();
  await page.waitForSelector('.infl-main-list', { timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    const p = el && el.__vue_app__ && el.__vue_app__._container._vnode.component.proxy;
    return !!p && p.inflLoading === false;
  }, null, { timeout: 60000 });

  console.log('2) 用近 2 交易日窗口刷新，注入来源应进入新闻集合并聚合成事件');
  await page.evaluate(async () => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    p.setInflRegion('cn');
    p.setInflRangeDays(2);
    await p.refreshInfluence();
  });
  await page.waitForTimeout(1500);
  const uiText = await page.locator('.infl-main-list').innerText();
  check('同花顺快讯测试新闻进入影响力事件', uiText.includes(THS_TITLE), uiText.slice(0, 300));
  check('同花顺快讯来源标签可见', uiText.includes('同花顺快讯'), uiText.slice(0, 300));
  check('今日头条测试新闻进入影响力事件', uiText.includes(TT_TITLE), uiText.slice(0, 300));
  check('今日头条来源标签可见', uiText.includes('今日头条'), uiText.slice(0, 300));

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
