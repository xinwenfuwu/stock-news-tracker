/* ============================================================
 * e2e-batch13.mjs — 真实浏览器验证「账号级数据隔离」
 *
 * 用户诉求（两条都很硬）：
 *   1) 普通用户之间不能看到彼此的本地数据；管理员的数据绝对不能出现在普通用户那里。
 *   2) 同一台设备、同一个浏览器里登录普通账号，内容不能和管理员账号一样 ——
 *      两个账号必须是各自独立的账号。
 *
 * 根因：早期 v1 只有一个 localStorage 键 `stock-news-tracker-v1`，
 *   所有账号共用同一份数据 —— 换账号只是换了个门牌，数据还是同一批。
 *
 * 本批改动：
 *   · store.js       一个账号一个键 `stock-news-tracker-v1::<username>`；
 *                    升级前的旧共享数据只允许**管理员接管一次**，普通账号从空数据开始
 *   · cloud-sync.js  云同步凭据同样按账号隔离（否则普通账号会继承管理员的 GitHub Token）
 *   · app.js         Store.init 传入当前账号；「本地数据」面板补运行时权限校验
 *   · index.html     「🗄 本地数据」入口改成 v-if="can('data.clear')"（仅管理员可见）
 *
 * 覆盖（同一浏览器上下文里三个账号来回切换）：
 *   1) 管理员首次登录 → 接管升级前的旧共享数据（键变成 ::admin，旧键留作备份）
 *   2) 管理员写入标记数据
 *   3) 退出 → 普通账号 A 登录 → 看不到管理员任何数据、入口没有、自己从空开始
 *   4) A 写入自己的标记数据
 *   5) 退出 → 普通账号 B 登录 → 既看不到管理员的、也看不到 A 的
 *   6) B 写入自己的标记数据
 *   7) 回到 A → 只看到自己的；回到管理员 → 只看到自己的
 *   8) 三个账号各自一个独立存储键
 *   9) 云同步凭据隔离（含「只允许管理员接管一次」的规则）
 *  10) resolveKey 迁移规则的边界用例（不接管 / 接管一次 / 不重复接管 / 清理保护）
 *  11) 三个存储键的内容互不串门（物理隔离）
 *  12) 升级兼容：普通账号「自己的持仓」从旧共享数据里被认领回来，其余一概不继承
 *
 * 外部行情/IP 源全部 abort，应用代码与 UI 交互均为真实行为。
 * 用法：node scripts/e2e-batch13.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const PW_A = 'User@2026';
const PW_B = 'User@2026';
const LEGACY_KEY = 'stock-news-tracker-v1';
const OWNER_KEY = 'snt-store-owner-v1';

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

/** 升级前的「旧共享数据」：注意 settings.categories 特意用非默认值，用来证明旧数据被接管 */
const SEED = {
  news: [], stockPools: [], favorites: [], dailyData: {}, hotTopicSnapshots: {},
  hotBoards: [], hotStocks: [], preMarketBoards: [], amplitudeBoards: [], sectorPools: [],
  settings: { categories: ['旧共享分类'], proxyUrl: '' }
};

async function newCtx(browser, seed) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  await page.addInitScript((d) => {
    if (localStorage.getItem('__e2e_seeded')) return;
    localStorage.setItem('stock-news-tracker-v1', JSON.stringify(d));
    localStorage.setItem('__e2e_seeded', '1');
  }, seed || SEED);
  return { ctx, page, errors };
}

