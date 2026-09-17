/* ============================================================
 * e2e-batch11.mjs — 真实浏览器验证「注册申请 → 管理员收到提示」闭环
 *
 * 用户反馈：普通用户提交注册后，系统告诉他「需管理员同意」，
 *   但管理员那边**没有任何提示**（系统对这句话负责不了）。
 *
 * 根因（纯静态站的能力边界）：
 *   账号表只写在注册者自己浏览器的 localStorage 里，没有服务端推送。
 *   跨设备时那条记录根本不会出现在管理员浏览器里，必须有人「把申请送过去」。
 *
 * 本批改动：
 *   A. 注册完成页：明确告知「不会自动通知管理员」+「📨 复制申请信息，发给管理员」
 *      复制出的消息含 用户名/时间/申请码/一键导入链接
 *   B. 管理员端：导航栏红点角标（未读时红色呼吸、已读转灰）+ 右下角站内提醒条
 *      「去审核」直达用户管理；数据源为本机账号表，storage 事件 + 轮询双通道刷新
 *   C. 导入链接 #admin-import?req=<申请码>：管理员点开 → 自动清 hash → 登录后
 *      自动打开用户管理并填好申请码，只需再点一下「导入申请」
 *
 * 覆盖：
 *   1) 注册端：提示框文案、复制按钮、剪贴板内容（含申请码与导入链接）
 *   2) 管理员端（跨设备）：导入链接 → 自动打开用户管理 + 预填申请码 → 导入成功
 *   3) 管理员端（同设备）：另一标签页注册 → storage 事件 → 红点角标 + 提醒条出现
 *   4) 已读语义：「去审核」后提醒条收起、角标转灰、数字保留
 *   5) 未登录时打开导入链接：落在登录页并给出明确提示
 *   6) 回归：提醒轮询不产生任何 data/hot-topics 请求（不破坏「暂停刷新」约定）
 *
 * 外部行情/IP 源全部 mock 或 abort，应用代码与 UI 交互均为真实行为。
 * 用法：node scripts/e2e-batch11.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const REG_PW = 'Passw0rd1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
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

const SEED = {
  news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
  hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [], sectorPools: [],
  settings: { categories: ['主线概念'], proxyUrl: '', dataPaused: false }
};

/** 建页：拦掉所有外部源（行情 / IP / 代理），保证离线可跑且不产生真实请求 */
async function newPage(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: o.viewport || { width: 1560, height: 1000 },
    permissions: o.permissions || []
  });
  const page = await ctx.newPage();
  const errors = [];
  const hotReqs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/\/data\/hot-topics\//.test(r.url())) hotReqs.push(r.url()); });
  if (!o.keepExternal) {
    await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
      r => r.abort());
  }
  await page.addInitScript((d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  }, SEED);
  return { ctx, page, errors, hotReqs };
}

