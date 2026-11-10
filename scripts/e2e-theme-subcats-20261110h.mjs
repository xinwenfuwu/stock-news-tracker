/* ============================================================
 * e2e-theme-subcats-20261110h.mjs — 验证 20261110h「题材归类新增子类」
 *
 * 改动：题材归类维度新增 消费 / 短剧 / 文旅 三个子类，并把原「医药生物」显示名改为「医药」
 *   （key t_医药生物 不变，历史 catMeta 不失效）。命中逻辑为多标签 + 相对得分闸门：
 *   一条新闻仅当其某类别为「主导主题」时才计入该子类（次要提及会被相对得分截断丢弃）。
 *   因此 短剧/文旅 只在当日确有相关主导新闻时出现在渲染里；其余情况由下方运行时/静态校验兜底。
 *
 * 覆盖：
 *   1) 题材归类分组存在，真实数据下渲染出 医药 / 消费（这两个子类在该数据集中稳定有主导命中）
 *   2) 旧名「医药生物」不再出现（已改名 医药）
 *   3) 运行时调用应用自身的 HotTopics.briefStats（合成数据）确认 医药/消费/短剧/文旅 四个子类均被正确归类（>=1）
 *   4) 静态接线：HotTopics.BRIEF_DIMENSIONS 含 t_消费/t_短剧/t_文旅 且 t_医药生物 显示名为「医药」；
 *      BRIEF_KEYWORDS 含 t_短剧/t_文旅 非空词表
 *   5) 无 JS 报错
 *
 * 用法：node scripts/e2e-theme-subcats-20261110h.mjs
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
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hot-topics/index.json'), 'utf8'));
  const briefDates = (idx.briefsDates || []).filter(Boolean);
  check('index.json 已含 briefsDates', briefDates.length > 0);
  const date = briefDates[0];
  const briefFile = path.join(ROOT, 'data/hot-topics', `briefs-${date}.json`);
  check(`快讯文件 briefs-${date}.json 存在`, fs.existsSync(briefFile));
  const briefJson = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
  check('快讯 items 充足（>=100）', Array.isArray(briefJson.items) && briefJson.items.length >= 100,
    '共 ' + (briefJson.items || []).length + ' 条');
  console.log(`（使用真实数据：${date}，${briefJson.items.length} 条）\n`);

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

  console.log('2) 题材归类分组：真实数据下渲染 医药 / 消费，且旧名医药生物已消失');
  const themeCats = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.brief-panel .brief-cat-group'));
    const tg = groups.find(g => { const h = g.querySelector('.bcg-head'); return h && h.textContent.includes('题材'); });
    if (!tg) return { found: false };
    const cats = Array.from(tg.querySelectorAll('.brief-cat')).map(c => {
      const n = c.querySelector('.bc-name');
      const cc = c.querySelector('.bc-count');
      const count = cc ? parseInt(String(cc.textContent).replace(/[^\d]/g, ''), 10) : NaN;
      return { name: n ? n.textContent.trim() : '(无)', count };
    });
    return { found: true, cats };
  });
  check('题材归类分组存在', themeCats.found);
  const names = (themeCats.cats || []).map(c => c.name);
  console.log('   题材归类渲染子类（前 20）：' + names.slice(0, 20).join(' / '));
  check('含「医药」子类（真实主导命中）', names.includes('医药'), '缺失医药');
  check('含「消费」子类（真实主导命中）', names.includes('消费'), '缺失消费');
  check('旧名「医药生物」已不再出现（改名医药）', !names.includes('医药生物'), '仍含医药生物');
  const get = (nm) => (themeCats.cats || []).find(c => c.name === nm);
  const med = get('医药'), con = get('消费');
  check('医药 条数为数字且 > 0', med && Number.isFinite(med.count) && med.count > 0, med && med.count);
  check('消费 条数为数字且 > 0', con && Number.isFinite(con.count) && con.count > 0, con && con.count);

  console.log('3) 运行时校验：调用应用自身 HotTopics.briefStats（合成数据）确认四个子类均被正确归类');
  const run = await page.evaluate(() => {
    const H = window.HotTopics;
    if (!H || !H.briefStats || !H.BRIEF_DIMENSIONS) return { missing: true };
    const synth = [
      { text: '国庆假期文旅市场火热，各地景区游客爆满酒店一房难求，旅游消费强劲复苏' },
      { text: '某微短剧平台短剧出海斩获千万播放，短剧概念板块拉升' },
      { text: '社零数据回暖，家电以旧换新带动消费复苏，免税零售走旺' },
      { text: '创新药获批，恒瑞医药大涨，CXO 订单饱满' },
      { text: '半导体板块领涨，光刻机国产替代加速' }
    ];
    const st = H.briefStats(synth, 'theme');
    const map = {}; st.forEach(t => { map[t.name] = (map[t.name] || 0) + t.count; });
    return { missing: false, map };
  });
  check('HotTopics.briefStats 接口可用', !run.missing);
  if (!run.missing) {
    const m = run.map;
    console.log('   合成数据归类结果：' + Object.entries(m).filter(([k]) => ['医药', '消费', '短剧', '文旅', '半导体'].includes(k)).map(([k, v]) => `${k}:${v}`).join('  '));
    check('合成数据中 医药 被归类（>=1）', (m['医药'] || 0) >= 1, m['医药']);
    check('合成数据中 消费 被归类（>=1）', (m['消费'] || 0) >= 1, m['消费']);
    check('合成数据中 短剧 被归类（>=1）', (m['短剧'] || 0) >= 1, m['短剧']);
    check('合成数据中 文旅 被归类（>=1）', (m['文旅'] || 0) >= 1, m['文旅']);
  }

  console.log('4) 静态接线：BRIEF_DIMENSIONS / BRIEF_KEYWORDS 含四个新子类定义');
  const wiring = await page.evaluate(() => {
    const H = window.HotTopics;
    const dims = H.BRIEF_DIMENSIONS || [];
    const kw = H.BRIEF_KEYWORDS || {};
    const dimByKey = {}; dims.forEach(d => { dimByKey[d.key] = d; });
    return {
      hasConsume: !!dimByKey['t_消费'],
      hasDrama: !!dimByKey['t_短剧'],
      hasCulture: !!dimByKey['t_文旅'],
      hasMedKey: !!dimByKey['t_医药生物'],
      medName: dimByKey['t_医药生物'] ? dimByKey['t_医药生物'].name : null,
      dramaKwLen: (kw['t_短剧'] || []).length,
      cultureKwLen: (kw['t_文旅'] || []).length,
      consumeKwLen: (kw['t_消费'] || []).length
    };
  });
  check('BRIEF_DIMENSIONS 含 t_消费', wiring.hasConsume);
  check('BRIEF_DIMENSIONS 含 t_短剧', wiring.hasDrama);
  check('BRIEF_DIMENSIONS 含 t_文旅', wiring.hasCulture);
  check('BRIEF_DIMENSIONS 含 t_医药生物（改名后 key 不变）', wiring.hasMedKey);
  check('t_医药生物 显示名为「医药」', wiring.medName === '医药', wiring.medName);
  check('t_短剧 词表非空', wiring.dramaKwLen > 0, 'len=' + wiring.dramaKwLen);
  check('t_文旅 词表非空', wiring.cultureKwLen > 0, 'len=' + wiring.cultureKwLen);
  check('t_消费 词表非空', wiring.consumeKwLen > 0, 'len=' + wiring.consumeKwLen);

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
