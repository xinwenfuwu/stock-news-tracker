/* ============================================================
 * e2e-daybtns-move-20261110i.mjs — 验证「今天/昨天/前天」按钮
 *   从每日快讯标题栏右侧 (.brief-head-right) 剪切至「每日话题」标签左侧
 *   （即 .hot-topics-panel 内 .ht-head-right，位于 .ht-tabs 之前）。
 *
 * 覆盖：
 *   1) .ht-day-btns 仅 1 处，且位于左侧 .hot-topics-panel 的 .ht-head-right 内
 *   2) 该 .ht-day-btns 在 DOM 顺序上位于 .ht-tabs（每日话题/统计分析）之前（即「左侧」）
 *   3) 每日快讯的 .brief-head-right 不再包含 .ht-day-btns（已剪切）
 *   4) 三个按钮文本齐全（今天/昨天/前天）
 *   5) 点击「昨天」会把 briefWinDay 置为 1（功能仍然有效）
 *   6) 无 JS 报错
 *
 * 用法：node scripts/e2e-daybtns-move-20261110i.mjs
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
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev/.test(u.href), r => r.abort());

  console.log('1) 进入系统并打开「全球信息」页');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '全球信息' }).click();
  await page.waitForSelector('.brief-panel', { timeout: 30000 });

  console.log('2) 日按钮位置与剪切校验');
  const pos = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.ht-day-btns'));
    const inLeft = all.filter(b => b.closest('.hot-topics-panel'));
    const inBriefHeadRight = Array.from(document.querySelectorAll('.brief-head-right .ht-day-btns'));
    let texts = [], beforeTabs = false;
    if (inLeft.length === 1) {
      const box = inLeft[0];
      texts = Array.from(box.querySelectorAll('button')).map(b => b.textContent.trim());
      // DOM 顺序：.ht-day-btns 必须在 .ht-tabs 之前（即「每日话题」标签左侧）
      const parent = box.parentElement; // .ht-head-right
      const day = parent.querySelector('.ht-day-btns');
      const tabs = parent.querySelector('.ht-tabs');
      beforeTabs = !!day && !!tabs && !!(day.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    return {
      total: all.length,
      leftCount: inLeft.length,
      inBriefHeadRight: inBriefHeadRight.length,
      texts, beforeTabs
    };
  });
  check('.ht-day-btns 全站仅 1 处', pos.total === 1, 'total=' + pos.total);
  check('该组位于左侧 .hot-topics-panel（每日话题面板）内', pos.leftCount === 1, 'leftCount=' + pos.leftCount);
  check('每日快讯的 .brief-head-right 已不再含 .ht-day-btns（已剪切）', pos.inBriefHeadRight === 0, 'inBriefHeadRight=' + pos.inBriefHeadRight);
  check('该组在 DOM 顺序上位于 .ht-tabs（每日话题/统计分析）之前（即「左侧」）', pos.beforeTabs === true, 'beforeTabs=' + pos.beforeTabs);
  check('三个按钮文本齐全：今天 / 昨天 / 前天',
    pos.texts.includes('今天') && pos.texts.includes('昨天') && pos.texts.includes('前天'),
    JSON.stringify(pos.texts));

  console.log('3) 功能仍然有效：点击「昨天」设置 briefWinDay=1');
  const app = () => page.evaluate(() => document.getElementById('app').__vue_app__._container._vnode.component.proxy);
  const before = await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    return p.briefWinDay;
  });
  await page.locator('.hot-topics-panel .ht-day-btns button', { hasText: '昨天' }).click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    return p.briefWinDay;
  });
  check('点击「昨天」后 briefWinDay 由 ' + before + ' 变为 1', after === 1, 'after=' + after);

  console.log('4) 无 JS 报错');
  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
