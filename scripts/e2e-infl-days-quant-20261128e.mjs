/* ============================================================
 * e2e-infl-days-quant-20261128e.mjs
 * 验证：影响天数改为 DeepSeek 式量化多因子预测的「利好概念预计上涨交易日数」
 *  ①静态接线（版本/函数/暴露/文案）；②页面 chip + 等级徽标 + title 因子明细；
 *  ③六因子单调响应（催化/叙事/容量/热度/新鲜度/确定性）；④detail 可解释字段；
 *  ⑤天数范围 1~10 与降序排序；⑥无 JS 报错。
 * 用法：node scripts/e2e-infl-days-quant-20261128e.mjs
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
const VER = '20261128e';
const DAY = '2026-11-28';

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
  check('app.js 含量化模型六因子函数', ['_impactCatalyst','_impactNarrative','_impactBreadth','_impactHeat','_impactFresh','_impactCertainty'].every(k => appTxt.includes('function ' + k + '(')));
  check('app.js 含 computeImpactDaysDetailed', appTxt.includes('function computeImpactDaysDetailed(e)'));
  check('app.js 暴露详细函数', appTxt.includes('computeImpactDays, computeImpactDaysDetailed, inflImportanceScopeOf,'));
  check('app.js 挂 impactDaysInfo', appTxt.includes('x.impactDaysInfo = _id;'));
  check('index.html 说明为量化多因子口径', indexTxt.includes('影响天数（20261128e，量化多因子）') && indexTxt.includes('利好概念预计上涨交易日数'));
  check('index.html 卡片显示等级徽标', indexTxt.includes("'lv-' + e.impactDaysInfo.level"));
  check('index.html 卡片 title 含因子明细', indexTxt.includes('因子分：催化') && indexTxt.includes('e.impactDaysInfo.f.catalyst'));
  check('index.html 排序按钮 title 更新', indexTxt.includes('量化多因子预测的'));
  check('css 含等级徽标样式', cssTxt.includes('.infl-days-level') && cssTxt.includes('.infl-days-level.lv-S'));

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /^(https?:)?\/\/(gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com|news\.10jqka\.com\.cn)/.test(u.href), r => r.abort());
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
    return !!p && typeof p.computeImpactDaysDetailed === 'function';
  }, null, { timeout: 60000 });

  console.log('2) 页面 chip / 等级 / title 明细');
  const dayChips = await page.locator('.infl-main-list .infl-impact-days').allInnerTexts();
  check('事件卡片显示影响天数', dayChips.length > 0 && dayChips.every(s => /影响天数\s*\d{1,2}\s*交易日/.test(s)), JSON.stringify(dayChips.slice(0, 4)));
  const lvCount = await page.locator('.infl-main-list .infl-days-level').count();
  check('事件卡片显示 S/A/B/C 等级', lvCount > 0 && lvCount === dayChips.length, 'lv=' + lvCount + ' chips=' + dayChips.length);
  const firstTitle = await page.locator('.infl-main-list .infl-impact-days').first().getAttribute('title');
  check('影响天数 title 含量化因子明细', firstTitle && firstTitle.includes('量化预测') && firstTitle.includes('因子分：催化') && firstTitle.includes('叙事'), (firstTitle || '').slice(0, 160));

  const sortBtn = page.locator('.infl-sort-btn', { hasText: '按影响天数' });
  check('排序按钮存在', await sortBtn.count() === 1);
  await sortBtn.click();
  await page.waitForTimeout(600);
  const nums = (await page.locator('.infl-main-list .infl-impact-days').allInnerTexts())
    .map(s => Number((s.match(/影响天数\s*(\d{1,2})/) || [])[1]));
  check('影响天数降序排列', nums.length > 1 && nums.every((n, i) => i === 0 || nums[i - 1] >= n), JSON.stringify(nums));
  check('天数均在 1~10', nums.every(n => n >= 1 && n <= 10), JSON.stringify(nums));

  console.log('3) 量化因子单调响应（纯函数）');
  const r = await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const F = p.computeImpactDaysDetailed;
    const base = { bullConcepts: ['国产替代','半导体'], bullIndustries: ['科技'], relatedStocks: ['A','B','C'], investorShare: '42', affectedPeople: 300000000, reportTime: '2026-11-28 01:02', cnImp: { dir: 'bull', detail: { reports: 4 } } };
    const mk = (o) => F(Object.assign({}, base, o));
    return {
      // 催化层级：国家最高层 > 部委 > 公司级
      catalystHigh: mk({ title: '国务院常务会议部署国产替代重大政策' }).f.catalyst,
      catalystMid: mk({ title: '发改委发布规划方案' }).f.catalyst,
      catalystLow: mk({ title: '某公司发布季度财报公告' }).f.catalyst,
      // 叙事空间：国产替代 > 前沿科技 > 业绩驱动（清空概念，避免 base 概念词干扰仅按标题判定）
      narrativeA: mk({ title: '美国出口管制升级，国产替代自主可控加速', bullConcepts: [], bullIndustries: [] }).f.narrative,
      narrativeB: mk({ title: '人工智能算力大模型迎来突破', bullConcepts: [], bullIndustries: [] }).f.narrative,
      narrativeC: mk({ title: '某公司订单中标业绩增长', bullConcepts: [], bullIndustries: [] }).f.narrative,
      // 容量：多概念多股票 > 少
      breadthMany: mk({ title: 'X' }).f.breadth,
      breadthFew: mk({ title: 'X', bullConcepts: [], bullIndustries: [], relatedStocks: [] }).f.breadth,
      // 新鲜度：今天 > 一周前
      freshToday: mk({ title: 'X', reportTime: '2026-11-28 01:02' }).f.freshness,
      freshOld: mk({ title: 'X', reportTime: '2026-11-18 09:00' }).f.freshness,
      // 确定性：预期 > 兑现
      certExpect: mk({ title: '规划目标有望突破' }).f.certainty,
      certDone: mk({ title: '项目已完成兑现' }).f.certainty,
      // 综合分/天数：强叙事政策 > 弱事件
      strong: mk({ title: '国务院常务会议部署国产替代自主可控重大政策并规划实施', reportTime: '2026-11-28 01:02' }),
      weak: mk({ title: '某公司发布季度财报', bullConcepts: [], bullIndustries: [], relatedStocks: [], investorShare: '2', affectedPeople: 10000, reportTime: '2026-11-18 09:00', cnImp: { dir: 'bull', detail: { reports: 0 } } }),
      // 方向措辞
      bearWord: mk({ title: 'X', cnImp: { dir: 'bear', detail: { reports: 2 } } }).dirWord,
      bullWord: mk({ title: 'X', cnImp: { dir: 'bull', detail: { reports: 2 } } }).dirWord
    };
  });
  check('催化层级单调 国家>部委>公司', r.catalystHigh > r.catalystMid && r.catalystMid > r.catalystLow, JSON.stringify([r.catalystHigh,r.catalystMid,r.catalystLow]));
  check('叙事空间单调 国产替代>科技>业绩', r.narrativeA > r.narrativeB && r.narrativeB > r.narrativeC, JSON.stringify([r.narrativeA,r.narrativeB,r.narrativeC]));
  check('板块容量 多概念多股 > 空', r.breadthMany > r.breadthFew, JSON.stringify([r.breadthMany,r.breadthFew]));
  check('新鲜度 今日 > 一周前', r.freshToday > r.freshOld, JSON.stringify([r.freshToday,r.freshOld]));
  check('确定性 预期>兑现', r.certExpect > r.certDone, JSON.stringify([r.certExpect,r.certDone]));
  check('强事件综合分/天数 > 弱事件', r.strong.score > r.weak.score && r.strong.days >= r.weak.days, JSON.stringify({ s:r.strong.score,d:r.strong.days,ws:r.weak.score,wd:r.weak.days }));
  check('强事件天数达 6+', r.strong.days >= 6, String(r.strong.days));
  check('弱事件天数收敛到 1~2', r.weak.days <= 2, String(r.weak.days));
  check('方向措辞 利好上涨/利空发酵', r.bullWord.includes('上涨') && r.bearWord.includes('发酵'), JSON.stringify([r.bullWord,r.bearWord]));
  check('detail 字段完整', r.strong.level && r.strong.why && r.strong.f && typeof r.strong.score === 'number' && typeof r.strong.days === 'number', JSON.stringify(r.strong).slice(0, 240));

  console.log('4) JS 报错');
  check('无未捕获异常', errors.length === 0, errors.join('; '));

  await browser.close();
  await new Promise(r => srv.close(r));
  console.log('\n[RESULT] ' + pass + '/' + (pass + fail) + ' 通过');
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(1); });
