/* ============================================================
 * e2e-holdings.mjs — 「用户」页面 + 新闻表「用户」归属列 真实浏览器端到端验证
 *
 * 覆盖本轮需求：
 *   1) 导航出现「用户」页，空态正确
 *   2) 会员服务弹窗：展示一年期/6 个月期价格 + 微信支付二维码
 *   3) 添加持仓：建仓日期 / 数量 / 建仓价 / 现价 → 自动算出 天数 / 持仓涨跌幅 / 市值 / 盈亏(元) / 盈亏比例
 *   4) 编辑持仓后重算
 *   5) 刷新现价（走腾讯行情接口）→ 重算盈亏
 *   6) 新闻追踪表最左侧出现「用户」归属列，新增新闻归属当前登录用户
 *   7) 与「暂停数据刷新」约定兼容：进入持仓页不自动发行情请求
 *
 * 股票搜索（smartbox.gtimg.cn）与实时行情（qt.gtimg.cn）一律用 route 伪造，
 * 保证断言确定、不依赖外网。
 * 用法：node scripts/e2e-holdings.mjs
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
const LIVE = process.env.LIVE === '1';
const LIVE_URL = 'https://xinwenfuwu.github.io/stock-news-tracker/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
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

let _shared = null;
async function newPage(browser) {
  if (LIVE) {
    // 线上：复用同一个浏览器上下文（共享 CDN 缓存，避免反复整包下载被 Pages 限流），
    // 每个场景之间清空 localStorage 并重新加载到登录态。
    if (!_shared) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = [];
      const counts = { qt: 0, smartbox: 0 };
      page.on('pageerror', e => errors.push(e.message));
      if (fs.existsSync(VUE_LOCAL)) {
        await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
      }
      await page.route('**/smartbox.gtimg.cn/**', r => {
        counts.smartbox++;
        r.fulfill({ contentType: 'application/javascript', body: 'v_hint="sh~600519~贵州茅台~moutai~GP-A";' });
      });
      await page.route('**/qt.gtimg.cn/**', r => {
        counts.qt++;
        const fields = new Array(33).fill('');
        fields[0] = 'sh'; fields[1] = '贵州茅台'; fields[2] = 'sh600519';
        fields[3] = '1300.00'; fields[4] = '1690.00'; fields[32] = '0.65';
        r.fulfill({ contentType: 'application/javascript', body: `v_sh600519="${fields.join('~')}";` });
      });
      _shared = { ctx, page, errors, counts };
    } else {
      await _shared.page.evaluate(() => localStorage.clear());
      await _shared.page.goto(LIVE_URL, { waitUntil: 'load' });
    }
    return _shared;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const counts = { qt: 0, smartbox: 0 };
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 股票联想（smartbox.gtimg.cn）伪造：返回 贵州茅台 sh600519
  await page.route('**/smartbox.gtimg.cn/**', r => {
    counts.smartbox++;
    r.fulfill({ contentType: 'application/javascript', body: 'v_hint="sh~600519~贵州茅台~moutai~GP-A";' });
  });
  // 实时行情（qt.gtimg.cn）伪造：sh600519 现价 1300.00
  await page.route('**/qt.gtimg.cn/**', r => {
    counts.qt++;
    const fields = new Array(33).fill('');
    fields[0] = 'sh'; fields[1] = '贵州茅台'; fields[2] = 'sh600519';
    fields[3] = '1300.00'; fields[4] = '1690.00'; fields[32] = '0.65';
    r.fulfill({ contentType: 'application/javascript', body: `v_sh600519="${fields.join('~')}";` });
  });
  return { ctx, page, errors, counts };
}

function baseUrl(port) {
  return LIVE ? LIVE_URL : `http://127.0.0.1:${port}/`;
}
async function gotoApp(page, port, hash) {
  await page.goto(baseUrl(port) + (hash || ''), { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
}
async function waitAppReady(page) {
  // 线上 GitHub Pages CDN 偶发较慢，超时放宽到 90s（本地通常 1~2s）
  const t = LIVE ? 90000 : 45000;
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: t });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    return !!(el && el.__vue_app__);
  }, null, { timeout: t });
}
async function loginFresh(page, pw = ADMIN_PW) {
  await page.evaluate(async (p) => {
    await Auth.setup('admin', p, p);
    AuthUI.enterApp();
  }, pw);
  await waitAppReady(page);
}

async function setHoldingStock(page, kw) {
  await page.fill('.holding-modal .stock-search-wrap input', kw);
  await page.waitForSelector('.holding-modal .suggestion', { timeout: 10000 });
  await page.click('.holding-modal .suggestion');
  await page.waitForFunction(() => {
    const el = document.querySelector('.holding-modal .muted.small');
    return el && el.textContent.includes('已选');
  }, null, { timeout: 10000 });
}

const main = async () => {
  const A = LIVE ? { port: 0 } : await serveStatic(ROOT);
  const browser = await chromium.launch();

  // ---------------- 1 ----------------
  console.log('1) 持仓页入口与空态');
  {
    const { ctx, page, errors, counts } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    // 进入持仓页：断言进入时不自动发行情请求（暂停约定兼容）
    const before = counts.qt;
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    await page.waitForTimeout(300);
    check('进入持仓页不自动发行情请求（兼容暂停约定）', counts.qt === before, 'qt=' + counts.qt);
    check('空态提示出现', (await page.locator('.holding-table .empty-row').innerText()).includes('暂无持仓'));
    check('汇总卡在空态不显示', (await page.locator('.hold-summary').count()) === 0);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 2 ----------------
  console.log('\n2) 添加持仓 + 自动计算（建仓价1000/现价1100/100股）');
  let rowCells;
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    await page.click('button:has-text("添加持仓")');
    await page.waitForSelector('.holding-modal', { timeout: 10000 });
    await setHoldingStock(page, '600519');
    await page.fill('input[placeholder="建仓成本单价"]', '1000');
    await page.fill('input[placeholder="留空默认等于建仓价"]', '1100');
    await page.fill('input[placeholder="持仓股数"]', '100');
    await page.click('.holding-modal .modal-actions .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('.holding-table tbody tr').length === 1, null, { timeout: 15000 });

    rowCells = await page.locator('.holding-table tbody tr').first().locator('td').allInnerTexts();
    // 列序：0股票 1建仓日期 2建仓价 3现价 4数量 5天数 6涨跌幅 7市值 8盈亏元 9盈亏比例 10方向
    check('股票名为贵州茅台', /贵州茅台/.test(rowCells[0]), JSON.stringify(rowCells));
    check('建仓价=1000.00', rowCells[2].includes('1000.00'), rowCells[2]);
    check('现价=1100.00', rowCells[3].includes('1100.00'), rowCells[3]);
    check('数量=100.00', rowCells[4].includes('100.00'), rowCells[4]);
    check('天数=0（建仓日为今天）', rowCells[5].trim() === '0', rowCells[5]);
    check('持仓涨跌幅=+10.00%', rowCells[6].includes('+10.00%'), rowCells[6]);
    check('市值=110000.00', rowCells[7].includes('110000.00'), rowCells[7]);
    check('盈亏(元)=+10000.00', rowCells[8].includes('+10000.00'), rowCells[8]);
    check('盈亏比例=+10.00%', rowCells[9].includes('+10.00%'), rowCells[9]);
    check('方向=多', rowCells[10].includes('多'), rowCells[10]);

    // 汇总卡
    const sum = await page.locator('.hold-summary').innerText();
    check('汇总：持仓数 1', /1/.test(sum) && /只/.test(sum), sum);
    check('汇总：总市值 110000', sum.includes('110000'), sum);
    check('汇总：总盈亏 +10000', sum.includes('+10000'), sum);
    check('汇总：总盈亏比例 +10.00%', sum.includes('+10.00%'), sum);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 3 ----------------
  console.log('\n3) 编辑持仓后重算（现价改 1200 → 盈亏 +20000 / +20%）');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    await page.click('button:has-text("添加持仓")');
    await page.waitForSelector('.holding-modal', { timeout: 10000 });
    await setHoldingStock(page, '600519');
    await page.fill('input[placeholder="建仓成本单价"]', '1000');
    await page.fill('input[placeholder="持仓股数"]', '100');
    await page.click('.holding-modal .modal-actions .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('.holding-table tbody tr').length === 1, null, { timeout: 15000 });

    // 编辑：把现价设为 1200
    await page.locator('.holding-table tbody tr .btn-icon-sm[title="编辑"]').click();
    await page.waitForSelector('.holding-modal', { timeout: 10000 });
    await page.fill('input[placeholder="留空默认等于建仓价"]', '1200');
    await page.click('.holding-modal .modal-actions .btn-primary');
    await page.waitForFunction(() => {
      const t = document.querySelector('.holding-table tbody tr td:nth-child(9)');
      return t && t.textContent.includes('+20000');
    }, null, { timeout: 15000 });
    const c = await page.locator('.holding-table tbody tr').first().locator('td').allInnerTexts();
    check('编辑后盈亏(元)=+20000.00', c[8].includes('+20000.00'), c[8]);
    check('编辑后盈亏比例=+20.00%', c[9].includes('+20.00%'), c[9]);
    check('编辑后现价=1200.00', c[3].includes('1200.00'), c[3]);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 4 ----------------
  console.log('\n4) 刷新现价（走腾讯行情接口，伪造 1300）→ 重算');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    await page.click('button:has-text("添加持仓")');
    await page.waitForSelector('.holding-modal', { timeout: 10000 });
    await setHoldingStock(page, '600519');
    await page.fill('input[placeholder="建仓成本单价"]', '1000');
    await page.fill('input[placeholder="持仓股数"]', '100');
    await page.click('.holding-modal .modal-actions .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('.holding-table tbody tr').length === 1, null, { timeout: 15000 });

    await page.click('button:has-text("刷新现价")');
    await page.waitForFunction(() => {
      const t = document.querySelector('.holding-table tbody tr td:nth-child(4)');
      return t && t.textContent.includes('1300.00');
    }, null, { timeout: 20000 });
    const c = await page.locator('.holding-table tbody tr').first().locator('td').allInnerTexts();
    check('刷新后现价=1300.00', c[3].includes('1300.00'), c[3]);
    check('刷新后盈亏(元)=+30000.00', c[8].includes('+30000.00'), c[8]);
    check('刷新后持仓涨跌幅=+30.00%', c[6].includes('+30.00%'), c[6]);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 5 ----------------
  console.log('\n5) 新闻追踪表出现「用户」归属列，新增新闻归属当前用户');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("新闻追踪")');
    await page.waitForSelector('.news-table', { timeout: 15000 });
    check('新闻表有「用户」列头', (await page.locator('.news-table th.col-owner').innerText()).includes('用户'));

    await page.click('button:has-text("手动添加")');
    await page.waitForSelector('.modal-overlay:has-text("添加新闻")', { timeout: 10000 });
    await page.fill('textarea[placeholder="输入或粘贴新闻内容"]', '持仓功能联调测试新闻');
    await page.click('.modal-overlay:has-text("添加新闻") .btn-primary');
    await page.waitForSelector('.news-table tbody tr:has-text("持仓功能联调测试新闻")', { timeout: 15000 });

    const owner = await page.locator('.news-table tbody tr:has-text("持仓功能联调测试新闻")').first().locator('td.col-owner').innerText();
    check('新增新闻归属当前用户 admin', owner.trim() === 'admin', JSON.stringify(owner));
    // 数据落盘：Store 中该条新闻 owner 为 admin
    const stored = await page.evaluate(() => {
      const n = Store.data.news[0];
      return { owner: n && n.owner, has: !!n };
    });
    check('Store 中新闻记录 owner=admin', stored.has && stored.owner === 'admin', JSON.stringify(stored));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 6 ----------------
  console.log('\n6) 会员服务弹窗：价格说明 + 微信支付二维码');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    // 会员服务按钮在添加持仓左侧
    const vipBtn = page.locator('button:has-text("会员服务")');
    check('「会员服务」按钮存在', await vipBtn.count() === 1);
    const addBtn = page.locator('button:has-text("添加持仓")');
    const vipBox = await vipBtn.boundingBox();
    const addBox = await addBtn.boundingBox();
    check('「会员服务」按钮在「添加持仓」左侧', !!vipBox && !!addBox && vipBox.x < addBox.x, `vip x=${vipBox?.x} add x=${addBox?.x}`);
    await vipBtn.click();
    await page.waitForSelector('.membership-modal', { timeout: 10000 });
    const modalText = await page.locator('.membership-modal').innerText();
    check('弹窗显示「一年期会员」', modalText.includes('一年期会员'));
    check('弹窗显示「6 个月期会员」', modalText.includes('6 个月期会员'));
    check('弹窗显示一年期价格 ¥2000', modalText.includes('¥2000'));
    check('弹窗显示 6 个月期价格 ¥1000', modalText.includes('¥1000'));
    check('弹窗显示微信支付二维码图片', await page.locator('.membership-modal .qr-pay-img').count() === 1);
    const qrSrc = await page.locator('.membership-modal .qr-pay-img').getAttribute('src');
    check('二维码地址指向 assets/qr-pay-wechat.jpg', qrSrc && qrSrc.includes('assets/qr-pay-wechat.jpg'), qrSrc);
    await page.click('.membership-modal .modal-actions .btn');
    await page.waitForFunction(() => document.querySelectorAll('.membership-modal').length === 0, null, { timeout: 10000 });
    check('点击关闭后弹窗消失', await page.locator('.membership-modal').count() === 0);
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  // ---------------- 7 ----------------
  console.log('\n7) 持仓按用户名隔离（admin 的持仓不串到别的键）');
  {
    const { ctx, page, errors } = await newPage(browser);
    await gotoApp(page, A.port);
    await loginFresh(page);
    await page.click('a.nav-item:has-text("用户")');
    await page.waitForSelector('.holding-table', { timeout: 15000 });
    await page.click('button:has-text("添加持仓")');
    await page.waitForSelector('.holding-modal', { timeout: 10000 });
    await setHoldingStock(page, '600519');
    await page.fill('input[placeholder="建仓成本单价"]', '1000');
    await page.fill('input[placeholder="持仓股数"]', '100');
    await page.click('.holding-modal .modal-actions .btn-primary');
    await page.waitForFunction(() => document.querySelectorAll('.holding-table tbody tr').length === 1, null, { timeout: 15000 });
    const keys = await page.evaluate(() => Object.keys(Store.data.holdings || {}));
    check('持仓只写入 admin 名下', keys.length === 1 && keys[0] === 'admin', JSON.stringify(keys));
    check('无 JS 报错', errors.length === 0, errors.join(' | '));
    if (!LIVE) await ctx.close();
  }

  await browser.close();
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error('运行异常：', e); process.exit(2); });
