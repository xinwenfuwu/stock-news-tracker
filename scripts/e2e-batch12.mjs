/* ============================================================
 * e2e-batch12.mjs — 真实浏览器验证「普通用户注册直达链接」
 *
 * 用户诉求：管理员要能直接把一条「注册链接」发给要用工具的人，
 *   对方点开就是注册表单，而不是先看登录页再自己找「注册新账号」。
 *
 * 本批改动（js/auth-boot.js）：
 *   · wantsRegister()      识别 `#register` / `#signup`
 *   · clearRegisterHash()  离开注册表单时把 hash 抹掉（否则刷新又被弹回注册页）
 *   · start()              冷加载带 #register → 直接 showForm('register')
 *   · onHashChange()       站点已开着时把链接粘进地址栏 → 不刷新即切到注册表单
 *   · 返回登录按钮         清 hash 后再 showForm
 *
 * 覆盖：
 *   1) 冷加载 #register（已有账号表、未登录）→ 落在注册表单，不是登录页
 *   2) 对照：不带 hash → 仍是登录页（不误伤既有入口）
 *   3) 热导航：登录页上改 hash → 不刷新即切到注册表单
 *   4) 「返回登录」清 hash → 当前在登录页，且刷新后仍是登录页
 *   5) 从 #register 走完整注册 → 完成页 / 申请码 / 消息含管理员导入链接
 *   6) 回归：#admin-import 导入链接仍自动打开用户管理并预填申请码
 *   7) 首次使用（无账号表）带 #register → 注册表单
 *   8) 注册等待期间对 data/hot-topics 的请求数为 0（不破坏「暂停数据刷新」约定）
 *
 * 外部行情/IP 源全部 abort，应用代码与 UI 交互均为真实行为。
 * 用法：node scripts/e2e-batch12.mjs
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
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  await page.addInitScript((d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  }, SEED);
  return { ctx, page, errors, hotReqs };
}

/**
 * 强制一次真正的文档加载。
 * 坑：只有 hash 不同时浏览器走的是**同文档导航**，不会重新加载文档；
 *     而登录成功后 auth-gate 已被移出 DOM，于是「冷加载」会被误测成「热导航」，
 *     表现为等 #auth-gate 等到超时。必须显式 reload 一次。
 */