async function hardGoto(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
async function gotoApp(page, port) {
  await hardGoto(page, `http://127.0.0.1:${port}/`);
  await page.waitForSelector('#auth-gate', { timeout: 45000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await waitAppReady(page);
}
async function logoutAndWait(page) {
  await page.evaluate(() => AuthUI.logout());
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForSelector('#auth-login-form:not([hidden])', { timeout: 30000 });
}
async function loginAs(page, username, password) {
  const r = await page.evaluate(async ([u, p]) => {
    const res = await Auth.login(u, p);
    if (res && res.ok) AuthUI.enterApp();
    return res || { ok: false, error: '无返回' };
  }, [username, password]);
  if (!r.ok) throw new Error(`登录 ${username} 失败：${r.error}`);
  await waitAppReady(page);
}

/** 一次性探针：把「应用眼里的数据」和「DOM 里有没有泄漏」都取回来 */
const PROBE = () => {
  const S = (typeof Store !== 'undefined') ? Store : null;
  const A = (typeof Auth !== 'undefined') ? Auth : null;
  const body = document.body ? document.body.textContent || '' : '';
  let keys = [];
  try { keys = Object.keys(localStorage).filter(k => /^stock-news-tracker-v1/.test(k)); } catch (e) { }
  const titles = (S && S.data && S.data.news) ? S.data.news.map(n => n.title) : [];
  return {
    storeKey: S ? S.STORAGE_KEY : '',
    storeAccount: S ? S.account : '',
    titles,
    titlesInDom: titles.filter(t => t && body.indexOf(t) >= 0),
    settingsCat: (S && S.data && S.data.settings && S.data.settings.categories) || [],
    canClear: !!(A && A.can('data.clear')),
    role: (A && A.user) ? A.user.role : '',
    me: (A && A.user) ? A.user.username : '',
    hasLocalDataBtn: !!document.querySelector('.btn-data'),
    hasLdModal: !!document.querySelector('.ld-modal'),
    legacy: S ? S.legacyInfo() : null,
    storeKeys: keys,
    cloudCredsKey: (typeof CloudSync !== 'undefined' && CloudSync.credsKey) ? CloudSync.credsKey() : '',
    cloudToken: (function () {
      try {
        const c = (typeof CloudSync !== 'undefined' && CloudSync.getCreds) ? CloudSync.getCreds() : null;
        return (c && c.token) || '';
      } catch (e) { return ''; }
    })(),
    adminNewsInDom: body.indexOf('管理员专属新闻') >= 0,
    aNewsInDom: body.indexOf('用户A专属新闻') >= 0,
    bNewsInDom: body.indexOf('用户B专属新闻') >= 0
  };
};
const addNews = (title) => {
  // 注意：新闻列表正文列渲染的是 `content`（title 只是行内 tooltip），
  // 所以标记要同时写进 content，否则 DOM 断言会因为「没渲染出来」而假失败。
  Store.addNews({
    title: title, content: title, date: Store.today(), source: 'E2E', category: '主线概念',
    conceptCategory: '', industryCategory: '', customTag: '',
    relatedStocks: [], stockPrices: {}, url: ''
  });
  Store.saveNow();
  return (Store.data.news || []).map(n => n.title);
};

/* ============================================================ */
const main = async () => {
  const A = await serveStatic(ROOT);
  const browser = await chromium.launch();

  try {
    /* ========== 1. 管理员首次登录 → 接管升级前的旧共享数据 ========== */
    console.log('\n1) 管理员首次登录 → 接管「升级前的旧共享数据」');
    const t = await newCtx(browser);
    const page = t.page;
    await gotoApp(page, A.port);
    await bootAdmin(page);
    let st = await page.evaluate(PROBE);
    check('数据键已按账号拆分到 ::admin', st.storeKey === LEGACY_KEY + '::admin', st.storeKey);
    check('store.account 记为 admin', st.storeAccount === 'admin', st.storeAccount);
    check('管理员拿到了旧共享数据（settings 是旧值）',
      st.settingsCat.length === 1 && st.settingsCat[0] === '旧共享分类', JSON.stringify(st.settingsCat));
    check('升级前的旧键仍在（留作备份，不直接删）', st.legacy && st.legacy.exists === true, JSON.stringify(st.legacy));
    check('旧键归属标记为 admin（只接管一次的依据）', st.legacy && st.legacy.owner === 'admin', JSON.stringify(st.legacy));
    check('旧键已不是当前账号正在使用的键', st.legacy && st.legacy.isCurrent === false);
    check('管理员：can(data.clear) = true', st.canClear === true);
    check('管理员：能看到「🗄 本地数据」入口', st.hasLocalDataBtn === true);

    /* ========== 2. 管理员写入自己的标记数据 ========== */
    console.log('\n2) 管理员写入自己的标记数据');
    const adminTitles = await page.evaluate(addNews, '管理员专属新闻★');
    check('管理员数据里有自己的新闻', adminTitles.indexOf('管理员专属新闻★') >= 0, JSON.stringify(adminTitles));
    st = await page.evaluate(PROBE);
    check('这条新闻确实渲染进了 DOM', st.titlesInDom.indexOf('管理员专属新闻★') >= 0, JSON.stringify(st.titlesInDom));
    const adminRaw = await page.evaluate((k) => (localStorage.getItem(k) || ''), LEGACY_KEY + '::admin');
    check('已落盘到管理员自己的键', adminRaw.indexOf('管理员专属新闻★') >= 0, adminRaw.length);
    // 管理员写一份云同步凭据，用来验证普通账号继承不到
    const adminCreds = await page.evaluate(() => {
      CloudSync.setCreds({ token: 'T_ADMIN_ONLY', gistId: 'g1', autoSync: false });
      const c = CloudSync.getCreds() || {};
      return { token: c.token, key: CloudSync.credsKey() };
    });
    check('管理员凭据写到自己账号的键', adminCreds.token === 'T_ADMIN_ONLY' && adminCreds.key === 'cloud-creds-v1::admin',
      JSON.stringify(adminCreds));

    /* ========== 3. 建两个普通账号 ========== */
    console.log('\n3) 管理员新建两个普通账号');
    const made = await page.evaluate(async ([pa, pb]) => {
      const r1 = await Auth.addUser('membera', pa, 'user');
      const r2 = await Auth.addUser('memberb', pb, 'user');
      return [r1.ok, r1.error || '', r2.ok, r2.error || ''];
    }, [PW_A, PW_B]);
    check('membera 创建成功', made[0] === true, made[1]);
    check('memberb 创建成功', made[2] === true, made[3]);

    /* ========== 4. 普通账号 A：看不到管理员任何数据 ========== */
    console.log('\n4) 同一浏览器切换到普通账号 membera');
    await logoutAndWait(page);
    await loginAs(page, 'membera', PW_A);
    st = await page.evaluate(PROBE);
    check('数据键切到 ::membera', st.storeKey === LEGACY_KEY + '::membera', st.storeKey);
    check('身份是普通用户', st.role === 'user' && st.me === 'membera', st.role + '/' + st.me);
    check('【核心】看不到管理员的新闻', st.titles.indexOf('管理员专属新闻★') < 0, JSON.stringify(st.titles));
    check('【核心】DOM 里也没有管理员的新闻', st.adminNewsInDom === false);
    check('新账号从空数据开始（不是继承旧数据）', st.titles.length === 0, JSON.stringify(st.titles));
    check('设置也是自己的（默认分类，不是旧共享分类）',
      st.settingsCat.indexOf('旧共享分类') < 0 && st.settingsCat.length > 1, JSON.stringify(st.settingsCat));
    check('【核心】普通用户没有「🗄 本地数据」入口', st.hasLocalDataBtn === false);
    check('【核心】本地数据弹窗根本没渲染', st.hasLdModal === false);
    check('普通用户 can(data.clear) = false', st.canClear === false);
    check('【核心】普通用户继承不到管理员的云同步凭据', st.cloudToken === '', st.cloudToken);
    check('云同步凭据键也按账号隔离', st.cloudCredsKey === 'cloud-creds-v1::membera', st.cloudCredsKey);
    const rawLeak = await page.evaluate((k) => {
      const mine = localStorage.getItem(k) || '';
      return {
        mineLen: mine.length,
        mineHasAdmin: mine.indexOf('管理员专属新闻★') >= 0,
        mineHasLegacyCat: mine.indexOf('旧共享分类') >= 0
      };
    }, LEGACY_KEY + '::membera');
    check('【核心】membera 自己的存储里不含管理员数据', rawLeak.mineHasAdmin === false, JSON.stringify(rawLeak));
    check('membera 自己的存储里不含旧共享设置', rawLeak.mineHasLegacyCat === false, JSON.stringify(rawLeak));

    /* ========== 5. A 写入自己的数据 ========== */
    console.log('\n5) membera 写入自己的标记数据');
    const aTitles = await page.evaluate(addNews, '用户A专属新闻');
    check('membera 自己的数据里有这条', aTitles.indexOf('用户A专属新闻') >= 0, JSON.stringify(aTitles));
    st = await page.evaluate(PROBE);
    check('membera 只看到自己的这一条', st.titles.length === 1 && st.titles[0] === '用户A专属新闻', JSON.stringify(st.titles));
    check('membera 的新闻渲染进了 DOM', st.aNewsInDom === true);
    check('membera 依然看不到管理员的', st.adminNewsInDom === false);

    /* ========== 6. 普通账号 B：两人互相看不到 ========== */
    console.log('\n6) 切换到普通账号 memberb');
    await logoutAndWait(page);
    await loginAs(page, 'memberb', PW_B);
    st = await page.evaluate(PROBE);
    check('数据键切到 ::memberb', st.storeKey === LEGACY_KEY + '::memberb', st.storeKey);
    check('【核心】memberb 看不到 membera 的数据', st.titles.indexOf('用户A专属新闻') < 0, JSON.stringify(st.titles));
    check('【核心】DOM 里也没有 membera 的数据', st.aNewsInDom === false);
    check('【核心】memberb 也看不到管理员的', st.adminNewsInDom === false);
    check('memberb 同样从空数据开始', st.titles.length === 0, JSON.stringify(st.titles));
    check('memberb 也没有本地数据入口', st.hasLocalDataBtn === false);
    await page.evaluate(addNews, '用户B专属新闻');

    /* ========== 7. 回到 A：只看到自己的 ========== */
    console.log('\n7) 切回 membera → 数据还在、且只有自己的');
    await logoutAndWait(page);
    await loginAs(page, 'membera', PW_A);
    st = await page.evaluate(PROBE);
    check('membera 的数据被完整保留（刷新/重登后仍在）',
      st.titles.length === 1 && st.titles[0] === '用户A专属新闻', JSON.stringify(st.titles));
    check('membera 看不到 memberb 的', st.bNewsInDom === false && st.titles.indexOf('用户B专属新闻') < 0);
    check('membera 看不到管理员的', st.adminNewsInDom === false);

    /* ========== 8. 回到管理员：自己的数据完好 ========== */
    console.log('\n8) 切回管理员 → 自己的数据完好、看不到两个普通账号的');
    await logoutAndWait(page);
    await loginAs(page, 'admin', ADMIN_PW);
    st = await page.evaluate(PROBE);
    check('管理员数据完好（没被普通账号覆盖）',
      st.titles.indexOf('管理员专属新闻★') >= 0, JSON.stringify(st.titles));
    check('管理员看不到 membera 的数据', st.aNewsInDom === false && st.titles.indexOf('用户A专属新闻') < 0);
    check('管理员看不到 memberb 的数据', st.bNewsInDom === false && st.titles.indexOf('用户B专属新闻') < 0);
    check('管理员仍有本地数据入口', st.hasLocalDataBtn === true);
    check('管理员 can(data.clear) = true', st.canClear === true);

    /* ========== 9. 三个账号 = 三个独立存储键 ========== */
    console.log('\n9) 三个账号各占一个独立存储键');
    const keys = st.storeKeys.slice().sort();
    check('::admin / ::membera / ::memberb 三个键都在',
      keys.indexOf(LEGACY_KEY + '::admin') >= 0 &&
      keys.indexOf(LEGACY_KEY + '::membera') >= 0 &&
      keys.indexOf(LEGACY_KEY + '::memberb') >= 0, JSON.stringify(keys));
    check('三个键互不相同（共 3 个账号键 + 1 个旧键）',
      keys.length >= 4 && new Set(keys).size === keys.length, JSON.stringify(keys));
    check('旧键仍保留为备份', keys.indexOf(LEGACY_KEY) >= 0, JSON.stringify(keys));

    /* ========== 10. 云同步凭据：只有管理员能接管旧凭据 ========== */
    console.log('\n10) 云同步凭据的接管规则');
    const cloudRule = await page.evaluate(async () => {
      localStorage.setItem('cloud-creds-v1', JSON.stringify({ token: 'LEGACY_TOKEN' }));
      localStorage.removeItem('snt-cloud-creds-owner-v1');
      localStorage.removeItem('cloud-creds-v1::probeuser');
      localStorage.removeItem('cloud-creds-v1::probeadmin');
      // 普通账号不接管
      CloudSync.setAccount('probeuser');
      const asUser = CloudSync.adoptLegacyCreds('user');
      const userKeyEmpty = localStorage.getItem('cloud-creds-v1::probeuser') === null;
      // 管理员接管
      CloudSync.setAccount('probeadmin');
      const asAdmin = CloudSync.adoptLegacyCreds('admin');
      const got = JSON.parse(localStorage.getItem('cloud-creds-v1::probeadmin') || 'null');
      // 第二个管理员不再重复接管
      localStorage.removeItem('cloud-creds-v1::probeadmin2');
      CloudSync.setAccount('probeadmin2');
      const again = CloudSync.adoptLegacyCreds('admin');
      const secondEmpty = localStorage.getItem('cloud-creds-v1::probeadmin2') === null;
      // 收尾
      localStorage.removeItem('cloud-creds-v1');
      localStorage.removeItem('snt-cloud-creds-owner-v1');
      localStorage.removeItem('cloud-creds-v1::probeadmin');
      CloudSync.setAccount('admin');
      return { asUser: asUser, userKeyEmpty: userKeyEmpty, asAdmin: asAdmin, got: got, again: again, secondEmpty: secondEmpty };
    });
    check('普通账号不接管旧凭据', cloudRule.asUser === false && cloudRule.userKeyEmpty === true, JSON.stringify(cloudRule));
    check('管理员可以接管旧凭据', cloudRule.asAdmin === true && cloudRule.got && cloudRule.got.token === 'LEGACY_TOKEN',
      JSON.stringify(cloudRule.got));
    check('第二个管理员不会再次接管（避免互相继承）', cloudRule.again === false && cloudRule.secondEmpty === true);

    /* ========== 11. resolveKey 迁移规则的正反用例 ========== */
    console.log('\n11) 存储键迁移规则的边界用例');
    const mig = await page.evaluate(() => {
      const LEG = 'stock-news-tracker-v1';
      const OWN = 'snt-store-owner-v1';
      const out = {};
      // 造一份「还没被接管」的旧共享数据
      localStorage.setItem(LEG, JSON.stringify({ news: [{ title: '旧共享数据' }] }));
      localStorage.removeItem(OWN);
      localStorage.removeItem(LEG + '::probeuser');
      localStorage.removeItem(LEG + '::probeadmin');
      localStorage.removeItem(LEG + '::probeadmin2');

      out.userKey = Store.resolveKey('probeuser', 'user');
      out.legacyUntouched = (localStorage.getItem(LEG) || '').indexOf('旧共享数据') >= 0;
      out.userGotNothing = localStorage.getItem(LEG + '::probeuser') === null;
      out.ownerStillEmpty = (localStorage.getItem(OWN) || '') === '';

      out.adminKey = Store.resolveKey('probeadmin', 'admin');
      out.adminGotLegacy = (localStorage.getItem(LEG + '::probeadmin') || '').indexOf('旧共享数据') >= 0;
      out.ownerSet = localStorage.getItem(OWN) || '';

      out.admin2Key = Store.resolveKey('probeadmin2', 'admin');
      out.admin2Empty = localStorage.getItem(LEG + '::probeadmin2') === null;

      out.legacyInfo = Store.legacyInfo();

      // 当前账号正在用旧键时必须拒绝清理（防自删）
      const realKey = Store.STORAGE_KEY;
      Store.STORAGE_KEY = LEG;
      out.refuseWhenCurrent = Store.clearLegacy();
      Store.STORAGE_KEY = realKey;
      out.legacyStillThere = localStorage.getItem(LEG) !== null;
      // 恢复正常后可以清理
      out.cleared = Store.clearLegacy();
      out.legacyGone = localStorage.getItem(LEG) === null;

      return out;
    });
    check('普通账号拿不到旧数据（键为空）', mig.userKey === LEGACY_KEY + '::probeuser' && mig.userGotNothing === true, JSON.stringify(mig));
    check('普通账号不会消耗「接管权」，旧数据原封不动', mig.legacyUntouched === true && mig.ownerStillEmpty === true);
    check('管理员接管旧数据到自己的键', mig.adminKey === LEGACY_KEY + '::probeadmin' && mig.adminGotLegacy === true);
    check('接管后写入归属标记', mig.ownerSet === 'probeadmin', mig.ownerSet);
    check('第二个管理员不再继承同一份旧数据', mig.admin2Key === LEGACY_KEY + '::probeadmin2' && mig.admin2Empty === true);
    check('legacyInfo 如实反映归属', mig.legacyInfo && mig.legacyInfo.exists === true && mig.legacyInfo.owner === 'probeadmin',
      JSON.stringify(mig.legacyInfo));
    check('当前账号正在使用旧键时拒绝清理', mig.refuseWhenCurrent === false && mig.legacyStillThere === true);
    check('非当前键时可以清理旧数据', mig.cleared === true && mig.legacyGone === true);

    /* ========== 12. 物理隔离：每个存储键里只有自己的东西 ========== */
    console.log('\n12) 三个存储键的内容互不串门');
    const raw = await page.evaluate((k) => {
      const rd = (key) => localStorage.getItem(key) || '';
      const of = (suffix) => ({
        hasAdmin: rd(k + '::' + suffix).indexOf('管理员专属新闻★') >= 0,
        hasA: rd(k + '::' + suffix).indexOf('用户A专属新闻') >= 0,
        hasB: rd(k + '::' + suffix).indexOf('用户B专属新闻') >= 0
      });
      return { admin: of('admin'), a: of('membera'), b: of('memberb') };
    }, LEGACY_KEY);
    check('admin 键里只有自己的新闻', raw.admin.hasAdmin && !raw.admin.hasA && !raw.admin.hasB, JSON.stringify(raw.admin));
    check('membera 键里只有自己的新闻', raw.a.hasA && !raw.a.hasAdmin && !raw.a.hasB, JSON.stringify(raw.a));
    check('memberb 键里只有自己的新闻', raw.b.hasB && !raw.b.hasAdmin && !raw.b.hasA, JSON.stringify(raw.b));
    check('全程无 JS 报错', t.errors.length === 0, t.errors.slice(0, 3).join(' | '));

    /* ========== 13. 升级兼容：普通账号「自己的持仓」被认领回来 ========== */
    // 旧版本所有业务数据都是共用的，只有 holdings 是按用户名分开存的（D.holdings[username]），
    // 那一部分确实属于这个账号自己 —— 隔离上线时不能让它凭空消失。
    console.log('\n13) 升级兼容：普通账号自己的持仓从旧共享数据里认领');
    const t2 = await newCtx(browser, Object.assign({}, SEED, {
      holdings: { membera: [{ id: 'h1', code: 'sz000001', name: '平安银行', shares: 100 }] }
    }));
    const p2 = t2.page;
    await gotoApp(p2, A.port);
    // 管理员先登录：他会整份接管旧数据（含那份 holdings）
    await p2.evaluate(async (pw) => { await Auth.setup('boss', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
    await waitAppReady(p2);
    const addOk = await p2.evaluate(async (pw) => (await Auth.addUser('membera', pw, 'user')).ok, PW_A);
    check('管理员新建 membera 成功', addOk === true);
    // 退出 → membera 首次登录（此时他的命名空间是空的）
    await p2.evaluate(() => AuthUI.logout());
    await p2.waitForSelector('#auth-gate', { timeout: 60000 });
    await p2.waitForSelector('#auth-login-form:not([hidden])', { timeout: 30000 });
    const lr = await p2.evaluate(async (pw) => {
      const r = await Auth.login('membera', pw);
      if (r && r.ok) AuthUI.enterApp();
      return r || { ok: false };
    }, PW_A);
    check('membera 登录成功', lr.ok === true, lr.error);
    await waitAppReady(p2);
    const mig2 = await p2.evaluate(() => ({
      migrated: Store.migratedHoldings,
      holdings: (Store.data.holdings && Store.data.holdings.membera) || null,
      newsLen: (Store.data.news || []).length,
      key: Store.STORAGE_KEY,
      settingsCat: (Store.data.settings && Store.data.settings.categories) || []
    }));
    check('认领回自己的 1 条持仓', mig2.migrated === 1 && Array.isArray(mig2.holdings) && mig2.holdings.length === 1,
      JSON.stringify(mig2));
    check('认领的持仓内容正确', !!mig2.holdings && mig2.holdings[0].name === '平安银行',
      JSON.stringify(mig2.holdings));
    check('只认领持仓，新闻一概不继承', mig2.newsLen === 0, String(mig2.newsLen));
    check('设置也是自己的默认值，不是旧共享的', mig2.settingsCat.indexOf('旧共享分类') < 0, JSON.stringify(mig2.settingsCat));
    check('仍落在 membera 自己的键上', mig2.key === LEGACY_KEY + '::membera', mig2.key);
    check('第二个上下文无 JS 报错', t2.errors.length === 0, t2.errors.slice(0, 3).join(' | '));
    await t2.ctx.close();

    await t.ctx.close();
  } finally {
    await browser.close();
    A.srv.close();
  }

  console.log('\n============================================');
  console.log(`结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
  console.log('============================================');
  if (fail > 0) process.exit(1);
};

main().catch(e => { console.error('运行异常：', e); process.exit(1); });
