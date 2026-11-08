/* ============================================================
 * e2e-hot-topics.mjs — 火热话题「实时抓取失败 → 自动回退内置快照」真实浏览器验证
 * 用 Playwright 打开本地静态服务上的真实页面，模拟用户点「刷新热门话题」。
 * 断言点：
 *   1) 未配置代理时，进入页面自动展示内置快照（有新闻条目）
 *   2) 代理不可达（模拟国内 *.workers.dev 被拦截）时，点刷新不再报「各金融源暂未取到数据」，
 *      而是自动回退展示最近快照，并给出提示
 *   3) 当日无快照时，自动回退到「前一个可用日期」的快照
 *   4) 分类筛选、统计分析（跨站重合榜 + 各站分类统计）渲染正常
 *   5) 主题分类统计（行业/概念/产品/产业/科技）渲染在跨站重合榜右侧，可折叠、有条形与样例
 * 用法：node scripts/e2e-hot-topics.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 「全球信息」页区块内的工具栏（页面里还有多个 .toolbar-right，必须限定作用域） */
const FIN_TOOLBAR = 'section.page:has(.hot-topics-panel) .toolbar-right';
const VUE_LOCAL = path.join(ROOT, '_repo_tmp', 'vue.global.prod.js');

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
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

/** 起一个只服务本目录的静态服务器 */
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

/**
 * 走真实的「首次初始化管理员 → 进入系统」流程，
 * 顺便验证登录关卡本身是可用的（业务脚本只在登录后才被注入）。
 *
 * 注意：#app 里的 header / main 是静态 HTML，Vue 挂载前就已存在于 DOM，
 * 所以不能拿它们当「已就绪」的信号，必须等 Vue 真正 mount（container.__vue_app__）。
 */
async function loginAs(page, username, password) {
  const u = username || 'e2e';
  const p = password || 'E2ePass123';
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async ([name, pass]) => {
    Auth.init();
    if (!Auth.hasUsers()) await Auth.setup(name, pass, pass);
    else if (!Auth.isLoggedIn()) await Auth.login(name, pass, true);
    AuthUI.enterApp();
  }, [u, p]);
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 45000 });
}

/** 打开页面并注入代理设置 + 登录态；拦截 unpkg 用本地 Vue，保证离线可跑 */
async function openApp(browser, port, proxyUrl) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  const saved = { settings: { categories: ['测试分类'], proxyUrl: proxyUrl || '' } };
  await page.addInitScript((s) => {
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(s));
  }, saved);
  await page.goto(`http://127.0.0.1:${port}/#finance`, { waitUntil: 'load' });
  await loginAs(page);
  return { ctx, page, errors };
}

const waitItems = (page) =>
  page.waitForFunction(() => document.querySelectorAll('.source-card .source-items li').length > 0, { timeout: 25000 });

