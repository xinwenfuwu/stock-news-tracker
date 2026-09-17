/* ============================================================
 * e2e-batch8.mjs — 本轮 3 项改动的真实浏览器端到端验证
 *
 * 覆盖：
 *   1) 「全球信息」页火热话题面板的两个页签（每日话题 / 统计分析）文字改为红色
 *      · 未选中 = 红字；选中 = 浅红底 + 深红字（两种状态文字都是红的）
 *      · 顺带回归一个真实 bug：`--accent` / `--muted` 此前**从未定义**，
 *        `background: var(--accent)` 按「计算值无效」退回 transparent，
 *        导致 `.ht-tab.active` / `.seg button.active` / `.snap-date.active` 变成白字透明底（看不见）。
 *        这里用「文字色 vs 背景色」的实际对比度做客观断言（WCAG AA ≥ 4.5）。
 *   2) 点「实时」但实时增强源（代理）不可达 → 属**正常回退**
 *      · toast 改为「正常回退」口径，不再出现「不可用/失败」这类报错措辞
 *      · 面板内出现常驻说明条，讲清「为什么是快照」以及「想真·实时该怎么办」
 *      · 用户显式点「历史」后说明条消失
 *   3) 「用户」页：会员服务左侧新增「用户须知」按钮 → 弹窗分段温馨提示（一~五）
 *      · 按钮几何位置在「会员服务」左侧（同 y、x 更小）
 *      · 五段齐全、关键文案到位、「我已阅读」可关闭、不影响「会员服务」弹窗
 *
 * 用法：node scripts/e2e-batch8.mjs
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
/** 无监听端口 → 连接被拒，等价于「代理不可达」（不要用 127.0.0.1:9，Chrome 判为不安全端口会在浏览器层拦掉） */
const DEAD_PROXY = 'http://127.0.0.1:65500';
const SETTINGS_KEY = 'stock-news-tracker-v1';
/** 「用户」页区块内的工具栏（页面里还有多个 .toolbar-right，必须限定作用域） */
const USER_TOOLBAR = 'section.page:has(.holding-table) .toolbar-right';

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

