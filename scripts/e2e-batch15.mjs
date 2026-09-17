/* ============================================================
 * e2e-batch15.mjs — 真实浏览器验证 batch15 的三件事
 *
 * 用户诉求：
 *   1) 普通用户注册返回的申请码**不要带链接**，用户复制即可。
 *   2) 用户管理界面加「显示管理员密码」的按钮。
 *   3) 「全球信息 → 格隆汇每日快讯」：① 来源名（格隆汇）改成可改可写的下拉菜单；
 *      ② 在现有「题材归类」之外再加「概念分类」「行业分类」，
 *         全部消息按这两套维度全部分类，点分类展开。
 *
 * 本批改动：
 *   · auth-boot.js  buildRegMessage 去掉导入链接段（申请信息 = 用户名 + 时间 + 纯码）
 *   · index.html    注册完成页提示改文案；密码列「显示/复制」不再受 hasPassword 限制，
 *                   无明文时补一行说明；快讯标题里来源名改为下拉 + 自定义输入；
 *                   新增「题材归类 / 概念分类 / 行业分类」切换条
 *   · app.js        toggleRevealPassword 无明文时给说明并直接打开重置面板；
 *                   showToast 支持自定义时长；briefSourceName / briefDimMode（存 settings）
 *   · hot-topics.js 新增概念 20 类 / 行业 30 类词典，briefStats(items, mode) 支持三套维度，
 *                   cleanBriefText 前缀剥离不再写死「格隆汇」
 *   · store.js      settings.briefSource / settings.briefDimMode 默认值
 *
 * 覆盖：
 *   场景 1  注册完成页：剪贴板内容无 http / 无 #admin-import，只有用户名 + 时间 + 申请码；
 *          「只复制申请码」拿到的是纯码；页面提示里也不再出现「链接」说法
 *   场景 2  用户管理：有明文的账号点「显示」出真密码；无明文（改造前/导入）的账号
 *          也**有**「显示」按钮，点了给出说明并直接展开该行重置面板
 *   场景 3  快讯来源名：下拉选预设 → 标题与「点标题跳 X 原文」跟着变、刷新后保留；
 *          选「自定义…」自己写也生效；cleanBriefText 对任意来源名都剥前缀
 *   场景 4  概念分类 / 行业分类：切换条存在、分类数正确、真实命中（电池储能/银行…）、
 *          点分类展开出该类消息、切换维度后展开项收起、刷新后维度保留
 *
 * 快讯数据用 page.route 伪造（4 条带明确特征词的快讯），断言不依赖线上快照。
 * 用法：node scripts/e2e-batch15.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADMIN_PW = 'Admin@2026';
const REG_PW = 'Reg@2026pass';

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

/* 伪造的当日快讯：每条都带明确特征词，便于断言三套维度的命中 */
const FAKE_BRIEFS = {
  date: '2026-09-17', source: 'gelonghui', sourceName: '格隆汇',
  generatedAt: '2026-09-17 21:00', total: 4,
  items: [
    { id: 90001, time: '2026-09-17 09:00', url: 'https://example.com/1',
      text: '格隆汇9月17日｜固态电池量产线正式投产，储能订单大幅增长', stocks: [], subjects: [] },
    { id: 90002, time: '2026-09-17 09:30', url: 'https://example.com/2',
      text: '格隆汇9月17日｜央行宣布降准，银行存款成本下行、信贷投放增加', stocks: [], subjects: [] },
    { id: 90003, time: '2026-09-17 10:00', url: 'https://example.com/3',
      text: '格隆汇9月17日｜英伟达发布新一代AI芯片，算力大幅提升', stocks: [], subjects: [] },
    { id: 90004, time: '2026-09-17 10:30', url: 'https://example.com/4',
      text: '格隆汇9月17日｜某券商资管子公司获批设立，保险资金入市', stocks: [], subjects: [] }
  ]
};

