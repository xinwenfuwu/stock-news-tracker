/* ============================================================
 * e2e-batch9.mjs — 「用户」页「🗄 本地数据」面板的真实浏览器端到端验证
 *
 * 背景：登录卡上那句「正在加载数据… (1/5)」其实是**在下载 5 个业务 JS 脚本**，
 *       不是 5 份数据。本机真正存的数据都在 localStorage 里，本脚本验证
 *       新加的「本地数据」面板能把这些数据列清楚、看得见、删得掉。
 *
 * 覆盖：
 *   1) 入口：按钮在「用户须知」左侧（同 y、x 更小），点击弹出面板
 *   2) 清单：逐项名称 / 条数 / 占用大小正确；「本机账号表」为🔒受保护（无删除按钮）
 *   3) 查看：点「查看」出 JSON 预览；「系统设置」里的 aiKey 必须打码（不能明文外泄）
 *   4) 删除：先出现「确认删除？」→ 取消不生效 → 确认后该行归零、落盘 localStorage、
 *      刷新后仍为空，其它行不受影响
 *   5) 一键清空业务数据：业务行归零，但持仓 / 设置 / 账号 / 云凭据保留
 *   6) 权限：普通用户看不到「本机账号表」这一行
 *   7) 删「登录会话」= 退出登录，回到登录关卡
 *
 * 用法：node scripts/e2e-batch9.mjs
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
const USER_PW = 'User@2026';
const STORE_KEY = 'stock-news-tracker-v1';
const USERS_KEY = 'snt-auth-users-v1';
const SESSION_KEY = 'snt-auth-session-v1';
const CLOUD_KEY = 'cloud-creds-v1';
/** 「用户」页区块内的工具栏（页面里还有多个 .toolbar-right，必须限定作用域） */
const USER_TOOLBAR = 'section.page:has(.holding-table) .toolbar-right';
const AI_KEY_PLAIN = 'sk-super-secret-key-should-be-masked';

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

/* ---------------- 种子数据：把每一类都填上，才能验证「条数」算得对 ---------------- */
const SEED = {
  settings: {
    categories: ['测试分类'], proxyUrl: '',
    aiEndpoint: 'https://api.example.com/v1/chat/completions',
    aiKey: AI_KEY_PLAIN, aiModel: 'test-model'
  },
  news: [
    { id: 'n1', date: '2026-09-17', content: '测试新闻一', conceptCategory: '', industryCategory: '', customTag: '', relatedStocks: [], category: '', owner: 'admin', createdAt: 1 },
    { id: 'n2', date: '2026-09-17', content: '测试新闻二', conceptCategory: '', industryCategory: '', customTag: '', relatedStocks: [], category: '', owner: 'admin', createdAt: 2 },
    { id: 'n3', date: '2026-09-16', content: '测试新闻三', conceptCategory: '', industryCategory: '', customTag: '', relatedStocks: [], category: '', owner: 'admin', createdAt: 3 }
  ],
  stockPools: [{ id: 'p1', date: '2026-09-17', name: '测试股票池', stocks: [{ code: '600000', name: '浦发银行' }] }],
  sectorPools: [{ id: 'sp1', name: '测试板块', bk: 'BK0001', type: 'concept', date: '2026-09-17', stocks: [{ code: '600000', name: '浦发银行' }] }],
  favorites: [{ code: '600000', name: '浦发银行', favDate: '2026-09-17', note: '' }],
  holdings: {
    admin: [{ id: 'h1', code: '600000', name: '浦发银行', entryDate: '2026-09-01', entryPrice: 10, currentPrice: 10, shares: 100, direction: 'long', fee: 0, note: '', createdAt: 1, updatedAt: 1 }]
  },
  holdingColWidths: {}, filterColWidths: {}, sectorColWidths: {},
  financePush: { url: '', locked: false },
  dailyData: { '2026-09-17': { stocks: [{ code: '600000', price: 10 }] } },
  hotTopicSnapshots: { '2026-09-17': { date: '2026-09-17', generatedAt: 1, sources: [] } },
  hotBoards: [{ name: '测试热板' }], hotStocks: [], preMarketBoards: [], amplitudeBoards: []
};