/* ---------------- 颜色工具：把 rgb()/rgba() 解析成 [r,g,b,a] 并算对比度 ---------------- */
function parseColor(s) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(s));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
function relLum(rgb) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrast(a, b) {
  const la = relLum(a), lb = relLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
/** 是不是「红字」：红通道明显高于绿蓝 */
function isReddish(rgb) {
  return rgb[0] > 140 && rgb[0] - rgb[1] > 60 && rgb[0] - rgb[2] > 60;
}

/* ---------------- 页面准备 ---------------- */
async function newPage(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /eastmoney\.com|gtimg\.cn|vore\.top|ip\.sb/.test(u.href), r => r.abort());
  // 种一份带 settings.categories 的存储（缺 categories 会被 Store.init 整体重置，把 proxyUrl 一起清掉）
  const saved = { settings: { categories: ['测试分类'], proxyUrl: o.proxyUrl || '' } };
  await page.goto(`http://127.0.0.1:${o.port}/` + (o.hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [SETTINGS_KEY, saved]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
  return { ctx, page, errors };
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 45000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, { timeout: 45000 });
}
async function loginFresh(page) {
  await page.evaluate(async (p) => { await Auth.setup('admin', p, p); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}

const main = async () => {
  for (const f of ['data/hot-topics/index.json']) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.log('缺少前置文件 ' + f + '，请先运行 node scripts/fetch-hot-topics.mjs');
      process.exit(1);
    }
  }
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ================= 1. 两个页签改红色 ================= */
  console.log('\n1) 「全球信息」页：每日话题 / 统计分析 两个页签文字为红色且可读');
  {
    const { ctx, page, errors } = await newPage(browser, { port: A.port, hash: '#finance', proxyUrl: '' });
    await loginFresh(page);
    await page.waitForSelector('.hot-topics-panel .ht-tabs .ht-tab', { timeout: 25000 });

    const readTabs = () => page.evaluate(() => {
      const alpha = c => {
        const m = /rgba?\([^)]*?([\d.]+)\s*\)$/.exec(c);
        return m ? Number(m[1]) : 1;
      };
      // 页签自身可能是透明底，真正肉眼看到的底来自最近的「不透明」祖先
      const effBg = el => {
        let cur = el, bg = getComputedStyle(cur).backgroundColor;
        while (alpha(bg) === 0 && cur.parentElement) { cur = cur.parentElement; bg = getComputedStyle(cur).backgroundColor; }
        return bg;
      };
      return Array.from(document.querySelectorAll('.ht-tabs .ht-tab')).map(t => ({
        text: t.textContent.trim(),
        active: t.classList.contains('active'),
        color: getComputedStyle(t).color,
        bg: effBg(t)
      }));
    });

    const tabs = await readTabs();
    check('页签为「每日话题」「统计分析」两枚', tabs.length === 2
      && tabs[0].text === '每日话题' && tabs[1].text === '统计分析',
      tabs.map(t => t.text).join('|'));

    for (const t of tabs) {
      const c = parseColor(t.color);
      check(`「${t.text}」文字色为红（实际 ${t.color}）`, !!c && isReddish(c), t.color);
    }
    const active = tabs.find(t => t.active);
    const inactive = tabs.find(t => !t.active);
    check('有一枚为选中态、一枚为非选中态', !!active && !!inactive,
      tabs.map(t => t.text + (t.active ? '(active)' : '')).join(','));

    for (const t of tabs) {
      const c = parseColor(t.color), bg = parseColor(t.bg);
      check(`「${t.text}」文字与背景对比度 ≥ 4.5（实际 ${(c && bg) ? contrast(c, bg).toFixed(2) : 'n/a'}）`,
        !!(c && bg) && contrast(c, bg) >= 4.5, `${t.color} on ${t.bg}`);
    }
    check('选中态背景不是透明/纯白（回归 --accent 未定义导致的白字透明底）',
      !!parseColor(active.bg) && active.bg !== 'rgba(0, 0, 0, 0)' && active.bg !== 'rgb(255, 255, 255)', active.bg);

    // 另一个真实的「白字透明底」受害者：实时/历史 分段按钮
    const seg = await page.evaluate(() => {
      const b = document.querySelector('#ht-daily .ht-controls .seg button.active');
      const cs = getComputedStyle(b);
      return { text: b.textContent.trim(), color: cs.color, bg: cs.backgroundColor };
    });
    check('「实时/历史」选中段的背景不是透明（同一 bug 的回归点）',
      seg.bg !== 'rgba(0, 0, 0, 0)', `${seg.text} ${seg.color} on ${seg.bg}`);
    check('「实时/历史」选中段文字可读（对比度 ≥ 4.5）',
      contrast(parseColor(seg.color), parseColor(seg.bg)) >= 4.5, `${seg.color} on ${seg.bg}`);

    // 切到统计分析，页签仍然是红的
    await page.locator('.ht-tabs .ht-tab', { hasText: '统计分析' }).click();
    await page.waitForTimeout(500);
    const tabs2 = await readTabs();
    const nowActive = tabs2.find(t => t.active);
    check('切到「统计分析」后选中态正确切换', nowActive && nowActive.text === '统计分析', nowActive && nowActive.text);
    const c2 = parseColor(nowActive.color);
    check('切换后选中页签文字仍为红', !!c2 && isReddish(c2), nowActive.color);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 2. 点「实时」→ 正常回退 ================= */
  console.log('\n2) 点「实时」但代理不可达：应为「正常回退」口径 + 常驻说明条');
  {
    const { ctx, page, errors } = await newPage(browser, { port: A.port, hash: '#finance', proxyUrl: DEAD_PROXY });
    await loginFresh(page);
    // 进页面走的是历史快照路径，先确认已展示条目、且此刻没有说明条
    await page.waitForFunction(() => document.querySelectorAll('.source-card .source-items li').length > 0,
      null, { timeout: 30000 });
    check('进入页面时无「实时源」说明条（还没点实时）',
      await page.locator('#ht-daily .ht-live-note').count() === 0, 'note exists');

    await page.locator('#ht-daily .ht-controls .seg button', { hasText: '实时' }).click();
    await page.waitForFunction(() => {
      const t = document.querySelector('.toast');
      return t && t.textContent.includes('已展示最新自动抓取快照');
    }, null, { timeout: 40000 });

    const toast = (await page.locator('.toast').last().innerText()).replace(/\s+/g, ' ');
    check('toast 说明已展示最新自动抓取快照', /已展示最新自动抓取快照（\d{4}-\d{2}-\d{2}）/.test(toast), toast);
    check('toast 不再出现「不可用 / 失败」这类报错措辞', !/不可用|失败|错误/.test(toast), toast);
    check('toast 明确告知不影响使用', /不影响使用/.test(toast), toast);

    const note = (await page.locator('#ht-daily .ht-live-note').innerText()).replace(/\s+/g, ' ');
    check('出现常驻说明条', note.length > 0, note);
    check('说明条点明原因（实时增强源/代理 未连通）', /实时增强源/.test(note) && /未连通/.test(note), note);
    check('说明条说明当前展示的是最新自动抓取快照', /自动抓取快照（\d{4}-\d{2}-\d{2}/.test(note), note);
    check('说明条给出可行做法（国内 *.workers.dev 常被拦截 / 设置里换域名 / 不配置也能用）',
      /workers\.dev/.test(note) && /设置/.test(note) && /不影响使用/.test(note), note);
    check('说明条不是报错配色（不是红底红字）', await page.evaluate(() => {
      const el = document.querySelector('#ht-daily .ht-live-note');
      const c = getComputedStyle(el);
      const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(c.color);
      return rgb ? Number(rgb[1]) < Number(rgb[2]) : true; // 蓝字（红通道小于绿通道）
    }), await page.evaluate(() => getComputedStyle(document.querySelector('#ht-daily .ht-live-note')).color));

    const stillItems = await page.locator('.source-card .source-items li').count();
    check('回退后仍有新闻条目可看', stillItems > 0, 'items=' + stillItems);
    check('模式切回「历史」（展示的是快照）',
      (await page.locator('#ht-daily .ht-controls .seg button.active').innerText()).trim() === '历史',
      (await page.locator('#ht-daily .ht-controls .seg button.active').innerText()).trim());

    await page.locator('#ht-daily .ht-controls .seg button', { hasText: '历史' }).click();
    await page.waitForTimeout(400);
    check('用户显式点「历史」后说明条消失',
      await page.locator('#ht-daily .ht-live-note').count() === 0, 'still there');
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 3. 用户须知 ================= */
  console.log('\n3) 「用户」页：会员服务左侧的「用户须知」按钮 + 分段温馨提示弹窗');
  {
    const { ctx, page, errors } = await newPage(browser, { port: A.port, hash: '#news', proxyUrl: '' });
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector(USER_TOOLBAR, { timeout: 20000 });

    // 3.1 按钮本身
    const btnInfo = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('section.page:has(.holding-table) .toolbar-right button'));
      return btns.map(b => ({ text: b.textContent.trim(), rect: b.getBoundingClientRect().toJSON() }));
    });
    const noticeBtn = btnInfo.find(b => b.text.includes('用户须知'));
    const vipBtn = btnInfo.find(b => b.text.includes('会员服务'));
    check('存在「用户须知」按钮', !!noticeBtn, btnInfo.map(b => b.text).join(' | '));
    check('存在「会员服务」按钮', !!vipBtn, btnInfo.map(b => b.text).join(' | '));
    check('「用户须知」在「会员服务」左侧（同一行）',
      !!noticeBtn && !!vipBtn && Math.abs(noticeBtn.rect.y - vipBtn.rect.y) <= 8
      && noticeBtn.rect.x + noticeBtn.rect.width <= vipBtn.rect.x + 2,
      noticeBtn && vipBtn ? `notice.x+${Math.round(noticeBtn.rect.width)}=${Math.round(noticeBtn.rect.x + noticeBtn.rect.width)} vs vip.x=${Math.round(vipBtn.rect.x)}` : 'missing');

    // 3.2 点击 → 弹窗
    await page.click(USER_TOOLBAR + ' button:has-text("用户须知")');
    await page.waitForSelector('.notice-modal', { timeout: 15000 });
    check('点击后弹出「用户须知」弹窗', await page.locator('.notice-modal').isVisible(), 'not visible');
    const modalText = (await page.locator('.notice-modal').innerText()).replace(/[ \t]+/g, ' ');

    const items = await page.locator('.notice-modal .notice-item').count();
    check('提示分为 5 段', items === 5, 'items=' + items);
    const idxs = (await page.locator('.notice-modal .notice-idx').allInnerTexts()).map(s => s.trim());
    check('分段序号为 一~五', idxs.join('') === '一二三四五', idxs.join(''));
    check('弹窗标题为「用户须知」', /用户须知/.test(await page.locator('.notice-modal h3').innerText()),
      await page.locator('.notice-modal h3').innerText());
    check('标明仅供参考、不构成投资建议', /不构成.*投资建议/.test(modalText), modalText.slice(0, 60));

    // 3.3 五段各自的关键内容
    check('一：股市有风险、投资需谨慎（含价值/资金 50% 的说法）',
      /股市有风险/.test(modalText) && /投资需谨慎/.test(modalText)
      && /50%/.test(modalText) && /资金作用/.test(modalText) && /政策/.test(modalText), 'seg1');
    check('二：盖房子的比喻（地基/框架/梁板/装修/家电）',
      ['地基', '框架', '梁板', '装修', '家电'].every(k => modalText.includes(k)), 'seg2');
    check('二：四点齐全（板块风口 / 基本面 / 时机 / 数据能力）',
      /向上/.test(modalText) && /轮动风口/.test(modalText) && /基本面好的股票/.test(modalText)
      && /时机/.test(modalText) && /驾驭数据的能力/.test(modalText) && /经验/.test(modalText), 'seg2');
    check('二：结论表述为「这四点」（原文列了四条）', /满足这四点/.test(modalText), 'seg2');
    check('三：好软件不荐股、否则是骗局/接盘侠',
      /不会告诉你哪只股票会涨/.test(modalText) && /骗局/.test(modalText) && /接盘侠/.test(modalText)
      && /数据都是真的/.test(modalText) && /态势感知/.test(modalText), 'seg3');
    check('四：精确筛选、去除无用股票、不超过 30 个、减轻服务器压力',
      /精确筛选/.test(modalText) && /去除无用的股票/.test(modalText) && /30 个/.test(modalText)
      && /服务器/.test(modalText), 'seg4');
    check('五：不要告诉任何人 + 共同学习交流 + 限时优惠 + 新股友 10%',
      /不要告诉任何人/.test(modalText) && /共同学习和交流/.test(modalText) && /限时优惠/.test(modalText)
      && /10%/.test(modalText) && /直至新股友退出为止/.test(modalText), 'seg5');

    // 3.4 关闭
    await page.click('.notice-modal .modal-actions button');
    await page.waitForFunction(() => document.querySelectorAll('.notice-modal').length === 0, null, { timeout: 10000 });
    check('「我已阅读」可关闭弹窗', await page.locator('.notice-modal').count() === 0, 'still open');

    // 3.5 不影响原有的「会员服务」
    await page.click(USER_TOOLBAR + ' button:has-text("会员服务")');
    await page.waitForSelector('.membership-modal', { timeout: 15000 });
    check('「会员服务」弹窗仍正常', await page.locator('.membership-modal').isVisible(), 'not visible');
    await page.click('.membership-modal .modal-actions button');
    await page.waitForFunction(() => document.querySelectorAll('.membership-modal').length === 0, null, { timeout: 10000 });
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  A.srv.close();
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
