/* ============================================================
 * e2e-batch16.mjs — 真实浏览器验证 batch16 的五件事
 *
 * 用户诉求：
 *   1) 用户须知：删掉「软件不要告诉任何人 / 共同学习交流」，改为
 *      「悟道以后，请帮助更多需要帮助的人，股友之间相互学习参悟，愿诸君早日悟道。」
 *   2) 「限时优惠活动（新股友 10%）」放到正文**上面**，且完整展示。
 *   3) 全球信息页「跨站重合榜 / 主题分类统计 / 格隆汇每日快讯」三个板块
 *      时间口径统一：以每天 15:00 为换日节点（不是 24:00），单设时间栏
 *      「新闻统计开始时间 <起> - <止>」（默认昨天 15:00 → 现在，可改），
 *      三个板块各自独立刷新，统计的是时间段内的实时快讯。
 *   4) 注册完成后加「← 返回登录」按钮。
 *   5) 【关键 bug】手机注册 → 管理员导入并授权三天 → 用户登录却一直提示
 *      「该账号正在等待管理员审核」，电脑再注册又是同一个申请码、管理员再导入说
 *      「已存在」，手机电脑都登不进。要求完成注册登录功能。
 *
 * 场景 3 用两个独立 browser context 模拟「两台设备」（localStorage 互不共享），
 * 完整重演用户的报障链路，这是本批最重要的回归。
 *
 * 用法：node scripts/e2e-batch16.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const USER_PW = 'User@2026pass';

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

/* 伪造快讯：时间戳横跨 15:00 分界，用于验证「按窗口过滤」真的生效 */
function makeBriefs(date, items) {
  return { date, source: 'gelonghui', sourceName: '格隆汇', generatedAt: date + ' 23:00', total: items.length, items };
}
const BRIEF_ITEMS = [
  { id: 1, time: '2026-09-16 16:00', url: 'https://e/1', text: '格隆汇9月16日｜收盘后消息：固态电池产线投产', stocks: [], subjects: [] },
  { id: 2, time: '2026-09-16 09:00', url: 'https://e/2', text: '格隆汇9月16日｜盘中早间消息：央行开展逆回购', stocks: [], subjects: [] },
  { id: 3, time: '2026-09-17 10:00', url: 'https://e/3', text: '格隆汇9月17日｜上午消息：英伟达发布新一代AI芯片', stocks: [], subjects: [] },
  { id: 4, time: '2026-09-17 16:30', url: 'https://e/4', text: '格隆汇9月17日｜收盘后消息：券商资管子公司获批', stocks: [], subjects: [] }
];

async function newCtx(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  if (o.fakeData) {
    await page.route(u => /briefs-2026-09-16\.json/.test(u.href), r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeBriefs('2026-09-16', [BRIEF_ITEMS[0], BRIEF_ITEMS[1]])) }));
    await page.route(u => /briefs-2026-09-17\.json/.test(u.href), r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeBriefs('2026-09-17', [BRIEF_ITEMS[2], BRIEF_ITEMS[3]])) }));
    await page.route(u => /\/data\/hot-topics\/2026-09-1[67]\.json/.test(u.href), r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        date: '2026-09-17', generatedAt: '2026-09-17 20:00',
        sources: [1, 2, 3].map(n => ({
          rank: n, key: 's' + n, name: '站点' + n, color: '#2563eb',
          items: [{ text: '固态电池量产提速 储能订单增长', time: '', url: '', cat: '科技' },
                  { text: '央行降准 银行存款成本下行', time: '', url: '', cat: '财经' }]
        }))
      }) }));
  }
  return { ctx, page, errors };
}