async function gotoApp(page, port, hash) {
  await page.goto(`http://127.0.0.1:${port}/${hash || ''}`, { waitUntil: 'load', timeout: 40000 });
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function loginFresh(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}

/** 读页面里的关键提醒状态（角标 / 提醒条） */
const ALERT_STATE = () => {
  const chip = document.querySelector('.user-chip-badge');
  const alert = document.querySelector('.admin-alert');
  const dd = document.querySelector('.user-dd-badge');
  const txt = alert ? (alert.textContent || '').replace(/\s+/g, ' ').trim() : '';
  return {
    chipExists: !!chip,
    chipText: chip ? chip.textContent.trim() : '',
    chipIsNew: chip ? chip.classList.contains('is-new') : false,
    alertVisible: !!alert,
    alertText: txt,
    ddExists: !!dd,
    ddText: dd ? dd.textContent.trim() : ''
  };
};

/* ============================================================ */
const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ========== 1. 注册端：提示 + 一键复制申请信息 ========== */
  console.log('1) 注册端（普通用户）：明确告知不会自动通知 + 一键复制申请信息');
  let code = '';
  let importLink = '';
  {
    const { ctx, page, errors } = await newPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    await gotoApp(page, A.port);
    // 无账号时默认落在注册表单
    await page.waitForSelector('#auth-register-form:not([hidden])', { timeout: 15000 });

    const tipTxt = await page.locator('#auth-register-form .auth-tip').first().textContent();
    check('注册表单提示已说明「不会自动通知管理员」', /不会自动通知管理员/.test(tipTxt || ''), tipTxt);

    await page.fill('#reg-username', 'newbie1');
    await page.fill('#reg-password', REG_PW);
    await page.fill('#reg-confirm', REG_PW);
    await page.click('#auth-register-form button[type=submit]');
    try {
      await page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 45000 });
    } catch (e) {
      const diag = await page.evaluate(() => ({
        msg: (document.getElementById('auth-msg') || {}).textContent || '',
        forms: [...document.querySelectorAll('.auth-form, #auth-reg-done')]
          .map(f => f.id + '=' + (f.hidden ? 'hidden' : 'visible'))
      }));
      console.log('  · 注册未进入完成页，诊断：' + JSON.stringify(diag));
      throw e;
    }

    const box = page.locator('#auth-reg-done .auth-alert-box');
    check('完成页出现「还有一步：请主动通知管理员」提示框', await box.count() === 1);
    const boxTxt = (await box.textContent()) || '';
    check('提示框文案点明「不会自动给管理员发通知」', /不会自动给管理员发通知/.test(boxTxt), boxTxt.replace(/\s+/g, ' ').slice(0, 60));

    check('完成页有「📨 复制申请信息，发给管理员」按钮',
      (await page.locator('#auth-reg-send').count()) === 1);
    check('原有「只复制申请码」按钮仍在', (await page.locator('#auth-reg-copy').count()) === 1);

    code = (await page.inputValue('#reg-code')).trim();
    check('已生成本次注册的申请码（SNTREG1. 前缀）', /^SNTREG1\.[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(code), code.slice(0, 40));

    await page.click('#auth-reg-send');
    await page.waitForTimeout(400);
    let clip = '';
    try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = ''; }
    check('点击后剪贴板拿到内容（消息已复制）', clip.length > 0, clip.slice(0, 40));
    check('复制的消息含用户名', clip.includes('newbie1'), clip.slice(0, 60));
    check('复制的消息含完整申请码', code.length > 0 && clip.includes(code));
    const mL = /#admin-import\?req=([^\s]+)/.exec(clip);
    check('复制的消息含「管理员一键导入」链接', !!mL, /admin-import/.test(clip) ? '有 #admin-import 但正则未匹配' : '整条消息里没有导入链接');
    if (mL) importLink = '#admin-import?req=' + mL[1];
    check('导入链接里的申请码与页面上的申请码一致',
      decodeURIComponent((mL && mL[1]) || '') === code,
      (mL && mL[1] || '').slice(0, 30));

    const msgTxt = await page.locator('#auth-msg').textContent();
    check('复制成功后有明确反馈', /已复制/.test(msgTxt || ''), msgTxt);
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ========== 2. 管理员端：点导入链接 → 自动填好申请码 ========== */
  console.log('\n2) 管理员端（跨设备）：点开用户发来的导入链接 → 自动打开用户管理并填好申请码');
  let adminCtx, adminPage, adminErrors;
  {
    const t = await newPage(browser, {});
    adminCtx = t.ctx; adminPage = t.page; adminErrors = t.errors;
    // 先正常登录管理员（模拟管理员自己的设备）
    await gotoApp(adminPage, A.port, '#news');
    await loginFresh(adminPage);
    await adminPage.waitForTimeout(300);

    let st = await adminPage.evaluate(ALERT_STATE);
    check('初始没有待审核申请时，不显示角标、不显示提醒条',
      !st.chipExists && !st.alertVisible, JSON.stringify(st));

    // 管理员点开注册者发来的链接（此时已登录）
    await adminPage.goto(`http://127.0.0.1:${A.port}/${importLink}`, { waitUntil: 'load', timeout: 40000 });
    await waitAppReady(adminPage);
    await adminPage.waitForSelector('.modal-um', { timeout: 20000 });

    const hashAfter = await adminPage.evaluate(() => location.hash);
    check('导入链接的 hash 已被清掉（不在地址栏留长串、刷新不会重复触发）', hashAfter === '', hashAfter.slice(0, 40));

    const filled = await adminPage.inputValue('.um-code-bar input');
    check('申请码已自动填进「导入申请」输入框', filled === code, filled.slice(0, 30));

    const toastTxt = await adminPage.evaluate(() => {
      const t = document.querySelector('.toast');
      return t ? t.textContent.trim() : '';
    });
    check('给出「已自动填好申请码」的提示', /自动填好/.test(toastTxt), toastTxt);

    // 点「导入申请」→ 该申请进入本机待审核
    await adminPage.click('.um-code-bar button');
    await adminPage.waitForFunction(() => {
      const items = document.querySelectorAll('.um-pending-item');
      return items.length === 1;
    }, null, { timeout: 20000 });
    const pendingName = await adminPage.textContent('.um-pending-item .um-name');
    check('导入后出现在「待审核注册申请」区', pendingName.trim() === 'newbie1', pendingName);
    check('待审核区显示申请人数', /1 人/.test((await adminPage.textContent('.um-pending-head')) || ''));

    // 关掉面板，检查角标（已读语义：数字在、不为红色未读）
    await adminPage.click('.modal-um .modal-header .btn-icon');
    await adminPage.waitForTimeout(400);
    st = await adminPage.evaluate(ALERT_STATE);
    check('关闭面板后角标显示待审核人数', st.chipExists && st.chipText === '1', JSON.stringify(st));
    check('刚看过的申请不算「未读」→ 角标不是红色呼吸态', st.chipIsNew === false, JSON.stringify(st));
    check('提醒条不重复弹出（已读后保持收起）', st.alertVisible === false, JSON.stringify(st));

    // 打开用户菜单，确认「用户管理」入口上也带待审数字
    await adminPage.click('.user-chip');
    await adminPage.waitForSelector('.user-dropdown', { timeout: 10000 });
    const stDd = await adminPage.evaluate(ALERT_STATE);
    check('用户菜单里「用户管理」也带待审数字', stDd.ddExists && /1 份待审/.test(stDd.ddText), stDd.ddText);
    await adminPage.keyboard.press('Escape');
  }

  /* ========== 3. 管理员端：同设备另一个标签页注册 → 立刻提醒 ========== */
  console.log('\n3) 管理员端（同设备）：另一个标签页提交注册 → storage 事件即时推送提醒');
  {
    const p2 = await adminCtx.newPage();
    p2.on('pageerror', e => adminErrors.push('p2: ' + e.message));
    await p2.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi/.test(u.href), r => r.abort());
    await p2.goto(`http://127.0.0.1:${A.port}/`, { waitUntil: 'load', timeout: 40000 });
    await p2.waitForSelector('#auth-gate', { timeout: 45000 });
    const rr = await p2.evaluate(async (pw) => {
      const r = await Auth.register('newbie2', pw);
      return { ok: r.ok, error: r.error || '' };
    }, REG_PW);
    check('另一标签页用真实注册路径提交成功', rr.ok, JSON.stringify(rr));

    // 同一浏览器跨标签页写 localStorage → 管理员页收到 storage 事件 → 立刻刷新
    await adminPage.waitForSelector('.admin-alert', { timeout: 20000 });
    const st = await adminPage.evaluate(ALERT_STATE);
    check('管理员页出现站内提醒条（无需手动刷新）', st.alertVisible, JSON.stringify(st));
    check('提醒条写明是「新的」注册申请', /1 份新的注册申请待审核/.test(st.alertText), st.alertText);
    check('提醒条列出申请人用户名', /newbie2/.test(st.alertText), st.alertText);
    check('角标数字更新为 2（累计待审核）', st.chipText === '2', JSON.stringify(st));
    check('有新申请时角标为红色未读态', st.chipIsNew === true, JSON.stringify(st));

    // 点「去审核」→ 打开用户管理，提醒条收起、角标转已读
    await adminPage.click('.admin-alert .btn-primary');
    await adminPage.waitForSelector('.modal-um', { timeout: 20000 });
    await adminPage.waitForTimeout(400);
    const st2 = await adminPage.evaluate(ALERT_STATE);
    check('「去审核」直接打开用户管理', (await adminPage.locator('.um-pending-item').count()) === 2);
    check('查看后提醒条收起', st2.alertVisible === false, JSON.stringify(st2));
    check('查看后角标转为已读（数字保留、不再红色）',
      st2.chipText === '2' && st2.chipIsNew === false, JSON.stringify(st2));

    // ✕ 关闭：再模拟一条新申请，验证可手动忽略
    await adminPage.click('.modal-um .modal-header .btn-icon');
    await adminPage.waitForTimeout(300);
    const rr2 = await p2.evaluate(async (pw) => (await Auth.register('newbie3', pw)).ok, REG_PW);
    check('第三条申请注册成功', rr2 === true);
    await adminPage.waitForSelector('.admin-alert', { timeout: 20000 });
    await adminPage.click('.admin-alert-x');
    await adminPage.waitForTimeout(400);
    const st3 = await adminPage.evaluate(ALERT_STATE);
    check('点 ✕ 可收起提醒条', st3.alertVisible === false, JSON.stringify(st3));
    check('点 ✕ 后角标仍在（未处理的事不会被隐藏）', st3.chipText === '3', JSON.stringify(st3));
    await p2.close();
  }

  /* ========== 3b. 切回本站时立即补扫（不依赖会被节流的定时器） ========== */
  console.log('\n3b) 切回本站（focus / visibilitychange）立即补扫');
  {
    const rrF = await adminPage.evaluate(async (pw) => (await Auth.register('focususer', pw)).ok, 'Passw0rd9');
    check('同页面写入一条新申请', rrF === true);
    // 不派发任何事件时，定时器可能被浏览器节流，界面不应立刻变化
    await adminPage.waitForTimeout(300);
    const before = await adminPage.evaluate(ALERT_STATE);
    check('未收到 focus/visibility 事件时不抢先刷新（角标仍是 3）', before.chipText === '3', JSON.stringify(before));

    // 模拟「管理员从微信切回浏览器」→ 应当立刻补扫
    await adminPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await adminPage.waitForTimeout(400);
    const after = await adminPage.evaluate(ALERT_STATE);
    check('切回窗口后角标立刻更新为 4', after.chipText === '4', JSON.stringify(after));
    check('切回窗口后提醒条重新弹出（又有新申请）', after.alertVisible === true, JSON.stringify(after));
    check('提醒条列出新申请人', /focususer/.test(after.alertText), after.alertText);
  }

  /* ========== 4. 未登录时打开导入链接（冷加载） ========== */
  console.log('\n4) 会话过期后重新打开用户发来的导入链接 → 落在登录页并明确提示');
  {
    // 只清会话，保留账号表 → 模拟「会话过期 / 换了浏览器」的管理员
    await adminPage.evaluate(() => {
      try { Auth.logout(); } catch (e) { /* ignore */ }
      try { localStorage.removeItem('snt-auth-session-v1'); } catch (e) { /* ignore */ }
    });
    // 用不同 path 强制完整加载（只改 hash 不会重载页面），模拟重新打开链接
    await adminPage.goto(`http://127.0.0.1:${A.port}/index.html${importLink}`, { waitUntil: 'load', timeout: 40000 });
    await adminPage.waitForSelector('#auth-gate', { timeout: 20000 });
    await adminPage.waitForSelector('#auth-login-form:not([hidden])', { timeout: 20000 });
    const msg = (await adminPage.textContent('#auth-msg')) || '';
    check('停在登录页并提示需先用管理员账号登录', /请先用管理员账号登录/.test(msg), msg);
    check('并说明登录后会自动填好申请码', /自动打开用户管理并填好申请码/.test(msg), msg);
    check('此时地址栏 hash 也已清掉', (await adminPage.evaluate(() => location.hash)) === '');
  }
  await adminCtx.close();

  /* ========== 5. 回归：提醒机制不引入数据请求 ========== */
  console.log('\n5) 回归：提醒轮询只读 localStorage，不会破坏「暂停数据刷新」约定');
  {
    const { ctx, page, errors, hotReqs } = await newPage(browser, {
      permissions: [],
      viewport: { width: 1400, height: 950 }
    });
    // 先暂停数据刷新，再进入会自动抓取的「全球信息」页
    await page.addInitScript(() => {
      try {
        const k = 'stock-news-tracker-v1';
        const d = JSON.parse(localStorage.getItem(k) || '{}');
        d.settings = Object.assign({}, d.settings, { dataPaused: true });
        localStorage.setItem(k, JSON.stringify(d));
      } catch (e) { /* ignore */ }
    });
    await gotoApp(page, A.port, '#finance');
    await loginFresh(page);

    // 覆盖提醒机制的两个刷新通道：等一个轮询周期（8s）+ 一次跨标签页写入
    const t0 = hotReqs.length;
    await page.waitForTimeout(9500);
    const p2 = await ctx.newPage();
    await p2.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb/.test(u.href), r => r.abort());
    await p2.goto(`http://127.0.0.1:${A.port}/`, { waitUntil: 'load', timeout: 40000 });
    await p2.waitForSelector('#auth-gate', { timeout: 45000 });
    await p2.evaluate(async (pw) => { await Auth.register('pauseduser', pw); }, REG_PW);
    await p2.waitForTimeout(1200);
    await p2.close();

    const hotAfter = hotReqs.length - t0;
    check('暂停状态下等待轮询 + 收到新注册申请，data/hot-topics 请求数仍为 0',
      hotAfter === 0, `hotReqs=${hotAfter} :: ${hotReqs.slice(0, 3).join(' , ')}`);
    const st = await page.evaluate(ALERT_STATE);
    check('暂停状态下提醒仍然工作（角标已出现）', st.chipExists && st.chipText === '1', JSON.stringify(st));
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();

  console.log('\n============================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('============================================');
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('测试异常：', e); process.exit(2); });