/* ---------------- 页面准备 ---------------- */
async function newPage(browser, port, hash) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /eastmoney\.com|gtimg\.cn|vore\.top|ip\.sb|api\.github\.com/.test(u.href), r => r.abort());
  const seed = JSON.parse(JSON.stringify(SEED));
  await page.goto(`http://127.0.0.1:${port}/` + (hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.evaluate(([k, s, ck]) => {
    localStorage.clear();
    localStorage.setItem(k, JSON.stringify(s));
    localStorage.setItem(ck, JSON.stringify({ token: 'ghp_fake_token_for_test', login: 'tester' }));
  }, [STORE_KEY, seed, CLOUD_KEY]);
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

/** 打开「用户」页 → 点「本地数据」 */
async function openPanel(page) {
  await page.click('a.nav-item:has-text("用户")');
  await page.waitForSelector(USER_TOOLBAR, { timeout: 20000 });
  await page.click(USER_TOOLBAR + ' button:has-text("本地数据")');
  await page.waitForSelector('.ld-modal', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.ld-row').length > 0, null, { timeout: 15000 });
}

/** 读整张清单 */
function readRows(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.ld-row')).map(r => {
    const nameSpans = r.querySelectorAll('.ld-name span');
    return {
      id: r.getAttribute('data-ld-id') || '',
      name: nameSpans[1] ? nameSpans[1].textContent.trim() : '',
      count: (r.querySelector('.ld-count') || {}).textContent || '',
      size: (r.querySelector('.ld-size') || {}).textContent || '',
      danger: r.classList.contains('is-danger'),
      locked: !!r.querySelector('.ld-lock'),
      tagged: !!r.querySelector('.ld-tag-danger'),
      btns: Array.from(r.querySelectorAll('.ld-ops button')).map(b => b.textContent.trim())
    };
  }));
}
/** 按名称取行 locator */
function ldRow(page, name) {
  return page.locator('.ld-row').filter({ hasText: name });
}
async function rowData(page, name) {
  const rows = await readRows(page);
  return rows.find(r => r.name === name) || null;
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ================= 1. 入口按钮 + 清单 ================= */
  console.log('\n1) 「用户」页：本地数据按钮（在用户须知左侧）→ 面板清单');
  {
    const { ctx, page, errors } = await newPage(browser, A.port, '#news');
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector(USER_TOOLBAR, { timeout: 20000 });

    const btnInfo = await page.evaluate(() => Array.from(
      document.querySelectorAll('section.page:has(.holding-table) .toolbar-right button')
    ).map(b => ({ text: b.textContent.trim(), rect: b.getBoundingClientRect().toJSON() })));
    const dataBtn = btnInfo.find(b => b.text.includes('本地数据'));
    const noticeBtn = btnInfo.find(b => b.text.includes('用户须知'));
    const vipBtn = btnInfo.find(b => b.text.includes('会员服务'));
    check('存在「本地数据」按钮', !!dataBtn, btnInfo.map(b => b.text).join(' | '));
    check('「本地数据」在「用户须知」左侧（同一行）',
      !!dataBtn && !!noticeBtn && Math.abs(dataBtn.rect.y - noticeBtn.rect.y) <= 8
      && dataBtn.rect.x + dataBtn.rect.width <= noticeBtn.rect.x + 2,
      dataBtn && noticeBtn ? `${Math.round(dataBtn.rect.x + dataBtn.rect.width)} vs ${Math.round(noticeBtn.rect.x)}` : 'missing');

    await page.click(USER_TOOLBAR + ' button:has-text("本地数据")');
    await page.waitForSelector('.ld-modal', { timeout: 15000 });
    check('点击后弹出「本地数据」面板', await page.locator('.ld-modal').isVisible(), 'not visible');
    check('标题写明是「这台设备」的数据',
      /本地数据/.test(await page.locator('.ld-modal h3').innerText())
      && /这台设备/.test(await page.locator('.ld-modal h3').innerText()),
      await page.locator('.ld-modal h3').innerText());

    const usage = await page.locator('.ld-usage').innerText();
    check('显示本机存储实际占用（带单位）', /本机存储占用/.test(usage) && /\d+(\.\d+)?\s*(B|KB|MB)/.test(usage), usage);
    check('提示浏览器上限约 5 MB', /5\s*MB/.test(usage), usage);

    const rows = await readRows(page);
    check('清单至少 12 类数据', rows.length >= 12, 'rows=' + rows.length);
    const expect = [
      ['新闻数据', '3 条'], ['股票池', '1 组'], ['选股板块', '1 个'], ['收藏股票', '1 只'],
      ['我的持仓', '1 只'], ['每日行情数据', '1 天'], ['热点快照（本机缓存）', '1 天'],
      ['热门榜缓存', '1 条'], ['表格列宽', '0 列'], ['财经推送网址', '0 项'],
      ['系统设置', '6 项'], ['本机账号表', '1 个'], ['登录会话', '1 项'],
      // 云同步凭据：启动时后台验 token 失败会被清掉（这里的 github 请求被断掉），所以是 0
      ['云同步凭据', '0 项']
    ];
    for (const [name, want] of expect) {
      const r = rows.find(x => x.name === name);
      check(`列出「${name}」且条数=${want}`, !!r && r.count === want, r ? r.count : '（缺该行）');
      check(`「${name}」显示占用大小`, !!r && /\d+(\.\d+)?\s*(B|KB|MB)/.test(r.size), r ? r.size : '（缺该行）');
    }
    const settingsRow = rows.find(r => r.name === '系统设置');
    check('「系统设置」标为谨慎（删除会恢复出厂默认）', !!settingsRow && settingsRow.danger && settingsRow.tagged,
      settingsRow ? JSON.stringify(settingsRow) : 'missing');
    const usersRow = rows.find(r => r.name === '本机账号表');
    check('「本机账号表」显示🔒受保护', !!usersRow && usersRow.locked, usersRow ? String(usersRow.locked) : 'missing');
    check('「本机账号表」不提供「删除」按钮（避免把本机所有账号锁死）',
      !!usersRow && !usersRow.btns.includes('删除'), usersRow ? usersRow.btns.join(',') : 'missing');

    /* ---- 查看：JSON 预览 + 密钥打码 ---- */
    await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("查看")').click();
    await page.waitForSelector('.ld-preview', { timeout: 10000 });
    const pre = await page.locator('.ld-pre').innerText();
    check('点「查看」出现 JSON 预览', pre.length > 0, pre.slice(0, 40));
    check('预览里能看到真实新闻内容', /测试新闻一/.test(pre), pre.slice(0, 80));

    await ldRow(page, '系统设置').locator('.ld-ops button:has-text("查看")').click();
    await page.waitForFunction(() => /系统设置/.test(document.querySelector('.ld-preview-head') ? document.querySelector('.ld-preview-head').textContent : ''), null, { timeout: 10000 });
    const preSet = await page.locator('.ld-pre').innerText();
    check('切换到「系统设置」预览', /aiEndpoint/.test(preSet), preSet.slice(0, 80));
    check('设置预览里 AI Key 已打码（不出现明文密钥）',
      !preSet.includes(AI_KEY_PLAIN) && /已隐藏/.test(preSet), preSet.slice(0, 200));

    await page.click('.ld-preview-head button:has-text("收起")');
    await page.waitForFunction(() => !document.querySelector('.ld-preview'), null, { timeout: 10000 });
    check('「收起」可关闭预览', await page.locator('.ld-preview').count() === 0, 'still open');
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 2. 单项删除 + 一键清空 ================= */
  console.log('\n2) 单项删除（取消 / 确认 / 落盘 / 刷新后仍生效）与一键清空');
  {
    const { ctx, page, errors } = await newPage(browser, A.port, '#news');
    await loginFresh(page);
    await openPanel(page);

    // 2.1 取消
    await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("删除")').click();
    check('点「删除」先出现「确认删除？」二次确认',
      await ldRow(page, '新闻数据').locator('.ld-confirm-tip').isVisible(), 'no confirm');
    await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("取消")').click();
    let r = await rowData(page, '新闻数据');
    check('「取消」后条数不变（仍 3 条）', r && r.count === '3 条', r ? r.count : 'missing');

    // 2.2 确认删除
    await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("删除")').click();
    await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("确认")').click();
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll('.ld-row')).find(r => /新闻数据/.test(r.textContent));
      return el && /0 条/.test(el.textContent);
    }, null, { timeout: 15000 });
    r = await rowData(page, '新闻数据');
    check('确认后「新闻数据」归零', r && r.count === '0 条', r ? r.count : 'missing');
    check('归零后该行「删除」按钮置灰（无可删内容）',
      await ldRow(page, '新闻数据').locator('.ld-ops button:has-text("删除")').isDisabled(), 'not disabled');
    const toast = (await page.locator('.toast').last().innerText()).replace(/\s+/g, ' ');
    check('给出删除成功提示', /已删除「新闻数据」/.test(toast), toast);

    const other = await rowData(page, '股票池');
    check('其它行不受影响（股票池仍 1 组）', other && other.count === '1 组', other ? other.count : 'missing');

    const saved = await page.evaluate(k => {
      try { return JSON.parse(localStorage.getItem(k)).news.length; } catch (e) { return -1; }
    }, STORE_KEY);
    check('已落盘 localStorage（news 长度为 0）', saved === 0, 'len=' + saved);

    // 2.3 刷新后仍是 0（证明不是只改了内存）
    await page.reload({ waitUntil: 'load' });
    await waitAppReady(page);
    await openPanel(page);
    r = await rowData(page, '新闻数据');
    check('刷新后「新闻数据」仍为 0（改动已持久化）', r && r.count === '0 条', r ? r.count : 'missing');

    // 2.4 一键清空业务数据
    await page.click('.ld-actions button:has-text("清空业务数据")');
    check('「清空业务数据」也要二次确认',
      await page.locator('.ld-actions .ld-confirm-tip').isVisible(), 'no confirm');
    await page.click('.ld-actions button:has-text("确认清空")');
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll('.ld-row')).find(r => /股票池/.test(r.textContent));
      return el && /0 组/.test(el.textContent);
    }, null, { timeout: 15000 });
    for (const [name, want] of [['股票池', '0 组'], ['选股板块', '0 个'], ['收藏股票', '0 只'],
      ['每日行情数据', '0 天'], ['热点快照（本机缓存）', '0 天'], ['热门榜缓存', '0 条']]) {
      const x = await rowData(page, name);
      check(`清空后「${name}」=${want}`, !!x && x.count === want, x ? x.count : 'missing');
    }
    for (const [name, want] of [['我的持仓', '1 只'], ['系统设置', '6 项'], ['本机账号表', '1 个'], ['登录会话', '1 项']]) {
      const x = await rowData(page, name);
      check(`清空不动「${name}」（应保留 ${want}）`, !!x && x.count === want, x ? x.count : 'missing');
    }
    const toast2 = (await page.locator('.toast').last().innerText()).replace(/\s+/g, ' ');
    check('提示里说明持仓/设置/账号已保留', /已清空业务数据/.test(toast2) && /保留/.test(toast2), toast2);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 3. 权限：普通用户看不到账号表 ================= */
  console.log('\n3) 权限：普通用户的面板里没有「本机账号表」');
  {
    const { ctx, page, errors } = await newPage(browser, A.port, '#news');
    await page.evaluate(async ([pw, upw]) => {
      await Auth.setup('admin', pw, pw);
      const add = await Auth.addUser('user1', upw, 'user');   // 必须 await：内部是异步算哈希
      if (!add.ok) throw new Error('创建普通用户失败：' + add.error);
      Auth.logout();
      const r = await Auth.login('user1', upw, true);
      if (!r.ok) throw new Error('普通用户登录失败：' + r.error);
      AuthUI.enterApp();
    }, [ADMIN_PW, USER_PW]);
    await waitAppReady(page);

    const who = await page.evaluate(() => Auth.user && Auth.user.username);
    check('已切换到普通用户 user1', who === 'user1', String(who));
    await openPanel(page);
    const rows = await readRows(page);
    check('普通用户看不到「本机账号表」', !rows.some(r => r.name === '本机账号表'),
      rows.map(r => r.name).join(','));
    const hold = rows.find(r => r.name === '我的持仓');
    check('普通用户也能看到「我的持仓」一行', !!hold, rows.map(r => r.name).join(','));
    const holdDesc = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.ld-row')).find(r => /我的持仓/.test(r.textContent));
      return el ? el.querySelector('.ld-desc').textContent : '';
    });
    check('持仓描述指出是当前账号的记录（其它账号不受影响）',
      /user1/.test(holdDesc) && /不受影响/.test(holdDesc), holdDesc);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 4. 删「登录会话」= 退出登录 ================= */
  console.log('\n4) 删除「登录会话」应退出登录并回到登录关卡');
  {
    const { ctx, page, errors } = await newPage(browser, A.port, '#news');
    await loginFresh(page);
    await openPanel(page);
    await ldRow(page, '登录会话').locator('.ld-ops button:has-text("删除")').click();
    await ldRow(page, '登录会话').locator('.ld-ops button:has-text("确认")').click();
    await page.waitForSelector('#auth-gate', { timeout: 30000 });
    check('删除登录会话后被踢回登录关卡', await page.locator('#auth-gate').isVisible(), 'no gate');
    const stillLogged = await page.evaluate(k => !!localStorage.getItem(k), SESSION_KEY);
    check('localStorage 中的会话键已清掉', stillLogged === false, 'still there');
    check('账号表没有被牵连（仍能重新登录）', await page.evaluate(k => !!localStorage.getItem(k), USERS_KEY), 'users lost');
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ================= 5. 云同步凭据可单独删除 ================= */
  console.log('\n5) 删除「云同步凭据」只清该键，不动其它数据');
  {
    const { ctx, page, errors } = await newPage(browser, A.port, '#news');
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector(USER_TOOLBAR, { timeout: 20000 });
    // 启动时若 localStorage 已有 token，会去校验 GitHub 并（在此环境下）把它清掉；
    // 所以登录完成后再写入，专门验证「单独删这一项」这条路。
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
      [CLOUD_KEY, { token: 'ghp_fake_token_for_test', login: 'tester' }]);
    await page.click(USER_TOOLBAR + ' button:has-text("本地数据")');
    await page.waitForSelector('.ld-modal', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.ld-row').length > 0, null, { timeout: 15000 });
    const before = await rowData(page, '云同步凭据');
    check('未删前「云同步凭据」=1 项', before && before.count === '1 项', before ? before.count : 'missing');
    await ldRow(page, '云同步凭据').locator('.ld-ops button:has-text("删除")').click();
    await ldRow(page, '云同步凭据').locator('.ld-ops button:has-text("确认")').click();
    await page.waitForFunction(() => {
      const el = Array.from(document.querySelectorAll('.ld-row')).find(r => /云同步凭据/.test(r.textContent));
      return el && /0 项/.test(el.textContent);
    }, null, { timeout: 15000 });
    const after = await rowData(page, '云同步凭据');
    check('删除后「云同步凭据」=0 项', after && after.count === '0 项', after ? after.count : 'missing');
    check('localStorage 里该键确实没了', !(await page.evaluate(k => localStorage.getItem(k), CLOUD_KEY)), 'still there');
    check('新闻数据未受影响（仍 3 条）',
      (await rowData(page, '新闻数据')).count === '3 条', (await rowData(page, '新闻数据')).count);
    check('页面无 JS 报错', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  A.srv.close();
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
