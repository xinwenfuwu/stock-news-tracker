/* ============================================================
 * test-worker-pay-claim.mjs — 验证 payClaim（Worker 侧）20261016h 改动
 *
 * 1) 账号快照透传：合法快照（用户名一致 + pbkdf2 哈希）落库；结构不符/用户名不符丢弃
 * 2) 未决申请「重新提交即取代最新」：同用户同套餐的未决申请被最新提交替换
 * 3) 不同套餐可并存；已 resolved 的旧申请不被替换
 * 4) 无 GH_PAT → 503（保持原行为）
 * 5) 20261016i 拒绝标记：rejected=true → resolved+rejected+rejectedAt；被拒后重交生成新未决申请
 * 6) 20261016i 普通 resolve 不写 rejected 字段（与拒绝互不污染）
 * 7) 20261016k /auth/register：全新注册写注册表；占用口径（active/admin/paid→409；pending/rejected→覆盖）
 * 8) 20261016l /auth/register：会员字段透传；同哈希 upsert（覆盖更新不 409）；同哈希不降级 admin
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---------- mock GitHub ---------- */
const ghFiles = new Map();
ghFiles.set('data/membership/claims.json', { content: JSON.stringify({ claims: [] }, null, 2), sha: 'sha-clm-0' });
function b64utf8(s) { return Buffer.from(s, 'utf8').toString('base64'); }

const sandbox = {
  console, setTimeout, clearTimeout,
  URL,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  unescape: globalThis.unescape, escape: globalThis.escape,
  Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers,
  caches: { default: { put: async () => {}, match: async () => undefined } },
  fetch: async (url, opt = {}) => {
    const u = String(url);
    if (!u.includes('api.github.com')) return { ok: false, status: 500, json: async () => ({}) };
    const m = (opt.method || 'GET').toUpperCase();
    if (m === 'GET') {
      const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
      const p = decodeURIComponent(mm[1]);
      const f = ghFiles.get(p);
      if (!f) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ sha: f.sha, content: b64utf8(f.content), encoding: 'base64' }) };
    }
    if (m === 'PUT') {
      const mm = /\/contents\/(.+?)(\?|$)/.exec(u);
      const p = decodeURIComponent(mm[1]);
      const body = JSON.parse(opt.body);
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      ghFiles.set(p, { content, sha: 'sha-' + Math.random().toString(36).slice(2, 8) });
      return { ok: true, status: 200, json: async () => ({ content: { sha: ghFiles.get(p).sha } }) };
    }
    return { ok: false, status: 405, json: async () => ({}) };
  },
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.GH_PAT = 'ghp_mocktoken';   // payEnv 读 globalThis[name]

let handler = null;
sandbox.addEventListener = (type, fn) => { if (type === 'fetch') handler = fn; };

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'cloudflare-worker-prod/worker.js'), 'utf8'), sandbox, { filename: 'worker.js' });

