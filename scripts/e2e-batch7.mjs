/* ============================================================
 * e2e-batch7.mjs — 本轮 2 项改动的真实浏览器端到端验证
 *
 * 覆盖：
 *   1) 用户管理页：把「登录IP」列改为「试用」列，三档（试用一天 / 试用三天 / 试用一周）
 *      · 点一下即开通；开通后即便账号还停在「待审核」，该用户也能用自己的密码登录
 *      · 试用账号按普通用户对待（拿不到管理入口与管理员权限）
 *      · 刷新页面仍保持登录（会话有效）
 *      · 试用一到期：已持有的会话被踢回登录页、再用密码登录也被拒
 *      · 「结束」按钮可立即结束试用，账号回到待审核
 *   2) 格隆汇每日快讯：日期字段右侧的独立「刷新（闭市周期）」按钮
 *      · 窗口 = [最近一个已过去的 15:00, 现在]（15:00 前 → 昨天15:00起；15:00 后 → 今天15:00起）
 *      · 跨天合并 briefs-*.json，只保留窗口内新闻，且不包含「现在之后」的条目
 *      · 「回到当日全部」可退出窗口视图；换日期自动退出
 *
 * 只 mock 外部行情源与 data/hot-topics 下的快讯文件，应用代码与 UI 交互全部为真实行为。
 * 用法：node scripts/e2e-batch7.mjs
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
const USER_NAME = 'trialuser';
const USER_PW = 'Zhangsan123';
const USERS_KEY = 'snt-auth-users-v1';

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

/* ---------------- 快讯 mock 数据（时间用本地时区，与前端 fmtDate 口径一致） ---------------- */
const PAD = n => String(n).padStart(2, '0');
const fmtD = d => d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate());
const fmtDT = d => fmtD(d) + ' ' + PAD(d.getHours()) + ':' + PAD(d.getMinutes());

const NOW0 = new Date();
const TODAY = fmtD(NOW0);
const YDAY = fmtD(new Date(NOW0.getTime() - 86400000));
/** 命中不同题材的关键词，保证 13 分类里至少有几类非空、可展开 */
const KEYS = ['英伟达', '央行', '黄金'];
/** 每小时两条（:07 / :43），刻意避开 15:00 与整点，便于验证闭市周期边界 */
const MINUTES = [7, 43];
function mkBriefItems(dateStr, seed) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    for (const m of MINUTES) {
      const k = KEYS[(h + m + seed) % KEYS.length];
      out.push({
        id: seed * 10000 + h * 100 + m,
        time: `${dateStr} ${PAD(h)}:${PAD(m)}`,
        text: `${k} 快讯测试 ${dateStr.slice(5)} ${PAD(h)}:${PAD(m)}`,
        url: '', stocks: [], subjects: [], cat: ''
      });
    }
  }
  return out.sort((a, b) => String(b.time).localeCompare(String(a.time)));
}
const TODAY_ITEMS = mkBriefItems(TODAY, 2);
const YDAY_ITEMS = mkBriefItems(YDAY, 1);
const ALL_ITEMS = YDAY_ITEMS.concat(TODAY_ITEMS);

/** 与前端 briefCloseWindow 完全相同的口径（起点 = 最近一个已过去的 15:00） */
function closeWindow(now) {
  const n = now ? new Date(now) : new Date();
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 15, 0, 0, 0);
  if (n.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
  return { start: start, end: n };
}
const winExp = closeWindow();
const WIN_START = fmtDT(winExp.start);
const WIN_END = fmtDT(winExp.end);
const EXPECT_COUNT = ALL_ITEMS.filter(it => it.time >= WIN_START && it.time <= WIN_END).length;

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 快讯静态文件全部走 mock，保证时间可控
  await page.route(u => /\/data\/hot-topics\//.test(u.href), route => {
    const url = route.request().url();
    const jsend = obj => route.fulfill({
      status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj)
    });
    if (/index\.json/.test(url)) {
      return jsend({ latest: TODAY, latestBriefs: TODAY, dates: [TODAY, YDAY], briefsDates: [TODAY, YDAY] });
    }
    const m = /briefs-(\d{4}-\d{2}-\d{2})\.json/.exec(url);
    if (m) {
      const d = m[1];
      const items = d === TODAY ? TODAY_ITEMS : (d === YDAY ? YDAY_ITEMS : []);
      return jsend({ date: d, source: 'gelonghui', sourceName: '格隆汇', generatedAt: Date.now(), total: items.length, items });
    }
    return jsend({});
  });
  // 行情 / 其它外网：一律断开，保证离线可跑（本轮不涉及行情）
  await page.route(u => /eastmoney\.com|gtimg\.cn|workers\.dev|vore\.top|ip\.sb/.test(u.href), r => r.abort());
  return { ctx, page, errors };
}