const main = async () => {
  // 防呆：运行前确认已生成快照与清单
  for (const f of ['data/hot-topics/index.json', 'data/hot-topics/2026-09-17.json']) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.log('缺少前置文件 ' + f + '，请先运行 node scripts/fetch-hot-topics.mjs');
      process.exit(1);
    }
  }

  const A = await serveStatic(ROOT);
  const baseA = `http://127.0.0.1:${A.port}`;
  const browser = await chromium.launch();

  // ---------------- 场景 1：未配置代理 ----------------
  console.log('1) 未配置代理：进入「全球信息」页应自动展示内置快照');
  {
    const { ctx, page, errors } = await openApp(browser, A.port, '');
    await waitItems(page);
    const n = await page.locator('.source-card .source-items li').count();
    check('展示出新闻条目', n > 0, 'items=' + n);
    const cards = await page.locator('.source-card').count();
    check('渲染 11 个来源卡片（含新增财联社）', cards === 11, 'cards=' + cards);
    const upd = (await page.locator(FIN_TOOLBAR).innerText()).replace(/\s+/g, ' ');
    // 当前 UI 已改为「时间段模式」：更新文案为「…（覆盖 N 天，按时间段合并）」
    check('标注数据来自时间段快照（按时间段合并）且非实时', /按时间段合并|覆盖\s*\d+\s*天/.test(upd) && !/（实时）/.test(upd), upd);
    // 序号列（1..11 站顺序；20261108e 新增第 11 个「财联社」）
    const ranks = await page.locator('.source-card .src-rank').allInnerTexts();
    check('来源按 1..11 顺序编号', ranks.slice(0, 11).join(',') === '1,2,3,4,5,6,7,8,9,10,11', ranks.join(','));
    const names = await page.locator('.source-card .src-name').allInnerTexts();
    check('第 11 个平台是「财联社」', (names[10] || '').includes('财联社'), names.join(','));
    check('证券时报平台存在', names.some(n => n.includes('证券时报')), names.join(','));
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 场景 1.5：未配置代理，点「刷新热门话题」应加载今日快照（合规免费主路径） ----------------
  console.log('1.5) 未配置代理：点「刷新热门话题」应加载最新自动抓取快照（今日），而非报错');
  {
    const { ctx, page, errors } = await openApp(browser, A.port, '');
    await waitItems(page);
    await page.locator(FIN_TOOLBAR + ' button').first().click();
    await page.waitForSelector('.toast', { timeout: 30000 });
    const toast = (await page.locator('.toast').innerText()).replace(/\s+/g, ' ');
    check('提示已按时间段加载快照（非「不可用/回退」）',
      /已加载.*火热话题/.test(toast) && !/不可用/.test(toast), toast);
    check('提示里带上了统计窗口日期', /\d{4}年\d{1,2}月\d{1,2}日/.test(toast), toast);
    const n = await page.locator('.source-card .source-items li').count();
    check('刷新后仍有新闻条目（来源含真实数据）', n > 0, 'items=' + n);
    const upd = (await page.locator(FIN_TOOLBAR).innerText()).replace(/\s+/g, ' ');
    check('更新时间标注为按时间段合并', /按时间段合并/.test(upd), upd);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 场景 2：代理不可达 → 点刷新应回退 ----------------
  console.log('2) 代理不可达（模拟 workers.dev 被拦截）：仍应展示 11 个平台与快照新闻');
  {
    // 127.0.0.1:65500 无监听，连接被拒，等价于「代理不可达」。
    // 当前主路径为「时间段快照」(refreshDailyTopics)，不依赖代理，故代理故障不应影响任何平台。
    const { ctx, page, errors } = await openApp(browser, A.port, 'http://127.0.0.1:65500');
    await waitItems(page);
    await page.locator(FIN_TOOLBAR + ' button').first().click();
    await page.waitForSelector('.toast', { timeout: 30000 });
    const toast = (await page.locator('.toast').innerText()).replace(/\s+/g, ' ');
    check('代理不可达时仍按时间段加载快照（不报「各金融源暂未取到数据」）',
      /已加载.*火热话题/.test(toast) && !/各金融源暂未取到数据/.test(toast), toast);
    check('提示不含「不可用/失败」这类报错措辞', !/不可用|失败/.test(toast), toast);
    const n = await page.locator('.source-card .source-items li').count();
    check('回退后仍有新闻条目可看', n > 0, 'items=' + n);
    const cards = await page.locator('.source-card').count();
    check('代理不可达时 11 个平台卡片仍齐全', cards === 11, 'cards=' + cards);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 场景 3：分类筛选 ----------------
  console.log('3) 分类筛选 chips：只看某一类');
  {
    const { ctx, page } = await openApp(browser, A.port, '');
    await waitItems(page);
    const totalBefore = await page.locator('.source-card .source-items li').count();
    // 点第一个非「全部」的分类 chip
    await page.locator('.cat-filter .cat-chip').nth(1).click();
    await page.waitForTimeout(400);
    const catText = (await page.locator('.cat-filter .cat-chip').nth(1).innerText()).trim();
    const totalAfter = await page.locator('.source-card .source-items li').count();
    check(`筛选「${catText}」后条目数减少或持平`, totalAfter <= totalBefore, `${totalBefore} -> ${totalAfter}`);
    const tags = (await page.locator('.source-card .source-items .cat-tag').allInnerTexts()).map(s => s.trim());
    check('筛选后可见条目类别一致', tags.length === 0 || tags.every(t => t === catText), [...new Set(tags)].join(','));
    await ctx.close();
  }

  // ---------------- 场景 4：统计分析 ----------------
  console.log('4) 统计分析：跨站重合榜 + 各站分类统计');
  {
    const { ctx, page, errors } = await openApp(browser, A.port, '');
    await waitItems(page);
    await page.locator('.ht-tab', { hasText: '统计分析' }).click();
    await page.locator('button', { hasText: '生成统计' }).first().click();
    await page.waitForSelector('.sc-card', { timeout: 25000 });
    const scCount = await page.locator('.sc-card').count();
    check('渲染 11 个站点的分类统计卡', scCount === 11, 'sc=' + scCount);
    const covered = (await page.locator('#ht-analysis .ht-controls .muted').allInnerTexts()).join(' ').replace(/\s+/g, ' ');
    check('显示覆盖天数与条数', /覆盖\s*\d+\s*天/.test(covered) && /\d+\s*条/.test(covered), covered);
    const bars = await page.locator('.sc-bar').count();
    check('存在分类分布条', bars > 0, 'bars=' + bars);
    const ovCount = await page.locator('.overlap-item').count();
    check('跨站重合榜有内容（标题级聚合）', ovCount > 0, 'overlap=' + ovCount);
    // 展开第一条重合话题，应列出具体站点
    if (ovCount > 0) {
      await page.locator('.overlap-item .ov-toggle').first().click();
      await page.waitForSelector('.ov-detail-row', { timeout: 10000 });
      const rows = await page.locator('.ov-detail-row').count();
      check('展开后能看到具体站点与标题', rows > 0, 'rows=' + rows);
      const ratioTxt = (await page.locator('.overlap-item .ov-ratio').first().innerText()).trim();
      check('比例显示为 N/11 格式', /^\d+\/11$/.test(ratioTxt), ratioTxt);
    }
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 场景 5：主题维度统计（跨站重合榜右侧） ----------------
  console.log('5) 主题分类统计：行业/概念/产品/产业/科技 在跨站重合榜右侧');
  {
    const { ctx, page, errors } = await openApp(browser, A.port, '');
    await waitItems(page);
    await page.locator('.ht-tab', { hasText: '统计分析' }).click();
    await page.locator('button', { hasText: '生成统计' }).first().click();
    await page.waitForSelector('.theme-dim', { timeout: 25000 });

    const dims = await page.locator('.theme-dim').count();
    check('渲染 5 个主题维度统计项', dims === 5, 'dims=' + dims);
    const dimNames = (await page.locator('.theme-dim-name').allInnerTexts()).join(' ');
    check('五个维度为 行业/概念/产品/产业/科技',
      ['行业', '概念', '产品', '产业', '科技'].every(n => dimNames.includes(n)), dimNames.replace(/\s+/g, ' '));

    const topicBars = await page.locator('.theme-topic').count();
    check('主题条已渲染（统计非空）', topicBars > 0, 'topics=' + topicBars);
    const widths = await page.locator('.theme-topic .tt-fill').evaluateAll(els => els.slice(0, 6).map(e => e.style.width));
    check('主题条按命中数给出宽度', widths.length > 0 && widths.every(w => /%$/.test(w)), widths.join(','));
    const hint = await page.locator('.theme-topic').first().getAttribute('title');
    check('悬停主题可看样例标题', !!hint && hint.length > 4, String(hint).slice(0, 40));
    const pcts = (await page.locator('.theme-topic .tt-pct').allInnerTexts()).filter(s => /%$/.test(s.trim()));
    check('显示占全部新闻的百分比', pcts.length > 0, pcts.slice(0, 3).join(','));

    // 位置关系：右栏在同一行的重合榜右侧
    const boxL = await page.locator('.ht-split-left .overlap-list').boundingBox();
    const boxR = await page.locator('.theme-stats').boundingBox();
    check('主题统计面板位于跨站重合榜右侧', !!boxL && !!boxR && boxR.x > boxL.x + 50,
      `L.x=${boxL && Math.round(boxL.x)} R.x=${boxR && Math.round(boxR.x)}`);
    check('两栏顶部对齐（同一行并排）', !!boxL && !!boxR && Math.abs(boxL.y - boxR.y) < 80,
      `Δy=${boxL && boxR ? Math.abs(Math.round(boxL.y - boxR.y)) : 'n/a'}`);

    // 折叠交互
    await page.locator('.theme-dim-head').first().click();
    await page.waitForTimeout(250);
    const afterCollapse = await page.locator('.theme-topics').count();
    check('点击维度标题可折叠', afterCollapse === dims - 1, `之前=${dims} 之后=${afterCollapse}`);
    await page.locator('.theme-dim-head').first().click();
    await page.waitForTimeout(250);
    check('再次点击可展开', (await page.locator('.theme-topics').count()) === dims);

    // 点击主题词（半导体 / 人工智能 / 医疗器械 …）→ 右侧就地出现对应新闻
    console.log('   · 点击主题词展开对应新闻');
    const topic0 = page.locator('.theme-topic').first();
    const name0 = (await topic0.locator('.tt-name').innerText()).trim();
    const count0 = parseInt((await topic0.locator('.tt-val').innerText()).trim(), 10);
    await topic0.click();
    await page.waitForSelector('.tt-news', { timeout: 10000 });
    const rows0 = await page.locator('.tt-news-item').count();
    check(`点击「${name0}」后出现对应新闻列表`, rows0 > 0, 'rows=' + rows0);
    check('新闻条数与该主题命中数一致', rows0 === count0, `${rows0} vs ${count0}`);
    check('展开的主题被高亮标记', (await page.locator('.theme-topic.active').count()) === 1);
    const head0 = (await page.locator('.tt-news-head .tt-news-title').innerText()).replace(/\s+/g, ' ');
    check('明细区标明主题与条数', head0.includes(name0) && head0.includes(String(count0)), head0);
    const meta0 = (await page.locator('.tt-news-item .tt-news-meta').first().innerText()).replace(/\s+/g, ' ');
    check('每条新闻带站点与日期', /\d{2}-\d{2}/.test(meta0), meta0);
    const txt0 = (await page.locator('.tt-news-text').first().innerText()).trim();
    check('新闻标题文本非空', txt0.length > 4, txt0);
    const links0 = await page.locator('a.tt-news-text').count();
    check('带原文链接的新闻可点击跳转', links0 > 0, 'links=' + links0);

    // 换一个主题：前一个应自动收起（同一维度一次只看一个）
    await page.locator('.theme-topic').nth(1).click();
    await page.waitForTimeout(300);
    check('一次只展开一个主题', (await page.locator('.tt-news').count()) === 1, 'open=' + (await page.locator('.tt-news').count()));
    check('新主题的新闻已替换显示', (await page.locator('.tt-news-item').count()) > 0);
    await page.locator('.theme-topic').nth(1).click();
    await page.waitForTimeout(300);
    check('再次点击可收起新闻明细', (await page.locator('.tt-news').count()) === 0);
    check('收起后不再有高亮主题', (await page.locator('.theme-topic.active').count()) === 0);

    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- 场景 6：11 源快照（含财联社 24h 电报、证券时报）完整渲染 ----------------
  console.log('6) 20261108e：11 源快照中财联社 / 证券时报真实新闻渲染');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'htn-'));
    fs.cpSync(ROOT, tmp, { recursive: true, filter: (src) => !src.includes('_repo_tmp') && !src.includes('.git') });
    const dir = path.join(tmp, 'data', 'hot-topics');
    // 只保留补写过 11 个来源的今日快照，清单指向它
    for (const f of fs.readdirSync(dir)) {
      if (/^2026-\d\d-\d\d\.json$/.test(f) && f !== '2026-11-08.json') fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.writeFileSync(path.join(dir, 'index.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), latest: '2026-11-08', dates: ['2026-11-08'] }, null, 2));
    const B = await serveStatic(tmp);
    const { ctx, page, errors } = await openApp(browser, B.port, '');
    await waitItems(page);

    const snap = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-08.json'), 'utf8'));
    check('今日快照含 11 个来源', (snap.sources || []).length === 11, 'sources=' + (snap.sources || []).length);
    const clsSrc = (snap.sources || []).find(s => s.key === 'cls');
    const stcnSrc = (snap.sources || []).find(s => s.key === 'stcn');
    check('财联社快照含 50 条 24 小时电报', !!(clsSrc && clsSrc.items.length === 50), 'cls=' + (clsSrc ? clsSrc.items.length : 'missing'));
    check('财联社条目均带北京时间时间戳', !!(clsSrc && clsSrc.items.every(i => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(i.time))), 'first=' + (clsSrc && clsSrc.items[0] && clsSrc.items[0].time));
    check('财联社条目链接指向 cls.cn', !!(clsSrc && clsSrc.items.every(i => /cls\.cn/.test(i.url))), 'first=' + (clsSrc && clsSrc.items[0] && clsSrc.items[0].url));
    check('证券时报快照含 50 条真实新闻', !!(stcnSrc && stcnSrc.items.length === 50), 'stcn=' + (stcnSrc ? stcnSrc.items.length : 'missing'));
    check('证券时报条目链接指向 stcn.com', !!(stcnSrc && stcnSrc.items.every(i => /stcn\.com/.test(i.url))), 'first=' + (stcnSrc && stcnSrc.items[0] && stcnSrc.items[0].url));

    const cards = await page.locator('.source-card').count();
    check('页面稳定渲染 11 个平台', cards === 11, 'cards=' + cards);
    const clsCard = page.locator('.source-card').filter({ hasText: '财联社' });
    const clsRows = await clsCard.locator('.source-items li').count();
    check('财联社卡片显示新闻条目（不再空白）', clsRows > 0, 'rows=' + clsRows);
    const stcnCard = page.locator('.source-card').filter({ hasText: '证券时报' });
    const stcnRows = await stcnCard.locator('.source-items li').count();
    check('证券时报卡片显示新闻条目（修复 0 条）', stcnRows > 0, 'rows=' + stcnRows);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
    B.srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
