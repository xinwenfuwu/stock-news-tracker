/* ============================================================
 * auth.js — 登录鉴权与角色权限（逻辑层，可在 Node 中直接测试）
 *
 * 第一阶段（当前）：纯浏览器本地实现
 *   · 密码用 PBKDF2-SHA256（15 万次迭代 + 每用户独立随机盐）派生，任何地方都不存明文
 *   · 登录态带签名与有效期：改角色 / 延长有效期 / 凭空伪造会话都会验签失败
 *   · 会话签名与密码哈希绑定 → 管理员改了某人的密码，那人的旧登录态立即失效
 *   · 账号表存在浏览器本地，可导出 / 导入以便迁移设备
 *
 * ⚠️ 能力边界（务必知晓）：本文件同样会下发到浏览器，
 *    它挡得住「随手点开链接的人」，挡不住「看得懂源码并愿意动手改的人」。
 *    真正的强鉴权必须把校验放到服务端 —— 见下方第二阶段。
 *
 * 第二阶段（已预留）：把 Auth.remote 指向 Cloudflare Worker 后，
 *   login / restore / listUsers / saveUsers 会自动改走远端，前端调用代码一行都不用改。
 * ============================================================ */
(function (global) {
  'use strict';

  var USERS_KEY = 'snt-auth-users-v1';
  var SESSION_KEY = 'snt-auth-session-v1';

  var ITERATIONS = 150000;
  var SALT_BYTES = 16;
  var KEY_BITS = 256;

  var TTL_DEFAULT = 7 * 24 * 3600 * 1000;   // 默认记住 7 天
  var TTL_REMEMBER = 30 * 24 * 3600 * 1000; // 勾选「记住我」30 天

  // 会话签名盐：让「直接往 localStorage 塞一个假会话」这条最省事的路径失效
  var SIGN_SALT = 'snt/auth/v1::k7Qm2Zr9LpXwR4tY';

  var ROLE = { ADMIN: 'admin', USER: 'user' };
  var ROLE_NAME = { admin: '管理员', user: '普通用户' };
  var ROLE_RANK = { admin: 2, user: 1 };

  // 账号状态：pending=待审核（可登录前必须由管理员通过）, active=正常, rejected=已驳回
  var STATUS = { PENDING: 'pending', ACTIVE: 'active', REJECTED: 'rejected' };
  var STATUS_NAME = { pending: '待审核', active: '已通过', rejected: '已驳回', disabled: '已停用', trial: '试用中' };

  var MAX_LOGIN_RECORDS = 20;   // 每人最多保留的登录记录条数
  var MAX_CODE_LEN = 8192;      // 申请码/准入码长度上限，防粘贴超大内容

  // 权限点 → 所需最低角色。未在此声明的权限点按「最高要求」处理，避免漏配后放开。
  var PERMISSIONS = {
    'data.read': ROLE.USER,
    'data.write': ROLE.USER,
    'data.export': ROLE.USER,
    'data.import': ROLE.ADMIN,
    'data.clear': ROLE.ADMIN,
    'settings.write': ROLE.ADMIN,
    'users.manage': ROLE.ADMIN
  };

  var USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5.-]{2,20}$/;
  var PASSWORD_MIN = 8;
  var PASSWORD_MAX = 64;
  var PASSWORD_HAS_LETTER = /[A-Za-z]/;
  var PASSWORD_HAS_DIGIT = /[0-9]/;

  // 「可还原密码」的混淆密钥（仅防明文直接出现在 localStorage / 导出文件里，不是加密）
  var SEAL_KEY = 'snt/auth/v1/seal::pV6yRt2Kw9Ns4HdQ';

  // 申请码 / 准入码的签名盐：用于检出复制粘贴时的错漏与随手篡改
  var CODE_SALT = 'snt/auth/v1/code::mZ3xLb8Tc5Jf1WqY';

  // 申请码前缀（注册者 → 管理员）与准入码前缀（管理员 → 注册者）
  var CODE_TAG_REQ = 'SNTREG1';
  var CODE_TAG_OK = 'SNTACC1';

  // 用户名不存在时用来「陪跑」一次哈希比对，避免通过响应快慢嗅探账号是否存在
  var DUMMY_HASH = 'pbkdf2$' + ITERATIONS + '$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

  /* ================= 存储适配（Node 下自动退化为内存） ================= */

  var memStore = {};
  var boundStorage = null;

  function storage() {
    if (Auth.storage) return Auth.storage;
    if (boundStorage) return boundStorage;
    try {
      if (typeof global.localStorage !== 'undefined' && global.localStorage) {
        global.localStorage.setItem('__snt_probe__', '1');
        global.localStorage.removeItem('__snt_probe__');
        boundStorage = global.localStorage;
        return boundStorage;
      }
    } catch (e) { /* 隐私模式 / 无 localStorage：退化为内存 */ }
    boundStorage = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null; },
      setItem: function (k, v) { memStore[k] = String(v); },
      removeItem: function (k) { delete memStore[k]; }
    };
    return boundStorage;
  }

  function readJSON(key, fallback) {
    try {
      var raw = storage().getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, val) {
    try { storage().setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* ================= 加密原语 ================= */

  function cryptoObj() {
    var c = global.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c) throw new Error('当前环境缺少加密支持');
    return c;
  }

  function subtle() {
    var c = cryptoObj();
    if (!c.subtle) throw new Error('当前环境不支持 WebCrypto，请通过 HTTPS 或 localhost 打开本页面');
    return c.subtle;
  }

  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    cryptoObj().getRandomValues(b);
    return b;
  }

  function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return diff === 0;
  }

  function derive(password, saltBytes, iterations) {
    var enc = new TextEncoder().encode(password);
    return subtle().importKey('raw', enc, 'PBKDF2', false, ['deriveBits']).then(function (key) {
      return subtle().deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
        key, KEY_BITS
      );
    }).then(function (bits) { return new Uint8Array(bits); });
  }

  function sha256Hex(text) {
    return subtle().digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      var u8 = new Uint8Array(buf);
      var out = '';
      for (var i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
      return out;
    });
  }

  /** 生成可存储的密码哈希：pbkdf2$迭代次数$盐$摘要 */
  function makePasswordHash(password) {
    var salt = randomBytes(SALT_BYTES);
    return derive(password, salt, ITERATIONS).then(function (dk) {
      return ['pbkdf2', ITERATIONS, bytesToB64(salt), bytesToB64(dk)].join('$');
    });
  }

  /** 校验密码（迭代次数从存储串读取，便于日后提升强度而不影响老账号） */
  function verifyPassword(password, stored) {
    if (!password || !stored || typeof stored !== 'string') return Promise.resolve(false);
    var parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return Promise.resolve(false);
    var iterations = parseInt(parts[1], 10);
    if (!iterations || iterations < 1) return Promise.resolve(false);
    var salt;
    try { salt = b64ToBytes(parts[2]); } catch (e) { return Promise.resolve(false); }
    return derive(password, salt, iterations).then(function (dk) {
      return timingSafeEqual(bytesToB64(dk), parts[3]);
    }).catch(function () { return false; });
  }

  /* ================= 可还原密码（供管理员查看） ================= */

  /**
   * 混淆存储：XOR + Base64。
   * 目的只有一个 —— 别让明文密码以肉眼可见的形态躺在 localStorage 和导出文件里。
   * 它不是加密（密钥就在本文件中，看得懂源码的人能还原），仅供管理员自查密码用。
   */
  function sealPassword(pw) {
    if (typeof pw !== 'string' || !pw) return '';
    var src = new TextEncoder().encode(pw);
    var key = new TextEncoder().encode(SEAL_KEY);
    var out = new Uint8Array(src.length);
    for (var i = 0; i < src.length; i++) {
      out[i] = src[i] ^ key[i % key.length] ^ ((i * 31 + 7) & 0xff);
    }
    return bytesToB64(out);
  }

  function unsealPassword(sealed) {
    if (typeof sealed !== 'string' || !sealed) return '';
    var buf;
    try { buf = b64ToBytes(sealed); } catch (e) { return ''; }
    var key = new TextEncoder().encode(SEAL_KEY);
    var out = new Uint8Array(buf.length);
    for (var i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ key[i % key.length] ^ ((i * 31 + 7) & 0xff);
    }
    try { return new TextDecoder().decode(out); } catch (e) { return ''; }
  }

  /* ================= 短码（申请码 / 准入码） ================= */

  function b64uFromText(text) {
    var bytes = new TextEncoder().encode(String(text));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function textFromB64u(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(out);
  }

  /** 把「内容」压成便于人工转发的码：前缀.负载.签名前 12 位 */
  function packCode(tag, payload) {
    var body = b64uFromText(JSON.stringify(payload));
    var sig = '';
    var text = tag + '|' + body + '|' + CODE_SALT;
    // 同步的简易校验和：FNV-1a 变体，足够发现「少粘了一段 / 改了一个字符」
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    sig = h.toString(36);
    return tag + '.' + body + '.' + sig;
  }

  function unpackCode(code) {
    var s = String(code == null ? '' : code).trim().replace(/\s+/g, '');
    if (!s) return { ok: false, error: '请先粘贴申请码 / 准入码' };
    if (s.length > MAX_CODE_LEN) return { ok: false, error: '内容过长，请确认粘贴的是完整且正确的码' };
    var parts = s.split('.');
    if (parts.length !== 3) return { ok: false, error: '码的格式不对（应为 三段式，形如 SNTREG1.xxxx.yyyy）' };
    // 按同样规则重算校验和，用来发现「少粘了一段 / 改了一个字符」
    var text = parts[0] + '|' + parts[1] + '|' + CODE_SALT;
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    if (parts[2] !== h.toString(36)) {
      return { ok: false, error: '码校验失败：可能复制不完整或被人改过，请让对方重新复制' };
    }
    var obj;
    try { obj = JSON.parse(textFromB64u(parts[1])); } catch (e) { return { ok: false, error: '码内容无法解析' }; }
    if (!obj || typeof obj !== 'object') return { ok: false, error: '码内容无法解析' };
    return { ok: true, tag: parts[0], data: obj };
  }

  /** 注册申请码：注册者生成，发给管理员（只带用户名 + 密码哈希，不带明文） */
  function makeRequestCode(u) {
    return packCode(CODE_TAG_REQ, {
      v: 1,
      username: u.username,
      hash: u.hash,
      pwSeal: u.pwSeal || '',
      createdAt: u.createdAt || Date.now()
    });
  }

  /**
   * 准入码：管理员审核 / 授权后生成，发给注册者，注册者粘贴后即可登录。
   *
   * batch16 重要改造：码里除了身份，还带上「授权信息」——
   *   status / trialUntil / trialDays / registerDate / quotaMonths / disableDate
   * 原因：本项目是纯静态站，账号表存在各自设备的 localStorage，管理员的审批与授权
   * （尤其是「试用三天」）只写在他自己机器上。以前准入码只带身份，用户粘贴后本机
   * 账号虽变成已通过，但试用期 / 会员额度一概没有，于是仍然登录不了 ——
   * 这正是「管理员已授权三天，用户却一直提示等待审核」的根因。
   * 现在无论账号是 active 还是「pending 但已开试用」，都能生成码，且授权随码走。
   */
  function makeApproveCode(u) {
    return packCode(CODE_TAG_OK, {
      v: 2,
      username: u.username,
      hash: u.hash,
      pwSeal: u.pwSeal || '',
      role: u.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.USER,
      status: statusOf(u) === STATUS.ACTIVE ? STATUS.ACTIVE : STATUS.PENDING,
      approvedAt: u.reviewedAt || Date.now(),
      approvedBy: u.reviewedBy || '',
      /* ---- 授权信息：随码同步到用户设备 ---- */
      trialUntil: Number(u.trialUntil) || 0,
      trialDays: Number(u.trialDays) || 0,
      trialGrantedAt: Number(u.trialGrantedAt) || 0,
      registerDate: String(u.registerDate || ''),
      quotaMonths: Number(u.quotaMonths) || 0,
      disableDate: String(u.disableDate || '')
    });
  }

  /** 从准入码载荷里读出授权信息（兼容 v1 旧码：无 status → 按已通过、无试用处理） */
  function readGrantFromCode(d) {
    return {
      status: String(d.status || '') === STATUS.PENDING ? STATUS.PENDING : STATUS.ACTIVE,
      trialUntil: Number(d.trialUntil) || 0,
      trialDays: Number(d.trialDays) || 0,
      trialGrantedAt: Number(d.trialGrantedAt) || 0,
      registerDate: String(d.registerDate || ''),
      quotaMonths: Number(d.quotaMonths) || 0,
      disableDate: String(d.disableDate || '')
    };
  }

  /** 把授权信息写进本机账号，让管理员那边的审批 / 试用 / 会员额度完整同步过来 */
  function applyGrant(u, g) {
    if (g.trialUntil > 0) {
      u.trialUntil = g.trialUntil;
      u.trialDays = g.trialDays || u.trialDays || 0;
      if (g.trialGrantedAt) u.trialGrantedAt = g.trialGrantedAt;
    } else {
      u.trialUntil = 0;
      u.trialDays = 0;
    }
    if (g.registerDate) u.registerDate = g.registerDate;
    if (g.quotaMonths > 0) u.quotaMonths = g.quotaMonths;
    if (g.disableDate) u.disableDate = g.disableDate;
  }

  /* ================= 设备 / 时段 ================= */

  /** 把 UserAgent 压成一句人话，例如「Chrome 128 / Windows」 */
  function parseUA(ua) {
    var s = String(ua || '');
    if (!s) return '';
    var browser = '未知浏览器';
    if (/Edg\//.test(s)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
    else if (/MicroMessenger/i.test(s)) browser = '微信内置';
    else if (/QQBrowser/i.test(s)) browser = 'QQ浏览器';
    else if (/Firefox\//.test(s)) browser = 'Firefox';
    else if (/Chrome\//.test(s)) browser = 'Chrome';
    else if (/Safari\//.test(s)) browser = 'Safari';
    var os = '未知系统';
    if (/Windows NT 10/.test(s)) os = 'Windows';
    else if (/Windows/.test(s)) os = 'Windows(旧版)';
    else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
    else if (/Android/.test(s)) os = 'Android';
    else if (/Mac OS X/.test(s)) os = 'macOS';
    else if (/Linux/.test(s)) os = 'Linux';
    return browser + ' / ' + os;
  }

  function localUA() {
    try {
      return (global.navigator && global.navigator.userAgent) ? String(global.navigator.userAgent) : '';
    } catch (e) { return ''; }
  }

  /** 当前浏览器的公开 IP 与归属地（接口在浏览器侧解析，无需服务端） */
  function resolveIp(fetcher) {
    var doFetch = fetcher || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    if (!doFetch) return Promise.resolve(null);
    // 中文地名优先（vore），英文兜底（ip.sb）；两个接口都带 Access-Control-Allow-Origin: *
    var chain = [
      {
        url: 'https://api.vore.top/api/IPdata',
        pick: function (j) {
          if (!j || j.code !== 200 || !j.ipinfo || !j.ipinfo.text) return null;
          var d = j.ipdata || {};
          var parts = [d.info1, d.info2].filter(Boolean).join(' ');
          return { ip: j.ipinfo.text, loc: [parts, d.isp].filter(Boolean).join(' · ') };
        }
      },
      {
        url: 'https://api.ip.sb/geoip',
        pick: function (j) {
          if (!j || !j.ip) return null;
          var parts = [j.country, j.region, j.city].filter(Boolean).join(' ');
          return { ip: j.ip, loc: [parts, j.isp || j.organization].filter(Boolean).join(' · ') };
        }
      }
    ];
    function attempt(i) {
      if (i >= chain.length) return Promise.resolve(null);
      var node = chain[i];
      var ctl = null, timer = null;
      try { ctl = new AbortController(); timer = setTimeout(function () { ctl.abort(); }, 6000); } catch (e) { /* 老浏览器无 AbortController */ }
      return Promise.resolve(doFetch(node.url, { signal: ctl ? ctl.signal : undefined, cache: 'no-store' }))
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (j) {
          if (timer) clearTimeout(timer);
          var got = j ? node.pick(j) : null;
          if (got && got.ip) return got;
          return attempt(i + 1);
        })
        .catch(function () {
          if (timer) clearTimeout(timer);
          return attempt(i + 1);
        });
    }
    return attempt(0);
  }

  /* ================= 用户记录派生字段 ================= */

  function statusOf(u) {
    var s = u && u.status;
    if (s === STATUS.PENDING || s === STATUS.REJECTED) return s;
    return STATUS.ACTIVE;   // 老数据没有 status 字段，一律视为已通过
  }

  /** 账号状态展示名：停用优先于审核状态；试用中的待审核账号显示「试用中」 */
  function statusName(u) {
    if (u && u.disabled && statusOf(u) === STATUS.ACTIVE) return STATUS_NAME.disabled;
    var tr = trialState(u);
    if (tr.active) return STATUS_NAME.trial;
    return STATUS_NAME[statusOf(u)];
  }

  /* ============ 会员额度（注册日期 / 月数 / 停用日期） ============ */

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 本地日期字符串 'YYYY-MM-DD'（按运行环境本地时区，本系统统一用北京时间语义） */
  function localDateStr(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 'YYYY-MM-DD' 加上 months 个月，返回 'YYYY-MM-DD'（月份溢出由 Date 自然处理） */
  function addMonthsToDateStr(s, months) {
    var p = String(s || '').split('-');
    var y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1, d = parseInt(p[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || !months || months <= 0) return '';
    var dt = new Date(y, m, d);
    dt.setMonth(dt.getMonth() + months);
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }

  /** 由 注册日期 + 额度(月) 推算停用日期；无额度(0/空)视为长期，返回 null */
  function disableDateOf(u) {
    if (!u || !u.registerDate || !u.quotaMonths || u.quotaMonths <= 0) return null;
    return addMonthsToDateStr(u.registerDate, u.quotaMonths);
  }

  /** 会员是否已到期：今天 > 停用日期（'YYYY-MM-DD' 字符串比较等价于日期比较） */
  function isMembershipExpired(u, now) {
    var dd = disableDateOf(u);
    if (!dd) return false;
    return localDateStr(now) > dd;
  }

  /* ============ 试用（普通用户可先试用、后审核） ============
   * 语义：管理员在「用户管理 → 试用」点一下，给这个普通用户开一段试用期；
   * 试用期内即使账号还停在「待审核」，也能用他自己的密码登录；
   * 试用一到期，登录与已持有的会话立即失效，账号回到原来的待审核状态。
   * 试用账号一律按「普通用户」对待，不继承管理员权限。
   */

  /** 可选试用时长（天）：一天 / 三天 / 一周 */
  var TRIAL_DAYS = [1, 3, 7];
  var TRIAL_DAY_LABEL = { 1: '一天', 3: '三天', 7: '一周' };

  /** 'YYYY-MM-DD HH:mm'（本地时区；本项目日期语义统一按北京时间） */
  function localMinStr(ts) {
    var d = new Date(Number(ts) || Date.now());
    return localDateStr(d.getTime()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 试用到期时间戳（ms）；未开通或已清空返回 null */
  function trialUntilOf(u) {
    var t = u ? Number(u.trialUntil) : 0;
    return (t && t > 0) ? t : null;
  }

  /**
   * 试用派生状态。
   * granted=false → 从未开通；active=true → 试用中（可登录）；expired=true → 开通过但已结束
   */
  function trialState(u, now) {
    var until = trialUntilOf(u);
    var t = Number(now) || Date.now();
    if (!until) {
      return { granted: false, active: false, expired: false, until: null, days: 0, leftMs: 0, label: '未开通' };
    }
    var days = Number(u.trialDays) || 0;
    var left = until - t;
    if (left <= 0) {
      return { granted: true, active: false, expired: true, until: until, days: days, leftMs: 0, label: '试用已结束' };
    }
    return { granted: true, active: true, expired: false, until: until, days: days, leftMs: left, label: '试用中' };
  }

  /** 试用剩余时长文案：不足 1 小时按分钟，不足 1 天按小时，其余按「x 天 y 小时」 */
  function trialLeftText(ms) {
    var m = Math.floor((Number(ms) || 0) / 60000);
    if (m <= 0) return '';
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function loginList(u) {
    return (u && Array.isArray(u.logins)) ? u.logins : [];
  }

  function lastLogin(u) {
    var list = loginList(u);
    if (!list.length) return null;
    return list[list.length - 1];
  }

  /** 累计在线时长（秒）= 各次登录记录里的 sec 之和 */
  function totalUsageSec(u) {
    return loginList(u).reduce(function (a, r) { return a + (Number(r && r.sec) || 0); }, 0);
  }

  function pushLoginRecord(u, meta) {
    if (!Array.isArray(u.logins)) u.logins = [];
    var rec = {
      at: (meta && meta.at) || Date.now(),
      ip: (meta && meta.ip) || '',
      loc: (meta && meta.loc) || '',
      ua: (meta && meta.ua) || '',
      sec: 0
    };
    u.logins.push(rec);
    if (u.logins.length > MAX_LOGIN_RECORDS) u.logins = u.logins.slice(-MAX_LOGIN_RECORDS);
    return rec;
  }

  /** 找到当前会话对应的登录记录（优先按 loginAt 精确匹配，其次取最后一条） */
  function currentRecord(u, loginAt) {
    var list = loginList(u);
    if (!list.length) return null;
    if (loginAt) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].at === loginAt) return list[i];
      }
    }
    return list[list.length - 1];
  }

  /* ================= 输入校验 ================= */

  function validateUsername(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return { ok: false, error: '请输入用户名' };
    if (s.length < 2 || s.length > 20) return { ok: false, error: '用户名长度需为 2-20 个字符' };
    if (!USERNAME_RE.test(s)) return { ok: false, error: '用户名只能包含中文、字母、数字、下划线、点或短横线' };
    return { ok: true, value: s };
  }

  /**
   * 密码规则：8-64 位，且必须同时包含字母与数字（大小写不限，可带符号）。
   * 顺序上先查长度、再查组成，保证错误提示只说最关键的一条。
   */
  function validatePassword(pw, confirm) {
    var s = String(pw == null ? '' : pw);
    if (!s) return { ok: false, error: '请输入密码' };
    if (s.length < PASSWORD_MIN) {
      return { ok: false, error: '密码至少 ' + PASSWORD_MIN + ' 位，且需同时包含字母和数字' };
    }
    if (s.length > PASSWORD_MAX) return { ok: false, error: '密码不能超过 ' + PASSWORD_MAX + ' 位' };
    if (/\s/.test(s)) return { ok: false, error: '密码不能包含空格' };
    if (!PASSWORD_HAS_LETTER.test(s) || !PASSWORD_HAS_DIGIT.test(s)) {
      return { ok: false, error: '密码必须同时包含字母和数字（例如 abc12345）' };
    }
    if (confirm !== undefined && confirm !== null && s !== confirm) {
      return { ok: false, error: '两次输入的密码不一致' };
    }
    return { ok: true, value: s };
  }

  /** 密码强度提示（仅用于界面提示，不做拦截） */
  function passwordStrength(pw) {
    var s = String(pw == null ? '' : pw);
    if (!s) return { level: 0, text: '' };
    var score = 0;
    if (s.length >= PASSWORD_MIN) score++;
    if (s.length >= 12) score++;
    if (PASSWORD_HAS_LETTER.test(s) && PASSWORD_HAS_DIGIT.test(s)) score++;
    if (/[A-Z]/.test(s) && /[a-z]/.test(s)) score++;
    if (/[^A-Za-z0-9]/.test(s)) score++;
    if (score <= 2) return { level: 1, text: '较弱' };
    if (score === 3) return { level: 2, text: '中等' };
    if (score === 4) return { level: 3, text: '较强' };
    return { level: 4, text: '很强' };
  }

  /* ================= 账号表 ================= */

  function loadUsers() {
    var arr = readJSON(USERS_KEY, []);
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (u) { return u && typeof u.username === 'string' && u.hash; });
  }

  function saveUsers(users) { return writeJSON(USERS_KEY, users); }

  function findUser(users, username) {
    if (!username) return null;
    var key = String(username).trim().toLowerCase();
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].username).trim().toLowerCase() === key) return users[i];
    }
    return null;
  }

  function publicUser(u) {
    var last = lastLogin(u);
    var tr = trialState(u);
    return {
      username: u.username,
      role: u.role,
      roleName: ROLE_NAME[u.role] || u.role,
      disabled: !!u.disabled,
      status: statusOf(u),
      statusName: statusName(u),
      pending: statusOf(u) === STATUS.PENDING,
      createdAt: u.createdAt || null,
      updatedAt: u.updatedAt || null,
      lastLoginAt: last ? last.at : null,
      usageSec: totalUsageSec(u),
      loginCount: loginList(u).length,
      // 试用（管理员在用户管理页按「一天 / 三天 / 一周」开通）
      trialActive: tr.active,
      trialExpired: tr.expired,
      trialGranted: tr.granted,
      trialDays: tr.days,
      trialUntil: tr.until,
      trialUntilText: tr.until ? localMinStr(tr.until) : '',
      trialLeftMs: tr.leftMs,
      trialLeftText: trialLeftText(tr.leftMs),
      trialLabel: tr.label,
      trialGrantedBy: u.trialGrantedBy || ''
    };
  }

  /** 管理员视角的账号明细：附带登录档案与「是否保存了可显示的密码」 */
  function adminUser(u) {
    var o = publicUser(u);
    var last = lastLogin(u);
    o.email = u.email || '';
    o.note = u.note || '';
    o.reviewNote = u.reviewNote || '';
    o.reviewedAt = u.reviewedAt || null;
    o.reviewedBy = u.reviewedBy || '';
    o.registeredAt = u.createdAt || null;
    o.registerDate = u.registerDate || '';
    o.quotaMonths = u.quotaMonths || 0;
    o.disableDate = disableDateOf(u) || '';
    o.autoDisabled = !!u.autoDisabled;
    o.disabledAt = u.disabledAt || null;
    o.regIp = u.regIp || '';
    o.regLoc = u.regLoc || '';
    o.regUa = parseUA(u.regUa);        // 界面只展示「Chrome / Windows」这类可读结果
    o.regUaRaw = u.regUa || '';
    o.hasPassword = !!u.pwSeal;
    o.lastIp = last ? (last.ip || '') : '';
    o.lastLoc = last ? (last.loc || '') : '';
    o.lastUa = last ? (last.ua || '') : '';
    o.lastSeenAt = (last && last.lastSeenAt) || null;
    o.lastSessionSec = last ? (Number(last.sec) || 0) : 0;
    o.logins = loginList(u).slice().reverse().map(function (r) {
      return {
        at: r.at, ip: r.ip || '', loc: r.loc || '',
        ua: parseUA(r.ua), sec: Number(r.sec) || 0,
        lastSeenAt: r.lastSeenAt || null
      };
    });
    return o;
  }

  /* ================= 登录态 ================= */

  function signSession(sess, cred) {
    return sha256Hex([sess.username, sess.role, sess.issuedAt, sess.exp, cred, SIGN_SALT].join('|'));
  }

  /** 签发登录态；loginAt 指向本次登录在用户档案里对应的那条登录记录 */
  function issueSession(user, ttl, loginAt) {
    var now = Date.now();
    var sess = { username: user.username, role: user.role, issuedAt: now, exp: now + ttl, loginAt: loginAt || now };
    return signSession(sess, user.hash).then(function (sig) {
      sess.sig = sig;
      Auth.session = sess;
      writeJSON(SESSION_KEY, sess);
      return sess;
    });
  }

  function clearSession() {
    Auth.session = null;
    try { storage().removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /** 校验登录态：过期、账号被删 / 停用 / 未过审、角色被改、签名被伪造，全部拦下 */
  function verifySession(sess, users) {
    if (!sess || typeof sess !== 'object') return Promise.resolve({ ok: false, error: '未登录' });
    if (!sess.username || !sess.role || !sess.exp || !sess.sig) {
      return Promise.resolve({ ok: false, error: '登录态不完整' });
    }
    if (Date.now() > sess.exp) return Promise.resolve({ ok: false, error: '登录已过期，请重新登录' });
    var list = users || loadUsers();
    var u = findUser(list, sess.username);
    if (!u) return Promise.resolve({ ok: false, error: '账号不存在或已被移除' });
    // 「试用中」的普通账号持有会话也放行；试用一结束立刻拦下（会话随即失效）
    var tr = trialState(u);
    if (statusOf(u) === STATUS.PENDING && !tr.active) {
      return Promise.resolve({
        ok: false,
        error: tr.expired ? '试用已结束，账号已回到待审核状态' : '账号待管理员审核通过后才能使用'
      });
    }
    if (statusOf(u) === STATUS.REJECTED && !tr.active) {
      return Promise.resolve({ ok: false, error: '注册申请未通过审核' });
    }
    // 会员额度到期：后台自动停用，持有旧会话也会被踢回登录页
    if (!u.disabled && isMembershipExpired(u)) {
      u.disabled = true; u.autoDisabled = true; u.disabledAt = Date.now(); u.updatedAt = Date.now();
      saveUsers(list);
      return Promise.resolve({ ok: false, error: '会员已到期，账号已被自动停用，请联系管理员' });
    }
    if (u.disabled) return Promise.resolve({ ok: false, error: '账号已被停用' });
    if (u.role !== sess.role) return Promise.resolve({ ok: false, error: '登录态校验失败' });
    return signSession(sess, u.hash).then(function (expect) {
      if (!timingSafeEqual(expect, sess.sig)) return { ok: false, error: '登录态校验失败' };
      return { ok: true, user: publicUser(u) };
    });
  }

  /* ================= 主对象 ================= */

  var Auth = {
    ROLE: ROLE,
    ROLE_NAME: ROLE_NAME,
    ROLE_RANK: ROLE_RANK,
    STATUS: STATUS,
    STATUS_NAME: STATUS_NAME,
    PERMISSIONS: PERMISSIONS,
    ITERATIONS: ITERATIONS,
    TTL_DEFAULT: TTL_DEFAULT,
    TTL_REMEMBER: TTL_REMEMBER,
    PASSWORD_MIN: PASSWORD_MIN,
    PASSWORD_MAX: PASSWORD_MAX,
    TRIAL_DAYS: TRIAL_DAYS,
    TRIAL_DAY_LABEL: TRIAL_DAY_LABEL,

    /** 可注入的存储实现（测试用） */
    storage: null,

    /**
     * 第二阶段接入 Cloudflare Worker 时赋值，实现以下方法即可无缝切换：
     *   login(username, password)  -> { ok, user?, session?, error? }
     *   verify(session)            -> { ok, user?, error? }
     *   logout()
     *   listUsers()                -> users[]
     *   saveUsers(users)           -> { ok }
     *   changePassword(username, newPassword) -> { ok, error? }
     */
    remote: null,

    users: [],
    session: null,
    user: null,

    init: function () {
      this.users = loadUsers();
      this.session = readJSON(SESSION_KEY, null);
      this.user = null;
      return this;
    },

    hasUsers: function () {
      this.users = loadUsers();
      return this.users.length > 0;
    },

    validate: function (username, password, confirm) {
      var u = validateUsername(username);
      if (!u.ok) return u;
      var p = validatePassword(password, confirm);
      if (!p.ok) return p;
      return { ok: true, username: u.value, password: p.value };
    },

    /** 首次使用：创建管理员账号并直接登录（管理员无需审核） */
    setup: function (username, password, confirm) {
      var self = this;
      if (this.hasUsers()) return Promise.resolve({ ok: false, error: '账号已初始化过，请直接登录' });
      var v = this.validate(username, password, confirm);
      if (!v.ok) return Promise.resolve(v);
      return makePasswordHash(v.password).then(function (hash) {
        var now = Date.now();
        var u = {
          username: v.username, role: ROLE.ADMIN, hash: hash,
          pwSeal: sealPassword(v.password),
          disabled: false, status: STATUS.ACTIVE,
          createdAt: now, updatedAt: now,
          logins: []
        };
        var rec = pushLoginRecord(u, { at: now, ua: localUA() });
        self.users = [u];
        if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
        return issueSession(u, TTL_REMEMBER, rec.at).then(function () {
          self.user = publicUser(u);
          return { ok: true, user: self.user };
        });
      });
    },

    /**
     * 自助注册：只写入一条待审核记录，**不会**登录态。
     * 必须由管理员 approveUser 通过后才能登录。
     */
    register: function (username, password) {
      var self = this;
      var v = this.validate(username, password, password);
      if (!v.ok) return Promise.resolve(v);
      this.users = loadUsers();
      var exist = findUser(this.users, v.username);
      // 已通过的账号直接拒绝；待审核的先不拦，等算出哈希确认是同一个人的密码再说
      if (exist && statusOf(exist) === STATUS.ACTIVE) {
        return Promise.resolve({ ok: false, error: '该用户名已被使用，请换一个' });
      }
      return makePasswordHash(v.password).then(function (hash) {
        var now = Date.now();
        // batch16：本机已有同名「待审核」记录时不再报错——换设备 / 忘记自己提交过的情况下
        // 用户会反复注册，每次都以为要重新申请。密码一致就直接把同一个申请码再给他一次。
        if (exist && statusOf(exist) === STATUS.PENDING) {
          // 注意：密码哈希带随机 salt，同一个密码每次算出的 hash 都不一样，
          // 所以不能拿 hash 字符串直接比，必须用 verifyPassword 真正校验一次。
          return verifyPassword(v.password, exist.hash).then(function (okPwd) {
            if (!okPwd) {
              return {
                ok: false,
                error: '该用户名已提交过注册申请。若这是你自己的账号，请用注册时设置的密码重新提交，即可取回同一个申请码'
              };
            }
            if (!exist.pwSeal) exist.pwSeal = sealPassword(v.password);
            exist.updatedAt = Date.now();
            saveUsers(self.users);
            return {
              ok: true, user: publicUser(exist),
              requestCode: makeRequestCode(exist), alreadySubmitted: true
            };
          });
        }
        var u = {
          username: v.username, role: ROLE.USER, hash: hash,
          pwSeal: sealPassword(v.password),
          disabled: false, status: STATUS.PENDING,
          createdAt: now, updatedAt: now,
          logins: []
        };
        // 曾被驳回的用户重新申请：覆盖旧记录，避免同名堆叠多条
        if (exist) {
          var i = self.users.indexOf(exist);
          if (i >= 0) self.users[i] = u; else self.users.push(u);
        } else {
          self.users.push(u);
        }
        if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
        return { ok: true, user: publicUser(u), requestCode: makeRequestCode(u) };
      });
    },

    login: function (username, password, remember) {
      var self = this;
      var uname = String(username == null ? '' : username).trim();
      if (!uname || !password) return Promise.resolve({ ok: false, error: '请输入用户名和密码' });

      // 第二阶段：远端校验优先
      if (this.remote && typeof this.remote.login === 'function') {
        return Promise.resolve(this.remote.login(uname, password)).then(function (r) {
          if (!r || !r.ok) return { ok: false, error: (r && r.error) || '用户名或密码不正确' };
          if (r.session) { self.session = r.session; writeJSON(SESSION_KEY, r.session); }
          self.user = r.user || null;
          return { ok: true, user: self.user };
        }).catch(function (e) {
          return { ok: false, error: '无法连接鉴权服务：' + (e && e.message ? e.message : e) };
        });
      }

      this.users = loadUsers();
      var u = findUser(this.users, uname);
      var stored = u ? u.hash : DUMMY_HASH;
      return verifyPassword(password, stored).then(function (okPwd) {
        if (!u || !okPwd) return { ok: false, error: '用户名或密码不正确' };
        // 审核门禁：密码对也不行，必须已通过审核 —— 但「试用中」的普通用户可直接登录
        var st = statusOf(u);
        var tr = trialState(u);
        if (st === STATUS.PENDING && !tr.active) {
          return {
            ok: false, status: STATUS.PENDING,
            error: tr.expired ? '试用已结束，请等待管理员审核通过后再登录' : '该账号正在等待管理员审核，通过后即可登录'
          };
        }
        if (st === STATUS.REJECTED && !tr.active) {
          return { ok: false, error: '该注册申请未通过审核，请联系管理员', status: STATUS.REJECTED };
        }
        // 会员额度到期：后台自动停用，无法登录（试用中的账号还没走会员额度，不受影响）
        if (!u.disabled && isMembershipExpired(u)) {
          u.disabled = true; u.autoDisabled = true; u.disabledAt = Date.now(); u.updatedAt = Date.now();
          saveUsers(self.users);
          return { ok: false, error: '会员已到期（停用日期 ' + disableDateOf(u) + '），无法登录，请联系管理员', status: 'expired' };
        }
        if (u.disabled) return { ok: false, error: '该账号已被停用，请联系管理员' };
        // 试用中的账号一律按普通用户放行，避免「待审核 + 管理员角色」这种组合直接拿到后台权限
        if (tr.active && st !== STATUS.ACTIVE && u.role !== ROLE.USER) {
          u.role = ROLE.USER;
          u.updatedAt = Date.now();
          saveUsers(self.users);
        }
        var ttl = remember ? TTL_REMEMBER : TTL_DEFAULT;
        var rec = pushLoginRecord(u, { ua: localUA() });
        u.lastLoginAt = rec.at;
        saveUsers(self.users);
        return issueSession(u, ttl, rec.at).then(function () {
          self.user = publicUser(u);
          return { ok: true, user: self.user, loginAt: rec.at, trial: tr.active };
        });
      });
    },

    /** 启动时恢复登录态；失败会顺手清掉本地残留 */
    restore: function () {
      var self = this;
      this.users = loadUsers();
      var sess = readJSON(SESSION_KEY, null);
      if (!sess) { this.session = null; this.user = null; return Promise.resolve({ ok: false, error: '未登录' }); }

      // 第二阶段：远端验签（不可达时静默回退本地校验）
      if (this.remote && typeof this.remote.verify === 'function') {
        return Promise.resolve(this.remote.verify(sess)).then(function (r) {
          if (r && r.ok) {
            self.session = sess;
            self.user = r.user || null;
            return { ok: true, user: self.user };
          }
          return verifySession(sess, self.users).then(function (lr) {
            if (lr.ok) { self.session = sess; self.user = lr.user; return lr; }
            self.user = null; clearSession();
            return r && r.error ? r : lr;
          });
        }).catch(function () {
          return verifySession(sess, self.users).then(function (lr) {
            if (lr.ok) { self.session = sess; self.user = lr.user; return lr; }
            self.user = null; clearSession();
            return lr;
          });
        });
      }

      return verifySession(sess, this.users).then(function (r) {
        if (!r.ok) { self.user = null; clearSession(); return r; }
        self.session = sess;
        self.user = r.user;
        return r;
      });
    },

    logout: function () {
      this.user = null;
      clearSession();
      if (this.remote && typeof this.remote.logout === 'function') {
        try { this.remote.logout(); } catch (e) { /* ignore */ }
      }
      return { ok: true };
    },

    isLoggedIn: function () { return !!this.user; },
    isAdmin: function () { return !!this.user && this.user.role === ROLE.ADMIN; },

    /** 权限判定：未声明的权限点按最高要求（管理员）处理 */
    can: function (perm) {
      if (!this.user) return false;
      var need = PERMISSIONS[perm] || ROLE.ADMIN;
      return (ROLE_RANK[this.user.role] || 0) >= (ROLE_RANK[need] || 99);
    },

    roleName: function (role) { return ROLE_NAME[role] || role || ''; },

    /* ---------- 账号管理（均需管理员） ---------- */

    listUsers: function () {
      this.users = loadUsers();
      return this.users.map(publicUser);
    },

    /** 管理员视角明细：含登录档案、使用时长、是否保存了可显示的密码 */
    listUsersDetail: function () {
      if (!this.isAdmin()) return this.listUsers();
      this.users = loadUsers();
      return this.users.map(adminUser);
    },

    /** 待审核列表（公开可读，只暴露用户名与申请时间，供登录页提示用） */
    pendingUsers: function () {
      this.users = loadUsers();
      return this.users.filter(function (u) { return statusOf(u) === STATUS.PENDING; }).map(publicUser);
    },

    pendingCount: function () {
      return this.pendingUsers().length;
    },

    /**
     * 审核通过：pending → active。
     * 返回 approveCode，管理员把它发给注册者，注册者在登录页粘贴即可登录。
     */
    approveUser: function (username, role) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可审核账号' };
      var roleVal = (role === ROLE.ADMIN) ? ROLE.ADMIN : ROLE.USER;
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (statusOf(u) === STATUS.ACTIVE && !u.disabled) {
        return { ok: false, error: '该账号已经是正常状态' };
      }
      var now = Date.now();
      u.status = STATUS.ACTIVE;
      u.reviewNote = '';
      if (role) u.role = roleVal;
      u.registerDate = u.registerDate || localDateStr(now);
      u.quotaMonths = u.quotaMonths || 0;
      u.reviewedAt = now;
      u.reviewedBy = (this.user && this.user.username) || '';
      u.updatedAt = now;
      saveUsers(this.users);
      return { ok: true, user: publicUser(u), approveCode: makeApproveCode(u) };
    },

    /** 驳回注册申请：pending → rejected（留有被驳回标记，用户可重新申请） */
    rejectUser: function (username, note) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可审核账号' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      u.status = STATUS.REJECTED;
      u.reviewNote = String(note == null ? '' : note).slice(0, 200);
      u.reviewedAt = Date.now();
      u.reviewedBy = (this.user && this.user.username) || '';
      u.updatedAt = Date.now();
      saveUsers(this.users);
      return { ok: true, user: publicUser(u) };
    },

    /** 重新取某个已通过账号的准入码（补发场景） */
    approveCodeFor: function (username) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可生成准入码' };
      var u = findUser(loadUsers(), username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (statusOf(u) === STATUS.REJECTED) return { ok: false, error: '该账号已被驳回，无法生成准入码' };
      if (u.disabled) return { ok: false, error: '该账号已停用，请先「启用」再生成准入码' };
      // batch16：pending 但已开试用的账号也要能出码，否则「授权三天」传不到用户设备上
      if (statusOf(u) !== STATUS.ACTIVE && !trialState(u).active) {
        return { ok: false, error: '该账号既未通过审核也没有试用，请先在「待审核注册申请」里点通过或开通试用' };
      }
      return { ok: true, approveCode: makeApproveCode(u), status: statusOf(u), trial: trialState(u) };
    },

    /* ---------- 试用：管理员给普通用户开一段试用期 ---------- */

    /**
     * 开通 / 续期试用。days 只接受 1 / 3 / 7（一天 / 三天 / 一周）。
     * 试用期内，即使账号还停在「待审核」，该用户也能用自己的密码登录（按普通用户对待）；
     * 到期后登录与已发出的会话都会立即失效，账号回到原来的待审核状态。
     * 再次点击 = 从「现在」重新起算，便于续期。
     */
    grantTrial: function (username, days) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可开通试用' };
      var d = parseInt(days, 10);
      if (TRIAL_DAYS.indexOf(d) < 0) return { ok: false, error: '试用时长只支持 一天 / 三天 / 一周' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (u.role === ROLE.ADMIN) return { ok: false, error: '管理员账号无需试用' };
      if (u.disabled) return { ok: false, error: '该账号已被停用，请先「启用」再开通试用' };
      var now = Date.now();
      u.trialUntil = now + d * 24 * 60 * 60 * 1000;
      u.trialDays = d;
      u.trialGrantedAt = now;
      u.trialGrantedBy = (this.user && this.user.username) || '';
      if (!u.registerDate) u.registerDate = localDateStr(now);
      u.updatedAt = now;
      if (!saveUsers(this.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
      // batch16：试用只写在本机账号表里，纯静态站没有服务端，不同步给对方设备就永远不生效。
      // 所以这里一并返回准入码，管理员把它发给用户，用户粘贴后本机才有同一段试用期。
      return {
        ok: true, user: adminUser(u), days: d,
        untilText: localMinStr(u.trialUntil),
        label: TRIAL_DAY_LABEL[d] || (d + ' 天'),
        approveCode: makeApproveCode(u)
      };
    },

    /** 立即结束试用：清掉试用期，账号回到原状态（通常仍是待审核） */
    revokeTrial: function (username) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可结束试用' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (!trialUntilOf(u)) return { ok: false, error: '该账号当前没有试用' };
      u.trialUntil = 0;
      u.trialDays = 0;
      u.trialRevokedAt = Date.now();
      u.trialRevokedBy = (this.user && this.user.username) || '';
      u.updatedAt = Date.now();
      if (!saveUsers(this.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
      return { ok: true, user: adminUser(u) };
    },

    /** 试用状态查询（管理员列表与界面提示共用） */
    trialState: function (username) {
      var u = findUser(loadUsers(), username);
      if (!u) return null;
      var tr = trialState(u);
      tr.untilText = tr.until ? localMinStr(tr.until) : '';
      tr.leftText = trialLeftText(tr.leftMs);
      return tr;
    },

    /**
     * 管理员粘贴「注册申请码」：把申请者的账号拉进本机待审核列表。
     * 这是纯静态站点在「跨浏览器」场景下的通道 —— 账号表存在各自浏览器里，
     * 没有共享服务端，所以用一串可转发的码代替接口。
     */
    applyRequestCode: function (code) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可导入注册申请' };
      var p = unpackCode(code);
      if (!p.ok) return p;
      if (p.tag !== CODE_TAG_REQ) return { ok: false, error: '这不是注册申请码（应以 SNTREG1 开头）' };
      var d = p.data || {};
      var v = validateUsername(d.username);
      if (!v.ok) return { ok: false, error: '申请码里的用户名不合法：' + v.error };
      if (typeof d.hash !== 'string' || d.hash.indexOf('pbkdf2$') !== 0) {
        return { ok: false, error: '申请码里的密码摘要不合法，请让对方重新生成' };
      }
      this.users = loadUsers();
      var exist = findUser(this.users, v.value);
      var now = Date.now();
      if (exist && statusOf(exist) === STATUS.ACTIVE) {
        return { ok: false, error: '本机已有同名且已通过的账号「' + v.value + '」' };
      }
      var rec = {
        username: v.value, role: ROLE.USER, hash: d.hash,
        pwSeal: typeof d.pwSeal === 'string' ? d.pwSeal : '',
        disabled: false, status: STATUS.PENDING,
        createdAt: Number(d.createdAt) || now, updatedAt: now,
        appliedByCode: true, logins: []
      };
      if (exist) {
        var i = this.users.indexOf(exist);
        if (i >= 0) this.users[i] = rec; else this.users.push(rec);
      } else {
        this.users.push(rec);
      }
      if (!saveUsers(this.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
      return { ok: true, user: publicUser(rec) };
    },

    /**
     * 注册者在本机粘贴「准入码」：写入（或更新）本机账号后即可用原密码登录。
     * 不需要管理员密码，也不需要导入整张账号表（避免泄露其他账号）。
     */
    importApproveCode: function (code) {
      var p = unpackCode(code);
      if (!p.ok) return p;
      if (p.tag !== CODE_TAG_OK) return { ok: false, error: '这不是准入码（应以 SNTACC1 开头）' };
      var d = p.data || {};
      var v = validateUsername(d.username);
      if (!v.ok) return { ok: false, error: '准入码里的用户名不合法：' + v.error };
      if (typeof d.hash !== 'string' || d.hash.indexOf('pbkdf2$') !== 0) {
        return { ok: false, error: '准入码里的密码摘要不合法，请向管理员重新索取' };
      }
      this.users = loadUsers();
      var exist = findUser(this.users, v.value);
      var now = Date.now();
      /* 授权信息：v1 旧码没有这些字段，一律按「已通过、无试用」处理 */
      var grant = readGrantFromCode(d);
      if (exist) {
        // 本机已有同名记录：只有哈希一致才允许覆盖，避免用别人的码顶掉本机账号
        if (exist.hash !== d.hash) {
          return { ok: false, error: '本机已存在账号「' + v.value + '」，与准入码不匹配' };
        }
        exist.status = grant.status;
        exist.role = d.role === ROLE.ADMIN ? ROLE.ADMIN : (exist.role || ROLE.USER);
        if (typeof d.pwSeal === 'string' && d.pwSeal) exist.pwSeal = d.pwSeal;
        exist.reviewedAt = Number(d.approvedAt) || now;
        exist.reviewedBy = String(d.approvedBy || '');
        applyGrant(exist, grant);
        exist.updatedAt = now;
      } else {
        exist = {
          username: v.value,
          role: d.role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.USER,
          hash: d.hash,
          pwSeal: typeof d.pwSeal === 'string' ? d.pwSeal : '',
          disabled: false, status: grant.status,
          createdAt: now, updatedAt: now,
          reviewedAt: Number(d.approvedAt) || now,
          reviewedBy: String(d.approvedBy || ''),
          importedByCode: true, logins: []
        };
        applyGrant(exist, grant);
        // 用准入码导入的记录必须置顶，否则 hasUsers() 为真时会被误判为「本机已有主账号」
        this.users.push(exist);
      }
      if (!saveUsers(this.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
      var tr = trialState(exist);
      return {
        ok: true, user: publicUser(exist),
        status: exist.status,
        trial: tr.active,
        untilText: tr.until ? localMinStr(tr.until) : ''
      };
    },

    /** 解析一段码，供界面判断是申请码还是准入码（不做任何写入） */
    parseCode: function (code) {
      var p = unpackCode(code);
      if (!p.ok) return p;
      var d = p.data || {};
      return {
        ok: true,
        tag: p.tag,
        kind: p.tag === CODE_TAG_REQ ? 'request' : (p.tag === CODE_TAG_OK ? 'approve' : 'unknown'),
        username: d.username || '',
        createdAt: Number(d.createdAt || d.approvedAt) || null
      };
    },

    /**
     * 注册者取回自己的申请码（本机存在待审核记录时可用）。
     * batch16：换设备或忘了自己提交过的情况下，用户会反复注册；
     * 这里让他能直接把同一个申请码再发给管理员，而不用重新填一遍。
     */
    requestCodeFor: function (username) {
      var u = findUser(loadUsers(), String(username == null ? '' : username).trim());
      if (!u) return { ok: false, error: '本机没有该账号的注册记录' };
      if (statusOf(u) !== STATUS.PENDING) {
        return { ok: false, error: '该账号已通过审核，无需申请码；若仍无法登录，请向管理员索取准入码' };
      }
      return { ok: true, username: u.username, requestCode: makeRequestCode(u) };
    },

    /* ---------- 密码查看（仅管理员） ---------- */

    /**
     * 显示密码：从混淆存储里还原。
     * 只认管理员；历史账号（改造前创建 / 手工导入）没有该字段时明确说明。
     */
    revealPassword: function (username) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可查看密码' };
      var u = findUser(loadUsers(), username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (!u.pwSeal) {
        return { ok: false, error: '该账号没有保存可显示的密码（改造前创建的账号，或由账号表导入），请用「重置密码」设定新密码' };
      }
      var pw = unsealPassword(u.pwSeal);
      if (!pw) return { ok: false, error: '密码无法还原，请用「重置密码」设定新密码' };
      return { ok: true, password: pw };
    },

    /* ---------- 登录档案：IP / 时间 / 使用时长 ---------- */

    /**
     * 把当前会话的 IP 等信息补写到对应的登录记录上。
     * 登录时不等 IP（避免网络慢把登录卡住），先进来再异步补。
     */
    attachLoginMeta: function (at, meta) {
      if (!this.user && !this.session) return false;
      var uname = (this.session && this.session.username) || (this.user && this.user.username);
      if (!uname) return false;
      this.users = loadUsers();
      var u = findUser(this.users, uname);
      if (!u) return false;
      var rec = currentRecord(u, at || (this.session && this.session.loginAt));
      if (!rec) rec = pushLoginRecord(u, { at: at || Date.now() });
      var m = meta || {};
      if (m.ip) rec.ip = String(m.ip);
      if (m.loc) rec.loc = String(m.loc).slice(0, 80);
      if (m.ua) rec.ua = String(m.ua);
      rec.updatedAt = Date.now();
      saveUsers(this.users);
      return true;
    },

    /** 注册者的注册来源（管理员在待审核列表里能看到） */
    attachRegisterMeta: function (username, meta) {
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return false;
      var m = meta || {};
      if (m.ip) u.regIp = String(m.ip);
      if (m.loc) u.regLoc = String(m.loc).slice(0, 80);
      if (m.ua) u.regUa = String(m.ua);
      saveUsers(this.users);
      return true;
    },

    /**
     * 累计在线时长心跳：给当前会话对应的登录记录加 seconds。
     * 由界面在有焦点、可见时定时调用；不做任何鉴权以外的事。
     */
    touchSession: function (seconds) {
      var sec = Math.max(0, Math.floor(Number(seconds) || 0));
      if (!sec) return false;
      var sess = this.session;
      if (!sess || !sess.username) return false;
      this.users = loadUsers();
      var u = findUser(this.users, sess.username);
      if (!u || statusOf(u) !== STATUS.ACTIVE || u.disabled) return false;
      var rec = currentRecord(u, sess.loginAt);
      if (!rec) rec = pushLoginRecord(u, { at: sess.loginAt || Date.now() });
      rec.sec = (Number(rec.sec) || 0) + sec;
      rec.lastSeenAt = Date.now();
      u.lastSeenAt = rec.lastSeenAt;
      saveUsers(this.users);
      return true;
    },

    /** 当前登录用户在本次会话里的在线秒数 */
    currentSessionSeconds: function () {
      if (!this.session) return 0;
      var u = findUser(loadUsers(), this.session.username);
      if (!u) return 0;
      var rec = currentRecord(u, this.session.loginAt);
      return rec ? (Number(rec.sec) || 0) : 0;
    },

    /* ---------- 获取本机公网 IP（浏览器直连第三方接口） ---------- */

    /** 结果缓存在 Auth 上，避免一次访问里反复请求；失败返回 null，不抛异常 */
    resolveIp: function (fetcher) {
      var self = this;
      if (self._ipCache) return Promise.resolve(self._ipCache);
      return resolveIp(fetcher).then(function (got) {
        if (got && got.ip) self._ipCache = got;
        return got;
      }).catch(function () { return null; });
    },

    /** 便捷组合：登录/进入后调用一次，把 IP 补写到当前登录记录 */
    syncLoginMeta: function (fetcher) {
      var self = this;
      return this.resolveIp(fetcher).then(function (got) {
        var meta = { ua: localUA() };
        if (got && got.ip) { meta.ip = got.ip; meta.loc = got.loc || ''; }
        self.attachLoginMeta(self.session && self.session.loginAt, meta);
        return got;
      }).catch(function () { return null; });
    },

    addUser: function (username, password, role) {
      var self = this;
      if (!this.isAdmin()) return Promise.resolve({ ok: false, error: '仅管理员可管理账号' });
      var v = this.validate(username, password, password);
      if (!v.ok) return Promise.resolve(v);
      var roleVal = (role === ROLE.ADMIN) ? ROLE.ADMIN : ROLE.USER;
      this.users = loadUsers();
      if (findUser(this.users, v.username)) return Promise.resolve({ ok: false, error: '该用户名已存在' });
      return makePasswordHash(v.password).then(function (hash) {
        var now = Date.now();
        var u = {
          username: v.username, role: roleVal, hash: hash,
          pwSeal: sealPassword(v.password),
          disabled: false, status: STATUS.ACTIVE,
          createdAt: now, updatedAt: now,
          registerDate: localDateStr(now), quotaMonths: 0,
          createdBy: (self.user && self.user.username) || '',
          logins: []
        };
        self.users.push(u);
        if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
        return { ok: true, user: publicUser(u) };
      });
    },

    removeUser: function (username) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可管理账号' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (this.user && u.username === this.user.username) {
        return { ok: false, error: '不能删除当前登录的账号' };
      }
      var activeAdmins = this.users.filter(function (x) { return x.role === ROLE.ADMIN && !x.disabled; });
      if (u.role === ROLE.ADMIN && activeAdmins.length <= 1) {
        return { ok: false, error: '必须至少保留一个可用的管理员' };
      }
      this.users = this.users.filter(function (x) { return x !== u; });
      saveUsers(this.users);
      return { ok: true };
    },

    setUserRole: function (username, role) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可管理账号' };
      var roleVal = (role === ROLE.ADMIN) ? ROLE.ADMIN : ROLE.USER;
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (this.user && u.username === this.user.username && roleVal !== ROLE.ADMIN) {
        return { ok: false, error: '不能取消自己当前的管理员身份' };
      }
      if (u.role === ROLE.ADMIN && roleVal !== ROLE.ADMIN) {
        var activeAdmins = this.users.filter(function (x) { return x.role === ROLE.ADMIN && !x.disabled; });
        if (activeAdmins.length <= 1) return { ok: false, error: '必须至少保留一个可用的管理员' };
      }
      u.role = roleVal;
      u.updatedAt = Date.now();
      saveUsers(this.users);
      return { ok: true, user: publicUser(u) };
    },

    setUserDisabled: function (username, disabled) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可管理账号' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      var off = !!disabled;
      if (this.user && u.username === this.user.username && off) {
        return { ok: false, error: '不能停用当前登录的账号' };
      }
      if (off && u.role === ROLE.ADMIN) {
        var activeAdmins = this.users.filter(function (x) { return x.role === ROLE.ADMIN && !x.disabled; });
        if (activeAdmins.length <= 1) return { ok: false, error: '必须至少保留一个可用的管理员' };
      }
      u.disabled = off;
      u.autoDisabled = false;            // 手动操作，清掉「到期自动停用」标记
      u.disabledAt = off ? (u.disabledAt || Date.now()) : null;
      u.updatedAt = Date.now();
      saveUsers(this.users);
      return { ok: true, user: publicUser(u) };
    },

    /**
     * 管理员设置普通用户的会员信息：注册日期 + 额度(月)。
     * 停用日期由二者推算，只读展示。若此前因到期被自动停用、现在额度已覆盖今天，自动恢复。
     */
    setUserMembership: function (username, opts) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可管理账号' };
      if (!opts || typeof opts !== 'object') return { ok: false, error: '参数缺失' };
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return { ok: false, error: '用户不存在' };
      if (opts.registerDate !== undefined) u.registerDate = String(opts.registerDate || '').trim();
      if (opts.quotaMonths !== undefined) {
        var q = parseInt(opts.quotaMonths, 10);
        if (isNaN(q) || q < 0) q = 0;
        u.quotaMonths = q;
      }
      u.updatedAt = Date.now();
      // 此前因到期被自动停用的账号，若额度调整后续期到今天之后，则解除停用
      if (u.disabled && u.autoDisabled && !isMembershipExpired(u)) {
        u.disabled = false; u.autoDisabled = false; u.disabledAt = null;
      }
      saveUsers(this.users);
      return { ok: true, user: adminUser(u) };
    },

    /** 改密码：改自己的需验原密码；管理员改他人无需。改完自动重签自己的会话，避免把自己踢下线。 */
    changePassword: function (username, oldPassword, newPassword) {
      var self = this;
      if (!this.user) return Promise.resolve({ ok: false, error: '未登录' });
      this.users = loadUsers();
      var u = findUser(this.users, username);
      if (!u) return Promise.resolve({ ok: false, error: '用户不存在' });
      var isSelf = u.username === this.user.username;
      if (!isSelf && !this.isAdmin()) return Promise.resolve({ ok: false, error: '只能修改自己的密码' });

      var pc = validatePassword(newPassword, newPassword);
      if (!pc.ok) return Promise.resolve(pc);

      var pre = isSelf
        ? verifyPassword(oldPassword, u.hash).then(function (ok) { return ok ? { ok: true } : { ok: false, error: '原密码不正确' }; })
        : Promise.resolve({ ok: true });

      return pre.then(function (chk) {
        if (!chk.ok) return chk;
        return makePasswordHash(pc.value).then(function (hash) {
          // 防竞态：上面 makePasswordHash 是异步（PBKDF2），其间本模块其它方法
          // （touchSession / syncLoginMeta 等后台心跳）可能 reload 并写回了「旧」的 this.users，
          // 若直接沿用开头拿到的 u，saveUsers(self.users) 会把过期数组写回、丢掉新密码哈希，
          // 导致刷新后会话签名与存储哈希对不上而「登录态校验失败」。
          // 因此在落盘前重新读取最新用户表，并在同一同步步内完成「改值 + 保存」。
          self.users = loadUsers();
          var u2 = findUser(self.users, username);
          if (!u2) return { ok: false, error: '用户不存在' };
          u2.hash = hash;
          u2.pwSeal = sealPassword(pc.value);   // 同步更新可显示密码，避免「显示的是旧密码」
          u2.updatedAt = Date.now();
          if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
          if (isSelf) {
            // 会话签名绑定密码哈希，改完必须重签，否则自己会被立刻踢下线
            var rec = currentRecord(u2, self.session && self.session.loginAt);
            return issueSession(u2, TTL_REMEMBER, rec ? rec.at : Date.now()).then(function () {
              return { ok: true, resigned: true };
            });
          }
          return { ok: true };
        });
      });
    },

    /* ---------- 账号表导出 / 导入（换设备迁移） ---------- */

    exportUsers: function () {
      this.users = loadUsers();
      return JSON.stringify({
        type: 'snt-auth-users',
        version: 1,
        exportedAt: new Date().toISOString(),
        users: this.users
      }, null, 2);
    },

    /** mode: 'replace' 覆盖 | 'merge' 合并（同名跳过）；导入后需要对方用自己的密码重新登录 */
    importUsers: function (json, mode) {
      if (!this.isAdmin()) return { ok: false, error: '仅管理员可导入账号表' };
      var obj;
      try { obj = JSON.parse(json); } catch (e) { return { ok: false, error: '内容不是合法的 JSON' }; }
      var incoming = obj && Array.isArray(obj.users) ? obj.users : null;
      if (!incoming) return { ok: false, error: '缺少 users 字段' };
      var valid = incoming.filter(function (u) {
        return u && typeof u.username === 'string' && typeof u.hash === 'string' && u.hash.indexOf('pbkdf2$') === 0;
      });
      if (!valid.length) return { ok: false, error: '没有可导入的合法账号' };
      if (mode === 'replace') {
        var keepSelf = this.users.filter(function (u) {
          return u.username === (Auth.user && Auth.user.username);
        });
        var hasSelf = valid.some(function (u) { return u.username === (Auth.user && Auth.user.username); });
        this.users = hasSelf ? valid.slice() : keepSelf.concat(valid);
      } else {
        this.users = loadUsers();
        var seen = {};
        this.users.forEach(function (u) { seen[u.username.toLowerCase()] = true; });
        for (var i = 0; i < valid.length; i++) {
          if (!seen[valid[i].username.toLowerCase()]) this.users.push(valid[i]);
        }
      }
      if (!saveUsers(this.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
      return { ok: true, count: this.users.length };
    },

    /** 清空账号表（危险，仅用于重装） */
    reset: function () {
      this.users = [];
      saveUsers([]);
      this.user = null;
      clearSession();
      return { ok: true };
    },

    /* ---------- 底层原语，供外部复用 ---------- */
    makePasswordHash: makePasswordHash,
    verifyPassword: verifyPassword,
    hashText: sha256Hex,
    validateUsername: validateUsername,
    validatePassword: validatePassword,
    passwordStrength: passwordStrength,
    sealPassword: sealPassword,
    unsealPassword: unsealPassword,
    parseUA: parseUA,
    makeRequestCode: makeRequestCode,
    makeApproveCode: makeApproveCode,
    statusOf: statusOf,
    totalUsageSec: totalUsageSec,
    _ipCache: null
  };

  global.Auth = Auth;
  if (typeof module !== 'undefined' && module.exports) module.exports = Auth;
})(typeof window !== 'undefined' ? window : globalThis);