function claimsNow() { return JSON.parse(ghFiles.get('data/membership/claims.json').content).claims; }
async function postClaim(body) {
  const req = new Request('https://sichina.dpdns.org/pay/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const resp = await handler({ request: req, respondWith: () => {} }).catch ? null : null;
  // handler 是 (event)=>event.respondWith(fetchHandler(event.request))；直接调 fetchHandler 更稳：
  return resp;
}
// 直接驱动 fetchHandler（worker 内部函数经 addEventListener 暴露不便，改用事件对象）
async function submit(body) {
  const req = new Request('https://sichina.dpdns.org/pay/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let out = null;
  const event = { request: req, respondWith: (p) => { out = p; } };
  handler(event);
  const resp = await out;
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
// 20261016i：驱动 /pay/claims/resolve（rejected=true 为「拒绝」，false/省略为「开通」）
async function resolve(id, rejected) {
  const req = new Request('https://sichina.dpdns.org/pay/claims/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, rejected: !!rejected }),
  });
  let out = null;
  const event = { request: req, respondWith: (p) => { out = p; } };
  handler(event);
  const resp = await out;
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
// 20261016k：驱动 /auth/register（无令牌设备注册代写云端注册表）
async function authReg(body) {
  const req = new Request('https://sichina.dpdns.org/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let out = null;
  const event = { request: req, respondWith: (p) => { out = p; } };
  handler(event);
  const resp = await out;
  const j = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
function registryNow() {
  const f = ghFiles.get('data/accounts/registry.json');
  return f ? JSON.parse(f.content) : null;
}
function seedRegistry(accounts) {
  ghFiles.set('data/accounts/registry.json', {
    content: JSON.stringify({ version: 1, updatedAt: Date.now(), accounts }, null, 2),
    sha: 'sha-reg-' + Math.random().toString(36).slice(2, 8),
  });
}

const GOOD_HASH = 'pbkdf2$150000$c2FsdHNhbHQ=$aGFzaGhhc2g';
const base = (over = {}) => Object.assign({
  id: 'c_test_' + Math.random().toString(36).slice(2, 8),
  user: 'yh123', plan: '6m', ts: Date.now() - 3600000, amount: 1000, fee: 1000,
  startTs: Date.now() - 3600000, endTs: Date.now(), period: '6 个月（¥1000）', resolved: false,
}, over);

(async () => {
  /* ---- T1 快照透传 ---- */
  console.log('\n[T1] 账号快照透传');
  {
    const r = await submit(base({ acct: { username: 'yh123', hash: GOOD_HASH, role: 'user', status: 'active', trialUntil: 123, createdAt: 456 } }));
    check('提交成功', r.j && r.j.ok === true, JSON.stringify(r.j));
    const c = claimsNow().find(x => x.user === 'yh123');
    check('claims 落库且带 acct', !!c && !!c.acct, JSON.stringify(c));
    check('acct.hash 原样保留', c && c.acct && c.acct.hash === GOOD_HASH, 'hash=' + (c && c.acct && c.acct.hash));
    check('acct.username 规整为 user 字段', c && c.acct && c.acct.username === 'yh123', '');
    check('acct.createdAt 数字落库', c && c.acct && c.acct.createdAt === 456, 'createdAt=' + (c && c.acct && c.acct.createdAt));
  }

  /* ---- T2 非法快照丢弃 ---- */
  console.log('\n[T2] 非法/不符快照丢弃，不影响提交');
  {
    const r1 = await submit(base({ user: 'u_nohash', acct: { username: 'u_nohash', hash: 'plaintext' } }));
    check('哈希非 pbkdf2 → 仍提交成功', r1.j && r1.j.ok === true, JSON.stringify(r1.j));
    check('但 acct 不入库', !claimsNow().find(x => x.user === 'u_nohash').acct, 'acct leaked');
    const r2 = await submit(base({ user: 'u_mismatch', acct: { username: 'someone_else', hash: GOOD_HASH } }));
    check('用户名不一致 → 仍提交成功', r2.j && r2.j.ok === true, JSON.stringify(r2.j));
    check('但 acct 不入库', !claimsNow().find(x => x.user === 'u_mismatch').acct, 'acct leaked');
    const r3 = await submit(base({ user: 'u_array', acct: [1, 2, 3] }));
    check('acct 为数组 → 提交成功且不入库', r3.j && r3.j.ok === true && !claimsNow().find(x => x.user === 'u_array').acct, JSON.stringify(r3.j));
  }

  /* ---- T3 未决申请重新提交即取代 ---- */
  console.log('\n[T3] 同用户同套餐未决申请 → 重新提交取代最新');
  {
    const before = claimsNow().filter(c => c.user === 'yh123').length;
    const r = await submit(base({ ts: Date.now(), amount: 1200, acct: { username: 'yh123', hash: GOOD_HASH } }));
    check('重新提交成功', r.j && r.j.ok === true && r.j.replaced === true, JSON.stringify(r.j));
    const list = claimsNow().filter(c => c.user === 'yh123');
    check('仍只有一条未决申请（不堆积）', list.length === before && list.length === 1, 'n=' + list.length);
    check('被最新提交取代（金额/时间为新值）', list[0] && Number(list[0].amount) === 1200 && list[0].ts > Date.now() - 60000, JSON.stringify(list[0]));
  }

  /* ---- T4 不同套餐并存 + 已 resolved 不被替换 ---- */
  console.log('\n[T4] 不同套餐并存；已 resolved 旧申请不被替换');
  {
    await submit(base({ user: 'multi', plan: '6m' }));
    await submit(base({ user: 'multi', plan: '1y' }));
    check('同用户不同套餐各一条', claimsNow().filter(c => c.user === 'multi').length === 2, 'n=' + claimsNow().filter(c => c.user === 'multi').length);
    // 造一条已 resolved 的旧申请
    const all = claimsNow();
    all.push({ id: 'c_old_resolved', user: 'resolveduser', plan: '6m', ts: 1, resolved: true });
    ghFiles.set('data/membership/claims.json', { content: JSON.stringify({ claims: all }, null, 2), sha: 'sha-x' });
    const r = await submit(base({ user: 'resolveduser', plan: '6m', amount: 999 }));
    check('已 resolved 旧申请保留，新申请另起一条', r.j && r.j.ok === true && claimsNow().filter(c => c.user === 'resolveduser').length === 2, 'n=' + claimsNow().filter(c => c.user === 'resolveduser').length);
  }

  /* ---- T5 无 GH_PAT → 503 ---- */
  console.log('\n[T5] 无 GH_PAT 保持 503');
  {
    delete sandbox.GH_PAT;
    const r = await submit(base({ user: 'nopat' }));
    check('无令牌 → 503 且提示发给管理员', r.status === 503 && /发给管理员/.test(r.j.error || ''), JSON.stringify(r.j));
    sandbox.GH_PAT = 'ghp_mocktoken';
  }

  /* ---- T6 拒绝标记（20261016i：/pay/claims/resolve rejected=true） ---- */
  console.log('\n[T6] 拒绝标记：resolved + rejected + rejectedAt，被拒后重交生成新未决申请');
  {
    const r0 = await submit(base({ user: 'rejectme', plan: '6m', amount: 1000 }));
    check('先提交一条未决申请', r0.j && r0.j.ok === true, JSON.stringify(r0.j));
    const c = claimsNow().find(x => x.user === 'rejectme');
    check('申请存在且未决', !!c && !c.resolved, JSON.stringify(c));
    const rj = await resolve(c.id, true);
    check('拒绝标记成功且回执 rejected=true', rj.j && rj.j.ok === true && rj.j.rejected === true, JSON.stringify(rj.j));
    const c2 = claimsNow().find(x => x.id === c.id);
    check('resolved 与 rejected 均置位', !!c2 && c2.resolved === true && c2.rejected === true, JSON.stringify(c2));
    check('rejectedAt 已记录', !!c2 && Number(c2.rejectedAt) > 0, 'rejectedAt=' + (c2 && c2.rejectedAt));
    // 被拒后重新提交：旧申请已 resolved，去重逻辑不再取代它 → 生成新的未决申请
    const rr = await submit(base({ user: 'rejectme', plan: '6m', amount: 1000 }));
    check('被拒后重新提交成功且不取代旧申请', rr.j && rr.j.ok === true && rr.j.replaced === false, JSON.stringify(rr.j));
    const mine = claimsNow().filter(x => x.user === 'rejectme');
    check('同一用户现有两条申请（旧已拒 + 新未决）', mine.length === 2, 'n=' + mine.length);
    check('其中恰一条未决（新申请进入审核区）', mine.filter(x => !x.resolved).length === 1, 'n=' + mine.filter(x => !x.resolved).length);
  }

  /* ---- T7 普通 resolve 不写 rejected 字段（与拒绝互不污染） ---- */
  console.log('\n[T7] 普通开通标记只置 resolved，不写 rejected');
  {
    const r0 = await submit(base({ user: 'plainresolve' }));
    const c = claimsNow().find(x => x.user === 'plainresolve');
    const rj = await resolve(c.id, false);
    check('普通开通标记成功且回执 rejected=false', rj.j && rj.j.ok === true && rj.j.rejected === false, JSON.stringify(rj.j));
    const c2 = claimsNow().find(x => x.id === c.id);
    check('resolved=true 但不带 rejected/rejectedAt', !!c2 && c2.resolved === true && !c2.rejected && !c2.rejectedAt, JSON.stringify(c2));
  }

  /* ---- T8 全新注册：写云端注册表（20261016k） ---- */
  console.log('\n[T8] /auth/register 全新注册 → 注册表落库（active + 1天试用）');
  {
    ghFiles.delete('data/accounts/registry.json');   // 注册表文件不存在 → 现场创建
    const r = await authReg({
      username: 'newuser', hash: GOOD_HASH,
      trialUntil: Date.now() + 86400000, trialDays: 1, createdAt: Date.now() - 5000,
    });
    check('注册成功', r.j && r.j.ok === true, JSON.stringify(r.j));
    const reg = registryNow();
    const a = reg && reg.accounts && reg.accounts['newuser'];
    check('注册表已创建且含该账号', !!a, JSON.stringify(reg));
    check('状态 active（管理员审核通过区可见）', a && a.status === 'active', 'status=' + (a && a.status));
    check('角色一律 user（防提权）', a && a.role === 'user', 'role=' + (a && a.role));
    check('哈希原样落库', a && a.hash === GOOD_HASH, 'hash=' + (a && a.hash));
    check('试用期 1 天', a && a.trialDays === 1 && Number(a.trialUntil) > Date.now(), JSON.stringify({ d: a && a.trialDays, u: a && a.trialUntil }));
    check('registerDate 缺省为空串', a && a.registerDate === '', 'rd=' + (a && a.registerDate));
    check('updatedAt 已写', a && Number(a.updatedAt) > 0, '');
  }

  /* ---- T9 占用口径：active / admin / 付费 → 409 不覆盖 ---- */
  console.log('\n[T9] 已存在同名账号的占用口径（active/admin/付费 → 409）');
  {
    seedRegistry({
      activeguy: { hash: GOOD_HASH, role: 'user', status: 'active', trialUntil: Date.now() + 86400000, createdAt: 1, updatedAt: 1 },
      adminboss: { hash: GOOD_HASH, role: 'admin', status: 'active', createdAt: 1, updatedAt: 1 },
      paidvip: { hash: GOOD_HASH, role: 'user', status: 'active', payMembershipUntil: Date.now() + 86400000 * 200, createdAt: 1, updatedAt: 1 },
    });
    const before = JSON.stringify(registryNow().accounts);
    const r1 = await authReg({ username: 'activeguy', hash: 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo' });
    check('已存在 active 同名 → 409 拒绝', r1.status === 409 && r1.j && r1.j.ok === false, JSON.stringify(r1.j));
    check('拒绝提示「该用户名已被使用」', /已被使用/.test((r1.j && r1.j.error) || ''), JSON.stringify(r1.j));
    const r2 = await authReg({ username: 'adminboss', hash: 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo' });
    check('已存在管理员同名 → 409 拒绝（防提权/抢名）', r2.status === 409, JSON.stringify(r2.j));
    const r3 = await authReg({ username: 'paidvip', hash: 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo' });
    check('已存在付费会员同名 → 409 拒绝（不覆盖付费权益）', r3.status === 409, JSON.stringify(r3.j));
    check('三个账号在注册表中均未被改动', JSON.stringify(registryNow().accounts) === before, 'registry mutated');
  }

  /* ---- T10 pending / rejected → 允许覆盖（主人认领/重新申请） ---- */
  console.log('\n[T10] 已存在 pending / rejected 同名 → 覆盖为 active');
  {
    seedRegistry({
      pendguy: { hash: 'pbkdf2$150000$b2xkc2FsdA$vbGRoYXNo', role: 'user', status: 'pending', createdAt: 1, updatedAt: 1 },
      rejeguy: { hash: 'pbkdf2$150000$b2xkc2FsdA$vbGRoYXNo', role: 'user', status: 'rejected', createdAt: 1, updatedAt: 1 },
    });
    const r1 = await authReg({ username: 'pendguy', hash: GOOD_HASH, trialUntil: Date.now() + 86400000 });
    check('pending 同名 → 覆盖成功', r1.j && r1.j.ok === true, JSON.stringify(r1.j));
    check('覆盖后为 active 且哈希更新', registryNow().accounts['pendguy'].status === 'active' && registryNow().accounts['pendguy'].hash === GOOD_HASH, JSON.stringify(registryNow().accounts['pendguy']));
    const r2 = await authReg({ username: 'rejeguy', hash: GOOD_HASH, trialUntil: Date.now() + 86400000 });
    check('rejected 同名 → 覆盖成功', r2.j && r2.j.ok === true, JSON.stringify(r2.j));
    check('覆盖后为 active', registryNow().accounts['rejeguy'].status === 'active', 'status=' + registryNow().accounts['rejeguy'].status);
  }

  /* ---- T11 参数校验 ---- */
  console.log('\n[T11] 参数校验（用户名/哈希/试用期）');
  {
    seedRegistry({});
    const r1 = await authReg({ username: 'x', hash: GOOD_HASH });
    check('用户名过短 → 400', r1.status === 400, JSON.stringify(r1.j));
    const r2 = await authReg({ username: 'okname', hash: 'plaintext-not-pbkdf2' });
    check('哈希非 pbkdf2$ → 400', r2.status === 400, JSON.stringify(r2.j));
    const r3 = await authReg({ username: 'okname', hash: 'pbkdf2$150000$onlythree' });
    check('哈希段数不足 → 400', r3.status === 400, JSON.stringify(r3.j));
    const r4 = await authReg({ username: 'okname!' , hash: GOOD_HASH });
    check('用户名含非法字符 → 400', r4.status === 400, JSON.stringify(r4.j));
    const r5 = await authReg({ username: '中文名ok', hash: GOOD_HASH, trialUntil: Date.now() + 86400000 });
    check('中文用户名合法 → 成功', r5.j && r5.j.ok === true, JSON.stringify(r5.j));
    // 试用期异常值按无试用处理，不拒请求
    const r6 = await authReg({ username: 'weirdtrial', hash: GOOD_HASH, trialUntil: Date.now() + 86400000 * 3650 });
    check('试用期超 30 天 → 仍成功但按无试用落库', r6.j && r6.j.ok === true && registryNow().accounts['weirdtrial'].trialUntil === 0, JSON.stringify(r6.j));
  }

  /* ---- T12 无 GH_PAT → 503 ---- */
  console.log('\n[T12] 无 GH_PAT → 503（注册同步通道未配置）');
  {
    seedRegistry({});
    delete sandbox.GH_PAT;
    const r = await authReg({ username: 'nopatuser', hash: GOOD_HASH });
    check('无令牌 → 503', r.status === 503 && /未配置/.test(r.j.error || ''), JSON.stringify(r.j));
    check('未写入注册表', !registryNow().accounts['nopatuser'], 'leaked');
    sandbox.GH_PAT = 'ghp_mocktoken';
  }

  /* ---- T13 幂等重试：重复注册同一账号（pending 覆盖后二次提交） ---- */
  console.log('\n[T13] 同一账号覆盖为 active 后，二次注册被 409 拒绝（防重复覆盖）');
  {
    seedRegistry({});
    await authReg({ username: 'twice', hash: GOOD_HASH, trialUntil: Date.now() + 86400000 });
    const r = await authReg({ username: 'twice', hash: 'pbkdf2$150000$b3RoZXJzYWx0$b3RoZXJoYXNo', trialUntil: Date.now() + 86400000 });
    check('二次注册（已是 active）→ 409', r.status === 409, JSON.stringify(r.j));
    check('哈希保持首次那份', registryNow().accounts['twice'].hash === GOOD_HASH, 'hash overwritten');
  }

  /* ---- T14 会员字段透传（20261016l：创建并开通后经本端点落库） ---- */
  console.log('\n[T14] /auth/register 透传会员字段（账号+会员一次落库）');
  {
    seedRegistry({});
    const until = Date.now() + 86400000 * 700;
    const paidAt = Date.now() - 3600000;
    const r = await authReg({
      username: 'claimnew', hash: GOOD_HASH, status: 'active',
      trialUntil: 0, registerDate: '2026-10-17',
      payMembershipUntil: until, paidAt: paidAt, paidPlan: '2y', paidAmount: 4000, quotaMonths: 24,
      createdAt: Date.now() - 10000,
    });
    check('带会员字段注册成功', r.j && r.j.ok === true, JSON.stringify(r.j));
    const a = registryNow().accounts['claimnew'];
    check('payMembershipUntil 落库', !!a && Number(a.payMembershipUntil) === until, 'until=' + (a && a.payMembershipUntil));
    check('quotaMonths=24 落库', !!a && a.quotaMonths === 24, 'q=' + (a && a.quotaMonths));
    check('paidPlan=2y 落库', !!a && a.paidPlan === '2y', 'plan=' + (a && a.paidPlan));
    check('paidAmount=4000 落库', !!a && a.paidAmount === 4000, 'amt=' + (a && a.paidAmount));
    check('paidAt 落库', !!a && Number(a.paidAt) === paidAt, 'paidAt=' + (a && a.paidAt));
    check('角色仍为 user（不带管理员权限）', !!a && a.role === 'user', 'role=' + (a && a.role));
  }

  /* ---- T15 同哈希 upsert（20261016l：主人/管理员同步最新状态可覆盖） ---- */
  console.log('\n[T15] 同一哈希的 active 账号 → 允许覆盖更新（会员写入）');
  {
    const until = Date.now() + 86400000 * 700;
    seedRegistry({
      upsertguy: { hash: GOOD_HASH, role: 'user', status: 'active', trialUntil: Date.now() + 86400000, createdAt: 1, updatedAt: 1 },
    });
    const r = await authReg({
      username: 'upsertguy', hash: GOOD_HASH, status: 'active',
      payMembershipUntil: until, paidAt: Date.now(), paidPlan: '2y', paidAmount: 4000, quotaMonths: 24,
    });
    check('同哈希 active → 覆盖成功（不 409）', r.j && r.j.ok === true, JSON.stringify(r.j));
    const a = registryNow().accounts['upsertguy'];
    check('会员字段已更新', !!a && Number(a.payMembershipUntil) === until && a.quotaMonths === 24, JSON.stringify(a));
  }

  /* ---- T16 同哈希 upsert 不把管理员降级 ---- */
  console.log('\n[T16] 同哈希覆盖时保留已有 admin 角色（不降级）');
  {
    seedRegistry({
      adminkeep: { hash: GOOD_HASH, role: 'admin', status: 'active', createdAt: 1, updatedAt: 1 },
    });
    const r = await authReg({ username: 'adminkeep', hash: GOOD_HASH, status: 'active', trialUntil: Date.now() + 86400000 });
    check('同哈希覆盖成功', r.j && r.j.ok === true, JSON.stringify(r.j));
    check('角色仍为 admin', registryNow().accounts['adminkeep'].role === 'admin', 'role=' + registryNow().accounts['adminkeep'].role);
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
