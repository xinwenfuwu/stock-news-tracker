/* ============================================================
 * e2e-theme-guochanghui-20261127a.mjs — 验证 20261127a「题材归类新增国常会子概念」
 *
 * 覆盖：
 *   1) 静态接线：BRIEF_DIMENSIONS 含 t_国常会（显示名「国常会」），BRIEF_KEYWORDS 词表非空
 *   2) 运行时归类：应用自身 HotTopics.briefStats 对合成国常会新闻计入「国常会」，且国务院/部门不回退
 *   3) 真实浏览器：全球信息页题材归类分组可渲染「国常会」行与条数
 *   4) 版本戳：index.html 与 auth-boot.js 同步为 20261127a
 *   5) 无 JS 报错
 *
 * 用法：node scripts/e2e-theme-guochanghui-20261127a.mjs
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
const VER = '20261127a';

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
  console.log('0) 静态版本戳检查');
  const indexTxt = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const authTxt = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
  const tags = [...new Set([...indexTxt.matchAll(/\?v=([0-9a-z]+)/g)].map(m => m[1]))];
  check('index.html 版本戳统一为 ' + VER, tags.length > 0 && tags.every(t => t === VER), JSON.stringify(tags));
  check('auth-boot.js ASSET_V=' + VER, authTxt.includes("var ASSET_V = '" + VER + "'"));

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

  console.log('2) 静态接线：题材归类含 t_国常会 且词表非空');
  const wiring = await page.evaluate(() => {
    const H = window.HotTopics;
    const dim = (H.BRIEF_DIMENSIONS || []).find(d => d.key === 't_国常会');
    return { has: !!dim, name: dim && dim.name, kwLen: (H.BRIEF_KEYWORDS['t_国常会'] || []).length };
  });
  check('BRIEF_DIMENSIONS 含 t_国常会', wiring.has);
  check('显示名为「国常会」', wiring.name === '国常会', wiring.name);
  check('t_国常会 词表非空', wiring.kwLen > 0, 'len=' + wiring.kwLen);

  console.log('3) 运行时归类：国常会新闻进入新子类，国务院/部门不回退');
  const run = await page.evaluate(() => {
    const H = window.HotTopics;
    const synth = [
      { text: '国常会：完善资本市场稳市机制，增强股市内在稳定性', time: '2026-11-27 16:00' },
      { text: '李强主持召开国务院常务会议，部署加快重大项目建设进度', time: '2026-11-27 16:10' },
      { text: '国务院常务会议审议通过促进消费专项行动方案', time: '2026-11-27 16:20' }
    ];
    const rows = H.briefStats(synth, 'theme');
    const map = {};
    rows.forEach(r => { map[r.name] = r.count; });
    return { map, keys: rows.map(r => r.key) };
  });
  check('briefStats 返回 t_国常会', run.keys.includes('t_国常会'), run.keys.join('/'));
  check('国常会命中数 >= 3', (run.map['国常会'] || 0) >= 3, 'count=' + run.map['国常会']);
  check('国务院原有子类仍命中', (run.map['国务院'] || 0) >= 3, 'count=' + run.map['国务院']);
  check('部门总类仍命中', (run.map['部门'] || 0) >= 3, 'count=' + run.map['部门']);

  console.log('4) 真实浏览器：向题材归类注入国常会新闻并检查渲染');
  await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    p.briefWindow.on = false;
    p.briefDate = '2026-11-27';
    p.briefKeyword = '';
    p.briefItems = [
      { text: '国常会：完善资本市场稳市机制，增强股市内在稳定性', time: '2026-11-27 16:00', date: '2026-11-27', sourceName: '测试' },
      { text: '李强主持召开国务院常务会议，部署加快重大项目建设进度', time: '2026-11-27 16:10', date: '2026-11-27', sourceName: '测试' },
      { text: '国务院常务会议审议通过促进消费专项行动方案', time: '2026-11-27 16:20', date: '2026-11-27', sourceName: '测试' }
    ];
  });
  await page.waitForFunction(() => {
    const groups = Array.from(document.querySelectorAll('.brief-panel .brief-cat-group'));
    const tg = groups.find(g => { const h = g.querySelector('.bcg-head'); return h && h.textContent.includes('题材'); });
    return !!(tg && Array.from(tg.querySelectorAll('.bc-name')).some(n => n.textContent.trim() === '国常会'));
  }, null, { timeout: 15000 }).catch(() => {});
  const ui = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.brief-panel .brief-cat-group'));
    const tg = groups.find(g => { const h = g.querySelector('.bcg-head'); return h && h.textContent.includes('题材'); });
    if (!tg) return { found: false };
    const row = Array.from(tg.querySelectorAll('.brief-cat')).find(c => {
      const n = c.querySelector('.bc-name');
      return n && n.textContent.trim() === '国常会';
    });
    if (!row) return { found: true, hasRow: false };
    const cc = row.querySelector('.bc-count');
    return {
      found: true,
      hasRow: true,
      text: row.textContent.replace(/\s+/g, ' ').trim(),
      count: cc ? parseInt(String(cc.textContent).replace(/[^\d]/g, ''), 10) : NaN
    };
  });
  check('题材归类分组存在', ui.found);
  check('题材归类渲染「国常会」行', ui.hasRow, ui.text);
  check('国常会行条数=3', ui.count === 3, 'count=' + ui.count);

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
