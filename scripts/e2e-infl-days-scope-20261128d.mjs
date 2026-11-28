/* ============================================================
 * e2e-infl-days-scope-20261128d.mjs
 * 验证：①影响力事件卡片不再显示「影响范围：中国境内」；
 *       ②三子版块重要程度口径：中国新闻=中国境内，美国新闻/世界新闻=世界境内；
 *       ③新增「影响天数」与「按影响天数」排序；④无 JS 报错。
 * 用法：node scripts/e2e-infl-days-scope-20261128d.mjs
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
const VER = '20261128d';
const DAY = '2026-11-28';
const CN_NEWS = '国务院部署新能源汽车下乡专项行动，A股充电桩概念股大涨';
const US_NEWS = '美联储宣布加息25个基点，全球市场流动性收紧';
const JP_NEWS = '日本央行宣布超预期加息25个基点';

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
  const cssTxt = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const authTxt = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
  const tags = [...new Set([...indexTxt.matchAll(/\?v=([0-9a-z]+)/g)].map(m => m[1]))];
  check('版本戳统一为 ' + VER, tags.length > 0 && tags.every(t => t === VER), JSON.stringify(tags));
  check('auth-boot ASSET_V=' + VER, authTxt.includes("var ASSET_V = '" + VER + "'"));
  check('app.js 含世界范围词表', appTxt.includes('const WORLD_INDUSTRY_WORDS =') && appTxt.includes('const WORLD_MARKET_WORDS ='));
  check('app.js 含重要程度范围函数', appTxt.includes('function inflImportanceScopeOf(e)'));
  check('app.js 含影响天数函数', appTxt.includes('function computeImpactDays(e)'));
  check('app.js 排序标签含影响天数', /const k = inflSortBy\.value;[\s\S]{0,180}if \(k === 'impactDays'\) return '影响天数';/.test(appTxt));
  check('app.js 排序逻辑含影响天数', appTxt.includes("if (by === 'impactDays')"));
  check('app.js 暴露新函数', appTxt.includes('computeImpactDays, inflImportanceScopeOf,'));
  check('index.html 新增按影响天数排序', indexTxt.includes('>按影响天数</button>'));
  check('index.html 新增影响天数 chip', indexTxt.includes('影响天数 <b>'));
  check('index.html 影响力面板已删影响范围 chip', (indexTxt.match(/影响范围：\{\{ impactScopeLabel\(e\.impactScope\) \}\}/g) || []).length === 1);
  check('index.html 含三子版块重要程度口径说明', indexTxt.includes('重要程度（20261128d，满分 100）') && indexTxt.includes('世界境内范围'));
  check('css 含影响天数样式', cssTxt.includes('.infl-impact-days'));

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
  await page.route(u => /news\.10jqka\.com\.cn\/tapp\/news\/push\/stock\//.test(u.href), async r => {
    const url = new URL(r.request().url());
    const pageNo = Number(url.searchParams.get('page') || 1);
    if (pageNo !== 1) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { list: [] } }) });
    const ctime = Math.floor(new Date(DAY + 'T10:00:00+08:00').getTime() / 1000) - 8 * 3600;
    const mk = (title, n) => ({ id: 'days-test-' + n, title, digest: title, ctime: ctime + n * 60, url: 'https://news.10jqka.com.cn/days/' + n, tag: '快讯' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      code: 0, data: { list: [
        mk(CN_NEWS, 1), mk(CN_NEWS, 2),
        mk(US_NEWS, 3), mk(US_NEWS, 4),
        mk(JP_NEWS, 5), mk(JP_NEWS, 6)
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
    return !!p && typeof p.computeImpactDays === 'function' && typeof p.inflImportanceScopeOf === 'function';
  }, null, { timeout: 60000 });

  console.log('2) 卡片字段与排序');
  const listText = await page.locator('.infl-main-list').innerText();
  check('影响力列表不含「影响范围：」', !listText.includes('影响范围：'), listText.slice(0, 180));
  const dayChips = await page.locator('.infl-main-list .infl-impact-days').allInnerTexts();
  check('事件卡片显示影响天数', dayChips.length > 0 && dayChips.every(s => /影响天数\s*\d{1,2}\s*交易日/.test(s)), JSON.stringify(dayChips.slice(0, 4)));
  const sortBtn = page.locator('.infl-sort-btn', { hasText: '按影响天数' });
  check('排序按钮存在', await sortBtn.count() === 1);
  await sortBtn.click();
  await page.waitForTimeout(600);
  const hint = await page.locator('.infl-sort-hint').first().innerText();
  check('排序提示=影响天数', hint.includes('影响天数'), hint);
  const nums = (await page.locator('.infl-main-list .infl-impact-days').allInnerTexts())
    .map(s => Number((s.match(/影响天数\s*(\d{1,2})/) || [])[1]));
  check('影响天数降序排列', nums.length > 1 && nums.every((n, i) => i === 0 || nums[i - 1] >= n), JSON.stringify(nums));

  console.log('3) 三子版块口径纯函数');
  const fnRes = await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const cn = { title: '国务院部署新能源汽车下乡，A股充电桩概念股大涨', region: 'cn', conceptName: '新能源车', affectedPeople: 320000000, affected: 86000000 };
    const us = { title: '美联储宣布加息25个基点，全球市场流动性收紧', region: 'us', conceptName: 'finance', affectedPeople: 6000000000, affected: 180000000 };
    const wo = { title: '日本央行超预期加息，全球市场波动', region: 'world', conceptName: 'finance', affectedPeople: 6000000000, affected: 180000000 };
    return {
      scopes: [p.inflImportanceScopeOf(cn), p.inflImportanceScopeOf(us), p.inflImportanceScopeOf(wo)],
      cnDetail: p.computeChinaImpact(cn).detail,
      usDetail: p.computeChinaImpact(us).detail,
      daysExplicit: p.computeImpactDays({ impact: { days: 7 } }),
      daysPolicy: p.computeImpactDays({ title: '国务院部署中长期产业规划并正式实施', cnImp: { score: 88 }, affectedPeople: 500000000 }),
      daysSimple: p.computeImpactDays({ title: '某公司发布季度财报', cnImp: { score: 20 }, affectedPeople: 10000 })
    };
  });
  check('中国新闻=中国境内，美国/世界新闻=世界境内', fnRes.scopes.join('|') === 'cn|world|world', JSON.stringify(fnRes.scopes));
  check('重要程度 detail 带范围标签', fnRes.cnDetail.scopeLabel === '中国境内' && fnRes.usDetail.scopeLabel === '世界境内', JSON.stringify({ cn: fnRes.cnDetail, us: fnRes.usDetail }));
  check('影响天数优先取显式字段', fnRes.daysExplicit === 7, String(fnRes.daysExplicit));
  check('政策类长事件影响天数更长', fnRes.daysPolicy > fnRes.daysSimple, JSON.stringify(fnRes));
  check('影响天数在 1~30', [fnRes.daysExplicit, fnRes.daysPolicy, fnRes.daysSimple].every(n => n >= 1 && n <= 30), JSON.stringify(fnRes));

  console.log('4) JS 报错');
  check('无未捕获异常', errors.length === 0, errors.join('; '));

  await browser.close();
  await new Promise(r => srv.close(r));
  console.log('\n[RESULT] ' + pass + '/' + (pass + fail) + ' 通过');
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(1); });
