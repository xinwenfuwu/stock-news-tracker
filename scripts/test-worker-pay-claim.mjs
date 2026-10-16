/* ============================================================
 * test-worker-pay-claim.mjs — 验证 payClaim（Worker 侧）20261016h 改动
 *
 * 1) 账号快照透传：合法快照（用户名一致 + pbkdf2 哈希）落库；结构不符/用户名不符丢弃
 * 2) 未决申请「重新提交即取代最新」：同用户同套餐的未决申请被最新提交替换
 * 3) 不同套餐可并存；已 resolved 的旧申请不被替换
 * 4) 无 GH_PAT → 503（保持原行为）
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

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
