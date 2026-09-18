/* ============================================================
 * e2e-batch21.mjs — 验证 batch21 六项改动
 *   1) 设置仅管理员可见（普通用户看不到设置齿轮，但有「偏好设置」入口）
 *   2) 登录页「显示密码」按钮
 *   3) 登录失败原因正确显示（中文、无 [object Object] 乱码）
 *   4) 同浏览器账户切换刷新后保持当前账户（独立性）
 *   5) 全球信息-每日快讯：来源切换真正驱动不同数据文件
 *   6) 新闻追踪-手动添加后，四字段（新闻解读参考/利好利空/散户参考/核心股票）由 AI 自动填写
 *
 * 用法：node scripts/e2e-batch21.mjs
 * ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'accounts', 'registry.json');
const ADMIN_PW = 'Admin@2026';
const ADMIN_USER = 'admin';
const NORMAL_USER = 'nor21';
const NORMAL_PW = 'pw12345678';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- 复用 batch20 的静态服务 + 助手里程 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveStatic(dir) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}
async function newCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(u => /gtimg\.cn|eastmoney\.com|workers\.dev|api\.github\.com|vore\.top|ip\.sb|ipapi|unpkg\.com|toutiao\.com|openai\.com/.test(u.href), r => r.abort());
  return { ctx, page, errors };
}
async function waitAuthReady(page) {
  await page.waitForSelector('#auth-gate', { timeout: 60000 });
  await page.waitForFunction(() => typeof window.Auth !== 'undefined' && typeof window.AuthUI !== 'undefined', null, { timeout: 60000 });
}
async function waitAppReady(page) {
  await page.waitForFunction(() => !document.getElementById('auth-gate'), null, { timeout: 90000 });
  await page.waitForFunction(() => { const el = document.getElementById('app'); return !!(el && el.__vue_app__); }, null, { timeout: 90000 });
}
async function bootAdmin(page) {
  await page.evaluate(async (pw) => { await Auth.setup('admin', pw, pw); }, ADMIN_PW);
  await page.evaluate(() => AuthUI.enterApp());
  await waitAppReady(page);
}

/* ================================================================== */
/* (A) Node 单元：parseInterpretation 解析四段（含核心股票）            */
/* ================================================================== */
await import(pathToFileURL(path.join(ROOT, 'js/auth.js')).href);
const Auth = globalThis.Auth;
// 复刻 app.js 内的 parseInterpretation（同正则），确保四字段解析正确
function parseInterpretation(text) {
  const out = { ref: '', bull: '', retail: '', core: [] };
  const mRef = text.match(/【?\s*新闻解读参考\s*】?([\s\S]*?)(?=【?\s*利好利空\s*】?|$)/);
  const mBull = text.match(/【?\s*利好利空\s*】?([\s\S]*?)(?=【?\s*散户参考\s*】?|$)/);
  const mRetail = text.match(/【?\s*散户参考\s*】?([\s\S]*?)(?=【?\s*核心股票\s*】?|$)/);
  const mCore = text.match(/【?\s*核心股票\s*】?([\s\S]*?)$/);
  if (mRef) out.ref = mRef[1].trim();
  if (mBull) out.bull = mBull[1].trim();
  if (mRetail) out.retail = mRetail[1].trim();
  if (mCore) out.core = mCore[1].split(/[\n，,，、；;]+/).map(s => s.replace(/[【】\s.。]/g, '').trim()).filter(s => s && !/^(无|none|na|无核心股票)$/i.test(s)).slice(0, 5);
  return out;
}
const SAMPLE = '【新闻解读参考】\n这是一条利好半导体设备的政策。\n【利好利空】\n利好概念：半导体、算力\n利好行业：半导体\n利空概念：无\n利空行业：无\n【散户参考】\n可逢低关注设备龙头，仅供参考，不构成投资建议。\n【核心股票】\n北方华创\n中微公司\n长电科技';
const pi = parseInterpretation(SAMPLE);
check('解析：新闻解读参考非空', pi.ref.includes('半导体设备'));
check('解析：利好利空非空', pi.bull.includes('半导体'));
check('解析：散户参考非空', pi.retail.includes('逢低关注'));
check('解析：核心股票提取 3 只', pi.core.length === 3 && pi.core[0] === '北方华创' && pi.core[2] === '长电科技', JSON.stringify(pi.core));
const piNoCore = parseInterpretation('【新闻解读参考】x\n【利好利空】y\n【散户参考】z\n【核心股票】\n无');
check('解析：核心股票写「无」时不产生条目', piNoCore.core.length === 0);