async function gotoApp(page, port, hash, seedUsers) {
  if (seedUsers) {
    // 先建立 origin 再写 localStorage（addInitScript 每次导航都会重跑，会覆盖后续写入）
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 40000 });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [USERS_KEY, seedUsers]);
  }
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load', timeout: 40000 });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function loginAsAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}
async function loginViaForm(page, username, password) {
  await page.evaluate(([u, p]) => {
    const ui = document.getElementById('login-username');
    const pi = document.getElementById('login-password');
    ui.value = u; pi.value = p;
    ui.dispatchEvent(new Event('input', { bubbles: true }));
    pi.dispatchEvent(new Event('input', { bubbles: true }));
  }, [username, password]);
  await page.click('#auth-login-form .auth-btn');
  await page.waitForFunction(() => {
    const gone = !document.getElementById('auth-gate');
    const err = document.querySelector('.auth-msg');
    return gone || (err && !err.hidden && err.textContent.trim());
  }, { timeout: 60000 });
}
async function openUserManage(page) {
  await page.click('.user-chip');
  await page.waitForSelector('.user-dropdown', { timeout: 15000 });
  await page.click('.user-dd-item:has-text("用户管理")');
  await page.waitForSelector('.um-table, .um-empty', { timeout: 25000 });
}
async function logout(page) {
  await page.click('.user-chip');
  await page.waitForSelector('.user-dropdown', { timeout: 15000 });
  await page.click('.user-dd-item.is-danger');
  await page.waitForSelector('#auth-login-form', { timeout: 40000 });
}
/** 读取用户管理表：某用户名所在行的第 8 列（试用列）文本 */
async function trialCellText(page, username) {
  return await page.evaluate((name) => {
    const table = document.querySelector('.um-table');
    if (!table) return null;
    for (const tr of table.querySelectorAll('tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      if ((tds[0].textContent || '').includes(name)) return (tds[7].textContent || '').replace(/\s+/g, ' ').trim();
    }
    return null;
  }, username);
}
/** 读取用户在浏览器里的试用到期时间戳 */
async function trialUntilOf(page, username) {
  return await page.evaluate(([k, name]) => {
    const list = JSON.parse(localStorage.getItem(k) || '[]');
    const u = list.find(x => x.username === name);
    return u ? Number(u.trialUntil) || 0 : 0;
  }, [USERS_KEY, username]);
}

const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  console.log('闭市周期窗口（Node 侧独立计算）：' + WIN_START + ' → ' + WIN_END + '，期望 ' + EXPECT_COUNT + ' 条');

  /* ---------------- 1. 用户管理「试用」列 ---------------- */
  console.log('\n1) 用户管理：登录IP 列改为「试用」列，三档开通后普通用户可登录试用');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port, '#news');
    await loginAsAdmin(page);

    // 造一个待审核用户
    const reg = await page.evaluate(([u, p]) => Auth.register(u, p).then(r => r.ok), [USER_NAME, USER_PW]);
    check('已创建一个待审核的普通用户', reg === true);

    await openUserManage(page);
    const heads = await page.$$eval('.um-table thead th', els => els.map(e => e.textContent.trim()));
    check('表头第 8 列已改为「试用」', heads[7] === '试用', heads.join('|'));
    check('表头不再有「登录IP」列', !heads.some(h => /登录IP/.test(h)), heads.join('|'));

    const cell = await trialCellText(page, USER_NAME);
    check('试用列出现三档按钮', ['试用一天', '试用三天', '试用一周'].every(t => (cell || '').includes(t)), cell);
    check('未开通时显示「未开通」', /未开通/.test(cell || ''), cell);

    const btns = page.locator('.um-table tbody tr', { hasText: USER_NAME }).locator('.btn-trial');
    check('三档按钮数量为 3', await btns.count() === 3, String(await btns.count()));
    const labels = await btns.allInnerTexts();
    check('按钮文案为「试用一天 / 试用三天 / 试用一周」',
      labels.join(',') === '试用一天,试用三天,试用一周', labels.join(','));

    // 点「试用三天」
    await page.locator('.um-table tbody tr', { hasText: USER_NAME }).locator('.btn-trial', { hasText: '试用三天' }).click();
    await page.waitForSelector('.um-trial-on', { timeout: 10000 });
    const after = await trialCellText(page, USER_NAME);
    check('开通后显示「试用中 · 至 … （剩 …）」', /试用中/.test(after || '') && /剩/.test(after || ''), after);
    check('剩余时长为 3 天档', /剩 2 天 2[0-4] 小时|剩 3 天/.test(after || ''), after);
    const until = await trialUntilOf(page, USER_NAME);
    const expectUntil = Date.now() + 3 * 86400000;
    check('试用到期时间 = 现在 + 3 天', Math.abs(until - expectUntil) < 60000,
      `until-now=${Math.round((until - Date.now()) / 60000)} 分钟`);
    check('角色被限为普通用户（按钮「通过」仍存在，说明账号还停在待审核）',
      /通过/.test(await page.locator('.um-table tbody tr', { hasText: USER_NAME }).innerText()));
    await page.click('.modal-um .modal-header .btn-icon');   // 关掉用户管理弹窗
    await page.waitForTimeout(300);

    // 退出 → 该用户用自助注册时的密码登录
    await page.evaluate(() => AuthUI.logout());
    await page.waitForSelector('#auth-login-form', { timeout: 40000 });
    await loginViaForm(page, USER_NAME, USER_PW);
    check('试用期内：待审核用户可以直接登录', await page.evaluate(() => !document.getElementById('auth-gate')));
    check('登录身份确实是他本人', await page.evaluate((n) => Auth.user && Auth.user.username === n, USER_NAME));
    check('试用账号是普通用户（无用户管理权限）',
      await page.evaluate(() => Auth.can('users.manage') === false));
    const menuItems = await page.evaluate(() => {
      const c = document.querySelector('.user-chip'); if (!c) return [];
      c.click();
      return [...document.querySelectorAll('.user-dd-item')].map(e => e.textContent.trim());
    });
    check('用户菜单里没有「用户管理」入口', !menuItems.some(t => /用户管理/.test(t)), menuItems.join('|'));

    // 刷新仍保持登录
    await page.reload({ waitUntil: 'load', timeout: 40000 });
    await waitAppReady(page);
    check('试用期内刷新页面仍保持登录', await page.evaluate((n) => !!Auth.user && Auth.user.username === n, USER_NAME));

    // 试用到期（把 trialUntil 改成过去）→ 会话被踢回登录页
    await page.evaluate((k) => {
      const list = JSON.parse(localStorage.getItem(k) || '[]');
      list.forEach(u => { if (u.trialUntil) u.trialUntil = Date.now() - 60000; });
      localStorage.setItem(k, JSON.stringify(list));
    }, USERS_KEY);
    await page.reload({ waitUntil: 'load', timeout: 40000 });
    await page.waitForSelector('#auth-gate', { timeout: 40000 });
    const hint = await page.evaluate(() => {
      const m = document.querySelector('.auth-msg');
      return m && !m.hidden ? m.textContent.trim() : '';
    });
    check('试用到期后刷新：被踢回登录页并提示「试用已结束」', /试用已结束/.test(hint), hint);

    // 再用密码登录也应被拒
    await loginViaForm(page, USER_NAME, USER_PW);
    const err = await page.evaluate(() => {
      const m = document.querySelector('.auth-msg');
      return m && !m.hidden ? m.textContent.trim() : '';
    });
    check('试用到期后用密码登录被拒（提示「试用已结束」）', /试用已结束/.test(err), err);

    // 管理员登录 → 状态显示「试用已结束」→ 点「结束」清掉试用
    // 注意：此时用户表里已经有 trialuser，Auth.setup 只在「首次使用」时可用，必须走登录表单
    await loginViaForm(page, 'admin', ADMIN_PW);
    await waitAppReady(page);
    await openUserManage(page);
    const expiredCell = await trialCellText(page, USER_NAME);
    check('试用列显示「试用已结束」', /试用已结束/.test(expiredCell || ''), expiredCell);

    await page.locator('.um-table tbody tr', { hasText: USER_NAME }).locator('.btn-trial', { hasText: '试用一天' }).click();
    await page.waitForSelector('.um-trial-on', { timeout: 10000 });
    check('可再次开通（续期）试用一天', /试用中/.test(await trialCellText(page, USER_NAME) || ''));
    await page.locator('.um-table tbody tr', { hasText: USER_NAME }).locator('.um-trial-state button:has-text("结束")').click();
    await page.waitForTimeout(600);
    const endedCell = await trialCellText(page, USER_NAME);
    check('点「结束」后回到「未开通」', /未开通/.test(endedCell || ''), endedCell);
    check('结束试用后账号回到待审核（状态列显示待审核）', await page.evaluate((n) => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === n);
      return !!u && u.status === 'pending';
    }, USER_NAME));
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ---------------- 2. 快讯闭市周期刷新 ---------------- */
  console.log('\n2) 格隆汇每日快讯：日期右侧独立「刷新（闭市周期）」按钮');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port, '#finance');
    await loginAsAdmin(page);
    await page.waitForSelector('.brief-panel', { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.brief-cat').length > 0, { timeout: 40000 });

    const btn = page.locator('.brief-refresh');
    check('存在独立刷新按钮「刷新（闭市周期）」', await btn.count() === 1);
    check('按钮文案含「闭市周期」', /闭市周期/.test(await btn.innerText()));
    const sb = await page.locator('.brief-date').boundingBox();
    const bb = await btn.boundingBox();
    check('按钮位于日期字段右侧（同一行、x 更大）', !!sb && !!bb && bb.x > sb.x + sb.width - 1 && Math.abs(bb.y - sb.y) < 14,
      `date=${sb && sb.x}+${sb && sb.width} btn=${bb && bb.x}`);

    // 刷新前：显示所选日期（今天）的全部快讯
    const beforeCount = await page.locator('.brief-head .muted.small').innerText();
    check('刷新前展示所选日期的全部快讯（48 条）', /共 48 条/.test(beforeCount), beforeCount);
    check('刷新前没有闭市周期窗口条', await page.locator('.brief-window').count() === 0);

    // 点刷新
    await btn.click();
    await page.waitForSelector('.brief-window', { timeout: 40000 });

    const win = await page.evaluate(() => {
      const el = document.querySelector('.brief-window');
      return { start: el.getAttribute('data-start'), end: el.getAttribute('data-end'), text: el.textContent.replace(/\s+/g, ' ').trim() };
    });
    check('窗口起点是「最近一个已过去的 15:00」', / 15:00$/.test(win.start), win.start);
    const expectStart = fmtDT(closeWindow(new Date(win.end)).start);
    check('窗口起点与 Node 侧独立计算一致', win.start === expectStart, `${win.start} vs ${expectStart}`);
    check('窗口终点 = 刷新时刻（与当前时间同分钟）',
      Math.abs(new Date(win.end.replace(' ', 'T') + ':00').getTime() - Date.now()) < 120000, win.end);
    check('窗口文案显示起止时间与条数', /闭市周期/.test(win.text) && /共 \d+ 条/.test(win.text), win.text);

    // 期望条数：用页面回读的窗口起止重算，避免测试执行跨分钟带来的抖动
    const expect = ALL_ITEMS.filter(it => it.time >= win.start && it.time <= win.end).length;
    const shown = await page.evaluate(() => {
      const el = document.querySelector('.brief-window .bw-count');
      const m = /(\d+)/.exec(el ? el.textContent : '');
      return m ? Number(m[1]) : -1;
    });
    check('窗口内条数与按同一规则算出的期望一致', shown === expect, `页面=${shown} 期望=${expect}`);
    check('窗口内不包含「现在之后」的条目（今天 23:43 等被剔除）',
      ALL_ITEMS.some(it => it.time > win.end) && shown < 48 + 48, `shown=${shown}`);
    check('顶部「共 N 条」同步为窗口条数',
      new RegExp('共 ' + shown + ' 条').test(await page.locator('.brief-head .muted.small').innerText()));

    // 展开所有分类，逐条校验渲染出来的时间都落在窗口内
    await page.$$eval('.brief-cat-head', els => els.forEach(e => e.click()));
    await page.waitForTimeout(500);
    const times = await page.$$eval('.brief-item .brief-time', els => els.map(e => e.textContent.trim()));
    const lo = win.start.slice(5), hi = win.end.slice(5);
    check('展开后每条快讯时间都在窗口内', times.length > 0 && times.every(t => t >= lo && t <= hi),
      `${times.length} 条，越界=${times.filter(t => t < lo || t > hi).slice(0, 3).join(',')}`);
    const catCount = await page.locator('.brief-cat').count();
    check('13 个题材分类照常渲染', catCount === 13, String(catCount));

    // 回到当日全部
    await page.click('.brief-window .bw-off');
    await page.waitForTimeout(500);
    check('点「回到当日全部」后窗口条消失', await page.locator('.brief-window').count() === 0);
    check('回到当日全部后条数恢复为该日全部（48 条）',
      /共 48 条/.test(await page.locator('.brief-head .muted.small').innerText()));

    // 换日期自动退出窗口视图
    await btn.click();
    await page.waitForSelector('.brief-window', { timeout: 40000 });
    await page.selectOption('.brief-date', YDAY);
    await page.waitForTimeout(800);
    check('切换日期后自动退出闭市周期视图', await page.locator('.brief-window').count() === 0);
    check('切换日期后展示该日全部快讯（48 条）',
      /共 48 条/.test(await page.locator('.brief-head .muted.small').innerText()));

    // 关键词搜索在窗口模式下依然生效
    await btn.click();
    await page.waitForSelector('.brief-window', { timeout: 40000 });
    await page.fill('.brief-search', '央行');
    await page.waitForTimeout(500);
    const searched = await page.locator('.brief-head .muted.small').innerText();
    check('闭市周期视图下关键词搜索仍生效', /匹配 \d+ 条/.test(searched), searched);
    await page.fill('.brief-search', '');
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
};

main().catch(e => { console.error('测试异常：', e); process.exit(1); });
