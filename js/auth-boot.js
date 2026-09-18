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
  var ASSET_V = '20260918k';

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
    // 防御：错误可能传来对象/undefined，避免页面出现 [object Object] 这类“乱码”
    if (text && typeof text === 'object') text = text.error || text.message || JSON.stringify(text);
    if (typeof text !== 'string') text = (text == null ? '' : String(text));
    if (!text) { elMsg.hidden = true; elMsg.textContent = ''; elMsg.className = 'auth-msg'; return; }
    elMsg.hidden = false;
    elMsg.textContent = text;
    elMsg.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 带按钮的提示（内容由本文件常量拼装，用户名经 escHtml 转义） */
  function showMsgHtml(html, type) {
    if (!elMsg) return;
    if (!html) { showMsg(''); return; }
    elMsg.hidden = false;
    elMsg.innerHTML = html;
    elMsg.className = 'auth-msg auth-msg-' + (type || 'info');
  }

  /**
   * batch16：账号停在「待审核」时不能只丢一句「等待管理员审核」就完事。
   * 管理员那边的通过 / 授权只写在他自己设备上，纯静态站没有服务端同步，
   * 用户必须拿到「准入码」粘到本机才能登录 —— 这里把这条出路直接摆到他面前。
   */
  function showPendingGuide(username) {
    var html = ''
      + '<div class="auth-guide-title">⏳ 该账号还需要一步才能登录</div>'
      + '<div class="auth-guide-text">本系统没有服务端，管理员在他自己设备上「通过审核 / 开通试用」'
      + '<b>不会自动同步到这台设备</b>。请让管理员把一串「准入码」发给你，粘贴到本机后即可用原密码登录。</div>'
      + '<div class="auth-msg-actions">'
      + '<button type="button" class="auth-guide-btn" id="auth-guide-code">📋 我有准入码，去粘贴</button>'
      + '<button type="button" class="auth-guide-btn auth-guide-btn-ghost" id="auth-guide-resend">📨 复制我的申请码</button>'
      + '</div>';
    showMsgHtml(html, 'warn');
    var b1 = document.getElementById('auth-guide-code');
    if (b1) b1.addEventListener('click', function () { showMsg(''); showForm('code'); });
    var b2 = document.getElementById('auth-guide-resend');
    if (b2) b2.addEventListener('click', function () {
      var r = Auth.requestCodeFor(username);
      if (!r || !r.ok) { showMsg((r && r.error) || '取回申请码失败', 'error'); return; }
      copyText(buildRegMessage(r.username, r.requestCode), '申请信息已复制，发给管理员即可');
    });
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
   * 只包含人能看懂的用户名/时间 + 申请码本身，**不带任何链接**（2026-09-17 batch15 用户要求）：
   * 链接会让对方以为要点开，也会让申请码看起来像一长串网址；现在用户复制一段纯码发过来即可。
   */
  function buildRegMessage(username, code) {
    return '【股市信息分析系统】注册申请\n'
      + '用户名：' + username + '\n'
      + '提交时间：' + nowText() + '\n'
      + '——————\n'
      + '申请码（请完整转给管理员，勿增删字符，共 ' + code.length + ' 字符）：\n'
      + code;
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
    // 极端时序：游客预览开着时 Auth.restore() 才异步返回「已登录」，
    // 若不收起预览层，业务应用会挂载在它下面、看起来像没登录成功。
    removeGuestView();
    document.body.classList.remove('guest-mode');
    document.body.classList.remove('auth-locked');
    elGate.classList.add('auth-gate-hide');
    setTimeout(function () {
      if (elGate && elGate.parentNode) elGate.parentNode.removeChild(elGate);
    }, 340);
  }

  /* ---------------- 游客预览 ----------------
   * 点登录卡片右上角的 ✕ 进来：**不登录、也不加载任何业务脚本**，
   * 只把 index.html 里 `<template id="guest-tpl">` 那段纯静态骨架克隆出来。
   *
   * 为什么用 <template> + 用完即删，而不是常驻一个 hidden 的 div：
   *   骨架为了像素级一致复用了 .page-toolbar / .toolbar-right / .news-table 等 app 的 class。
   *   若它常驻 DOM（哪怕 hidden），这些选择器就会同时命中两处 ——
   *   不但既有 E2E 会撞 Playwright strict mode，将来做功能验证也容易被假阳性骗到。
   *   `<template>` 的内容不算 document 的一部分，不进 DOM、不被任何选择器看到。 */

  var guestHintTimer = null;

  function showGuestHint(text) {
    var box = $('#guest-hint');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    if (guestHintTimer) clearTimeout(guestHintTimer);
    guestHintTimer = setTimeout(function () { box.hidden = true; guestHintTimer = null; }, 2200);
  }

  /** 惰性挂载骨架；已挂载则直接返回 */
  function ensureGuestView() {
    var g = $('#guest-view');
    if (g) return g;
    var tpl = document.getElementById('guest-tpl');
    if (!tpl || !tpl.content) return null;
    document.body.appendChild(tpl.content.cloneNode(true));
    return $('#guest-view');
  }

  function removeGuestView() {
    var g = $('#guest-view');
    if (g && g.parentNode) g.parentNode.removeChild(g);
    if (guestHintTimer) { clearTimeout(guestHintTimer); guestHintTimer = null; }
  }

  function enterGuest() {
    var g = ensureGuestView();
    if (!g) return;
    // 关卡只能加 class 淡出——不能用 hideGate，它会把节点删掉，回来就没得用了
    if (elGate) elGate.classList.add('auth-gate-hide');
    document.body.classList.remove('auth-locked');
    // guest-mode 会把「透明度归零的关卡」和「未挂载 Vue 的 #app 原始模板」一起 display:none：
    // 只靠透明度的话，#app 里那些 position:fixed 的 modal-overlay 会浮上来吃掉所有点击。
    document.body.classList.add('guest-mode');
    var back = g.querySelector('.guest-login-btn');
    if (back) { try { back.focus(); } catch (e) { /* ignore */ } }
  }

  function leaveGuest() {
    document.body.classList.add('auth-locked');
    document.body.classList.remove('guest-mode');
    removeGuestView();
    if (elGate) {
      elGate.classList.remove('auth-gate-hide');
      // 回到卡片时清掉上一轮残留的报错/忙碌态，免得看到过期提示
      showMsg('');
      setBusy('');
    }
    var u = elLoginForm && !elLoginForm.hidden ? $('#login-username') : null;
    if (u) { try { u.focus(); } catch (e) { /* ignore */ } }
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
          if (!r.ok) {
            setBusy('');
            // 待审核：给出可操作的下一步（粘贴准入码 / 重新取申请码），而不是干等
            if (r.status === Auth.STATUS.PENDING) showPendingGuide(u);
            else showMsg(r.error, 'error');
            return;
          }
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
          // batch16：同一台设备重复提交时不再报错，直接把同一个申请码再给一次，并说清楚不用重复申请
          if (r.alreadySubmitted) {
            showMsg('这台设备已经提交过「' + ((r.user && r.user.username) || lastReg.username)
              + '」的注册申请，下面还是同一个申请码，直接发给管理员即可，不必重复提交。', 'warn');
          }
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
        // 恒回到登录表单：即使本机还没有任何账号（跨设备 / 已拿准入码的场景），
        // 「返回登录」也必须能落到登录页，而不是再弹回注册表单卡死。
        showForm('login');
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
    // 注册完成屏：等待审核的用户拿到管理员回传的「准入码」后，一条直达粘贴准入码，
    // 不必先点「返回登录」再找「已通过审核？粘贴准入码」（initial 反馈里缺这条路径）。
    var regDoneCodeBtn = $('#auth-reg-done-code');
    if (regDoneCodeBtn) regDoneCodeBtn.addEventListener('click', function () {
      showMsg('');
      showForm('code');
    });

    if (elRetry) {
      elRetry.addEventListener('click', function () {
        elRetry.hidden = true;
        showMsg('');
        if (Auth.isLoggedIn()) enterApp();
        else start();
      });
    }

    /* ----- 显示 / 隐藏密码（登录 + 注册） ----- */
    Array.prototype.forEach.call(document.querySelectorAll('.auth-pw-toggle'), function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById(btn.getAttribute('data-pw'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('is-on', show);
        btn.textContent = show ? '🙈' : '👁️';
        try { input.focus(); } catch (e) { /* ignore */ }
      });
    });

    // ---- 游客预览：✕ 进入；骨架里「登录」按钮点回卡片；其余交互只提示 ----
    var elAuthClose = $('#auth-close');
    if (elAuthClose) {
      elAuthClose.addEventListener('click', function () { enterGuest(); });
    }
    // 骨架是惰性克隆出来的，绑不到固定节点上，所以在 document 上做事件委托
    document.addEventListener('click', function (e) {
      if (!document.getElementById('guest-view')) return;
      var t = e.target && e.target.closest ? e.target.closest('.guest-login-btn, [data-need-login]') : null;
      if (!t) return;
      e.preventDefault();
      if (t.classList.contains('guest-login-btn')) { leaveGuest(); return; }
      showGuestHint('请先登录后再使用这个功能');
    });
    // Esc 也能从游客预览退回登录卡片
    global.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (document.getElementById('guest-view')) leaveGuest();
    });

    // 会话在别的标签页被变更时，本页同步：登出或切换到其他账号都应即时生效，
    // 保证「同一浏览器多标签页」下每个账户的登录态互相独立、刷新/切换后保持一致。
    global.addEventListener('storage', function (e) {
      if (e.key !== 'snt-auth-session-v1') return;
      if (!document.getElementById('auth-gate')) {
        if (!e.newValue) { location.reload(); return; }   // 被登出
        var cur = Auth.session && Auth.session.username;
        try {
          var nv = e.newValue ? JSON.parse(e.newValue) : null;
          if (!nv || !nv.username || nv.username !== cur) location.reload();  // 切换了账号
        } catch (e2) { location.reload(); }
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
      // 首次使用：直接展示「登录」表单（含「注册新账号」「已通过审核？粘贴准入码」两个入口）。
      // 不再强制注册表单——否则本机还没有任何账号的用户（例如跨设备免码登录、
      // 或已拿到管理员准入码的人）会被困在注册页，点「返回登录」也回不去，
      // 表现成「初次登录没有准入码入口」。注册入口仍在登录表单内，新用户点一下即可。
      showForm('login');
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
    enterGuest: enterGuest,
    leaveGuest: leaveGuest,
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
