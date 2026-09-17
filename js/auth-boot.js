/* ============================================================
 * auth-boot.js — 登录关卡与启动引导（浏览器专用）
 *
 * 职责：
 *   1) 启动时先判登录态：有效 → 动态注入业务脚本并放行；无效 → 停在登录界面
 *   2) 未登录时业务脚本（store / stock-api / app…）根本不会被加载，
 *      数据不会进入内存，比「只用一个遮罩挡住 UI」更干净
 *   3) 首次使用引导创建管理员账号；日常使用提供「自助注册 + 审核」入口
 *
 * 关于注册审核（纯静态站的能力边界）：
 *   账号表存在各自浏览器的 localStorage 里，没有共享服务端。
 *   · 同一台设备：注册后立即出现在管理员的「用户管理 → 待审核」，点通过即可登录。
 *   · 不同设备：注册者把生成的「申请码」发给管理员 → 管理员粘贴导入并审核
 *     → 把系统生成的「准入码」发回 → 注册者粘贴后即可用自己的密码登录。
 *
 *   ⚠️ 因为「不同设备」时数据不会自己跑到管理员那边，注册完成页特意做了两件事：
 *   1) 「📨 复制申请信息，发给管理员」——复制出的是一段**人话消息 + 申请码 + 导入链接**，
 *      注册者直接粘到微信/QQ 发给管理员即可；
 *   2) 导入链接形如 `#admin-import?req=<申请码>`，管理员点开会被自动识别，
 *      登录后自动打开「用户管理」并把申请码填好，只需再点一下「导入申请」。
 *   本文件负责生成消息与捕获该链接（captureImportLink / takePendingImport）。
 *
 * 之所以「放行后才加载」，是因为纯静态站点没有服务端可以做重定向，
 * 用运行时按需注入脚本是最接近「未授权就拿不到」的做法。
 * ============================================================ */
