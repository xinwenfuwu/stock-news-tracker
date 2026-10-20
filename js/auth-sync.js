/* ============================================================
 * auth-sync.js — 跨设备免码登录：浏览器 ↔ GitHub 公开注册表 的桥接层
 *
 * 思路（无需 Cloudflare Worker / 任何服务端）：
 *  - 共享账号表存为仓库里的公开文件 data/accounts/registry.json，
 *    由 GitHub Pages 直接托管，任何设备「读」都免鉴权（同源 GET）。
 *  - 「写」（新增 / 审核 / 停用）只在管理员设备发生，走 GitHub Contents API，
 *    用管理员在「设置」里填的 GitHub 细粒度令牌（仅本仓库 Contents 读写）。
 *  - 普通用户在他设备上登录时，只「读」注册表、本地校验密码，即可登录，
 *    无需再粘贴准入码。
 *
 * 配置（独立 localStorage 键，不进 D.settings，避免随设置导出泄露）：
 *   snt-auth-admin-token —— GitHub 细粒度 PAT（仅管理员设备填，用于写入）
 *
 * 安全说明：registry.json 是公开文件，会包含「用户名 + PBKDF2 密码哈希(带每账号随机盐)」。
 *   哈希用 15 万次 PBKDF2-SHA256 + 随机盐，离线爆破成本很高；这与「准入码」里本来就会
 *   携带哈希是同等暴露级别。写入令牌（PAT）绝不进注册表，只存在于管理员浏览器 localStorage。
 *   若需更强隔离（不公开账号表），可改用 worker/ 下的 Cloudflare Worker 方案。
 *
 * 所有请求失败都走「本地 + 准入码」兜底，不会把用户挡在门外。
 * ============================================================ */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'snt-auth-admin-token';
  var REGISTRY_PATH = 'data/accounts/registry.json';
  var REPO_OWNER = 'xinwenfuwu';
  var REPO_NAME = 'stock-news-tracker';
  var REPO_BRANCH = 'main';

  /* ---------- 静态文件基址：Cloudflare 托管时统一走代理 Worker ----------
   * GitHub Pages：同源相对路径（data/... 由 Pages 托管，免鉴权同源 GET）。
   * Cloudflare Workers / Pages：页面与 GitHub 不同源，直接 fetch github.io 会被 CORS 拦，
   *   故统一改走 snt-registry-proxy Worker（Cloudflare 边缘回源 GitHub，补 CORS 头）。
   *   注意：写操作仍走下方 gh() → api.github.com，读写同指 GitHub 仓库，
   *   不会出现「Cloudflare 读到旧快照、GitHub 才是新数据」的分裂。
   *   REGISTRY_PATH / MEMBER_*_PATH 仍保持「仓库内相对路径」不变（写接口按它拼 URL）。 */
  var REGISTRY_PROXY_BASE = 'https://snt-registry-proxy.hui-zhou.workers.dev';
  function isCfHost() {
    try {
      var h = String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
      return /(^|\.)workers\.dev$/.test(h) || /(^|\.)pages\.dev$/.test(h);
    } catch (e) { return false; }
  }
  /** 把仓库内相对路径解析成「当前宿主可读」的 URL。 */
  function staticUrl(path) {
    var p = String(path || '').replace(/^\/+/, '');
    return isCfHost() ? (REGISTRY_PROXY_BASE + '/' + p) : p;
  }

  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function isAdminConfigured() { return !!getToken(); }

  /** 读取注册表：同源静态文件，免鉴权。失败返回空表，绝不抛异常。
   *  加时间戳参数绕开 GitHub Pages 的 CDN 缓存 —— 否则管理员刚开通的会员 / 刚变更的状态
   *  最长要等十几分钟才能在别的设备上看到。 */
  function readRegistry() {
    return fetch(staticUrl(REGISTRY_PATH) + '?_=' + Date.now(), { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return { version: 1, updatedAt: null, accounts: {} };
        return r.json().catch(function () { return { version: 1, updatedAt: null, accounts: {} }; });
      })
      .then(function (j) {
        if (!j || typeof j !== 'object' || !j.accounts || typeof j.accounts !== 'object') {
          return { version: 1, updatedAt: null, accounts: {} };
        }
        return j;
      })
      .catch(function () { return { version: 1, updatedAt: null, accounts: {} }; });
  }

  /** UTF-8 安全转 base64（用于把注册表 JSON 写进 GitHub） */
  function b64utf8(str) {
    try { return btoa(unescape(encodeURIComponent(str))); }
    catch (e) {
      var bytes = new TextEncoder().encode(str);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
  }

  function apiHeaders(token) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'snt-auth-registry',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': token ? ('Bearer ' + token) : ''
    };
  }

  function gh(path, method, token, body) {
    var url = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + path;
    var opt = { method: method, headers: apiHeaders(token), cache: 'no-store' };
    if (body) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, body: j || {} };
      });
    });
  }

  /** 写入整个注册表（带 sha 冲突重试一次） */
  function writeRegistry(reg) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: '未配置 GitHub 令牌' });
    var content = b64utf8(JSON.stringify(reg, null, 2));
    function doPut(sha) {
      var body = { message: 'chore(auth): sync account registry', content: content, branch: REPO_BRANCH };
      if (sha) body.sha = sha;
      return gh('/contents/' + REGISTRY_PATH, 'PUT', token, body).then(function (res) {
        if (res.ok) return { ok: true };
        if (res.status === 409 && !sha) {
          // 并发冲突：重新拿 sha 再试一次
          return gh('/contents/' + REGISTRY_PATH + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
            return doPut(g.body && g.body.sha ? g.body.sha : null);
          });
        }
        var errs = res.body && res.body.errors;
        var msg = (res.body && res.body.message)
          || (errs && errs[0] && errs[0].message)
          || ('HTTP ' + res.status);
        return { ok: false, error: msg };
      });
    }
    return gh('/contents/' + REGISTRY_PATH + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
      return doPut(g.body && g.body.sha ? g.body.sha : null);
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  /** 归一化「已核对开通申请 id」数组：去重、最多保留最近 30 条（与 auth.js claimIdList 同口径）。 */
  function claimIdList(src) {
    var arr = (src && Array.isArray(src)) ? src : [];
    var seen = {}, out = [];
    arr.forEach(function (x) {
      var s = String(x == null ? '' : x).trim();
      if (s && !seen[s]) { seen[s] = 1; out.push(s); }
    });
    return out.slice(-30);
  }

  /** 写入单个用户（upsert）。record 来自本地账号，仅挑注册表需要的字段。 */
  function writeUser(record) {
    if (!record || !record.username) return Promise.resolve({ ok: false, error: '缺少用户名' });
    var uname = String(record.username);
    return readRegistry().then(function (reg) {
      reg.version = reg.version || 1;
      reg.updatedAt = Date.now();
      reg.accounts = reg.accounts || {};
      reg.accounts[uname] = {
        hash: record.hash || '',
        // 20261019b：可还原密码 seal（pwSeal）一并落云端，使管理员刷新后可在面板查看/复制明文密码
        // （用户已接受：注册表为公开文件，sealed 密码等同明文）。本次记录未携带 pwSeal 时不覆盖云端已有值，
        // 避免管理员重新提交 / 仅改其它字段时把已有的可显示密码洗掉。
        pwSeal: (record.pwSeal || (reg.accounts[uname] && reg.accounts[uname].pwSeal) || ''),
        role: record.role || 'user',
        status: record.status || 'pending',
        disabled: !!record.disabled,
        trialUntil: record.trialUntil || 0,
        trialDays: record.trialDays || 0,
        quotaMonths: record.quotaMonths || 0,
        disableDate: record.disableDate || '',
        registerDate: record.registerDate || '',
        payMembershipUntil: record.payMembershipUntil || 0,   // batch-A：扫码/后台开通的会员到期时间戳(ms)
        paidAt: Number(record.paidAt) || 0,                   // 20261007q：支付日期(ms)
        paidPlan: record.paidPlan || '',                      // 20261007q：支付套餐 6m / 1y / 2y
        paidAmount: Number(record.paidAmount) || 0,           // 20261007q：实付金额
        paidClaimIds: claimIdList(record.paidClaimIds),        // 20261018e：已核对开通的申请 id（审核区去重依据）
        placeholder: !!record.placeholder,                     // 20261018e：占位会员凭证（无密码、仅带会员到期时间）
        createdAt: record.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      return writeRegistry(reg);
    });
  }

  /* ---------- 会员相关共享文件（个人收款码配置 / 待开通记录），复用同一套 GitHub 读写 ---------- */
  var MEMBER_CFG_PATH = 'data/membership/config.json';
  var MEMBER_CLAIMS_PATH = 'data/membership/claims.json';

  /** 读取静态 JSON 文件；bust=true 时追加时间戳参数，绕开 GitHub Pages 的 CDN 缓存。 */
  function readJsonFile(path, bust) {
    var base = staticUrl(path);
    var url = base + (bust ? ((base.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now()) : '');
    return fetch(url, { method: 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      })
      .catch(function () { return null; });
  }
  function writeJsonFile(path, obj, message) {
    var token = getToken();
    if (!token) return Promise.resolve({ ok: false, error: '未配置 GitHub 令牌' });
    var content = b64utf8(JSON.stringify(obj, null, 2));
    function doPut(sha) {
      var body = { message: message || 'chore(membership): update ' + path, content: content, branch: REPO_BRANCH };
      if (sha) body.sha = sha;
      return gh('/contents/' + path, 'PUT', token, body).then(function (res) {
        if (res.ok) return { ok: true };
        if (res.status === 409 && !sha) {
          return gh('/contents/' + path + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
            return doPut(g.body && g.body.sha ? g.body.sha : null);
          });
        }
        var errs = res.body && res.body.errors;
        var msg = (res.body && res.body.message) || (errs && errs[0] && errs[0].message) || ('HTTP ' + res.status);
        return { ok: false, error: msg };
      });
    }
    return gh('/contents/' + path + '?ref=' + REPO_BRANCH, 'GET', token).then(function (g) {
      return doPut(g.body && g.body.sha ? g.body.sha : null);
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  /** 读取个人收款码配置（公开，免鉴权） */
  function readMembershipConfig() { return readJsonFile(MEMBER_CFG_PATH); }
  /** 写入个人收款码配置（管理员令牌） */
  function writeMembershipConfig(cfg) { return writeJsonFile(MEMBER_CFG_PATH, cfg || {}, 'chore(membership): update config'); }

  /* ---------- 20261012e：会员到期时间查询（登录门禁兜底用） ---------- */

  /** 会员后端基地址：优先页面注入的 __SNT_MEMBER_API__（业务层按用户设置回填），否则用加速域名 */
  function memberApiBase() {
    var b = (typeof window !== 'undefined' && window.__SNT_MEMBER_API__) ? String(window.__SNT_MEMBER_API__).trim().replace(/\/+$/, '') : '';
    if (b) return b;
    var a = (typeof window !== 'undefined' && window.__SNT_ACCEL__) ? String(window.__SNT_ACCEL__).trim().replace(/\/+$/, '') : '';
    return a || '';
  }

  /**
   * 20261018g：写入通道候选地址（按优先级）。
   * 主地址取自页面注入（默认 sichina.dpdns.org）。若该域名 DNS 未委派到 Cloudflare
   * （表现为 A 记录停在 192.0.2.1 占位、Worker 路由永远不可达），写入会静默失败，
   * 导致「注册成功却只落本机 → 换设备/换入口登录报密码不正确、管理员在后端看不到」。
   * 因此追加 Worker 自身的 *.workers.dev 地址作为兜底通道——它始终可达
   * （仅国内部分网络对 *.workers.dev 有拦截，故仍放在次选）。
   */
  function workerDevUrl() {
    // 账号所在 Cloudflare 账号的 workers.dev 子域（deploy-stock-edge.js 部署脚本名 stock-edge）
    return 'https://stock-edge.hui-zhou.workers.dev';
  }
  /** 国内可达的 Worker 主域（与 index.html 注入的 __SNT_ACCEL__ 同一实例 stock-edge）。
   *  实测：本机/国内直连 *.workers.dev 全部超时，而该自定义域 1 秒内返回，
   *  故把它固定加入候选，避免管理员在「设置 → 代理地址」里填了失效地址后，
   *  开通/审核/写申请状态全部静默失败（本次「审核后刷新又回来」的根因之一）。 */
  var PRIMARY_MEMBER_API = 'https://sichina.dpdns.org';
  function memberApiBases() {
    var out = [];
    var p = memberApiBase();
    if (p) out.push(p);
    if (out.indexOf(PRIMARY_MEMBER_API) < 0) out.push(PRIMARY_MEMBER_API);
    var fb = workerDevUrl();
    if (fb && out.indexOf(fb) < 0) out.push(fb);
    return out;
  }

  /**
   * 20261018g：依次尝试多个写入通道，直到拿到业务成功的响应或确定失败。
   * - 网络异常 / 超时（视为该通道不可用）→ 试下一个候选地址；
   * - 4xx（403 密钥错 / 409 抢名 / 400 参数错等确定性失败）→ 立即返回，不再试下一个（避免重复写）；
   * - 2xx 且业务 ok → 成功。
   * 每个通道带 6s 超时，避免某个死域名长时间挂起拖垮注册/开通流程。
   */
  function fetchFirstAvailable(path, bodyObj) {
    var bases = memberApiBases();
    var lastErr = { ok: false, error: '未配置后端写入地址' };
    function go(i) {
      if (i >= bases.length) return Promise.resolve(lastErr);
      var base = bases[i];
      var sig = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(6000) : null;
      var opt = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, cache: 'no-store', body: JSON.stringify(bodyObj) };
      if (sig) opt.signal = sig;
      return Promise.resolve(fetch(base + path, opt)).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j && j.ok) return { ok: true, status: r.status, body: j };
          if (r.status >= 400 && r.status < 500) return { ok: false, status: r.status, body: j, stop: true };
          lastErr = { ok: false, status: r.status, error: (j && j.error) ? String(j.error) : ('HTTP ' + r.status) };
          return go(i + 1);
        });
      }).catch(function (e) {
        lastErr = { ok: false, error: String((e && e.message) || e) };
        return go(i + 1);
      });
    }
    return go(0);
  }

  /**
   * 查会员后端（Cloudflare Worker KV）里某用户的会员到期时间。
   * 商户扫码支付成功回调会写这个 KV；管理员「核对并开通」也会尽量同步到这里。
   * 任何失败都返回 { ok:false, until:0 }，绝不抛异常（门禁兜底不能把用户挡在门外）。
   */
  function queryMembershipRemote(username) {
    var bases = memberApiBases();
    var uname = String(username == null ? '' : username).trim();
    if (!uname) return Promise.resolve({ ok: false, until: 0 });
    function go(i) {
      if (i >= bases.length) return Promise.resolve({ ok: false, until: 0 });
      var base = bases[i];
      var sig = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(6000) : null;
      var opt = { headers: { 'Accept': 'application/json' }, cache: 'no-store' };
      if (sig) opt.signal = sig;
      return Promise.resolve(fetch(base + '/pay/membership?user=' + encodeURIComponent(uname), opt)).then(function (r) {
        if (!r.ok) { return go(i + 1); }
        return r.json().catch(function () { return {}; });
      }).then(function (j) {
        return { ok: true, until: Number(j && j.until) || 0 };
      }).catch(function () { return go(i + 1); });
    }
    return go(0);
  }
  /** 读取待开通记录（公开，免鉴权）。始终带时间戳参数，保证管理员点「刷新」拿到的是最新申请。 */
  function readClaims() {
    return readJsonFile(MEMBER_CLAIMS_PATH, true).then(function (j) {
      if (j && Array.isArray(j.claims)) return { ok: true, claims: j.claims };
      return { ok: true, claims: [] };
    });
  }
  /** 覆盖写入待开通记录（管理员令牌 / Worker 持 GH_PAT 调用） */
  function writeClaims(claims) { return writeJsonFile(MEMBER_CLAIMS_PATH, { claims: Array.isArray(claims) ? claims : [] }, 'chore(membership): update claims'); }
  /**
   * 20261016r：把某条申请在后端 claims.json 标记为已处理。
   * · rejected=true → resolved=true + rejected=true + rejectedAt（从审核区移除，留审计）；
   * · rejected=false（默认）→ 仅 resolved=true（核对并开通后让申请不再回显）。
   * 读取公开、写入需令牌（管理员 GitHub 令牌 / Worker 持 GH_PAT）。
   * 返回 { ok, changed, error }。找不到该申请（可能已被清理）时 ok=true、changed=false。
   *
   * 用途：用户管理「保存设置」按钮把本机已拒绝 / 已通过的申请状态可靠写回云端，
   * 实现「拒绝通过 → 保存设置 → 强制刷新（甚至换设备）后该申请永不重现审核区」。
   */
  function markClaimResolved(id, opts) {
    var o = opts || {};
    var rejected = o.rejected === true;
    return readClaims().then(function (rd) {
      var all = (rd && rd.claims) || [];
      var t = all.find(function (c) { return c.id === id; });
      if (!t) return { ok: true, changed: false, notFound: true };
      if (t.resolved && (!rejected || t.rejected)) return { ok: true, changed: false };
      t.resolved = true;
      if (rejected) { t.rejected = true; t.rejectedAt = Number(t.rejectedAt) || Date.now(); }
      return writeClaims(all).then(function (wr) {
        return { ok: !!(wr && wr.ok), changed: !!(wr && wr.ok), error: wr && wr.error };
      });
    }).catch(function (e) {
      return { ok: false, changed: false, error: String((e && e.message) || e) };
    });
  }

  /**
   * 20261018h：把某条申请在云端标记为已处理（resolved / rejected），走多通道兜底。
   * 与 markClaimResolved（需 GitHub 令牌直写）互补：本函数借 Worker 的 GH_PAT，管理员浏览器
   * 没配令牌也能标；并且按 memberApiBases() 依次尝试，主地址失效时自动换国内可达域，
   * 避免「返回 200 假成功 / 请求根本没发出去」导致审核区反复重现。
   * @returns {Promise<{ok:boolean, found:boolean, status?:number, error?:string}>}
   *   found=false 表示云端申请列表里已没有这条 id（可能已被清理）——调用方按「已处理」对待。
   */
  function resolveClaimRemote(id, rejected) {
    var cid = String(id == null ? '' : id).trim();
    if (!cid) return Promise.resolve({ ok: false, found: false, error: '缺少申请 id' });
    return fetchFirstAvailable('/pay/claims/resolve', { id: cid, rejected: !!rejected }).then(function (res) {
      var ok = !!(res && res.ok);
      return {
        ok: ok,
        found: ok && !(res.body && res.body.found === false),
        status: (res && res.status) || 0,
        error: ok ? '' : ((res && res.error) || ('HTTP ' + ((res && res.status) || 0)))
      };
    }).catch(function (e) {
      return { ok: false, found: false, error: String((e && e.message) || e) };
    });
  }

  /** 20261019d：时间戳 → YYYY-MM-DD（仅用于登录回执文案，不依赖其它模块） */
  function fmtDateNum(ts) {
    var d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '—';
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }

  /**
   * 20261019d：把注册表条目组装成登录回执（统一状态校验 + 授权字段 + 云端凭证）。
   * @param {Object} acc 注册表条目
   * @param {boolean} matchedBySeal 云端无哈希、用 pwSeal 明文比对通过
   */
  function grantFromRecord(acc, matchedBySeal) {
    var st = acc.status || 'pending';
    if (st === 'pending') return { ok: false, status: 'pending', error: '该账号正在等待管理员审核，通过后即可直接登录' };
    if (st === 'rejected') return { ok: false, status: 'rejected', error: '该注册申请未通过审核，请联系管理员' };
    if (acc.disabled) return { ok: false, status: 'disabled', error: '该账号已被停用，请联系管理员' };
    return {
      ok: true,
      grant: {
        role: acc.role || 'user',           // 20261012e：跨设备首次落地时角色以注册表为准
        trialDays: acc.trialDays || 0,
        trialUntil: acc.trialUntil || 0,
        quotaMonths: acc.quotaMonths || 0,
        disableDate: acc.disableDate || '',
        registerDate: acc.registerDate || '',
        payMembershipUntil: acc.payMembershipUntil || 0,
        paidAt: Number(acc.paidAt) || 0,
        paidPlan: acc.paidPlan || '',
        paidAmount: Number(acc.paidAmount) || 0,
        // 20261019d：云端凭证回传（本机落地时可直接采用，避免「云端有密码、本机却建不出账号」）
        hash: acc.hash || '',
        pwSeal: acc.pwSeal || '',
        matchedBySeal: !!matchedBySeal,
        loginReady: true
      }
    };
  }

  /** 登录：读注册表 → 校验密码 → 返回授权或状态。找不到用户返回 {} 让 auth.js 回落本地。 */
  function loginRemote(username, password) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname || !password) return Promise.resolve({});
    return readRegistry().then(function (reg) {
      var acc = reg.accounts && reg.accounts[uname];
      // 20261016k：注册表里没有这个账号时返回 { notFound: true }（仍回落本地登录），
      // 让 auth.js 在本地登录成功后补写一次云端——注册时离线没同步上的账号，
      // 下次登录即进入云端注册表，管理员的「审核通过区」随之可见。
      if (!acc) return { notFound: true };
      // 20261019d：云端「占位会员凭证」没有哈希（hash:''），此前直接返回 notFound 回落本地，
      // 用户换设备登录时本机无该账号 → 报「用户名或密码不正确」，即便会员早已开通也无法登录。
      // 处理顺序：① 有 hash → 正常校验；② 无 hash 但有 pwSeal → 用可还原密码比对明文；
      //          ③ 两者都没有但会员在有效期内 → 返回明确的「缺登录密码」回执（不再混淆为密码错）。
      if (!acc.hash) {
        var sealedPw = '';
        if (acc.pwSeal && global.Auth && typeof global.Auth.unsealPassword === 'function') {
          try { sealedPw = global.Auth.unsealPassword(acc.pwSeal) || ''; } catch (e) { sealedPw = ''; }
        }
        if (sealedPw && sealedPw === password) {
          return grantFromRecord(acc, true);   // 明文匹配 → 视为通过，回执标记 matchedBySeal
        }
        var untilTs = Number(acc.payMembershipUntil) || 0;
        if (untilTs > Date.now()) {
          return {
            ok: false,
            status: 'nocred',
            error: '该账号会员已开通（有效期至 ' + fmtDateNum(untilTs) + '），但云端缺少登录密码'
              + (sealedPw ? '（你输入的密码与之不符）' : '')
              + '：请使用注册时设置的密码登录；若忘记密码，请联系管理员在用户管理里「重置密码」后再登录'
          };
        }
        return { notFound: true };
      }
      var verify = global.Auth
        ? global.Auth.verifyPassword(password, acc.hash)
        : Promise.resolve(false);
      return Promise.resolve(verify).then(function (ok) {
        if (!ok) {
          // 20261016d：注册表里的哈希与所输密码不符（典型：用户在别的设备改过密码但没同步上去 /
          // 管理员手动添加时设了另一套密码）→ 不再硬报「用户名或密码不正确」把用户锁死，
          // 改为返回 {} 让 auth.js 回落本机校验：本机账号表里有正确哈希就能正常登录。
          // 本机也没有该账号时，_localLogin 会给出同样的错误提示，安全性不变。
          // 20261019d：附带 mismatch + 会员到期时间，供 auth.js 生成本机也不通时的诊断文案
          // （「会员有效、只是密码不符」比笼统的「用户名或密码不正确」有用得多）。
          return { mismatch: true, until: Number(acc.payMembershipUntil) || 0, hasCred: true };
        }
        return grantFromRecord(acc, false);
      });
    }).catch(function () { return {}; });
  }

  function statusRemote(username) {
    return readRegistry().then(function (reg) {
      var acc = reg.accounts && reg.accounts[String(username)];
      return { ok: true, status: acc ? (acc.status || 'pending') : 'unknown', disabled: acc ? !!acc.disabled : false };
    }).catch(function () { return { ok: false }; });
  }

  function fetchPending() {
    return readRegistry().then(function (reg) {
      var list = [];
      var a = reg.accounts || {};
      for (var k in a) if (a[k].status === 'pending') list.push({ username: k, createdAt: a[k].createdAt || 0 });
      return { ok: true, list: list };
    }).catch(function () { return { ok: true, list: [] }; });
  }

  /* ---------- 以下为兼容 / 手动接口 ---------- */
  function approveRemote(username, grant, hash) {
    return writeUser({
      username: username, hash: hash || '', role: 'user', status: 'active',
      trialUntil: (grant && grant.trialUntil) || 0,
      quotaMonths: (grant && grant.quotaMonths) || 0,
      disableDate: (grant && grant.disableDate) || '',
      registerDate: (grant && grant.registerDate) || ''
    });
  }
  function rejectRemote(username, hash) {
    return writeUser({ username: username, hash: hash || '', role: 'user', status: 'rejected' });
  }
  function disableRemote(username, hash, disabled) {
    return writeUser({ username: username, hash: hash || '', role: 'user', status: 'active', disabled: !!disabled });
  }
  /**
   * 20261016d：从注册表删除某个账号（管理员删除用户时调用）。
   * 没有令牌时返回 skip（调用方据此决定是否提示）；删除失败绝不抛异常。
   */
  function deleteUser(username) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname) return Promise.resolve({ ok: false, error: '缺少用户名' });
    if (!isAdminConfigured()) return Promise.resolve({ ok: false, skip: true, error: '未配置 GitHub 令牌（设置 → 云端同步）' });
    return readRegistry().then(function (reg) {
      if (!reg.accounts || !reg.accounts[uname]) return { ok: true, skipped: true }; // 云端本来就没有，视为成功
      delete reg.accounts[uname];
      reg.updatedAt = Date.now();
      return writeRegistry(reg).then(function (w) {
        return w.ok ? { ok: true } : { ok: false, error: w.error || '注册表删除失败' };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }
  /** 注册写注册表需要令牌；没有令牌（普通用户设备）静默跳过，回落本地 + 准入码流程 */
  function registerRemote(username, password) {
    if (!isAdminConfigured()) return Promise.resolve({ ok: false, local: true });
    var mk = global.Auth ? global.Auth.makePasswordHash(password) : Promise.resolve(null);
    return Promise.resolve(mk).then(function (hash) {
      if (!hash) return { ok: false, local: true };
      return writeUser({ username: username, hash: hash, role: 'user', status: 'pending' });
    });
  }

  /**
   * 20261016k：无令牌设备（普通用户）注册时，经 pay Worker 把账号代写进云端注册表。
   * 与 registerRemote（需管理员令牌直写）二选一：有令牌走 GitHub 直写，无令牌走这里
   * （Worker 持 GH_PAT，落库后管理员打开用户管理即经 recoverFromRegistry 看到该账号）。
   * 任何失败都返回 { ok:false }，调用方离线兜底，不阻塞注册流程。
   */
  function registerRemoteViaWorker(acct, opts) {
    var uname = String(acct && acct.username || '').trim();
    // 20261018e：占位会员凭证（管理员为旧版无账号申请登记会籍）hash 为空、但带 placeholder 标记，
    // 允许经本端点写入云端注册表（普通账号仍要求 pbkdf2$ 哈希）。
    var isPlaceholder = !!(acct && acct.placeholder);
    if (!uname || !acct || typeof acct.hash !== 'string'
        || (acct.hash.indexOf('pbkdf2$') !== 0 && !isPlaceholder)) {
      return Promise.resolve({ ok: false, error: '参数不完整（需合法哈希）' });
    }
    var payload = {
      username: uname,
      hash: acct.hash,
      // 20261019b：把可还原密码 seal（pwSeal）一并发往 Worker 落云端，使管理员刷新后可在面板查看/复制明文密码
      // （用户已接受：注册表为公开文件，sealed 密码等同明文）。仅当本机确有 pwSeal 才携带。
      pwSeal: (typeof acct.pwSeal === 'string' && acct.pwSeal) ? acct.pwSeal : '',
      status: 'active',
      trialUntil: Number(acct.trialUntil) || 0,
      trialDays: Number(acct.trialDays) || 0,
      registerDate: typeof acct.registerDate === 'string' ? acct.registerDate : '',
      createdAt: Number(acct.createdAt) || 0,
      // 20261016l：会员字段透传——管理员「创建并开通」后经本端点把
      // 「账号 + 会员状态」一次性落库（无令牌设备也能上云）。
      payMembershipUntil: Number(acct.payMembershipUntil) || 0,
      paidAt: Number(acct.paidAt) || 0,
      paidPlan: typeof acct.paidPlan === 'string' ? acct.paidPlan : '',
      paidAmount: Number(acct.paidAmount) || 0,
      quotaMonths: Number(acct.quotaMonths) || 0,
      // 20261018e：已核对开通的申请 id + 占位标记一并上云，供跨设备审核区去重与会员认领。
      paidClaimIds: claimIdList(acct.paidClaimIds),
      placeholder: isPlaceholder,
      // 20261020c：selfSet=true 表示「本人刚设定了这个密码」（注册申请 / 登录自愈补传）。
      // Worker 端据此对普通用户账号放行哈希覆盖：否则 /auth/register 对「异哈希 + 已激活/付费」
      // 一律 409，导致「注册完用户管理里显示的还是旧密码、用户拿新密码登不上」。
      // 管理员账号（role=admin）Worker 端仍然拒绝，不会被本标记接管。
      selfSet: !!(opts && opts.selfSet)
    };
    // 20261018g：经多写入通道兜底（sichina 主 / stock-edge *.workers.dev 兜底），
    // 避免主域名 DNS 未委派时注册写入静默失败。
    return fetchFirstAvailable('/auth/register', payload).then(function (res) {
      return { ok: res.ok, status: res.status, error: (res.body && res.body.error) ? String(res.body.error) : (res.ok ? '' : '云端写入失败') };
    });
  }

  /**
   * 20261018e：管理员「重置密码」专用通道（无 GitHub 令牌也能把新哈希写进云端注册表）。
   * 普通 /auth/register 端点对「已激活账号的不同哈希」会 409（防抢名 / 防篡改），改密码走不通，
   * 故另开 /auth/admin-reset —— 仅本端点接受 resetKey（= Worker 环境变量 ADMIN_RESET_KEY）。
   * 密钥不符或 Worker 未配置该键时返回非 ok，调用方回落到「需配置 GitHub 令牌」的提示。
   */
  function adminResetRemoteViaWorker(acct, key) {
    var uname = String(acct && acct.username || '').trim();
    if (!uname || !acct || typeof acct.hash !== 'string'
        || acct.hash.indexOf('pbkdf2$') !== 0 || !key) {
      return Promise.resolve({ ok: false, error: '参数不完整（需 Worker 地址、合法哈希与重置密钥）' });
    }
    var payload = {
      username: uname,
      hash: acct.hash,
      // 20261019b：携带可还原密码 seal，使管理员重置后的密码也能在面板查看/复制（用户已接受公开暴露）
      pwSeal: (typeof acct.pwSeal === 'string' && acct.pwSeal) ? acct.pwSeal : '',
      resetKey: String(key)
    };
    // 20261018g：多写入通道兜底。
    return fetchFirstAvailable('/auth/admin-reset', payload).then(function (res) {
      return { ok: res.ok, status: res.status, error: (res.body && res.body.error) ? String(res.body.error) : (res.ok ? '' : '云端写入失败') };
    });
  }

  /**
   * 20261018f：管理员「删除账号」专用通道——无 GitHub 令牌的设备也能把账号从云端注册表真正删掉
   * （Worker 持 GH_PAT 服务端删除；否则只删本机，下次 recoverFromRegistry 又会把云端残留合并回来）。
   * 权限与 adminReset 同口径：resetKey === Worker 环境变量 ADMIN_RESET_KEY。
   */
  function adminDeleteRemoteViaWorker(username, key) {
    var uname = String(username == null ? '' : username).trim();
    if (!uname) return Promise.resolve({ ok: false, error: '参数不完整（需 Worker 地址与用户名）' });
    if (!key) return Promise.resolve({ ok: false, error: '缺少管理员删除密钥' });
    // 20261018g：多写入通道兜底。
    return fetchFirstAvailable('/auth/admin-delete', { username: uname, resetKey: String(key) }).then(function (res) {
      return { ok: res.ok, status: res.status, deleted: !!(res.body && res.body.deleted), error: (res.body && res.body.error) ? String(res.body.error) : (res.ok ? '' : '云端删除失败') };
    });
  }

  global.Auth = global.Auth || {};
  // 20261012e：登录门禁的云端会员兜底查询（auth.js 的 accessDenyWithRemote 会调用）。
  // 单独挂到 Auth 上（不进 Sync），让 auth.js 不依赖同步模块的加载顺序。
  global.Auth.remoteMembershipQuery = queryMembershipRemote;
  global.Auth.Sync = {
    TOKEN_KEY: TOKEN_KEY,
    adminToken: getToken,
    isConfigured: function () { return true; }, // 同源读注册表始终可用；写需令牌
    isAdminConfigured: isAdminConfigured,
    readRegistry: readRegistry,
    writeRegistry: writeRegistry,
    writeUser: writeUser,
    loginRemote: loginRemote,
    statusRemote: statusRemote,
    fetchPending: fetchPending,
    approveRemote: approveRemote,
    rejectRemote: rejectRemote,
    disableRemote: disableRemote,
    deleteUser: deleteUser,
    registerRemote: registerRemote,
    registerRemoteViaWorker: registerRemoteViaWorker,
    adminResetRemoteViaWorker: adminResetRemoteViaWorker,
    adminDeleteRemoteViaWorker: adminDeleteRemoteViaWorker,
    // batch-A：会员个人收款码配置 + 待开通记录（公开读、令牌写）
    MEMBER_CFG_PATH: MEMBER_CFG_PATH,
    MEMBER_CLAIMS_PATH: MEMBER_CLAIMS_PATH,
    readMembershipConfig: readMembershipConfig,
    writeMembershipConfig: writeMembershipConfig,
    readClaims: readClaims,
    writeClaims: writeClaims,
    markClaimResolved: markClaimResolved,
    resolveClaimRemote: resolveClaimRemote,
    // 20261012e：会员到期时间查询 + 后端基地址（业务层复用同一基地址）
    memberApiBase: memberApiBase,
    queryMembershipRemote: queryMembershipRemote
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Auth.Sync;
})(typeof window !== 'undefined' ? window : globalThis);