async function newCtx(browser, opts) {
  const o = opts || {};
  const ctx = await browser.newContext({
    viewport: { width: 1560, height: 1000 },
    ...(o.permissions ? { permissions: o.permissions } : {})
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|vore\.top|ip\.sb|ipapi|unpkg\.com/.test(u.href),
    r => r.abort());
  if (o.fakeBriefs) {
    await page.route(u => /briefs-[^/]*\.json/.test(u.href), r =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_BRIEFS) }));
  }
  await page.addInitScript(() => {
    window.__toasts = [];
    const grab = () => {
      document.querySelectorAll('.toast').forEach(el => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && window.__toasts[window.__toasts.length - 1] !== t) window.__toasts.push(t);
      });
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(grab).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  });
  return { ctx, page, errors };
}

async function hardGoto(page, url, hash) {
  await page.goto(url + (hash || ''), { waitUntil: 'load', timeout: 40000 });
  await page.reload({ waitUntil: 'load', timeout: 40000 });
}
/** ⚠️ #auth-gate 是静态节点，Auth/AuthUI 要等脚本执行完才有——必须两个都等 */
async function waitAuthReady(page) {
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForFunction(() => typeof window.Auth !== 'undefined' && typeof window.AuthUI !== 'undefined',
    null, { timeout: 60000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), { timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, { timeout: 60000 });
}
async function bootAdmin(page, port) {
  await hardGoto(page, `http://127.0.0.1:${port}/`);
  await waitAuthReady(page);
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}
async function loginAdmin(page, port) {
  await hardGoto(page, `http://127.0.0.1:${port}/`);
  await waitAuthReady(page);
  await page.evaluate(async (pw) => { await Auth.login('admin', pw, true); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}

/** 找用户管理表格里某个账号所在行 */
async function umRow(page, username) {
  const idx = await page.evaluate((u) => {
    const rows = [...document.querySelectorAll('.modal-um tbody tr')];
    return rows.findIndex(r => {
      const n = r.querySelector('.um-name');
      return n && n.textContent.trim().toLowerCase() === u.toLowerCase();
    });
  }, username);
  return page.locator('.modal-um tbody tr').nth(idx);
}

/** 某个分类当前显示的条数（-1 = 没找到这个分类） */
async function catCount(page, name) {
  return await page.evaluate((n) => {
    const els = [...document.querySelectorAll('.brief-cat')];
    const el = els.find(e => (e.querySelector('.bc-name') || {}).textContent?.trim() === n);
    if (!el) return -1;
    const c = el.querySelector('.bc-count');
    return c ? parseInt(c.textContent.trim(), 10) : -1;
  }, name);
}
async function clickCat(page, name) {
  await page.evaluate((n) => {
    const els = [...document.querySelectorAll('.brief-cat')];
    const el = els.find(e => (e.querySelector('.bc-name') || {}).textContent?.trim() === n);
    if (el) el.querySelector('.brief-cat-head').click();
  }, name);
  await page.waitForTimeout(250);
}

/** 读快讯面板标题的"渲染态"：去掉下拉框里的全部 option 文本，只留 📰 + 源名 + 每日快讯 的静态骨架 */
async function briefTitleState(page) {
  return await page.evaluate(() => {
    const h = document.querySelector('.brief-head .panel-title');
    if (!h) return { static: '', selVal: '', inputVal: '' };
    const clone = h.cloneNode(true);
    const sel = clone.querySelector('.brief-source');
    const input = clone.querySelector('.brief-source-input');
    if (sel) sel.remove();
    if (input) input.remove();
    const staticText = clone.textContent.replace(/\s+/g, ' ').trim();
    const realSel = h.querySelector('.brief-source');
    const realInput = h.querySelector('.brief-source-input');
    return {
      static: staticText,
      selVal: realSel ? realSel.value : '',
      inputVal: realInput ? realInput.value : ''
    };
  });
}

(async () => {
  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  console.log(`本地静态服务 127.0.0.1:${port}\n`);

  try {
    /* ========== 场景 1：注册申请码不带链接 ========== */
    console.log('1) 注册完成页：申请码纯文本，复制即可（无链接）');
    {
      const { ctx, page, errors } = await newCtx(browser, { permissions: ['clipboard-read', 'clipboard-write'] });
      await hardGoto(page, `http://127.0.0.1:${port}/`);
      await waitAuthReady(page);
      await page.waitForSelector('#auth-register-form:not([hidden])', { timeout: 20000 });
      await page.fill('#reg-username', 'newbie15');
      await page.fill('#reg-password', REG_PW);
      await page.fill('#reg-confirm', REG_PW);
      await page.click('#auth-register-form button[type=submit]');
      await page.waitForSelector('#auth-reg-done:not([hidden])', { timeout: 45000 });

      const code = (await page.inputValue('#reg-code')).trim();
      check('已生成申请码（SNTREG1. 前缀）', /^SNTREG1\.[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(code), code.slice(0, 40));

      await page.click('#auth-reg-send');
      await page.waitForTimeout(400);
      let clip = '';
      try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = ''; }
      check('点「复制申请信息」后剪贴板有内容', clip.length > 0, clip.slice(0, 40));
      check('🔴 复制的申请信息不含 http(s) 链接', !/https?:\/\//i.test(clip), clip.slice(-70));
      check('🔴 复制的申请信息不含 #admin-import', !/admin-import/i.test(clip), clip.slice(-70));
      check('复制的申请信息含用户名', clip.includes('newbie15'), clip.slice(0, 60));
      check('复制的申请信息含完整申请码', code.length > 0 && clip.includes(code));

      await page.click('#auth-reg-copy');
      await page.waitForTimeout(300);
      let clip2 = '';
      try { clip2 = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip2 = ''; }
      check('「只复制申请码」拿到的是纯码（等于页面上的码）', clip2.trim() === code, clip2.slice(0, 40));
      check('纯码里也没有链接', !/https?:|admin-import/i.test(clip2));

      const tips = (await page.locator('#auth-reg-done .auth-tip').allTextContents()).join(' ');
      check('完成页提示不再说「带了一个链接」', !/带了一个链接|点开下面的链接/.test(tips), tips.slice(0, 80));
      check('完成页仍提示要主动把码发给管理员', /发给管理员|发回给你/.test(tips));
      check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
      await ctx.close();
    }

    /* ========== 场景 2：用户管理里显示管理员密码 ========== */
    console.log('\n2) 用户管理：管理员密码「显示」按钮（有明文 / 无明文两种）');
    {
      const { ctx, page, errors } = await newCtx(browser, {});
      await bootAdmin(page, port);

      await page.locator('.user-chip').click();
      await page.locator('.user-dd-item:has-text("用户管理")').click();
      await page.waitForSelector('.modal-um', { timeout: 15000 });

      const adminRow = await umRow(page, 'admin');
      check('管理员自己这行在列表里', await adminRow.count() === 1);
      check('管理员行有「显示」按钮',
        (await adminRow.locator('.um-pw button:has-text("显示")').count()) === 1);
      check('管理员行的密码默认是打码的',
        /•+/.test((await adminRow.locator('.um-pw-text').textContent()) || ''),
        await adminRow.locator('.um-pw-text').textContent());

      await adminRow.locator('.um-pw button:has-text("显示")').click();
      await page.waitForTimeout(250);
      const shown = (await adminRow.locator('.um-pw-text').textContent() || '').trim();
      check('点「显示」后出现真实密码（等于注册时设的密码）', shown === ADMIN_PW, shown);
      await adminRow.locator('.um-pw button:has-text("隐藏")').click();
      await page.waitForTimeout(200);
      check('再点「隐藏」恢复打码',
        /•+/.test((await adminRow.locator('.um-pw-text').textContent()) || ''));
      await ctx.close();
    }
    {
      // 无明文的账号（改造前创建 / 账号表导入，没有 pwSeal）——按钮也要在，点了给说法 + 开重置面板
      const { ctx, page, errors } = await newCtx(browser, {});
      await bootAdmin(page, port);
      const r = await page.evaluate(() => {
        const KEY = 'snt-auth-users-v1';
        const raw = localStorage.getItem(KEY);
        if (!raw) return 'no-key';
        const data = JSON.parse(raw);
        let hit = false;
        const walk = (o) => {
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (o && typeof o === 'object') {
            if (typeof o.username === 'string' && o.username.toLowerCase() === 'admin' && 'pwSeal' in o) {
              o.pwSeal = ''; hit = true; return;
            }
            Object.values(o).forEach(v => { if (v && typeof v === 'object') walk(v); });
          }
        };
        walk(data);
        localStorage.setItem(KEY, JSON.stringify(data));
        return hit ? 'ok' : 'not-found';
      });
      check('已把管理员账号改成「无保存明文」状态（模拟改造前创建的账号）', r === 'ok', r);

      await loginAdmin(page, port);
      await page.locator('.user-chip').click();
      await page.locator('.user-dd-item:has-text("用户管理")').click();
      await page.waitForSelector('.modal-um', { timeout: 15000 });

      const adminRow = await umRow(page, 'admin');
      check('🔴 无明文的管理员行**仍然有**「显示」按钮（原来是没有的）',
        (await adminRow.locator('.um-pw button:has-text("显示")').count()) === 1);
      check('无明文时密码列显示「未保存」',
        /未保存/.test((await adminRow.locator('.um-pw-text').textContent()) || ''),
        await adminRow.locator('.um-pw-text').textContent());
      check('无明文时密码列下方有说明文字',
        (await adminRow.locator('.um-pw-note').count()) === 1);

      await adminRow.locator('.um-pw button:has-text("显示")').click();
      await page.waitForTimeout(400);
      const toasts = await page.evaluate(() => window.__toasts || []);
      check('点「显示」给出说明（提「重置密码」）',
        toasts.some(t => /重置密码/.test(t)), JSON.stringify(toasts.slice(-2)));
      check('点「显示」后直接展开了该行的重置密码面板',
        (await page.locator('.um-resetrow').count()) === 1);
      const headTxt = (await page.locator('.um-reset-head').innerText().catch(() => '')) || '';
      check('重置面板指向的就是 admin 这个账号', /admin/.test(headTxt), headTxt.replace(/\s+/g, ' ').slice(0, 60));
      check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
      await ctx.close();
    }

    /* ========== 场景 3：快讯来源名可改（下拉 + 自定义） ========== */
    console.log('\n3) 快讯来源名：下拉选预设 / 自定义输入，标题与原文文案跟着变');
    {
      const { ctx, page, errors } = await newCtx(browser, { fakeBriefs: true });
      await bootAdmin(page, port);
      await page.locator('a.nav-item:has-text("全球信息")').click();
      await page.waitForSelector('.brief-cats', { timeout: 20000 });
      await page.waitForTimeout(400);

      check('标题里是下拉菜单（不再写死「格隆汇」）',
        (await page.locator('.brief-head .brief-source').count()) === 1);
      check('下拉当前值是「格隆汇」',
        (await page.locator('.brief-source').inputValue()) === '格隆汇');
      const t1 = await briefTitleState(page);
      check('标题骨架 = 📰 … 每日快讯（前缀📰、后缀每日快讯）',
        t1.static.startsWith('📰') && t1.static.endsWith('每日快讯'), JSON.stringify(t1));
      check('标题里的来源名（下拉当前值）是「格隆汇」', t1.selVal === '格隆汇', JSON.stringify(t1));

      await page.selectOption('.brief-source', '今日头条');
      await page.waitForTimeout(350);
      const t2 = await briefTitleState(page);
      check('选「今日头条」后标题里的来源名（下拉当前值）变成「今日头条」',
        t2.selVal === '今日头条', JSON.stringify(t2));
      check('选「今日头条」后标题骨架仍是 📰 … 每日快讯',
        t2.static.startsWith('📰') && t2.static.endsWith('每日快讯'), JSON.stringify(t2));
      check('来源名已写入设置', (await page.evaluate(() => Store.data.settings.briefSource)) === '今日头条');
      check('有「已改为」的提示 toast',
        (await page.evaluate(() => window.__toasts || [])).some(t => /已改为/.test(t)));

      await clickCat(page, '国家政策类');
      check('展开后「点标题跳X原文」里的来源名也跟着变',
        /点标题跳今日头条原文/.test((await page.locator('.brief-news-head').first().innerText()).replace(/\s+/g, ' ')),
        (await page.locator('.brief-news-head').first().innerText()).replace(/\s+/g, ' '));

      // 前缀剥离：显示出来的正文不含「格隆汇9月17日｜」
      const firstText = (await page.locator('.brief-item .brief-text').first().innerText()) || '';
      check('正文已剥掉「来源名+月日｜」前缀', !/9月17日[｜|丨]/.test(firstText), firstText.slice(0, 40));
      check('正文保留了真实内容', /固态电池|央行|英伟达|券商/.test(firstText), firstText.slice(0, 40));

      // 刷新后仍保留
      await hardGoto(page, `http://127.0.0.1:${port}/`);
      await waitAuthReady(page);
      await page.evaluate(async (pw) => { await Auth.login('admin', pw, true); }, ADMIN_PW);
      await page.evaluate(() => AuthUI.enterApp());
      await waitAppReady(page);
      await page.locator('a.nav-item:has-text("全球信息")').click();
      await page.waitForSelector('.brief-cats', { timeout: 20000 });
      check('刷新后来源名仍是「今日头条」',
        (await page.locator('.brief-source').inputValue()) === '今日头条');

      // 自定义
      await page.selectOption('.brief-source', '__custom__');
      await page.waitForTimeout(300);
      check('选「自定义…」后出现输入框', (await page.locator('.brief-source-input').count()) === 1);
      await page.fill('.brief-source-input', '我的快讯源');
      await page.press('.brief-source-input', 'Enter');
      await page.waitForTimeout(350);
      const t3 = await briefTitleState(page);
      check('自定义来源名（输入框）生效', t3.inputVal === '我的快讯源', JSON.stringify(t3));
      check('自定义后标题骨架仍是 📰 … 每日快讯',
        t3.static.startsWith('📰') && t3.static.endsWith('每日快讯'), JSON.stringify(t3));
      check('自定义名已写入设置', (await page.evaluate(() => Store.data.settings.briefSource)) === '我的快讯源');
      check('cleanBriefText 对任意来源名都剥前缀', await page.evaluate(() => {
        if (typeof HotTopics === 'undefined') return false;
        return HotTopics.cleanBriefText('我的快讯源9月17日｜测试内容') === '测试内容'
          && HotTopics.cleanBriefText('格隆汇9月17日｜测试内容') === '测试内容';
      }));
      check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
      await ctx.close();
    }

    /* ========== 场景 4：概念分类 / 行业分类 ========== */
    console.log('\n4) 概念分类 / 行业分类：全部消息按维度分类，点分类展开');
    {
      const { ctx, page, errors } = await newCtx(browser, { fakeBriefs: true });
      await bootAdmin(page, port);
      await page.locator('a.nav-item:has-text("全球信息")').click();
      await page.waitForSelector('.brief-cats', { timeout: 20000 });
      await page.waitForTimeout(400);

      check('有三档切换条（题材归类 / 概念分类 / 行业分类）',
        (await page.locator('.brief-dim-seg .bd-seg').count()) === 3);
      const segNames = (await page.locator('.bd-seg').allTextContents()).map(s => s.trim());
      check('三档名称正确', JSON.stringify(segNames) === JSON.stringify(['题材归类', '概念分类', '行业分类']), JSON.stringify(segNames));
      check('默认停在「题材归类」',
        (await page.locator('.bd-seg.active').innerText()).trim() === '题材归类');

      const nTheme = await page.locator('.brief-cat').count();
      const expTheme = await page.evaluate(() => HotTopics.BRIEF_MODES[0].dims.length);
      check('题材归类分类数与词典一致', nTheme === expTheme, `${nTheme} vs ${expTheme}`);
      check('题材维度命中：国家政策类 ≥1（央行降准那条）', (await catCount(page, '国家政策类')) >= 1, await catCount(page, '国家政策类'));
      check('提示文案写着当前维度', /题材归类/.test(await page.locator('.brief-tip').first().innerText().catch(() => '')),
        await page.locator('.brief-tip').first().innerText().catch(() => ''));

      // 切到概念分类
      await page.locator('.bd-seg:has-text("概念分类")').click();
      await page.waitForTimeout(400);
      check('切换后高亮在「概念分类」', (await page.locator('.bd-seg.active').innerText()).trim() === '概念分类');
      const nConcept = await page.locator('.brief-cat').count();
      const expConcept = await page.evaluate(() => HotTopics.BRIEF_MODES[1].dims.length);
      check('概念分类数与词典一致（20 类）', nConcept === expConcept, `${nConcept} vs ${expConcept}`);
      check('概念维度命中：电池储能 ≥1（固态电池/储能那条）', (await catCount(page, '电池储能')) >= 1, await catCount(page, '电池储能'));
      check('概念维度命中：人工智能 ≥1（AI/算力那条）', (await catCount(page, '人工智能')) >= 1, await catCount(page, '人工智能'));
      check('概念维度命中：非银金融不在概念里（那是行业）', (await catCount(page, '非银金融')) === -1);
      check('切换维度后已展开的分类收起', (await page.locator('.brief-news').count()) === 0);
      check('提示文案跟着换成「概念分类」', /概念分类/.test(await page.locator('.brief-tip').first().innerText().catch(() => '')));

      // 点分类展开
      await clickCat(page, '电池储能');
      check('点「电池储能」展开出该类消息', (await page.locator('.brief-news').count()) >= 1);
      const newsTxt = (await page.locator('.brief-news').first().innerText()) || '';
      check('展开的消息确实是固态电池那条', /固态电池/.test(newsTxt), newsTxt.replace(/\s+/g, ' ').slice(0, 60));

      // 切到行业分类
      await page.locator('.bd-seg:has-text("行业分类")').click();
      await page.waitForTimeout(400);
      const nInd = await page.locator('.brief-cat').count();
      const expInd = await page.evaluate(() => HotTopics.BRIEF_MODES[2].dims.length);
      check('行业分类数与词典一致（30 类）', nInd === expInd, `${nInd} vs ${expInd}`);
      check('行业维度命中：银行 ≥1（银行存款/信贷那条）', (await catCount(page, '银行')) >= 1, await catCount(page, '银行'));
      check('行业维度命中：非银金融 ≥1（券商资管那条）', (await catCount(page, '非银金融')) >= 1, await catCount(page, '非银金融'));
      check('行业维度命中：电力设备 ≥1（电池储能那条）', (await catCount(page, '电力设备')) >= 1, await catCount(page, '电力设备'));
      await clickCat(page, '非银金融');
      const indTxt = (await page.locator('.brief-news').first().innerText()) || '';
      check('展开行业分类后消息内容正确', /券商|资管|保险/.test(indTxt), indTxt.replace(/\s+/g, ' ').slice(0, 60));
      check('维度已写入设置', (await page.evaluate(() => Store.data.settings.briefDimMode)) === 'industry');

      // 刷新后维度保留
      await hardGoto(page, `http://127.0.0.1:${port}/`);
      await waitAuthReady(page);
      await page.evaluate(async (pw) => { await Auth.login('admin', pw, true); }, ADMIN_PW);
      await page.evaluate(() => AuthUI.enterApp());
      await waitAppReady(page);
      await page.locator('a.nav-item:has-text("全球信息")').click();
      await page.waitForSelector('.brief-cats', { timeout: 20000 });
      await page.waitForTimeout(300);
      check('刷新后仍停在「行业分类」', (await page.locator('.bd-seg.active').innerText()).trim() === '行业分类');
      check('无 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
      await ctx.close();
    }
  } catch (e) {
    fail++;
    console.log('\nE2E 异常：', e && e.stack ? e.stack : e);
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
