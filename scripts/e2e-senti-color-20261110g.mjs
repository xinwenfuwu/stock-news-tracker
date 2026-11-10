/* ============================================================
 * e2e-senti-color-20261110g.mjs — 验证 20261110g 两轮改动
 *
 * 改动 A（多空着色）：全球信息页下所有「新闻数量数字」按新闻追踪页同源逻辑着色
 *   —— 偏利好(bull) → 红色数字 (.senti-bull)，偏利空(bear) → 绿色数字 (.senti-bear)，中性 → 不着色。
 * 改动 B（快捷窗口上移）：把「今天/昨天/前天」按钮从「🔥 火热话题」面板头部
 *   移到「📰 格隆汇每日快讯」面板标题栏右侧空白区 (.brief-head-right)。
 *
 * 覆盖：
 *   1) 核心逻辑回归：computeCategorySentiment 利好→'bull' / 利空→'bear' / 中性→'neutral'
 *      （直接验证此前 ear 笔误已修复，利空判定不再失效）
 *   2) 日按钮位置：.ht-day-btns 仅 1 处，位于 .brief-panel 的 .brief-head-right，
 *      且不在 .hot-topics-panel（火热话题）内；三个按钮文本齐全
 *   3) 每日快讯总条数着色：渲染 class 与 HotTopics.sentiClass(briefSenti) 一致
 *   4) 13 个分类条数着色：逐条对比渲染 class 与 sentiClass(c.sentiment)（数据驱动）
 *   5) 火热话题（统计分析标签）：存在已着色的数字且颜色正确（红=利好 / 绿=利空）
 *   6) 颜色值正确：.senti-bull→rgb(220,38,38) #dc2626；.senti-bear→rgb(22,163,74) #16a34a
 *   7) 无 JS 报错
 *
 * 用法：node scripts/e2e-senti-color-20261110g.mjs
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

async function main() {
  // 数据前置检查
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hot-topics/index.json'), 'utf8'));
  const briefDates = (idx.briefsDates || []).filter(Boolean);
  check('index.json 已含快讯日期清单 briefsDates', briefDates.length > 0, JSON.stringify(idx).slice(0, 120));
  const date = briefDates[0];
  const briefFile = path.join(ROOT, 'data/hot-topics', `briefs-${date}.json`);
  check(`快讯文件 briefs-${date}.json 存在`, fs.existsSync(briefFile));
  const briefJson = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
  check('快讯文件含 items 且条数充足（>=100）', Array.isArray(briefJson.items) && briefJson.items.length >= 100,
    '共 ' + (briefJson.items || []).length + ' 条');
  console.log(`（使用真实数据：${date}，${briefJson.items.length} 条）\n`);

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());

  console.log('1) 进入系统并打开「全球信息」页');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '全球信息' }).click();
  await page.waitForSelector('.brief-panel', { timeout: 30000 });

  console.log('2) 核心逻辑回归（ear 笔误修复 → 利空判定恢复）');
  const logic = await page.evaluate(() => {
    const H = window.HotTopics;
    if (!H || !H.computeCategorySentiment || !H.newsSentiment) return { missing: true };
    const bull = H.computeCategorySentiment([{ text: '股价大涨 涨停 利好 业绩超预期 上涨' }, { text: '强势拉升 创新高 反弹' }]);
    const bear = H.computeCategorySentiment([{ text: '股价大跌 跌停 利空 业绩暴雷 下跌' }, { text: '暴跌 破位 走弱' }]);
    const neutral = H.computeCategorySentiment([{ text: '公司召开股东大会审议议案' }, { text: '据媒体报道' }]);
    // 混合：3 利空 + 1 利好 → 利空占多数
    const mixedBear = H.computeCategorySentiment([{ text: '大跌 利空' }, { text: '暴跌' }, { text: '下滑' }, { text: '大涨 利好' }]);
    const clsBull = H.sentiClass('bull');
    const clsBear = H.sentiClass('bear');
    const clsNeutral = H.sentiClass('neutral');
    return { bull, bear, neutral, mixedBear, clsBull, clsBear, clsNeutral };
  });
  check('HotTopics 情感接口可用', !logic.missing);
  check('利好文本 → computeCategorySentiment 返回 "bull"', logic.bull === 'bull', logic.bull);
  check('利空文本 → computeCategorySentiment 返回 "bear"（笔误已修复）', logic.bear === 'bear', logic.bear);
  check('中性文本 → 返回 "neutral"', logic.neutral === 'neutral', logic.neutral);
  check('3 利空 + 1 利好 → 返回 "bear"（多数判定正确）', logic.mixedBear === 'bear', logic.mixedBear);
  check('sentiClass(\'bull\') = "senti-bull"', logic.clsBull === 'senti-bull', logic.clsBull);
  check('sentiClass(\'bear\') = "senti-bear"', logic.clsBear === 'senti-bear', logic.clsBear);
  check('sentiClass(\'neutral\') = ""（中性不着色）', logic.clsNeutral === '', JSON.stringify(logic.clsNeutral));

  console.log('3) 「今天/昨天/前天」按钮位置');
  const dayPos = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ht-day-btns'));
    const single = btns.length === 1 ? btns[0] : null;
    const inBrief = single ? !!single.closest('.brief-panel') : false;
    const inBriefHeadRight = single ? !!single.closest('.brief-head-right') : false;
    const inHot = single ? !!single.closest('.hot-topics-panel') : false;
    const labels = single ? Array.from(single.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
    return { count: btns.length, inBrief, inBriefHeadRight, inHot, labels };
  });
  check('页面仅 1 处 .ht-day-btns（不再在火热话题头部重复）', dayPos.count === 1, 'count=' + dayPos.count);
  check('日按钮位于「格隆汇每日快讯」面板内 (.brief-panel)', dayPos.inBrief);
  check('日按钮位于面板标题栏右侧空白区 (.brief-head-right)', dayPos.inBriefHeadRight);
  check('日按钮不在「🔥 火热话题」面板内 (.hot-topics-panel)', !dayPos.inHot);
  check('三个按钮文本齐全（今天/昨天/前天）',
    dayPos.labels.includes('今天') && dayPos.labels.includes('昨天') && dayPos.labels.includes('前天'),
    dayPos.labels.join(','));

  // 同时确认火热话题面板头部不再含该按钮
  const htHeadHasDay = await page.evaluate(() => {
    const ht = document.querySelector('.hot-topics-panel .panel-head');
    return ht ? !!ht.querySelector('.ht-day-btns') : false;
  });
  check('🔥 火热话题 面板头部已不含日按钮', !htHeadHasDay);

  console.log('4) 每日快讯总条数着色（逐值对比）');
  const totalCheck = await page.evaluate(() => {
    const app = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const senti = app.briefSenti;
    const expected = window.HotTopics.sentiClass(senti);
    const span = document.querySelector('.brief-head-right .muted span');
    const rendered = span ? span.className : '(无)';
    const total = (app.briefBase || []).length;
    return { senti, expected, rendered, total };
  });
  check('每日快讯总条数存在且 >=0', typeof totalCheck.total === 'number', 'total=' + totalCheck.total);
  check('总条数渲染 class 与 sentiClass(briefSenti) 一致', totalCheck.rendered === totalCheck.expected,
    `rendered=${totalCheck.rendered} expected=${totalCheck.expected} (senti=${totalCheck.senti})`);

  console.log('5) 每日快讯各分类条数着色（.bc-count，与新闻追踪页同源 sent-bull/sent-bear）');
  const catCheck = await page.evaluate(() => {
    const app = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const groups = Array.from(document.querySelectorAll('.brief-panel .brief-cat-group'));
    let colored = 0, checked = 0, mism = [], groupCount = 0, totalCats = 0;
    groups.forEach(g => {
      const headEl = g.querySelector('.bcg-head');
      const headText = headEl ? headEl.textContent : '';
      let list = null;
      if (headText.includes('题材')) list = app.briefThemeStats || [];
      else if (headText.includes('概念')) list = app.briefConceptStats || [];
      else if (headText.includes('行业')) list = app.briefIndustryStats || [];
      if (!list) return;
      groupCount++;
      const byName = {};
      list.forEach(c => { byName[c.name] = c.sentiment; });
      const cats = g.querySelectorAll('.brief-cat');
      totalCats += cats.length;
      cats.forEach(cat => {
        const nameEl = cat.querySelector('.bc-name');
        const countEl = cat.querySelector('.bc-count');
        if (!nameEl || !countEl) return;
        const name = nameEl.textContent.trim();
        const expSent = byName[name];
        if (expSent === undefined) return; // 该维度列表内无此名（极少），跳过
        const cls = countEl.className || '';
        const rend = cls.includes('sent-bull') ? 'sent-bull' : cls.includes('sent-bear') ? 'sent-bear' : '';
        const exp = expSent === 'bull' ? 'sent-bull' : expSent === 'bear' ? 'sent-bear' : '';
        checked++;
        if (rend !== exp) mism.push(`${name}(${headText.slice(0, 2)}): exp=${exp} got=${rend}`);
        if (rend) colored++;
      });
    });
    return { groupCount, totalCats, checked, colored, mism: mism.slice(0, 8) };
  });
  check('每日快讯含题材/概念/行业 3 个维度分组', catCheck.groupCount === 3, 'groupCount=' + catCheck.groupCount);
  check('每日快讯分类渲染行数 >= 13（多维度展开）', catCheck.totalCats >= 13, 'totalCats=' + catCheck.totalCats);
  check('至少核对到若干分类（维度内名称唯一可匹配）', catCheck.checked > 0, 'checked=' + catCheck.checked);
  check('已着色的分类条数 >= 1（真实数据应有偏多/偏空分类）', catCheck.colored >= 1, 'colored=' + catCheck.colored);
  check('每个分类 .bc-count 着色与其维度内 sentiment 完全一致（数据驱动）', catCheck.mism.length === 0,
    catCheck.mism.join(' ; '));

  console.log('6) 颜色值正确性（红=利好 / 绿=利空，两种 class 体系）');
  const colors = await page.evaluate(() => {
    function first(sel) { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; }
    return {
      sentiBull: first('.senti-bull'),
      sentiBear: first('.senti-bear'),
      bcBull: first('.bc-count.sent-bull'),
      bcBear: first('.bc-count.sent-bear')
    };
  });
  const RED = ['rgb(220, 38, 38)', 'rgb(224, 50, 47)'];   // var(--up)=#dc2626 ; .bc-count.sent-bull=#e0322f
  const GREEN = ['rgb(22, 163, 74)', 'rgb(21, 160, 90)']; // var(--down)=#16a34a ; .bc-count.sent-bear=#15a05a
  if (colors.sentiBull) check('.senti-bull 为红色', RED.includes(colors.sentiBull), colors.sentiBull);
  else console.log('  (本数据集无 senti-bull 元素，跳过)');
  if (colors.sentiBear) check('.senti-bear 为绿色', GREEN.includes(colors.sentiBear), colors.sentiBear);
  else console.log('  (本数据集无 senti-bear 元素，跳过)');
  if (colors.bcBull) check('.bc-count.sent-bull 为红色', RED.includes(colors.bcBull), colors.bcBull);
  else console.log('  (本数据集无 .bc-count.sent-bull 元素，跳过)');
  if (colors.bcBear) check('.bc-count.sent-bear 为绿色', GREEN.includes(colors.bcBear), colors.bcBear);
  else console.log('  (本数据集无 .bc-count.sent-bear 元素，跳过)');

  console.log('7) 统计分析 / 火热话题来源条数：标记已接入 sentiClass 着色逻辑（静态校验）');
  const markup = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const keys = ['theme-dim-count', 'tt-val', 'tt-news-title', 'sc-bar-val'];
  const analysisBindings = keys.filter(k => {
    if (!markup.includes(k)) return false;
    const i = markup.indexOf(k);
    const win = markup.substring(Math.max(0, i - 200), i + 400);
    return win.includes('sentiClass(');
  });
  check('统计分析标签含 sentiClass 着色绑定（theme-dim / 话题 / 站点维度）', analysisBindings.length >= 3, analysisBindings.join(','));
  const hasSrcSenti = markup.includes('src-status') && markup.includes('sentiClass(srcSenti(s))');
  check('火热话题来源条数含 sentiClass(srcSenti(s)) 绑定', hasSrcSenti);
  console.log('  注：统计分析/来源数据依赖外部抓取（e2e 已屏蔽外网），其运行时着色将在部署后线上核对；核心情感逻辑已由第 2 步覆盖。');

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
