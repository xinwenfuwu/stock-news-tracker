/* ============================================================
 * e2e-branding.mjs — 站名改名 + 分上下两层、导航「选股」改名 的真实浏览器验证
 *
 * 覆盖：
 *   1) 浏览器标题、登录页标题文字已改为「股市信息分析系统」
 *   2) 登录页标题、顶部栏站名均为上下两层（两行的 y 坐标不同、水平居中对齐）
 *   3) 顶部栏站名两行不溢出顶栏（仍在 header 内，且不再换行成第三行）
 *   4) 顶部导航「概念行业选股」→「选股」，且旧文字全站不再出现
 *   5) 点击「选股」进入该页，页面标题为「🧭 选股」，页面本身功能正常
 *
 * 用法：node scripts/e2e-branding.mjs
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
const BRAND = '股市信息分析系统';
const OLD_BRAND = '股市信息追踪分析系统';
const OLD_TAB = '概念行业选股';

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

/** 读取一个元素内所有行内子节点的几何位置，判断是否「上下两层」 */
const LINES_INFO = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const kids = Array.from(el.children).filter(k => k.tagName === 'SPAN');
  const box = el.getBoundingClientRect();
  return {
    text: el.textContent.replace(/\s+/g, ''),
    childCount: kids.length,
    childTexts: kids.map(k => k.textContent.replace(/\s+/g, '')),
    lines: kids.map(k => {
      const r = k.getBoundingClientRect();
      return { y: Math.round(r.y), x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    box: { y: Math.round(box.y), h: Math.round(box.height), w: Math.round(box.width) },
    // 行盒高度（用于判断是否真的分行渲染）
    lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 0
  };
};

async function main() {
  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  // 外部行情/资讯接口全部拦截，避免测试受网络影响
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());

  console.log('1) 登录页：站名与上下两层');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });

  check('浏览器标签标题已改为新站名', (await page.title()) === BRAND, await page.title());
  const authInfo = await page.evaluate(LINES_INFO, '.auth-title');
  check('登录页标题文字为新站名（无「追踪」）',
    authInfo && authInfo.text === BRAND && !authInfo.text.includes('追踪'), authInfo && authInfo.text);
  check('登录页标题为两层（两个 span）', authInfo && authInfo.childCount === 2,
    authInfo && String(authInfo.childCount));
  check('登录页标题第一层为「股市信息」', authInfo && authInfo.childTexts[0] === '股市信息',
    authInfo && authInfo.childTexts.join('|'));
  check('登录页标题第二层为「分析系统」', authInfo && authInfo.childTexts[1] === '分析系统',
    authInfo && authInfo.childTexts.join('|'));
  check('登录页标题确实上下排布（第二层 y > 第一层 y）',
    authInfo && authInfo.lines[1].y > authInfo.lines[0].y,
    authInfo && JSON.stringify(authInfo.lines));
  check('登录页标题两层水平居中对齐（中心 x 差 <= 1px）',
    authInfo && Math.abs((authInfo.lines[0].x + authInfo.lines[0].w / 2) - (authInfo.lines[1].x + authInfo.lines[1].w / 2)) <= 1,
    authInfo && JSON.stringify(authInfo.lines.map(l => l.x + l.w / 2)));
  check('登录页标题两层各占一行（容器高 ≈ 2 倍行高）',
    authInfo && authInfo.lineHeight > 0 && Math.abs(authInfo.box.h - authInfo.lineHeight * 2) <= 4,
    authInfo && `h=${authInfo.box.h} lh=${authInfo.lineHeight}`);

  console.log('2) 进入系统：顶部栏站名与导航');
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });

  const brandInfo = await page.evaluate(LINES_INFO, '.brand-title');
  check('顶部栏站名文字为新站名', brandInfo && brandInfo.text === BRAND, brandInfo && brandInfo.text);
  check('顶部栏站名第一层为「股市信息」', brandInfo && brandInfo.childTexts[0] === '股市信息', brandInfo && brandInfo.childTexts.join('|'));
  check('顶部栏站名第二层为「分析系统」', brandInfo && brandInfo.childTexts[1] === '分析系统', brandInfo && brandInfo.childTexts.join('|'));
  check('顶部栏站名上下两层（第二层 y > 第一层 y）',
    brandInfo && brandInfo.lines[1].y > brandInfo.lines[0].y,
    brandInfo && JSON.stringify(brandInfo.lines));
  check('顶部栏站名两层水平居中对齐（中心 x 差 <= 1px）',
    brandInfo && Math.abs((brandInfo.lines[0].x + brandInfo.lines[0].w / 2) - (brandInfo.lines[1].x + brandInfo.lines[1].w / 2)) <= 1,
    brandInfo && JSON.stringify(brandInfo.lines.map(l => l.x + l.w / 2)));

  // 站名不能溢出顶栏（否则会被裁切或把导航挤走）
  const headerFit = await page.evaluate(() => {
    const h = document.querySelector('.app-header').getBoundingClientRect();
    const b = document.querySelector('.brand-title').getBoundingClientRect();
    const nav = document.querySelector('.main-nav').getBoundingClientRect();
    return { headerTop: Math.round(h.top), headerBottom: Math.round(h.bottom), headerH: Math.round(h.height),
      brandTop: Math.round(b.top), brandBottom: Math.round(b.bottom),
      navLeft: Math.round(nav.left), brandRight: Math.round(b.right) };
  });
  check('站名两行完整落在顶栏高度内（不被裁切）',
    headerFit.brandTop >= headerFit.headerTop && headerFit.brandBottom <= headerFit.headerBottom,
    JSON.stringify(headerFit));
  check('站名未与导航重叠', headerFit.brandRight <= headerFit.navLeft + 1, JSON.stringify(headerFit));

  const navTexts = await page.$$eval('.nav-item', els => els.map(e => e.textContent.replace(/\s+/g, '')));
  check('导航项为「🧭选股」（已去掉「概念行业」前缀）',
    navTexts.some(t => t === '🧭选股'), navTexts.join(' | '));
  check('导航中不再出现旧文字「概念行业选股」',
    !navTexts.some(t => t.includes(OLD_TAB)), navTexts.join(' | '));

  console.log('3) 页面本体：旧文字应全站消失');
  const bodyText = await page.evaluate(() => document.body.innerText);
  check('页面可见文字中无「概念行业选股」', !bodyText.includes(OLD_TAB));
  check('页面可见文字中无旧站名', !bodyText.includes(OLD_BRAND));

  console.log('4) 点击「选股」进入该页');
  await page.locator('.nav-item', { hasText: '选股' }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.page[style*="display: none"]');
    void el;
    const t = Array.from(document.querySelectorAll('.page-title')).find(x => x.offsetParent !== null);
    return !!(t && /选股/.test(t.textContent));
  }, { timeout: 20000 });
  const pageTitle = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.page-title')).find(x => x.offsetParent !== null);
    return t ? t.textContent.replace(/\s+/g, '') : '';
  });
  check('选股页标题为「🧭选股」', pageTitle === '🧭选股', pageTitle);
  check('选股页标题不含「概念行业」', !pageTitle.includes('概念行业'), pageTitle);
  const sectorUsable = await page.evaluate(() => {
    const sec = document.querySelector('section.page');
    void sec;
    return !!document.querySelector('input[placeholder], .sector-search input, .page-toolbar');
  });
  check('选股页工具栏正常渲染（未被改名破坏）', sectorUsable);

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await ctx.close();
  // 窄屏：站名应隐藏（既有规则），不应撑破布局
  console.log('5) 窄屏（390×844）：不溢出、不报错');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  const merr = [];
  mp.on('pageerror', e => merr.push(e.message));
  if (fs.existsSync(VUE_LOCAL)) await mp.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  await mp.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());
  await mp.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await mp.waitForSelector('#auth-gate', { timeout: 20000 });
  const mInfo = await mp.evaluate(() => {
    const t = document.querySelector('.auth-title');
    const card = document.querySelector('.auth-card');
    const r = card.getBoundingClientRect();
    return {
      text: t.textContent.replace(/\s+/g, ''),
      cardLeft: Math.round(r.left), cardRight: Math.round(r.right), cardW: Math.round(r.width),
      vw: window.innerWidth,
      bodyOverflow: getComputedStyle(document.body).overflow,
      // 未登录时页面骨架（宽表格）仍在 DOM 中，靠 body overflow:hidden 锁住横向滚动条
      hasHScroll: document.documentElement.scrollWidth > window.innerWidth && getComputedStyle(document.body).overflow !== 'hidden'
    };
  });
  check('窄屏登录页站名仍为两层新站名', mInfo.text === BRAND, mInfo.text);
  check('窄屏登录卡片完整落在视口内（左右不溢出）',
    mInfo.cardLeft >= 0 && mInfo.cardRight <= mInfo.vw + 1,
    JSON.stringify(mInfo));
  check('窄屏不出现横向滚动条', !mInfo.hasHScroll, JSON.stringify(mInfo));
  check('窄屏无 JS 报错', merr.length === 0, merr.slice(0, 2).join(' | '));
  await mctx.close();

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