(function (global) {
  'use strict';

  // 与 index.html 中静态资源版本号保持一致，避免升级后命中旧缓存
  var ASSET_V = '20260917m';

  // 管理员点开「注册申请导入链接」后，申请码暂存在这里，等业务层（app.js）就绪后取走
  var IMPORT_KEY = 'snt-pending-import-v1';

  // 业务脚本装载顺序（Vue 已在 <head> 静态加载，不在此列）
  var APP_SCRIPTS = [
    'js/store.js',
    'js/cloud-sync.js',
    'js/stock-api.js',
    'js/hot-topics.js',
    'js/app.js'
  ];

  function $(sel) { return document.querySelector(sel); }

  var elGate, elSub, elMsg, elLoading, elLoadingText, elRetry;
  var elLoginForm, elRegisterForm, elRegDone, elCodePanel;
  var elRegCode, elCodeInput, elStrength;
  var busy = false;
  // 最近一次注册成功的信息，供「📨 复制申请信息」按钮使用
  var lastReg = { username: '', code: '' };

  /* ---------------- 界面状态 ---------------- */

  function showMsg(text, type) {
    if (!elMsg) return;
    if (!text) { elMsg.hidden = true; elMsg.textContent = ''; elMsg.className = 'auth-msg'; return; }
    elMsg.hidden = false;
    elMsg.textContent = text;
    elMsg.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  function setBusy(text) {
    busy = !!text;
    if (elLoading) {
      elLoading.hidden = !busy;
      if (elLoadingText) elLoadingText.textContent = text || '';
    }
    [elLoginForm, elRegisterForm, elCodePanel].forEach(function (f) {
      if (!f) return;
      Array.prototype.forEach.call(f.querySelectorAll('input, button'), function (el) { el.disabled = busy; });
    });
  }

  var SUB_TEXT = {
    setup: '首次使用，请先创建管理员账号',
    login: '请登录后使用',
    register: '注册新账号 · 提交后需管理员审核',
    regdone: '注册申请已提交',
    code: '粘贴管理员发来的准入码'
  };

  function showForm(which) {
    if (elLoginForm) elLoginForm.hidden = which !== 'login';
    if (elRegisterForm) elRegisterForm.hidden = which !== 'register';
    if (elRegDone) elRegDone.hidden = which !== 'regdone';
    if (elCodePanel) elCodePanel.hidden = which !== 'code';
    if (elSub) elSub.textContent = SUB_TEXT[which] || SUB_TEXT.login;
    var focusMap = {
      setup: '#setup-username',
      register: '#reg-username',
      code: '#auth-code-input',
      login: '#login-username'
    };
    var sel = focusMap[which];
    var first = sel ? $(sel) : null;
    if (first) setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 60);
  }

  function showRetry(message) {
    if (!elRetry) return;
    elRetry.textContent = message ? (message + '　点击重试') : '点击重试';
    elRetry.hidden = false;
  }

  /** 密码强度提示（注册时实时显示，仅作提示不拦截） */
  function updateStrength() {
    if (!elStrength) return;
    var input = $('#reg-password');
    var pw = input ? input.value : '';
    if (!pw) { elStrength.hidden = true; return; }
    var s = (typeof Auth !== 'undefined' && Auth.passwordStrength)
      ? Auth.passwordStrength(pw) : { level: 1, text: '' };
    elStrength.hidden = false;
    elStrength.className = 'auth-strength lv' + s.level;
    var bar = elStrength.querySelector('i');
    var txt = elStrength.querySelector('span');
    if (bar) bar.style.width = Math.max(12, s.level * 20) + '%';
    if (txt) txt.textContent = '密码强度：' + s.text;
  }

  /** 复制到剪贴板：优先 clipboard API，失败退回 execCommand */
  function copyText(text, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        showMsg(ok ? okMsg : '复制失败，请手动选中上面的申请码复制', ok ? 'ok' : 'error');
      } catch (e) {
        showMsg('复制失败，请手动选中上面的申请码复制', 'error');
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { showMsg(okMsg, 'ok'); }).catch(fallback);
        return;
      }
    } catch (e) { /* 落到 fallback */ }
    fallback();
  }

  /** 静默复制：成功不提示、失败也不提示（用在脱离用户手势的自动复制场景） */
  function tryCopySilently(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { /* 被浏览器拒绝，忽略 */ });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 注册申请：生成「发给管理员」的消息与导入链接 ---------------- */

  /** 当前时间（本地/北京时间，形如 2026-09-17 17:20）。不能用 toISOString，UTC+8 凌晨会差一天 */
  function nowText() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 管理员一键导入的链接：打开后自动填好申请码 */
  function buildImportLink(code) {
    return location.origin + location.pathname + '#admin-import?req=' + encodeURIComponent(code);
  }

  /**
   * 组装完整申请信息（纯文本，直接粘到微信/QQ 即可）。
   * 既包含人能看懂的用户名/时间，也包含管理员需要的申请码与导入链接。
   */
  function buildRegMessage(username, code) {
    return '【股市信息分析系统】注册申请\n'
      + '用户名：' + username + '\n'
      + '提交时间：' + nowText() + '\n'
      + '——————\n'
      + '申请码（请完整转给管理员，勿增删字符，共 ' + code.length + ' 字符）：\n'
      + code + '\n'
      + '——————\n'
      + '管理员点开下面的链接会自动填好申请码，直接点「导入申请」即可：\n'
      + buildImportLink(code);
  }

  /**
   * 捕获地址栏里的管理员导入链接（`#admin-import?req=<申请码>`）。
   * 命中后立刻把 hash 清掉（避免刷新重复触发、也不把长串留在地址栏），
   * 申请码转存 sessionStorage，等业务层就绪后由 takePendingImport() 取走。
   */
  function captureImportLink() {
    var h = String(location.hash || '');
    if (h.indexOf('#admin-import') !== 0) return '';
    var req = '';
    var q = h.indexOf('?');
    if (q >= 0) {
      try {
        req = new URLSearchParams(h.slice(q + 1)).get('req') || '';
      } catch (e) { req = ''; }
    }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    if (req) {
      try { sessionStorage.setItem(IMPORT_KEY, req); } catch (e) { /* ignore */ }
    }
    return req;
  }

  /**
   * 普通用户的「注册直达链接」：`#register`（兼容 `#signup`）。
   * 用途：管理员把这一条链接发给要用工具的人，对方点开就是注册表单，
   *       不用先看登录页再自己找「注册新账号」——少一步就少一批人卡住。
   */
  function wantsRegister() {
    var h = String(location.hash || '').toLowerCase();
    return h === '#register' || h === '#signup';
  }

  /**
   * 离开注册表单时把 `#register` 从地址栏抹掉。
   * 不抹的话，用户点了「返回登录」以后再刷新页面又会被弹回注册表单，
   * 表现成「我想登录却一直让我注册」。
   */
  function clearRegisterHash() {
    if (!wantsRegister()) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  /** 业务层取走待导入的申请码（取一次即清，避免重复弹窗） */
  function takePendingImport() {
    var v = '';
    try {
      v = sessionStorage.getItem(IMPORT_KEY) || '';
      if (v) sessionStorage.removeItem(IMPORT_KEY);
    } catch (e) { v = ''; }
    return v;
  }

  /* 业务层（app.js）就绪后会注册下面的回调，用于「页面已经打开、只是 hash 变了」的场景 */
  var importHandler = null;
  function setImportHandler(fn) { importHandler = typeof fn === 'function' ? fn : null; }

  /**
   * 处理地址栏里的导入链接，两个入口都要覆盖：
   *   ① 冷加载（浏览器此前没打开本站）→ start() 里捕获，申请码存进 sessionStorage，
   *      随后 app.js 挂载时 takePendingImport() 取走；
   *   ② 热导航（本站已经开着，管理员只是点了条链接）→ 浏览器只换 hash、
   *      **不会重新加载页面**，必须靠 hashchange 事件在这里接住，直接回调业务层。
   *      漏掉 ② 会出现「点了链接却没反应」——这正是微信里点链接最常见的路径。
   */
  function onHashChange() {
    var req = captureImportLink();
    if (req) {
      if (importHandler) { importHandler(); return; }
      // 业务层还没就绪：多半停在登录页（注意 elGate 在进入应用后会被移出 DOM，
      // 这里必须查一次真实 DOM，否则提示会写进一个已脱离文档的节点、用户看不到）
      if (document.getElementById('auth-gate')) {
        showMsg('已收到用户发来的注册申请，请先用管理员账号登录，登录后会自动打开用户管理并填好申请码', 'warn');
      }
      return;
    }
    // 站点已经开着，有人把注册链接粘进地址栏 / 点了链接 → 直接切到注册表单，不必刷新
    // （登录成功后 auth-gate 会被移出 DOM，此时不该再动，交给业务层自己的路由）
    if (wantsRegister() && document.getElementById('auth-gate')) {
      showMsg('');
      showForm('register');
    }
  }

  /* ---------------- 动态装载业务脚本 ---------------- */

  /**
   * 单次脚本下载超时。
   * 注意：定时器是从「元素插入」就开始算的，而请求可能还排在连接队列里没发出去，
   * 所以它同时兜住了「请求排队」与「连接卡死」两种情况 —— 值不宜过大。
   */
  var LOAD_TIMEOUT = 20000;
  /** 单个脚本的最大尝试次数（含首次） */
  var LOAD_RETRIES = 3;

  /** 已成功装载的脚本（重试时跳过，避免重复注入触发 “已经声明过” 的语法错误） */
  var loadedScripts = [];

  /**
   * 装载单个脚本（一次尝试）。
   * @param {string} src 形如 js/store.js
   * @param {number} attempt 第几次尝试（>1 时附加 cache-buster，强制新建连接）
   */
  function loadOne(src, attempt) {
    return new Promise(function (resolve, reject) {
      var url = src + '?v=' + ASSET_V + (attempt > 1 ? '&_r=' + attempt : '');
      var s = document.createElement('script');
      var settled = false;
      function cleanup() {
        try { s.onload = null; s.onerror = null; } catch (e) { /* ignore */ }
        try { if (s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* ignore */ }
      }
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('加载超时：' + src));
      }, LOAD_TIMEOUT);
      s.src = url;
      s.async = false;
      s.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      s.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error('无法加载 ' + src));
      };
      document.body.appendChild(s);
    });
  }

  /**
   * 按顺序装载业务脚本，失败自动重试。
   * 之所以要重试：国内访问 github.io 偶发「连接建起来但迟迟不返回」，
   * 这种挂起既不会触发 onerror、也不会自己恢复，只能主动超时后换一条连接重来。
   * @param {function} [onProgress] (src, index, total, attempt) 进度回调
   */
  function loadScripts(list, onProgress) {
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= list.length) { resolve(); return; }
        var src = list[i++];
        if (loadedScripts.indexOf(src) >= 0) { next(); return; }
        var attempt = 0;
        (function tryOnce() {
          attempt++;
          if (onProgress) onProgress(src, i, list.length, attempt);
          loadOne(src, attempt).then(function () {
            loadedScripts.push(src);
            next();
          }).catch(function (err) {
            if (attempt < LOAD_RETRIES) { setTimeout(tryOnce, 600 * attempt); return; }
            var offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
            reject(new Error(err.message + (offline ? '（当前网络已断开）' : '（已自动重试 ' + LOAD_RETRIES + ' 次仍未成功，多为网络问题）')));
          });
        })();
      })();
    });
  }

  function hideGate() {
    if (!elGate) return;
    document.body.classList.remove('auth-locked');
    elGate.classList.add('auth-gate-hide');
    setTimeout(function () {
      if (elGate && elGate.parentNode) elGate.parentNode.removeChild(elGate);
    }, 340);
  }

  function enterApp() {
    showMsg('');
    setBusy('正在加载数据…');
    // 网络慢时把「正在加载第几/共几个脚本」显示出来，避免用户以为卡死
    var slowHint = setTimeout(function () {
      if (busy) setBusy('网络较慢，正在重试加载…请稍候');
    }, 12000);
    loadScripts(APP_SCRIPTS, function (src, idx, total) {
      if (!busy) return;
      setBusy('正在加载数据… (' + idx + '/' + total + ')');
    }).then(function () {
      clearTimeout(slowHint);
      setBusy('');
      hideGate();
      // 通知业务层登录成功（app.js 若已就绪可据此刷新界面）
      try {
        document.dispatchEvent(new CustomEvent('auth:ready', {
          detail: { user: Auth.currentUser }
        }));
      } catch (e) { /* 老浏览器不支持 CustomEvent 构造器时忽略 */ }
      }).catch(function (err) {
      clearTimeout(slowHint);
      setBusy('');
      showMsg(String(err && err.message ? err.message : err), 'error');
      showForm(Auth.hasUsers() ? 'login' : 'register');
      showRetry('资源加载失败，请检查网络后重试');
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    if (elLoginForm) {
      elLoginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        showMsg('');
        var u = $('#login-username') ? $('#login-username').value : '';
        var p = $('#login-password') ? $('#login-password').value : '';
        var remember = $('#login-remember') ? $('#login-remember').checked : true;
        setBusy('正在验证…');
        Auth.login(u, p, remember).then(function (r) {
          if (!r.ok) { setBusy(''); showMsg(r.error, 'error'); return; }
          setBusy('登录成功，正在进入…');
          enterApp();
        }).catch(function (err) {
          setBusy('');
          showMsg('登录失败：' + (err && err.message ? err.message : err), 'error');
        });
      });
    }

    /* ----- 注册：提交后进入待审核，并展示申请码 ----- */
    if (elRegisterForm) {
      elRegisterForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (busy) return;
        showMsg('');
        var u = $('#reg-username') ? $('#reg-username').value : '';
        var p = $('#reg-password') ? $('#reg-password').value : '';
        var c = $('#reg-confirm') ? $('#reg-confirm').value : '';
        // 先在本地把密码规则与二次确认校验掉，避免为一个必然失败的表单去算哈希
        var vw = Auth.validateUsername(u);
        if (!vw.ok) { showMsg(vw.error, 'error'); return; }
        var vp = Auth.validatePassword(p, c);
        if (!vp.ok) { showMsg(vp.error, 'error'); return; }
        setBusy('正在提交注册申请…');
        Auth.register(u, p).then(function (r) {
          setBusy('');
          if (!r.ok) { showMsg(r.error, 'error'); return; }
          var code = r.requestCode || '';
          lastReg = { username: (r.user && r.user.username) || '', code: code };
          if (elRegCode) elRegCode.value = code;
          var hint = $('#reg-code-hint');
          if (hint) hint.textContent = code
            ? '申请码共 ' + code.length + ' 个字符，请完整复制（漏掉一段会校验失败）'
            : '';
          showForm('regdone');
          showMsg('');
          // 顺手帮用户把「发给管理员」的消息准备好（静默尝试：注册是异步回调，
          // 已脱离用户手势，剪贴板可能被浏览器拒绝，失败不提示，用户可点按钮手动复制）
          tryCopySilently(code ? buildRegMessage(lastReg.username, code) : '');
          // 记录注册来源（异步，失败不影响注册结果）
          try {
            Auth.resolveIp().then(function (got) {
              Auth.attachRegisterMeta(r.user.username, {
                ip: got && got.ip ? got.ip : '',
                loc: got && got.loc ? got.loc : '',
                ua: (navigator && navigator.userAgent) || ''
              });
            }).catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }).catch(function (err) {
          setBusy('');
          showMsg('注册失败：' + (err && err.message ? err.message : err), 'error');
        });
      });
      var regPw = $('#reg-password');
      if (regPw) regPw.addEventListener('input', updateStrength);
    }

    /* ----- 注册者：粘贴准入码 ----- */
    if (elCodePanel) {
      var submitCode = function () {
        if (busy) return;
        showMsg('');
        var code = elCodeInput ? elCodeInput.value : '';
        var r = Auth.importApproveCode(code);
        if (!r.ok) { showMsg(r.error, 'error'); return; }
        if (elCodeInput) elCodeInput.value = '';
        var lu = $('#login-username');
        if (lu) lu.value = r.user.username;
        showForm('login');
        showMsg('准入码已生效，请用注册时设置的密码登录', 'ok');
      };
      var codeBtn = $('#auth-code-submit');
      if (codeBtn) codeBtn.addEventListener('click', submitCode);
    }

    /* ----- 视图切换 ----- */
    [['#auth-to-register', 'register'], ['#auth-to-code', 'code']].forEach(function (pair) {
      var btn = $(pair[0]);
      if (btn) btn.addEventListener('click', function () { showMsg(''); showForm(pair[1]); });
    });
    ['#auth-reg-back', '#auth-reg-done-back', '#auth-code-back'].forEach(function (sel) {
      var btn = $(sel);
      if (btn) btn.addEventListener('click', function () {
        showMsg('');
        // 用户是点 #register 直达链接进来的，离开注册表单就把 hash 清掉，
        // 否则他下次刷新又被弹回注册页（想登录却一直被要求注册）
        clearRegisterHash();
        showForm(Auth.hasUsers() ? 'login' : 'register');
      });
    });
    var sendBtn = $('#auth-reg-send');
    if (sendBtn) sendBtn.addEventListener('click', function () {
      var code = elRegCode ? elRegCode.value : lastReg.code;
      var name = lastReg.username || ($('#reg-username') ? $('#reg-username').value.trim() : '');
      if (!code) { showMsg('请先提交注册申请', 'error'); return; }
      copyText(buildRegMessage(name, code), '申请信息已复制，粘到微信 / QQ 发给管理员即可');
    });
    var copyBtn = $('#auth-reg-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var text = elRegCode ? elRegCode.value : '';
      if (!text) return;
      copyText(text, '申请码已复制，发给管理员即可');
    });

    if (elRetry) {
      elRetry.addEventListener('click', function () {
        elRetry.hidden = true;
        showMsg('');
        if (Auth.isLoggedIn()) enterApp();
        else start();
      });
    }

    // 会话在别的标签页被登出时，本页也退回登录界面
    global.addEventListener('storage', function (e) {
      if (e.key === 'snt-auth-session-v1' && !e.newValue && !document.getElementById('auth-gate')) {
        location.reload();
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    elGate = $('#auth-gate');
    elSub = $('#auth-sub');
    elMsg = $('#auth-msg');
    elLoading = $('#auth-loading');
    elLoadingText = $('#auth-loading-text');
    elLoginForm = $('#auth-login-form');
    elRegisterForm = $('#auth-register-form');
    elRegDone = $('#auth-reg-done');
    elCodePanel = $('#auth-code-panel');
    elRegCode = $('#reg-code');
    elCodeInput = $('#auth-code-input');
    elStrength = $('#reg-strength');
    elRetry = $('#auth-retry');

    if (!elGate) return; // 没有关卡节点（例如被裁剪过的页面）时不做任何拦截

    // 管理员点开「注册申请导入链接」时，先把申请码收好、把地址栏 hash 清掉
    var importCode = captureImportLink();
    // 用户点开管理员发的「注册直达链接」(#register) 时，直接落在注册表单
    var askRegister = wantsRegister();
    // 页面已经开着时点链接只换 hash、不会重载页面，靠这个监听补上
    global.addEventListener('hashchange', onHashChange);

    bind();
    Auth.init();

    if (!Auth.hasUsers()) {
      // 首次使用：登录页不再提供「创建管理员」入口，直接展示注册表单。
      // 首个管理员由后台（Auth.setup，开发者在控制台调用）创建，符合「管理员创建功能后台分配」。
      showForm('register');
      return;
    }

    Auth.restore().then(function (r) {
      if (r.ok) { enterApp(); return; }
      var hint = (r.error && r.error !== '未登录') ? r.error : '';
      // 带 #register 链接进来的（多半是管理员发给新用户的）优先显示注册表单
      showForm(askRegister ? 'register' : 'login');
      if (importCode) showMsg('已收到用户发来的注册申请，请先用管理员账号登录，登录后会自动打开用户管理并填好申请码', 'warn');
      else if (hint) showMsg(hint, 'warn');
    }).catch(function (err) {
      showForm('login');
      showMsg('初始化失败：' + (err && err.message ? err.message : err), 'error');
    });
  }

  /** 供业务层调用：退出登录（重新加载即可回到登录界面，业务脚本不会再装入） */
  function logout() {
    Auth.logout();
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
  }

  global.AuthUI = {
    start: start,
    logout: logout,
    enterApp: enterApp,
    showForm: showForm,
    /** 业务层（app.js）在就绪后取走待导入的注册申请码 */
    takePendingImport: takePendingImport,
    /** 业务层在就绪后注册「收到导入链接」的回调（页面未重载时走这条路） */
    setImportHandler: setImportHandler,
    ASSET_V: ASSET_V,
    APP_SCRIPTS: APP_SCRIPTS
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
