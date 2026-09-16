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
  var PASSWORD_MIN = 6;

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

  /* ================= 输入校验 ================= */

  function validateUsername(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return { ok: false, error: '请输入用户名' };
    if (s.length < 2 || s.length > 20) return { ok: false, error: '用户名长度需为 2-20 个字符' };
    if (!USERNAME_RE.test(s)) return { ok: false, error: '用户名只能包含中文、字母、数字、下划线、点或短横线' };
    return { ok: true, value: s };
  }

  function validatePassword(pw, confirm) {
    var s = String(pw == null ? '' : pw);
    if (!s) return { ok: false, error: '请输入密码' };
    if (s.length < PASSWORD_MIN) return { ok: false, error: '密码至少 ' + PASSWORD_MIN + ' 位' };
    if (s.length > 128) return { ok: false, error: '密码不能超过 128 位' };
    if (confirm !== undefined && confirm !== null && s !== confirm) {
      return { ok: false, error: '两次输入的密码不一致' };
    }
    return { ok: true, value: s };
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
    return {
      username: u.username,
      role: u.role,
      roleName: ROLE_NAME[u.role] || u.role,
      disabled: !!u.disabled,
      createdAt: u.createdAt || null,
      updatedAt: u.updatedAt || null
    };
  }

  /* ================= 登录态 ================= */

  function signSession(sess, cred) {
    return sha256Hex([sess.username, sess.role, sess.issuedAt, sess.exp, cred, SIGN_SALT].join('|'));
  }

  function issueSession(user, ttl) {
    var now = Date.now();
    var sess = { username: user.username, role: user.role, issuedAt: now, exp: now + ttl };
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

  /** 校验登录态：过期、账号被删 / 被停用、角色被改、签名被伪造，全部拦下 */
  function verifySession(sess, users) {
    if (!sess || typeof sess !== 'object') return Promise.resolve({ ok: false, error: '未登录' });
    if (!sess.username || !sess.role || !sess.exp || !sess.sig) {
      return Promise.resolve({ ok: false, error: '登录态不完整' });
    }
    if (Date.now() > sess.exp) return Promise.resolve({ ok: false, error: '登录已过期，请重新登录' });
    var u = findUser(users || loadUsers(), sess.username);
    if (!u) return Promise.resolve({ ok: false, error: '账号不存在或已被移除' });
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
    PERMISSIONS: PERMISSIONS,
    ITERATIONS: ITERATIONS,
    TTL_DEFAULT: TTL_DEFAULT,
    TTL_REMEMBER: TTL_REMEMBER,

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

    /** 首次使用：创建管理员账号并直接登录 */
    setup: function (username, password, confirm) {
      var self = this;
      if (this.hasUsers()) return Promise.resolve({ ok: false, error: '账号已初始化过，请直接登录' });
      var v = this.validate(username, password, confirm);
      if (!v.ok) return Promise.resolve(v);
      return makePasswordHash(v.password).then(function (hash) {
        var u = {
          username: v.username, role: ROLE.ADMIN, hash: hash,
          disabled: false, createdAt: Date.now(), updatedAt: Date.now()
        };
        self.users = [u];
        if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
        return issueSession(u, TTL_REMEMBER).then(function () {
          self.user = publicUser(u);
          return { ok: true, user: self.user };
        });
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
        if (u.disabled) return { ok: false, error: '该账号已被停用，请联系管理员' };
        var ttl = remember ? TTL_REMEMBER : TTL_DEFAULT;
        return issueSession(u, ttl).then(function () {
          self.user = publicUser(u);
          return { ok: true, user: self.user };
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

    addUser: function (username, password, role) {
      var self = this;
      if (!this.isAdmin()) return Promise.resolve({ ok: false, error: '仅管理员可管理账号' });
      var v = this.validate(username, password, password);
      if (!v.ok) return Promise.resolve(v);
      var roleVal = (role === ROLE.ADMIN) ? ROLE.ADMIN : ROLE.USER;
      this.users = loadUsers();
      if (findUser(this.users, v.username)) return Promise.resolve({ ok: false, error: '该用户名已存在' });
      return makePasswordHash(v.password).then(function (hash) {
        var u = {
          username: v.username, role: roleVal, hash: hash,
          disabled: false, createdAt: Date.now(), updatedAt: Date.now()
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
      u.updatedAt = Date.now();
      saveUsers(this.users);
      return { ok: true, user: publicUser(u) };
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
          u.hash = hash;
          u.updatedAt = Date.now();
          if (!saveUsers(self.users)) return { ok: false, error: '保存失败：浏览器本地存储不可用' };
          if (isSelf) {
            return issueSession(u, TTL_REMEMBER).then(function () { return { ok: true, resigned: true }; });
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
    validatePassword: validatePassword
  };

  global.Auth = Auth;
  if (typeof module !== 'undefined' && module.exports) module.exports = Auth;
})(typeof window !== 'undefined' ? window : globalThis);
