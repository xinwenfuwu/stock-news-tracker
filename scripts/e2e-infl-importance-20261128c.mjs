/* ============================================================
 * e2e-infl-importance-20261128c.mjs
 * 验证「重要程度」字段（新闻池 → 中国产业 + 中国股市影响程度）与三个子版块改名
 *   1) 静态接线 / 版本戳
 *   2) 真实浏览器：三个 tab 文案 = 中国新闻 / 美国新闻 / 世界新闻
 *   3) 真实浏览器：排序按钮 = 按重要程度，切换后提示同步
 *   4) 真实浏览器：卡片显示「重要程度」分值，分值在 5~100 区间
 *   5) 真实浏览器：注入中国产业+股市新闻，验证新闻池佐证抬高重要程度分值
 *   6) 无 JS 报错
 * 用法：node scripts/e2e-infl-importance-20261128c.mjs
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
const VER = '20261128c';
const DAY = '2026-11-28';
const CN_NEWS = '国务院部署新能源汽车下乡专项行动，A股充电桩概念股大涨，北向资金加仓';

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

async function main() {
  console.log('0) 静态接线检查');
  const appTxt = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const indexTxt = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const authTxt = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
  const tags = [...new Set([...indexTxt.matchAll(/\?v=([0-9a-z]+)/g)].map(m => m[1]))];
  check('版本戳统一为 ' + VER, tags.length > 0 && tags.every(t => t === VER), JSON.stringify(tags));
  check('auth-boot ASSET_V=' + VER, authTxt.includes("var ASSET_V = '" + VER + "'"));
  check('app.js 含中国产业词表', appTxt.includes('const CN_INDUSTRY_WORDS ='));
  check('app.js 含中国股市词表', appTxt.includes('const CN_STOCK_WORDS ='));
  check('app.js 含新闻池佐证函数', appTxt.includes('function _cnPoolCorroboration(e)'));
  check('app.js 重要程度暴露供验证', appTxt.includes('inflStrictRegionOf, computeChinaImpact,'));
  check('app.js 影响力排序标签已改名', /const k = inflSortBy\.value;[\s\S]{0,160}if \(k === 'cnimp'\) return '重要程度';/.test(appTxt));
  check('index.html 排序按钮=按重要程度', indexTxt.includes('>按重要程度</button>'));
  check('index.html 卡片字段=重要程度', indexTxt.includes('>重要程度 <b>'));
  check('index.html 三个新标签', ['🇨🇳 中国新闻</button>', '🇺🇸 美国新闻</button>', '🌍 世界新闻</button>'].every(s => indexTxt.includes(s)));
  check('index.html 旧三标签已清零', !['>🇨🇳 中国</button>', '>🇺🇸 美国</button>', '>🌍 全世界</button>'].some(s => indexTxt.includes(s)));
  check('index.html 含重要程度口径说明', indexTxt.includes('重要程度（20261128c，满分 100）'));

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /^(https?:)?\/\/(gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com)/.test(u.href), r => r.abort());
  // 注入中国产业+股市同题新闻（3 条形成语义簇）+ 美国 / 日本各 2 条
  await page.route(u => /news\.10jqka\.com\.cn\/tapp\/news\/push\/stock\//.test(u.href), async r => {
    const url = new URL(r.request().url());
    const pageNo = Number(url.searchParams.get('page') || 1);
    if (pageNo !== 1) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { list: [] } }) });
    const ctime = Math.floor(new Date(DAY + 'T10:00:00+08:00').getTime() / 1000) - 8 * 3600;
    const mk = (title, n) => ({ id: 'imp-test-' + n, title, digest: title, ctime: ctime + n * 60, url: 'https://news.10jqka.com.cn/imp/' + n, tag: '快讯' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      code: 0, data: { list: [
        mk(CN_NEWS, 1), mk(CN_NEWS, 2), mk(CN_NEWS, 3),
        mk('美联储宣布加息25个基点，美股三大指数收跌', 4), mk('美联储加息25个基点，美股指数收跌', 5),
        mk('日本央行宣布超预期加息25个基点', 6), mk('日本央行超预期加息25个基点', 7)
      ] }
    }) });
  });
  await page.route(u => {
    try { return /briefs-.+-\d{4}-\d{2}-\d{2}\.json/.test(new URL(u.href).pathname); }
    catch (e) { return false; }
  }, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: DAY, items: [] }) }));

  console.log('1) 进入系统并打开影响力事件');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '热门板块' }).click();
  await page.waitForSelector('.infl-main-list', { timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    const p = el && el.__vue_app__ && el.__vue_app__._container._vnode.component.proxy;
    return !!p && typeof p.computeChinaImpact === 'function';
  }, null, { timeout: 60000 });

  console.log('2) 页面文案与排序联动');
  const tabTexts = (await page.locator('.infl-region-tabs .infl-tab').allInnerTexts()).slice(0, 3);
  check('三个 tab 文案正确', tabTexts.map(s => s.trim()).join('|') === '🇨🇳 中国新闻|🇺🇸 美国新闻|🌍 世界新闻', JSON.stringify(tabTexts));
  const sortBtn = page.locator('.infl-sort-btn', { hasText: '按重要程度' });
  check('排序按钮存在', await sortBtn.count() === 1);
  await sortBtn.click();
  await page.waitForTimeout(600);
  const hint = await page.locator('.infl-sort-hint').first().innerText();
  check('排序提示=重要程度', hint.includes('重要程度'), hint);
  const chipText = await page.locator('.infl-main-list .infl-cnimp').first().innerText();
  check('卡片显示重要程度分值', /重要程度\s*\d{1,3}/.test(chipText), chipText);
  const scores = await page.locator('.infl-main-list .infl-cnimp').allInnerTexts();
  const nums = scores.map(s => Number((s.match(/(\d{1,3})/) || [])[1])).filter(n => !isNaN(n));
  check('全部分值在 5~100', nums.length > 0 && nums.every(n => n >= 5 && n <= 100), JSON.stringify(nums.slice(0, 8)));

  console.log('3) 新闻池佐证对重要程度的影响');
  // 等待后台全网新闻加载完成（首报锚定 + 自动聚类）
  await page.waitForTimeout(3500);
  const scored = await page.evaluate((title) => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const fn = p.computeChinaImpact;
    const hit = fn({
      title, summary: title, conceptName: '新能源车', region: 'cn',
      bullConcepts: ['充电桩'], bullIndustries: ['汽车'], relatedStocks: ['比亚迪'],
      affectedPeople: 320000000, affected: 86000000, autoReports: 3
    });
    const ctrl = fn({
      title: '某地公交车线路调整公告', summary: '公交线路优化', conceptName: '', region: 'cn',
      affectedPeople: 12000, affected: 300
    });
    return { hit, ctrl };
  }, CN_NEWS);
  check('命中新闻池的事件有同题报道', scored.hit.detail && scored.hit.detail.reports > 0, JSON.stringify(scored.hit));
  check('命中事件重要程度显著高于无关事件', scored.hit.score > scored.ctrl.score + 15, JSON.stringify(scored));
  check('分值不超过 100', scored.hit.score <= 100 && scored.ctrl.score >= 5, JSON.stringify(scored));

  console.log('4) JS 报错');
  check('无未捕获异常', errors.length === 0, errors.join('; '));

  await browser.close();
  await new Promise(r => srv.close(r));
  console.log('\n[RESULT] ' + pass + '/' + (pass + fail) + ' 通过');
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(1); });