async function hardGoto(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function gotoApp(page, port, hash) {
  await hardGoto(page, `http://127.0.0.1:${port}/${hash || ''}`);
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
/** 已登录场景的冷加载：进入应用（没有登录关卡） */
async function gotoLoggedIn(page, port, hash) {
  await hardGoto(page, `http://127.0.0.1:${port}/${hash || ''}`);
  await waitAppReady(page);
}
async function loginFresh(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}
/** 造出「已有账号表、但当前未登录」的状态（模拟新用户第一次进来） */
async function logoutKeepUsers(page) {
  await page.evaluate(() => {
    try { Auth.logout(); } catch (e) { /* ignore */ }
    try { localStorage.removeItem('snt-auth-session-v1'); } catch (e) { /* ignore */ }
  });
}
/** 当前哪个表单可见：login / register / regdone / code / none */
const VISIBLE_FORM = () => {
  const ids = ['auth-login-form', 'auth-register-form', 'auth-reg-done', 'auth-code-panel'];
  const vis = ids.filter(id => {
    const el = document.getElementById(id);
    return el && !el.hidden;
  });
  return { vis, hash: location.hash, sub: (document.getElementById('auth-sub') || {}).textContent || '' };
};

/* ============================================================ */
const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  /* ========== 1. 冷加载 #register ========== */
  console.log('1) 已有账号表、未登录：打开 #register 直达链接');
  let guestCtx, guestPage, guestErrors, guestHot;
  let guestCode = '';
  {
    const t = await newPage(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
    guestCtx = t.ctx; guestPage = t.page; guestErrors = t.errors; guestHot = t.hotReqs;

    // 先在这台"设备"上创建管理员（此后登录页才是默认入口）
    await gotoApp(guestPage, A.port);
    await loginFresh(guestPage);
    await logoutKeepUsers(guestPage);

    // 管理员发给新用户的链接
    await gotoApp(guestPage, A.port, '#register');
    let st = await guestPage.evaluate(VISIBLE_FORM);
    check('打开 #register 直接落在「注册表单」，不是登录页',
      st.vis.length === 1 && st.vis[0] === 'auth-register-form', JSON.stringify(st.vis));
    check('副标题说明是注册（注册新账号 · 提交后需管理员审核）',
      /注册新账号/.test(st.sub), st.sub);
    check('地址栏保留 #register（链接可复制、可刷新）', st.hash === '#register', st.hash);

    /* ---- 对照：不带 hash 仍是登录页 ---- */
    await gotoApp(guestPage, A.port);
    st = await guestPage.evaluate(VISIBLE_FORM);
    check('不带 hash 打开时仍是登录页（未误伤既有入口）',
      st.vis.length === 1 && st.vis[0] === 'auth-login-form', JSON.stringify(st.vis));

    /* ---- 热导航：已开着页面，把链接粘进地址栏 ---- */
    await guestPage.evaluate(() => { location.hash = '#register'; });
    await guestPage.waitForFunction(() => {
      const el = document.getElementById('auth-register-form');
      return el && !el.hidden;
    }, null, { timeout: 8000 }).catch(() => {});
    st = await guestPage.evaluate(VISIBLE_FORM);
    check('页面已开着时改 hash → 无需刷新即切到注册表单',
      st.vis.length === 1 && st.vis[0] === 'auth-register-form', JSON.stringify(st.vis));

    /* ---- 返回登录：清 hash ---- */
    await guestPage.click('#auth-reg-back');
    await guestPage.waitForTimeout(300);
    st = await guestPage.evaluate(VISIBLE_FORM);
    check('点「返回登录」回到登录表单',
      st.vis.length === 1 && st.vis[0] === 'auth-login-form', JSON.stringify(st.vis));
    check('并且 #register 已从地址栏清掉', st.hash === '', st.hash);

    await guestPage.reload({ waitUntil: 'load', timeout: 40000 });
    await guestPage.waitForSelector('#auth-gate', { timeout: 30000 });
    await guestPage.waitForTimeout(500);
    st = await guestPage.evaluate(VISIBLE_FORM);
    check('刷新后仍在登录页（不会被弹回注册页）',
      st.vis.length === 1 && st.vis[0] === 'auth-login-form', JSON.stringify(st.vis));

    /* ---- 从 #register 走完整注册 ---- */
    await gotoApp(guestPage, A.port, '#register');
    await guestPage.waitForSelector('#auth-register-form:not([hidden])', { timeout: 15000 });
    await guestPage.fill('#reg-username', 'newbie12');
    await guestPage.fill('#reg-password', REG_PW);
    await guestPage.fill('#reg-confirm', REG_PW);
    await guestPage.click('#auth-register-form button[type=submit]');
    await guestPage.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 45000 });
    check('从直达链接可以正常完成注册（进入完成页）', true);

    guestCode = (await guestPage.inputValue('#reg-code')).trim();
    check('已生成申请码', /^SNTREG1\./.test(guestCode), guestCode.slice(0, 30));

    await guestPage.click('#auth-reg-send');
    await guestPage.waitForTimeout(400);
    let clip = '';
    try { clip = await guestPage.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = ''; }
    check('复制出的申请信息里含管理员导入链接', /#admin-import\?req=/.test(clip), clip.slice(0, 60));

    await guestPage.click('#auth-reg-done-back');
    await guestPage.waitForTimeout(300);
    st = await guestPage.evaluate(VISIBLE_FORM);
    check('从完成页返回登录：#register 也被清掉、落在登录页',
      st.hash === '' && st.vis[0] === 'auth-login-form', JSON.stringify(st));

    check('注册全程无 JS 报错', guestErrors.length === 0, JSON.stringify(guestErrors.slice(0, 3)));
    check('注册等待期间未自动请求 data/hot-topics（守住「暂停刷新」约定）',
      guestHot.length === 0, guestHot.slice(0, 2).join(', '));
  }

  /* ========== 2. 回归：#admin-import 导入链接仍可用 ========== */
  console.log('\n2) 回归：管理员点导入链接 → 自动打开用户管理并预填申请码');
  {
    const { ctx, page, errors } = await newPage(browser, {});
    await gotoApp(page, A.port, '#news');
    await loginFresh(page);
    await page.waitForTimeout(300);

    const link = '#admin-import?req=' + encodeURIComponent(guestCode);
    await page.goto(`http://127.0.0.1:${A.port}/${link}`, { waitUntil: 'load', timeout: 40000 });
    await waitAppReady(page);
    await page.waitForSelector('.modal-um', { timeout: 20000 });

    check('导入链接的 hash 仍会被清掉', (await page.evaluate(() => location.hash)) === '');
    const filled = await page.inputValue('.um-code-bar input');
    check('申请码仍被自动填好', filled === guestCode, filled.slice(0, 30));

    await page.click('.um-code-bar button');
    await page.waitForFunction(() => document.querySelectorAll('.um-pending-item').length === 1, null, { timeout: 20000 });
    const nm = (await page.textContent('.um-pending-item .um-name')).trim();
    check('导入后出现在「待审核注册申请」区', nm === 'newbie12', nm);
    check('管理员端无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ========== 3. 首次使用（无账号表）带 #register ========== */
  console.log('\n3) 全新设备（无账号表）带 #register 打开');
  {
    const { ctx, page, errors } = await newPage(browser, {});
    await gotoApp(page, A.port, '#register');
    await page.waitForTimeout(800);
    const st = await page.evaluate(VISIBLE_FORM);
    check('仍是注册表单（首次使用本来就默认注册）',
      st.vis.length === 1 && st.vis[0] === 'auth-register-form', JSON.stringify(st.vis));
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  /* ========== 4. 已登录的管理员带 #register 打开：不崩 ========== */
  console.log('\n4) 已登录管理员误点注册链接：不应看到空白页');
  {
    const { ctx, page, errors } = await newPage(browser, {});
    await gotoApp(page, A.port);
    await loginFresh(page);
    await gotoLoggedIn(page, A.port, '#register');
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => {
      const app = document.getElementById('app');
      return {
        textLen: (document.body.innerText || '').trim().length,
        navCount: document.querySelectorAll('nav.main-nav .nav-item').length,
        pageVisible: !!document.querySelector('.page, .news-page, main')
      };
    });
    check('登录状态下带 #register 打开仍进入应用、不空白',
      info.textLen > 50 && info.navCount >= 5, JSON.stringify(info));
    check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
    await ctx.close();
  }

  await browser.close();
  A.srv.close();

  console.log('\n============================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
  console.log('============================================');
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('运行异常：', e); process.exit(2); });