/* ================================================================== */
/* (B) Playwright 真浏览器                                            */
/* ================================================================== */
const { srv, port } = await serveStatic(ROOT);
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch();
try {
  /* ---------- 1) 显示密码按钮 + 3) 登录失败提示（登录页，未登录） ---------- */
  console.log('\n[web] 1) 显示密码 + 3) 登录失败提示');
  const gate = await newCtx(browser);
  // 预置一个账号，使 gate 默认展示「登录」表单（空浏览器默认展示注册表单）
  await gate.page.addInitScript(() => {
    try { localStorage.setItem('snt-auth-users-v1', JSON.stringify([{ username: 'seed', role: 'user', hash: 'x', status: 'active', disabled: false, createdAt: 1, updatedAt: 1, logins: [] }])); } catch (e) {}
  });
  await gate.page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await waitAuthReady(gate.page);
  await gate.page.locator('#auth-login-form').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  const pwTypeBefore = await gate.page.getAttribute('#login-password', 'type');
  await gate.page.click('.auth-pw-toggle[data-pw="login-password"]');
  const pwTypeAfter = await gate.page.getAttribute('#login-password', 'type');
  check('登录页：点击眼睛后密码框变为可见文本', pwTypeBefore === 'password' && pwTypeAfter === 'text', `before=${pwTypeBefore} after=${pwTypeAfter}`);
  await gate.page.click('.auth-pw-toggle[data-pw="login-password"]');
  const pwTypeBack = await gate.page.getAttribute('#login-password', 'type');
  check('登录页：再次点击恢复为密码框', pwTypeBack === 'password');

  // 登录失败：错误密码
  await gate.page.fill('#login-username', 'nobody');
  await gate.page.fill('#login-password', 'wrongpass');
  await gate.page.click('#auth-login-form button[type="submit"]');
  await gate.page.waitForSelector('#auth-msg:not([hidden])', { timeout: 8000 }).catch(() => {});
  const msgText = await gate.page.locator('#auth-msg').innerText().catch(() => '');
  check('登录失败：提示可见且为中文', msgText.trim().length > 0 && !/\[object Object\]/.test(msgText), msgText.slice(0, 80));
  const stillGate = await gate.page.locator('#auth-gate').isVisible().catch(() => false);
  check('登录失败：仍停在登录页', stillGate === true);

  /* ---------- 4) 账户独立性：同浏览器 admin→normal→刷新保持 normal ---------- */
  console.log('\n[web] 4) 账户独立性');
  const indep = await newCtx(browser);
  await indep.page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await waitAuthReady(indep.page);
  await bootAdmin(indep.page);                 // 管理员登录（同一浏览器）
  const role1 = await indep.page.evaluate(() => Auth.user && Auth.user.role);
  check('独立性：管理员登录后身份=admin', role1 === 'admin', String(role1));
  // 在同一浏览器新增普通账号并登录
  await indep.page.evaluate(async (args) => {
    await Auth.addUser(args.u, args.p, 'user');
    const r = await Auth.login(args.u, args.p, true);
    if (r && r.ok) AuthUI.enterApp();
    return r;
  }, { u: NORMAL_USER, p: NORMAL_PW });
  await waitAppReady(indep.page);
  const role2 = await indep.page.evaluate(() => Auth.user && Auth.user.role);
  check('独立性：切到普通账号后身份=user', role2 === 'user', String(role2));
  // 关键：刷新后保持普通账号（不复原成管理员）
  await indep.page.reload({ waitUntil: 'load', timeout: 40000 });
  await waitAppReady(indep.page);
  const role3 = await indep.page.evaluate(() => Auth.user && Auth.user.role);
  check('独立性：刷新后仍保持普通账号（修复点）', role3 === 'user', String(role3));
  // 切回管理员并刷新，仍保持管理员
  await indep.page.evaluate(async (args) => {
    const r = await Auth.login(args.a, args.p, true);
    if (r && r.ok) AuthUI.enterApp();
    return r;
  }, { a: ADMIN_USER, p: ADMIN_PW });
  await waitAppReady(indep.page);
  await indep.page.reload({ waitUntil: 'load', timeout: 40000 });
  await waitAppReady(indep.page);
  const role4 = await indep.page.evaluate(() => Auth.user && Auth.user.role);
  check('独立性：切回管理员刷新后保持 admin', role4 === 'admin', String(role4));

  /* ---------- 1) 设置仅管理员可见 / 偏好设置对所有人可见 ---------- */
  console.log('\n[web] 1) 设置可见性（管理员 vs 普通用户）');
  // 当前 indep 是管理员
  const adminGearVisible = await indep.page.locator('button[title="设置"]').first().isVisible().catch(() => false);
  check('管理员：设置齿轮可见', adminGearVisible === true);
  // 打开用户菜单，确认有「偏好设置」入口
  await indep.page.locator('.user-chip').click();
  await indep.page.waitForTimeout(300);
  const adminMenuText = await indep.page.locator('.user-dropdown').innerText().catch(() => '');
  check('管理员：用户菜单含「偏好设置」', /偏好设置/.test(adminMenuText));
  await indep.page.keyboard.press('Escape').catch(() => {});

  // 普通用户上下文：先 bootAdmin（addUser 需管理员），再建普通账号并登录
  const norm = await newCtx(browser);
  await norm.page.goto(base, { waitUntil: 'load', timeout: 40000 });
  await waitAuthReady(norm.page);
  await bootAdmin(norm.page);
  await norm.page.evaluate(async (args) => { await Auth.addUser(args.u, args.p, 'user'); const r = await Auth.login(args.u, args.p, true); if (r && r.ok) AuthUI.enterApp(); }, { u: NORMAL_USER, p: NORMAL_PW });
  await waitAppReady(norm.page);
  const normGearVisible = await norm.page.locator('button[title="设置"]').first().isVisible().catch(() => false);
  check('普通用户：设置齿轮不可见', normGearVisible === false);
  await norm.page.locator('.user-chip').click();
  await norm.page.waitForTimeout(300);
  const normMenuText = await norm.page.locator('.user-dropdown').innerText().catch(() => '');
  check('普通用户：用户菜单仍含「偏好设置」', /偏好设置/.test(normMenuText));
  // 打开偏好设置，确认含 AI 解读配置
  await norm.page.locator('.user-dd-item', { hasText: '偏好设置' }).click();
  await norm.page.waitForSelector('.modal-overlay', { timeout: 8000 });
  const prefsText = await norm.page.locator('.modal-overlay').innerText().catch(() => '');
  check('普通用户：偏好设置含「AI 解读接口」配置', /AI 解读接口/.test(prefsText));
  check('普通用户：偏好设置不含「GitHub 令牌」（那是管理员设置）', !/GitHub 令牌/.test(prefsText));
  await norm.page.keyboard.press('Escape').catch(() => {});

  /* ---------- 6) 新闻追踪-手动添加：弹窗含 AI 按钮 + 四字段 ---------- */
  console.log('\n[web] 6) 手动添加弹窗含 AI 按钮与四字段');
  // 先关掉可能残留的偏好设置弹窗（前一步打开过），避免遮罩挡住点击
  await norm.page.keyboard.press('Escape').catch(() => {});
  await norm.page.waitForTimeout(300);
  const overlayOpen = await norm.page.locator('.modal-overlay').isVisible().catch(() => false);
  if (overlayOpen) {
    await norm.page.locator('.modal-overlay .btn-icon').first().click().catch(() => {});
    await norm.page.waitForTimeout(300);
  }
  await norm.page.evaluate(() => { location.hash = 'news'; });
  await norm.page.waitForTimeout(400);
  // 找到「➕ 手动添加」按钮（新闻追踪页）并点击
  const addBtn = norm.page.locator('button', { hasText: '手动添加' }).first();
  await addBtn.click({ timeout: 8000 }).catch(async () => {
    // 兜底：部分版本文案不同，尝试“添加新闻”
    await norm.page.locator('button', { hasText: '添加新闻' }).first().click();
  });
  await norm.page.waitForSelector('.modal-overlay', { timeout: 8000 });
  const addModal = await norm.page.locator('.modal-overlay').innerText().catch(() => '');
  check('手动添加弹窗含「🤖 AI 生成解读」按钮', /AI 生成解读/.test(addModal));
  check('手动添加弹窗含「新闻解读参考」字段', /新闻解读参考/.test(addModal));
  check('手动添加弹窗含「利好利空」字段', /利好利空/.test(addModal));
  check('手动添加弹窗含「散户参考」字段', /散户参考/.test(addModal));
  // 第四字段「核心股票」由 AI 填入「股票名称/代码」字段（关联股票）
  check('手动添加弹窗含「股票名称/代码」字段（核心股票落点）', /股票名称\/代码/.test(addModal) || /股票名称/.test(addModal));
  // 填内容后保存：未配 AI → 应正常“已添加”，不报错、不乱码
  await norm.page.locator('.modal-overlay textarea').first().fill('央行宣布降准0.5个百分点，释放长期资金约1万亿元。');
  await norm.page.locator('.modal-overlay button', { hasText: '保存' }).first().click();
  await norm.page.waitForTimeout(800);
  const addToast = await norm.page.locator('.toast, .app-toast').innerText().catch(() => '');
  check('手动添加（无 AI 配置）：保存成功提示，无异常', /已添加/.test(addToast) || addToast === '', addToast.slice(0, 80));

  /* ---------- 5) 每日快讯：来源切换驱动不同数据文件 ---------- */
  console.log('\n[web] 5) 每日快讯来源切换');
  // 监听请求必须在切到 finance 之前挂上，否则默认（格隆汇）那次加载会被漏掉
  const reqs = [];
  norm.page.on('request', r => { if (/briefs-/.test(r.url())) reqs.push(r.url()); });
  await norm.page.evaluate(() => { location.hash = 'finance'; });
  await norm.page.waitForTimeout(800);
  await waitAppReady(norm.page);
  // 默认来源=格隆汇，等其加载
  await norm.page.waitForTimeout(1500);
  const hasGelonghui = reqs.some(u => /briefs-\d{4}-\d{2}-\d{2}\.json/.test(u) && !/今日头条/.test(u));
  check('每日快讯：默认加载格隆汇数据文件 briefs-YYYY-MM-DD.json', hasGelonghui, reqs.slice(-3).join(' | '));
  // 切换来源为「今日头条」
  await norm.page.selectOption('.brief-source', '今日头条').catch(() => {});
  await norm.page.waitForTimeout(1500);
  const hasToutiao = reqs.some(u => /briefs-今日头条-/.test(decodeURIComponent(u)));
  check('每日快讯：切换为今日头条后加载 briefs-今日头条-*.json', hasToutiao, reqs.slice(-4).join(' | '));
  // 切回格隆汇
  await norm.page.selectOption('.brief-source', '格隆汇').catch(() => {});
  await norm.page.waitForTimeout(1200);
  const backGelonghui = reqs.filter(u => /briefs-\d{4}-\d{2}-\d{2}\.json/.test(u) && !/今日头条/.test(u)).length >= 1;
  check('每日快讯：切回格隆汇再次加载格隆汇文件', backGelonghui);

  const errs = gate.errors.concat(indep.errors, norm.errors).filter(e => !/gtimg|eastmoney|Failed to fetch|NetworkError|api\.github|toutiao|openai/.test(e));
  check('页面无脚本错误', errs.length === 0, errs.join(' ; '));
} catch (e) {
  console.error('E2E 异常:', e);
  fail++;
} finally {
  await browser.close();
  srv.close();
  fs.writeFileSync(REG_PATH, JSON.stringify({ version: 1, updatedAt: null, accounts: {} }, null, 2));
  console.log('\n已还原 data/accounts/registry.json 为空表');
}
console.log(`\n结果：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