async function hardGoto(page, url, hash) {
  await page.goto(url + (hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function waitAuthReady(page) {
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForFunction(
    () => typeof window.Auth !== 'undefined' && typeof window.AuthUI !== 'undefined',
    null, { timeout: 60000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 90000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, { timeout: 90000 });
}

/* 在页面里以管理员身份起号并进入应用 */
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}
async function enterApp(page, url) {
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}

(async () => {
  const { srv, port } = await serveStatic(ROOT);
  const base = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch();

  try {
    /* ================= 场景 1：用户须知文案与限时优惠位置 ================= */
    console.log('\n[场景 1] 用户须知：限时优惠前置 + 结语文案');
    {
      const { ctx, page, errors } = await newCtx(browser);
      await hardGoto(page, base, '#holdings');   // 用户须知按钮在「👤 用户」页
      await waitAuthReady(page);
      await bootAdmin(page);
      await page.waitForSelector('.btn-notice', { timeout: 15000 });
      await page.click('.btn-notice');
      await page.waitForSelector('.notice-modal', { timeout: 15000 });

      const modalText = (await page.locator('.notice-modal').innerText()).replace(/\s+/g, ' ');
      check('弹窗已打开', await page.locator('.notice-modal').isVisible());

      // 限时优惠：存在且位于正文（.notice-body）之前
      const promoBefore = await page.evaluate(() => {
        const m = document.querySelector('.notice-modal');
        if (!m) return { ok: false, why: 'no modal' };
        const promo = m.querySelector('.notice-promo');
        const body = m.querySelector('.notice-body');
        if (!promo || !body) return { ok: false, why: 'missing promo/body' };
        return { ok: (promo.compareDocumentPosition(body) & 4) === 4, text: promo.innerText.replace(/\s+/g, ' ') };
      });
      check('限时优惠块在正文上方', promoBefore.ok === true, JSON.stringify(promoBefore));
      check('限时优惠文案完整（10% + 直至新股友退出为止）',
        /10\s*%/.test(modalText) && /直至新股友退出为止/.test(modalText));

      // 新结语文案
      check('新结语文案「悟道以后，请帮助更多需要帮助的人」', /悟道以后，请帮助更多需要帮助的人/.test(modalText));
      check('新结语文案「股友之间相互学习参悟，愿诸君早日悟道」', /股友之间相互学习参悟，愿诸君早日悟道/.test(modalText));
      // 旧文案必须消失
      check('旧文案「不要告诉任何人」已删除', !/不要告诉任何人/.test(modalText));
      check('旧文案「共同学习和交流」已删除', !/共同学习和交流/.test(modalText));

      check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    /* ================= 场景 2：注册后「返回登录」按钮 ================= */
    console.log('\n[场景 2] 注册完成后「← 返回登录」按钮');
    {
      const { ctx, page, errors } = await newCtx(browser);
      await hardGoto(page, base, '#register');
      await waitAuthReady(page);
      // 走真实注册表单
      await page.fill('#reg-username', 'bob16');
      await page.fill('#reg-password', USER_PW);
      await page.fill('#reg-confirm', USER_PW);
      await page.click('#auth-register-form button[type="submit"]');
      await page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 20000 });

      const backVisible = await page.locator('#auth-reg-done-back').isVisible();
      const backText = (await page.locator('#auth-reg-done-back').innerText()).trim();
      check('注册完成页有「返回登录」按钮', backVisible);
      check('按钮文案含「返回登录」', /返回登录/.test(backText), backText);
      check('按钮是实心按钮样式（.auth-btn）',
        await page.locator('#auth-reg-done-back.auth-btn').count() === 1);

      // 点击后应回到登录表单
      await page.click('#auth-reg-done-back');
      await page.waitForTimeout(300);
      check('点「返回登录」回到登录表单',
        await page.locator('#auth-login-form').isVisible() && !(await page.locator('#auth-reg-done').isVisible()));

      check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    /* ================= 场景 3：双设备注册 → 审核 → 登录闭环（核心 bug） ================= */
    console.log('\n[场景 3] 两台设备：注册 → 管理员审核 → 用户粘贴准入码 → 登录成功');

    // ---- 设备 U（用户手机/电脑）----
    const U = await newCtx(browser);
    await hardGoto(U.page, base);
    await waitAuthReady(U.page);
    await U.page.evaluate(() => { Auth.init(); });
    let regRes = await U.page.evaluate(async (pw) => {
      const r = await Auth.register('alice16', pw);
      return { ok: r.ok, error: r.error || '', code: r.requestCode || '' };
    }, USER_PW);
    check('设备U 注册成功并返回申请码', regRes.ok && /^SNTREG1/.test(regRes.code), JSON.stringify(regRes));

    // 同一设备重复注册：应复用并给回同一个申请码（而不是报错或换码）
    const regAgain = await U.page.evaluate(async (pw) => {
      const r = await Auth.register('alice16', pw);
      return { ok: r.ok, error: r.error || '', code: r.requestCode || '', again: !!r.alreadySubmitted };
    }, USER_PW);
    check('同设备重复注册：复用同一申请码', regAgain.ok && regAgain.code === regRes.code && regAgain.again === true,
      JSON.stringify(regAgain));

    // 未拿到准入码前登录 → 应被拦下，并给出可操作引导
    const loginBefore = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('alice16', pw, true);
      return { ok: r.ok, error: r.error || '', status: r.status || '' };
    }, USER_PW);
    check('审核前登录被拦下（status=pending）', !loginBefore.ok && loginBefore.status === 'pending',
      JSON.stringify(loginBefore));

    // ---- 设备 A（管理员）----
    const A = await newCtx(browser);
    await hardGoto(A.page, base);
    await waitAuthReady(A.page);
    await A.page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
    const imported = await A.page.evaluate((code) => {
      const r = Auth.applyRequestCode(code);
      return { ok: r.ok, error: r.error || '', user: (r.user && r.user.username) || '' };
    }, regRes.code);
    check('管理员设备导入申请码成功', imported.ok && imported.user === 'alice16', JSON.stringify(imported));

    // 重复导入同一申请码（账号已通过时应提示已存在，不炸）
    const approved = await A.page.evaluate(() => {
      const r = Auth.approveUser('alice16', 'user');
      return { ok: r.ok, error: r.error || '', code: r.approveCode || '' };
    });
    check('管理员审核通过并返回准入码', approved.ok && /^SNTACC1/.test(approved.code), JSON.stringify(approved));
    const reImport = await A.page.evaluate((code) => {
      const r = Auth.applyRequestCode(code);
      return { ok: r.ok, error: r.error || '' };
    }, regRes.code);
    check('重复导入同一申请码不崩溃（提示已存在）', reImport.ok === false && /已存在|已通过/.test(reImport.error),
      JSON.stringify(reImport));

    // ---- 回到设备 U：粘贴准入码后应能登录 ----
    const importedOnU = await U.page.evaluate((code) => {
      const r = Auth.importApproveCode(code);
      return { ok: r.ok, error: r.error || '', status: r.status || '' };
    }, approved.code);
    check('设备U 粘贴准入码成功且状态为已通过', importedOnU.ok && importedOnU.status === 'active',
      JSON.stringify(importedOnU));

    const loginAfter = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('alice16', pw, true);
      return { ok: r.ok, error: r.error || '', user: (r.user && r.user.username) || '' };
    }, USER_PW);
    check('🔴 设备U 用原密码登录成功（闭环打通）', loginAfter.ok && loginAfter.user === 'alice16',
      JSON.stringify(loginAfter));

    /* ---- 子场景 3b：只「授权三天」不点通过，也要能登录（用户报的原场景）---- */
    console.log('\n[场景 3b] 管理员只开「试用三天」不点通过 → 用户凭准入码登录');
    const regBob = await U.page.evaluate(async (pw) => {
      const r = await Auth.register('bob16b', pw);
      return { ok: r.ok, code: r.requestCode || '' };
    }, USER_PW);
    const grantRes = await A.page.evaluate((code) => {
      const im = Auth.applyRequestCode(code);
      if (!im.ok) return { ok: false, error: im.error };
      const g = Auth.grantTrial('bob16b', 3);
      return { ok: g.ok, error: g.error || '', until: g.untilText || '', code: g.approveCode || '' };
    }, regBob.code);
    check('管理员开通三天试用并拿到准入码', grantRes.ok && /^SNTACC1/.test(grantRes.code), JSON.stringify(grantRes));

    const codeFor = await A.page.evaluate(() => {
      const r = Auth.approveCodeFor('bob16b');
      return { ok: r.ok, error: r.error || '', status: r.status || '' };
    });
    check('未通过但已开试用的账号也能取准入码', codeFor.ok && codeFor.status === 'pending', JSON.stringify(codeFor));

    const bobImport = await U.page.evaluate((code) => {
      const r = Auth.importApproveCode(code);
      return { ok: r.ok, error: r.error || '', status: r.status || '', trial: !!r.trial, until: r.untilText || '' };
    }, grantRes.code);
    check('设备U 粘贴后带上试用期', bobImport.ok && bobImport.trial === true, JSON.stringify(bobImport));

    const bobLogin = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('bob16b', pw, true);
      return { ok: r.ok, error: r.error || '', trial: !!r.trial };
    }, USER_PW);
    check('🔴 只授权三天的账号也能登录（trial 生效）', bobLogin.ok && bobLogin.trial === true,
      JSON.stringify(bobLogin));

    /* ---- 子场景 3c：登录页 pending 引导按钮 ---- */
    const guide = await U.page.evaluate(async (pw) => {
      const r = await Auth.login('carol16', pw, true);   // 不存在的账号 → 走普通错误
      return { ok: r.ok, error: r.error || '' };
    }, USER_PW);
    check('不存在账号走普通错误（不误弹引导）', !guide.ok && !/pending/.test(JSON.stringify(guide)), JSON.stringify(guide));

    // UI 引导：先退出登录（否则 reload 会因会话恢复直接进应用，看不到登录卡）
    await U.page.evaluate(() => { try { Auth.logout(); } catch (e) { /* ignore */ } });
    await hardGoto(U.page, base);
    await waitAuthReady(U.page);
    await U.page.fill('#login-username', 'alice16');
    await U.page.fill('#login-password', USER_PW);
    // 先把 alice16 打回 pending，制造引导场景
    await U.page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('snt-auth-users-v1') || '[]');
      const u = list.find(x => x.username === 'alice16');
      if (u) { u.status = 'pending'; u.trialUntil = 0; }
      localStorage.setItem('snt-auth-users-v1', JSON.stringify(list));
      Auth.init();
    });
    await U.page.click('#auth-login-form button[type="submit"]');
    await U.page.waitForTimeout(700);
    const guideVisible = await U.page.locator('#auth-guide-code').count();
    check('pending 登录后出现「我有准入码，去粘贴」引导按钮', guideVisible === 1, 'count=' + guideVisible);

    await U.ctx.close();
    await A.ctx.close();

    /* ================= 场景 4：三板块统一时间窗口（15:00 换日） ================= */
    console.log('\n[场景 4] 三板块时间栏 + 独立刷新 + 15:00 换日');
    {
      const { ctx, page, errors } = await newCtx(browser, { fakeData: true });
      await hardGoto(page, base, '#finance');   // 「🌐 全球信息」页
      await waitAuthReady(page);
      await bootAdmin(page);
      await page.waitForTimeout(800);

      // 快讯面板时间栏
      const briefWin = await page.locator('.brief-head ~ .stat-win, #ht-brief .stat-win, .stat-win').count();
      check('页面存在统计时间栏 .stat-win', briefWin >= 1, 'count=' + briefWin);

      const inputs = page.locator('#brief-stat-win input[type="datetime-local"]');
      const inputCount = await inputs.count();
      check('时间栏含起止两个时间输入框', inputCount >= 2, 'count=' + inputCount);

      // 默认值应为「昨天 15:00 → 现在」
      const defStart = await inputs.first().inputValue();
      check('默认开始时间是昨天 15:00', /T15:00$/.test(defStart), defStart);
      const startDay = (defStart || '').slice(0, 10);
      const yest = await page.evaluate(() => {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      });
      check('默认开始日期 = 昨天', startDay === yest, startDay + ' vs ' + yest);

      // 时间栏文案格式：'YYYY年M月D日 HH:mm - YYYY年M月D日 HH:mm'
      const winText = (await page.locator('#brief-stat-win .sw-text').first().innerText()).trim();
      check('时间栏展示中文时间文案', /\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2} - \d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(winText),
        winText);

      // 刷新按钮：三个板块（快讯 1 个 + 统计分析区 1 个 + 两个板块内联各 1 个）
      const refreshBtns = await page.locator('.stat-win .sw-btn').count();
      check('时间栏含刷新/重置按钮', refreshBtns >= 2, 'count=' + refreshBtns);

      // 切到「统计分析」tab（跨站重合榜 / 主题分类统计在这一层）
      const toAnalysis = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.ht-tab')].find(e => /统计分析/.test(e.innerText || ''));
        if (b) { b.click(); return true; }
        return false;
      });
      await page.waitForTimeout(900);
      check('切到统计分析 tab 且面板可见',
        toAnalysis === true && await page.locator('#ht-analysis').isVisible(), 'toAnalysis=' + toAnalysis);

      const anWin = await page.locator('#ht-analysis .stat-win').count();
      check('统计分析区也有统一时间栏', anWin === 1, 'count=' + anWin);

      // 板块内容要等分析结果出来才渲染，先点「生成统计」
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(e => /生成统计/.test(e.innerText || ''));
        if (b) b.click();
      });
      await page.waitForTimeout(2500);
      const inlineBtns = await page.locator('.sub-title .sw-btn.sw-inline').count();
      check('跨站重合榜/主题分类统计各有独立刷新按钮', inlineBtns >= 2, 'count=' + inlineBtns);

      check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

    /* ================= 场景 5：时间窗口过滤真的生效 ================= */
    console.log('\n[场景 5] 改时间窗口 → 统计结果随之变化');
    {
      const { ctx, page, errors } = await newCtx(browser, { fakeData: true });
      await hardGoto(page, base, '#finance');   // 「🌐 全球信息」页
      await waitAuthReady(page);
      await bootAdmin(page);
      await page.waitForTimeout(800);

      // 把窗口设为 2026-09-16 15:00 → 2026-09-17 15:00（应命中 16 日 16:00 与 17 日 10:00 两条）
      const res = await page.evaluate(async () => {
        const inp = [...document.querySelectorAll('#brief-stat-win input[type="datetime-local"]')];
        if (inp.length < 2) return { ok: false, why: 'no inputs' };
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(inp[0], '2026-09-16T15:00');
        setVal(inp[1], '2026-09-17T15:00');
        await new Promise(r => setTimeout(r, 200));
        const btn = [...document.querySelectorAll('#brief-stat-win .sw-btn')].find(b => /刷新/.test(b.innerText || ''));
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 1800));
        return { ok: true };
      });
      check('已设置窗口并点刷新', res.ok === true, JSON.stringify(res));

      const shown = await page.evaluate(() => {
        const w = document.querySelector('.brief-window .bw-label');
        const cnt = document.querySelector('.brief-window .bw-count');
        return { label: w ? w.innerText.replace(/\s+/g, ' ') : '', count: cnt ? cnt.innerText.replace(/\s+/g, ' ') : '' };
      });
      check('刷新后出现窗口统计条', /15:00/.test(shown.label) && /共 \d+ 条/.test(shown.count),
        JSON.stringify(shown));
      // 该窗口内应只有 2 条（16日16:00 与 17日10:00），17日16:30 的应被排除（已过 17 日 15:00）
      const n = parseInt((shown.count.match(/(\d+)/) || [0, '0'])[1], 10);
      check('🔴 15:00 分界过滤生效（窗口内 2 条，不含 17日16:30）', n === 2, 'got=' + n);

      check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }

  } catch (e) {
    fail++;
    console.log('\n!! 脚本异常: ' + (e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
