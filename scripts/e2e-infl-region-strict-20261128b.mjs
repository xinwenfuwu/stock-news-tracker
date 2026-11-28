/* ============================================================
 * e2e-infl-region-strict-20261128b.mjs — 验证影响力事件三子版块（中国/美国/全世界）地域严格互斥
 *
 * 需求：每个子版块的新闻必须属于该子版块区域内的新闻——
 *   · 🇨🇳 中国 只收中国境内主体/政策/市场的新闻，其他国家新闻不计入
 *   · 🇺🇸 美国 只收美国境内主体的新闻，其他国家新闻不计入
 *   · 🌍 全世界 只收中美之外其他国家 + 中美混合的全球性新闻
 *
 * 覆盖：
 *   1) 静态接线：app.js 含严格地域函数 + 三处接入，index.html 说明文案 + 三个 tab title
 *   2) 版本戳 20261128b
 *   3) 真实浏览器：直接调用 inflAutoRegionOf / inflStrictRegionOf 跑 30+ 地域判定用例
 *   4) 真实浏览器：注入中/美/日三方新闻，切换三个 tab，验证互斥归属（各只出现在自己板块）
 *   5) 无 JS 报错
 *
 * 用法：node scripts/e2e-infl-region-strict-20261128b.mjs
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
const VER = '20261128b';
const DAY = '2026-11-28';

// 注入测试新闻：三条地域各自唯一
const CN_TITLE = '国务院部署新能源汽车下乡专项行动方案';
const US_TITLE = '美国财政部宣布对华芯片出口管制新规';
const JP_TITLE = '日本央行宣布超预期加息25个基点';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
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
  console.log('0) 静态接线检查');
  const appTxt = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const indexTxt = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const authTxt = fs.readFileSync(path.join(ROOT, 'js/auth-boot.js'), 'utf8');
  const tags = [...new Set([...indexTxt.matchAll(/\?v=([0-9a-z]+)/g)].map(m => m[1]))];
  check('版本戳统一为 ' + VER, tags.length > 0 && tags.every(t => t === VER), JSON.stringify(tags));
  check('auth-boot ASSET_V=' + VER, authTxt.includes("var ASSET_V = '" + VER + "'"));
  check('app.js 含 inflAutoRegionOf 地域判定函数', appTxt.includes('function inflAutoRegionOf(text)'));
  check('app.js 含美国政府机构短语剔除', appTxt.includes('INFL_US_GOV_PHRASE_RE'));
  check('app.js 含 inflStrictRegionOf 硬校验', appTxt.includes('function inflStrictRegionOf(e)'));
  check('seed 轨注释说明保留硬编码归类', appTxt.includes('seed 精选样例按「影响范围」预置 region'));
  check('自动轨硬校验已接入', appTxt.includes('e.region === reg && inflStrictRegionOf(e) === reg'));
  check('自动事件保存 _regionText', (appTxt.match(/_regionText:/g) || []).length >= 2);
  check('地域函数暴露供验证', appTxt.includes('inflAutoRegionOf, inflStrictRegionOf,'));
  check('index.html 含三子版块地域说明', indexTxt.includes('三子版块地域归属（20261128b 严格互斥）'));
  check('三个 tab title 明确地域互斥', indexTxt.includes('其他国家的新闻不计入'));

  const { srv, port } = await serveStatic(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  if (fs.existsSync(VUE_LOCAL)) {
    await page.route('**unpkg.com/**', r => r.fulfill({ path: VUE_LOCAL, contentType: 'text/javascript' }));
  }
  await page.route(u => /^(https?:)?\/\/(gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com)/.test(u.href), r => r.abort());
  // 同花顺快讯：注入三条地域新闻，每条 2 条形成语义簇
  await page.route(u => /news\.10jqka\.com\.cn\/tapp\/news\/push\/stock\//.test(u.href), async r => {
    const url = new URL(r.request().url());
    const pageNo = Number(url.searchParams.get('page') || 1);
    if (pageNo !== 1) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { list: [] } }) });
    const ctime = Math.floor(new Date(DAY + 'T10:00:00+08:00').getTime() / 1000) - 8 * 3600;
    const mk = (title, n) => ({ id: 'region-test-' + n, title, digest: title, ctime: ctime + n * 60, url: 'https://news.10jqka.com.cn/region/' + n, tag: '快讯' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      code: 0, data: { list: [
        mk(CN_TITLE, 1), mk(CN_TITLE, 2),
        mk(US_TITLE, 3), mk(US_TITLE, 4),
        mk(JP_TITLE, 5), mk(JP_TITLE, 6)
      ] }
    }) });
  });
  await page.route(u => {
    try { return /briefs-.+-\d{4}-\d{2}-\d{2}\.json/.test(new URL(u.href).pathname); }
    catch (e) { return false; }
  }, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ date: DAY, items: [] }) }));

  console.log('1) 进入系统并打开影响力事件');
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#auth-gate', { timeout: 20000 });
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); AuthUI.enterApp(); }, ADMIN_PW);
  await page.waitForFunction(() => !document.getElementById('auth-gate') && document.getElementById('app').__vue_app__, { timeout: 45000 });
  await page.locator('.nav-item', { hasText: '热门板块' }).click();
  await page.waitForSelector('.infl-main-list', { timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('app');
    const p = el && el.__vue_app__ && el.__vue_app__._container._vnode.component.proxy;
    return !!p && typeof p.inflAutoRegionOf === 'function';
  }, null, { timeout: 60000 });

  console.log('2) 地域判定用例（直接调用纯函数）');
  const cases = await page.evaluate(() => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    const fn = p.inflAutoRegionOf;
    const C = [
      // 中国境内
      ['国务院部署新能源汽车下乡专项行动方案', 'cn'],
      ['央行宣布降准0.5个百分点，释放长期流动性', 'cn'],
      ['证监会发布活跃资本市场一揽子新规', 'cn'],
      ['A股新能源板块获政策加码', 'cn'],
      ['发改委印发低空经济发展规划', 'cn'],
      ['国内多家车企上调新能源车售价', 'cn'],
      // 美国境内（含政府机构，修复重点）
      ['美国财政部宣布对华芯片出口管制新规', 'us'],
      ['美国商务部发布半导体出口新限制', 'us'],
      ['美联储超预期加息25个基点', 'us'],
      ['美国国务院发表最新声明', 'us'],
      ['白宫签署新一轮关税行政令', 'us'],
      ['五角大楼公布国防预算方案', 'us'],
      ['美股科技巨头上调AI资本开支指引', 'us'],
      ['英伟达发布新一代AI芯片Blackwell', 'us'],
      // 全世界（非美境外 + 中美混合）
      ['日本央行宣布超预期加息25个基点', 'world'],
      ['欧洲央行维持利率不变', 'world'],
      ['SK海力士宣布扩产存储芯片', 'world'],
      ['台积电上调先进制程报价', 'world'],
      ['韩国政府出台半导体扶持政策', 'world'],
      ['中东局势升级推升原油价格', 'world'],
      ['德国政府通过新能源补贴法案', 'world'],
      ['特朗普中期选举失利，民主党推动暂停AI发展', 'us'],
      ['美联储加息，中国央行同步降准应对', 'world'],
      ['美国对等关税升级，全球贸易链重构', 'us']
    ];
    return C.map(([text, want]) => ({ text, want, got: fn(text) }));
  });
  let cOk = 0;
  for (const c of cases) {
    if (c.got === c.want) cOk++;
    else console.log('    ✗ ' + c.text + '  want=' + c.want + ' got=' + c.got);
  }
  check('地域判定 ' + cOk + '/' + cases.length + ' 用例通过', cOk === cases.length, cOk + '/' + cases.length);

  console.log('3) 三子版块互斥归属（注入新闻后切换 tab）');
  await page.evaluate(async () => {
    const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
    p.setInflRegion('cn');
    p.setInflRangeDays(2);
    await p.refreshInfluence();
  });
  await page.waitForTimeout(1800);

  async function titlesInRegion(reg) {
    return await page.evaluate(async (r) => {
      const p = document.getElementById('app').__vue_app__._container._vnode.component.proxy;
      p.setInflRegion(r);
      await p.refreshInfluence();
      // setupState 自动解包 ref，p.inflEvents 已是数组；兼容 .value 以防未解包
      const list = Array.isArray(p.inflEvents) ? p.inflEvents : (p.inflEvents && p.inflEvents.value) || [];
      return list.map(e => e.title || '').join('\n');
    }, reg);
  }
  const cnText = await titlesInRegion('cn');
  const usText = await titlesInRegion('us');
  const worldText = await titlesInRegion('world');

  check('中国新闻只在中国板块', cnText.includes(CN_TITLE), cnText.slice(0, 200));
  check('中国新闻不在美国板块', !usText.includes(CN_TITLE));
  check('中国新闻不在全世界板块', !worldText.includes(CN_TITLE));

  check('美国新闻只在美国板块', usText.includes(US_TITLE), usText.slice(0, 200));
  check('美国新闻不在中国板块', !cnText.includes(US_TITLE));
  check('美国新闻不在全世界板块', !worldText.includes(US_TITLE));

  check('日本新闻只在全世界板块', worldText.includes(JP_TITLE), worldText.slice(0, 200));
  check('日本新闻不在中国板块', !cnText.includes(JP_TITLE));
  check('日本新闻不在美国板块', !usText.includes(JP_TITLE));

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
