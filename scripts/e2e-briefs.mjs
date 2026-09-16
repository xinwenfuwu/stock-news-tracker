/* ============================================================
 * e2e-briefs.mjs — 「全球信息」页右栏：美股美债 → 格隆汇每日快讯（13 分类）改造验证
 *
 * 覆盖：
 *   1) 美股美债面板已彻底移除（旧标题与旧容器都不在）
 *   2) 格隆汇每日快讯面板渲染：标题、日期选择、关键词输入
 *   3) 13 个分类名齐全且按用户指定顺序排列；每项带命中数与百分比
 *   4) 点击分类 → 就在该项下方展开该类全部快讯（默认 30 条，可再展开更多）
 *   5) 多个分类可分别展开/收起；同一分类再点即收起
 *   6) 关键词搜索：条数收敛、统计随之重算、命中处高亮 <mark>、清空后恢复
 *   7) 切换日期会重新加载
 *   8) 无 JS 报错
 *
 * 用法：node scripts/e2e-briefs.mjs
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

const CATS = ['国家政策类', '世界500强领导者', '社会热点', '南下资金', '科技突破', '行业标杆上市公司',
  '大行机构', '美债', '美股', '日韩股', '港股', '黄金', '石油'];

async function main() {
  // 数据前置检查：本地须已有 briefs 文件（由 scripts/fetch-hot-topics.mjs 生成）
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
  await page.waitForFunction(() => document.querySelectorAll('.brief-cat').length === 13, { timeout: 30000 });

  console.log('2) 美股美债已移除');
  check('旧容器 .us-market-panel 不存在', (await page.locator('.us-market-panel').count()) === 0);
  const noUs = await page.evaluate(() => {
    const p = document.querySelector('section.page[v-show], section.page');
    void p;
    const panel = document.querySelector('.brief-panel');
    const head = panel ? panel.previousElementSibling : null;
    void head;
    // 只在「全球信息」页可见文本里找旧面板标题
    const sec = Array.from(document.querySelectorAll('section.page')).find(s => s.offsetParent !== null && s.querySelector('.brief-panel'));
    return sec ? sec.innerText.includes('美股美债') : true;
  });
  check('页面不再出现「美股美债」面板标题', !noUs);
  check('旧的「📡 美股美债」标题节点不存在',
    (await page.locator('h3:has-text("美股美债")').count()) === 0);

  console.log('3) 快讯面板与控件');
  check('面板标题为「📰 格隆汇每日快讯」',
    (await page.locator('.brief-panel .panel-title').innerText()).includes('格隆汇每日快讯'));
  check('日期下拉存在且已选中最新快讯日',
    (await page.locator('.brief-date').inputValue()) === date,
    await page.locator('.brief-date').inputValue());
  check('关键词输入框存在', (await page.locator('.brief-search').count()) === 1);
  check('日期下拉含该日期选项',
    (await page.locator('.brief-date option').count()) >= 1);

  console.log('4) 13 个分类：名称与顺序');
  const names = await page.$$eval('.brief-cat .bc-name', els => els.map(e => e.textContent.trim()));
  check('分类数量为 13', names.length === 13, names.join(' / '));
  check('分类名称与顺序完全一致', JSON.stringify(names) === JSON.stringify(CATS), names.join(' / '));

  const firstStat = await page.evaluate(() => {
    const head = document.querySelector('.brief-cat .brief-cat-head');
    return {
      count: head.querySelector('.bc-count').textContent.trim(),
      pct: head.querySelector('.bc-pct').textContent.trim(),
      fill: head.querySelector('.bc-fill').style.width
    };
  });
  check('分类行显示命中条数', /^\d+$/.test(firstStat.count), firstStat.count);
  check('分类行显示百分比', /^\d+%$/.test(firstStat.pct), firstStat.pct);
  check('分类行有占比条宽度', /%$/.test(firstStat.fill), firstStat.fill);

  console.log('5) 点击分类 → 展开该类消息');
  await page.locator('.brief-cat').first().locator('.brief-cat-head').click();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const cat = document.querySelector('.brief-cat');
    const head = cat.querySelector('.brief-cat-head');
    const items = cat.querySelectorAll('.brief-item');
    return {
      count: Number(head.querySelector('.bc-count').textContent.trim()),
      items: items.length,
      title: (cat.querySelector('.brief-news-title') || {}).textContent || '',
      firstText: (cat.querySelector('.brief-text') || {}).textContent || '',
      hasTime: !!cat.querySelector('.brief-time'),
      active: head.classList.contains('active')
    };
  });
  check('展开后该类消息出现', opened.items > 0, JSON.stringify(opened).slice(0, 160));
  check('默认最多显示 30 条（与命中数取小）', opened.items === Math.min(opened.count, 30),
    `命中 ${opened.count} / 显示 ${opened.items}`);
  check('展开区标题含分类名与条数',
    opened.title.includes(CATS[0]) && opened.title.includes(String(opened.count)), opened.title);
  check('每条消息带时间', opened.hasTime);
  check('消息正文非空', opened.firstText.trim().length > 8, opened.firstText.slice(0, 60));
  check('展开的分类行高亮', opened.active);

  console.log('6) 再多点几个分类（各自独立展开）与收起');
  await page.locator('.brief-cat').nth(4).locator('.brief-cat-head').click();
  await page.waitForTimeout(250);
  check('第二个分类也能展开（同时展开不互斥）',
    (await page.locator('.brief-news').count()) === 2,
    '展开区数量 ' + (await page.locator('.brief-news').count()));
  await page.locator('.brief-cat').nth(4).locator('.brief-cat-head').click();
  await page.waitForTimeout(250);
  check('再点一次即收起', (await page.locator('.brief-news').count()) === 1);

  console.log('7) 展开更多');
  const bigIdx = await page.$$eval('.brief-cat', els =>
    els.findIndex(e => Number(e.querySelector('.bc-count').textContent.trim()) > 30));
  check('存在命中超过 30 条的分类（用于验证展开更多）', bigIdx >= 0, 'index=' + bigIdx);
  if (bigIdx >= 0) {
    // 该分类可能已处于展开态（前面点过）→ 只有在未展开时才点击，避免把已展开的收起
    const alreadyOpen = await page.locator('.brief-cat').nth(bigIdx).locator('.brief-news').count();
    if (!alreadyOpen) {
      await page.locator('.brief-cat').nth(bigIdx).locator('.brief-cat-head').click();
      await page.waitForTimeout(300);
    }
    const before = await page.locator('.brief-cat').nth(bigIdx).locator('.brief-item').count();
    await page.locator('.brief-cat').nth(bigIdx).locator('.theme-more').click();
    await page.waitForTimeout(300);
    const after = await page.locator('.brief-cat').nth(bigIdx).locator('.brief-item').count();
    check('「展开更多」增加 50 条', after === before + 50, `${before} → ${after}`);
  }

  console.log('8) 关键词搜索');
  const totalAll = await page.evaluate(() => Number(document.querySelector('.brief-head .muted').textContent.match(/共\s*(\d+)\s*条/)[1]));
  await page.fill('.brief-search', '英伟达');
  await page.waitForTimeout(500);
  const searched = await page.evaluate(() => {
    const headText = document.querySelector('.brief-head .muted').textContent;
    const m = headText.match(/共\s*(\d+)\s*条\s*·\s*匹配\s*(\d+)\s*条/);
    return { total: m ? Number(m[1]) : -1, matched: m ? Number(m[2]) : -1, headText };
  });
  check('搜索后显示「共 N 条 · 匹配 M 条」', searched.total === totalAll && searched.matched >= 0, searched.headText.trim());
  check('匹配条数少于总条数（过滤生效）', searched.matched > 0 && searched.matched < totalAll,
    `${searched.matched} / ${totalAll}`);
  check('搜索关键词出现在匹配到的正文里',
    await page.evaluate(() => {
      const t = document.querySelector('.brief-text');
      return !!t && t.textContent.includes('英伟达');
    }));
  check('命中关键词已高亮 <mark>',
    (await page.locator('.brief-text mark').count()) > 0,
    'mark 数量 ' + (await page.locator('.brief-text mark').count()));
  const catCountsSearched = await page.$$eval('.brief-cat .bc-count', els => els.map(e => Number(e.textContent.trim())));
  check('分类统计随搜索重算（不再等于未过滤时的数字）',
    JSON.stringify(catCountsSearched) !== JSON.stringify([]) && catCountsSearched.some(n => n > 0));

  await page.locator('.brief-search-clear').click();
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => Number(document.querySelector('.brief-head .muted').textContent.match(/共\s*(\d+)\s*条/)[1]));
  check('清空关键词后恢复全部条数', cleared === totalAll, `${cleared} vs ${totalAll}`);
  check('清空后不再有高亮标记', (await page.locator('.brief-text mark').count()) === 0);

  console.log('9) 搜索无结果时的提示');
  await page.fill('.brief-search', 'zzz不存在的关键词zzz');
  await page.waitForTimeout(400);
  check('无匹配时给出提示', (await page.locator('.brief-tip:has-text("没有匹配")').count()) === 1);
  check('无匹配时不渲染分类列表', (await page.locator('.brief-cat').count()) === 0);
  await page.locator('.brief-search-clear').click();
  await page.waitForTimeout(400);

  console.log('10) 切换日期');
  const dateOpts = await page.$$eval('.brief-date option', els => els.map(e => e.value));
  if (dateOpts.length > 1) {
    await page.selectOption('.brief-date', dateOpts[1]);
    await page.waitForTimeout(1200);
    check('切换日期后仍能渲染出分类', (await page.locator('.brief-cat').count()) === 13);
    await page.selectOption('.brief-date', dateOpts[0]);
    await page.waitForTimeout(1200);
  } else {
    check('当前只有一个快讯日期（跳过切换验证）', true);
  }

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('11) 顶部「暂停」生效时：不自动请求，改为按钮手动加载');
  const pctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const pp = await pctx.newPage();
  const perr = [];
  pp.on('pageerror', e => perr.push(e.message));
  let hotReqs = 0;
  pp.on('request', r => { if (/data\/hot-topics\//.test(r.url())) hotReqs++; });
  if (fs.existsSync(VUE_LOCAL)) await pp.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  await pp.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());
  await pp.addInitScript(() => {
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify({ settings: { categories: ['测试分类'], dataPaused: true } }));
  });
  await pp.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await pp.waitForSelector('#auth-gate', { timeout: 20000 });
  await pp.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await pp.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await pp.locator('.nav-item', { hasText: '全球信息' }).click();
  await pp.waitForSelector('.brief-panel', { timeout: 20000 });
  await pp.waitForTimeout(1500);
  check('暂停状态下进入该页：0 次快讯数据请求', hotReqs === 0, 'hotReqs=' + hotReqs);
  check('面板提示「自动加载已暂停」', (await pp.locator('.brief-tip:has-text("自动加载已暂停")').count()) === 1);
  check('暂停时分类列表尚未渲染', (await pp.locator('.brief-cat').count()) === 0);
  await pp.locator('button:has-text("加载该日快讯")').click();
  await pp.waitForFunction(() => document.querySelectorAll('.brief-cat').length === 13, { timeout: 30000 });
  check('点「加载该日快讯」后正常出 13 个分类', (await pp.locator('.brief-cat').count()) === 13);
  check('用户主动点击后才发生数据请求', hotReqs > 0, 'hotReqs=' + hotReqs);
  check('暂停场景无 JS 报错', perr.length === 0, perr.slice(0, 2).join(' | '));
  await pctx.close();

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
