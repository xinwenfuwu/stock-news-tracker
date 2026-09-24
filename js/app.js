/**
 * 主应用 - Vue 3
 * 页面1：新闻追踪  页面2：股票池  页面3：热门板块
 */
const { createApp, ref, reactive, computed, onMounted, watch, nextTick } = Vue;

const app = createApp({
  setup() {
    // 每个账号读自己的那份数据（同一浏览器上切账号互不可见），
    // 所以必须把当前账号传进去 —— 详见 store.js 的 resolveKey()
    Store.init(Vue, (typeof Auth !== 'undefined' && Auth && Auth.user)
      ? { username: Auth.user.username, role: Auth.user.role }
      : null);
    const D = Store.data;

    // ===== 数据迁移：relatedStocks 字符串 → 数组 =====
    D.news.forEach(n => {
      if (typeof n.relatedStocks === 'string') {
        n.relatedStocks = StockAPI.parseStockInput(n.relatedStocks);
      } else if (!Array.isArray(n.relatedStocks)) {
        n.relatedStocks = [];
      }
    });

    // ===== 路由 =====
    const currentPage = ref('news');
    const tabs = [
      { key: 'holdings', label: '用户', icon: '👤' },
      { key: 'news', label: '新闻追踪', icon: '📰' },
      { key: 'finance', label: '全球信息', icon: '🌐' },
      { key: 'pools', label: '股票池', icon: '📅' },
      { key: 'sector', label: '选股', icon: '🧭' },
      { key: 'filter', label: '板块成分股', icon: '🎯' },
      { key: 'hot', label: '热门板块', icon: '🔥' }
    ];
    // batch52：每日快讯面板现在同时挂在「新闻追踪」页顶部与「全球信息」页右栏（同一份数据、同一套交互），
    // 因此这两个页面任一激活都要触发一次自动加载——原来只认 finance，会导致新闻页那份永远停在
    // 「暂无快讯数据，等待服务端定时抓取」。autoLoadBriefs 内部有 _briefLoaded 幂等保护，重复调用无副作用。
    const PAGES_WITH_BRIEFS = ['news', 'finance'];
    function maybeAutoLoadBriefs(page) { if (PAGES_WITH_BRIEFS.indexOf(page) >= 0) autoLoadBriefs(); }
    function goPage(key) {
      currentPage.value = key;
      location.hash = key;
      // 进入「全球信息」页：优先展示最近可用的内置快照（同源、无需代理），再考虑实时抓取
      if (key === 'finance') autoLoadHotTopics();
      maybeAutoLoadBriefs(key);
    }
    // 初始化路由
    const hash = location.hash.replace('#', '');
    if (['news', 'holdings', 'finance', 'pools', 'sector', 'filter', 'hot'].includes(hash)) currentPage.value = hash;
    // 监听 hashchange：支持通过 URL 锚点直接跳转页面（如 index.html#finance），
    // 否则仅靠 goPage 点击切换，外部改 location.hash 不会更新 currentPage。
    // 这里只同步 currentPage，具体的「进入页面加载」交给已有的 watch(currentPage)。
    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (['news', 'holdings', 'finance', 'pools', 'sector', 'filter', 'hot'].includes(h)) {
        if (currentPage.value !== h) currentPage.value = h;
      }
    });

    // ===== 登录账号与权限 =====
    // Auth 由 js/auth.js 提供；auth-boot.js 只在登录通过后才加载本文件，
    // 因此正常情况下这里一定拿得到已登录用户。
    const A = (typeof Auth !== 'undefined' && Auth) ? Auth : null;
    const authUser = ref(A && A.user ? A.user : null);
    // 登录 / 切换账号后，auth-boot 的 enterApp 会派发 auth:ready；据此把响应式 authUser 同步成最新登录用户。
    // 否则切换账号后模板（如 v-if="can('settings.write')"）不会重渲染，齿轮/管理员入口会停留在上一次登录的角色。
    document.addEventListener('auth:ready', function () {
      authUser.value = (A && A.user) ? A.user : null;
    });
    const userMenuOpen = ref(false);
    const userList = ref([]);
    const userModal = reactive({
      show: false, newUsername: '', newPassword: '', newRole: 'user',
      pending: [], pendingRole: {}, reqCode: ''
    });
    const pwModal = reactive({ show: false, username: '', oldPassword: '', newPassword: '', confirmPassword: '' });
    // 用户管理：哪些账号的密码已展开、哪个账号的登录记录已展开
    const revealedPw = reactive({});
    const expandedUser = ref(null);
    /* 「重置密码」的行内输入区（batch14 起不再用 window.prompt）：
       一次只展开一行；error 承载行内校验提示，不弹 alert。 */
    const resetPw = reactive({ show: false, username: '', newPassword: '', confirmPassword: '', error: '', reveal: false });

    /* ===== 注册申请站内提醒（管理员） =====
     * 纯静态站没有服务端推送，所以这里监视「本机账号表」里的待审核记录：
     *   · 同一台设备上有人注册 → 账号表本机写入 → 角标/提醒条立刻出现
     *   · 跨设备 → 管理员粘贴「申请码」导入本机后，同样立刻出现
     * 因此提醒的准确含义是「有多少申请已经到了你本机、还没处理」，
     * 它不能替代注册者把申请发给管理员这一步（注册完成页已做一键转发）。 */
    const ADMIN_SEEN_KEY = 'snt-admin-pending-seen-v1';
    const pendingCount = ref(0);      // 待审核总数 → 角标数字
    const pendingNewCount = ref(0);   // 其中「上次查看之后新增」的数量 → 红色高亮
    const adminAlert = reactive({ show: false, count: 0, names: '' });
    // 用户点过「稍后再说」时记住当时未读的条数：只有**又来了更多**申请才再次弹出，
    // 否则同一批申请会被反复打扰
    const adminAlertMutedAt = ref(0);

    function readAdminSeen() {
      const v = Number(localStorage.getItem(ADMIN_SEEN_KEY) || 0);
      return isFinite(v) && v > 0 ? v : 0;
    }

    /** 扫描本机账号表的待审核申请，刷新角标与提醒条（只读 localStorage，不发任何网络请求） */
    function scanPending() {
      if (!can('users.manage') || !A || typeof A.pendingUsers !== 'function') {
        pendingCount.value = 0; pendingNewCount.value = 0; adminAlert.show = false; return;
      }
      let list = [];
      try { list = A.pendingUsers() || []; } catch (e) { list = []; }
      pendingCount.value = list.length;
      const seen = readAdminSeen();
      const fresh = list.filter(p => Number(p.createdAt || 0) > seen);
      pendingNewCount.value = fresh.length;
      if (!fresh.length) { adminAlert.show = false; return; }
      adminAlert.count = fresh.length;
      const names = fresh.slice(0, 3).map(p => p.username).join('、');
      adminAlert.names = fresh.length > 3
        ? `${names} 等 ${fresh.length} 人提交了注册申请`
        : `${names} 提交了注册申请`;
      // 用户点过「稍后再说」就不再自动弹出，但角标仍在；
      // 一旦又来了新的申请（未读条数增加），重新弹出提醒
      if (fresh.length > adminAlertMutedAt.value) adminAlert.show = true;
    }

    /** 打开用户管理即视为「已查看」，角标转为已读（数字仍保留，提醒条收起） */
    function markPendingSeen() {
      try { localStorage.setItem(ADMIN_SEEN_KEY, String(Date.now())); } catch (e) { /* ignore */ }
      pendingNewCount.value = 0;
      adminAlert.show = false;
      adminAlertMutedAt.value = 0;
    }

    function dismissAdminAlert() {
      adminAlert.show = false;
      adminAlertMutedAt.value = pendingNewCount.value;
    }

    /** 点提醒条上的「去审核」：打开用户管理并定位到待审核区 */
    function goReviewPending() {
      adminAlert.show = false;
      openUserManage();
    }

    /**
     * 管理员点开注册者发来的「导入链接」（#admin-import?req=…）时：
     * 自动打开用户管理并把申请码填好，管理员只需再点一下「导入申请」。
     */
    function consumeImportLink() {
      const code = (typeof AuthUI !== 'undefined' && AuthUI.takePendingImport)
        ? AuthUI.takePendingImport() : '';
      if (!code) return;
      if (!can('users.manage')) {
        showToast('这个链接需要管理员账号才能导入注册申请', 'error');
        return;
      }
      openUserManage();           // 内部会把 reqCode 清空，所以赋值必须放在它后面
      userModal.reqCode = code;
      showToast('已自动填好用户发来的申请码，点「导入申请」即可', 'success');
      nextTick(() => {
        const bar = document.querySelector('.um-code-bar');
        if (!bar) return;
        try { bar.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
        const input = bar.querySelector('input');
        if (input) {
          try {
            input.focus();
            // 申请码很长，输入框会自动滚到末尾；移回开头便于确认收到的是 SNTREG1. 申请码
            if (input.setSelectionRange) input.setSelectionRange(0, 0);
          } catch (e) { /* ignore */ }
        }
      });
    }

    const authInitial = computed(() => {
      const n = (authUser.value && authUser.value.username) ? authUser.value.username : '?';
      return n.slice(0, 1).toUpperCase();
    });

    const authExpiryText = computed(() => {
      const s = A && A.session;
      if (!s || !s.exp) return '本次会话有效';
      const d = new Date(s.exp);
      const p = n => String(n).padStart(2, '0');
      return '有效期至 ' + Store.fmtDate(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    });

    /** 权限判定：UI 只是把入口藏起来，真正的拦截在 Auth 的方法内部再做一次。
     *  必须用响应式的 authUser.value，否则切换账号后模板不会重渲染（Auth.user 非响应式）。 */
    function can(perm) { return !!(A && A.can(perm, authUser.value)); }

    function fmtDateTime(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      const p = n => String(n).padStart(2, '0');
      return Store.fmtDate(d) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    /** 秒 → 「1小时23分」/「12分钟」/「56秒」；0 显示「—」 */
    function fmtDuration(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      if (!s) return '—';
      if (s < 60) return s + '秒';
      const m = Math.floor(s / 60);
      if (m < 60) return m + '分钟';
      const h = Math.floor(m / 60);
      const rm = m % 60;
      if (h < 24) return h + '小时' + (rm ? rm + '分' : '');
      return Math.floor(h / 24) + '天' + (h % 24) + '小时';
    }

    /** 状态徽标配色：待审核=黄、已驳回/停用=红、管理员=琥珀、正常=灰底 */
    function badgeClass(u) {
      if (u.status === 'pending') return 'pending';
      if (u.status === 'rejected') return 'rejected';
      if (u.disabled) return 'off';
      return u.role === 'admin' ? 'admin' : 'user';
    }

    /** 密码列显示：默认打码，只有管理员点过「显示」才展示明文 */
    function passwordText(u) {
      if (!u.hasPassword) return '未保存';
      return revealedPw[u.username] ? (u._plain || '••••') : '••••••••';
    }

    function doLogout() {
      userMenuOpen.value = false;
      if (typeof AuthUI !== 'undefined' && AuthUI.logout) AuthUI.logout();
      else if (A) { A.logout(); location.reload(); }
    }

    /** 刷新账号列表：管理员看到明细（含登录档案），其他情况只有公开字段 */
    function refreshUserList() {
      if (!A) { userList.value = []; userModal.pending = []; scanPending(); return; }
      const all = (typeof A.listUsersDetail === 'function') ? A.listUsersDetail() : A.listUsers();
      userList.value = all;
      userModal.pending = all.filter(u => u.status === 'pending');
      userModal.pending.forEach(p => {
        if (!userModal.pendingRole[p.username]) userModal.pendingRole[p.username] = 'user';
      });
      // 新增/导入/通过/驳回 都会走到这里，顺带同步角标
      scanPending();
    }

    function openUserManage() {
      userMenuOpen.value = false;
      if (!can('users.manage')) { showToast('仅管理员可管理账号', 'error'); return; }
      // 确保「GitHub 令牌」响应式变量反映已保存的值（即使没先打开设置也能显示同步按钮）
      try { authAdminToken.value = (localStorage.getItem('snt-auth-admin-token') || '').trim(); } catch (e) { /* ignore */ }
      userModal.newUsername = ''; userModal.newPassword = ''; userModal.newRole = 'user';
      userModal.reqCode = '';
      expandedUser.value = null;
      Object.keys(revealedPw).forEach(k => delete revealedPw[k]);
      refreshUserList();
      // 跨设备免码：管理员已配令牌时，同步自己的账号 + 拉云端注册表待审名单
      if (A && A.Sync && A.Sync.isAdminConfigured && A.Sync.isAdminConfigured()) {
        A.syncSelfToRegistry();
        loadRemotePending();
      }
      userModal.show = true;
      markPendingSeen();   // 打开面板即视为已查看，收起提醒条、角标转已读
    }

    function addUserByAdmin() {
      if (!A) return;
      A.addUser(userModal.newUsername, userModal.newPassword, userModal.newRole).then(r => {
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`已添加用户「${r.user.username}」`, 'success');
        userModal.newUsername = ''; userModal.newPassword = ''; userModal.newRole = 'user';
        refreshUserList();
      }).catch(e => showToast('添加失败：' + e.message, 'error'));
    }

    function changeUserRole(u, role) {
      if (!A) return;
      const r = A.setUserRole(u.username, role);
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      showToast(`「${u.username}」已设为${A.roleName(role)}`, 'success');
      refreshUserList();
    }

    function toggleUserDisabled(u) {
      if (!A) return;
      const r = A.setUserDisabled(u.username, !u.disabled);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      showToast(`「${u.username}」已${u.disabled ? '启用' : '停用'}`, 'success');
      refreshUserList();
    }

    function removeUserByAdmin(u) {
      if (!A) return;
      if (!confirm(`确定删除用户「${u.username}」？删除后该账号无法再登录。`)) return;
      const r = A.removeUser(u.username);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      showToast('已删除用户', 'success');
      refreshUserList();
    }

    /* ---------- 试用（三层：一天 / 三天 / 一周） ---------- */
    /** 三档试用时长；label 用于按钮文案「试用一天 / 试用三天 / 试用一周」 */
    const trialDayOptions = [
      { days: 1, label: '一天' },
      { days: 3, label: '三天' },
      { days: 7, label: '一周' }
    ];

    /**
     * 给某个普通用户开通试用。
     * 开通后即便账号还在「待审核」，该用户也能用自己的密码登录（按普通用户对待）；
     * 试用到期后登录与已发出的会话立即失效，账号回到待审核。
     */
    function grantUserTrial(u, days) {
      if (!A) return;
      const r = A.grantTrial(u.username, days);
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      showToast(`已给「${u.username}」开通${r.label}试用（至 ${r.untilText}）`, 'success');
      refreshUserList();
      /* batch16：试用只落在这台设备的账号表里。不把准入码转给对方，
       * 他那边就没有这段试用期，登录时依旧提示「等待管理员审核」。 */
      if (r.approveCode) {
        copyText(r.approveCode, `已开通试用，准入码已复制到剪贴板`);
        showApproveCodePanel({
          title: `「${u.username}」已开通${r.label}试用（至 ${r.untilText}）`,
          desc: '试用期目前只写在这台设备上。如果对方用别的手机 / 电脑登录，'
            + '必须把这串准入码发给他，他在登录页粘贴后，本机才会有同一段试用期。'
            + '不转发的话，他那边仍然会提示「等待管理员审核」。',
          code: r.approveCode
        });
      }
    }

    function revokeUserTrial(u) {
      if (!A) return;
      const r = A.revokeTrial(u.username);
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      showToast(`已结束「${u.username}」的试用，账号回到待审核`, 'success');
      refreshUserList();
    }

    /* ---------- 会员额度（注册日期 / 额度 / 停用日期） ---------- */
    function setUserRegisterDate(u, val) {
      if (!A) return;
      const r = A.setUserMembership(u.username, { registerDate: val });
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      showToast(`「${u.username}」注册日期已更新`, 'success');
      refreshUserList();
    }

    function setUserQuota(u, val) {
      if (!A) return;
      const r = A.setUserMembership(u.username, { quotaMonths: val });
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      if (r.user && r.user.disabled && r.user.autoDisabled) {
        showToast(`「${u.username}」会员已到期，系统已自动停用`, 'warn');
      } else {
        showToast(`「${u.username}」会员额度已更新`, 'success');
      }
      refreshUserList();
    }

    /** 停用日期是否已超过今天（'YYYY-MM-DD' 字符串比较） */    function isExpiredDate(s) {
      if (!s) return false;
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      return today > s;
    }

    /* ---------- 重置密码：行内输入区（batch14 替换掉原来的 window.prompt） ---------- */

    /** 打开某账号的重置面板（已打开同一行则收起，做成开关） */
    function openResetPassword(u) {
      if (!A) return;
      if (resetPw.show && resetPw.username === u.username) { cancelResetPassword(); return; }
      resetPw.show = true;
      resetPw.username = u.username;
      resetPw.newPassword = '';
      resetPw.confirmPassword = '';
      resetPw.reveal = false;
      resetPw.error = '';
    }

    function cancelResetPassword() {
      resetPw.show = false;
      resetPw.username = '';
      resetPw.newPassword = '';
      resetPw.confirmPassword = '';
      resetPw.reveal = false;
      resetPw.error = '';
    }

    /** 生成 12 位随机密码（含大小写字母与数字，去掉 0/O/1/l/I 等易混字符）并复制 */
    function genResetPassword() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const n = 12;
      let pw = '';
      try {
        const buf = new Uint32Array(n);
        (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(buf)
          : buf.forEach((_, i) => { buf[i] = Math.floor(Math.random() * 4294967296); });
        for (let i = 0; i < n; i++) pw += chars[buf[i] % chars.length];
      } catch (e) {
        for (let i = 0; i < n; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      }
      resetPw.newPassword = pw;
      resetPw.confirmPassword = pw;
      resetPw.reveal = true;      // 随机密码直接明文显示，方便核对/抄给用户
      resetPw.error = '';
      copyText(pw, '已生成随机密码并复制到剪贴板');
    }

    function submitResetPassword() {
      if (!A) return;
      const who = resetPw.username;
      if (!who) return;
      const v = A.validatePassword(resetPw.newPassword || '', resetPw.confirmPassword || '');
      if (!v.ok) { resetPw.error = v.error; return; }
      const np = resetPw.newPassword;
      resetPw.error = '';
      A.changePassword(who, null, np).then(r => {
        if (!r.ok) { resetPw.error = r.error; return; }
        // 密文里带有可显示用的封装，改完要清掉旧的「已展开」状态
        delete revealedPw[who];
        cancelResetPassword();
        refreshUserList();
        copyText(np, `已重置「${who}」的密码，新密码已复制到剪贴板`);
      }).catch(e => { resetPw.error = '重置失败：' + (e && e.message ? e.message : e); });
    }

    /* ---------- 注册审核 ---------- */

    function approveUserByAdmin(u) {
      if (!A) return;
      const role = userModal.pendingRole[u.username] || (u.status === 'pending' ? 'user' : u.role);
      const r = A.approveUser(u.username, role);
      if (!r.ok) { showToast(r.error, 'error'); refreshUserList(); return; }
      refreshUserList();
      const code = r.approveCode || '';
      // 是否已配置 GitHub 令牌：决定云端注册表是否可写、对方能否「免准入码」直接登录。
      // approveUser 内部已自动把该账号同步进云端注册表（_syncUserToRegistry），无需手动再点。
      const cloudReady = !!(A.Sync && A.Sync.isAdminConfigured && A.Sync.isAdminConfigured());
      if (cloudReady) {
        // 审核通过的同时账号已写入云端，对方设备登录时用账号密码直接读取、免准入码。
        // 不再强制弹准入码面板，避免诱导管理员去发码、用户去抄码。
        showToast(`已通过「${u.username}」并已同步到云端，对方现在可用账号密码直接登录（免准入码）`, 'success');
        return;
      }
      // 未配置令牌：云端同步不可用，退回准入码流程（与历史行为一致，保证可用）。
      if (code) {
        copyText(code, `已通过「${u.username}」，准入码已复制到剪贴板`);
        showApproveCodePanel({
          title: `已通过「${u.username}」的注册申请`,
          desc: '本账号在这台设备上已直接生效。\n\n'
            + '⚠️ 如果对方用的是别的手机 / 电脑，他那边并不会自动通过——'
            + '请务必把这串「准入码」发给他，他在登录页点「已通过审核？粘贴准入码」粘贴后，'
            + '用注册时设置的密码即可登录。不转发的话，他那边会一直提示「等待管理员审核」。',
          code: code
        });
      } else {
        showToast(`已通过「${u.username}」`, 'success');
      }
    }

    function rejectUserByAdmin(u) {
      if (!A) return;
      const note = prompt(`驳回「${u.username}」的注册申请？可填写原因（可留空）：`, '');
      if (note == null) return;
      const r = A.rejectUser(u.username, note);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      showToast(`已驳回「${u.username}」的注册申请`, 'success');
      refreshUserList();
    }

    function importRequestCode() {
      if (!A) return;
      const r = A.applyRequestCode(userModal.reqCode);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      userModal.reqCode = '';
      refreshUserList();
      showToast(`已导入「${r.user.username}」的注册申请，请审核`, 'success');
    }

    /* ---------- 跨设备免码：云端注册表（GitHub）待审 ---------- */

    /** 从云端注册表拉待审名单（需管理员令牌）。失败静默，保留空列表走本地兜底。 */
    async function loadRemotePending() {
      remotePending.value = [];
      if (!A || !A.Sync || !A.Sync.isAdminConfigured || !A.Sync.isAdminConfigured()) return;
      remotePendingLoading.value = true;
      try {
        const r = await A.Sync.fetchPending();
        if (r && r.ok && Array.isArray(r.list)) {
          remotePending.value = r.list.map(x => ({ username: x.username, createdAt: x.createdAt || 0 }));
        }
      } catch (e) { /* 网络问题忽略 */ }
      finally { remotePendingLoading.value = false; }
    }

    /** 管理员一键通过：本地审核 + 自动同步到云端注册表，对方设备登录时直接读取、无需粘贴准入码 */
    async function approveRemoteByAdmin(item) {
      if (!A) return;
      if (!A.Sync || !A.Sync.isAdminConfigured || !A.Sync.isAdminConfigured()) {
        showToast('请先在「设置」填写 GitHub 令牌（仅管理员），才能把账号同步到云端注册表', 'error'); return;
      }
      const r = A.approveUser(item.username, 'user');
      if (!r || !r.ok) { showToast((r && r.error) || '通过失败', 'error'); return; }
      showToast(`已通过「${item.username}」，已同步到云端注册表，对方现在可直接登录（免准入码）`, 'success');
      await loadRemotePending();
      refreshUserList();
    }

    /** 管理员驳回：本地 + 同步云端注册表 */
    async function rejectRemoteByAdmin(item) {
      if (!A) return;
      if (!A.Sync || !A.Sync.isAdminConfigured || !A.Sync.isAdminConfigured()) {
        showToast('请先在「设置」填写 GitHub 令牌（仅管理员），才能同步云端注册表', 'error'); return;
      }
      const r = A.rejectUser(item.username);
      if (!r || !r.ok) { showToast((r && r.error) || '驳回失败', 'error'); return; }
      showToast(`已驳回「${item.username}」`, 'success');
      await loadRemotePending();
      refreshUserList();
    }

    /** 管理员手动把本机全部账号同步到云端注册表（用户管理面板按钮） */
    async function syncAllToRegistryByAdmin() {
      if (!A) return;
      if (!A.Sync || !A.Sync.isAdminConfigured || !A.Sync.isAdminConfigured()) {
        showToast('请先在「设置」填写 GitHub 令牌（仅管理员），才能同步云端注册表', 'error'); return;
      }
      showToast('正在同步本机账号到云端注册表…', 'info');
      const r = await A.syncAllToRegistry();
      if (!r || !r.ok) { showToast((r && r.error) || '同步失败', 'error'); return; }
      showToast(`已同步 ${r.count} 个账号到云端注册表`, 'success');
      await loadRemotePending();
      refreshUserList();
    }

    function showApproveCode(u) {
      if (!A) return;
      const r = A.approveCodeFor(u.username);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      copyText(r.approveCode, '准入码已复制到剪贴板');
      showApproveCodePanel({
        title: `「${u.username}」的准入码`,
        desc: '把这串码发给对方，他在登录页点「已通过审核？粘贴准入码」粘贴后即可用注册时设置的密码登录。'
          + '码里同时带了他当前的审核状态、试用期与会员额度，粘贴后两边授权保持一致。',
        code: r.approveCode
      });
    }

    /** 管理员查看密码：按需从混淆存储还原，只放在内存里 */
    function toggleRevealPassword(u) {
      if (!A) return;
      if (revealedPw[u.username]) { delete revealedPw[u.username]; delete u._plain; return; }
      // batch15：改造前创建 / 由账号表导入的账号没有 pwSeal，明文根本不存在。
      // 这时不能只是干瞪眼——说明原因 + 直接把该行的「重置密码」面板展开，管理员设个新密码就能看了。
      if (!u.hasPassword) {
        showToast('「' + u.username + '」是改造前创建或由账号表导入的账号，系统里没有保存可显示的密码。已为你打开「重置密码」，设一个新密码后即可显示。', 'info', 6000);
        openResetPassword(u);
        return;
      }
      const r = A.revealPassword(u.username);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      u._plain = r.password;
      revealedPw[u.username] = true;
    }

    function revealPendingPassword(p) {
      if (!A) return;
      const r = A.revealPassword(p.username);
      showToast(r.ok ? `「${p.username}」当前密码：${r.password}` : r.error, r.ok ? 'info' : 'error');
    }

    function copyPassword(u) {
      if (!A) return;
      const r = A.revealPassword(u.username);
      if (!r.ok) { showToast(r.error, 'error'); return; }
      copyText(r.password, `「${u.username}」的密码已复制`);
    }

    function toggleLoginLog(u) {
      expandedUser.value = expandedUser.value === u.username ? null : u.username;
    }

    /** 复制文本（优先用剪贴板 API，不可用时退回选中+execCommand） */
    function copyText(text, okMsg) {
      const done = () => showToast(okMsg || '已复制', 'success');
      const fail = () => showToast('复制失败，请手动选中复制', 'error');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
          return;
        }
      } catch (e) { /* 落到 fallback */ }
      fallback();
      function fallback() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? done() : fail();
        } catch (e) { fail(); }
      }
    }

    function exportUsersTable() {
      if (!A) return;
      const blob = new Blob([A.exportUsers()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'stock-news-accounts-' + Store.today() + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('账号表已导出（含密码密文与登录记录，请妥善保管）', 'success');
    }

    function importUsersTable(e) {
      const file = e.target.files && e.target.files[0];
      if (!file || !A) return;
      const reader = new FileReader();
      reader.onload = () => {
        const r = A.importUsers(String(reader.result), 'merge');
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`已导入账号表，当前共 ${r.count} 个账号`, 'success');
        refreshUserList();
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    function openChangePassword() {
      userMenuOpen.value = false;
      if (!A || !A.user) return;
      pwModal.username = A.user.username;
      pwModal.oldPassword = ''; pwModal.newPassword = ''; pwModal.confirmPassword = '';
      pwModal.show = true;
    }

    function submitChangePassword() {
      if (!A) return;
      if (pwModal.newPassword !== pwModal.confirmPassword) { showToast('两次输入的新密码不一致', 'error'); return; }
      A.changePassword(pwModal.username, pwModal.oldPassword, pwModal.newPassword).then(r => {
        if (!r.ok) { showToast(r.error, 'error'); return; }
        pwModal.show = false;
        authUser.value = A.user;
        showToast('密码已修改', 'success');
      }).catch(e => showToast('修改失败：' + e.message, 'error'));
    }

    /* ===== 使用时长统计 + 登录 IP 归档 =====
     * 语义说明：
     *   · 时长只在「页面可见 + 5 分钟内有操作」时累计，挂机不计；每 30 秒落一次盘。
     *   · IP 通过第三方接口查询一次（结果缓存在会话里），**不受数据刷新暂停影响以外的干扰**：
     *     但为遵守既有「暂停后进入页面不自动发外部请求」的约定，暂停时不查询，该次登录记为「未获取到」。
     */
    let hbTimer = null;
    let hbLastAt = Date.now();
    let hbLastActive = Date.now();
    const HB_IDLE_MS = 5 * 60 * 1000;

    function hbMarkActive() { hbLastActive = Date.now(); }
    function hbTick() {
      const now = Date.now();
      const delta = Math.round((now - hbLastAt) / 1000);
      hbLastAt = now;
      if (!A || !A.touchSession || !A.session) return;
      if (document.hidden) return;
      if (delta <= 0) return;
      if (now - hbLastActive > HB_IDLE_MS) return;
      A.touchSession(Math.min(delta, 150));
    }
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => {
      window.addEventListener(ev, hbMarkActive, { passive: true });
    });
    document.addEventListener('visibilitychange', () => {
      hbLastAt = Date.now();
      if (!document.hidden) hbMarkActive();
    });
    window.addEventListener('beforeunload', hbTick);
    hbTimer = setInterval(hbTick, 30000);

    /** 登录后补写 IP / 设备（异步，失败不影响使用） */
    function syncLoginMeta() {
      if (!A || !A.syncLoginMeta) return;
      if (autoRefreshPaused()) return;   // 暂停时不发任何自动外部请求
      A.syncLoginMeta().catch(() => {});
    }

    // ===== Toast =====
    const toast = reactive({ show: false, msg: '', type: 'info', _t: null });
    function showToast(msg, type = 'info', ms = 2800) {
      toast.msg = msg;
      toast.type = type;
      toast.show = true;
      clearTimeout(toast._t);
      toast._t = setTimeout(() => (toast.show = false), ms);
    }

    // ===== 数据刷新总开关（顶部「暂停」按钮） =====
    // 语义：暂停的是「自动」发起的刷新——进入页面自动抓取热门话题、导入后自动补价、
    // 板块详情自动补历史价、数据变化后自动云同步。手动点击的刷新按钮一律照常执行，
    // 否则暂停后整个页面会变成「点什么都没反应」，那反而是个 bug。
    if (typeof D.settings.dataPaused !== 'boolean') D.settings.dataPaused = false;
    const dataPaused = computed({
      get: () => !!D.settings.dataPaused,
      set: (v) => { D.settings.dataPaused = !!v; }
    });
    /** 自动刷新是否已被暂停（各处自动刷新逻辑统一走这里判断） */
    function autoRefreshPaused() { return !!D.settings.dataPaused; }
    /** 被暂停时的统一提示（只在真正会发起自动请求的位置调用，避免刷屏） */
    function pauseHint(what) {
      showToast(`已暂停数据自动刷新：未执行${what || '自动刷新'}。可点顶部 ▶ 恢复，或手动点刷新按钮`, 'info');
    }
    function toggleDataPause() {
      dataPaused.value = !dataPaused.value;
      if (dataPaused.value) {
        showToast('已暂停数据自动刷新（进入页面不再自动抓取、不再自动云同步；手动刷新按钮照常可用）', 'info');
      } else {
        showToast('已恢复数据自动刷新', 'success');
        if (currentPage.value === 'finance') autoLoadHotTopics();
        maybeAutoLoadBriefs(currentPage.value);
      }
    }

    // ===== 通用格式化 =====
    const allCategories = computed(() => D.settings.categories || Store.DEFAULT_CATEGORIES);

    function fmt(v) {
      if (v == null || v === '' || isNaN(v)) return '—';
      return (+v).toFixed(2);
    }
    function fmtPct(v) {
      if (v == null || v === '' || isNaN(v)) return '—';
      const n = +v;
      return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
    }
    /** 带正负号的金额（盈亏用；绝对价如市值仍用 fmt） */
    function fmtSigned(v) {
      if (v == null || v === '' || isNaN(v)) return '—';
      const n = +v;
      return (n > 0 ? '+' : '') + n.toFixed(2);
    }
    /** 日期 YYYY-MM-DD → YYYY年MM月DD日 */
    function fmtDateCN(dateStr) {
      if (!dateStr) return '';
      const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}年${m[2]}月${m[3]}日`;
      return dateStr;
    }
    function numClass(v) {
      if (v == null || v === '' || isNaN(v)) return 'muted';
      const n = +v;
      if (n > 0) return 'up';      // 正数：红
      if (n < 0) return 'down';    // 负数：绿
      return 'flat';
    }
    function pctClass(v) {
      if (v == null || v === '' || isNaN(v)) return 'muted';
      const n = +v;
      if (n > 0) return 'up';
      if (n < 0) return 'down';
      return 'flat';
    }

    // ===== 股票池财务字段格式化与计算 =====

    /** 金额(元) → 亿字符串，如 44516880421 → 445.17亿 */
    function fmtYi(v) {
      if (v == null || isNaN(v)) return '—';
      return (+v / 1e8).toFixed(2) + '亿';
    }
    /** 亿元数字 */
    function yiVal(v) {
      return v == null || isNaN(v) ? null : +(v / 1e8);
    }
    /** 数值相除工具（安全） */
    function ratio(a, b) {
      if (a == null || b == null || isNaN(a) || isNaN(b)) return null;
      if (+b === 0) return null;
      return +(+a / +b);
    }
    /**
     * 市值类比值计算。
     * 统一用「亿元」：总市值=totalMarketCap(亿)，净利润/扣非/营收=元→转亿（yiVal）。
     * 量纲必然自洽（亿 ÷ 亿 = 倍数），所以三个「市值比」**一律不再做任何缩放**：
     * 市净比(pbRatio) = 总市值 ÷ 净利润
     * 市扣比(pkRatio) = 总市值 ÷ 扣非净利润
     * 市营比(prRatio) = 总市值 ÷ 营业收入
     * 🔴 batch54：市净比/市扣比原先各有一个 `÷ 10` 的历史缩放，已按用户要求删除
     *    —— 它与量纲无关，会把 12.5 倍的市净比错显示成 1.25；改前请先确认三个字段
     *    的取值来源单位（市值=亿、财务三项=元后转亿），别再引入新的系数。
     * 市净同比(pyRatio) = 总市值 ÷ 净利润同比增长率(profitYoY)
     * 市扣同比(pk2Ratio) = 总市值 ÷ 扣非净利润同比增长率(kcfYoY)
     * 市营同比(prrRatio) = 总市值 ÷ 营收同比增长率(revenueYoY)
     * 市净环比(ph2Ratio) = 总市值 ÷ 净利润环比增长率(hbGrowth)
     * 市扣环比(pkHbRatio) = 总市值 ÷ 扣非净利润环比增长率(kcfHb)
     * 市营环比(phRatio) = 总市值 ÷ 营收环比增长率(revHb)
     */
    function sRatio(s) {
      const cap = s.totalMarketCap;
      const net = yiVal(s.netProfit);     // 净利润(亿)
      const kcf = yiVal(s.kcfjcxjlr);     // 扣非净利润(亿)
      const rev = yiVal(s.revenue);       // 营业收入(亿)
      const p = ratio(cap, net);           // 总市值/净利润
      const k = ratio(cap, kcf);           // 总市值/扣非净利润
      const pr = ratio(cap, rev);          // 总市值/营业收入
      // 三个「市值比」同口径：都是「市值(亿) ÷ 财务项(亿)」的倍数，不再有额外系数
      const pRatio = p != null ? +p.toFixed(2) : null;          // 市净比
      const kRatio = k != null ? +k.toFixed(2) : null;          // 市扣比
      const prRatio = pr != null ? +pr.toFixed(2) : null;       // 市营比
      // 市净同比 = 总市值 ÷ 净利润同比增长率(profitYoY)
      const py = s.profitYoY != null && +s.profitYoY !== 0 ? +(+cap / +s.profitYoY).toFixed(2) : null;
      // 市扣同比 = 总市值 ÷ 扣非净利润同比增长率(kcfYoY)
      const pk2 = s.kcfYoY != null && +s.kcfYoY !== 0 ? +(+cap / +s.kcfYoY).toFixed(2) : null;
      // 市营同比 = 总市值 ÷ 营收同比增长率(revenueYoY)
      const prrRatio = s.revenueYoY != null && +s.revenueYoY !== 0 ? +(+cap / +s.revenueYoY).toFixed(2) : null;
      // 市净环比 = 总市值 ÷ 净利润环比增长率(hbGrowth)
      const ph2 = s.hbGrowth != null && +s.hbGrowth !== 0 ? +(+cap / +s.hbGrowth).toFixed(2) : null;
      // 市扣环比 = 总市值 ÷ 扣非净利润环比增长率(kcfHb)
      const pkHb = s.kcfHb != null && +s.kcfHb !== 0 ? +(+cap / +s.kcfHb).toFixed(2) : null;
      // 市营环比 = 总市值 ÷ 营收环比增长率(revHb)
      const ph = s.revHb != null && +s.revHb !== 0 ? +(+cap / +s.revHb).toFixed(2) : null;
      return { pbRatio: pRatio, pkRatio: kRatio, pyRatio: py, pk2Ratio: pk2, phRatio: ph, prRatio, prrRatio, ph2Ratio: ph2, pkHbRatio: pkHb };
    }

    function parseStocks(val) {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') return StockAPI.parseStockInput(val);
      return [];
    }

    /** 从 stock 对象列表生成可读字符串 */
    function stocksText(val) {
      return parseStocks(val).map(s => s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)).join(', ');
    }

    /** 取纯代码 */
    function pureCode(code) {
      return StockAPI.pureCode(code);
    }

    // ============================================================
    //  通用：收藏
    // ============================================================
    const favorites = computed(() => D.favorites || []);
    const sortedFavorites = computed(() => {
      const list = [...(D.favorites || [])];
      if (favSort.key === '__idx') {
        const dir = favSort.dir === 'asc' ? 1 : -1;
        const pos = new Map(list.map((s, i) => [s, i]));
        list.sort((a, b) => (pos.get(a) - pos.get(b)) * dir);
      } else if (favSort.key) {
        const dir = favSort.dir === 'asc' ? 1 : -1;
        list.sort((a, b) => compareForSort(a, b, favSort.key) * dir);
      } else {
        list.sort((a, b) => (b.favDate || '').localeCompare(a.favDate || ''));
      }
      return list;
    });
    function isFav(code) { return Store.isFavorite(code); }
    /** 收藏/取消收藏（股票对象）—— 保存完整股票字段，使收藏板块可展示与概念选股一致的字段 */
    function toggleFavorite(stock) {
      if (!stock || !stock.code) return;
      if (Store.isFavorite(stock.code)) {
        Store.removeFavorite(stock.code);
        showToast(`已取消收藏「${stock.name || stock.code}」`, 'success');
      } else {
        const fav = _newStock(stock);
        fav.favDate = Store.today();
        fav.note = '';
        // 添加当日股价快照：供「距添加」字段计算基准，且不会被后续行情刷新覆盖
        fav.favPrice = (stock.todayPrice != null && !isNaN(stock.todayPrice)) ? +stock.todayPrice : null;
        // 复制现有数据字段（若来源已带行情/财务数据则一并保存）
        const keys = ['industry','dailyChange','amplitude','capitalFlow','shareholderCount','prevShareholderCount',
          'profitYoY','revenueYoY','hbGrowth','kcfYoY','revHb','kcfHb','q24Rev','q24Kcf',
          'netProfit','kcfjcxjlr','revenue','totalMarketCap',
          'contractLiab','todayPrice','yearStartPrice','price924','yearChange','change924',
          'weekAgoClose','monthAgoClose','weekChange','monthChange','turnover',
          'yearHighPrice','yearLowPrice','favPrice'];
        keys.forEach(k => { if (stock[k] != null) fav[k] = stock[k]; });
        const ok = Store.addFavorite(fav);
        if (ok) showToast(`已收藏「${stock.name || stock.code}」`, 'success');
      }
    }
    function removeFavorite(code) {
      const f = (D.favorites || []).find(f => f.code === code);
      if (f && confirm(`确认取消收藏「${f.name || code}」？`)) {
        Store.removeFavorite(code);
        showToast('已取消收藏', 'success');
      }
    }
    function updateFavNote(fav, note) {
      Store.updateFavoriteNote(fav.id, note);
      showToast('备注已保存', 'success');
    }

    // ============================================================
    //  batch41：通用股票备注（所有表格都能填，且跨表共享）
    //  原先备注只挂在「收藏记录」上：非收藏表（股票池详情 / 概念选股板块详情 / 筛选 / 热门明细）
    //  的备注列渲染的是只读文本，用户在这些表里根本填不进去 —— 这正是「备注无法填写」的根因。
    //  现改为按「纯 6 位代码」统一存放在 D.stockNotes，任何表格都可直接编辑，且同一只股票
    //  在所有表里显示同一条备注；读取时回退老的 fav.note，历史数据不丢。
    // ============================================================
    /** 备注键：统一用纯 6 位数字代码，避免 sh600519 / 600519 被当成两只股票 */
    function _noteKey(code) {
      try { return StockAPI.pureCode(code) || String(code || ''); }
      catch (e) { return String(code || ''); }
    }
    /** 按代码找收藏记录（兼容带/不带市场前缀两种写法） */
    function _findFavByCode(code) {
      const k = _noteKey(code);
      return (D.favorites || []).find(x => x.code === code || _noteKey(x.code) === k) || null;
    }
    /** 读某只股票的备注：优先通用备注表，其次回退到收藏记录上的旧字段 */
    function stockNoteOf(code) {
      const k = _noteKey(code);
      if (!k) return '';
      const store = D.stockNotes || {};
      if (store[k] != null) return String(store[k]);
      if (store[code] != null) return String(store[code]);
      const f = _findFavByCode(code);
      return (f && f.note) ? String(f.note) : '';
    }
    /**
     * 写某只股票的备注（空内容 = 删除该备注）。
     * 同时同步到收藏记录上的 note 字段：老版本的收藏表/云端旧数据仍按该字段读取，保持向后兼容。
     */
    function setStockNote(code, text, opts) {
      const k = _noteKey(code);
      if (!k) return;
      const val = String(text == null ? '' : text).trim();
      if (!D.stockNotes) D.stockNotes = {};
      if (val) D.stockNotes[k] = val; else delete D.stockNotes[k];
      const f = _findFavByCode(code);
      if (f && f.note !== val) f.note = val;
      if (!opts || opts.quiet !== true) showToast(val ? '备注已保存' : '备注已清空', 'success');
    }
    /** 收藏距今天数 */
    function favDays(fav) {
      if (!fav.favDate) return null;
      return Store.daysSince(fav.favDate);
    }
    /**
     * 「距添加」：自加入收藏以来的涨跌幅(%)
     * 计算规则：(现价 - 添加当日股价) / 添加当日股价 × 100
     * 添加当日股价取自收藏快照字段 favPrice（收藏时写入，历史数据缺失时由刷新流程按收藏日期回填当日收盘价）。
     */
    function favGainPct(fav) {
      if (!fav) return null;
      const base = fav.favPrice;
      const cur = fav.todayPrice;
      if (base == null || cur == null || isNaN(base) || isNaN(cur) || !base) return null;
      return +(((cur - base) / base) * 100).toFixed(2);
    }
    /** 回填「添加当日股价」：缺失 favPrice 时，按收藏日期取当日收盘价（历史收藏同样适用） */
    async function ensureFavPrice(fav) {
      if (!fav || !fav.code || !fav.favDate) return;
      if (fav.favPrice != null && !isNaN(fav.favPrice)) return;
      try {
        // 收藏日若为非交易日则无K线，向后顺延 7 天取首个交易日收盘价
        const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const d0 = new Date(fav.favDate);
        const d1 = new Date(d0.getTime() + 7 * 86400000);
        const rows = await StockAPI.getKline(fav.code, ymd(d0), ymd(d1));
        const close = rows && rows.length ? rows[0].close : null;
        if (close != null && !isNaN(close)) {
          fav.favPrice = close;
          Store.save();
        }
      } catch (e) {
        console.debug('添加日股价回填失败', fav.code, e);
      }
    }
    // 收藏板块手动新增
    const favAddCode = ref('');
    const favAddName = ref('');
    const favAdding = ref(false);   // 请求U：名称反查需要联网，加上按钮 loading 态避免重复点击
    /* 请求U：以前这里强制「必须有代码」，且代码不经 inferPrefix 规范化（存进去的 '600519'
     * 没有 sh/sz 前缀 → 行情接口查不到 → 表现同样是「刷新不出数据」）。
     * 现在：① 只填名称也能加（走三级降级反查代码）；② 只填代码自动补市场前缀；③ 两者都填以代码为准。 */
    async function addFavoriteManual() {
      const rawCode = String(favAddCode.value || '').trim();
      const rawName = String(favAddName.value || '').trim();
      if (!rawCode && !rawName) { showToast('请输入股票代码或名称', 'error'); return; }
      favAdding.value = true;
      try {
        let code = rawCode ? StockAPI.inferPrefix(rawCode) : '';
        let name = rawName;
        if (!code && name) {
          showToast(`正在识别「${name}」...`, 'info');
          const pend = [{ name: name, code: '' }];
          await StockAPI.resolveStockNames(pend);
          if (pend[0].code) { code = pend[0].code; name = pend[0].name || name; }
        }
        if (!code) {
          showToast(`未能识别「${rawName || rawCode}」，请检查名称或改用 6 位代码`, 'error');
          return;
        }
        // 手动添加也用完整字段结构，便于表格展示一致字段
        const fav = _newStock({ code, name: name || code });
        fav.favDate = Store.today();
        fav.note = '';
        const ok = Store.addFavorite(fav);
        if (ok) {
          showToast(`已收藏「${name || code}」`, 'success');
          favAddCode.value = '';
          favAddName.value = '';
        } else {
          showToast('该股票已在收藏中', 'info');
        }
      } catch (e) {
        showToast('添加失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        favAdding.value = false;
      }
    }
    /** 补全单只股票的财务/股东/历史价数据（东财，best-effort）。供收藏/股票池/热门表刷新复用。 */
    async function enrichStockFinancials(s) {
      if (!s || !s.code) return;
      try {
        const [flow, fin] = await Promise.all([
          StockAPI.getCapitalFlow(s.code),
          StockAPI.getFinance(s.code)
        ]);
        if (flow != null) s.capitalFlow = flow;
        if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
        if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
        if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
        if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
        if (fin.revHb != null) s.revHb = fin.revHb;
        if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
        if (fin.netProfit != null) s.netProfit = fin.netProfit;
        if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
        if (fin.revenue != null) s.revenue = fin.revenue;
        if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
        if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
        if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
      } catch (e) { console.warn('财务数据获取失败', s.code, e); }
      try {
        const q24 = await StockAPI.getQuarterlyFinance(s.code);
        if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
        if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
      } catch (e) { console.warn('季报对比获取失败', s.code, e); }
      // 历史价：优先「一次请求取四项」（getHistoryBundle，请求量降为 1/3），
      // 取不到的项再逐项兜底。各项独立 try —— 原先四项挤在同一个 try 里，
      // 只要 getYearStartPrice 抛异常，后面三项就永远不会执行，六个字段全部空白。
      try {
        const hb = await StockAPI.getHistoryBundle(s.code);
        if (hb) {
          if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
          if (hb.price924 != null) s.price924 = hb.price924;
          if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
          if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
          if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
          if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
          if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
          if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
        }
      } catch (e) { console.warn('历史价批量获取失败', s.code, e); }
      if (s.yearStartPrice == null) {
        try {
          const yp = await StockAPI.getYearStartPrice(s.code);
          if (yp != null) s.yearStartPrice = yp;
        } catch (e) { console.warn('年初价获取失败', s.code, e); }
      }
      if (s.price924 == null) {
        try {
          const p924 = await StockAPI.get924Price(s.code);
          if (p924 != null) s.price924 = p924;
        } catch (e) { console.warn('924价获取失败', s.code, e); }
      }
      if (s.yearHighPrice == null || s.yearLowPrice == null) {
        try {
          const yhl = await StockAPI.getYearHighLow(s.code);
          if (yhl) {
            if (yhl.high != null) s.yearHighPrice = yhl.high;
            if (yhl.low != null) s.yearLowPrice = yhl.low;
          }
        } catch (e) { console.warn('今年高低价获取失败', s.code, e); }
      }
      // 所属行业 / 主营构成（best-effort，仅在缺失时请求，避免重复拉取）
      try {
        if (!s.industry) {
          const ind = await StockAPI.getIndustry(s.code);
          if (ind) s.industry = ind;
        }
      } catch (e) { console.warn('行业获取失败', s.code, e); }
      try {
        if (!s.mainBusiness) {
          const mb = await StockAPI.getMainBusiness(s.code);
          if (mb) s.mainBusiness = mb;
        }
      } catch (e) { console.warn('主营构成获取失败', s.code, e); }
      if (s.todayPrice && s.yearStartPrice) {
        s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
      }
      if (s.todayPrice && s.price924) {
        s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
      }
      // 一周涨跌 / 一月涨跌：现价 vs 5 / 20 个交易日前收盘价
      if (s.todayPrice && s.weekAgoClose) {
        s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
      }
      if (s.todayPrice && s.monthAgoClose) {
        s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
      }
    }

    // 刷新收藏股票行情与财务数据
    const favRefreshing = ref(false);
    async function refreshFavorites() {
      const favs = D.favorites || [];
      if (!favs.length) { showToast('暂无收藏股票', 'error'); return; }
      favRefreshing.value = true;
      showToast('正在刷新收藏行情...', 'info');
      try {
        // 1) 实时行情（腾讯）
        let quotes = {};
        try { quotes = await StockAPI.getQuotes(favs.map(f => f.code).filter(Boolean)); }
        catch (e) { console.warn('收藏行情刷新失败', e); }
        for (const f of favs) {
          const q = quotes[f.code];
          if (q) {
            f.name = f.name || q.name;
            f.dailyChange = q.changePercent;
            f.amplitude = q.amplitude;
            f.turnover = q.turnover;
            f.todayPrice = q.price || f.todayPrice;
            if (q.totalMarketCap) f.totalMarketCap = q.totalMarketCap;
          }
        }
        showToast('行情已刷新，正在获取财务数据...', 'info');
        // 2) 财务/股东数据（东财，best-effort，复用共享补全逻辑）
        for (let i = 0; i < favs.length; i++) {
          // 「距添加」基准价缺失时（如历史收藏/手动添加），按收藏日期回填当日收盘价
          await ensureFavPrice(favs[i]);
          await enrichStockFinancials(favs[i]);
        }
        showToast('收藏行情已刷新', 'success');
      } catch (e) {
        showToast('刷新失败，请重试', 'error');
        console.warn('收藏刷新异常', e);
      } finally {
        favRefreshing.value = false;
      }
    }

    // ============================================================
    //  页面1：新闻追踪
    // ============================================================
    const newsFilter = reactive({ date: '', keyword: '', category: '', customTag: '' });

    // ---- 联网搜索（豆包） ----
    // 原「自定义标记 / 散户参考」输入框只能在本页已录入的新闻里筛选，查不到外部信息；
    // 这里把同一个输入框接上豆包联网搜索：输入关键词后点「🫘 豆包搜索」（或回车）即用该
    // 关键词打开豆包，同时保留原有的本页筛选行为，不丢能力。
    const DOUBAO_SEARCH_BASE = 'https://www.doubao.com/chat/?q=';
    /** 复制文本（优先 clipboard API，失败退回 execCommand），返回是否成功 */
    function copyPlainText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () { /* 忽略：仅为兜底便利 */ });
          return true;
        }
      } catch (e) { /* 落到 execCommand */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }
    /**
     * 用关键词打开豆包联网搜索（新标签页）。
     * 之所以额外复制一遍关键词：豆包是单页应用，若浏览器/豆包版本忽略了 URL 里的 q 参数，
     * 用户仍可直接粘贴继续搜索，不会白点一次。
     */
    function doubaoSearch(keyword) {
      const q = String(keyword != null ? keyword : newsFilter.customTag || '').trim();
      if (!q) { showToast('请先输入要联网搜索的关键词', 'error'); return; }
      const url = DOUBAO_SEARCH_BASE + encodeURIComponent(q);
      let win = null;
      try { win = window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { win = null; }
      copyPlainText(q);
      if (!win) {
        showToast('浏览器拦截了新窗口，关键词已复制，请手动打开豆包粘贴搜索', 'warn');
        return;
      }
      showToast(`已打开豆包搜索「${q}」（关键词也已复制，可直接粘贴）`, 'success');
    }

    // 财经推送：右侧嵌入财经网页（与 Store 数据同源，自动持久化）
    const financePush = Store.data.financePush;
    function toggleFinanceLock() {
      if (!financePush.locked) {
        // 锁定：需先有网址
        if (!financePush.url || !financePush.url.trim()) {
          showToast('请先输入财经网址再锁定', 'error');
          return;
        }
        financePush.url = financePush.url.trim();
        financePush.locked = true;
        showToast('已锁定，财经网页已固定', 'success');
      } else {
        financePush.locked = false;
        showToast('已解锁财经推送', 'info');
      }
    }

    // 财经推送页面：推送新闻到「新闻追踪」
    const financePushNews = reactive({
      content: '',          // 新闻内容（必填）
      url: '',              // 来源链接（可选）
      date: Store.today(),  // 新闻日期
      category: '',         // 概念分类（可选）
      relatedStocks: [],    // 关联股票 [{name, code}]
      stockSearch: '',
      suggestions: [],
      _searchTimer: null
    });
    function onFinanceStockSearch() {
      clearTimeout(financePushNews._searchTimer);
      const kw = financePushNews.stockSearch.trim();
      if (!kw) { financePushNews.suggestions = []; return; }
      financePushNews._searchTimer = setTimeout(async () => {
        try {
          const results = await StockAPI.searchStocks(kw);
          const exist = new Set((financePushNews.relatedStocks || []).map(s => s.code));
          financePushNews.suggestions = results
            .filter(r => r.type === 'GP-A' || r.type === 'GP-S' || !r.type)
            .filter(r => !exist.has(r.code)).slice(0, 8);
        } catch (e) { financePushNews.suggestions = []; }
      }, 300);
    }
    function addFinanceStock(s) {
      if (!Array.isArray(financePushNews.relatedStocks)) financePushNews.relatedStocks = [];
      if (!financePushNews.relatedStocks.find(x => x.code === s.code)) {
        financePushNews.relatedStocks.push({ name: s.name, code: s.code });
      }
      financePushNews.stockSearch = '';
      financePushNews.suggestions = [];
    }
    function removeFinanceStock(idx) {
      if (Array.isArray(financePushNews.relatedStocks)) financePushNews.relatedStocks.splice(idx, 1);
    }
    function pushFinanceNews() {
      const content = (financePushNews.content || '').trim();
      if (!content) { showToast('请输入新闻内容', 'error'); return; }
      const url = (financePushNews.url || '').trim();
      const fullContent = url ? `🔗 ${url}\n${content}` : content;
      const item = {
        date: financePushNews.date || Store.today(),
        content: fullContent,
        conceptCategory: '',
        industryCategory: '',
        customTag: '',
        relatedStocks: (financePushNews.relatedStocks || []).map(s => ({ name: s.name, code: s.code })),
        category: financePushNews.category || '',
        newsDayPrice: null, price924: null, todayPrice: null
      };
      item.daysSince = Store.daysSince(item.date);
      const added = Store.addNews(item);
      fillPriceForNews(added, true);
      showToast('已推送到新闻追踪', 'success');
      // 重置表单（保留日期）
      financePushNews.content = '';
      financePushNews.url = '';
      financePushNews.relatedStocks = [];
      financePushNews.category = '';
      financePushNews.stockSearch = '';
      financePushNews.suggestions = [];
    }
    const selectedNewsIds = ref([]);
    const sortKey = ref('daysSince');
    const sortDir = ref('desc');
    const priceLoading = ref(false);

    const filteredNews = computed(() => {
      let list = D.news;
      if (newsFilter.date) list = list.filter(n => n.date === newsFilter.date);
      if (newsFilter.category) list = list.filter(n => n.category === newsFilter.category);
      if (newsFilter.customTag) {
        const kw = newsFilter.customTag.toLowerCase();
        list = list.filter(n => (n.customTag || '').toLowerCase().includes(kw));
      }
      if (newsFilter.keyword) {
        const kw = newsFilter.keyword.toLowerCase();
        list = list.filter(n =>
          (n.content || '').toLowerCase().includes(kw) ||
          stocksText(n.relatedStocks).toLowerCase().includes(kw) ||
          (n.conceptCategory || '').toLowerCase().includes(kw) ||
          (n.industryCategory || '').toLowerCase().includes(kw) ||
          (n.customTag || '').toLowerCase().includes(kw)
        );
      }
      return list;
    });

    const sortedNews = computed(() => {
      const list = [...filteredNews.value];
      const k = sortKey.value;
      const dir = sortDir.value === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        let va = a[k], vb = b[k];
        if (k === 'daysSince') {
          va = Store.daysSince(a.date);
          vb = Store.daysSince(b.date);
        }
        va = parseFloat(va);
        vb = parseFloat(vb);
        if (isNaN(va)) va = dir > 0 ? Infinity : -Infinity;
        if (isNaN(vb)) vb = dir > 0 ? Infinity : -Infinity;
        return (va - vb) * dir;
      });
      return list;
    });

    function sortBy(key) {
      if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey.value = key;
        sortDir.value = 'desc';
      }
    }
    function sortIcon(key) {
      if (sortKey.value !== key) return '⇅';
      return sortDir.value === 'asc' ? '↑' : '↓';
    }

    // 选择相关
    const allNewsSelected = computed(() =>
      filteredNews.value.length > 0 && selectedNewsIds.value.length === filteredNews.value.length
    );
    function toggleSelectAll(e) {
      if (e.target.checked) {
        selectedNewsIds.value = filteredNews.value.map(n => n.id);
      } else {
        selectedNewsIds.value = [];
      }
    }
    function invertSelection() {
      const all = new Set(filteredNews.value.map(n => n.id));
      const sel = new Set(selectedNewsIds.value);
      selectedNewsIds.value = [...all].filter(id => !sel.has(id));
    }
    function selectAllNews() {
      selectedNewsIds.value = filteredNews.value.map(n => n.id);
    }
    function clearSelection() {
      selectedNewsIds.value = [];
    }
    function deleteSelectedNews() {
      if (!selectedNewsIds.value.length) return;
      if (!confirm(`确认删除选中的 ${selectedNewsIds.value.length} 条新闻？`)) return;
      Store.deleteNewsBatch(selectedNewsIds.value);
      selectedNewsIds.value = [];
      showToast('已删除选中新闻', 'success');
    }

    // 新闻增删改
    const newsModal = reactive({
      show: false,
      isEdit: false,
      data: {},
      stockSearch: '',
      suggestions: [],
      _searchTimer: null
    });
    function openAddNews() {
      newsModal.isEdit = false;
      newsModal.data = {
        date: Store.today(),
        content: '',
        conceptCategory: '',
        industryCategory: '',
        customTag: '',
        relatedStocks: [],
        category: '',
        newsDayPrice: null,
        price924: null,
        todayPrice: null
      };
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
      newsModal.show = true;
    }
    function editNews(item) {
      newsModal.isEdit = true;
      newsModal.data = JSON.parse(JSON.stringify(item));
      // 确保 relatedStocks 是数组
      if (!Array.isArray(newsModal.data.relatedStocks)) {
        newsModal.data.relatedStocks = parseStocks(newsModal.data.relatedStocks);
      }
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
      newsModal.show = true;
    }

    // 股票联想搜索（防抖）
    function onStockSearchInput() {
      clearTimeout(newsModal._searchTimer);
      const kw = newsModal.stockSearch.trim();
      if (!kw) { newsModal.suggestions = []; return; }
      newsModal._searchTimer = setTimeout(async () => {
        const results = await StockAPI.searchStocks(kw);
        // 过滤已添加的
        const exist = new Set((newsModal.data.relatedStocks || []).map(s => s.code));
        newsModal.suggestions = results.filter(r => r.type === 'GP-A' || r.type === 'GP-S' || !r.type).filter(r => !exist.has(r.code)).slice(0, 8);
      }, 300);
    }
    function addStock(s) {
      if (!Array.isArray(newsModal.data.relatedStocks)) newsModal.data.relatedStocks = [];
      if (!newsModal.data.relatedStocks.find(x => x.code === s.code)) {
        newsModal.data.relatedStocks.push({ name: s.name, code: s.code });
      }
      newsModal.stockSearch = '';
      newsModal.suggestions = [];
    }
    function removeStock(idx) {
      if (Array.isArray(newsModal.data.relatedStocks)) {
        newsModal.data.relatedStocks.splice(idx, 1);
      }
    }
    function closeStockSuggestions() {
      setTimeout(() => { newsModal.suggestions = []; }, 200);
    }

    function saveNews() {
      if (!newsModal.data.content || !newsModal.data.content.trim()) {
        showToast('请输入新闻内容', 'error');
        return;
      }
      if (!newsModal.data.date) {
        showToast('请选择日期', 'error');
        return;
      }
      const d = newsModal.data;
      // 确保 relatedStocks 是数组
      if (!Array.isArray(d.relatedStocks)) d.relatedStocks = parseStocks(d.relatedStocks);
      // 计算距今
      d.daysSince = Store.daysSince(d.date);
      if (newsModal.isEdit) {
        const original = D.news.find(n => n.id === d.id);
        const oldStockStr = original ? stocksText(original.relatedStocks) : '';
        const newStockStr = stocksText(d.relatedStocks);
        // 若关联股票变化，清空旧股价，避免刷新时仍显示旧股票的价位
        if (original && oldStockStr !== newStockStr) {
          d.newsDayPrice = null;
          d.price924 = null;
          d.todayPrice = null;
          d.todayChange = null;
          d.changeSinceNews = null;
          d.changeSince924 = null;
        }
        Store.updateNews(d.id, d);
        showToast('已更新', 'success');
        // 关联股票变化后自动补全新股价
        if (oldStockStr !== newStockStr) {
          const updated = D.news.find(n => n.id === d.id);
          if (updated) fillPriceForNews(updated, true);
        }
      } else {
        delete d.id;
        const item = Store.addNews(d);
        // 异步补全股价
        fillPriceForNews(item, true);
        // 手动添加：若已配置 AI 且四字段为空，自动请 AI 填写「新闻解读参考/利好利空/散户参考/核心股票」
        if (aiConfigured.value && !d.conceptCategory && !d.industryCategory && !d.customTag) {
          autoInterpretAfterAdd(item);
          showToast('已添加，AI 正在生成解读…', 'success');
        } else {
          showToast('已添加', 'success');
        }
      }
      newsModal.show = false;
    }
    function deleteNews(id) {
      if (!confirm('确认删除该条新闻？')) return;
      Store.deleteNews(id);
      showToast('已删除', 'success');
    }

    // ---------- AI 新闻解读（OpenAI 兼容，浏览器端调用用户自己的 Key）----------
    const aiGenerating = ref(false);
    const aiConfigured = computed(() =>
      !!(D.settings.aiEndpoint && D.settings.aiEndpoint.trim()) &&
      !!(D.settings.aiKey && D.settings.aiKey.trim()) &&
      !!(D.settings.aiModel && D.settings.aiModel.trim())
    );

    /**
     * 网络层探针：`mode: 'no-cors'` 的请求不发 CORS 预检、也不校验响应头，
     * 因此「能拿到 opaque 响应」= 网络层通（问题只可能在 CORS 或业务层）；
     * 「超时 / 直接 reject」= 网络层根本不通（域名被拦截、DNS 失败、断网）。
     *
     * 这是浏览器里唯一能区分「被墙」与「真 CORS」的办法——
     * 两种情况下正式 fetch 都只抛一个笼统的 `TypeError: Failed to fetch`。
     * 实测见 `_repo_tmp/probe-nocors.mjs`：DeepSeek/硅基流动 → resolved(139~934ms)；
     * api.openai.com → 8s 超时；不存在的域名 → 281ms reject。
     */
    async function probeEndpointReachable(url, timeoutMs) {
      const ms = timeoutMs || 8000;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try {
          await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
          return { ok: true };
        } finally { clearTimeout(timer); }
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        const aborted = (e && e.name === 'AbortError') || /abort/i.test(msg);
        return { ok: false, timeout: aborted, error: msg };
      }
    }

    /** 把 HTTP 状态码翻译成一句人话提示 */
    function aiStatusHint(code) {
      if (code === 401 || code === 403) return '（密钥无效或无权限：核对 API Key，并确认账号已开通该模型）';
      if (code === 404) return '（地址写错：要填到 /v1/chat/completions 这一级，不要只填域名）';
      if (code === 408 || code === 504) return '（对方超时）';
      if (code === 429) return '（触发限流或余额不足）';
      if (code >= 500) return '（对方服务端异常，稍后重试）';
      return '';
    }

    /**
     * 正式请求抛 `Failed to fetch` 时再跑一次探针，给出**准确**的原因与对策。
     * 旧版本不管三七二十一都说「多为 CORS」并把用户推去部署 Worker，
     * 但实测国内五家（DeepSeek / 硅基流动 / 智谱 / 阿里百炼 / Kimi）浏览器直连全都通，
     * 真正失败的绝大多数是「填了境外地址、域名被墙」，此时部署代理也未必管用。
     */
    async function explainAiFetchFailure(endpoint) {
      const net = await probeEndpointReachable(endpoint, 8000);
      if (net.ok) {
        return '浏览器跨域（CORS）拦截：这个地址能连通，但不允许网页直接调用。'
          + '办法一：换国内可直连的接口（DeepSeek / 硅基流动 / 智谱 GLM / 阿里百炼 / Kimi 均可浏览器直连）；'
          + '办法二：部署 worker/ai-proxy.js 用代理转发（顺带把 Key 藏到服务端）。';
      }
      if (net.timeout) {
        return '连不上这个地址（8 秒内无任何响应），该域名在当前网络多半被拦截。'
          + '这不是 CORS 问题，部署代理也未必能解决——请改用国内可直连的接口'
          + '（DeepSeek / 硅基流动 / 智谱 GLM / 阿里百炼 / Kimi）。';
      }
      return '这个地址解析不到，或当前网络已断开（' + net.error + '）：请检查地址是否拼错、网络是否正常。';
    }

    /** 通用 OpenAI 兼容调用；返回 { ok, content } 或 { ok:false, error }
     *  opts: { timeoutMs, maxTokens, cfg:{endpoint,key,model} } —— cfg 用于「测试连接」时不落库地试算 */
    async function callOpenAICompat(messages, opts) {
      const o = opts || {};
      const c = o.cfg || {};
      const pick = (k, fallback) => (c[k] != null ? String(c[k]) : fallback);
      const endpoint = pick('endpoint', D.settings.aiEndpoint || '').trim();
      const key = pick('key', D.settings.aiKey || '').trim();
      const model = pick('model', D.settings.aiModel || '').trim();
      if (!endpoint || !key || !model) {
        return { ok: false, error: '未配置 AI 接口（设置 → AI 解读：需填写 API 地址、密钥、模型）' };
      }
      const timeoutMs = o.timeoutMs || 60000;
      const body = { model, messages, temperature: 0.6, stream: false };
      if (o.maxTokens) body.max_tokens = o.maxTokens;
      // 慢响应兜底：15 秒还没动静就先并行探一次网络层。
      // 若探针判定「根本连不上」，立刻中止请求 —— 被墙的地址不必让用户干等满 60 秒。
      let netVerdict = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const slowTimer = setTimeout(function () {
          probeEndpointReachable(endpoint, 6000).then(function (net) {
            if (net.ok) return;
            netVerdict = net.timeout
              ? '连不上这个地址（无任何响应），该域名在当前网络多半被拦截。'
                + '这不是 CORS 问题，部署代理也未必能解决——请改用国内可直连的接口'
                + '（DeepSeek / 硅基流动 / 智谱 GLM / 阿里百炼 / Kimi）。'
              : '这个地址解析不到，或当前网络已断开（' + net.error + '）：请检查地址是否拼错、网络是否正常。';
            try { ctrl.abort(); } catch (e) { /* ignore */ }
          }).catch(function () { /* 探针自身失败不影响主流程 */ });
        }, 15000);
        let r;
        try {
          r = await fetch(endpoint, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
            body: JSON.stringify(body)
          });
        } finally { clearTimeout(timer); clearTimeout(slowTimer); }
        if (!r.ok) {
          let detail = '';
          try { detail = (await r.text()).slice(0, 200); } catch (e) {}
          return {
            ok: false, status: r.status,
            error: 'AI 接口返回 ' + r.status + aiStatusHint(r.status) + (detail ? '：' + detail : '')
          };
        }
        const j = await r.json();
        const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!content) return { ok: false, error: 'AI 返回内容为空（模型名可能写错，或该 Key 无权访问此模型）' };
        return { ok: true, content: String(content) };
      } catch (e) {
        // 探针已经给出了明确结论时，直接用它的（比 catch 里那句笼统的 TypeError 有用得多）
        if (netVerdict) return { ok: false, error: netVerdict };
        let msg = (e && e.message) ? e.message : String(e);
        if (/abort|timeout/i.test(msg)) {
          msg = 'AI 请求超时（' + Math.round(timeoutMs / 1000) + 's 内无响应）：检查网络，或换国内可直连的接口';
        } else if (/Failed to fetch|CORS|NetworkError|跨域|Load failed/i.test(msg)) {
          msg = await explainAiFetchFailure(endpoint);
        }
        return { ok: false, error: msg };
      }
    }

    // 把 AI 返回文本解析成四段：新闻解读参考 / 利好利空 / 散户参考 / 核心股票
    function parseInterpretation(text) {
      const out = { ref: '', bull: '', retail: '', core: [] };
      const mRef = text.match(/【?\s*新闻解读参考\s*】?([\s\S]*?)(?=【?\s*利好利空\s*】?|$)/);
      const mBull = text.match(/【?\s*利好利空\s*】?([\s\S]*?)(?=【?\s*散户参考\s*】?|$)/);
      const mRetail = text.match(/【?\s*散户参考\s*】?([\s\S]*?)(?=【?\s*核心股票\s*】?|$)/);
      const mCore = text.match(/【?\s*核心股票\s*】?([\s\S]*?)$/);
      if (mRef) out.ref = mRef[1].trim();
      if (mBull) out.bull = mBull[1].trim();
      if (mRetail) out.retail = mRetail[1].trim();
      if (mCore) {
        out.core = mCore[1].split(/[\n，,，、；;]+/).map(s => s.replace(/[【】\s.。]/g, '').trim())
          .filter(s => s && !/^(无|none|na|无核心股票)$/i.test(s)).slice(0, 5);
      }
      if (!out.ref && !out.bull && !out.retail) out.ref = text.trim();
      return out;
    }

    /** 把 AI 提炼的核心股票名（简称）解析成 {name, code}，尽量用搜索接口补全代码 */
    async function resolveCoreStocks(names) {
      const list = [];
      if (!Array.isArray(names) || !names.length) return list;
      for (const nm of names) {
        let code = '';
        let name = nm;
        try {
          const r = await StockAPI.searchStocks(nm);
          if (r && r.length) { code = r[0].code || ''; name = r[0].name || nm; }
        } catch (e) { /* 解析失败就只存简称 */ }
        list.push({ name, code });
      }
      return list;
    }

    /** 核心 AI 解读：返回 { ref, bull, retail, core:[名称] }，供手动按钮与「手动添加后自动填充」复用 */
    async function callAIForNewsInterpretation(content, stocks) {
      if (!aiConfigured.value) return { ok: false, error: '未配置 AI 接口（偏好设置 → AI 解读：需填写 API 地址、密钥、模型）' };
      if (!content || !content.trim()) return { ok: false, error: '新闻内容为空' };
      const stockLine = stocks.length ? ('关联股票：' + stocks.join('、')) : '关联股票：无';
      const sys = '你是资深 A 股财经分析师，语言精炼、专业、客观，不夸大、不喊单。';
      const user = '请解读以下财经新闻，并严格按下面四段格式输出（保留【】标记，不要加额外前后缀、不要使用 Markdown 代码块）：\n\n新闻内容：' + content + '\n' + stockLine + '\n\n【新闻解读参考】\n（用 2-4 句话说明这条新闻意味着什么、对市场预期的影响；并简要说明利好什么、利空什么）\n\n【利好利空】\n利好概念：…（用顿号分隔的关键概念，可空）\n利好行业：…（用顿号分隔的行业，可空）\n利空概念：…（用顿号分隔的关键概念，可空）\n利空行业：…（用顿号分隔的行业，可空）\n\n【散户参考】\n（站在散户视角，给出 1-3 条可操作建议：关注时机、仓位、风险控制；结尾注明「仅供参考，不构成投资建议」）\n\n【核心股票】\n（提炼这条新闻最核心的 1-5 只 A 股上市公司，每行一只，只写股票简称，不要代码、不要解释；若确实没有相关上市公司，写「无」）';
      const res = await callOpenAICompat([
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ]);
      if (!res.ok) return res;
      return { ok: true, ...parseInterpretation(res.content) };
    }

    /** 把解读结果（含核心股票）写回某个新闻对象（弹窗或已存记录皆可） */
    async function applyInterpretation(target, res) {
      target.conceptCategory = res.ref;
      target.industryCategory = res.bull;
      target.customTag = res.retail;
      if (res.core && res.core.length) {
        const exist = new Set((parseStocks(target.relatedStocks) || []).map(s => s.name));
        const add = (await resolveCoreStocks(res.core)).filter(x => !exist.has(x.name));
        if (add.length) {
          target.relatedStocks = (target.relatedStocks || []).concat(add);
        }
      }
    }

    // 依据当前新闻内容+关联股票，调用 AI 生成四段解读并写回（弹窗里的「🤖 AI 生成解读」按钮）
    async function generateNewsInterpretation() {
      const d = newsModal.data;
      if (!d || !d.content || !d.content.trim()) {
        showToast('请先填写新闻内容再生成 AI 解读', 'error');
        return;
      }
      if (!aiConfigured.value) {
        showToast('请先在「偏好设置 → AI 解读」填写 API 地址、密钥、模型', 'error');
        return;
      }
      aiGenerating.value = true;
      try {
        const stocks = (parseStocks(d.relatedStocks) || []).map(s => s.name || pureCode(s.code)).filter(Boolean);
        const res = await callAIForNewsInterpretation(d.content, stocks);
        if (!res.ok) {
          showToast('AI 解读失败：' + res.error, 'error');
          return;
        }
        await applyInterpretation(d, res);
        showToast('AI 解读已生成（可手动微调后保存）', 'success');
      } finally {
        aiGenerating.value = false;
      }
    }

    /** 手动添加新闻后：若已配置 AI 且四字段为空，静默调用 AI 自动填写四字段 + 核心股票 */
    async function autoInterpretAfterAdd(item) {
      const stocks = (parseStocks(item.relatedStocks) || []).map(s => s.name || pureCode(s.code)).filter(Boolean);
      const res = await callAIForNewsInterpretation(item.content, stocks);
      if (!res.ok) return; // 静默失败：用户仍可手动点「🤖 AI 生成解读」
      const patch = { conceptCategory: res.ref, industryCategory: res.bull, customTag: res.retail };
      if (res.core && res.core.length) {
        const exist = new Set((parseStocks(item.relatedStocks) || []).map(s => s.name));
        const add = (await resolveCoreStocks(res.core)).filter(x => !exist.has(x.name));
        if (add.length) patch.relatedStocks = (item.relatedStocks || []).concat(add);
      }
      Store.updateNews(item.id, patch);
      if (patch.relatedStocks) {
        const updated = D.news.find(n => n.id === item.id);
        if (updated) fillPriceForNews(updated, true);
      }
    }

    // ============================================================
    // 页面：用户持仓（各登录用户只看自己的持仓，按用户名隔离）
    // ============================================================
    function blankHolding() {
      return {
        id: null, code: '', name: '', entryDate: Store.today(),
        entryPrice: null, currentPrice: null, shares: null,
        direction: 'long', fee: 0, note: ''
      };
    }
    const holdingModal = reactive({ show: false, isEdit: false, data: blankHolding(), stockSearch: '', suggestions: [] });
    const holdingRefreshing = ref(false);
    const membershipModal = reactive({ show: false });
    function openMembershipService() { membershipModal.show = true; }
    // 用户须知（入口在「会员服务」左侧）
    const userNoticeModal = reactive({ show: false });
    function openUserNotice() { userNoticeModal.show = true; }

    /* batch16：准入码展示面板。
     * 以前用 prompt() 弹长串码，很多浏览器（尤其移动端 / 微信内置）会拦或截断，
     * 管理员复制不到，用户就拿不到授权 —— 这是「已授权三天却登不进」的关键一环。
     * 现在统一用这个面板：完整展示 + 一键复制。 */
    const approveCodeModal = reactive({ show: false, title: '', desc: '', code: '' });
    function showApproveCodePanel(opts) {
      const o = opts || {};
      approveCodeModal.title = o.title || '准入码';
      approveCodeModal.desc = o.desc || '';
      approveCodeModal.code = String(o.code || '');
      approveCodeModal.show = true;
    }
    function copyApproveCode() {
      const code = approveCodeModal.code;
      if (!code) return;
      copyText(code, '准入码已复制，发给对方即可');
    }

    /* ============ 本地数据管理（入口在「用户须知」左侧） ============
     * 纯静态站没有服务端，所有业务数据都存在当前浏览器（localStorage）里。
     * 这里把「本机到底存了什么 / 占多大 / 能不能删」透明地摆出来，并逐项提供删除。
     * 删除只影响这台设备的界面：官方快照（GitHub Action 抓的）在服务器上，不受影响。
     * ============================================================== */
    const LD_KEY_USERS = 'snt-auth-users-v1';   // 账号表：同一浏览器上共用（否则没法登录）
    const LD_KEY_SESSION = 'snt-auth-session-v1';
    const LD_KEY_CLOUD = 'cloud-creds-v1';      // 升级前的共用旧键；现在按账号隔离，见 ldCloudKey()

    /** 本账号的云同步凭据键（按账号隔离，普通账号拿不到管理员的 Token） */
    function ldCloudKey() {
      return (typeof CloudSync !== 'undefined' && CloudSync.credsKey) ? CloudSync.credsKey() : LD_KEY_CLOUD;
    }

    const localDataModal = reactive({
      show: false,
      previewId: '', previewTitle: '', previewText: '',
      confirmId: '',          // 单行「确认删除」的行 id
      confirmClear: false     // 底部「确认清空业务数据」
    });
    const localDataRows = ref([]);
    const localDataUsageText = ref('0 B');
    const localDataKeyText = ref('');   // 当前账号的数据存在哪个键上

    function ldBytes(v) {
      const s = typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v);
      try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
    }
    function ldSizeText(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(2) + ' MB';
    }
    function ldCountText(n, unit) { return Number(n || 0) + ' ' + unit; }
    function ldSumLen(obj) {
      return Object.keys(obj || {}).reduce((s, k) => s + ((obj[k] && obj[k].length) || 0), 0);
    }
    function ldReadRaw(key) {
      try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    }
    function ldHasKey(key) {
      try { return !!localStorage.getItem(key); } catch (e) { return false; }
    }

    /** 本机存储的全部数据桶（每次打开弹窗重新计算，保证是最新值） */
    function ldBuckets() {
      const me = (authUser.value && authUser.value.username) || '';
      const isAdmin = can('users.manage');
      return [
        { id: 'news', name: '新闻数据', icon: '📰', unit: '条',
          count: v => (v || []).length,
          desc: '新闻追踪页的全部新闻（来源、分类、关联股票、AI 解读三字段）',
          raw: () => D.news || [], clear: () => { D.news = []; } },
        { id: 'stockPools', name: '股票池', icon: '💹', unit: '组',
          count: v => (v || []).length,
          desc: '按日期分组的自选股票池',
          raw: () => D.stockPools || [], clear: () => { D.stockPools = []; } },
        { id: 'sectorPools', name: '选股板块', icon: '🧩', unit: '个',
          count: v => (v || []).length,
          desc: '自建的概念/行业板块（含成分股与主营业务）',
          raw: () => D.sectorPools || [], clear: () => { D.sectorPools = []; } },
        { id: 'favorites', name: '收藏股票', icon: '⭐', unit: '只',
          count: v => (v || []).length,
          desc: '收藏夹里的股票',
          raw: () => D.favorites || [], clear: () => { D.favorites = []; } },
        { id: 'holdings', name: '我的持仓', icon: '💼', unit: '只',
          count: v => (v || []).length,
          desc: '当前账号（' + (me || '未登录') + '）的持仓记录，其他账号不受影响',
          raw: () => (D.holdings && D.holdings[me]) || [],
          clear: () => { if (D.holdings && me) delete D.holdings[me]; } },
        { id: 'dailyData', name: '每日行情数据', icon: '📈', unit: '天',
          count: v => Object.keys(v || {}).length,
          desc: '按日期缓存的股票行情（刷新现价时产生，删掉后下次刷新会重新取）',
          raw: () => D.dailyData || {}, clear: () => { D.dailyData = {}; } },
        { id: 'hotTopicSnapshots', name: '热点快照（本机缓存）', icon: '🌐', unit: '天',
          count: v => Object.keys(v || {}).length,
          desc: '「全球信息」页缓存在本机的热点榜单快照',
          raw: () => D.hotTopicSnapshots || {}, clear: () => { D.hotTopicSnapshots = {}; } },
        { id: 'hotCache', name: '热门榜缓存', icon: '🔥', unit: '条',
          count: v => [v.hotBoards, v.hotStocks, v.preMarketBoards, v.amplitudeBoards, v.newListedStocks]
            .reduce((s, a) => s + ((a && a.length) || 0), 0),
          desc: '最近一次的热门板块 / 热门股票 / 盘前热点 / 振幅板块 / 新上市股票',
          raw: () => ({
            hotBoards: D.hotBoards, hotStocks: D.hotStocks,
            preMarketBoards: D.preMarketBoards, amplitudeBoards: D.amplitudeBoards,
            newListedStocks: D.newListedStocks
          }),
          clear: () => { D.hotBoards = []; D.hotStocks = []; D.preMarketBoards = []; D.amplitudeBoards = []; D.newListedStocks = []; } },
        { id: 'layout', name: '表格列宽', icon: '📐', unit: '列',
          count: v => Object.keys(v.holdingColWidths || {}).length + Object.keys(v.filterColWidths || {}).length
            + Object.keys(v.sectorColWidths || {}).length,
          desc: '你拖动过的列宽记忆（持仓 / 筛选 / 板块详情）',
          raw: () => ({
            holdingColWidths: D.holdingColWidths,
            filterColWidths: D.filterColWidths,
            sectorColWidths: D.sectorColWidths
          }),
          clear: () => { D.holdingColWidths = {}; D.filterColWidths = {}; D.sectorColWidths = {}; } },
        { id: 'financePush', name: '财经推送网址', icon: '📺', unit: '项',
          count: v => ((v && v.url) ? 1 : 0),
          desc: '「财经推送」里嵌入的网址与锁定状态',
          raw: () => D.financePush || {},
          clear: () => { D.financePush = { url: '', locked: false }; } },
        { id: 'settings', name: '系统设置', icon: '⚙️', unit: '项',
          count: v => Object.keys(v || {}).length,
          desc: '新闻代理地址、AI 解读接口与密钥、主题分类等（删除后恢复出厂默认）',
          danger: true, raw: () => D.settings || {},
          clear: () => { D.settings = Store._default().settings; } },
        { id: 'authUsers', name: '本机账号表', icon: '👥', unit: '个',
          count: v => (v || []).length,
          desc: '存放在这台设备上的账号（密码只存哈希，不存明文）',
          adminOnly: true, locked: true, danger: true,
          raw: () => ldReadRaw(LD_KEY_USERS) || [], clear: () => { } },
        { id: 'session', name: '登录会话', icon: '🔑', unit: '项',
          count: () => (ldHasKey(LD_KEY_SESSION) ? 1 : 0),
          desc: '当前设备的登录状态；删除后本页立即退出登录，需重新输入密码',
          raw: () => ldReadRaw(LD_KEY_SESSION) || {},
          danger: true,
          clear: () => { try { localStorage.removeItem(LD_KEY_SESSION); } catch (e) { /* ignore */ } } },
        { id: 'cloudCreds', name: '云同步凭据', icon: '☁️', unit: '项',
          count: () => (ldHasKey(ldCloudKey()) ? 1 : 0),
          desc: '本账号（' + (me || '未登录') + '）的 GitHub Gist 同步 Token；删除后需重新填写才能同步',
          raw: () => ldReadRaw(ldCloudKey()) || {},
          danger: true,
          clear: () => { try { localStorage.removeItem(ldCloudKey()); } catch (e) { /* ignore */ } } },
        { id: 'legacyStore', name: '升级前的旧共享数据', icon: '🗃️', unit: '项',
          count: () => (Store.legacyInfo().exists ? 1 : 0),
          desc: '旧版本所有账号共用一份数据时留下的那份记录（已迁移到管理员账号）。确认数据没问题后可删除，普通账号读不到它',
          adminOnly: true, danger: true,
          showIf: () => Store.legacyInfo().exists,
          raw: () => ldReadRaw(Store.legacyInfo().key) || {},
          clear: () => { Store.clearLegacy(); } }
      ].filter(b => (!b.adminOnly || isAdmin) && (!b.showIf || b.showIf()));
    }

    /** localStorage 实际占用（含所有键名与键值，比上面各项相加更准确） */
    function ldStorageUsage() {
      let total = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          total += ldBytes(k) + ldBytes(localStorage.getItem(k) || '');
        }
      } catch (e) { /* ignore */ }
      return total;
    }

    function refreshLocalDataRows() {
      const rows = ldBuckets().map(b => {
        const raw = b.raw();
        const size = ldBytes(raw);
        return {
          id: b.id, name: b.name, icon: b.icon, desc: b.desc,
          countText: ldCountText(b.count ? b.count(raw) : 1, b.unit),
          sizeText: ldSizeText(size),
          size: size,
          isEmpty: size <= 8,        // [] / {} 序列化后只有 2 字节
          danger: !!b.danger,
          locked: !!b.locked
        };
      });
      localDataRows.value = rows;
      localDataUsageText.value = ldSizeText(ldStorageUsage());
      // 让管理员一眼确认「这份数据挂在哪个键上」——账号隔离是否生效看这里
      const who = (authUser.value && authUser.value.username) || '';
      localDataKeyText.value = Store.STORAGE_KEY + '（当前账号：' + (who || '未登录') + '）';
      return rows;
    }

    function openLocalData() {
      // 双保险：入口按钮已按权限隐藏，这里再挡一次（旧缓存 / 控制台调用都拦得住）
      if (!can('data.clear')) { showToast('本机数据管理仅管理员可用', 'error'); return; }
      localDataModal.previewId = '';
      localDataModal.previewTitle = '';
      localDataModal.previewText = '';
      localDataModal.confirmId = '';
      localDataModal.confirmClear = false;
      refreshLocalDataRows();
      localDataModal.show = true;
    }

    /** 查看原始 JSON（截断到 4000 字符，设置里的 AI Key 做打码） */
    function previewLocalData(row) {
      const b = ldBuckets().find(x => x.id === row.id);
      if (!b) return;
      let text;
      try { text = JSON.stringify(b.raw(), null, 2); } catch (e) { text = String(b.raw()); }
      if (!text) text = '（空）';
      // 任何形如 token / password / hash / key / secret 的字段一律打码，避免在界面上二次泄露
      text = text.replace(
        /"([A-Za-z0-9_]*(?:[Tt]oken|[Pp]assword|[Hh]ash|[Kk]ey|[Ss]ecret)[A-Za-z0-9_]*)"\s*:\s*"[^"]*"/g,
        '"$1": "*** 已隐藏 ***"'
      );
      const LIMIT = 4000;
      if (text.length > LIMIT) text = text.slice(0, LIMIT) + '\n\n…（内容较长，仅显示前 4000 个字符）';
      localDataModal.previewId = row.id;
      localDataModal.previewTitle = row.icon + ' ' + row.name;
      localDataModal.previewText = text;
    }
    function closeLocalDataPreview() {
      localDataModal.previewId = '';
      localDataModal.previewTitle = '';
      localDataModal.previewText = '';
    }

    function askDeleteLocalData(row) {
      localDataModal.confirmId = row.id;
      localDataModal.confirmClear = false;
    }
    function cancelDeleteLocalData() { localDataModal.confirmId = ''; }

    function doDeleteLocalData(row) {
      const b = ldBuckets().find(x => x.id === row.id);
      localDataModal.confirmId = '';
      if (!b || b.locked) return;
      b.clear();
      if (localDataModal.previewId === b.id) closeLocalDataPreview();
      if (b.id === 'session') {           // 删掉会话 = 退出登录（由登录关卡接管）
        try { Store.saveNow(); } catch (e) { /* ignore */ }
        showToast('已删除登录会话，正在退出登录…', 'info');
        doLogout();
        return;
      }
      try { Store.saveNow(); } catch (e) { /* ignore */ }
      refreshLocalDataRows();
      showToast('已删除「' + b.name + '」', 'success');
    }

    function askClearLocalBusinessData() {
      localDataModal.confirmClear = true;
      localDataModal.confirmId = '';
    }
    /** 一键清空业务数据：不动持仓、设置、账号与登录态 */
    function doClearLocalBusinessData() {
      localDataModal.confirmClear = false;
      D.news = [];
      D.stockPools = [];
      D.sectorPools = [];
      D.favorites = [];
      D.dailyData = {};
      D.hotTopicSnapshots = {};
      D.hotBoards = [];
      D.hotStocks = [];
      D.preMarketBoards = [];
      D.amplitudeBoards = [];
      closeLocalDataPreview();
      try { Store.saveNow(); } catch (e) { /* ignore */ }
      refreshLocalDataRows();
      showToast('已清空业务数据（持仓、设置与账号已保留）', 'success');
    }

    const myHoldings = computed(() => {
      const u = authUser.value && authUser.value.username;
      return u ? Store.getUserHoldings(u) : [];
    });

    function holdingDays(h) { return h.entryDate ? Store.daysSince(h.entryDate) : 0; }
    function holdingCost(h) {                 // 成本金额 = 建仓价 × 数量
      const ep = parseFloat(h.entryPrice), sh = parseFloat(h.shares);
      if (isNaN(ep) || isNaN(sh)) return null;
      return ep * sh;
    }
    function holdingMarketValue(h) {          // 市值 = 现价 × 数量
      const cp = parseFloat(h.currentPrice), sh = parseFloat(h.shares);
      if (isNaN(cp) || isNaN(sh)) return null;
      return cp * sh;
    }
    function holdingChangePct(h) {            // 持仓涨跌幅（相对建仓价）
      const ep = parseFloat(h.entryPrice), cp = parseFloat(h.currentPrice);
      if (isNaN(ep) || ep === 0 || isNaN(cp)) return null;
      return (cp - ep) / ep * 100;
    }
    function holdingProfit(h) {               // 盈亏金额（扣手续费）
      const ep = parseFloat(h.entryPrice), cp = parseFloat(h.currentPrice), sh = parseFloat(h.shares);
      const fee = parseFloat(h.fee) || 0;
      if (isNaN(ep) || isNaN(cp) || isNaN(sh)) return null;
      const raw = (cp - ep) * sh;
      return (h.direction === 'short' ? -raw : raw) - fee;
    }
    function holdingProfitPct(h) {            // 盈亏比例 = 盈亏 / 成本
      const cost = holdingCost(h), profit = holdingProfit(h);
      if (cost == null || profit == null || cost === 0) return null;
      return profit / cost * 100;
    }

    const holdingSummary = computed(() => {
      let totalCost = 0, totalMarket = 0, totalProfit = 0, count = 0;
      for (const h of myHoldings.value) {
        const c = holdingCost(h), m = holdingMarketValue(h), p = holdingProfit(h);
        if (c != null) totalCost += c;
        if (m != null) totalMarket += m;
        if (p != null) totalProfit += p;
        count++;
      }
      return { totalCost, totalMarket, totalProfit, pct: totalCost > 0 ? totalProfit / totalCost * 100 : null, count };
    });

    const holdingSortKey = ref('entryDate');
    const holdingSortDir = ref('desc');
    const sortedHoldings = computed(() => {
      const list = [...myHoldings.value];
      const k = holdingSortKey.value, dir = holdingSortDir.value === 'asc' ? 1 : -1;
      list.sort((a, b) => {
        let va, vb;
        if (k === 'days') { va = holdingDays(a); vb = holdingDays(b); }
        else if (k === 'changePct') { va = holdingChangePct(a); vb = holdingChangePct(b); }
        else if (k === 'profit') { va = holdingProfit(a); vb = holdingProfit(b); }
        else if (k === 'marketValue') { va = holdingMarketValue(a); vb = holdingMarketValue(b); }
        else { va = a[k]; vb = b[k]; }
        va = parseFloat(va); vb = parseFloat(vb);
        if (isNaN(va)) va = dir > 0 ? Infinity : -Infinity;
        if (isNaN(vb)) vb = dir > 0 ? Infinity : -Infinity;
        return (va - vb) * dir;
      });
      return list;
    });
    function sortHoldingBy(key) {
      if (holdingSortKey.value === key) holdingSortDir.value = holdingSortDir.value === 'asc' ? 'desc' : 'asc';
      else { holdingSortKey.value = key; holdingSortDir.value = 'desc'; }
    }
    function holdingSortIcon(key) {
      if (holdingSortKey.value !== key) return '⇅';
      return holdingSortDir.value === 'asc' ? '↑' : '↓';
    }

    function onHoldingStockSearch() {
      clearTimeout(holdingModal._t);
      const kw = (holdingModal.stockSearch || '').trim();
      if (!kw) { holdingModal.suggestions = []; return; }
      holdingModal._t = setTimeout(async () => {
        const r = await StockAPI.searchStocks(kw);
        holdingModal.suggestions = (r || []).slice(0, 8);
      }, 300);
    }
    function pickHoldingStock(s) {
      holdingModal.data.code = StockAPI.inferPrefix(s.pureCode || s.code || '');
      holdingModal.data.name = s.name || '';
      holdingModal.stockSearch = s.name ? (s.name + (s.pureCode ? '(' + s.pureCode + ')' : '')) : holdingModal.data.code;
      holdingModal.suggestions = [];
    }
    function openAddHolding() {
      holdingModal.isEdit = false;
      holdingModal.data = blankHolding();
      holdingModal.stockSearch = '';
      holdingModal.suggestions = [];
      holdingModal.show = true;
    }
    function editHolding(h) {
      holdingModal.isEdit = true;
      holdingModal.data = JSON.parse(JSON.stringify(h));
      holdingModal.stockSearch = h.name ? (h.name + (h.code ? '(' + pureCode(h.code) + ')' : '')) : (h.code || '');
      holdingModal.suggestions = [];
      holdingModal.show = true;
    }
    function saveHolding() {
      const d = holdingModal.data;
      if (!d.code) { showToast('请选择股票', 'error'); return; }
      if (!d.entryDate) { showToast('请填写建仓日期', 'error'); return; }
      const ep = parseFloat(d.entryPrice), sh = parseFloat(d.shares), cp = parseFloat(d.currentPrice);
      if (isNaN(ep) || ep <= 0) { showToast('建仓价必须大于 0', 'error'); return; }
      if (isNaN(sh) || sh <= 0) { showToast('持仓数量必须大于 0', 'error'); return; }
      if (d.currentPrice === '' || d.currentPrice == null || isNaN(cp)) d.currentPrice = ep;
      const u = authUser.value && authUser.value.username;
      if (!u) { showToast('未获取到当前用户', 'error'); return; }
      const rec = {
        code: d.code, name: d.name || '', entryDate: d.entryDate,
        entryPrice: ep, currentPrice: parseFloat(d.currentPrice), shares: sh,
        direction: d.direction || 'long', fee: parseFloat(d.fee) || 0, note: (d.note || '').trim()
      };
      if (holdingModal.isEdit) { Store.updateHolding(u, d.id, rec); showToast('已更新持仓', 'success'); }
      else { Store.addHolding(u, rec); showToast('已添加持仓', 'success'); }
      holdingModal.show = false;
    }
    function deleteHoldingRow(h) {
      const u = authUser.value && authUser.value.username;
      if (!u) return;
      if (!confirm('确认删除该持仓？')) return;
      Store.deleteHolding(u, h.id);
      showToast('已删除', 'success');
    }
    /** 按建仓日取历史收盘价作为建仓价（不复权真实价） */
    async function fetchEntryPrice() {
      const d = holdingModal.data;
      if (!d.code || !d.entryDate) { showToast('请先选择股票并填写建仓日期', 'error'); return; }
      try {
        const px = await StockAPI.getHistoryClose(StockAPI.inferPrefix(d.code), d.entryDate);
        if (px == null) { showToast('该日无行情（可能停牌或未上市）', 'error'); return; }
        d.entryPrice = +px.toFixed(2);
        if (d.currentPrice == null || d.currentPrice === '') d.currentPrice = +px.toFixed(2);
        showToast('已按建仓日填入收盘价', 'success');
      } catch (e) { showToast('取价失败：' + e.message, 'error'); }
    }
    /** 刷新全部持仓现价（用户手动触发；暂停时不发请求） */
    async function refreshHoldingPrices() {
      const list = myHoldings.value;
      if (!list.length) return;
      if (autoRefreshPaused()) { pauseHint('持仓现价刷新'); return; }
      holdingRefreshing.value = true;
      try {
        const codes = [...new Set(list.map(h => StockAPI.inferPrefix(h.code)).filter(Boolean))];
        const quotes = await StockAPI.getQuotes(codes);
        const map = {};
        for (const c of codes) {
          const q = quotes[c];
          if (q && q.price != null && !isNaN(q.price)) map[c] = q.price;
        }
        const u = authUser.value && authUser.value.username;
        Store.setHoldingPrices(u, map);
        const hit = Object.keys(map).length;
        showToast(hit ? `已刷新 ${hit}/${codes.length} 只现价` : '未能获取现价（接口限流或代码无效）', hit ? 'success' : 'error');
      } catch (e) {
        showToast('刷新现价失败：' + e.message, 'error');
      } finally {
        holdingRefreshing.value = false;
      }
    }

    // 为单条新闻补全股价
    async function fillPriceForNews(item, silent) {
      const stocks = parseStocks(item.relatedStocks);
      if (!stocks.length) {
        if (!silent) showToast('该新闻未关联股票', 'error');
        return;
      }
      const primary = stocks[0];
      if (!primary.code) {
        if (!silent) showToast('关联股票代码无效', 'error');
        return;
      }
      if (!silent) showToast('正在获取股价...', 'info');
      try {
        const tasks = [
          StockAPI.getQuote(primary.code),
          StockAPI.get924Price(primary.code),
          StockAPI.getHistoryClose(primary.code, item.date)
        ];
        const [quote, p924, newsDay] = await Promise.all(tasks);
        if (quote) {
          item.todayPrice = quote.price;
          item.todayChange = quote.changePercent;
        }
        if (p924 != null) item.price924 = p924;
        if (newsDay != null) item.newsDayPrice = newsDay;
        item.daysSince = Store.daysSince(item.date);
        // 计算涨幅
        if (item.newsDayPrice && item.todayPrice) {
          item.changeSinceNews = +(((item.todayPrice - item.newsDayPrice) / item.newsDayPrice) * 100).toFixed(2);
        }
        if (item.price924 && item.todayPrice) {
          item.changeSince924 = +(((item.todayPrice - item.price924) / item.price924) * 100).toFixed(2);
        }
        if (!silent) showToast('股价已更新', 'success');
      } catch (e) {
        if (!silent) showToast('股价获取失败', 'error');
      }
    }

    // 批量刷新所有新闻股价
    async function refreshAllPrices() {
      const list = filteredNews.value.filter(n => parseStocks(n.relatedStocks).length);
      if (!list.length) {
        showToast('没有可刷新股价的新闻', 'error');
        return;
      }
      priceLoading.value = true;
      showToast(`正在刷新 ${list.length} 条新闻的股价...`, 'info');
      // 按股票代码分组，避免同一只股票重复请求历史数据
      const stockGroups = {};
      for (const n of list) {
        const s = parseStocks(n.relatedStocks)[0];
        if (!s.code) continue;
        if (!stockGroups[s.code]) stockGroups[s.code] = [];
        stockGroups[s.code].push(n);
      }
      const codes = Object.keys(stockGroups);
      try {
        // 实时行情批量获取
        const quotes = await StockAPI.getQuotes(codes);
        let stockCount = 0;
        for (const [code, newsItems] of Object.entries(stockGroups)) {
          stockCount++;
          showToast(`正在获取 ${code} 的历史价格... (${stockCount}/${codes.length})`, 'info');
          // 924 股价：每只代码只请求一次
          const p924 = await StockAPI.get924Price(code);
          // 新闻日股价：按日期去重，每个日期只请求一次
          const dates = [...new Set(newsItems.map(n => n.date).filter(Boolean))];
          const newsDayPrices = {};
          for (const date of dates) {
            newsDayPrices[date] = await StockAPI.getHistoryClose(code, date);
          }
          const q = quotes[code];
          for (const n of newsItems) {
            if (q) {
              n.todayPrice = q.price;
              n.todayChange = q.changePercent;
            }
            if (p924 != null) n.price924 = p924;
            const nd = newsDayPrices[n.date];
            if (nd != null) n.newsDayPrice = nd;
            n.daysSince = Store.daysSince(n.date);
            if (n.newsDayPrice && n.todayPrice) {
              n.changeSinceNews = +(((n.todayPrice - n.newsDayPrice) / n.newsDayPrice) * 100).toFixed(2);
            }
            if (n.price924 && n.todayPrice) {
              n.changeSince924 = +(((n.todayPrice - n.price924) / n.price924) * 100).toFixed(2);
            }
          }
        }
        showToast(`已刷新 ${list.length} 条新闻股价`, 'success');
      } catch (e) {
        showToast('刷新失败：' + e.message, 'error');
      } finally {
        priceLoading.value = false;
      }
    }

    // ===== 导入新闻 =====
    const importModal = reactive({
      show: false,
      tab: 'paste',
      date: Store.today(),
      text: ''
    });
    function openImportDialog() {
      importModal.date = Store.today();
      importModal.text = '';
      importModal.tab = 'paste';
      importModal.show = true;
    }
    const previewImportCount = computed(() => {
      if (importModal.tab !== 'paste') return 0;
      return importModal.text.split(/\n+/).map(s => s.trim()).filter(Boolean).length;
    });
    function doPasteImport() {
      const lines = importModal.text.split(/\n+/).map(s => s.trim()).filter(Boolean);
      if (!lines.length) {
        showToast('没有可导入的内容', 'error');
        return;
      }
      let added = 0;
      for (const line of lines) {
        Store.addNews({
          date: importModal.date || Store.today(),
          content: line,
          conceptCategory: '',
          industryCategory: '',
          customTag: '',
          relatedStocks: [],
          category: '',
          newsDayPrice: null,
          price924: null,
          todayPrice: null,
          daysSince: Store.daysSince(importModal.date)
        });
        added++;
      }
      showToast(`已导入 ${added} 条新闻`, 'success');
      importModal.show = false;
      // 尝试批量补价（自动补价同样受顶部「暂停」开关控制）
      nextTick(() => {
        const fresh = D.news.slice(0, added);
        if (autoRefreshPaused()) pauseHint('导入后的自动补价');
        else setTimeout(() => refreshAllPrices(), 300);
      });
    }

    // 一键抓取财经快讯（通过 Cloudflare Worker 代理，免费）
    async function doScrapeImport() {
      const date = importModal.date;
      const base = (D.settings.proxyUrl || '').trim().replace(/\/+$/, '');
      if (!base) {
        showToast('请先在「设置」里填写新闻代理地址（免费Cloudflare Worker）', 'error');
        return;
      }
      showToast('正在通过代理抓取财经快讯...', 'info');
      try {
        // 抓取多页以确保覆盖所选日期
        const allItems = [];
        for (let page = 1; page <= 3; page++) {
          const resp = await fetch(`${base}/news?page=${page}&size=50`);
          if (!resp.ok) throw new Error('代理返回错误 ' + resp.status);
          const json = await resp.json();
          const list = (json.data && json.data.list) || [];
          if (!list.length) break;
          allItems.push(...list);
          // 如果最早一条已经早于所选日期，停止翻页
          const oldest = list[list.length - 1];
          if (oldest && oldest.showTime && oldest.showTime.slice(0, 10) < date) break;
        }
        // 按日期过滤
        const dateStr = date || Store.today();
        const filtered = allItems.filter(it => {
          const t = it.showTime || '';
          return t.slice(0, 10) === dateStr;
        });
        const news = (filtered.length ? filtered : allItems.slice(0, 50)).map(it => {
          const title = (it.title || '').trim();
          const summary = (it.summary || '').trim();
          const content = title && summary ? `${title}：${summary}` : (title || summary);
          return makeNewsItem(dateStr, content);
        }).filter(n => n.content);
        if (!news.length) {
          showToast('所选日期暂无快讯，可尝试换一天或用「粘贴导入」', 'error');
          return;
        }
        for (const n of news) Store.addNews(n);
        showToast(`抓取并导入 ${news.length} 条财经快讯`, 'success');
        importModal.show = false;
        if (autoRefreshPaused()) pauseHint('导入后的自动补价');
        else setTimeout(() => refreshAllPrices(), 300);
      } catch (e) {
        showToast('抓取失败：' + e.message + '。请检查代理地址是否正确', 'error');
      }
    }

    function parseScrapedNews(text, source, date) {
      const result = [];
      try {
        const json = JSON.parse(text);
        const list = json.result || json.data || json.list || (json.data && json.data.list) || [];
        for (const item of (Array.isArray(list) ? list : [])) {
          const content = item.title || item.content || item.summary || '';
          if (content) result.push(makeNewsItem(date, content));
        }
      } catch (e) {
        text.split(/\n+/).forEach(line => {
          line = line.trim();
          if (line.length > 5 && line.length < 200) result.push(makeNewsItem(date, line));
        });
      }
      return result;
    }
    function makeNewsItem(date, content) {
      return {
        date: date || Store.today(),
        content,
        conceptCategory: '', industryCategory: '', customTag: '',
        relatedStocks: [], category: '',
        newsDayPrice: null, price924: null, todayPrice: null,
        daysSince: Store.daysSince(date)
      };
    }

    // ============================================================
    //  页面2：股票池
    // ============================================================
    const poolLoading = ref(false);
    const poolModal = reactive({ show: false, isEdit: false, saving: false, data: {} });
    const poolDetail = reactive({ show: false, data: { stocks: [] }, nameEdit: false, nameDraft: '', addText: '', adding: false, noteQuery: '' });
    const poolDetailSort = reactive({ key: 'dailyChange', dir: 'desc' });

    const sortedPools = computed(() => {
      const list = [...D.stockPools];
      list.sort((a, b) => {
        const va = parseFloat(a.avgChange) || -Infinity;
        const vb = parseFloat(b.avgChange) || -Infinity;
        return vb - va; // 降序
      });
      // batch41：一键置顶的股票池恒排在最前，组内仍按平均涨跌幅降序（取消置顶即回到原位置）
      return list.filter(p => p.pinned).concat(list.filter(p => !p.pinned));
    });

    /**
     * 【batch41】一键置顶 / 取消置顶：股票池卡片与「我的概念选股板块」卡片共用（两者数据结构一致）。
     * 只写一个 pinned 标记，不改动任何股票数据；置顶只影响展示顺序，再次点击即可取消。
     */
    function togglePoolPin(pool) {
      if (!pool || !pool.id) return;
      pool.pinned = !pool.pinned;
      const nm = pool.name || '未命名板块';
      showToast(pool.pinned ? `已置顶「${nm}」` : `已取消置顶「${nm}」`, 'success');
    }

    function openAddPool() {
      poolModal.isEdit = false;
      poolModal.data = { date: Store.today(), name: '', stockText: '' };
      poolModal.show = true;
    }
    function openEditPool(pool) {
      poolModal.isEdit = true;
      poolModal.saving = false;
      poolModal.data = {
        id: pool.id,
        date: pool.date,
        name: pool.name || '',
        stockText: pool.stocks.map(s => s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)).join('\n')
      };
      poolModal.show = true;
    }
    /** 创建一个标准的股票池股票对象（初始化所有字段为 null） */
    function _newStock(s) {
      return {
        code: s.code,
        name: s.name || '',
        industry: s.industry || null,   // 所属一级行业
        dailyChange: null,
        amplitude: null,
        capitalFlow: null,
        shareholderCount: null,
        prevShareholderCount: null,
        profitYoY: null,
        revenueYoY: null,
        hbGrowth: null,
        kcfYoY: null,        // 扣非净利润同比增长率(%)
        revHb: null,         // 营收环比增长率(%)
        kcfHb: null,         // 扣非净利润环比增长率(%)
        q24Rev: null,        // 24营比：最新营收 vs 2024同期 增长率(%)
        q24Kcf: null,        // 24扣比：最新扣非 vs 2024同期 增长率(%)
        netProfit: null,       // 净利润(元)
        kcfjcxjlr: null,       // 扣非净利润(元)
        revenue: null,         // 营业收入(元)
        totalMarketCap: null,  // 总市值(亿)
        contractLiab: null,    // 最新合同负债(元)
        todayPrice: null,      // 当日收盘价
        yearStartPrice: null,  // 年初第1个交易日收盘价
        price924: null,        // 2024-09-24 收盘价
        yearChange: null,      // 年初涨跌幅(%)
        change924: null,       // 924涨跌幅(%)
        weekAgoClose: null,    // 一周前(5个交易日前)收盘价
        monthAgoClose: null,   // 一月前(20个交易日前)收盘价
        weekChange: null,      // 一周涨跌：现价 vs 一周前收盘价(%)
        monthChange: null,     // 一月涨跌：现价 vs 一月前收盘价(%)
        turnover: null
      };
    }

    /** 把「只有名称」的条目先弹出生成算一部分：先给提示，再走三级降级补代码 */
    async function savePool() {
      if (poolModal.saving) return;
      const parsed = StockAPI.parseStockInput(poolModal.data.stockText);
      if (!parsed.length) {
        showToast('请输入至少一只股票', 'error');
        return;
      }

      // 只写了名称（没带代码）的先反查成代码，否则后面行情/财务一律拉不到
      const needName = parsed.filter(s => s.name && !s.code);
      if (needName.length) {
        poolModal.saving = true;
        showToast(`正在识别 ${needName.length} 个股票名称...`, 'info');
        try {
          const failed = await StockAPI.resolveStockNames(parsed);
          if (failed.length) {
            const shown = failed.map(s => s.name).filter(Boolean).slice(0, 5).join('、');
            const more = failed.length > 5 ? ` 等 ${failed.length} 个` : '';
            if (failed.length >= parsed.length) {
              showToast(`未能找到「${shown}」${more}对应的股票，请检查名称或改用 6 位代码`, 'error');
              return;
            }
            showToast(`以下名称未识别已跳过：${shown}${more}，其余股票已保存`, 'error');
          }
        } finally {
          poolModal.saving = false;
        }
      }

      const stocks = parsed.filter(s => s.code);
      if (!stocks.length) {
        showToast('未识别到有效股票，请输入 6 位代码或正确的股票名称', 'error');
        return;
      }
      const stockList = stocks.map(s => _newStock(s));
      if (poolModal.isEdit) {
        const existing = D.stockPools.find(p => p.id === poolModal.data.id);
        // 保留已有的手动数据
        if (existing) {
          const map = {};
          existing.stocks.forEach(s => { map[s.code] = s; });
          stockList.forEach(s => {
            if (map[s.code]) {
              const o = map[s.code];
              s.capitalFlow = o.capitalFlow;
              s.shareholderCount = o.shareholderCount;
              s.prevShareholderCount = o.prevShareholderCount;
              s.profitYoY = o.profitYoY;
              s.revenueYoY = o.revenueYoY;
              s.hbGrowth = o.hbGrowth;
              s.kcfYoY = o.kcfYoY;
              s.revHb = o.revHb;
              s.kcfHb = o.kcfHb;
              s.q24Rev = o.q24Rev;
              s.q24Kcf = o.q24Kcf;
              s.netProfit = o.netProfit;
              s.kcfjcxjlr = o.kcfjcxjlr;
              s.revenue = o.revenue;
              s.totalMarketCap = o.totalMarketCap;
              s.contractLiab = o.contractLiab;
              s.industry = o.industry;
              s.todayPrice = o.todayPrice;
              s.yearStartPrice = o.yearStartPrice;
              s.price924 = o.price924;
              s.yearChange = o.yearChange;
              s.change924 = o.change924;
              s.weekAgoClose = o.weekAgoClose;
              s.monthAgoClose = o.monthAgoClose;
              s.weekChange = o.weekChange;
              s.monthChange = o.monthChange;
            }
          });
        }
        Store.updatePool(poolModal.data.id, { name: (poolModal.data.name || '').trim(), date: poolModal.data.date, stocks: stockList, avgChange: null });
        showToast('股票池已更新', 'success');
      } else {
        Store.addPool({ name: (poolModal.data.name || '').trim(), date: poolModal.data.date, stocks: stockList, avgChange: null });
        showToast('股票池已创建', 'success');
      }
      poolModal.show = false;
      // 自动刷新
      nextTick(() => refreshPoolPrices());
    }
    function deletePool(id) {
      if (!confirm('确认删除该股票池？')) return;
      Store.deletePool(id);
      showToast('已删除', 'success');
    }

    /** 一键选择当日股票明细：从当日新闻关联股票生成，预填到股票列表 */
    function pickDailyStocks() {
      const date = poolModal.data.date;
      if (!date) {
        showToast('请先选择日期', 'error');
        return;
      }
      const dayNews = D.news.filter(n => n.date === date);
      const stockMap = {};
      for (const n of dayNews) {
        const stocks = parseStocks(n.relatedStocks);
        for (const s of stocks) {
          if (s.code && !stockMap[s.code]) stockMap[s.code] = s;
        }
      }
      const list = Object.values(stockMap);
      if (!list.length) {
        showToast(`所选日期（${date}）的新闻中暂无关联股票`, 'error');
        return;
      }
      poolModal.data.stockText = list.map(s =>
        s.name ? `${s.name}(${StockAPI.pureCode(s.code)})` : StockAPI.pureCode(s.code)
      ).join('\n');
      showToast(`已填入 ${list.length} 只当日股票，可再手动增删`, 'success');
    }

    /** 请求U：把股票池里「有名称但没代码（或代码残缺）」的条目反查补全。
     *  resolveStockNames 是原地修改传入对象，所以这里用一层 { name, code: '' } 包装再写回。
     *  @returns {Promise<number>} 成功补全的条数 */
    async function healBrokenCodes(pools) {
      const pend = [];
      (pools || []).forEach(p => (p.stocks || []).forEach(s => {
        if (!s || !s.name) return;
        if (/^(sh|sz|bj)\d{6}$/i.test(String(s.code || ''))) return;   // 正常代码不动
        const w = { name: s.name, code: '' };
        pend.push({ s, w });
      }));
      if (!pend.length) return 0;
      showToast(`正在补全 ${pend.length} 只缺少代码的股票...`, 'info');
      let fixed = 0;
      try {
        await StockAPI.resolveStockNames(pend.map(x => x.w));
        pend.forEach(x => {
          if (x.w.code) { x.s.code = x.w.code; x.s.name = x.w.name || x.s.name; fixed++; }
        });
      } catch (e) { console.warn('补全股票代码失败', e); }
      if (fixed) showToast(`已补全 ${fixed} 只股票的代码`, 'success');
      return fixed;
    }

    // 刷新所有股票池涨跌幅
    async function refreshPoolPrices() {
      if (!D.stockPools.length) {
        showToast('暂无股票池', 'error');
        return;
      }
      poolLoading.value = true;
      showToast('正在刷新股票池行情...', 'info');
      try {
        // 请求U 自愈：历史数据里用「名称」添加过的条目 code 为空（或只有 'sz' 这种残缺值），
        // 行情接口查不到它们 → 这些行永远显示 '-'。每次刷新时用已存的名称反查一次代码，
        // 补上即可恢复正常；补不上的保持原样，不影响其它股票。
        await healBrokenCodes(D.stockPools);
        // 收集所有代码
        const allCodes = new Set();
        D.stockPools.forEach(p => p.stocks.forEach(s => { if (s.code) allCodes.add(s.code); }));
        const quotes = await StockAPI.getQuotes([...allCodes]);
        for (const pool of D.stockPools) {
          let sum = 0, cnt = 0;
          for (const s of pool.stocks) {
            const q = quotes[s.code];
            if (q) {
              s.name = s.name || q.name;
              s.dailyChange = q.changePercent;
              s.amplitude = q.amplitude;
              s.turnover = q.turnover;
              if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;   // 总市值(亿)
              if (!isNaN(q.changePercent)) { sum += q.changePercent; cnt++; }
            }
          }
          pool.avgChange = cnt > 0 ? +(sum / cnt).toFixed(2) : null;
        }
        showToast('股票池行情已刷新', 'success');
      } catch (e) {
        showToast('刷新失败', 'error');
      } finally {
        poolLoading.value = false;
      }
    }

    function openPoolDetail(pool) {
      poolDetail.data = pool;
      poolDetail.nameEdit = false;
      poolDetail.nameDraft = pool.name || '';
      poolDetail.addText = '';
      poolDetail.noteQuery = '';   // batch42：备注搜索不跨池残留，每次打开都是全量视图
      poolDetail.show = true;
    }

    /* 在详情弹窗中向当前股票池添加股票（支持多只，用逗号/换行/分号分隔）
     *
     * 请求U 修复：以前这里拿到 parseStockInput 的结果就直接用，纯名称那部分 code 是空串，
     * 于是被当成「新股票」push 进池子（code:''）→ 后面 getQuotes('') 永远拉不到行情，
     * 表现就是「输名称添加成功但刷新不出数据」。现在补上 resolveStockNames 三级降级反查，
     * 与新建股票池（savePool）保持同一套行为；反查不到的直接跳过并提示，不再写脏数据。 */
    async function addPoolStocks() {
      const txt = (poolDetail.addText || '').trim();
      if (!txt) { showToast('请输入要添加的股票代码或名称', 'error'); return; }
      const pool = poolDetail.data;
      const parsed = StockAPI.parseStockInput(txt);
      if (!parsed.length) { showToast('未识别到有效股票', 'error'); return; }

      const needName = parsed.filter(s => s.name && !s.code);
      if (needName.length) {
        poolDetail.adding = true;
        showToast(`正在识别 ${needName.length} 个股票名称...`, 'info');
        try {
          await StockAPI.resolveStockNames(parsed);
        } finally {
          poolDetail.adding = false;
        }
      }

      const failed = parsed.filter(s => !s.code);
      if (failed.length) {
        const shown = failed.map(s => s.name || s.code).filter(Boolean).slice(0, 5).join('、');
        const more = failed.length > 5 ? ` 等 ${failed.length} 个` : '';
        if (failed.length >= parsed.length) {
          showToast(`未能识别「${shown}」${more}对应的股票，请检查名称或改用 6 位代码`, 'error');
          return;
        }
        showToast(`以下未能识别已跳过：${shown}${more}，其余股票已添加`, 'error');
      }

      const existing = new Set((pool.stocks || []).map(s => s.code));
      let added = 0;
      const newStocks = [];
      for (const p of parsed) {
        if (!p.code || existing.has(p.code)) continue;
        const ns = _newStock(p);
        newStocks.push(ns);
        existing.add(p.code);
        added++;
      }
      if (!added) { showToast('这些股票已在该股票池中', 'info'); return; }
      // 补充名称
      try {
        const quotes = await StockAPI.getQuotes(newStocks.map(s => s.code));
        newStocks.forEach(s => { const q = quotes[s.code]; if (q) s.name = s.name || q.name; });
      } catch (e) { console.warn('补充名称失败', e); }
      pool.stocks.push(...newStocks);
      // 同步更新平均涨跌幅
      recomputePoolAvg(pool);
      poolDetail.addText = '';
      showToast(`已添加 ${added} 只股票`, 'success');
    }

    /** 从当前股票池删除一只股票 */
    function removePoolStock(code) {
      const pool = poolDetail.data;
      const idx = (pool.stocks || []).findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = pool.stocks[idx].name || code;
      if (!confirm(`确认从股票池中删除「${name}」？`)) return;
      pool.stocks.splice(idx, 1);
      recomputePoolAvg(pool);
      showToast('已删除', 'success');
    }
    /** 筛选板块：从「当前选中的来源池（股票池或概念板块）」中删除某只股票 */
    function removeFilterStock(code) {
      const id = filterPanel.poolId;
      if (!id) return;
      let pool = null;
      if (id.startsWith('s-')) pool = (D.sectorPools || []).find(p => 's-' + p.id === id);
      else pool = (D.stockPools || []).find(p => 'p-' + p.id === id);
      if (!pool || !pool.stocks) return;
      const idx = pool.stocks.findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = pool.stocks[idx].name || code;
      if (!confirm(`确认从「${pool.name || ''}」中删除「${name}」？`)) return;
      pool.stocks.splice(idx, 1);
      recomputePoolAvg(pool);
      showToast('已删除', 'success');
    }

    /** 重新计算股票池平均涨跌幅（增删股票后调用） */
    function recomputePoolAvg(pool) {
      let sum = 0, cnt = 0;
      (pool.stocks || []).forEach(s => {
        if (s.dailyChange != null && !isNaN(s.dailyChange)) { sum += s.dailyChange; cnt++; }
      });
      pool.avgChange = cnt > 0 ? +(sum / cnt).toFixed(2) : null;
    }

    function startEditPoolName() {
      poolDetail.nameDraft = poolDetail.data.name || '';
      poolDetail.nameEdit = true;
    }
    function savePoolName() {
      poolDetail.data.name = (poolDetail.nameDraft || '').trim();
      poolDetail.nameEdit = false;
      showToast('股票池名称已更新', 'success');
    }

    /**
     * batch53：单个板块「自动补全」的股票数上限。
     * 背景：「人工智能」这类大板块本身就有 700+ 只成员（东财 BK0800 = 751 只），
     *  而 batch53 新增的「板块归属」召回通道会把它们整批带进语义结果 / 保存的板块里。
     *  `refreshPoolDetail` 的补全里有一部分是**逐只**请求（资金流 / 财务 / 季报），
     *  873 只就是数千次请求：浏览器会卡到连截图都超时，也等于在打爆免费接口。
     * 所以超过上限就**不自动补全**，改为明确提示 + 手动点「🔄 刷新行情」（并在服务端可承受时批量补全行业/主营）。
     */
    const AUTO_ENRICH_MAX = 200;

    async function refreshPoolDetail(pool) {
      showToast('正在刷新行情与财务数据...', 'info');
      const codes = pool.stocks.map(s => s.code).filter(Boolean);
      // 1) 实时行情（腾讯，稳定）—— 无 codes 也能返回空对象
      let quotes = {};
      try {
        quotes = await StockAPI.getQuotes(codes);
      } catch (e) {
        console.warn('实时行情刷新失败', e);
      }
      for (const s of pool.stocks) {
        const q = quotes[s.code];
        if (q) {
          s.name = s.name || q.name;
          s.dailyChange = q.changePercent;
          s.amplitude = q.amplitude;
          s.turnover = q.turnover;
          s.todayPrice = q.price || s.todayPrice;                 // 当日价
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;   // 总市值(亿)
        }
      }
      // 重新计算平均
      recomputePoolAvg(pool);
      showToast('行情已刷新，正在获取财务/股东数据...', 'info');
      // 2) 补充数据（东方财富，best-effort）：逐只 try/catch，避免单只失败中断整体
      const works = pool.stocks.filter(s => s.code);
      // 2a) batch53：**先把「缺行业 / 缺主营构成」的整批用批量接口补齐**。
      //     原来这两项在下面的逐只循环里各发一次请求 —— 一个 873 只的板块就是约 1800 次请求，
      //     既是「打开详情弹窗就卡死」的主因，也违背「用能承载一万用户的免费接口」这个前提。
      //     批量接口按 80 只一组（batch51 已落地）：873 只只需约 11 + 11 次。
      const needInd = works.filter(s => !s.industry).map(s => s.code);
      const needMb = works.filter(s => !s.mainBusiness).map(s => s.code);
      let indCovered = 0, mbCovered = 0;
      if (needInd.length) {
        try {
          const m = await StockAPI.getIndustriesBatch(needInd);
          if (m && m.size) for (const s of works) { const v = m.get(s.code); if (!s.industry && v) { s.industry = v; indCovered++; } }
        } catch (e) { console.warn('批量行业获取失败', e); }
      }
      if (needMb.length) {
        try {
          const m = await StockAPI.getMainBusinessBatch(needMb);
          if (m && m.size) for (const s of works) { const v = m.get(s.code); if (!s.mainBusiness && v) { s.mainBusiness = v; mbCovered++; } }
        } catch (e) { console.warn('批量主营构成获取失败', e); }
      }
      console.debug('[refreshPoolDetail] 批量补全：行业 ' + indCovered + '/' + needInd.length + '，主营 ' + mbCovered + '/' + needMb.length);
      // 逐只兜底只在**板块不大**时启用：大板块若批量也拿不到，宁可少几个字段，
      // 也不要在弹窗打开时对这个免费接口连发上千次请求。
      const allowPerStockFallback = works.length <= AUTO_ENRICH_MAX;
      for (let i = 0; i < works.length; i++) {
        const s = works[i];
        try {
          const [flow, fin] = await Promise.all([
            StockAPI.getCapitalFlow(s.code),
            StockAPI.getFinance(s.code)
          ]);
          if (flow != null) s.capitalFlow = flow;
          if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
          if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
          if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
          if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
          if (fin.revHb != null) s.revHb = fin.revHb;
          if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
          if (fin.netProfit != null) s.netProfit = fin.netProfit;
          if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
          if (fin.revenue != null) s.revenue = fin.revenue;
          if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
          if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
          if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
        } catch (e) {
          console.warn('补充数据获取失败', s.code, e);
        }
        // 所属行业（best-effort）：批量没覆盖到、且板块不大时，才逐只补
        try {
          if (!s.industry && allowPerStockFallback) {
            const ind = await StockAPI.getIndustry(s.code);
            if (ind) s.industry = ind;
          }
        } catch (e) {
          console.warn('行业获取失败', s.code, e);
        }
        // 主营构成（公司主业 + 占比，best-effort）：同上
        try {
          if (!s.mainBusiness && allowPerStockFallback) {
            const mb = await StockAPI.getMainBusiness(s.code);
            if (mb) s.mainBusiness = mb;
          }
        } catch (e) {
          console.warn('主营构成获取失败', s.code, e);
        }
        // 24营比 / 24扣比（季报营收/扣非对比2024同期）
        try {
          const q24 = await StockAPI.getQuarterlyFinance(s.code);
          if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
          if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
        } catch (e) {
          console.warn('季报对比获取失败', s.code, e);
        }
        // 历史价：优先「一次请求取四项 + 一周/一月」（getHistoryBundle，请求量降为 1/4 且腾讯优先），
        // 取不到的项再逐项兜底（各自独立 try，互不连坐）。旧实现把三项挤在同一 try 里，
        // 且 924 走 getHistoryClose 的窄窗口取不到 2024-09-24，导致「924涨跌」等字段长期为空。
        // 收藏/热门/筛选页早已改用此模式，唯独本函数（选股 + 股票池详情共用）遗漏。
        try {
          const hb = await StockAPI.getHistoryBundle(s.code);
          if (hb) {
            if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
            if (hb.price924 != null) s.price924 = hb.price924;
            if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
            if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
            if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
            if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
            if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
            if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
          }
        } catch (e) { console.warn('历史价批量获取失败', s.code, e); }
        if (s.yearStartPrice == null) {
          try {
            const yp = await StockAPI.getYearStartPrice(s.code);
            if (yp != null) s.yearStartPrice = yp;
          } catch (e) { console.warn('年初价获取失败', s.code, e); }
        }
        if (s.price924 == null) {
          try {
            const p924 = await StockAPI.get924Price(s.code);
            if (p924 != null) s.price924 = p924;
          } catch (e) { console.warn('924价获取失败', s.code, e); }
        }
        if (s.yearHighPrice == null || s.yearLowPrice == null) {
          try {
            const yhl = await StockAPI.getYearHighLow(s.code);
            if (yhl) {
              if (yhl.high != null) s.yearHighPrice = yhl.high;
              if (yhl.low != null) s.yearLowPrice = yhl.low;
            }
          } catch (e) { console.warn('今年高低价获取失败', s.code, e); }
        }
        // 重新计算年初涨跌幅、924涨跌幅
        if (s.todayPrice && s.yearStartPrice) {
          s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
        }
        if (s.todayPrice && s.price924) {
          s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
        }
        // 一周涨跌 / 一月涨跌
        if (s.todayPrice && s.weekAgoClose) {
          s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
        }
        if (s.todayPrice && s.monthAgoClose) {
          s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
        }
        // 每 5 只让出一次事件循环，避免卡顿
        if ((i + 1) % 5 === 0) await new Promise(r => setTimeout(r, 0));
      }
      showToast('数据刷新完成', 'success');
    }

    /** 正数统计：区间字段中「数值为正的个数」与「有数据的字段总数」（空值/非数字不计入总数） */
    function positiveStat(s) {
      let pos = 0, total = 0;
      for (const k of POSITIVE_KEYS) {
        const v = poolVal(s, k);
        if (v == null || v === '' || isNaN(parseFloat(v))) continue;
        total++;
        if (parseFloat(v) > 0) pos++;
      }
      return { pos, total };
    }
    /** 正数统计个数（供排序与区间筛选使用，返回数值） */
    function positiveCount(s) { return positiveStat(s).pos; }
    /** 正数统计展示文本：正数个数 / 有数据字段总数 */
    function positiveCountText(s) {
      const r = positiveStat(s);
      return r.total ? (r.pos + '/' + r.total) : '—';
    }

    /**
     * 公司主业展示文本：取主营构成中占比最高的前 2 项，格式「名称 占比%」。
     * 仅展示，不参与排序/筛选。
     *
     * 🔴 口径（batch46 修正）：mainBusiness[].ratio 是 **0~1 的小数**，不是百分数。
     *   它是东财 RPT_F10_FN_MAINOP 的 MBI_RATIO 原值，实测：
     *     600519 贵州茅台 MBI_RATIO=0.856909 → 茅台酒 85.69%
     *     000001 平安银行 MBI_RATIO=0.461065 → 批发金融业务 46.11%
     *     300308 中际旭创 MBI_RATIO=0.989305 → 光通信收发模块 98.93%
     *   （同文件 `bizRelevanceOf`、stock-api 的 `revenueRelevance`/`reverseBusiness` 都是按
     *    「小数 ×100 得百分数」处理的，只有下面这处老代码误以为「已是百分数」而直接拼 '%'。）
     *   后果：85.69% 被显示成「0.9%」——所有主营业务占比都被压在 1% 以内，
     *   即用户反馈的「很多业务占比才 0.9%，是不是少乘 100 了」。这里补上 ×100。
     */
    function mainBusinessText(s) {
      const arr = s && s.mainBusiness;
      if (!arr || !arr.length) return '';
      // ratio 为 0~1 小数 → ×100 转百分数再显示（勿再按「已是百分数」直接显示）
      return arr.slice(0, 2)
        .map(it => `${it.name} ${it.ratio != null ? (it.ratio * 100).toFixed(1) + '%' : ''}`)
        .join(' · ');
    }

    /** 主营产品（主业）营收占比：取主营构成中占营收比例最高的主营项，返回其占比(%)。
     *  🔴 ratio 为 0~1 小数（同上），此处统一 ×100 输出百分数。
     *  说明：东财主营构成只提供每项产品的「营收占比(MBI_RATIO/MBR_RATIO)」，无分产品扣非净利润占比。 */
    function mainBizShareRatio(s) {
      const arr = s && s.mainBusiness;
      if (!arr || !arr.length) return null;
      const top = [...arr].sort((a, b) => (b.ratio || 0) - (a.ratio || 0))[0];
      return top && top.ratio != null ? Number(top.ratio) * 100 : null;
    }
    /** 主营扣占比 = 主业营收占比 / 主营扣非占比。当前仅有营收占比(见 mainBizShareRatio)；
     *  扣非占比暂无数据源，先以占位符返回，公式与文案保留。 */
    function mainBizKcfRatio(s) {
      const revShare = mainBizShareRatio(s);
      if (revShare == null) return null;
      return { revShare: revShare, kcfShare: null };   // kcfShare 缺失 → 单元格显示占比 + "—"
    }

    // ============================================================
    //  产品业务 → 相关度（主营业务营收占比之和）
    //  与「AI 语义选股」同一口径：相关度 = 命中该产品/业务的主营构成段营收占比之和(%)
    // ============================================================
    /** 把「产品业务」输入切成匹配词：空白 / 逗号 / 顿号 / 分号 / 竖线 / 加号 分隔 */
    function bizKeywords(text) {
      return String(text == null ? '' : text)
        .split(/[\s,，、;；/|｜+＋]+/)
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0);
    }
    /**
     * 按主营构成计算单只股票相对「产品业务」的相关度。
     * 口径：遍历该股最新报告期「按产品」的营收占比构成，段名包含任一匹配词即命中，
     * 命中段的营收占比之和 = 相关度(%)，上限 100；同时给出主营业务命中明细文本。
     * 🔴 batch46 修正：mainBusiness[].ratio 是 0~1 小数（见 mainBusinessText 口径说明），
     *   此处必须 ×100 才能得到百分数——否则「茅台酒 85.69%」会被算成相关度 0.9、明细显示「0.9%」。
     * @param {object} s 股票对象（需已有 s.mainBusiness = [{name, ratio(0~1小数)}]）
     * @param {string[]} kws 已小写的匹配词
     */
    function bizRelevanceOf(s, kws) {
      const arr = (s && s.mainBusiness) || [];
      if (!arr.length || !kws.length) return { relevance: null, hitBusiness: '' };
      let sum = 0;
      const hits = [];
      for (const seg of arr) {
        const nm = String(seg.name || '').trim();
        if (!nm) continue;
        const low = nm.toLowerCase();
        if (!kws.some(k => low.includes(k))) continue;
        const r = Number(seg.ratio || 0) * 100;   // 0~1 小数 → 百分数
        sum += r;
        hits.push(nm + ' ' + r.toFixed(1) + '%');
      }
      if (!hits.length) return { relevance: 0, hitBusiness: '' };
      return { relevance: Math.min(100, Math.round(sum * 10) / 10), hitBusiness: hits.join(' · ') };
    }
    /**
     * 对一组股票批量计算「产品业务相关度」，并顺带补全 现价 / 涨跌幅 / 总市值 / 主营构成。
     * 补全口径与「筛选板块 / 选股板块」的「刷新行情」保持一致，保证同一份数据同一套字段。
     * @returns {Promise<{ok:boolean, hit?:number, total?:number, error?:string}>}
     */
    async function applyBizRelevance(list, keyword, onProgress) {
      const rows = Array.isArray(list) ? list.filter(Boolean) : [];
      const kws = bizKeywords(keyword);
      if (!kws.length) return { ok: false, error: '请先输入用于计算相关度的产品业务' };
      if (!rows.length) return { ok: false, error: '当前没有可计算的股票' };

      // 1) 行情：现价 / 涨跌幅 / 总市值（腾讯接口，批量一次拿回）
      try {
        const codes = rows.map(s => s.code).filter(Boolean);
        if (codes.length) {
          const quotes = await StockAPI.getQuotes(codes);
          rows.forEach(s => {
            const q = quotes && quotes[s.code];
            if (!q) return;
            s.name = s.name || q.name;
            if (q.price != null) s.todayPrice = q.price;
            if (q.changePercent != null) s.dailyChange = q.changePercent;
            if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
          });
        }
      } catch (e) { console.warn('产品业务相关度：行情补全失败', e); }

      // 2) 主营构成（只补缺失的；低并发，避免触发东财限流）
      const missing = rows.filter(s => !s.mainBusiness || !s.mainBusiness.length);
      let done = 0;
      if (missing.length) {
        await runWithConcurrency(missing, 4, async (s) => {
          try {
            const mb = await StockAPI.getMainBusiness(s.code);
            if (mb && mb.length) s.mainBusiness = mb;
          } catch (e) { /* 单只失败忽略 */ }
          done++;
          if (typeof onProgress === 'function') onProgress(done, missing.length);
        });
      }

      // 3) 计算相关度 + 主营业务
      let hit = 0;
      rows.forEach(s => {
        const r = bizRelevanceOf(s, kws);
        s.relevance = r.relevance;
        s.hitBusiness = r.hitBusiness;
        if (r.relevance != null && r.relevance > 0) hit++;
      });
      return { ok: true, hit: hit, total: rows.length };
    }
    /** 概念标签：从该股已保存的行业(industry)与主营产品名中，抽取出最多3个中文概念/行业标签（三行展示）。 */
    function stockConcepts(s) {
      const tags = [];
      const push = t => { t = String(t || '').trim(); if (t && tags.length < 3 && !tags.includes(t)) tags.push(t); };
      push(s && s.industry);
      const arr = s && s.mainBusiness;
      if (arr && arr.length) {
        for (const it of arr) {
          if (tags.length >= 3) break;
          const m = String(it.name || '').replace(/[（(].*?[)）]/g, '').trim();
          // 中文连续片段（长度≥2）作为候选概念词
          const segs = m.match(/[\u4e00-\u9fa5]{2,}/g) || [];
          for (const sg of segs) { if (tags.length < 3) push(sg); }
        }
      }
      return tags;
    }
    /** 合同负债展示：`1.5亿/组内排名`。rank 依据传入列表按合同负债降序。 */
    function contractLiabCell(s, list) {
      if (s.contractLiab == null) return null;
      const val = fmtYi(s.contractLiab);
      if (!Array.isArray(list) || !list.length) return val;
      const ranked = [...list].filter(x => x && x.contractLiab != null)
        .sort((a, b) => (b.contractLiab || 0) - (a.contractLiab || 0));
      const idx = ranked.findIndex(x => x.code === s.code);
      return { text: val, rank: idx >= 0 ? idx + 1 : null, total: ranked.length };
    }
    /** 金额(元) → 亿展示，空则占位 */
    function fmtYiOr(s, v) { return v == null ? '—' : fmtYi(v); }

    // ============================================================
    //  统一股票表列定义（消息7规范，去重后）
    //  前 4 列为冻结列(fixed)：序号/代码/股票名称/正数统计；其余随横条滚动
    // ============================================================
    const STOCK_COLUMNS = [
      { key: '__idx', label: '序号', fixed: true, fixedIndex: 0, width: 50, sortable: true, type: 'idx' },
      { key: 'code', label: '代码', fixed: true, fixedIndex: 1, width: 72, sortable: true, type: 'code' },
      { key: 'name', label: '股票名称', fixed: true, fixedIndex: 2, width: 92, sortable: true, type: 'name' },
      { key: 'positiveCount', label: '统计', fixed: true, fixedIndex: 3, width: 60, sortable: true, type: 'pos' },
      // 财务估值段：净利润 / 扣非 / 相关度 / 市营比 / 市净比 / 市扣比
      // 按需求：24营比、24扣比 紧随「市扣比」之后；「相关度」列位于「市营比」左侧（来自 AI 语义搜索的营收占比相关度）
      { key: 'netProfit', label: '净利润', width: 82, sortable: true, type: 'money' },
      // batch46：列名由「扣非净利润」缩短为「扣非」（**仅改显示名**，key=kcfjcxjlr 与取值口径不变）
      { key: 'kcfjcxjlr', label: '扣非', width: 82, sortable: true, type: 'money' },
      { key: 'relevance', label: '相关度', width: 70, sortable: true, type: 'relevance' },
      // batch50：「主营业务」列（key=hitBusiness，batch46 由「命中…主营业务」改名而来）**已整列删除** ——
      //   它与「主业与主要产品」取的是同一份主营构成，信息重复、还白占一列宽度；
      //   同时把「主业与主要产品」移到原「主营业务」的位置（紧随「相关度」），字段表更紧凑。
      //   注：hitBusiness 这份**数据**仍在 bizRelevanceOf/applyBizRelevance 里照常计算并写回股票对象，
      //       只是不再单独占一列（「板块成分股」勾选弹窗的悬浮提示仍在用它）。
      { key: 'mainBusiness', label: '主业与主要产品', width: 186, sortable: false, type: 'mainbiz' },
      { key: 'prRatio', label: '市营比', width: 72, sortable: true, type: 'ratio' },
      { key: 'pbRatio', label: '市净比', width: 72, sortable: true, type: 'ratio' },
      { key: 'pkRatio', label: '市扣比', width: 72, sortable: true, type: 'ratio' },
      { key: 'q24Rev', label: '24营比', width: 74, sortable: true, type: 'pct' },
      { key: 'q24Kcf', label: '24扣比', width: 74, sortable: true, type: 'pct' },
      // 924涨跌 / 年涨跌：按需求置于「24扣比」右侧（紧贴 24扣比），二者位置互换
      { key: 'change924', label: '924涨跌', width: 78, sortable: true, type: 'pct' },
      { key: 'yearChange', label: '年涨跌', width: 78, sortable: true, type: 'pct' },
      // 现价：今日实时股价，固定红色显示，便于与各项涨跌幅直接对照
      { key: 'todayPrice', label: '现价', width: 70, sortable: true, type: 'curPrice' },
      // 涨跌幅段（日涨跌紧贴一周涨跌左侧；一周/一月涨跌置于「距高价」左侧）
      // 一周涨跌 = 现价 vs 5 个交易日前收盘价；一月涨跌 = 现价 vs 20 个交易日前收盘价
      { key: 'dailyChange', label: '日涨跌', width: 78, sortable: true, type: 'pct' },
      { key: 'weekChange', label: '一周涨跌', width: 78, sortable: true, type: 'pct' },
      { key: 'monthChange', label: '一月涨跌', width: 78, sortable: true, type: 'pct' },
      { key: 'distToYearHigh', label: '距高价', width: 78, sortable: true, type: 'pct' },
      { key: 'distToYearLow', label: '距低价', width: 78, sortable: true, type: 'pct' },
      { key: 'pyRatio', label: '市净同比', width: 78, sortable: true, type: 'num2' },
      { key: 'pk2Ratio', label: '市扣同比', width: 78, sortable: true, type: 'num2' },
      { key: 'prrRatio', label: '市营同比', width: 78, sortable: true, type: 'num2' },
      { key: 'phRatio', label: '市净环比', width: 78, sortable: true, type: 'num2' },
      { key: 'pkHbRatio', label: '市扣环比', width: 78, sortable: true, type: 'num2' },
      { key: 'ph2Ratio', label: '市营环比', width: 78, sortable: true, type: 'num2' },
      { key: 'profitYoY', label: '净利润同比', width: 86, sortable: true, type: 'pct' },
      { key: 'hbGrowth', label: '净利润环比', width: 86, sortable: true, type: 'pct' },
      { key: 'kcfYoY', label: '扣非同比', width: 78, sortable: true, type: 'pct' },
      { key: 'kcfHb', label: '扣非环比', width: 78, sortable: true, type: 'pct' },
      { key: 'revenueYoY', label: '营收同比', width: 78, sortable: true, type: 'pct' },
      { key: 'revHb', label: '营收环比', width: 78, sortable: true, type: 'pct' },
      { key: 'amplitude', label: '振幅', width: 70, sortable: true, type: 'num2pct' },
      { key: 'shareholderDiff', label: '散户差额', width: 80, sortable: true, type: 'diff' },
      { key: 'shareholderCount', label: '最新散户', width: 82, sortable: true, type: 'int' },
      { key: 'prevShareholderCount', label: '上期散户', width: 82, sortable: true, type: 'int' },
      // 按需求：今年高价、今年低价 置于「换手率」左侧
      { key: 'yearHighPrice', label: '今年高价', width: 78, sortable: true, type: 'price' },
      { key: 'yearHighDays', label: '距高天', width: 64, sortable: true, type: 'days' },
      { key: 'yearLowPrice', label: '今年低价', width: 78, sortable: true, type: 'price' },
      { key: 'yearLowDays', label: '距低天', width: 64, sortable: true, type: 'days' },
      { key: 'turnover', label: '换手率', width: 70, sortable: true, type: 'num2pct' },
      // 按需求：总市值、营业收入 移至「资金流入」左侧
      { key: 'totalMarketCap', label: '总市值', width: 82, sortable: true, type: 'cap' },
      { key: 'revenue', label: '营业收入', width: 86, sortable: true, type: 'money' },
      { key: 'capitalFlow', label: '资金流入', width: 90, sortable: true, type: 'flow' },
      { key: 'contractLiab', label: '合同负债及排名', width: 114, sortable: true, type: 'contractliab' },
      // 概念 / 行业：按需求置于字段栏最后（收藏/操作/备注之前）
      // （batch50：「主业与主要产品」已前移到原「主营业务」的位置，即紧随「相关度」列）
      { key: 'concept', label: '概念', width: 112, sortable: false, type: 'concept' },
      { key: 'industry', label: '行业', width: 92, sortable: true, type: 'text' },
      { key: '__fav', label: '收藏', width: 58, sortable: false, type: 'fav' },
      { key: '__action', label: '操作', width: 84, sortable: false, type: 'action' },
      // batch42：备注列默认宽度 132 → 240（用户反馈输入框太短，中文备注两三个词就看不全）。
      // 该宽度是所有股票表（收藏/筛选/股票池详情/概念板块详情/当日明细）的公共默认值；
      // 用户仍可拖拽列右边缘自行调整，拖过的表以保存值为准。
      { key: '__note', label: '备注', width: 240, sortable: false, type: 'note' }
    ];
    /**
     * 正数统计所覆盖的字段集合：日涨跌 + 财务/估值 + 涨跌幅 + 今年高低价 + 同比/环比系列。
     * 【注意】这里用显式清单而非按列顺序切片 —— 列顺序会随需求调整，
     * 若用切片，调整列顺序就会悄悄改变「统计」列的口径。
     */
    const POSITIVE_KEYS = [
      'dailyChange', 'totalMarketCap', 'revenue', 'netProfit', 'kcfjcxjlr',
      'prRatio', 'pbRatio', 'pkRatio', 'q24Rev', 'q24Kcf',
      'todayPrice', 'weekChange', 'monthChange', 'yearChange', 'change924',
      'distToYearHigh', 'distToYearLow', 'yearHighPrice', 'yearLowPrice',
      'pyRatio', 'pk2Ratio', 'prrRatio', 'phRatio', 'pkHbRatio', 'ph2Ratio',
      'profitYoY', 'hbGrowth', 'kcfYoY', 'kcfHb', 'revenueYoY', 'revHb'
    ];
    // 收藏板块专属附加列（保留原有「收藏日期/距今」，置于末尾，不丢数据；备注已并入 STOCK_COLUMNS 标准列）
    const FAV_EXTRA_COLUMNS = [
      { key: '__favDate', label: '收藏日期', width: 104, sortable: false, type: 'favDate' },
      // 距添加：(现价 - 添加当日股价) / 添加当日股价，百分比
      { key: '__favGain', label: '距添加', width: 88, sortable: true, type: 'favGain' },
      { key: '__favDays', label: '距今', width: 70, sortable: false, type: 'favDays' }
    ];

    /** HTML 转义，防止股票名/备注中的特殊字符破坏单元格结构 */
    function esc(x) {
      return String(x == null ? '' : x)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    /** 计算「日期当天距离今天多少天」（自然日差，按本地零点对齐，规避时区偏移）。
     *  @param {string} dateStr 'YYYY-MM-DD'；非法或缺失返回 null */
    function daysFromDate(dateStr) {
      if (!dateStr) return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const diff = Math.round((today - d) / 86400000);
      return isNaN(diff) ? null : diff;
    }
    /** 取某上下文对应的列定义（收藏表额外附加 3 列） */
    function getColumns(ctx) {
      return ctx === 'fav' ? STOCK_COLUMNS.concat(FAV_EXTRA_COLUMNS) : STOCK_COLUMNS;
    }
    /** 单元格内容（HTML 字符串），通过 v-html 渲染 */
    function cellHtml(col, s, idx, list, ctx) {
      const v = (k) => poolVal(s, k);
      switch (col.type) {
        case 'idx': return String((idx || 0) + 1);
        case 'code': return esc(s.code || '');
        case 'name': return esc(s.name || s.code || '');
        case 'pos': return positiveCountText(s);
        case 'mainbiz':
          return (s.mainBusiness && s.mainBusiness.length) ? esc(mainBusinessText(s)) : '<span class="muted small">—</span>';
        case 'text':
          return (s[col.key] != null && s[col.key] !== '') ? esc(String(s[col.key])) : '—';
        case 'concept': {
          const tags = stockConcepts(s);
          return tags.length ? tags.map(esc).join('<br>') : '<span class="muted small">—</span>';
        }
        case 'contractliab': {
          const c = contractLiabCell(s, list);
          if (!c) return '<span class="muted small">—</span>';
          return esc(c.text) + (c.rank != null ? '<span class="muted small">/' + c.rank + '</span>' : '');
        }
        case 'pct': { const val = v(col.key); return (val != null && !isNaN(val)) ? '<span class="' + pctClass(val) + '">' + fmtPct(val) + '</span>' : '—'; }
        case 'price': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        case 'ratio': { const val = v(col.key); return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        case 'num2': { const val = v(col.key); return (val != null && !isNaN(val)) ? (+val).toFixed(2) : '—'; }
        // 相关度：来自 AI 语义搜索的「营收占比相关度」(命中主营构成段营收占比之和 %)；无语义来源时显示占位
        case 'relevance': { const val = s[col.key]; return (val != null && !isNaN(val)) ? ((+val).toFixed(1) + '%') : '—'; }
        // 命中「主营业务」的明细（段名 + 营收占比，多条换行）。
        // batch50 起「主营业务」列已从 STOCK_COLUMNS 删除，这里**保留**该分支：
        // 数据侧 s.hitBusiness 仍在计算，若日后要恢复该列无需再补渲染逻辑。
        case 'hitbiz': {
          const txt = s.hitBusiness;
          return txt ? esc(txt).split(' · ').join('<br>') : '<span class="muted small">—</span>';
        }
        case 'num2pct': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) + '%' : '—'; }
        case 'money': { const val = s[col.key]; return (val != null && !isNaN(val)) ? fmtYi(val) : '—'; }
        // 总市值：单位已是「亿元」，直接保留两位小数展示
        case 'cap': { const val = s[col.key]; return (val != null && !isNaN(val)) ? (+val).toFixed(2) + '亿' : '—'; }
        // 现价：今日实时股价，固定红色
        case 'curPrice': { const val = s[col.key]; return (val != null && !isNaN(val)) ? '<span class="price-red">' + (+val).toFixed(2) + '</span>' : '—'; }
        case 'int': { const val = s[col.key]; return (val != null && !isNaN(val)) ? Math.round(val).toLocaleString('en-US') : '—'; }
        case 'diff': { const val = v(col.key); return (val != null && !isNaN(val)) ? ((val > 0 ? '+' : '') + Math.round(val).toLocaleString('en-US')) : '—'; }
        case 'flow': {
          const val = s[col.key];
          if (val == null || isNaN(val)) return '—';
          return '<span class="' + numClass(val) + '">' + fmtYi(val) + '</span>';
        }
        case 'favDate': return esc(s.favDate || '—');
        // 距添加：自加入收藏以来的涨跌幅 (现价-添加日股价)/添加日股价
        case 'favGain': { const val = favGainPct(s); return (val != null && !isNaN(val)) ? '<span class="' + pctClass(val) + '">' + fmtPct(val) + '</span>' : '—'; }
        case 'favDays': { const d = favDays(s); return d != null ? d + '天' : '—'; }
        // 距高天 / 距低天：今年最高/最低价当天距今天数（自然日），无数据占位
        case 'days': { const val = poolVal(s, col.key); return (val != null && !isNaN(val)) ? (val + '天') : '—'; }
        case 'note': {
          // batch41：所有表格（收藏 / 股票池详情 / 概念选股板块详情 / 筛选 / 热门明细）都渲染成可编辑输入框。
          // 用 change 提交（回车或点击别处生效），不在 input 上实时提交 —— v-html 单元格在数据变化时会整段重建，
          // 边打字边提交会把刚聚焦的输入框重建成新节点，光标直接丢失、字也打不全。
          const f = _findFavByCode(s.code);
          const idAttr = (ctx === 'fav') ? (' data-id="' + esc(s.id || (f && f.id) || '') + '"') : '';
          return '<input class="fav-note-input note-input" type="text" data-action="note"' + idAttr
            + ' data-code="' + esc(s.code || '') + '"'
            + ' value="' + esc(stockNoteOf(s.code)) + '"'
            + ' placeholder="备注" title="填写备注，回车或点击别处保存">';
        }
        case 'fav': {
          const on = isFav(s.code);
          return '<button type="button" class="btn-icon fav-btn" data-action="fav" data-code="' + esc(s.code) + '" data-name="' + esc(s.name || '') + '">' + (on ? '★' : '☆') + '</button>';
        }
        case 'action': {
          const label = ctx === 'fav' ? '🗑' : '🗑 删除';
          return '<button type="button" class="btn-icon act-btn" data-action="remove" data-code="' + esc(s.code) + '">' + label + '</button>';
        }
        default: return '—';
      }
    }
    /**
     * 数值列（右对齐）判定 —— 表头与单元格必须共用同一套规则。
     * 原先表头只对部分类型、且排除冻结列才加 num-col，而单元格 cellClass 对更多类型
     * （cap / curPrice / favGain 等）也加 num-cell，导致「表头靠左、数据靠右」，
     * 字段与数据不在同一条中轴线上。这里统一为一份定义。
     */
    const NUMERIC_COL_TYPES = ['pct', 'price', 'ratio', 'num2', 'num2pct', 'money', 'flow', 'int', 'diff', 'cap', 'curPrice', 'favGain', 'relevance'];
    function isNumCol(col) { return !!col && NUMERIC_COL_TYPES.indexOf(col.type) >= 0; }

    /** 单元格 class（冻结列 + 数值列 + 涨跌色 + 多行展示） */
    function cellClass(col, s, idx, list, ctx) {
      const cls = [];
      if (col.fixed) cls.push('col-sticky', 'col-sticky-' + col.fixedIndex);
      // 注意：'pos'(正数统计) 是冻结列且与表头一样居中展示，不能加 num-cell（右对齐），
      // 否则会出现「表头居中、内容靠右」的错位
      if (isNumCol(col)) cls.push('num-cell');
      if (col.type === 'mainbiz') cls.push('mainbiz-cell');
      if (col.type === 'hitbiz') cls.push('mainbiz-cell');
      if (col.type === 'concept') cls.push('concept-cell');
      if (col.type === 'pct') cls.push(pctClass(poolVal(s, col.key)));
      if (col.type === 'favGain') cls.push(pctClass(favGainPct(s)));
      if (col.type === 'flow') cls.push(numClass(s[col.key]));
      return cls.join(' ');
    }

    // 排序状态：favSort 在此声明；SORT_STATES 延后到各表排序状态都声明之后定义（见下方 col-resize 段落）
    const favSort = reactive({ key: '', dir: 'desc' });
    function onStockSort(col, ctx) {
      if (!col.sortable) return;
      const st = SORT_STATES[ctx];
      if (!st) return;
      if (st.key === col.key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = col.key; st.dir = 'desc'; }
    }
    function stockSortIcon(col, ctx) {
      const st = SORT_STATES[ctx];
      if (!st || st.key !== col.key) return '⇅';
      return st.dir === 'asc' ? '↑' : '↓';
    }
    /** 表格点击委托：收藏/删除按钮 */
    function onTableClick(event, ctx, rows) {
      const t = event.target.closest('[data-action]');
      if (!t) return;
      const action = t.getAttribute('data-action');
      const code = t.getAttribute('data-code');
      if (!code) return;
      if (action === 'fav') {
        const s = (rows || []).find(x => x.code === code) || { code: code, name: t.getAttribute('data-name') || code };
        toggleFavorite(s);
      } else if (action === 'remove') {
        if (ctx === 'fav') removeFavorite(code);
        else if (ctx === 'pool') removePoolStock(code);
        else if (ctx === 'sector') removeSectorStock(code);
        else if (ctx === 'filter') removeFilterStock(code);
        else if (ctx === 'hot') removeHotStock(code);
      }
    }
    /**
     * 表格 change 委托：备注输入。
     * batch41：收藏表走 data-id（兼容原有 fav.note 写入路径），其余表格按 data-code 写入通用备注表，
     * 两种路径最终都会把值同步到同一处（收藏记录上的 note 也会一起维护）。
     */
    function onTableChange(event, ctx) {
      const t = event.target.closest('[data-action="note"]');
      if (!t) return;
      const note = t.value;
      const code = t.getAttribute('data-code');
      if (code) {
        if (stockNoteOf(code) === String(note == null ? '' : note).trim()) return;   // 没改动就不写、不弹提示
        setStockNote(code, note);
        return;
      }
      const id = t.getAttribute('data-id');
      const fav = (D.favorites || []).find(f => f.id === id);
      if (fav) updateFavNote(fav, note);
    }
    /**
     * batch41：备注输入框回车即保存。
     * change 只在「失焦」时触发，用户敲完回车以为已经保存、结果还停在输入框里，观感上就像「填不进去」。
     * 这里做一次全局委托：回车把输入框 blur 掉，自然触发 change 完成保存。
     */
    if (typeof document !== 'undefined' && !document.__sntNoteEnterBound) {
      document.__sntNoteEnterBound = true;
      document.addEventListener('keydown', function (e) {
        const t = e.target;
        if (!t || !t.matches || !t.matches('input[data-action="note"]')) return;
        if (e.key === 'Enter') { e.preventDefault(); t.blur(); }
      }, true);
    }

    /** 取股票池详情某列的排序值（含计算字段 市净比/市扣比/市营比/同比/环比系列、散户差额、正数统计） */
    function poolVal(s, key) {
      if (key === 'positiveCount') return positiveCount(s);
      if (key === 'pbRatio' || key === 'pkRatio' || key === 'pyRatio' || key === 'pk2Ratio' || key === 'phRatio' || key === 'prRatio' || key === 'prrRatio' || key === 'ph2Ratio' || key === 'pkHbRatio') {
        const r = sRatio(s);
        return r[key];
      }
      if (key === 'shareholderDiff') {
        return (s.shareholderCount != null && s.prevShareholderCount != null)
          ? +(s.shareholderCount - s.prevShareholderCount) : null;
      }
      // 距今年最高/最低价的涨跌幅（%，现价相对今年高低价）
      if (key === 'distToYearHigh') {
        return (s.todayPrice && s.yearHighPrice)
          ? +(((s.todayPrice - s.yearHighPrice) / s.yearHighPrice) * 100).toFixed(2) : null;
      }
      if (key === 'distToYearLow') {
        return (s.todayPrice && s.yearLowPrice)
          ? +(((s.todayPrice - s.yearLowPrice) / s.yearLowPrice) * 100).toFixed(2) : null;
      }
      // 距高天 / 距低天：今年最高价 / 最低价当天，距离今天的自然日数（无极值日期时为 null）
      if (key === 'yearHighDays') return daysFromDate(s.yearHighDate);
      if (key === 'yearLowDays') return daysFromDate(s.yearLowDate);
      return s[key];
    }

    /**
     * 通用排序比较：字符串按 localeCompare，数值按 parseFloat，
     * 空值（null/undefined/NaN/空串）始终排最后。
     * @returns 负数/0/正数（未乘方向，调用方需乘 dir）
     */
    function compareForSort(a, b, key) {
      const va = poolVal(a, key);
      const vb = poolVal(b, key);
      const na = va == null || va === '' || isNaN(parseFloat(va));
      const nb = vb == null || vb === '' || isNaN(parseFloat(vb));
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb), 'zh-Hans-CN');
      }
      return parseFloat(va) - parseFloat(vb);
    }

    const sortedPoolDetailStocks = computed(() => {
      const list = [...(poolDetail.data.stocks || [])];
      const k = poolDetailSort.key;
      const dir = poolDetailSort.dir === 'asc' ? 1 : -1;
      if (k === '__idx') {
        const pos = new Map(list.map((s, i) => [s, i]));
        list.sort((a, b) => (pos.get(a) - pos.get(b)) * dir);
      } else {
        list.sort((a, b) => compareForSort(a, b, k) * dir);
      }
      return list;
    });
    /**
     * batch42：股票池详情表的「备注搜索」。
     * 只按备注文本过滤（大小写不敏感的子串匹配），不动其他字段 —— 用户要的是"我记过什么"，
     * 按股票名/代码搜会和已有的「添加股票」框语义打架。
     * 过滤放在排序之后：命中行的相对顺序与当前排序完全一致，清空关键词即还原全量。
     */
    const poolDetailStocksView = computed(() => {
      const q = String(poolDetail.noteQuery || '').trim().toLowerCase();
      const list = sortedPoolDetailStocks.value;
      if (!q) return list;
      return list.filter(s => String(stockNoteOf(s.code) || '').toLowerCase().indexOf(q) >= 0);
    });
    /** 已填写备注的股票数（给搜索框旁边做提示，让用户知道有多少只可被搜到） */
    const poolDetailNoteCount = computed(() =>
      (poolDetail.data.stocks || []).filter(s => String(stockNoteOf(s.code) || '').trim()).length);
    function clearPoolNoteQuery() { poolDetail.noteQuery = ''; }
    function sortPoolDetailBy(key) {
      if (poolDetailSort.key === key) {
        poolDetailSort.dir = poolDetailSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        poolDetailSort.key = key;
        poolDetailSort.dir = 'desc';
      }
    }
    function poolSortIcon(key) {
      if (poolDetailSort.key !== key) return '⇅';
      return poolDetailSort.dir === 'asc' ? '↑' : '↓';
    }

    // ============================================================
    //  页面2.5：选股
    // ============================================================
    const sectorSearch = ref('');        // 搜索框
    const sectorResults = ref([]);       // 搜索结果
    // 搜索结果按「主行业概念（行业板块）＋ 多个次行业概念（概念板块）」分组（沿用板块自带 type 字段）
  const sectorResultsMain = computed(() => sectorResults.value.filter(s => s.type === '行业'));
  const sectorResultsSub = computed(() => sectorResults.value.filter(s => s.type === '概念'));
  const sectorResultsIdx = computed(() => sectorResults.value.filter(s => s.type === '指数'));
    const sectorSearching = ref(false);
    const sectorLoading = ref(false);    // 板块成分股加载中
    const sectorIndustryOpen = ref(false); // 板块详情内「行业」勾选下拉是否展开
    const sectorDetail = reactive({ show: false, data: { stocks: [] }, nameEdit: false, nameDraft: '' });
    const sectorDetailSort = reactive({ key: 'dailyChange', dir: 'desc' });
    // 板块详情：筛选栏与「字段含义」说明的一键收起/展开（收起以显示更多股票内容）
    const sectorFilterOpen = ref(true);
    // 字段含义与计算规则默认收起，把纵向空间让给个股列表（可一键展开查看）
    const sectorInfoOpen = ref(false);
    // 其余各页/弹窗的「字段含义与计算规则」同样默认隐藏，统一由「刷新行情」左侧的按钮一键切换
    const favInfoOpen = ref(false);
    const filterInfoOpen = ref(false);
    const poolInfoOpen = ref(false);
    // 选股页「用法和说明」折叠面板（默认收起，点击标题展开）
    const sectorUsageOpen = ref(false);
    // 勾选弹窗状态：选择板块成分股时使用
    const sectorPick = reactive({
      show: false, loading: false, name: '', bk: '', type: '', stocks: [], selected: {},
      // batch53：交集筛选时记录「源板块」。交集板块没有公开接口（bk 是前端生成的虚拟码），
      //         记住源板块后即可随时用它们**重算交集**，而不是拿虚拟码去查一个不存在的接口。
      blocks: [],
      // 筛选：去除301/688/北交所/ST；industry='' 表示不限行业
      filter: { no301: false, no688: false, noBj: false, noST: false, industry: '' },
      industryLoading: false,   // 是否正在补全行业字段
      industryDone: false       // 本次弹窗是否已尝试补全过行业
    });
    // 板块列表加载失败标志（用于显示重试/加载全部）
    const sectorLoadError = ref(false);
    const sectorLoadingAll = ref(false);

    // ===== 同类股票（同主营业务/产品的 A 股公司） =====
    // 逻辑：以「种子股票」的主营业务/产品为匹配词，扫描 A 股找出经营相同业务的同类公司；
    //      相关度口径与「AI 语义搜索」完全一致（命中主营段营收占比之和 %）。
    const similar = reactive({
      input: '',            // 种子股票代码/名称
      loading: false,
      error: '',
      done: false,
      seedName: '',
      seedCode: '',
      segments: [],         // 种子股票的主营构成（用于展示匹配依据）
      stocks: [],           // 同类公司结果
      minRatio: 10,         // 主营占比阈值(%)：低于该值的公司不纳入（可输入百分比）
      sort: 'ratio',        // 排序方式：'ratio' 按主营业务占比降序
      options: [            // 选项栏：固定项 + 可增删的自定义项
        { id: 'sort', fixed: true, type: 'sort', label: '股票排序方式', value: 'ratio', choices: [{ v: 'ratio', t: '主营业务占比 从大到小' }] },
        { id: 'minRatio', fixed: true, type: 'ratio', label: '主营占比', value: 10 }
      ]
    });
    /** 执行「同类股票」计算 */
    async function runSimilarBusiness() {
      const q = String(similar.input || '').trim();
      if (!q) { showToast('请输入种子股票代码/名称，如 600519 / 贵州茅台', 'error'); return; }
      similar.loading = true;
      similar.error = '';
      similar.done = false;
      similar.stocks = [];
      similar.segments = [];
      try {
        const res = await StockAPI.getSimilarByBusiness({
          code: q,
          minRatio: Number(similar.minRatio) || 0,
          sort: similar.sort || 'ratio'
        });
        if (!res.ok) {
          similar.error = res.error || '计算失败';
          showToast(similar.error, 'error');
        } else {
          similar.seedName = (res.seed && res.seed.name) || '';
          similar.seedCode = (res.seed && res.seed.code) || '';
          similar.segments = res.segments || [];
          similar.stocks = res.stocks || [];
          similar.done = true;
          showToast(`同类股票计算完成：命中 ${similar.stocks.length} 只`, similar.stocks.length ? 'success' : 'info');
        }
      } catch (e) {
        similar.error = '同类股票计算失败：' + (e && e.message ? e.message : e);
        showToast(similar.error, 'error');
        console.warn('同类股票计算失败', e);
      } finally {
        similar.loading = false;
      }
    }
    /** 按当前阈值/排序重排（不重新请求，仅本地过滤+排序） */
    function applySimilarOptions() {
      const th = Number(similar.minRatio) || 0;
      similar.stocks = similar.stocks
        .filter(s => (s.bizRatio || 0) >= th)
        .sort((a, b) => (b.bizRatio || 0) - (a.bizRatio || 0));
      showToast(`已按阈值 ${th}% 过滤，剩 ${similar.stocks.length} 只`, 'info');
    }
    /** 选项栏：新增自定义选项 */
    const similarNewOption = ref('');
    function addSimilarOption() {
      const t = String(similarNewOption.value || '').trim();
      if (!t) return;
      similar.options.push({ id: 'opt_' + Date.now(), fixed: false, type: 'custom', label: t, value: '' });
      similarNewOption.value = '';
    }
    /** 选项栏：删除自定义选项（固定项不可删） */
    function removeSimilarOption(opt) {
      if (!opt || opt.fixed) return;
      const i = similar.options.findIndex(o => o.id === opt.id);
      if (i >= 0) similar.options.splice(i, 1);
    }
    /** 选项栏：修改自定义选项值 */
    function setSimilarOptionValue(opt, v) { if (opt) opt.value = v; }

    // ===== AI 语义选股（自然语言 → 概念交叉 → 核心标的） =====
    const semantic = reactive({
      searching: false,
      error: '',
      query: '',
      concepts: [],
      modifiers: [],
      method: '',       // 'product' | 'deep' | 'revenue' | 'boards' | 'empty'
      productKey: '',
      productDesc: '',
      boards: [],       // 命中的板块（用于透明展示）
      stocks: [],       // 结果股票列表
      matchers: [],     // 营收占比相关度的主营段名匹配词（重算时回传，保持业务意图）
      done: false,
      saved: false,     // 是否已保存到我的板块
      recomputing: false, // 编辑概念/板块后正在按条件重算
      progress: '',     // 深度扫描（全市场主营构成）进度提示
      scan: null        // { pool, deep, matched } 本次检索的扫描范围
    });
    async function semanticSearch(forceDeep) {
      const q = String(sectorSearch.value || '').trim();
      if (!q) { showToast('请输入语义描述，如：谐波减速器 / 主营为ai安全的核心上市公司', 'error'); return; }
      if (semantic.searching) return;
      semantic.searching = true;
      semantic.error = '';
      semantic.boards = [];
      semantic.stocks = [];
      semantic.done = false;
      semantic.saved = false;
      semantic.scan = null;
      semantic.progress = '';
      const t0 = Date.now();
      try {
        const res = await StockAPI.semanticSearch(q, {
          deep: !!forceDeep,
          // 深度扫描要拉全市场 5 万+ 行主营构成（约 100+ 页），必须给用户可见反馈，否则像是卡死
          onProgress: (done, total) => { semantic.progress = `🌐 正在扫描全市场主营构成 ${done}/${total} 页…`; }
        });
        if (!res.ok) {
          semantic.error = res.error || '解析失败';
          showToast(semantic.error, 'error');
        } else {
          semantic.query = res.query;
          semantic.concepts = res.concepts;
          semantic.modifiers = res.modifiers;
          semantic.method = res.method;
          semantic.productKey = res.productKey || '';
          semantic.productDesc = res.productDesc || '';
          semantic.boards = res.boards;
          semantic.stocks = res.stocks;
          semantic.matchers = res.matchers || [];
          semantic.scan = res.scan || null;
          semantic.done = true;
          const m = res.method === 'product' ? '产品级语义命中（同产品族，按营收占比）'
            : res.method === 'deep' ? '全市场深度扫描（同业务/同产品，按营收占比）'
            : res.method === 'boards' ? '按当前板块重算（营收占比相关度）'
            : res.method === 'revenue' ? '营收占比相关度（主营构成匹配）' : '空';
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const scope = res.scan ? `，扫描 ${res.scan.pool} 只${res.scan.deep ? '（全市场）' : ''}` : '';
          showToast(`AI语义筛选完成：${m}，命中 ${res.stocks.length} 只${scope}（${secs}s）`, 'success');
        }
      } catch (e) {
        semantic.error = 'AI语义筛选失败：' + (e && e.message ? e.message : e);
        showToast(semantic.error, 'error');
        console.warn('AI语义筛选失败', e);
      } finally {
        semantic.searching = false;
        semantic.progress = '';
      }
    }
    // 把语义筛选结果保存为「我的概念选股板块」
    function saveSemanticAsPool() {
      if (!semantic.stocks.length) { showToast('暂无可保存的结果', 'error'); return; }
      if (semantic.saved) { showToast('该结果已保存', 'info'); return; }
      const conceptLabel = semantic.concepts.join('+') || '语义';
      const modLabel = semantic.modifiers.includes('核心') ? '(核心)' : '';
      const sector = {
        name: `AI语义:${conceptLabel}${modLabel}`,
        bk: 'SEMANTIC_' + Date.now(),
        type: 'AI语义',
        date: Store.today(),
        stocks: semantic.stocks.map(s => ({ code: s.code, name: s.name, relevance: s.relevance != null ? s.relevance : null }))
      };
      Store.addSectorPool(sector);
      recomputePoolAvg(sector);
      semantic.saved = true;
      showToast(`已保存板块「${sector.name}」共 ${sector.stocks.length} 只`, 'success');
    }

    // ===== 反推业务：输入一只股票，反推其主营构成的相关度与热度 =====
    const reverseSort = ref('relevance'); // 'relevance' | 'heat'
    const reverse = reactive({
      loading: false,
      error: '',
      input: '',
      name: '',
      code: '',
      segments: [],
      done: false,
      hotTheme: '',         // 固定首行概念名（反推后自动填入该股最火概念，可改）
      hotConcept: null,     // 固定首行的「该股最火概念」计算数据 {bk,name,corr,heat,boardNames}
      customName: '',       // 固定次行业务名（用户自行填写）
      industry: ''          // 反推个股所属细分行业（明细到最细层级，如「电力设备 / 其他电源设备Ⅱ / 综合电力设备商」）
    });
    function setReverseSort(k) { reverseSort.value = k; }
    // 自定义业务行的计算数据（与下方主营构成行口径完全一致：营收占比/相关度/热度=股票数/对应板块）
    const reverseCustom = reactive({ ratio: null, relevance: null, heat: null, boardNames: [] });
    watch(
      [() => reverse.customName, () => reverse.done, () => reverse.name],
      async () => {
        const cn = (reverse.customName || '').trim();
        if (!reverse.done || !cn) {
          reverseCustom.ratio = null; reverseCustom.relevance = null; reverseCustom.heat = null; reverseCustom.boardNames = [];
          return;
        }
        // 1) 优先匹配该股票已有的主营构成业务，直接复用其计算数据
        const m = (reverse.segments || []).find(s => s.name && (s.name === cn || s.name.includes(cn) || cn.includes(s.name)));
        if (m) {
          reverseCustom.ratio = m.ratio; reverseCustom.relevance = m.relevance; reverseCustom.heat = m.heat; reverseCustom.boardNames = m.boardNames || [];
          return;
        }
        // 2) 否则按业务名解析东财板块，取成分股数作为热度（股票数）
        try {
          const boards = await StockAPI.searchSectors(cn);
          if (boards && boards.length) {
            const cnt = await StockAPI.getSectorStockCount(boards[0].code);
            reverseCustom.heat = cnt || null;
            reverseCustom.boardNames = [boards[0].name];
          } else {
            reverseCustom.heat = null; reverseCustom.boardNames = [];
          }
        } catch (e) {
          reverseCustom.heat = null; reverseCustom.boardNames = [];
        }
        reverseCustom.ratio = null; reverseCustom.relevance = null;
      }
    );
    const reverseSorted = computed(() => {
      const segs = reverse.segments || [];
      const rows = [];
      // ① 固定首行：该股最火概念（标签在股票名称列）
      //    数据取自「与个股日收益率联动最强(相关系数最高)的概念板块」：
      //    营收占比不适用(显示—)，相关度=联动强度(corr%)，热度=该概念板块成分股数。
      const hc = reverse.hotConcept;
      if (hc && hc.name) {
        rows.push({
          type: 'hot',
          name: (reverse.hotTheme || '').trim() || hc.name,
          ratio: null,
          relevance: (hc.corr != null) ? hc.corr : null,
          heat: hc.heat || null,
          boardNames: hc.boardNames || [hc.name]
        });
      } else {
        // 回退口径：主营构成中热度(同业公司数)最高的业务段
        const byHeat = [...segs].sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.relevance || 0) - (a.relevance || 0));
        let hotSeg = byHeat[0] || null;
        const htName = (reverse.hotTheme || '').trim();
        if (htName && hotSeg) {
          const m = segs.find(s => s.name && (s.name === htName || s.name.includes(htName) || htName.includes(s.name)));
          if (m) hotSeg = m;
        }
        rows.push({
          type: 'hot',
          name: htName || (hotSeg ? hotSeg.name : ''),
          ratio: hotSeg ? hotSeg.ratio : null,
          relevance: hotSeg ? hotSeg.relevance : null,
          heat: hotSeg ? hotSeg.heat : null,
          boardNames: hotSeg ? (hotSeg.boardNames || []) : []
        });
      }
      // ② 固定次行：自定义业务（名称可填，数据口径与下方一致）
      rows.push({
        type: 'custom',
        name: (reverse.customName || '').trim(),
        ratio: reverseCustom.ratio,
        relevance: reverseCustom.relevance,
        heat: reverseCustom.heat,
        boardNames: reverseCustom.boardNames
      });
      // 正常业务结果（排除已固定在首行的主营构成段，避免重复）
      let below = segs;
      if (hc && hc.bk) {
        // 若最火概念恰好命中某主营构成段，下方不再重复列出该段
        const hit = segs.find(s => (s.boardCodes || []).includes(hc.bk));
        if (hit) below = segs.filter(s => s !== hit);
      }
      if (reverseSort.value === 'heat') {
        below.sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.relevance || 0) - (a.relevance || 0));
      } else {
        below.sort((a, b) => (b.relevance || 0) - (a.relevance || 0) || (b.heat || 0) - (a.heat || 0));
      }
      below.forEach(s => rows.push({ type: 'seg', ...s }));
      return rows;
    });
    async function reverseBusiness() {
      const v = String(reverse.input || '').trim();
      if (!v) { showToast('请输入股票代码或名称，如：掌阅科技 / 603533', 'error'); return; }
      reverse.loading = true; reverse.error = ''; reverse.done = false; reverse.segments = []; reverse.industry = '';
      try {
        const res = await StockAPI.reverseBusiness(v);
        if (!res.ok) {
          reverse.error = res.error || '反推失败';
          showToast(reverse.error, 'error');
        } else {
          reverse.name = res.name; reverse.code = res.code; reverse.segments = res.segments; reverse.hotTheme = res.hotBusiness || ''; reverse.hotConcept = res.hotConcept || null; reverse.done = true;
          reverse.industry = '';
          // 异步补全细分行业（best-effort，不阻塞结果展示）
          try {
            const ind = await StockAPI.getIndustryDetail(res.code);
            if (ind) reverse.industry = ind;
          } catch (e) { console.debug('反推业务细分行业获取失败', res.code, e); }
          showToast(`反推完成：${res.name} 共 ${res.segments.length} 项主营构成`, 'success');
        }
      } catch (e) {
        reverse.error = '反推业务失败：' + (e && e.message ? e.message : e);
        showToast(reverse.error, 'error');
        console.warn('反推业务失败', e);
      } finally {
        reverse.loading = false;
      }
    }
    function reverseSortIcon(k) { return reverseSort.value === k ? '⬇️' : '↕️'; }

    // 用户编辑语义结果后，允许重新保存
    function markSemanticDirty() { semantic.saved = false; }

    // ===== 语义结果「重算引擎」：概念/板块是选股条件，股票列表由它们推导 =====

    // 根据当前概念列表，重新解析出对应的板块集合（替换 semantic.boards）
    async function rebuildBoardsFromConcepts() {
      const resolved = [];
      for (const c of semantic.concepts) {
        const bs = await StockAPI.resolveConceptToBoards(c);
        resolved.push(...bs);
      }
      const map = new Map();
      for (const b of resolved) if (!map.has(b.bk)) map.set(b.bk, b);
      semantic.boards = [...map.values()];
    }

    // 用当前板块 + 修饰词重算符合语义的上市公司
    async function recomputeSemanticStocks() {
      if (!semantic.boards.length) {
        semantic.stocks = [];
        if (semantic.method !== 'product') semantic.method = 'empty';
        semantic.recomputing = false;
        markSemanticDirty();
        showToast('当前没有命中板块，无法重算；请先添加板块或在概念里补充主题', 'info');
        return;
      }
      semantic.recomputing = true;
      try {
        const res = await StockAPI.recomputeSemanticStocks({
          boards: semantic.boards.map(b => ({ bk: b.bk, name: b.name })),
          modifiers: semantic.modifiers,
          concepts: semantic.concepts,
          matchers: semantic.matchers
        });
        semantic.stocks = res.stocks;
        semantic.method = res.method;
        semantic.scan = res.scan || semantic.scan;
        semantic.saved = false;
        const m = res.method === 'intersect' ? '概念交集（同时归属这些板块的公司）'
          : res.method === 'union' ? '概念并集（无完全交集，已展示并集）'
          : res.method === 'single' ? '单板块'
          : res.method === 'deep' ? '全市场深度扫描（营收占比相关度）'
          : res.method === 'product' ? '产品级语义命中（营收占比相关度）'
          : (res.method === 'boards' ? '按当前板块重算（营收占比相关度）' : '空');
        showToast(`已按当前条件重算：${m}，命中 ${res.stocks.length} 只`, 'success');
      } catch (e) {
        showToast('重算失败：' + (e && e.message ? e.message : e), 'error');
        console.warn('语义重算失败', e);
      } finally {
        semantic.recomputing = false;
      }
    }

    // 概念变化：重建板块并立刻重算
    async function onConceptChanged() {
      if (semantic.method === 'product') { markSemanticDirty(); return; } // 产品级结果由产业链库定义，概念仅作标签
      await rebuildBoardsFromConcepts();
      await recomputeSemanticStocks();
    }
    // 板块变化：直接用当前板块重算
    async function onBoardChanged() {
      await recomputeSemanticStocks();
    }

    // ===== 语义结果 增删改：识别概念 =====
    const editingConceptIdx = ref(-1);
    const conceptDraft = ref('');
    const newConceptText = ref('');
    function startEditConcept(i) { editingConceptIdx.value = i; conceptDraft.value = semantic.concepts[i] || ''; }
    async function commitEditConcept() {
      const i = editingConceptIdx.value; const v = conceptDraft.value.trim();
      if (i >= 0 && v) semantic.concepts[i] = v;
      editingConceptIdx.value = -1;
      await onConceptChanged();
    }
    function cancelEditConcept() { editingConceptIdx.value = -1; }
    async function removeConcept(i) { if (i >= 0) semantic.concepts.splice(i, 1); await onConceptChanged(); }
    async function addConcept() {
      const v = newConceptText.value.trim(); if (v) { semantic.concepts.push(v); newConceptText.value = ''; await onConceptChanged(); }
    }

    // ===== 语义结果 增删改：命中板块 =====
    const editingBoardIdx = ref(-1);
    const boardDraft = ref('');
    const boardAddKw = ref('');
    const boardAddMatches = ref([]);
    const boardAdding = ref(false);
    function startEditBoard(i) { editingBoardIdx.value = i; boardDraft.value = semantic.boards[i] ? (semantic.boards[i].name || '') : ''; }
    async function commitEditBoard() {
      const i = editingBoardIdx.value; const v = boardDraft.value.trim();
      if (i >= 0 && semantic.boards[i]) semantic.boards[i].name = v;
      editingBoardIdx.value = -1;
      await onBoardChanged();
    }
    function cancelEditBoard() { editingBoardIdx.value = -1; }
    async function removeBoard(i) { if (i >= 0) semantic.boards.splice(i, 1); await onBoardChanged(); }
    async function searchBoardForAdd() {
      const kw = boardAddKw.value.trim(); if (!kw) { boardAddMatches.value = []; return; }
      boardAdding.value = true;
      try {
        // 优先用「东财业务板块名词典」本地匹配（零网络、不受 push2 限流影响、且含「人工智能/低空经济」等新浪没有的板块）
        const local = StockAPI.searchBoardNames(kw, 8) || [];
        if (local.length) { boardAddMatches.value = local; return; }
        const all = await StockAPI.getAllSectors();
        const k = kw.toLowerCase();
        boardAddMatches.value = all.filter(b => String(b.name || '').toLowerCase().includes(k)).slice(0, 8);
      } catch (e) { boardAddMatches.value = []; }
      finally { boardAdding.value = false; }
    }
    async function addBoard(b) {
      if (!b) return;
      semantic.boards.push({ bk: b.bk, name: b.name });
      boardAddMatches.value = []; boardAddKw.value = '';
      await onBoardChanged();
    }

    /**
     * 「命中来源」文案（batch53）。
     * 为什么需要：深度扫描原先只按「主营构成段名」召回，导致同一行业的公司因**各自给业务线起名不同**
     * 而召回率随机波动 —— 输入「证券」时中国银河、国泰海通这类段名不含「证券」的公司会被静默丢掉。
     * 现在补上「板块成员 / 行业归属」通道，但它们的相关度是 0（不伪造营收占比），
     * 所以必须在界面上说清楚**这一行是靠什么被选出来的**，否则用户会以为相关度算错了。
     */
    function matchKindLabel(s) {
      if (!s) return '—';
      const via = s.matchVia ? '：' + s.matchVia : '';
      switch (s.matchKind) {
        case 'board': return '板块成员' + via;
        case 'industry': return '行业归属' + via;
        case 'product': return '产品库';
        default: return '主营业务';
      }
    }

    // ===== 语义结果 增删改：筛选出的股票 =====
    const editingStockCode = ref('');
    const stockNameDraft = ref('');
    const stockRoleDraft = ref('');
    const stockConceptsDraft = ref('');
    const stockAddCode = ref('');
    const stockAdding = ref(false);
    function startEditStock(s) {
      editingStockCode.value = s.code; stockNameDraft.value = s.name || '';
      stockRoleDraft.value = s.role || ''; stockConceptsDraft.value = (s.concepts || []).join(',');
    }
    function commitEditStock() {
      const s = semantic.stocks.find(x => x.code === editingStockCode.value);
      if (s) {
        s.name = stockNameDraft.value.trim() || s.name;
        s.role = stockRoleDraft.value.trim();
        s.concepts = (stockConceptsDraft.value || '').split(/[,，]/).map(t => t.trim()).filter(Boolean);
      }
      editingStockCode.value = ''; markSemanticDirty();
    }
    function cancelEditStock() { editingStockCode.value = ''; }
    function removeStock(code) {
      const i = semantic.stocks.findIndex(x => x.code === code);
      if (i >= 0) semantic.stocks.splice(i, 1); markSemanticDirty();
    }
    /* 请求U：以前这里只跑 StockAPI.inferPrefix(raw)——非数字输入会被 replace(/\D/g,'') 清空，
     * 所有分支都不匹配，最终落到 return 'sz' + pure，即 code='sz'，行情必然拉不到。
     * 改成走统一的「名称 / 代码」解析，支持 600519 / sh600519 / 贵州茅台 / 贵州茅台(600519)，
     * 多只用逗号、分号或空格分隔。 */
    async function addStockByCode() {
      const raw = stockAddCode.value.trim();
      if (!raw) { showToast('请输入股票代码或名称', 'error'); return; }
      stockAdding.value = true;
      try {
        const parsed = StockAPI.parseStockInput(raw);
        if (!parsed.length) { showToast('未识别到有效股票', 'error'); return; }
        const needName = parsed.filter(s => s.name && !s.code);
        if (needName.length) {
          showToast(`正在识别 ${needName.length} 个股票名称...`, 'info');
          await StockAPI.resolveStockNames(parsed);
        }
        const list = parsed.filter(s => s.code);
        if (!list.length) {
          const names = parsed.map(s => s.name || s.code).slice(0, 3).join('、');
          showToast(`未能识别「${names}」，请检查名称或改用 6 位代码`, 'error');
          return;
        }
        const exist = new Set(semantic.stocks.map(s => s.code));
        const targets = [];
        for (const it of list) {
          if (exist.has(it.code)) continue;
          exist.add(it.code);
          targets.push(it);
        }
        if (!targets.length) { showToast('这些股票已在列表中', 'info'); stockAddCode.value = ''; return; }
        const q = await StockAPI.getQuotes(targets.map(t => t.code)) || {};
        let firstName = '';
        for (const it of targets) {
          const info = q[it.code] || {};
          const name = info.name || it.name || it.code.toUpperCase();
          if (!firstName) firstName = name;
          semantic.stocks.push({
            code: it.code, name,
            price: info.price != null ? info.price : null,
            changePercent: info.changePercent != null ? info.changePercent : null,
            marketCap: info.totalMarketCap != null ? info.totalMarketCap * 1e8 : null,
            role: '手动添加',
            concepts: semantic.concepts.slice(),
            relevance: null
          });
        }
        stockAddCode.value = '';
        // batch60：输入框已移到选股栏——没有语义结果时手动添加，也要把结果面板显示出来
        if (!semantic.done) { semantic.done = true; if (!semantic.query) semantic.query = '手动添加'; }
        showToast(targets.length > 1 ? `已添加 ${targets.length} 只股票，首个：${firstName}` : '已添加 ' + firstName, 'success');
        markSemanticDirty();
      } catch (e) {
        showToast('添加失败：' + (e && e.message ? e.message : e), 'error');
      } finally { stockAdding.value = false; }
    }

    /**
     * batch60：「恢复」按钮（选股栏末尾）——清空搜索词与全部结果，恢复默认状态。
     * 覆盖范围：板块搜索词/搜索结果、AI语义筛选、同类股票、反推业务、手动添加输入框。
     * 不动「我的概念选股板块」等已保存数据（那属于删除操作，不叫恢复默认状态）。
     */
    function resetSectorPanel() {
      sectorSearch.value = '';
      sectorResults.value = [];
      stockAddCode.value = '';
      // AI 语义筛选状态复位
      semantic.searching = false; semantic.error = ''; semantic.query = '';
      semantic.concepts = []; semantic.modifiers = [];
      semantic.method = ''; semantic.productKey = ''; semantic.productDesc = '';
      semantic.boards = []; semantic.stocks = []; semantic.matchers = [];
      semantic.done = false; semantic.saved = false;
      semantic.recomputing = false; semantic.progress = ''; semantic.scan = null;
      // 同类股票状态复位（保留排序方式/占比阈值这两个固定选项的默认值）
      similar.input = ''; similar.loading = false; similar.error = ''; similar.done = false;
      similar.seedName = ''; similar.seedCode = ''; similar.segments = []; similar.stocks = [];
      // 反推业务状态复位
      reverse.input = ''; reverse.loading = false; reverse.error = ''; reverse.done = false;
      reverse.name = ''; reverse.code = ''; reverse.segments = [];
      reverse.hotTheme = ''; reverse.hotConcept = null;
      showToast('已恢复默认状态', 'info');
    }

    // ===== batch60：全局回顶按钮（任何页面向下滚动超过一屏后出现） =====
    const showBackTop = ref(false);
    function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
    function _updateBackTop() {
      const y = Math.max(window.scrollY || window.pageYOffset || 0,
        document.documentElement.scrollTop || document.body.scrollTop || 0);
      showBackTop.value = y > 400;
    }

    // 已保存板块顺序：一旦用户拖动过卡片（所有板块都有显式 order），就按 order 升序；
    // 否则沿用旧的「按创建时间倒序」（新板块在最前），保证老数据的观感不变。
    // batch41：无论哪种基准，一键置顶（pinned）的板块都恒排在最前，组内顺序保持基准顺序不变。
    const sortedSectorPools = computed(() => {
      const list = [...D.sectorPools];
      const ordered = list.length > 0 && list.every(p => typeof p.order === 'number' && isFinite(p.order));
      const base = ordered
        ? list.sort((a, b) => a.order - b.order)
        : list
            .map((p, i) => ({ p, i }))
            .sort((a, b) => ((b.p.createdAt || 0) - (a.p.createdAt || 0)) || (b.i - a.i))
            .map(x => x.p);
      return base.filter(p => p.pinned).concat(base.filter(p => !p.pinned));
    });

    // ===== 板块卡片拖动排序 =====
    const poolDragId = ref('');     // 正在拖动的板块 id
    const poolDropId = ref('');     // 当前落点板块 id（用于高亮插入位置）
    let _poolDragged = false;       // 本次是否真的拖动过（用于拖完不误触发「打开详情」）

    /** 当前展示顺序固化为每个板块的 order 字段（持久化） */
    function _writePoolOrder(list) {
      list.forEach((p, i) => { p.order = i; });
    }
    function onPoolDragStart(pool, e) {
      if (sectorSubKeyword.value.trim()) {
        // 筛选状态下只能看到部分板块，拖动会导致顺序错乱，直接拦掉并说清原因
        showToast('子版块筛选状态下无法拖动排序，请先「✕ 清除筛选」', 'error');
        if (e && e.preventDefault) e.preventDefault();
        return;
      }
      _poolDragged = false;
      poolDragId.value = pool.id;
      if (e && e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(pool.id)); } catch (err) { /* 忽略 */ }
      }
    }
    function onPoolDragOver(pool) {
      if (!poolDragId.value || poolDragId.value === pool.id) return;
      _poolDragged = true;
      poolDropId.value = pool.id;
    }
    function onPoolDragEnd() {
      poolDragId.value = '';
      poolDropId.value = '';
      // 延迟复位，避免紧随其后的 click 把「打开详情」触发出来
      setTimeout(() => { _poolDragged = false; }, 60);
    }
    function onPoolDrop(pool) {
      const fromId = poolDragId.value;
      poolDragId.value = '';
      poolDropId.value = '';
      if (!fromId || fromId === pool.id) return;
      const list = sortedSectorPools.value.slice();   // 以当前展示顺序为基准
      const from = list.findIndex(p => p.id === fromId);
      const to = list.findIndex(p => p.id === pool.id);
      if (from === -1 || to === -1) return;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      // batch41：置顶板块始终固定在最前，不参与拖动换位（拖动只会调整「未置顶」板块之间的相对顺序）
      const finalList = list.filter(p => p.pinned).concat(list.filter(p => !p.pinned));
      _writePoolOrder(finalList);
      showToast(`已调整顺序：「${moved.name || '未命名板块'}」移到第 ${finalList.findIndex(p => p.id === moved.id) + 1} 位`, 'success');
    }
    /** 点击卡片打开详情（拖动后不触发，避免「拖一下就弹窗」） */
    function openPoolCard(pool) {
      if (_poolDragged) return;
      openSectorDetail(pool);
    }
    /** 恢复为默认顺序（按创建时间倒序） */
    function resetPoolOrder() {
      D.sectorPools.forEach(p => { delete p.order; });
      showToast('已恢复默认顺序（按创建时间倒序）', 'success');
    }

    // ===== 「我的概念选股板块」一键刷新（只刷新当日涨跌） =====
    const sectorPoolsRefreshing = ref(false);
    /**
     * 一键刷新：只刷新各板块成分股的「当日涨跌幅」（顺带更新现价以便重算平均涨跌幅），
     * 不拉取财务、股东户数、历史价等字段——目的就是快速看板块内当天谁在涨。
     * 代码数量多时按 60 只一批，避免单次 URL 过长被源站拒绝。
     */
    async function refreshSectorPoolsDailyChange() {
      const pools = sortedSectorPools.value;
      if (!pools.length) { showToast('暂无概念选股板块', 'error'); return; }
      if (sectorPoolsRefreshing.value) return;
      const codes = [];
      const seen = new Set();
      pools.forEach(p => (p.stocks || []).forEach(s => {
        if (s.code && !seen.has(s.code)) { seen.add(s.code); codes.push(s.code); }
      }));
      if (!codes.length) { showToast('板块内暂无股票', 'error'); return; }
      sectorPoolsRefreshing.value = true;
      showToast(`正在刷新 ${codes.length} 只股票的当日涨跌...`, 'info');
      try {
        const quotes = {};
        const BATCH = 60;
        for (let i = 0; i < codes.length; i += BATCH) {
          const batch = codes.slice(i, i + BATCH);
          try { Object.assign(quotes, (await StockAPI.getQuotes(batch)) || {}); }
          catch (e) { console.warn('批量行情获取失败', i, e); }
        }
        let hit = 0;
        pools.forEach(pool => {
          (pool.stocks || []).forEach(s => {
            const q = quotes[s.code];
            if (!q) return;
            if (q.changePercent != null && !isNaN(q.changePercent)) { s.dailyChange = q.changePercent; hit++; }
            if (q.price != null) s.todayPrice = q.price;
          });
          recomputePoolAvg(pool);
        });
        if (!hit) showToast('未取到行情（可能受网络限制），请稍后重试', 'error');
        else showToast(`已刷新 ${hit} 只股票的当日涨跌（其余字段未改动）`, 'success');
      } finally {
        sectorPoolsRefreshing.value = false;
      }
    }

    // 子版块搜索：在「我的概念选股板块」列表中，按名称关键字过滤已保存板块（空关键词=不筛选）
    const sectorSubKeyword = ref('');
    const filteredSectorPools = computed(() => {
      const kw = sectorSubKeyword.value.trim();
      if (!kw) return sortedSectorPools.value;
      return sortedSectorPools.value.filter(p => String(p.name || '').includes(kw));
    });
    function searchSubSectors() {
      const kw = String(sectorSearch.value || '').trim();
      if (!kw) {
        if (sectorSubKeyword.value) {
          sectorSubKeyword.value = '';
          showToast('已取消子版块筛选', 'info');
        } else {
          showToast('请先输入板块名称关键字', 'error');
        }
        return;
      }
      sectorSubKeyword.value = kw;
      const n = filteredSectorPools.value.length;
      if (n) showToast(`子版块筛选「${kw}」：命中 ${n} 个板块`, 'success');
      else showToast(`未找到名称含「${kw}」的子板块`, 'info');
    }
    function clearSubSectorSearch() {
      sectorSubKeyword.value = '';
      showToast('已取消子版块筛选', 'info');
    }

    // 搜索板块（防抖由模板 @input 触发，这里直接调用）
    async function searchSector() {
      const kw = sectorSearch.value.trim();
      if (!kw) { sectorResults.value = []; return; }
      sectorSearching.value = true;
      sectorLoadError.value = false;
      try {
        // 🔴 batch44：先直接搜（searchSectors 内部已含「新浪全量本地过滤 + 兜底」），
        // 不再「列表为空 → 直接报加载失败 → 根本不搜」这种一刀切。
        sectorResults.value = (await StockAPI.searchSectors(kw)) || [];
        if (sectorResults.value.length) return;
        // 零结果时才检查板块库本身是否为空，以区分「库没加载出来」与「确实没这个词」
        const all = await StockAPI.getAllSectors(false);
        if (!all.length) {
          sectorLoadError.value = true;
          showToast('板块数据加载失败，请检查网络后重试', 'error');
        } else {
          showToast(`未找到「${kw}」相关板块，可尝试「加载全部板块」`, 'info');
        }
      } catch (e) {
        sectorResults.value = [];
        sectorLoadError.value = true;
        showToast('板块加载失败，请重试', 'error');
        console.warn('板块搜索失败', e);
      } finally {
        sectorSearching.value = false;
      }
    }

    // 强制重新加载板块列表（清除缓存）
    async function reloadSectors() {
      StockAPI._sectorCache = null;
      StockAPI._sectorCacheAt = 0;
      await searchSector();
    }

    // 顶部「刷新数据」：清除板块缓存后重新拉取（有搜索词按词刷新，否则加载全部板块）
    async function refreshSectorData() {
      StockAPI._sectorCache = null;
      StockAPI._sectorCacheAt = 0;
      if (sectorSearch.value.trim()) {
        await searchSector();
      } else {
        await loadAllSectors();
      }
    }

    // 加载全部板块（分页更多，用于搜索冷门概念）
    async function loadAllSectors() {
      sectorLoadingAll.value = true;
      sectorLoadError.value = false;
      showToast('正在加载全部板块，可能需要几秒...', 'info');
      try {
        const all = await StockAPI.getAllSectors(true);
        if (!all.length) {
          sectorLoadError.value = true;
          showToast('板块数据加载失败，请稍后重试', 'error');
          return;
        }
        showToast(`已加载 ${all.length} 个板块`, 'success');
        await searchSector();
      } catch (e) {
        sectorLoadError.value = true;
        showToast('全部板块加载失败，请重试', 'error');
        console.warn('加载全部板块失败', e);
      } finally {
        sectorLoadingAll.value = false;
      }
    }

    // 已选概念：主选板块 + 次选概念列表（用于交集筛选）
    const sectorSel = reactive({ main: null, subs: [] });
    const sectorSelIntersecting = ref(false);
    const sectorSelError = ref('');
    // 已选概念总数（主选+次选）
    const sectorSelCount = computed(() => (sectorSel.main ? 1 : 0) + sectorSel.subs.length);

    // 点击搜索结果板块：设为主选；无次选时直接加载成分股弹出勾选弹窗，有次选时引导交集筛选
    async function addSectorFromSearch(item) {
      // 查重：同名板块已存在则提示
      if (D.sectorPools.some(p => p.bk === item.bk)) {
        showToast('该板块已在列表中', 'info');
        return;
      }
      sectorSel.main = { bk: item.bk, name: item.name, type: item.type || '' };
      if (!sectorSel.subs.length) {
        // 无次选：直接打开单板块勾选弹窗
        await openSectorSelPick(sectorSel.main);
      } else {
        showToast(`已设「${item.name}」为主选，点击「开始交集筛选」得到交集`, 'info');
      }
    }

    // 把搜索项加入次选概念列表（查重，最多支持多个）
    function addSubSector(item) {
      if (sectorSel.subs.some(s => s.bk === item.bk)) {
        showToast(`「${item.name}」已在次选概念中`, 'info');
        return;
      }
      sectorSel.subs.push({ bk: item.bk, name: item.name, type: item.type || '' });
      showToast(`已加入次选概念：${item.name}`, 'success');
    }
    function removeSubSector(bk) {
      const i = sectorSel.subs.findIndex(s => s.bk === bk);
      if (i >= 0) sectorSel.subs.splice(i, 1);
    }
    function clearSectorSel() {
      sectorSel.main = null;
      sectorSel.subs = [];
      sectorSelError.value = '';
    }

    // 把一组板块成分股合并并取交集（同时属于所有板块的股票）
    async function _loadIntersectPick(blocks) {
      sectorPick.show = true;
      sectorPick.loading = true;
      sectorPick.stocks = [];
      sectorPick.selected = {};
      sectorPick.bk = '';
      sectorPick.blocks = (blocks || []).map(b => ({ bk: b.bk, name: b.name, type: b.type || '' }));
      sectorPick.filter.industry = '';      // 切换板块时重置行业筛选
      sectorPick.industryDone = false;
      const names = blocks.map(b => b.name).join(' ∩ ');
      sectorPick.name = names;
      sectorPick.type = '交集筛选';
      try {
        // 并行加载各板块成分股（带上板块名，末档「按名兜底」可用）
        const results = await Promise.all(blocks.map(b => StockAPI.getSectorStocks(b.bk, b.name)));
        if (results.some(r => !r.length)) {
          const miss = blocks.filter((b, i) => !(results[i] && results[i].length)).map(b => b.name).join('、');
          showToast(`部分板块未获取到成分股（${miss}）：${StockAPI.lastSectorDiag() || '接口暂不可达'}`, 'error');
          return;
        }
        // 统计每只股票出现的板块数
        const codeCount = {};
        results.forEach(list => {
          list.forEach(s => {
            const c = String(s.code || '');
            if (c) codeCount[c] = (codeCount[c] || 0) + 1;
          });
        });
        const blockCount = blocks.length;
        // 取交集：出现在所有板块中的股票
        const common = [];
        const seen = {};
        results.forEach(list => {
          list.forEach(s => {
            const c = String(s.code || '');
            if (!c || seen[c]) return;
            seen[c] = true;
            if (codeCount[c] === blockCount) common.push(s);
          });
        });
        if (!common.length) {
          showToast(`未找到同时属于以上 ${blockCount} 个概念的股票（交集为空）`, 'error');
          return;
        }
        // 转成标准股票对象，默认全部勾选
        const list = common.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sectorPick.stocks = list;
        list.forEach(s => { sectorPick.selected[s.code] = true; });
        loadSectorPickIndustries(true);   // 后台补全行业，供行业下拉筛选
        showToast(`交集筛选完成：${list.length} 只股票（同时属于 ${blockCount} 个概念）`, 'success');
      } catch (e) {
        console.warn('交集筛选失败', e);
        showToast('交集筛选失败，请重试', 'error');
      } finally {
        sectorPick.loading = false;
      }
    }

    // 打开某个已选概念的勾选弹窗（单板块）
    async function openSectorSelPick(block) {
      sectorPick.show = true;
      sectorPick.loading = true;
      sectorPick.sector = block;
      sectorPick.name = block.name;
      sectorPick.bk = block.bk;
      sectorPick.type = block.type || '';
      sectorPick.stocks = [];
      sectorPick.selected = {};
      sectorPick.filter.industry = '';      // 切换板块时重置行业筛选
      sectorPick.industryDone = false;
      showToast(`正在获取「${block.name}」成分股...`, 'info');
      try {
        const stocks = await StockAPI.getSectorStocks(block.bk, block.name);
        if (!stocks.length) {
          // batch53：不再只甩一句无信息量的「未获取到该板块成分股」。
          // 多源链路会把「每一档试了什么、结果如何」记在诊断里，直接展示给用户/便于自查。
          if (StockAPI.isVirtualBoard && StockAPI.isVirtualBoard(block.bk)) {
            showToast(`「${block.name}」是交集筛选生成的虚拟板块，没有对应的板块接口；请点「开始交集筛选」重新生成`, 'error');
          } else {
            const diag = StockAPI.lastSectorDiag ? StockAPI.lastSectorDiag() : '';
            showToast(`未取到「${block.name}」的成分股${diag ? '｜' + diag : ''}`, 'error');
          }
          return;
        }
        const list = stocks.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sectorPick.stocks = list;
        list.forEach(s => { sectorPick.selected[s.code] = true; });
        loadSectorPickIndustries(true);   // 后台补全行业，供行业下拉筛选
        showToast(`已加载 ${list.length} 只成分股，默认全选`, 'success');
      } catch (e) {
        console.warn('成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        sectorPick.loading = false;
      }
    }

    // 开始交集筛选：主选 + 所有次选概念的成分股取交集
    async function startIntersectFilter() {
      const blocks = [];
      if (sectorSel.main) blocks.push(sectorSel.main);
      sectorSel.subs.forEach(s => blocks.push(s));
      if (blocks.length < 2) {
        showToast('交集筛选需要至少主选 + 1 个次选概念', 'error');
        return;
      }
      sectorSelIntersecting.value = true;
      sectorSelError.value = '';
      try {
        await _loadIntersectPick(blocks);
      } catch (e) {
        sectorSelError.value = '交集筛选失败，请稍后重试';
        console.warn('交集筛选异常', e);
      } finally {
        sectorSelIntersecting.value = false;
      }
    }

    // 全选 / 全不选
    function toggleSelectAllSector() {
      const stocks = visibleSectorPickStocks.value;
      if (!stocks.length) return;
      const allSel = stocks.every(s => sectorPick.selected[s.code]);
      stocks.forEach(s => { sectorPick.selected[s.code] = !allSel; });
    }
    // 判断股票是否被某筛选规则排除
    function sectorPickFiltered(s) {
      // 代码可能带 sh/sz/bj 前缀，统一取纯数字后再匹配板块规则
      const code = String(pureCode(s.code) || '');
      const name = String(s.name || '');
      const f = sectorPick.filter;
      if (f.no301 && /^30[01]/.test(code)) return true;      // 创业板（300/301）
      if (f.no688 && /^688/.test(code)) return true;          // 科创板
      if (f.noBj && /^(4|8|92)/.test(code)) return true;      // 北交所（4/8/92开头）
      if (f.noST && /ST/i.test(name)) return true;            // ST/*ST
      if (f.industry && (s.industry || '未知') !== f.industry) return true; // 行业筛选
      return false;
    }
    /** 当前成分股涉及的全部行业（去重、中文排序），用于下拉选项 */
    const sectorPickIndustries = computed(() => {
      const set = new Set();
      sectorPick.stocks.forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    /** 已获取到真实行业（非「未知」）的股票数量 */
    const sectorPickIndustryLoaded = computed(() => {
      return sectorPick.stocks.filter(s => s.industry).length;
    });
    /** 异步补全缺失的行业字段（best-effort，不阻塞弹窗交互） */
    async function loadSectorPickIndustries(force) {
      if (sectorPick.industryLoading) return;
      const missing = sectorPick.stocks.filter(s => !s.industry && s.code);
      if (!missing.length) { sectorPick.industryDone = true; return; }
      if (!force && sectorPick.industryDone) return;
      sectorPick.industryLoading = true;
      try {
        // 🔴 batch51：先走**批量**接口（东财报表支持 SECUCODE in，实测 200 只 / 166ms）。
        //   旧实现逐只调 getIndustry + getMainBusiness：一个 719 只成分股的板块（如「新能源车」）
        //   要发 ~1400 次请求（CONC=4 串行 180 批），既慢又会把免费接口打爆 —— 这是万级用户下的隐患。
        //   批量后同一板块只需个位数请求。
        const codes = missing.map(s => s.code);
        try {
          const indMap = await StockAPI.getIndustriesBatch(codes);
          if (indMap && indMap.size) missing.forEach(s => { const v = indMap.get(s.code); if (v) s.industry = v; });
        } catch (e) { /* 批量失败 → 落到下面的逐只兜底 */ }
        // 逐只兜底：只处理批量仍没拿到的（正常情况下为空）
        const stillNoInd = missing.filter(s => !s.industry);
        if (stillNoInd.length) {
          const CONC = 4;   // 低并发，避免触发接口限流
          for (let i = 0; i < stillNoInd.length; i += CONC) {
            const batch = stillNoInd.slice(i, i + CONC);
            await Promise.all(batch.map(async s => {
              try {
                const ind = await StockAPI.getIndustry(s.code);
                if (ind) s.industry = ind;
              } catch (e) { /* 单只失败忽略 */ }
            }));
          }
        }
        // 主营构成（字段表「主业与主要产品」列）同样走批量补全
        const noBiz = missing.filter(s => !s.mainBusiness && s.code);
        if (noBiz.length) {
          try {
            const mbMap = await StockAPI.getMainBusinessBatch(noBiz.map(s => s.code));
            if (mbMap && mbMap.size) noBiz.forEach(s => { const v = mbMap.get(s.code); if (v) s.mainBusiness = v; });
          } catch (e) { /* 批量失败：该列显示为空，不影响勾选与保存 */ }
        }
        sectorPick.industryDone = true;
      } finally {
        sectorPick.industryLoading = false;
      }
    }
    // 过滤后可见的成分股列表
    const visibleSectorPickStocks = computed(() => {
      return sectorPick.stocks.filter(s => !sectorPickFiltered(s));
    });
    /**
     * 弹窗「空列表」时的提示文案（batch53）。
     * 区分三种完全不同的原因，不再笼统甩「未获取到该板块成分股，请重试」：
     *   ① 交集筛选虚拟板块 —— 本来就没有接口，应引导重算交集；
     *   ② 筛选条件把股票全隐藏了 —— 应提示清空筛选，而不是让用户以为接口坏了；
     *   ③ 真的没取到 —— 引导重试。
     */
    const sectorPickEmptyHint = computed(() => {
      if (sectorPick.stocks.length && !visibleSectorPickStocks.value.length) {
        return '成分股已取到，但被当前筛选条件全部隐藏了，请清空筛选（去除301/688/北交所/ST 与行业下拉）后查看';
      }
      if (StockAPI.isVirtualBoard && StockAPI.isVirtualBoard(sectorPick.bk)) {
        return '该板块是「交集筛选」生成的虚拟板块，没有对应的板块接口；请关闭后用「开始交集筛选」重新生成';
      }
      return '未获取到该板块成分股';
    });
    /** 成分股行涨跌幅：优先 dailyChange，兼容旧字段 changePercent */
    function pickChg(s) {
      if (!s) return null;
      const v = s.dailyChange != null ? s.dailyChange : s.changePercent;
      return (v == null || isNaN(v)) ? null : +v;
    }
    /**
     * 成分股勾选弹窗：按「产品业务」计算每只成分股的相关度（命中主营构成段营收占比之和）
     * 与主营业务，并补全 现价 / 涨跌幅 / 总市值 —— 口径与选股（筛选）板块完全一致。
     */
    async function computeSectorPickRelevance() {
      const rows = sectorPick.stocks || [];
      if (!rows.length) { showToast('当前没有成分股可计算', 'error'); return; }
      if (!bizKeywords(sectorPick.filter.biz).length) { showToast('请先输入用于计算相关度的产品业务', 'error'); return; }
      if (sectorPick.bizLoading) return;
      sectorPick.bizLoading = true;
      showToast('正在按主营构成计算相关度…', 'info');
      try {
        const r = await applyBizRelevance(rows, sectorPick.filter.biz, (done, total) => {
          if (done % 10 === 0 || done === total) showToast(`正在补全主营构成 ${done}/${total}…`, 'info');
        });
        if (!r.ok) { showToast(r.error, 'error'); return; }
        showToast(`相关度已更新：${r.total} 只中命中 ${r.hit} 只`, 'success');
      } catch (e) {
        console.warn('成分股相关度计算失败', e);
        showToast('计算相关度失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        sectorPick.bizLoading = false;
      }
    }
    // 已勾选数量（基于过滤后可见股票）
    const sectorPickCount = computed(() => {
      return visibleSectorPickStocks.value.filter(s => sectorPick.selected[s.code]).length;
    });

    // 确认保存勾选的股票到概念选股板块
    function confirmSectorPick() {
      const selected = visibleSectorPickStocks.value.filter(s => sectorPick.selected[s.code]);
      if (!selected.length) { showToast('请至少勾选一只股票', 'error'); return; }
      // 交集筛选场景 bk 为空，生成唯一标识，避免详情刷新时误调用真实板块接口
      const bk = sectorPick.bk || ('INTERSECT_' + Date.now());
      const sector = {
        name: sectorPick.name,
        bk: bk,
        type: sectorPick.type,
        date: Store.today(),
        stocks: selected
      };
      // batch53：交集板块必须带上「源板块」一起保存。
      // 否则虚拟码 INTERSECT_* 永远查不到接口，一旦成分股为空（换设备同步 / 误删）
      // 用户就只能反复看到「未获取到该板块成分股」而无法自愈。
      if (!sectorPick.bk && sectorPick.blocks && sectorPick.blocks.length >= 2) {
        sector.intersectBlocks = sectorPick.blocks.map(b => ({ bk: b.bk, name: b.name, type: b.type || '' }));
      }
      Store.addSectorPool(sector);
      recomputePoolAvg(sector);
      sectorPick.show = false;
      sectorPick.filter = { no301: false, no688: false, noBj: false, noST: false, industry: '', biz: '' };
      sectorResults.value = [];
      sectorSearch.value = '';
      showToast(`已保存板块「${sectorPick.name}」共 ${selected.length} 只股票`, 'success');
    }

    // 拉取某板块全部成分股并填充
    async function loadSectorStocks(sector) {
      sectorLoading.value = true;
      try {
        // batch53：交集板块（bk 形如 INTERSECT_*）没有公开接口，必须用**源板块重算交集**，
        //   否则拿虚拟码去查必然返回 0 → 用户只看到「未获取到该板块成分股」，且无法自愈。
        if (StockAPI.isVirtualBoard && StockAPI.isVirtualBoard(sector.bk)) {
          const blocks = (sector.intersectBlocks || []).filter(b => b && b.bk);
          if (blocks.length < 2) {
            showToast('该板块是交集筛选结果，缺少源板块信息，无法自动重建；请重新执行「开始交集筛选」', 'error');
            return;
          }
          const lists = await Promise.all(blocks.map(b => StockAPI.getSectorStocks(b.bk, b.name)));
          const codeCount = {};
          lists.forEach(list => (list || []).forEach(s => {
            const c = String(s.code || ''); if (c) codeCount[c] = (codeCount[c] || 0) + 1;
          }));
          const base = lists.find(l => l && l.length) || [];
          const common = base.filter(s => codeCount[String(s.code || '')] === blocks.length);
          if (!common.length) { showToast('重算交集为空（源板块构成可能已变化）', 'error'); return; }
          const list = common.map(s => {
            const ns = _newStock(s);
            ns.dailyChange = s.changePercent;
            ns.todayPrice = s.price;
            return ns;
          });
          sector.stocks = list;
          recomputePoolAvg(sector);
          showToast(`已按源板块重算交集：${list.length} 只成分股（${blocks.map(b => b.name).join(' ∩ ')}）`, 'success');
          return;
        }
        const stocks = await StockAPI.getSectorStocks(sector.bk, sector.name);
        if (!stocks.length) {
          const diag = StockAPI.lastSectorDiag ? StockAPI.lastSectorDiag() : '';
          showToast(`未取到「${sector.name}」的成分股${diag ? '｜' + diag : ''}`, 'error');
          return;
        }
        // 转成股票池标准股票对象
        const list = stocks.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        sector.stocks = list;
        recomputePoolAvg(sector);
        showToast(`已加载 ${list.length} 只成分股`, 'success');
      } catch (e) {
        console.warn('成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        sectorLoading.value = false;
      }
    }

    // 刷新板块成分股的行情与财务数据
    async function refreshSectorDetail(sector) {
      // 若尚未获取到成分股，先重新拉取
      if (!sector.stocks || !sector.stocks.length) {
        await loadSectorStocks(sector);
        return;
      }
      await refreshPoolDetail(sector);
    }

    // 详情弹窗打开
    function openSectorDetail(sector) {
      sectorDetail.data = sector;
      sectorDetail.nameEdit = false;
      sectorDetail.nameDraft = sector.name || '';
      sectorDetail.show = true;
      // batch25：切换板块详情时清空「尾盘选股法」的上次结果与标红标记，避免残留到新板块
      if (typeof clearSectorTailBuy === 'function') clearSectorTailBuy();
      // 打开新板块时重置详情内筛选区间（已固定则保留）
      if (!sectorFilter.locked) resetSectorFilter();
      // 【修复】选股页点击子版块后，「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」
      // 六个依赖历史价的字段长期空白。根因：热门板块在 openHotBoard 后会自动 await refreshHotStocks()
      // 补全历史价，而本页 openSectorDetail 仅打开弹窗、不触发任何补全，须用户手动点「刷新行情」。
      // 这里在打开时检测：若成分股尚未补全历史价（yearStartPrice/yearHighPrice/price924 缺失），
      // 自动触发 refreshSectorDetail → refreshPoolDetail 补全，体验与热门板块一致。
      // 已补全过则跳过，避免重复请求触发接口限流。
      if (sector.stocks && sector.stocks.length) {
        const needHist = sector.stocks.some(s =>
          s.yearStartPrice == null || s.yearHighPrice == null || s.price924 == null);
        if (needHist && sector.stocks.length > AUTO_ENRICH_MAX) {
          // batch53：大板块（如「人工智能」751 只、语义结果保存的板块常有数百只）**不自动补全**。
          // 逐只补全要上千次请求 —— 页面会卡死，也等于在打爆免费接口。改为提示用户按需手动刷新。
          showToast(`该板块共 ${sector.stocks.length} 只，已跳过自动补全（避免大量请求）；需要时点「🔄 刷新行情」`, 'info');
        } else if (needHist && autoRefreshPaused()) {
          // 暂停期间不自动补全，避免「打开弹窗」就偷偷发一堆请求；手动「刷新行情」仍可用
          pauseHint('板块详情历史价自动补全');
        } else if (needHist) {
          sectorLoading.value = true;
          refreshSectorDetail(sector)
            .catch(e => console.warn('板块详情历史价自动补全失败', sector.name, e))
            .finally(() => { sectorLoading.value = false; });
        }
      }
    }
    function startEditSectorName() {
      sectorDetail.nameDraft = sectorDetail.data.name || '';
      sectorDetail.nameEdit = true;
    }
    function saveSectorName() {
      sectorDetail.data.name = (sectorDetail.nameDraft || '').trim();
      sectorDetail.nameEdit = false;
      showToast('板块名称已更新', 'success');
    }
    function deleteSectorPool(id) {
      if (!confirm('确认删除该概念选股板块？')) return;
      Store.deleteSectorPool(id);
      showToast('已删除', 'success');
    }

    /** 取板块详情某列的排序值（含计算字段） */
    function sectorVal(s, key) {
      return poolVal(s, key);
    }
    const sortedSectorDetailStocks = computed(() => {
      const list = [...filteredSectorDetailStocks.value];
      const k = sectorDetailSort.key;
      const dir = sectorDetailSort.dir === 'asc' ? 1 : -1;
      if (k === '__idx') {
        const pos = new Map(list.map((s, i) => [s, i]));
        list.sort((a, b) => (pos.get(a) - pos.get(b)) * dir);
      } else {
        list.sort((a, b) => compareForSort(a, b, k) * dir);
      }
      return list;
    });
    /**
     * 板块详情内的独立筛选状态（字段与筛选板块的 filterPanel 一致，
     * 但不含「板块筛选」选择器——详情页本身已锁定在某个板块）。
     */
    const sectorFilter = reactive({
      locked: false,
      pbMin: null, pbMax: null,
      pkMin: null, pkMax: null,
      prMin: null, prMax: null,
      q24Min: null, q24Max: null,
      q24kMin: null, q24kMax: null,
      posMin: null, posMax: null,
      ratioFilter: false,
      industry: '',
      industries: []   // 行业多选勾选（与单选 industry 二选一，勾选优先）
    });
    /** 当前板块详情成分股涉及的全部行业（去重、中文排序），供行业下拉筛选 */
    const sectorDetailIndustries = computed(() => {
      const set = new Set();
      (sectorDetail.data.stocks || []).forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    function resetSectorFilter() {
      if (sectorFilter.locked) {
        showToast('板块详情筛选区间已固定，请先取消固定再重置', 'error');
        return;
      }
      sectorFilter.pbMin = null; sectorFilter.pbMax = null;
      sectorFilter.pkMin = null; sectorFilter.pkMax = null;
      sectorFilter.prMin = null; sectorFilter.prMax = null;
      sectorFilter.q24Min = null; sectorFilter.q24Max = null;
      sectorFilter.q24kMin = null; sectorFilter.q24kMax = null;
      sectorFilter.posMin = null; sectorFilter.posMax = null;
      sectorFilter.ratioFilter = false; sectorFilter.industry = ''; sectorFilter.industries = [];
      sectorFilter.bizKeyword = '';
    }
    function toggleSectorFilterLock() {
      sectorFilter.locked = !sectorFilter.locked;
      showToast(sectorFilter.locked ? '已固定板块详情筛选区间，切换板块/重置将保留' : '已取消固定板块详情筛选区间',
        sectorFilter.locked ? 'success' : 'info');
    }
    /**
     * 板块详情：按筛选栏里的「产品业务」计算每只成分股的相关度（营收占比之和）与主营业务。
     * 计算前会补全行情（现价/涨跌幅/总市值）与主营构成，口径与「筛选板块 → 刷新行情」一致。
     */
    async function computeSectorDetailRelevance() {
      const stocks = (sectorDetail.data && sectorDetail.data.stocks) || [];
      if (!stocks.length) { showToast('当前板块还没有成分股', 'error'); return; }
      if (!bizKeywords(sectorFilter.bizKeyword).length) { showToast('请先输入用于计算相关度的产品业务', 'error'); return; }
      if (sectorFilter.bizLoading) return;
      sectorFilter.bizLoading = true;
      showToast('正在按主营构成计算相关度…', 'info');
      try {
        const r = await applyBizRelevance(stocks, sectorFilter.bizKeyword, (done, total) => {
          if (done % 10 === 0 || done === total) showToast(`正在补全主营构成 ${done}/${total}…`, 'info');
        });
        if (!r.ok) { showToast(r.error, 'error'); return; }
        const sector = D.sectorPools.find(p => p.id === (sectorDetail.data && sectorDetail.data.id));
        if (sector) recomputePoolAvg(sector);
        Store.saveNow();
        showToast(`相关度已更新：${r.total} 只中命中 ${r.hit} 只（按相关度可点表头排序）`, 'success');
      } catch (e) {
        console.warn('计算相关度失败', e);
        showToast('计算相关度失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        sectorFilter.bizLoading = false;
      }
    }
    /** 板块详情内按筛选条件过滤后的成分股 */
    const filteredSectorDetailStocks = computed(() => {
      return (sectorDetail.data.stocks || []).filter(s => passFilter(s, sectorFilter));
    });
    function sortSectorDetailBy(key) {
      if (sectorDetailSort.key === key) {
        sectorDetailSort.dir = sectorDetailSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sectorDetailSort.key = key;
        sectorDetailSort.dir = 'desc';
      }
    }
    function sectorSortIcon(key) {
      if (sectorDetailSort.key !== key) return '⇅';
      return sectorDetailSort.dir === 'asc' ? '↑' : '↓';
    }
    // 板块详情内删除个股（复用股票池删除逻辑）
    function removeSectorStock(code) {
      const sec = sectorDetail.data;
      const idx = (sec.stocks || []).findIndex(s => s.code === code);
      if (idx === -1) return;
      const name = sec.stocks[idx].name || code;
      if (!confirm(`确认从板块中删除「${name}」？`)) return;
      sec.stocks.splice(idx, 1);
      recomputePoolAvg(sec);
      showToast('已删除', 'success');
    }

    // ============================================================
    //  个股搜索添加（三处入口共用同一套逻辑）
    //    · sector：点击「我的概念选股板块」卡片 → 板块详情弹窗「字段含义」左侧
    //    · hot   ：热门板块页「当日股票明细」工具栏「字段含义」左侧
    //    · filter：筛选板块页工具栏「字段含义」左侧
    //  支持：直接输代码（600519 / sh600519）、输入名称联想搜索后点击添加、
    //        多只用逗号/分号/换行分隔；自动去重、自动补名称与当日行情。
    // ============================================================
    const MAX_SUGGESTED_STOCKS = 30;   // 单个板块建议上限（服务器资源有限）
    const quickAdd = reactive({
      sector: { text: '', loading: false, suggestions: [], open: false, timer: null },
      hot: { text: '', loading: false, suggestions: [], open: false, timer: null },
      filter: { text: '', loading: false, suggestions: [], open: false, timer: null }
    });

    /** 该入口当前要往哪个列表里加股票（热门明细与筛选板块都作用于「当前选中的来源」） */
    function quickAddTarget(scope) {
      if (scope === 'sector') return sectorDetail.data.stocks || [];
      const id = filterPanel.poolId;
      // 没选任何来源（例如刚进热门板块页、还没点板块）时返回 null，
      // 由调用方提示「请先选择板块」——否则会把股票加进一个当前不显示的列表里，用户以为没反应。
      if (!id) return null;
      if (id === 'hot') return hotFilterStocks.value || [];
      if (id.startsWith('s-')) {
        const sp = (D.sectorPools || []).find(p => 's-' + p.id === id);
        return sp ? (sp.stocks || []) : null;
      }
      if (id.startsWith('p-')) {
        const pp = (D.stockPools || []).find(p => 'p-' + p.id === id);
        return pp ? (pp.stocks || []) : null;
      }
      return null;
    }
    /** 该入口对应的「板块对象」（用于重算平均涨跌幅；热门板块成分股列表无归属对象，返回 null） */
    function quickAddTargetPool(scope) {
      if (scope === 'sector') return sectorDetail.data;
      const id = filterPanel.poolId;
      if (!id || id === 'hot') return null;
      if (id.startsWith('s-')) return (D.sectorPools || []).find(p => 's-' + p.id === id) || null;
      if (id.startsWith('p-')) return (D.stockPools || []).find(p => 'p-' + p.id === id) || null;
      return null;
    }
    /** 输入变化：代码直接留白，名称走腾讯联想（用户主动操作，不受「暂停刷新」影响） */
    function quickAddSearch(scope) {
      const st = quickAdd[scope];
      clearTimeout(st.timer);
      const kw = String(st.text || '').trim();
      if (!kw || /^(sh|sz|bj)?\d{4,8}$/i.test(kw)) {
        st.suggestions = []; st.open = false; return;
      }
      st.timer = setTimeout(async () => {
        try {
          const hints = await StockAPI.searchStocks(kw);
          st.suggestions = (hints || []).slice(0, 6);
        } catch (e) {
          st.suggestions = [];
        }
        st.open = st.suggestions.length > 0;
      }, 260);
    }
    function quickAddBlur(scope) {
      const st = quickAdd[scope];
      setTimeout(() => { st.open = false; }, 260);
    }
    /** 点击联想项 → 直接加入 */
    function quickAddPick(scope, item) {
      const st = quickAdd[scope];
      if (!item) return;
      st.open = false;
      st.text = '';
      quickAddCommit(scope, [{ code: item.code, name: item.name }]);
    }
    /** 真正写入列表（去重 + 补行情 + 重算平均涨跌幅） */
    async function quickAddCommit(scope, parsed) {
      const st = quickAdd[scope];
      const target = quickAddTarget(scope);
      if (!target) { showToast('请先选择板块（或先点击一个热门板块）再添加个股', 'error'); return; }
      const existing = new Set(target.map(s => s.code));
      const news = [];
      for (const p of (parsed || [])) {
        if (!p || !p.code || existing.has(p.code)) continue;
        news.push(_newStock({ code: p.code, name: p.name || '' }));
        existing.add(p.code);
      }
      if (!news.length) { showToast('未识别到新股票（输入为空或已在列表中）', 'info'); return; }
      st.loading = true;
      try {
        const quotes = await StockAPI.getQuotes(news.map(s => s.code));
        news.forEach(s => {
          const q = quotes[s.code];
          if (!q) return;
          s.name = s.name || q.name || '';
          if (q.changePercent != null) s.dailyChange = q.changePercent;
          if (q.amplitude != null) s.amplitude = q.amplitude;
          if (q.turnover != null) s.turnover = q.turnover;
          if (q.price != null) s.todayPrice = q.price;
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
        });
      } catch (e) {
        console.warn('添加个股时行情获取失败', e);
      }
      target.push(...news);
      const pool = quickAddTargetPool(scope);
      if (pool) recomputePoolAvg(pool);
      st.text = ''; st.suggestions = []; st.open = false;
      st.loading = false;
      if (target.length > MAX_SUGGESTED_STOCKS) {
        showToast(`已添加 ${news.length} 只；该板块现有 ${target.length} 只，建议不超过 ${MAX_SUGGESTED_STOCKS} 只（服务器资源有限）`, 'info');
      } else {
        showToast(`已添加 ${news.length} 只股票`, 'success');
      }
    }
    /** 回车 / 点「＋ 添加」：解析输入，名称走联想接口解析成代码后再写入 */
    async function quickAddSubmit(scope) {
      const st = quickAdd[scope];
      const txt = String(st.text || '').trim();
      if (!txt) { showToast('请输入股票代码或名称', 'error'); return; }
      if (!quickAddTarget(scope)) { showToast('请先选择板块（或先点击一个热门板块）再添加个股', 'error'); return; }
      const parsed = StockAPI.parseStockInput(txt);
      if (!parsed.length) { showToast('未识别到有效股票', 'error'); return; }
      const needResolve = parsed.filter(p => !p.code);
      if (needResolve.length) {
        showToast(`正在按名称匹配「${needResolve.map(p => p.name).join('、')}」...`, 'info');
        // 复用统一的名称反查：本机字典 → 全A名单 → 联网联想，比逐只串行快得多
        const failed = await StockAPI.resolveStockNames(parsed);
        const good = parsed.filter(p => p.code);
        if (!good.length) {
          showToast(`未找到股票「${needResolve.map(p => p.name).join('、')}」，请检查名称或直接输入代码`, 'error');
          return;
        }
        if (failed.length) showToast(`部分名称未识别：${failed.map(p => p.name).join('、')}`, 'error');
        await quickAddCommit(scope, good);
        return;
      }
      await quickAddCommit(scope, parsed);
    }

    // ============================================================
    //  页面3：热门板块
    // ============================================================
    const hotDate = ref(Store.today());
    const hotLoading = ref(false);
    const hotBoards = ref([]);
    const hotStocks = ref([]);
    const newListedStocks = ref([]);
    const preMarketBoards = ref([]);
    const amplitudeBoards = ref([]);
    const ampLoading = ref(false);
    const hotPanelsHidden = ref(false);
    const financePushHidden = ref(false);
    const hotSort = reactive({ key: 'dailyChange', dir: 'desc' });
    // 全球信息页：火热话题（10 个金融软件热门消息）+ 格隆汇每日快讯分类统计
    const hotTopicsSources = ref([]);
    const hotTopicsMerged = ref([]);
    const hotTopicsLoading = ref(false);
    const hotTopicsUpdated = ref('');

    // ===== 格隆汇每日快讯（「全球信息」页右栏：13 分类统计 + 日期 + 关键词搜索）=====
    const briefDates = ref([]);        // 有快讯数据的日期（来自仓库 index.json 的 briefsDates）
    const briefDate = ref('');         // 当前查看日期
    const briefItems = ref([]);        // 当日全部快讯
    // 闭市周期刷新（日期字段右侧的独立按钮）：
    // 窗口 = [最近一个已过去的 15:00, 现在]，即按股票收盘时刻切分，而不是按自然日。
    const briefWindowItems = ref([]);  // 窗口内的快讯（跨天合并、按时间倒序）
    const briefWindow = reactive({ on: false, start: '', end: '' });
    /* batch16：可编辑的统计时间窗口（三板块统一口径，默认「昨天 15:00 → 现在」）。
     * 以前闭市周期是写死计算的，用户没法改；现在起止都能改，改完点刷新即时重算。 */
    const briefWinStart = ref('');
    const briefWinEnd = ref('');
    function ht_() { return (typeof HotTopics !== 'undefined') ? HotTopics : null; }
    function resetBriefWin() {
      const HT = ht_();
      if (!HT || !HT.defaultWindowStart) return;
      briefWinStart.value = HT.toLocalInputValue(HT.defaultWindowStart());
      briefWinEnd.value = HT.toLocalInputValue(HT.defaultWindowEnd());
    }
    resetBriefWin();
    /** 时间栏文案：'2026年9月16日 15:00 - 2026年9月17日 15:00' */
    const briefWinText = computed(() => {
      const HT = ht_();
      if (!HT || !HT.fromLocalInputValue || !HT.fmtWindowCN) return '';
      const s = HT.fromLocalInputValue(briefWinStart.value);
      const e = HT.fromLocalInputValue(briefWinEnd.value);
      if (!s || !e) return '';
      return HT.fmtWindowCN(s.getTime()) + ' - ' + HT.fmtWindowCN(e.getTime());
    });
    const briefKeyword = ref('');      // 关键词
    const briefLoading = ref(false);
    const briefError = ref('');
    const briefPaused = ref(false);    // 顶部「暂停」生效时不自动去读快讯文件，改为按钮手动加载
    const briefUi = reactive({ open: {}, limit: {} });   // 展开状态与「展开更多」条数（与统计解耦，重算不丢）
    let _briefLoaded = false;          // 已初始化过就不再自动请求（避免每次切页都拉）

    // ===== 快讯来源名（batch15：界面上可改，下拉选预设或自己写）=====
    const BRIEF_SOURCE_PRESETS = ['格隆汇', '今日头条', '财联社', '东方财富', '同花顺', '新浪财经', '路透社', '彭博', '华尔街见闻', '金十数据'];
    const briefSourceName = ref('格隆汇');
    const briefSourceInput = ref('格隆汇');
    const briefSourceCustom = ref(false);
    const briefSourcePresets = BRIEF_SOURCE_PRESETS;

    // ===== 快讯分类维度（batch15）：题材归类 / 概念分类 / 行业分类 =====
    const briefDimModes = (typeof HotTopics !== 'undefined' && Array.isArray(HotTopics.BRIEF_MODES))
      ? HotTopics.BRIEF_MODES.map(m => ({ key: m.key, name: m.name }))
      : [{ key: 'theme', name: '题材归类' }];
    const briefDimMode = ref('theme');

    /** 从设置里恢复来源名与分类维度（设置项缺省时给默认值，老数据不受影响） */
    function initBriefPrefs() {
      const s = D.settings || {};
      const src = (typeof s.briefSource === 'string' && s.briefSource.trim()) ? s.briefSource.trim() : '格隆汇';
      briefSourceName.value = src;
      briefSourceInput.value = src;
      briefSourceCustom.value = BRIEF_SOURCE_PRESETS.indexOf(src) < 0;
      const mode = String(s.briefDimMode || '');
      if (briefDimModes.some(m => m.key === mode)) briefDimMode.value = mode;
    }
    initBriefPrefs();

    /** 写入来源名：立即落盘，标题/原文链接文案/前缀剥离都跟着这个名字走 */
    function setBriefSource(name) {
      const n = String(name || '').trim() || '格隆汇';
      briefSourceName.value = n;
      briefSourceInput.value = n;
      briefSourceCustom.value = BRIEF_SOURCE_PRESETS.indexOf(n) < 0;
      D.settings.briefSource = n;
      Store.saveNow();
    }
    function onBriefSourcePick(v) {
      if (v === '__custom__') {
        briefSourceCustom.value = true;
        nextTick(() => {
          const el = document.querySelector('.brief-source-input');
          if (el) { el.focus(); el.select(); }
        });
        return;
      }
      setBriefSource(v);
      showToast('快讯来源已改为「' + v + '」', 'success');
      if (briefDate.value) loadBriefs(briefDate.value, v);   // 切换来源立即加载对应平台数据
    }
    function commitBriefSource() {
      setBriefSource(briefSourceInput.value);
      showToast('快讯来源已改为「' + briefSourceName.value + '」', 'success');
      if (briefDate.value) loadBriefs(briefDate.value, briefSourceName.value);
    }
    /** 切换分类维度：换维度后原展开项已不属于当前维度，收起更干净 */
    function setBriefDim(mode) {
      if (briefDimMode.value === mode) return;
      briefDimMode.value = mode;
      D.settings.briefDimMode = mode;
      Object.keys(briefUi.open).forEach(k => { briefUi.open[k] = false; });
      Store.saveNow();
    }
    const briefDimLabel = computed(() => {
      const m = briefDimModes.filter(x => x.key === briefDimMode.value)[0];
      return m ? m.name : '题材归类';
    });
    // 火热话题：每日话题 / 统计分析
    const htTab = ref('daily');                 // 'daily' | 'analysis'
    const htMode = ref('live');                 // 'live' | 'history'
    // 点「实时」但实时增强源（代理）不可达时的常驻说明（非错误，仅为解释当前展示的是快照）
    const htLiveNote = ref('');
    const hotTopicDate = ref(fmtDate(new Date()));
    const hotTopicDateHasData = ref(false);
    const htCatFilter = ref('');
    const htCategories = (typeof HotTopics !== 'undefined') ? HotTopics.CATEGORIES : [];
    /* 请求R：原「1天内」改为「时段」——选中时严格统计上方「新闻统计开始时间」起止区间内的新闻；
     * 其余选项仍是「近 N 天」整日纳入（不套窗口）。 */
    const htRangeOptions = [
      { key: 'win', label: '时段', days: 1 },
      { key: '3d', label: '3天内', days: 3 },
      { key: '5d', label: '5天内', days: 5 },
      { key: '10d', label: '10天内', days: 10 },
      { key: '1m', label: '一月内', days: 30 }
    ];
    const analysisRange = ref('win');
    const analysisLoading = ref(false);
    const analysisResult = ref(null);
    /* 请求S：各站分类统计的「分类维度」。默认「概念」——用户要求按概念归类，而不是财经/科技这类 7 大类。
     * 可切到 行业/产品/产业/科技，也可切回原来的 7 大类。切换时用已有扁平数据即时重算，不重新拉快照。 */
    const siteCatDimOptions = [
      { key: 'concept', name: '概念', icon: '💡', color: '#e63525' },
      { key: 'industry', name: '行业', icon: '🏭', color: '#2563eb' },
      { key: 'product', name: '产品', icon: '📦', color: '#0a7d3e' },
      { key: 'chain', name: '产业', icon: '⛓️', color: '#b45309' },
      { key: 'tech', name: '科技', icon: '🔬', color: '#7c3aed' },
      { key: 'cat7', name: '7大类', icon: '🗂️', color: '#6b7280' }
    ];
    const siteStatsDim = ref('concept');
    const siteStatModal = reactive({
      show: false, siteName: '', siteRank: 0, topic: '', dimName: '', color: '#e63525', items: []
    });
    let _analysisFlat = [];   // 最近一次统计的扁平数据（不进响应式，避免大数组的代理开销）
    /* batch16：统计分析（跨站重合榜 / 主题分类统计）的统计时间窗口。
     * 与快讯板块同口径：以每天 15:00 换日，默认「昨天 15:00 → 现在」，可改。 */
    const analysisWinStart = ref('');
    const analysisWinEnd = ref('');
    function resetAnalysisWin() {
      const HT = ht_();
      if (!HT || !HT.defaultWindowStart) return;
      analysisWinStart.value = HT.toLocalInputValue(HT.defaultWindowStart());
      analysisWinEnd.value = HT.toLocalInputValue(HT.defaultWindowEnd());
    }
    resetAnalysisWin();
    const analysisWinText = computed(() => {
      const HT = ht_();
      if (!HT || !HT.fromLocalInputValue || !HT.fmtWindowCN) return '';
      const s = HT.fromLocalInputValue(analysisWinStart.value);
      const e = HT.fromLocalInputValue(analysisWinEnd.value);
      if (!s || !e) return '';
      return HT.fmtWindowCN(s.getTime()) + ' - ' + HT.fmtWindowCN(e.getTime());
    });

    /** 请求S：当前「各站分类统计」维度的名称与配色（供模板直接取用） */
    const scDimName = computed(() => {
      const o = siteCatDimOptions.find(x => x.key === siteStatsDim.value);
      return o ? o.name : '概念';
    });
    const scDimColor = computed(() => {
      const o = siteCatDimOptions.find(x => x.key === siteStatsDim.value);
      return o ? o.color : '#e63525';
    });

    /* batch22：每日话题（「每日话题」页签）改用「统计时间段」模式（与快讯 / 统计分析同口径）：
     * 以每天 15:00 换日，起止可改；刷新加载该时间段内跨天合并的火热话题（按源聚合、按窗口时间戳精筛）。 */
    const dailyWinStart = ref('');
    const dailyWinEnd = ref('');
    let _hotTopicsLoaded = false;
    function resetDailyWin() {
      const HT = ht_();
      if (!HT || !HT.defaultWindowStart) return;
      dailyWinStart.value = HT.toLocalInputValue(HT.defaultWindowStart());
      dailyWinEnd.value = HT.toLocalInputValue(HT.defaultWindowEnd());
    }
    resetDailyWin();
    const dailyWinText = computed(() => {
      const HT = ht_();
      if (!HT || !HT.fromLocalInputValue || !HT.fmtWindowCN) return '';
      const s = HT.fromLocalInputValue(dailyWinStart.value);
      const e = HT.fromLocalInputValue(dailyWinEnd.value);
      if (!s || !e) return '';
      return HT.fmtWindowCN(s.getTime()) + ' - ' + HT.fmtWindowCN(e.getTime());
    });

    function catColor(c) {
      // batch32：历史快照里可能还存着旧分类名（如「世界500强领导者动态」），先归一化再取色
      const HT = (typeof HotTopics !== 'undefined') ? HotTopics : null;
      if (!HT) return '#6b7280';
      const key = HT.normalizeCategory ? HT.normalizeCategory(c) : String(c || '');
      return HT.CATEGORY_COLORS[key] || '#6b7280';
    }
    /** batch32：分类标签显示名。历史快照里的旧分类名（如「世界500强领导者动态」）统一显示成新名，
     *  否则同一份列表里新旧两个名字并存，看起来像改名没生效。只影响显示，不动数据。 */
    function catLabel(c) {
      const HT = (typeof HotTopics !== 'undefined') ? HotTopics : null;
      return (HT && HT.normalizeCategory) ? HT.normalizeCategory(c) : String(c || '');
    }
    function htSourceByRank(rank) {
      const list = (typeof HotTopics !== 'undefined' && HotTopics.SOURCE_ORDER) || [];
      return list.find(s => s.rank === rank) || { name: String(rank), color: '#888' };
    }
    function htSourceColor(rank) { return htSourceByRank(rank).color; }
    function htSourceName(rank) { return htSourceByRank(rank).name; }
    function ratioClass(n) { return n >= 8 ? 'hot' : (n >= 4 ? 'warm' : ''); }
    function fmtDate(d) {
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    function dateMinusDays(dateStr, n) {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() - n);
      return fmtDate(d);
    }
    const filteredHotSources = computed(() => {
      const list = hotTopicsSources.value || [];
      if (!htCatFilter.value) return list.map(s => ({ ...s, filteredItems: s.items, filteredCount: s.items.length }));
      // batch32：条目可能带旧分类名，比较前先归一化，否则改名后老数据筛不出来
      const HT = (typeof HotTopics !== 'undefined') ? HotTopics : null;
      const norm = c => (HT && HT.normalizeCategory) ? HT.normalizeCategory(c) : String(c || '');
      return list.map(s => {
        const fi = (s.items || []).filter(it => norm(it.cat) === htCatFilter.value);
        return { ...s, filteredItems: fi, filteredCount: fi.length };
      });
    });
    // 点击热门板块 4 个子版块后，成分股同时载入下方「筛选板块」列表（与 filterPanel.poolId='hot' 联动）
    const hotFilterStocks = ref([]);

    // 概念频次（从当日新闻统计）
    const conceptFreq = computed(() => {
      const list = D.news.filter(n => n.date === hotDate.value && n.conceptCategory);
      const map = {};
      for (const n of list) {
        // 概念分类可能含多个，按顿号/逗号分割
        const cats = n.conceptCategory.split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
        for (const c of cats) map[c] = (map[c] || 0) + 1;
      }
      const arr = Object.entries(map).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      const max = arr.length ? arr[0].count : 1;
      arr.forEach(c => { c.width = Math.max(8, (c.count / max) * 100); });
      return arr;
    });

    // 当日股票表（从当日新闻关联股票汇总，或手动加载）
    function loadHotData() {
      const daily = Store.getDailyStocks(hotDate.value);
      // 若该日无数据，自动从当日新闻关联股票生成
      if (!daily.stocks.length) {
        const dayNews = D.news.filter(n => n.date === hotDate.value);
        const stockMap = {};
        for (const n of dayNews) {
          const stocks = parseStocks(n.relatedStocks);
          for (const s of stocks) {
            if (s.code && !stockMap[s.code]) {
              stockMap[s.code] = { code: s.code, name: s.name, amplitude: null, dailyChange: null, news: n.content, category: n.category };
            }
          }
        }
        daily.stocks = Object.values(stockMap);
      }
      showToast(`已加载 ${hotDate.value} 的 ${daily.stocks.length} 只股票`, 'success');
      refreshHotStocks();
    }

    const sortedHotStocks = computed(() => {
      const daily = D.dailyData[hotDate.value];
      let list = daily ? [...daily.stocks] : [];
      // 股票查询：按代码 / 名称关键字过滤（两者同时填写时取交集）
      const codeQ = String(hotSearchCode.value || '').trim().toLowerCase();
      const nameQ = String(hotSearchName.value || '').trim().toLowerCase();
      if (codeQ) list = list.filter(s => String(s.code || '').toLowerCase().indexOf(codeQ) >= 0);
      if (nameQ) list = list.filter(s => String(s.name || '').toLowerCase().indexOf(nameQ) >= 0);
      const k = hotSort.key;
      const dir = hotSort.dir === 'asc' ? 1 : -1;
      if (k === '__idx') {
        // 序号排序：按当前列表原始次序升序（还原）/ 降序（倒序），不依赖股票自身字段
        const pos = new Map(list.map((s, i) => [s, i]));
        list.sort((a, b) => (pos.get(a) - pos.get(b)) * dir);
      } else {
      list.sort((a, b) => {
        const va = parseFloat(a[k]); const vb = parseFloat(b[k]);
        if (isNaN(va) && isNaN(vb)) return 0;
        if (isNaN(va)) return 1;
        if (isNaN(vb)) return -1;
        return (va - vb) * dir;
      });
      }
      return list;
    });
    /** batch55：新闻追踪页「当日股票明细」数据源——子类激活时显示其成分股（独立状态），否则沿用热门板块点击载入的股票 */
    const dailyStockRows = computed(() => briefCatActive.value ? (briefCatStocks.value || []) : sortedHotStocks.value);
    function sortHotBy(key) {
      if (hotSort.key === key) {
        hotSort.dir = hotSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        hotSort.key = key;
        hotSort.dir = 'desc';
      }
    }
    function hotSortIcon(key) {
      if (hotSort.key !== key) return '⇅';
      return hotSort.dir === 'asc' ? '↑' : '↓';
    }

    function removeHotStock(code) {
      const daily = D.dailyData[hotDate.value];
      if (daily) {
        daily.stocks = daily.stocks.filter(s => s.code !== code);
        showToast('已移除', 'success');
      }
    }

    // ===== 火热话题本地快照（替代 GitHub Action 的自动历史积累）=====
    const HT_SNAPSHOT_KEEP_DAYS = 60;
    /** 读取某日本地快照 */
    function getLocalHotTopicSnapshot(date) {
      const m = Store.data && Store.data.hotTopicSnapshots;
      return (m && m[date]) || null;
    }
    /** 保存当日本地快照（实时抓取成功后调用；随 localStorage 持久化与云端同步） */
    function saveLocalHotTopicSnapshot(sources) {
      if (!sources || !sources.length) return;
      if (!Store.data.hotTopicSnapshots) Store.data.hotTopicSnapshots = {};
      const slim = sources.map(s => ({
        rank: s.rank, key: s.key, name: s.name, color: s.color,
        items: (s.items || []).map(it => ({ text: it.text, time: it.time, url: it.url, cat: it.cat }))
      }));
      if (!slim.some(s => s.items.length)) return; // 全空则不覆盖已有快照
      const date = fmtDate(new Date());
      Store.data.hotTopicSnapshots[date] = { date, generatedAt: new Date().toISOString(), sources: slim };
      // 仅保留最近 N 天，避免数据过大
      const keys = Object.keys(Store.data.hotTopicSnapshots).sort();
      while (keys.length > HT_SNAPSHOT_KEEP_DAYS) {
        delete Store.data.hotTopicSnapshots[keys.shift()];
      }
    }
    /** 本地快照已有日期（降序） */
    const localSnapshotDates = computed(() => {
      const m = (Store.data && Store.data.hotTopicSnapshots) || {};
      return Object.keys(m).sort().reverse();
    });

    /** 从各源重建「综合最火」合并列表（按时间降序） */
    function buildMergedList(srcs) {
      const m = [];
      for (const s of (srcs || [])) for (const it of (s.items || [])) m.push({ ...it, source: s.name, color: s.color, sourceRank: s.rank });
      m.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
      return m.slice(0, 20);
    }

    /**
     * 读取「仓库内置的最新可用快照」（同源，GitHub Pages 直出，不依赖任何代理）。
     * 先读清单 data/hot-topics/index.json 定位最新日期，读不到则从今天起向前回溯。
     */
    async function loadLatestRepoSnapshot() {
      const today = fmtDate(new Date());
      let manifest = null;
      try {
        const r = await fetch('./data/hot-topics/index.json', { cache: 'no-store' });
        if (r.ok) manifest = await r.json();
      } catch (e) { /* 忽略，走回溯 */ }
      const dates = (typeof HotTopics !== 'undefined' && HotTopics.snapshotCandidates)
        ? HotTopics.snapshotCandidates(manifest, today, 14)
        : [today];
      for (const d of dates) {
        try {
          const r = await fetch(`./data/hot-topics/${d}.json`, { cache: 'no-store' });
          if (!r.ok) continue;
          const snap = await r.json();
          const srcs = (snap.sources || []).map(s => ({
            ...s, loading: false,
            items: s.items || [],
            error: (s.items && s.items.length) ? null : '该源暂无数据'
          }));
          if (!srcs.some(s => s.items.length)) continue; // 全空快照跳过
          return { date: d, generatedAt: snap.generatedAt || '', sources: srcs };
        } catch (e) { /* 继续回溯前一天 */ }
      }
      return null;
    }

    // 全球信息页：刷新「火热话题」+「格隆汇每日快讯」
    // 设计要点（合规免费）：
    //   主路径 = 仓库内置最新快照（GitHub Action 每 2 小时服务端自动抓取，同源 GitHub Pages 直出，无需任何代理）。
    //   代理（Cloudflare Worker）仅作为"可选实时增强"——配了且可用才叠加真·实时；不可达不再阻断展示，
    //   而是友好提示并保留已加载的快照。这样即便 workers.dev 在国内被拦截，刷新按钮也能稳定给出最新榜单。
    async function refreshHotTopics() {
      const proxies = String(D.settings.proxyUrl || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      hotTopicsLoading.value = true;
      let usedSnapshot = false;
      try {
        // 1) 始终先加载仓库内置最新快照（同源、无需代理、合规免费）
        const fb = await loadLatestRepoSnapshot();
        if (fb) {
          hotTopicsSources.value = fb.sources;
          hotTopicsMerged.value = buildMergedList(fb.sources);
          hotTopicDate.value = fb.date;
          hotTopicDateHasData.value = true;
          const when = fb.generatedAt ? new Date(fb.generatedAt).toLocaleString('zh-CN', { hour12: false }) : fb.date;
          hotTopicsUpdated.value = `${when}（自动抓取快照 ${fb.date}）`;
          htMode.value = 'history';
          usedSnapshot = true;
        }

        // 2) 配置了代理 → 尝试真·实时叠加；全部失败则保留快照
        if (proxies.length) {
          for (const p of proxies) {
            const ht = await StockAPI.fetchHotTopics(p);
            if (ht.sources && ht.sources.some(s => s.items.length)) {
              hotTopicsSources.value = ht.sources;
              hotTopicsMerged.value = ht.merged || [];
              saveLocalHotTopicSnapshot(ht.sources);
              hotTopicsUpdated.value = new Date().toLocaleString('zh-CN', { hour12: false }) + '（实时）';
              htMode.value = 'live';
              htLiveNote.value = '';
              showToast(`已更新为最新实时抓取（${ht.sources.filter(s => s.items.length).length} 个来源）`, 'success');
              return;
            }
          }
          if (usedSnapshot) {
            // 这是**正常回退**而非故障：主路径本来就是「服务端每 2 小时自动抓取的快照」，
            // 代理只是可选的真·实时增强。文案不写「不可用/失败」，避免被误读成功能坏了。
            htMode.value = 'history';
            htLiveNote.value = `实时增强源（代理）当前未连通，已展示最新自动抓取快照（${fb.date}，2 小时内自动更新）。`
              + '国内 *.workers.dev 常被拦截，可在「设置 → 新闻代理地址」换成自有域名；不配置也不影响使用。';
            showToast(`已展示最新自动抓取快照（${fb.date}）· 实时增强源（代理）未连通，不影响使用`, 'info');
          } else {
            htLiveNote.value = '';
            showToast('实时抓取不可用，且暂无可展示的快照；请检查代理地址或稍后重试', 'error');
          }
          return;
        }

        // 3) 未配置代理：快照即最终结果（合规免费，每 2 小时自动更新）
        if (usedSnapshot) {
          htLiveNote.value = '';
          showToast(`已加载最新自动抓取快照（${fb.date}，每 2 小时自动更新）`, 'success');
        } else {
          hotTopicsSources.value = (typeof HotTopics !== 'undefined' ? HotTopics.SOURCE_ORDER : [])
            .map(s => ({ ...s, items: [], loading: false, error: null }));
          htLiveNote.value = '';
          showToast('暂无可展示的快照；请稍后重试或配置代理', 'error');
        }
      } catch (e) {
        showToast('火热话题刷新失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        hotTopicsLoading.value = false;
      }
    }

    /**
     * 每日话题（时间段模式）：加载该时间段内跨天合并的火热话题。
     * 与统计分析同口径（15:00 换日、起止可改）：按窗口覆盖的日期逐个读快照，
     * 按源聚合、按条目时间戳精筛落在区间内的新闻，最后按源展示（每个源区间内按时间倒序）。
     * 未配置代理时纯读同源仓库快照；不依赖任何实时增强，合规免费。
     */
    async function refreshDailyTopics() {
      const HT = ht_();
      const ws = HT && HT.fromLocalInputValue ? HT.fromLocalInputValue(dailyWinStart.value) : null;
      const we = HT && HT.fromLocalInputValue ? HT.fromLocalInputValue(dailyWinEnd.value) : null;
      if (!ws || !we || ws.getTime() >= we.getTime()) {
        showToast('请先填写完整的统计开始时间与结束时间，且开始必须早于结束', 'error');
        return;
      }
      hotTopicsLoading.value = true;
      try {
        const dates = HT.windowSnapshotDates(ws.getTime(), we.getTime());
        const bySource = new Map();
        let dayCount = 0;
        for (const d of dates) {
          const local = getLocalHotTopicSnapshot(d);
          let snap = local;
          if (!snap) {
            try {
              const r = await fetch(`./data/hot-topics/${d}.json`, { cache: 'no-store' });
              if (!r.ok) continue;
              snap = await r.json();
            } catch (e) { continue; }
          }
          if (!snap || !snap.sources) continue;
          dayCount++;
          for (const s of snap.sources) {
            if (!bySource.has(s.rank)) bySource.set(s.rank, { rank: s.rank, key: s.key, name: s.name, color: s.color, items: [] });
            const items = (s.items || []).filter(it => {
              if (it.time && HT.parseBriefTime && HT.inWindow) {
                const ts = HT.parseBriefTime(it.time);
                if (ts != null && !HT.inWindow(ts, ws.getTime(), we.getTime())) return false;
              }
              return true;
            });
            bySource.get(s.rank).items.push(...items);
          }
        }
        const list = [...bySource.values()].sort((a, b) => a.rank - b.rank);
        list.forEach(s => {
          s.items.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
          s.loading = false;
          s.error = s.items.length ? null : '该时间段内无数据';
        });
        hotTopicsSources.value = list;
        hotTopicsMerged.value = buildMergedList(list);
        const startStr = HT.fmtWindowCN(ws.getTime());
        const endStr = HT.fmtWindowCN(we.getTime());
        hotTopicsUpdated.value = `${startStr} - ${endStr}（覆盖 ${dayCount} 天，按时间段合并）`;
        _hotTopicsLoaded = true;
        const total = list.reduce((n, s) => n + s.items.length, 0);
        if (!total) showToast(`时间段（${startStr} - ${endStr}）内没有火热话题数据`, 'info');
        else showToast(`已加载 ${startStr} - ${endStr} 的火热话题（${total} 条）`, 'success');
      } catch (e) {
        showToast('每日话题刷新失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        hotTopicsLoading.value = false;
      }
    }

    /**
     * 进入「全球信息」页时自动加载（幂等）。
     * 顺序：本地快照 → 仓库内置最新快照（同源，不依赖代理）→ 已配代理才实时抓取。
     */
    // ===== 格隆汇每日快讯：日期清单 / 加载 / 分类展开 / 关键词高亮 =====
    /** 首次进入「全球信息」页时按需加载。
     *  只读同源静态快照做展示；但顶部「暂停」开关生效时，遵循既有约定「不发起任何自动请求」，
     *  改为在面板里给出「点击加载」按钮，由用户主动触发（主动点击不算自动刷新）。 */
    async function autoLoadBriefs() {
      if (_briefLoaded) return;
      if (autoRefreshPaused()) { briefPaused.value = true; return; }
      await loadBriefsNow();
    }
    /** 用户主动加载该日快讯（暂停状态下也可用） */
    async function loadBriefsNow() {
      _briefLoaded = true;
      briefPaused.value = false;
      await loadBriefDates();
      if (briefDate.value) await loadBriefs(briefDate.value, briefSourceName.value);
    }
    async function loadBriefDates() {
      try {
        const r = await fetch('./data/hot-topics/index.json', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const list = (j && Array.isArray(j.briefsDates))
          ? j.briefsDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
        briefDates.value = list;
        if (!list.length) { briefError.value = '服务端尚未生成快讯数据（定时任务每 2 小时抓取一次）'; return; }
        if (!briefDate.value || list.indexOf(briefDate.value) < 0) briefDate.value = list[0];
      } catch (e) {
        briefError.value = '快讯日期清单加载失败：' + (e && e.message ? e.message : e);
      }
    }
    /** 按来源选择快讯数据文件：格隆汇沿用历史遗留文件名 briefs-日期.json；
     *  其它来源（今日头条 / 财联社 …）各自独立成文件 briefs-来源-日期.json，
     *  这样切换来源真正加载对应平台的数据，而不是永远显示格隆汇。 */
    function briefFileForSource(source, date) {
      const s = String(source || '').trim();
      if (!s || s === '格隆汇') return `./data/hot-topics/briefs-${date}.json`;
      return `./data/hot-topics/briefs-${encodeURIComponent(s)}-${date}.json`;
    }
    async function loadBriefs(date, source) {
      if (!date) return;
      const src = String(source || briefSourceName.value || '格隆汇');
      briefLoading.value = true;
      briefError.value = '';
      try {
        const r = await fetch(briefFileForSource(src, date), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        briefItems.value = Array.isArray(j.items) ? j.items : [];
        if (!briefItems.value.length) {
          // 该来源当天无数据：明确告知，而不是默默回退到格隆汇
          briefError.value = src === '格隆汇'
            ? `${date} 暂无快讯数据`
            : `「${src}」快讯数据源暂未接入（已提交定时抓取，换个日期或稍后重试）`;
        }
      } catch (e) {
        briefItems.value = [];
        briefError.value = src === '格隆汇'
          ? `${date} 快讯加载失败：` + (e && e.message ? e.message : e)
          : `「${src}」快讯数据源暂未接入（已提交定时抓取，换个日期或稍后重试）`;
      } finally {
        briefLoading.value = false;
      }
    }
    function onBriefDateChange() {
      clearBriefWindow();                 // 手动选日期 = 回到「该日全部」，退出闭市周期视图
      loadBriefs(briefDate.value);
    }

    /* ---------- 闭市周期刷新（按股票收盘时刻切分，不按自然日） ----------
     * 口径（用户指定）：
     *   · 当天 15:00 以前刷新 → 统计 [昨天 15:00, 今天 15:00] 区间（此刻尚未到 15:00，
     *     实际可见数据即 [昨天 15:00, 现在]）
     *   · 当天 15:00 以后刷新 → 统计 [今天 15:00, 刷新时刻]
     * 统一表述：窗口起点 = 最近一个「已经过去」的 15:00（收盘时刻），窗口终点 = 现在。
     * 这样 15:00 之后刷新拿到的是「今日收盘以来」的消息，15:00 之前刷新拿到的是
     * 「昨日收盘以来」的消息（含隔夜与盘前），严格贴合 15:00 闭市 → 次日 9:26 开市的节奏。
     */
    /** 计算闭市周期窗口；返回 { start, end } 两个 Date（可注入 now 便于测试） */
    function briefCloseWindow(now) {
      const n = now ? new Date(now) : new Date();
      const start = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 15, 0, 0, 0);
      // 今天 15:00 还没到 → 上一个周期从昨天 15:00 起算
      if (n.getTime() < start.getTime()) start.setDate(start.getDate() - 1);
      return { start: start, end: n };
    }
    /** 退出闭市周期视图，回到「按日」查看 */
    function clearBriefWindow() {
      briefWindow.on = false;
      briefWindow.start = '';
      briefWindow.end = '';
      briefWindowItems.value = [];
    }
    /** 拉取某日快讯文件；文件不存在或拉取失败都返回空数组（跨天合并时允许缺一天） */
    async function fetchBriefsFile(date, source) {
      try {
        const r = await fetch(briefFileForSource(source, date), { cache: 'no-store' });
        if (!r.ok) return [];
        const j = await r.json();
        return Array.isArray(j.items) ? j.items : [];
      } catch (e) {
        return [];
      }
    }
    /**
     * 用户主动「刷新（闭市周期）」：重新拉取窗口跨越的那几天快讯（绕开浏览器缓存），
     * 合并后按时间过滤，只保留 [最近一个 15:00, 现在] 的新闻。
     * 属于用户主动触发，因此顶部「暂停自动刷新」开关生效时依然可用（与「📥 加载该日快讯」同理）。
     */
    async function refreshBriefCloseWindow() {
      if (briefLoading.value) return;
      // batch16：起止时间改为可编辑；没填 / 填错时给出明确提示，不再悄悄用默认值
      const HT = ht_();
      let s = HT && HT.fromLocalInputValue ? HT.fromLocalInputValue(briefWinStart.value) : null;
      let e = HT && HT.fromLocalInputValue ? HT.fromLocalInputValue(briefWinEnd.value) : null;
      if (!s || !e) { showToast('请先填写完整的统计开始时间与结束时间', 'error'); return; }
      if (s.getTime() >= e.getTime()) { showToast('统计开始时间必须早于结束时间', 'error'); return; }
      const w = { start: s, end: e };
      const startStr = fmtDateTime(w.start);   // 'YYYY-MM-DD HH:mm'，与快讯 time 字段同格式
      const endStr = fmtDateTime(w.end);
      // 以 15:00 换日后窗口可能跨自然日，把覆盖到的每一天都拉来再按时间戳精筛
      const days = (HT && HT.windowSnapshotDates) ? HT.windowSnapshotDates(s.getTime(), e.getTime()) : [];
      if (!days.length) {
        days.push(fmtDate(w.start));
        const endDay = fmtDate(w.end);
        if (days.indexOf(endDay) < 0) days.push(endDay);
      }

      briefLoading.value = true;
      briefError.value = '';
      briefPaused.value = false;
      _briefLoaded = true;
      try {
        const chunks = await Promise.all(days.map(d => fetchBriefsFile(d, briefSourceName.value)));
        if (!briefDates.value.length) {            // 顺手同步一下日期清单，便于「回到当日全部」
          briefDates.value = days.slice().reverse();
        }
        const merged = [];
        chunks.forEach(list => list.forEach(it => { if (it && it.time) merged.push(it); }));
        const inWin = merged
          .filter(it => {
            const t = String(it.time);
            return t >= startStr && t <= endStr;
          })
          .sort((a, b) => String(b.time).localeCompare(String(a.time)));
        briefWindowItems.value = inWin;
        loadPrevBriefStats();   // batch55：闭市周期窗口变化后，重算「上一个等长窗口」用于 序/增/数
        briefWindow.on = true;
        briefWindow.start = startStr;
        briefWindow.end = endStr;
        Object.keys(briefUi.open).forEach(k => { briefUi.open[k] = false; });   // 换窗口后分类先收起
        if (!inWin.length) {
          briefError.value = `闭市周期（${startStr} → ${endStr}）内没有快讯；可换用上方日期查看整日快讯`;
        } else {
          const hrs = (w.end - w.start) / 3600000;
          showToast(`已刷新：${startStr} → ${endStr}（约 ${hrs.toFixed(1)} 小时）共 ${inWin.length} 条`, 'success');
        }
      } catch (e) {
        briefWindowItems.value = [];
        briefError.value = '闭市周期刷新失败：' + (e && e.message ? e.message : e);
      } finally {
        briefLoading.value = false;
      }
    }

    function toggleBriefCat(key, mode) {
      const k = (mode ? mode + '::' : '') + key;
      briefUi.open[k] = !briefUi.open[k];
      if (briefUi.open[k] && !briefUi.limit[k]) briefUi.limit[k] = 30;
    }
    function moreBriefNews(key, mode) {
      const k = (mode ? mode + '::' : '') + key;
      briefUi.limit[k] = (briefUi.limit[k] || 30) + 50;
    }
    /** 关键词高亮：先转义再包 <mark>，避免把外部快讯正文当 HTML 执行 */
    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }
    function hlBrief(text) {
      // 先剥掉「格隆汇9月16日｜」这类统一前缀（与统计口径一致），再转义、再高亮
      const clean = (typeof HotTopics !== 'undefined' && HotTopics.cleanBriefText)
        ? HotTopics.cleanBriefText(text) : String(text == null ? '' : text);
      const safe = escapeHtml(clean);
      const kw = briefKeyword.value.trim();
      if (!kw) return safe;
      const esc = escapeHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try { return safe.replace(new RegExp(esc, 'gi'), m => `<mark>${m}</mark>`); }
      catch (e) { return safe; }
    }
    /** 当前展示的数据源：闭市周期窗口优先（跨天合并），否则为所选那天的全部快讯 */
    const briefBase = computed(() => (briefWindow.on ? briefWindowItems.value : briefItems.value));
    /** 关键词过滤（正文 / 关联股票 / 关联主题都参与匹配） */
    const briefFiltered = computed(() => {
      const kw = briefKeyword.value.trim();
      if (!kw) return briefBase.value;
      const k = kw.toLowerCase();
      return briefBase.value.filter(it =>
        String(it.text || '').toLowerCase().includes(k) ||
        (it.stocks || []).some(s => String(s).toLowerCase().includes(k)) ||
        (it.subjects || []).some(s => String(s).toLowerCase().includes(k)));
    });
    const briefSearching = computed(() => !!briefKeyword.value.trim());

    /* ===================== batch55：每日快讯子类 → 成分股 + 序/增/数 =====================
     * ① 上一个默认时间段（用于「增/数」的排名变化计算）：取与当前窗口等长的「紧邻上一个窗口」。
     *    默认窗口（昨天15:00→现在）→ 上一个 = 前天15:00→昨天15:00（HotTopics.lastClosedWindow）。
     *    自定义闭市周期窗口 → 上一个 = [当前开始−窗口长度, 当前开始)。按 窗口+来源 缓存，不重复请求。 */
    const prevBriefItems = ref([]);
    const prevBriefLoading = ref(false);
    let _prevKey = '';
    const prevStats = computed(() => {
      const items = prevBriefItems.value;
      const out = { map: {}, max: { theme: 1, concept: 1, industry: 1 }, hasData: items.length > 0 };
      if (!out.hasData) return out;
      for (const m of ['theme', 'concept', 'industry']) {
        const arr = HotTopics.briefStats(items, m);
        let mx = 1;
        arr.forEach((c, i) => {
          out.map[m + '::' + c.key] = { rank: i + 1, count: c.count };
          if (c.count > mx) mx = c.count;
        });
        out.max[m] = mx;
      }
      return out;
    });
    async function loadPrevBriefStats() {
      let pwin;
      if (briefWindow.on) {
        const s = HotTopics.parseBriefTime(briefWindow.start), e = HotTopics.parseBriefTime(briefWindow.end);
        if (s == null || e == null) return;
        const len = e - s; pwin = { startMs: s - len, endMs: e - len };
      } else {
        const lw = HotTopics.lastClosedWindow();
        pwin = { startMs: lw.start.getTime(), endMs: lw.end.getTime() };
      }
      const key = (briefWindow.on ? 'win' : 'def') + ':' + briefSourceName.value + ':' + pwin.startMs + '-' + pwin.endMs;
      if (key === _prevKey && prevBriefItems.value.length) return;   // 已缓存，跳过
      _prevKey = key;
      prevBriefLoading.value = true;
      try {
        const dates = HotTopics.windowSnapshotDates(pwin.startMs, pwin.endMs);
        const chunks = await Promise.all(dates.map(d => fetchBriefsFile(d, briefSourceName.value).catch(() => [])));
        let items = [];
        chunks.forEach(c => { if (Array.isArray(c)) items = items.concat(c); });
        items = items.filter(it => {
          const ts = HotTopics.parseBriefTime(it.time);
          return ts != null && ts >= pwin.startMs && ts < pwin.endMs;
        });
        prevBriefItems.value = items;
      } catch (e) {
        prevBriefItems.value = [];
      } finally {
        prevBriefLoading.value = false;
      }
    }

    /* ===================== 子类 → 成分股（新闻追踪页当日股票明细，独立于热门板块点击） ===================== */
    const briefCatStocks = ref([]);          // 子类成分股（独立状态，绝不写 daily.stocks）
    const briefCatActive = ref('');          // 当前选中的子类名（驱动新闻页明细表）
    const briefCatLoading = ref(false);
    const briefCatIsFallback = ref(false);   // true=未找到对应板块，回退到新闻关联股票
    // 类别名 → 板块名 的少量纠偏（概念名与板块名不完全一致时用）；其余走 searchSectors 名称匹配
    const BRIEF_CAT_BOARD_OVERRIDE = {
      '人工智能': '人工智能', '算力': '算力', '半导体': '半导体', '芯片': '芯片', '新能源车': '新能源车',
      '锂电池': '锂电池', '光伏': '光伏', '白酒': '白酒', '银行': '银行', '证券': '证券',
      '房地产': '房地产', '军工': '国防军工', '医药': '医药生物', '电子': '电子', '汽车': '汽车整车',
      '食品饮料': '食品饮料', '有色金属': '有色金属', '电力设备': '电力设备', '计算机': '计算机',
      '通信': '通信', '传媒': '传媒', '农林牧渔': '农林牧渔', '化工': '化学制品', '钢铁': '钢铁',
      '煤炭': '煤炭', '家电': '家用电器', '有色': '有色金属', '机器人': '机器人', '储能': '储能'
    };
    async function resolveCatBoard(cat) {
      const name = BRIEF_CAT_BOARD_OVERRIDE[cat.name] || cat.name;
      try {
        const res = await StockAPI.searchSectors(name);
        if (res && res.length && res[0] && res[0].bk) return res[0].bk;
      } catch (e) { /* 搜索失败则回退 */ }
      return null;
    }
    /** 给任意股票列表补全行情与财务（复用 refreshHotStocks 的核心逻辑，但不动 daily.stocks） */
    async function enrichStockList(list) {
      if (!list || !list.length) return;
      const codes = list.map(s => s.code).filter(Boolean);
      try {
        const quotes = await StockAPI.getQuotes(codes);
        for (const s of list) {
          const q = quotes[s.code];
          if (!q) continue;
          if (!s.name && q.name) s.name = q.name;
          s.amplitude = q.amplitude;
          s.dailyChange = q.changePercent;
          s.turnover = q.turnover;
          s.todayPrice = q.price || s.todayPrice;
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
        }
      } catch (e) { /* 行情失败不影响成分股本身 */ }
      await runWithConcurrency(list, 6, async (s) => {
        try { await enrichStockFinancials(s); } catch (e) { console.warn('子类成分股财务补全失败', s.code, e); }
      });
    }
    // 请求令牌：加载未完成时用户再点别的子类，新点击应立刻生效（后点覆盖先点），
    // 旧请求的结果作废，不再写回 —— 修复「加载中点击被静默吞掉」的旧行为。
    let briefCatToken = 0;
    async function openBriefCat(cat, mode) {
      if (!cat) return;
      const my = ++briefCatToken;
      briefCatLoading.value = true;
      briefCatActive.value = cat.name;
      briefCatIsFallback.value = false;
      showToast(`正在获取「${cat.name}」成分股...`, 'info');
      try {
        const bk = await resolveCatBoard(cat);
        if (my !== briefCatToken) return;   // 已被更新的点击取代，直接放弃旧结果
        if (bk) {
          const all = await StockAPI.getSectorStocks(bk, cat.name);
          if (all && all.length) {
            const list = all.filter(s => !hotExcluded({ code: s.code, name: s.name }));
            const removed = all.length - list.length;
            briefCatStocks.value = list.map(s => {
              const ns = _newStock(s);
              ns.dailyChange = s.changePercent;
              ns.todayPrice = s.price;
              return ns;
            });
            await enrichStockList(briefCatStocks.value);
            showToast(`已载入「${cat.name}」${briefCatStocks.value.length} 只成分股` + (removed ? `（已剔除 ${removed} 只）` : ''), 'success');
            return;
          }
        }
        // 回退：用该子类新闻里关联的股票
        const codes = []; const seen = new Set();
        (cat.news || []).forEach(n => (n.stocks || []).forEach(st => { if (!seen.has(st)) { seen.add(st); codes.push(st); } }));
        if (codes.length) {
          briefCatStocks.value = codes.map(c => _newStock({ code: c, name: '' }));
          await enrichStockList(briefCatStocks.value);
          briefCatIsFallback.value = true;
          showToast(`未找到「${cat.name}」对应板块，已用新闻关联股票代替（${codes.length} 只）`, 'warn');
        } else {
          briefCatStocks.value = [];
          showToast(`「${cat.name}」暂无成分股数据`, 'error');
        }
      } catch (e) {
        if (my === briefCatToken) {
          console.warn('子类成分股获取失败', e);
          briefCatStocks.value = [];
          showToast('成分股获取失败，请重试', 'error');
        }
      } finally {
        if (my === briefCatToken) briefCatLoading.value = false;
      }
    }
    function clearBriefCat() { briefCatActive.value = ''; briefCatStocks.value = []; }

    /* ===================== 子类排序字段 序/增/数（及占比）一键排序 ===================== */
    const briefCatSort = reactive({ field: 'seq', dir: 'asc' });   // 默认按序升序（名次 1 在最前，与「占比由大到小」同向）
    function sortByBriefField(field) {
      if (briefCatSort.field === field) { briefCatSort.dir = briefCatSort.dir === 'asc' ? 'desc' : 'asc'; }
      else { briefCatSort.field = field; briefCatSort.dir = 'desc'; }
    }
    /**
     * 给子类列表附上 序(seq)/增(inc)/数(cnt)，并按 briefCatSort 排序后返回。
     *  seq = 当前窗口内、本归类下、按新闻出现次数占比由大到小排序后的名次（1 起）。
     *  inc = 本次排名 − 上次默认时间段排名（正=名次下降/变差，负=上升/变好）。无上期数据则 null。
     *  cnt = 本次该子类新闻数量 − 上次默认时间段该归类下最大数量。无上期数据则 null。
     */
    function buildBriefStats(items, mode) {
      const base = (typeof HotTopics !== 'undefined' && HotTopics.briefStats) ? HotTopics.briefStats(items, mode) : [];
      const pv = prevStats.value;
      const enriched = base.map((c, i) => {
        const seq = i + 1;
        const prev = pv.hasData ? pv.map[mode + '::' + c.key] : null;
        const inc = prev ? (seq - prev.rank) : null;
        const cnt = pv.hasData ? (c.count - pv.max[mode]) : null;
        return Object.assign({}, c, { seq: seq, inc: inc, cnt: cnt });
      });
      const f = briefCatSort.field, dir = briefCatSort.dir === 'asc' ? 1 : -1;
      if (f === 'seq') return enriched.slice().sort((a, b) => (a.seq - b.seq) * dir);   // 序：名次升/降序（dir 控制箭头）
      if (f === 'pct') return enriched.slice().sort((a, b) => (a.count - b.count) * dir); // 占比：按 count 升/降序（与数值路径一致）
      const copy = enriched.slice();
      copy.sort((a, b) => {
        const va = a[f], vb = b[f];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va - vb) * dir;
      });
      return copy;
    }
    /** 分类统计（关键词过滤后集合上统计；三维度各自独立，附 序/增/数 且支持一键排序） */
    const briefThemeStats = computed(() => buildBriefStats(briefFiltered.value, 'theme'));
    const briefConceptStats = computed(() => buildBriefStats(briefFiltered.value, 'concept'));
    const briefIndustryStats = computed(() => buildBriefStats(briefFiltered.value, 'industry'));
    // 兼容旧引用（统计面板标题等）
    const briefStatsList = briefThemeStats;
    const briefDimCount = computed(() => briefThemeStats.value.length);

    function autoLoadHotTopics() {
      if (_hotTopicsLoaded || hotTopicsSources.value.length || hotTopicsLoading.value) return;
      // 顶部「暂停」生效时，不发起任何自动抓取（含仓库快照请求）
      if (autoRefreshPaused()) { pauseHint('自动加载热门话题'); return; }
      refreshDailyTopics();
    }

    /** 加载某日历史快照（优先本地快照，回退到仓库内置 data/hot-topics/YYYY-MM-DD.json） */
    async function loadHotTopicHistory(date) {
      // 1) 优先本地快照（打开应用时自动积累）
      const local = getLocalHotTopicSnapshot(date);
      if (local) {
        hotTopicDateHasData.value = true;
        hotTopicsSources.value = (local.sources || []).map(s => ({ ...s, loading: false, error: (s.items && s.items.length) ? null : '该日该源无数据' }));
        hotTopicsUpdated.value = (local.generatedAt ? new Date(local.generatedAt).toLocaleString('zh-CN', { hour12: false }) : date) + '（本地快照）';
        return;
      }
      hotTopicsLoading.value = true;
      try {
        const resp = await fetch(`./data/hot-topics/${date}.json`, { cache: 'no-store' });
        if (!resp.ok) {
          hotTopicDateHasData.value = false;
          hotTopicsSources.value = (typeof HotTopics !== 'undefined' ? HotTopics.SOURCE_ORDER : []).map(s => ({ ...s, items: [], loading: false, error: '该日暂无历史快照' }));
          return;
        }
        const snap = await resp.json();
        hotTopicDateHasData.value = true;
        hotTopicsSources.value = (snap.sources || []).map(s => ({ ...s, loading: false, error: (s.items && s.items.length) ? null : '该日该源无数据' }));
        hotTopicsUpdated.value = (snap.generatedAt ? new Date(snap.generatedAt).toLocaleString('zh-CN', { hour12: false }) : date) + '（历史）';
      } catch (e) {
        hotTopicDateHasData.value = false;
        hotTopicsSources.value = [];
      } finally {
        hotTopicsLoading.value = false;
      }
    }

    function setHtMode(m) {
      htMode.value = m;
      if (m === 'history') {
        htLiveNote.value = '';          // 用户明确要看历史，无需再解释「实时源不可达」
        loadHotTopicHistory(hotTopicDate.value);
      } else refreshHotTopics();
    }
    function onHotTopicDateChange() {
      if (htMode.value === 'history') loadHotTopicHistory(hotTopicDate.value);
    }

    /** 统计分析：按时间段加载历史快照，跨站聚类 + 各站分类统计 */
    async function runAnalysis() {
      const opt = htRangeOptions.find(r => r.key === analysisRange.value) || htRangeOptions[1];
      // 请求R：「时段」= 按上方「新闻统计开始时间」窗口统计；其余 = 近 N 天整日纳入
      const winMode = analysisRange.value === 'win';
      analysisLoading.value = true;
      analysisResult.value = null;
      try {
        // batch16：时间口径改为「统计窗口」（15:00 换日、起止可改）；
        // 请求R：只有选中「时段」时才按窗口精筛，否则按所选「近 N 天」回溯。
        const HT = ht_();
        const ws = (HT && HT.fromLocalInputValue) ? HT.fromLocalInputValue(analysisWinStart.value) : null;
        const we = (HT && HT.fromLocalInputValue) ? HT.fromLocalInputValue(analysisWinEnd.value) : null;
        let dates = [];
        let winStartMs = null, winEndMs = null;
        if (winMode) {
          if (ws && we && ws.getTime() < we.getTime()) {
            winStartMs = ws.getTime();
            winEndMs = we.getTime();
            dates = HT.windowSnapshotDates(winStartMs, winEndMs);
          } else {
            // 窗口没填或填错：提示并回退到当天，避免静默给出误导性结果
            showToast('「时段」需要有效的统计开始/结束时间（开始早于结束），已回退为当天', 'error');
            dates.push(hotTopicDate.value || fmtDate(new Date()));
          }
        } else {
          const today = hotTopicDate.value || fmtDate(new Date());
          for (let i = 0; i < opt.days; i++) dates.push(dateMinusDays(today, i));
        }
        if (!dates.length) dates.push(fmtDate(new Date()));
        const snapshots = await Promise.all(dates.map(async d => {
          const local = getLocalHotTopicSnapshot(d);
          if (local) return local;
          try {
            const r = await fetch(`./data/hot-topics/${d}.json`, { cache: 'no-store' });
            if (!r.ok) return null;
            return await r.json();
          } catch (e) { return null; }
        }));
        const flat = [];
        let dayCount = 0;
        for (const snap of snapshots) {
          if (!snap || !snap.sources) continue;
          dayCount++;
          for (const s of snap.sources) {
            for (const it of (s.items || [])) {
              // batch16：有逐条时间戳的按窗口精筛；历史快照没有 time，只能整日纳入（避免丢数据）
              if (winStartMs != null && it.time && HT && HT.parseBriefTime && HT.inWindow) {
                const ts = HT.parseBriefTime(it.time);
                if (ts != null && !HT.inWindow(ts, winStartMs, winEndMs)) continue;
              }
              flat.push({
                sourceRank: s.rank, sourceKey: s.key, sourceName: s.name,
                text: it.text, time: it.time, url: it.url, cat: it.cat || '财经', date: snap.date
              });
            }
          }
        }
        const clusters = (typeof HotTopics !== 'undefined' ? HotTopics.clusterItems(flat) : []).map(c => ({ ...c, _open: false }));
        _analysisFlat = flat;
        // 请求S：默认按「概念」维度分站统计；切到「7大类」时走原来的互斥分类
        const siteStats = (typeof HotTopics !== 'undefined')
          ? (siteStatsDim.value === 'cat7'
            ? HotTopics.siteCategoryStats(flat)
            : HotTopics.siteThemeStats(flat, siteStatsDim.value))
          : [];
        // 主题维度统计（行业/概念/产品/产业/科技），多标签命中，与跨站重合榜并排展示
        const themeStats = (typeof HotTopics !== 'undefined' && HotTopics.themeStats ? HotTopics.themeStats(flat) : [])
          .map(d => ({ ...d, _open: true, showAll: false, selTopic: null, newsLimit: 30 }));
        analysisResult.value = { clusters, siteStats, themeStats, dayCount, totalItems: flat.length };
      } catch (e) {
        showToast('统计分析失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        analysisLoading.value = false;
      }
    }

    /** 请求S：切换「各站分类统计」的维度（概念/行业/产品/产业/科技/7大类）——用已有扁平数据即时重算 */
    function recomputeSiteStats() {
      if (!analysisResult.value || !_analysisFlat.length) return;
      const HT = (typeof HotTopics !== 'undefined') ? HotTopics : null;
      if (!HT) return;
      analysisResult.value.siteStats = (siteStatsDim.value === 'cat7')
        ? HT.siteCategoryStats(_analysisFlat)
        : HT.siteThemeStats(_analysisFlat, siteStatsDim.value);
    }
    watch(siteStatsDim, recomputeSiteStats);

    /** 请求S：点某个概念（或分类）条 —— 弹窗列出「该站 + 该概念」命中的全部新闻 */
    function openSiteStatNews(st, d) {
      const dim = siteCatDimOptions.find(o => o.key === siteStatsDim.value) || siteCatDimOptions[0];
      siteStatModal.show = true;
      siteStatModal.siteName = (st && st.name) || '';
      siteStatModal.siteRank = (st && st.rank) || 0;
      siteStatModal.topic = (d && (d.name || d.cat)) || '';
      siteStatModal.dimName = dim.name;
      siteStatModal.color = (siteStatsDim.value === 'cat7') ? ((st && st.color) || dim.color) : dim.color;
      siteStatModal.items = ((d && d.news) || []).slice(0, 300);
    }
    function closeSiteStatNews() { siteStatModal.show = false; }

    /** 点击主题词（半导体 / 人工智能 / 医疗器械 …）：就地展开该主题命中的新闻明细；同一维度内一次只看一个主题 */
    function toggleThemeTopic(dim, topic) {
      dim.selTopic = dim.selTopic === topic.name ? null : topic.name;
    }
    /** 展开更多该主题的新闻（默认先显示 30 条） */
    function moreThemeNews(dim) { dim.newsLimit = (dim.newsLimit || 30) + 50; }

    async function fetchHotBoards() {
      hotLoading.value = true;
      showToast('正在获取热门板块...', 'info');
      // 每一路单独限时：某一路接口不可用（限流/非交易时段）时不让它拖住整轮刷新。
      // 典型如「连板股票」要回扫 10 个交易日，东财不可用时每天还要重试 + 退避，
      // 不设上限会把「点一次刷新」拖成几十秒。超时那一路按空处理，其余数据照常渲染。
      const HOT_SRC_TIMEOUT = 6000;
      const withTimeout = (p) => Promise.race([
        Promise.resolve(p).catch(() => null),
        new Promise(r => setTimeout(() => r(null), HOT_SRC_TIMEOUT))
      ]);
      try {
        const [boards, stocks, preBoards, ampBoards, newListed] = await Promise.all([
          withTimeout(StockAPI.getBoardRanking()),
          withTimeout(StockAPI.getLimitUpStreak()),
          withTimeout(StockAPI.getPreMarketBoards()),
          withTimeout(StockAPI.getAmplitudeBoards()),
          withTimeout(StockAPI.getNewListedStocks())
        ]);
        // 各路独立落盘：某一路接口限流返回空时保留旧数据，避免「刷新一次反而清空已有内容」
        if (boards && boards.length) { hotBoards.value = boards; D.hotBoards = boards; }
        if (stocks && stocks.length) { hotStocks.value = stocks; D.hotStocks = stocks; }
        if (preBoards && preBoards.length) { preMarketBoards.value = preBoards; D.preMarketBoards = preBoards; }
        if (ampBoards && ampBoards.length) { amplitudeBoards.value = ampBoards; D.amplitudeBoards = ampBoards; }
        if (newListed && newListed.length) { newListedStocks.value = newListed; D.newListedStocks = newListed; }
        // 任一当前有数据即视为成功（含历史残留），某一路限流不再误报整体失败
        const nBoards = hotBoards.value.length, nPre = preMarketBoards.value.length,
              nAmp = amplitudeBoards.value.length, nStocks = hotStocks.value.length, nNew = newListedStocks.value.length;
        const gotNew = (boards && boards.length) || (stocks && stocks.length) || (preBoards && preBoards.length)
                    || (ampBoards && ampBoards.length) || (newListed && newListed.length);
        const nAll = nBoards + nPre + nAmp + nStocks + nNew;
        if (nAll) {
          // 有数据即成功；本轮确实没拿到新数据时补一句「沿用上次」，避免用户误以为刷新没生效
          showToast(`获取到 ${nBoards} 个当日板块、${nPre} 个盘前热点、${nAmp} 个振幅板块、${nStocks} 只连板股票、${nNew} 只新上市股票`
            + (gotNew ? '' : '（本轮未获取到新数据，沿用上次结果）'), 'success');
        } else {
          // 全空：区分「本轮确实没拉到」与「真的一无所有」，给出可操作提示，不再使用已过时的 JSONP 措辞
          showToast('暂未获取到数据（接口限流或非交易时段），请稍后重试', 'error');
        }
      } catch (e) {
        const anyData = hotBoards.value.length || hotStocks.value.length || preMarketBoards.value.length
                     || amplitudeBoards.value.length || newListedStocks.value.length;
        showToast(anyData ? `获取暂未成功，继续沿用上次 ${anyData} 条数据` : '获取失败（网络异常），请稍后重试', anyData ? 'info' : 'error');
      } finally {
        hotLoading.value = false;
      }
    }

    // ===== batch23（请求F）：热门板块下六个子版块的「独立刷新」按钮 =====
    // 六个子版块：① 当日热门板块 ② 新上市股票 ③ 连板股票 ④ 盘前热点板块 ⑤ 尾盘买入法 ⑥ 振幅板块
    // 每个子版块各有一个独立刷新按钮，只刷新自己那一路数据，互不影响。
    const hotBoardsLoading = ref(false);
    const newListedLoading = ref(false);
    const hotStocksLoading = ref(false);
    const preMarketLoading = ref(false);

    /** ① 只刷新「当日热门板块」 */
    async function refreshHotBoardsOnly() {
      if (hotBoardsLoading.value) return;
      hotBoardsLoading.value = true;
      const prevLen = hotBoards.value.length; // 刷新前的旧数据条数，用于区分「沿用」与「真失败」
      showToast('正在刷新当日热门板块...', 'info');
      try {
        const list = await StockAPI.getBoardRanking();
        if (list && list.length) {
          hotBoards.value = list;
          D.hotBoards = list;
          showToast(`已刷新 ${list.length} 个当日热门板块`, 'success');
        } else if (prevLen) {
          // 这次没拿到新数据（限流/非交易时段接口空），本地还有上次数据 → 沿用，不算失败
          showToast(`未获取到新数据，继续沿用上次 ${prevLen} 条`, 'info');
        } else {
          showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
        }
      } catch (e) {
        if (prevLen) showToast(`刷新暂未成功，继续沿用上次 ${prevLen} 条`, 'info');
        else showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
      } finally {
        hotBoardsLoading.value = false;
      }
    }

    /** ② 只刷新「新上市股票」（失败时保留上次数据） */
    async function refreshNewListedStocks() {
      if (newListedLoading.value) return;
      newListedLoading.value = true;
      const prevLen = newListedStocks.value.length; // 刷新前的旧数据条数，用于区分「沿用」与「真失败」
      showToast('正在刷新新上市股票...', 'info');
      try {
        const list = await StockAPI.getNewListedStocks();
        if (list && list.length) {
          newListedStocks.value = list;
          D.newListedStocks = list;
          showToast(`已刷新 ${list.length} 只新上市股票`, 'success');
        } else if (prevLen) {
          // 这次没拿到新数据（限流/非交易时段接口空），本地还有上次数据 → 沿用，不算失败
          showToast(`未获取到新数据，继续沿用上次 ${prevLen} 条`, 'info');
        } else {
          showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
        }
      } catch (e) {
        if (prevLen) showToast(`刷新暂未成功，继续沿用上次 ${prevLen} 条`, 'info');
        else showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
      } finally {
        newListedLoading.value = false;
      }
    }

    /** ③ 只刷新「连板股票」（近 10 交易日涨停次数降序取前 25） */
    async function refreshHotStocksOnly() {
      if (hotStocksLoading.value) return;
      hotStocksLoading.value = true;
      const prevLen = hotStocks.value.length; // 刷新前的旧数据条数，用于区分「沿用」与「真失败」
      showToast('正在刷新连板股票...', 'info');
      try {
        const list = await StockAPI.getLimitUpStreak();
        if (list && list.length) {
          hotStocks.value = list;
          D.hotStocks = list;
          showToast(`已刷新 ${list.length} 只连板股票`, 'success');
        } else if (prevLen) {
          // 这次没拿到新数据（限流/非交易时段接口空），本地还有上次数据 → 沿用，不算失败
          showToast(`未获取到新数据，继续沿用上次 ${prevLen} 条`, 'info');
        } else {
          showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
        }
      } catch (e) {
        if (prevLen) showToast(`刷新暂未成功，继续沿用上次 ${prevLen} 条`, 'info');
        else showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
      } finally {
        hotStocksLoading.value = false;
      }
    }

    /** ④ 只刷新「盘前热点板块」 */
    async function refreshPreMarketBoards() {
      if (preMarketLoading.value) return;
      preMarketLoading.value = true;
      const prevLen = preMarketBoards.value.length; // 刷新前的旧数据条数，用于区分「沿用」与「真失败」
      showToast('正在刷新盘前热点板块...', 'info');
      try {
        const list = await StockAPI.getPreMarketBoards();
        if (list && list.length) {
          preMarketBoards.value = list;
          D.preMarketBoards = list;
          showToast(`已刷新 ${list.length} 个盘前热点板块`, 'success');
        } else if (prevLen) {
          // 这次没拿到新数据（限流/非交易时段接口空），本地还有上次数据 → 沿用，不算失败
          showToast(`未获取到新数据，继续沿用上次 ${prevLen} 条`, 'info');
        } else {
          showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
        }
      } catch (e) {
        if (prevLen) showToast(`刷新暂未成功，继续沿用上次 ${prevLen} 条`, 'info');
        else showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
      } finally {
        preMarketLoading.value = false;
      }
    }

    async function refreshAmplitudeBoards() {
      ampLoading.value = true;
      const prevLen = amplitudeBoards.value.length;
      showToast('正在刷新振幅板块...', 'info');
      try {
        const list = await StockAPI.getAmplitudeBoards();
        amplitudeBoards.value = list || [];
        D.amplitudeBoards = list || [];
        if (list && list.length) {
          showToast(`已刷新 ${list.length} 个振幅板块`, 'success');
        } else if (prevLen) {
          showToast(`未获取到新数据，继续沿用上次 ${prevLen} 条`, 'info');
        } else {
          showToast('刷新失败（网络/接口限流），请稍后重试', 'error');
        }
      } catch (e) {
        if (prevLen) showToast(`刷新暂未成功，继续沿用上次 ${prevLen} 条`, 'info');
        else showToast('刷新失败', 'error');
      } finally {
        ampLoading.value = false;
      }
    }

    /**
     * 以固定并发度执行异步任务。
     * 板块成分股动辄上百只，若逐只串行补全（每只约 7 次请求），总耗时与失败率都会急剧上升，
     * 是「今年高价/距高价/今年低价/距低价/年涨跌/924涨跌」六个字段长期刷新不出的主因；
     * 但若一次性全并发又会被接口限流。这里取折中并发度（默认 6）。
     * @param {Array} items 待处理项
     * @param {number} limit 并发度
     * @param {(item:any, index:number)=>Promise<any>} worker 处理函数
     */
    async function runWithConcurrency(items, limit, worker) {
      const list = items || [];
      if (!list.length) return;
      const n = Math.max(1, Math.min(limit || 6, list.length));
      let idx = 0;
      const runners = [];
      for (let w = 0; w < n; w++) {
        runners.push((async () => {
          for (;;) {
            const i = idx++;
            if (i >= list.length) return;
            try { await worker(list[i], i); }
            catch (e) { console.warn('并发补全任务失败', e); }
          }
        })());
      }
      await Promise.all(runners);
    }

    async function refreshHotStocks() {
      const daily = D.dailyData[hotDate.value];
      if (!daily || !daily.stocks.length) {
        showToast('请先加载当日数据', 'error');
        return;
      }
      hotLoading.value = true;
      showToast('正在刷新股票行情...', 'info');
      const codes = daily.stocks.map(s => s.code).filter(Boolean);
      const quotes = await StockAPI.getQuotes(codes);
      for (const s of daily.stocks) {
        const q = quotes[s.code];
        if (q) {
          s.name = s.name || q.name;
          s.amplitude = q.amplitude;
          s.dailyChange = q.changePercent;
          s.turnover = q.turnover;
          s.todayPrice = q.price || s.todayPrice;
          if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
        }
      }
      showToast('行情已刷新，正在获取财务数据...', 'info');
      // 财务/股东/历史价（东财，best-effort，复用共享补全逻辑）
      // 并发补全：成分股数量多时串行会显著拖慢并触发限流，导致六项历史价字段取不到
      let done = 0;
      await runWithConcurrency(daily.stocks, 6, async (s) => {
        try { await enrichStockFinancials(s); } catch (e) { console.warn('热门股财务补全失败', s.code, e); }
        done++;
        // 给出进度提示
        if (done % 25 === 0) showToast(`已补全 ${done}/${daily.stocks.length} 只...`, 'info');
      });
      hotLoading.value = false;
      showToast('行情已刷新', 'success');
    }

    // 当日股票明细的「股票查询」条件：按代码 / 按名称关键字过滤
    const hotSearchCode = ref('');
    const hotSearchName = ref('');
    /** 清空股票查询条件 */
    function clearHotSearch() {
      hotSearchCode.value = '';
      hotSearchName.value = '';
    }
    // 当前选中的热门板块名（用于高亮与表头提示）
    const hotBoardActive = ref('');
    const hotBoardLoading = ref(false);
    // true=当前明细展示的是「单只个股」；false=展示的是「板块成分股」
    const hotDetailIsStock = ref(false);

    /**
     * 热门板块：点击子版块后的「去除股票」选项弹窗状态。
     * 四个子版块（当日热门板块 / 盘前热点板块 / 振幅板块 / 连板股票）共用这一份勾选，
     * 勾选结果在本次会话内记住，不必每次重选。
     */
    const hotExclude = reactive({
      show: false,
      label: '',
      kind: 'board',                                        // 'board' | 'stock'
      no301: false, no688: false, noBj: false, noST: false,  // 四种剔除规则
      pending: null                                         // 待载入的目标 { type, board|stock }
    });

    /**
     * 点击「当日热门板块」中的某个板块（入口）：
     * 先弹出「去除股票」选项，确认后再真正载入 —— 保证剔除发生在「筛选板块」出现内容之前。
     */
    function askHotExclude(payload) {
      if (!payload) return;
      if (payload.type === 'board' && (!payload.board || !payload.board.bk)) {
        showToast('该板块缺少板块代码，请重新「获取热门板块」', 'error');
        return;
      }
      if (payload.type === 'stock' && (!payload.stock || !payload.stock.code)) {
        showToast('该股票缺少代码，请点击「获取热门板块」或「刷新数据」重新加载', 'error');
        return;
      }
      hotExclude.pending = payload;
      hotExclude.kind = payload.type;
      hotExclude.label = payload.type === 'stock'
        ? (payload.stock.name || payload.stock.code)
        : payload.board.name;
      hotExclude.show = true;
    }
    function cancelHotExclude() {
      hotExclude.show = false;
      hotExclude.pending = null;
    }
    async function confirmHotExclude() {
      const p = hotExclude.pending;
      hotExclude.show = false;
      hotExclude.pending = null;
      if (!p) return;
      // 若上一批成分股仍在补全字段（hotBoardLoading=true），openHotBoard 会直接 return，
      // 用户会觉得「点了应用并载入却毫无反应」。这里先等它收尾，最多等 30s。
      var waited = 0;
      while (hotBoardLoading.value && waited < 30000) {
        await new Promise(function (r) { setTimeout(r, 200); });
        waited += 200;
      }
      if (hotBoardLoading.value) {
        showToast('上一批仍在加载中，请稍候再试', 'warn');
        return;
      }
      if (p.type === 'board') await openHotBoard(p.board);
      else await openHotStock(p.stock);
    }
    /**
     * 热门页「去除股票」规则判定。
     * 需求口径：去除301 = 代码以 301 开头；去除688 = 代码以 688 开头；
     * 去除北交所 = 4/8/92 开头；去除ST = 名称含 ST/*ST。
     */
    function hotExcluded(s) {
      if (!s) return false;
      const code = String(pureCode(s.code) || '');
      const name = String(s.name || '');
      if (hotExclude.no301 && /^301/.test(code)) return true;
      if (hotExclude.no688 && /^688/.test(code)) return true;
      if (hotExclude.noBj && /^(4|8|92)/.test(code)) return true;
      if (hotExclude.noST && /ST/i.test(name)) return true;
      return false;
    }

    /**
     * 退市 / 已进入退市整理期股票的判定（尾盘买入法筛选前剔除）。
     * 口径：
     *   ① 名称含「退」——A 股退市整理期与已退市股票的标准标记（如「退市XX」「XX退」「XX退1」）；
     *   ② 名称/行情无有效价格（现价为空或 ≤0）且无有效涨跌幅——退市股通常已无心价数据。
     * 命中任一条即视为退市股，在筛选时剔除。
     * @param {object} s 股票对象（需含 name / code，可选 todayPrice / price / dailyChange）
     * @returns {boolean}
     */
    function isDelistedStock(s) {
      if (!s) return false;
      const name = String(s.name || '').trim();
      // ① 名称含「退」（退市/退市整理期标准标记）
      if (/退/.test(name)) return true;
      // ② 无有效价格：现价缺失或 ≤0，且涨跌幅也无效 → 视为已无行情的退市股
      const price = Number(s.todayPrice != null ? s.todayPrice : (s.price != null ? s.price : NaN));
      const chg = Number(s.dailyChange != null ? s.dailyChange : (s.changePercent != null ? s.changePercent : NaN));
      if ((!isFinite(price) || price <= 0) && !isFinite(chg)) return true;
      return false;
    }

    /**
     * 点击「当日热门板块」中的某个板块：
     * 把该板块的全部成分股载入下方「当日股票明细」，字段与格式与筛选板块完全一致。
     */
    async function openHotBoard(b) {
      if (!b) return;
      if (!b.bk) {
        showToast('该板块缺少板块代码，请重新「获取热门板块」', 'error');
        return;
      }
      if (hotBoardLoading.value) return;
      hotBoardLoading.value = true;
      showToast(`正在获取「${b.name}」成分股...`, 'info');
      try {
        const all = await StockAPI.getSectorStocks(b.bk);
        if (!all || !all.length) {
          showToast('未获取到成分股（可能受网络限制），可稍后重试', 'error');
          return;
        }
        // 载入前先按弹窗勾选的规则剔除，避免先展示再删
        const list = all.filter(s => !hotExcluded({ code: s.code, name: s.name }));
        const removed = all.length - list.length;
        if (!list.length) {
          showToast('成分股已被所选「去除股票」规则全部剔除，请放宽条件后重试', 'error');
          return;
        }
        const daily = Store.getDailyStocks(hotDate.value);
        daily.stocks = list.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          return ns;
        });
        hotBoardActive.value = b.name;
        hotDetailIsStock.value = false;
        // 联动：把成分股同时载入下方「筛选板块」列表（尊重「固定筛选」区间）
        if (!filterPanel.locked) resetHotFilterRanges();
        filterPanel.poolId = 'hot';
        hotFilterStocks.value = daily.stocks;
        showToast(`已载入「${b.name}」${daily.stocks.length} 只成分股`
          + (removed ? `（已剔除 ${removed} 只）` : '') + '，正在补全字段...', 'success');
        await refreshHotStocks();
      } catch (e) {
        console.warn('板块成分股获取失败', e);
        showToast('成分股获取失败，请重试', 'error');
      } finally {
        hotBoardLoading.value = false;
      }
    }

    /** 清除板块/个股选择，恢复当日新闻关联的股票 */
    function clearHotBoard() {
      hotBoardActive.value = '';
      hotDetailIsStock.value = false;
      hotFilterStocks.value = [];
      if (!filterPanel.locked) filterPanel.poolId = '';
      const daily = D.dailyData[hotDate.value];
      if (daily) daily.stocks = [];
      showToast('已清除选择', 'success');
    }

    /**
     * 点击「连板股票」中的某只个股：
     * 把该个股单独载入下方「当日股票明细」，字段与格式与筛选板块完全一致。
     * 与 openHotBoard（板块→成分股）互补：这里展示的是单只个股本身。
     */
    async function openHotStock(s) {
      if (!s) return;
      const code = s.code;
      if (!code) {
        showToast('该股票缺少代码，请点击「获取热门板块」或「刷新数据」重新加载', 'error');
        return;
      }
      // 与板块成分股同一套「去除股票」规则：勾选了规则且该股命中时，直接不载入
      if (hotExcluded({ code: code, name: s.name })) {
        showToast(`「${s.name || code}」命中所选「去除股票」规则，已跳过载入`, 'warn');
        return;
      }
      if (hotBoardLoading.value) return;
      hotBoardLoading.value = true;
      const label = s.name || code;
      showToast(`正在获取「${label}」的行情与财务数据...`, 'info');
      try {
        const daily = Store.getDailyStocks(hotDate.value);
        const ns = _newStock({ code, name: s.name });
        if (s.change != null) ns.dailyChange = s.change;
        daily.stocks = [ns];
        hotBoardActive.value = label;
        briefCatActive.value = '';   // batch55：热门个股点击载入时，清除新闻子类选择，保持两张表隔离
        hotDetailIsStock.value = true;
        // 联动：把个股同时载入下方「筛选板块」列表（尊重「固定筛选」区间）
        if (!filterPanel.locked) resetHotFilterRanges();
        filterPanel.poolId = 'hot';
        hotFilterStocks.value = daily.stocks;
        showToast(`已载入个股「${label}」，正在补全字段...`, 'success');
        await refreshHotStocks();
      } catch (e) {
        console.warn('个股载入失败', e);
        showToast('个股载入失败，请重试', 'error');
      } finally {
        hotBoardLoading.value = false;
      }
    }

    // 初始化时若有缓存的热门数据则恢复
    if (D.hotBoards && D.hotBoards.length) hotBoards.value = D.hotBoards;
    if (D.hotStocks && D.hotStocks.length) hotStocks.value = D.hotStocks;
    if (D.preMarketBoards && D.preMarketBoards.length) preMarketBoards.value = D.preMarketBoards;
    if (D.amplitudeBoards && D.amplitudeBoards.length) amplitudeBoards.value = D.amplitudeBoards;
    if (D.newListedStocks && D.newListedStocks.length) newListedStocks.value = D.newListedStocks;

    // ===== 尾盘买入法筛选（batch19 + batch22）：对当前「当日股票明细」按 8 项条件筛选 =====
    // 条件：涨幅 3%-5% / 换手率 5%-10% / 量比 1.5-2.5 / 市值 50亿-200亿 /
    //       20日线以上 / 成交量持续放大 / 分时图在黄色均价线上方 / 尾盘回抽均价线
    // 数据口径：涨幅/换手率/市值/分时与尾盘用实时行情（均价代理）；均线与成交量用 20 日K线；
    // 量比用「今日量 / 交易分钟 ÷ 近5日均量 / 240」代理（软条件，仅展示不硬筛）。
    // batch22：已配置 AI 接口时，先算好每只候选的实时特征，交给 AI 按 8 项条件精准判定；
    //         未配置或 AI 不可用时，回退到上面的规则硬筛（逻辑不变）。
    const tailBuyList = ref([]);
    const tailBuyLoading = ref(false);
    const tailBuyTotal = ref(0);
    const tailBuyNote = ref('');
    /** 命中的尾盘买入法股票代码集合（用于在「筛选板块」表里标红命中行） */
    const tailBuyHit = reactive({ codes: {}, show: false });
    /** 从结果列表 / 原始对象列表里提取纯代码（去前缀），用于跨表匹配 */
    function tailBuyPureCode(x) {
      const c = String((x && (x.code || x)) || '').trim();
      return String(pureCode(c) || c);
    }
    /** 清空命中标记（每次开筛前调用，避免旧结果残留） */
    function clearTailBuyHits() {
      Object.keys(tailBuyHit.codes).forEach(k => { delete tailBuyHit.codes[k]; });
      tailBuyHit.show = false;
    }
    /** 把命中结果写入标记，供表格行标红 */
    function markTailBuyHits(list) {
      const arr = list || [];
      arr.forEach(x => { tailBuyHit.codes[tailBuyPureCode(x)] = true; });
      tailBuyHit.show = arr.length > 0;
    }
    /** 该行是否为尾盘买入法命中（供模板 :class 使用） */
    function isTailBuyHit(s) {
      if (!tailBuyHit.show || !s) return false;
      return !!tailBuyHit.codes[tailBuyPureCode(s)];
    }

    // ===== batch25：选股页「尾盘选股法」——对当前「概念选股板块详情」的成分股跑同一套 8 项条件 =====
    // 与热门板块页的 runTailBuyFilter 算法完全一致（同一套特征口径、同一套 AI/规则分支），
    // 只是作用对象不同：这里针对 sectorDetail.data.stocks（选股页当前打开的概念选股板块详情）。
    const sectorTailBuyList = ref([]);
    const sectorTailBuyLoading = ref(false);
    const sectorTailBuyTotal = ref(0);
    const sectorTailBuyNote = ref('');

    async function runTailBuyForSector() {
      if (sectorTailBuyLoading.value) return;
      const rawPool = ((sectorDetail.data && sectorDetail.data.stocks) || []).slice();
      const pool = rawPool.filter(x => !isDelistedStock(x));
      const delistedCnt = rawPool.length - pool.length;
      sectorTailBuyList.value = []; sectorTailBuyTotal.value = 0; sectorTailBuyNote.value = '';
      if (!rawPool.length) {
        showToast('当前概念选股板块还没有成分股：请先在上方搜索板块 / 语义搜索并打开板块详情，再点「尾盘选股法」', 'error');
        return;
      }
      if (!pool.length) {
        showToast(`候选股票均为退市股（已剔除 ${delistedCnt} 只），无可筛选标的`, 'error');
        return;
      }
      sectorTailBuyLoading.value = true;
      clearTailBuyHits();
      showToast(`尾盘选股法：范围 = 当前板块 ${rawPool.length} 只，正在联网取实时行情与 20 日K线…`
        + (delistedCnt ? `（已先剔除 ${delistedCnt} 只退市股）` : ''), 'info');
      try {
        const norm = (x) => StockAPI.inferPrefix(String((x && x.code) || ''));
        const codes = pool.map(norm).filter(Boolean);
        let qmap = {};
        try { qmap = await StockAPI.getQuotes(codes); } catch (e) { qmap = {}; }
        const end = fmtDate(new Date());
        const start = fmtDate(new Date(Date.now() - 40 * 86400000));
        const feats = [];
        for (const x of pool) {
          const ncode = norm(x);
          const q = (qmap && qmap[ncode]) || x;
          const change = Number(q.changePercent != null ? q.changePercent : x.dailyChange);
          const turnover = Number(q.turnover != null ? q.turnover : (x.turnover || NaN));
          const cap = Number(q.totalMarketCap != null ? q.totalMarketCap : (x.totalMarketCap || NaN));
          const price = Number(q.price != null ? q.price : x.todayPrice);
          const amount = Number(q.amount || 0);
          const vol = Number(q.volume || 0);
          const low = Number(q.low || 0);
          const avg = (amount > 0 && vol > 0) ? (amount * 100 / vol) : 0;
          const aboveAvg = avg > 0 && price > avg;
          const pullback = avg > 0 && low < avg && price >= avg;
          let aboveMa = false, volRising = false, ma20 = NaN, vr = null, klineOk = true;
          let kline = [];
          try { kline = await StockAPI.getKline(ncode, start, end, 30); } catch (e) { kline = []; }
          if (!kline || kline.length < 20) { klineOk = false; }
          else {
            const closes = kline.map(k => Number(k.close));
            const vols = kline.map(k => Number(k.volume));
            ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            aboveMa = price > ma20;
            const vN = vols[vols.length - 1], v1 = vols[vols.length - 2], v2 = vols[vols.length - 3];
            volRising = vN > v1 && v1 > v2;
            try {
              const now = new Date();
              let mins = now.getHours() * 60 + now.getMinutes() - (9 * 60 + 30);
              if (now.getHours() >= 12) mins -= 60;
              mins = Math.max(1, mins);
              const avg5 = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
              if (avg5 > 0) vr = (vN / mins) / (avg5 / 240);
            } catch (e) {}
          }
          feats.push({ code: ncode, name: x.name || q.name || ncode, change, turnover, cap, price, ma20, aboveAvg, pullback, aboveMa, volRising, vr, klineOk });
        }
        sectorTailBuyTotal.value = pool.length;
        const fmtN = (x, d) => (isFinite(x) ? x.toFixed(d) : 'NA');
        const mkResult = (f) => ({
          code: f.code, name: f.name, changePercent: f.change,
          tip: `涨幅 ${fmtN(f.change, 2)}% · 换手 ${fmtN(f.turnover, 2)}% · 市值 ${fmtN(f.cap, 0)}亿`
            + (f.vr != null ? ` · 量比 ${fmtN(f.vr, 2)}` : '') + ` · 现价 ${fmtN(f.price, 2)} / 20日线 ${fmtN(f.ma20, 2)}`
        });
        // ① AI 精准筛选（与热门板块页同一口径）
        if (aiConfigured.value) {
          const pick = feats.slice(0, 50);
          const table = pick.map(f =>
            `${f.code} ${f.name} 涨幅=${fmtN(f.change, 2)}% 换手=${fmtN(f.turnover, 2)}% 市值=${fmtN(f.cap, 0)}亿 均价线上方=${f.aboveAvg ? '是' : '否'} 尾盘回抽=${f.pullback ? '是' : '否'} 20日线上方=${f.aboveMa ? '是' : '否'} 量能递增=${f.volRising ? '是' : '否'} 量比=${fmtN(f.vr, 2)}`
          ).join('\n');
          const sys = '你是资深 A 股量化选股助手，只依据下面给定的实时特征严格判定，不臆造数据、不列出特征表以外的股票。';
          const user = '尾盘买入法 8 项条件：①涨幅 3%-5% ②换手率 5%-10% ③市值 50亿-200亿 ④分时图在黄色均价线上方 ⑤尾盘回抽均价线 ⑥股价在 20 日线以上 ⑦近 3 日成交量持续放大 ⑧量比 1.5-2.5（量比仅供参考，不硬筛）。\n\n下面是候选股票的实时特征（已算好），请只保留**同时满足 ①②④⑤⑥⑦** 的股票（③市值若轻微超范围可放宽到 40亿-220亿，但需在 reason 里说明；⑧量比仅参考）：\n\n' + table + '\n\n请严格只输出一个 JSON 对象：{"pass":["股票代码",...],"reason":"一句话说明筛选口径与放宽项"}。不要输出 JSON 以外的任何内容。';
          const res = await callOpenAICompat([{ role: 'system', content: sys }, { role: 'user', content: user }], { timeoutMs: 60000, maxTokens: 500 });
          const byCode = {}; feats.forEach(f => { byCode[f.code] = f; });
          let passCodes = [];
          if (res.ok) {
            try {
              const m = res.content.match(/\{[\s\S]*\}/);
              const o = m ? JSON.parse(m[0]) : null;
              passCodes = (o && Array.isArray(o.pass)) ? o.pass.map(String) : [];
              sectorTailBuyNote.value = (o && o.reason ? o.reason : 'AI 精准筛选');
            } catch (e) { sectorTailBuyNote.value = 'AI 返回解析失败，已回退规则筛选'; }
          } else { sectorTailBuyNote.value = 'AI 筛选不可用（' + res.error + '），已回退规则筛选'; }
          const results = passCodes.map(c => byCode[c]).filter(Boolean).map(mkResult);
          sectorTailBuyList.value = results;
          markTailBuyHits(results);
          showToast(`AI 尾盘选股命中 ${results.length} 只（已在板块成分股中标红）`, results.length ? 'success' : 'info');
          return;
        }
        // ② 规则法
        const realtime = feats.filter(f =>
          f.change >= 3 && f.change <= 5 && f.turnover >= 5 && f.turnover <= 10
          && f.cap >= 50 && f.cap <= 200 && f.aboveAvg && f.pullback);
        if (!realtime.length) {
          sectorTailBuyNote.value = '实时行情条件（涨幅3-5% / 换手率5-10% / 市值50-200亿 / 分时均价线上方 / 尾盘回抽）无命中';
          showToast('尾盘选股法：实时行情条件无命中', 'info');
          return;
        }
        const results = [];
        let noKline = 0;
        for (const f of realtime) {
          if (!f.klineOk) { noKline++; continue; }
          if (!(f.aboveMa && f.volRising)) continue;
          results.push(mkResult(f));
        }
        sectorTailBuyList.value = results;
        markTailBuyHits(results);
        const delistedTag = delistedCnt ? `已剔除 ${delistedCnt} 只退市股 · ` : '';
        if (noKline) sectorTailBuyNote.value = delistedTag + `${noKline} 只因K线不足 20 日跳过（上市未满 20 日）`;
        else if (!results.length) sectorTailBuyNote.value = delistedTag + '均线 / 成交量条件无命中';
        else sectorTailBuyNote.value = delistedCnt ? `已剔除 ${delistedCnt} 只退市股` : '';
        showToast(`尾盘选股法：命中 ${results.length} 只（已在板块成分股中标红）`, results.length ? 'success' : 'info');
      } catch (e) {
        console.warn('尾盘选股法筛选失败', e);
        showToast('尾盘选股法筛选失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        sectorTailBuyLoading.value = false;
      }
    }
    /** 清空选股页尾盘选股法结果（切换板块详情时调用，避免旧结果残留） */
    function clearSectorTailBuy() {
      sectorTailBuyList.value = []; sectorTailBuyTotal.value = 0; sectorTailBuyNote.value = '';
      clearTailBuyHits();
    }

    async function runTailBuyFilter() {
      if (tailBuyLoading.value) return;
      // 筛选范围 = 下方「板块成分股」成分表**当前实际显示的**股票。
      // batch27 修复：原来直接读 hotFilterStocks，只覆盖「热门板块 / 全A筛选」这一条载入路径；
      // 当用户通过尾盘面板的「筛选板块」下拉选了「我的概念选股板块」（poolId = 's-<id>'）时，
      // 成分表能显示（filterPoolStocks 的 's-<id>' 分支），但 hotFilterStocks 仍为空 →
      // 误报「暂无股票」。现改为统一取 filterPoolStocks（已支持 hot / s-<id> / p-<id> 三种来源），
      // 与成分表所见完全一致。
      const rawPool = (filterPoolStocks.value || []).slice();
      // 兜底：若 poolId 未设置但 hotFilterStocks 有数据（历史路径），仍按热门明细筛选
      if (!rawPool.length && (hotFilterStocks.value || []).length) {
        rawPool.push(...hotFilterStocks.value);
      }
      // 筛选前先剔除退市股票（名称含「退」或已无有效行情），避免退市股进入候选
      const pool = rawPool.filter(s => !isDelistedStock(s));
      const delistedCnt = rawPool.length - pool.length;
      clearTailBuyHits();
      if (!rawPool.length) {
        tailBuyList.value = []; tailBuyTotal.value = 0; tailBuyNote.value = '';
        showToast('「板块成分股」暂无股票：请先用上方「筛选板块」下拉选择板块（或在热门板块页点板块 / 个股载入成分股），再开始筛选', 'error');
        return;
      }
      if (!pool.length) {
        tailBuyList.value = []; tailBuyTotal.value = 0; tailBuyNote.value = '';
        showToast(`候选股票均为退市股（已剔除 ${delistedCnt} 只），无可筛选标的`, 'error');
        return;
      }
      const scopeTag = `板块成分股${rawPool.length} 只`;
      tailBuyLoading.value = true;
      tailBuyList.value = []; tailBuyNote.value = '';
      showToast(`尾盘买入法：范围 = ${scopeTag}，正在联网取实时行情与 20 日K线…`
        + (delistedCnt ? `（已先剔除 ${delistedCnt} 只退市股）` : ''), 'info');
      try {
        const norm = (s) => StockAPI.inferPrefix(String((s && s.code) || ''));
        const codes = pool.map(norm).filter(Boolean);
        let qmap = {};
        try { qmap = await StockAPI.getQuotes(codes); } catch (e) { qmap = {}; }
        // 1) 给每只候选计算 8 项实时特征向量（与规则法同口径，一次性算好，AI 与规则法共用）
        const end = fmtDate(new Date());
        const start = fmtDate(new Date(Date.now() - 40 * 86400000));
        const feats = [];
        for (const s of pool) {
          const ncode = norm(s);
          const q = (qmap && qmap[ncode]) || s;
          const change = Number(q.changePercent != null ? q.changePercent : s.dailyChange);
          const turnover = Number(q.turnover != null ? q.turnover : (s.turnover || NaN));
          const cap = Number(q.totalMarketCap != null ? q.totalMarketCap : (s.totalMarketCap || NaN)); // 亿
          const price = Number(q.price != null ? q.price : s.todayPrice);
          const amount = Number(q.amount || 0);   // 万
          const vol = Number(q.volume || 0);       // 手
          const low = Number(q.low || 0);
          const avg = (amount > 0 && vol > 0) ? (amount * 100 / vol) : 0;  // 当日均价（元）
          const aboveAvg = avg > 0 && price > avg;                  // 分时图在黄色均价线上方
          const pullback = avg > 0 && low < avg && price >= avg;    // 尾盘回抽均价线
          let aboveMa = false, volRising = false, ma20 = NaN, vr = null, klineOk = true;
          let kline = [];
          try { kline = await StockAPI.getKline(ncode, start, end, 30); } catch (e) { kline = []; }
          if (!kline || kline.length < 20) { klineOk = false; }
          else {
            const closes = kline.map(k => Number(k.close));
            const vols = kline.map(k => Number(k.volume));
            ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            aboveMa = price > ma20;                       // 20日线以上
            const vN = vols[vols.length - 1], v1 = vols[vols.length - 2], v2 = vols[vols.length - 3];
            volRising = vN > v1 && v1 > v2;               // 成交量持续放大（近 3 日递增）
            try {
              const now = new Date();
              let mins = now.getHours() * 60 + now.getMinutes() - (9 * 60 + 30);
              if (now.getHours() >= 12) mins -= 60;       // 扣除午休
              mins = Math.max(1, mins);
              const avg5 = vols.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
              if (avg5 > 0) vr = (vN / mins) / (avg5 / 240);  // 量比代理
            } catch (e) {}
          }
          feats.push({ code: ncode, name: s.name || q.name || ncode, change, turnover, cap, price, ma20, aboveAvg, pullback, aboveMa, volRising, vr, klineOk });
        }
        tailBuyTotal.value = pool.length;
        const fmtN = (x, d) => (isFinite(x) ? x.toFixed(d) : 'NA');
        // 2) 已配置 AI 接口 → 交 AI 按 8 项条件精准判定
        if (aiConfigured.value) {
          const pick = feats.slice(0, 50);
          const usedCap = feats.length > 50;
          const table = pick.map(f =>
            `${f.code} ${f.name} 涨幅=${fmtN(f.change, 2)}% 换手=${fmtN(f.turnover, 2)}% 市值=${fmtN(f.cap, 0)}亿 均价线上方=${f.aboveAvg ? '是' : '否'} 尾盘回抽=${f.pullback ? '是' : '否'} 20日线上方=${f.aboveMa ? '是' : '否'} 量能递增=${f.volRising ? '是' : '否'} 量比=${fmtN(f.vr, 2)}`
          ).join('\n');
          const sys = '你是资深 A 股量化选股助手，只依据下面给定的实时特征严格判定，不臆造数据、不列出特征表以外的股票。';
          const user = '尾盘买入法 8 项条件：①涨幅 3%-5% ②换手率 5%-10% ③市值 50亿-200亿 ④分时图在黄色均价线上方 ⑤尾盘回抽均价线 ⑥股价在 20 日线以上 ⑦近 3 日成交量持续放大 ⑧量比 1.5-2.5（量比仅供参考，不硬筛）。\n\n下面是候选股票的实时特征（已算好），请只保留**同时满足 ①②④⑤⑥⑦** 的股票（③市值若轻微超范围可放宽到 40亿-220亿，但需在 reason 里说明；⑧量比仅参考）：\n\n' + table + '\n\n请严格只输出一个 JSON 对象：{"pass":["股票代码",...],"reason":"一句话说明筛选口径与放宽项"}。不要输出 JSON 以外的任何内容。';
          const res = await callOpenAICompat([
            { role: 'system', content: sys },
            { role: 'user', content: user }
          ], { timeoutMs: 60000, maxTokens: 500 });
          const byCode = {};
          feats.forEach(f => { byCode[f.code] = f; });
          let passCodes = [];
          if (res.ok) {
            try {
              const m = res.content.match(/\{[\s\S]*\}/);
              const o = m ? JSON.parse(m[0]) : null;
              passCodes = (o && Array.isArray(o.pass)) ? o.pass.map(String) : [];
              tailBuyNote.value = `范围：概念选股板块（${scopeTag}） · ` + (o && o.reason ? o.reason : 'AI 精准筛选')
                + (usedCap ? '（候选超 50 只，已对前 50 只精筛）' : '');
            } catch (e) {
              passCodes = [];
              tailBuyNote.value = `范围：概念选股板块（${scopeTag}） · AI 返回解析失败，已回退规则筛选`;
            }
          } else {
            tailBuyNote.value = `范围：概念选股板块（${scopeTag}） · AI 筛选不可用（` + res.error + '），已回退规则筛选';
          }
          const results = passCodes.map(c => byCode[c]).filter(Boolean).map(f => ({
            code: f.code, name: f.name, changePercent: f.change,
            tip: `涨幅 ${fmtN(f.change, 2)}% · 换手 ${fmtN(f.turnover, 2)}% · 市值 ${fmtN(f.cap, 0)}亿`
              + (f.vr != null ? ` · 量比 ${fmtN(f.vr, 2)}` : '') + ` · 现价 ${fmtN(f.price, 2)} / 20日线 ${fmtN(f.ma20, 2)}`
          }));
          tailBuyList.value = results;
          markTailBuyHits(results);
          showToast(`AI 精准筛选命中 ${results.length} 只（已在下表标红）`, results.length ? 'success' : 'info');
          return;
        }
        // 3) 规则法（未配置 AI 时回退，与 batch19 原逻辑一致）
        const realtime = feats.filter(f =>
          f.change >= 3 && f.change <= 5 && f.turnover >= 5 && f.turnover <= 10
          && f.cap >= 50 && f.cap <= 200 && f.aboveAvg && f.pullback);
        if (!realtime.length) {
          tailBuyNote.value = '实时行情条件（涨幅3-5% / 换手率5-10% / 市值50-200亿 / 分时均价线上方 / 尾盘回抽）无命中';
          showToast('尾盘买入法：实时行情条件无命中', 'info');
          return;
        }
        const results = [];
        let noKline = 0;
        for (const f of realtime) {
          if (!f.klineOk) { noKline++; continue; }
          if (!(f.aboveMa && f.volRising)) continue;
          results.push({
            code: f.code, name: f.name, changePercent: f.change,
            tip: `涨幅 ${fmtN(f.change, 2)}% · 换手 ${fmtN(f.turnover, 2)}% · 市值 ${fmtN(f.cap, 0)}亿`
              + (f.vr != null ? ` · 量比 ${fmtN(f.vr, 2)}` : '') + ` · 现价 ${fmtN(f.price, 2)} / 20日线 ${fmtN(f.ma20, 2)}`
          });
        }
        tailBuyList.value = results;
        markTailBuyHits(results);
        const delistedTag = `范围：概念选股板块（${scopeTag}） · ` + (delistedCnt ? `已剔除 ${delistedCnt} 只退市股 · ` : '');
        if (noKline) tailBuyNote.value = delistedTag + `${noKline} 只因K线不足 20 日跳过（上市未满 20 日）`;
        else if (!results.length) tailBuyNote.value = delistedTag + '均线 / 成交量条件无命中';
        else tailBuyNote.value = delistedCnt ? `已剔除 ${delistedCnt} 只退市股` : '';
        showToast(`尾盘买入法：命中 ${results.length} 只${delistedCnt ? `（已剔除 ${delistedCnt} 只退市股）` : ''}`, results.length ? 'success' : 'info');
      } catch (e) {
        console.warn('尾盘买入法筛选失败', e);
        showToast('尾盘买入法筛选失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        tailBuyLoading.value = false;
      }
    }

    // ===== 尾盘买入法 · 对 A 股全部股票筛选（先弹窗选剔除规则，再全网拉取并载入「筛选板块」） =====
    // 需求：对 A 股所有股票进行筛选，筛选前弹窗提示，可去除①北交所 ②688开头 ③科创板 ④创业板 ⑤ST股；
    // 符合条件的股票放进下方「板块成分股」显示。
    const allAFilter = reactive({
      show: false,
      loading: false,
      // 剔除规则（默认全部勾选，符合「先剔除」的诉求；会话内记住）
      noBj: true,        // 去除北交所（4/8/92 开头）
      no688: true,       // 去除 688 开头
      noStar: true,      // 去除科创板（688/689）
      noChiNext: true,   // 去除创业板（300/301）
      noST: true         // 去除 ST/*ST
    });
    /** 打开「对 A 股全部股票筛选」弹窗（筛选前提示） */
    function askAllAFilter() {
      if (allAFilter.loading) return;
      allAFilter.show = true;
    }
    // ===== batch26：尾盘买入法面板内的「筛选板块」下拉 =====
    // 需求：把原「🌐 对A股全部股票筛选」按钮改为下拉菜单；下拉列出「我的概念选股板块」的各板块，
    // 选中后该板块成分股直接展示在下方成分表（sortedFilterStocks）中。
    // batch27：按用户要求去除「全市场」项，下拉只剩「我的概念选股板块」。
    // （askAllAFilter / confirmAllAFilter 保留为内部能力，当前无 UI 入口调用。）
    const tailPoolPick = ref('');
    function onTailPoolChange() {
      const v = tailPoolPick.value;
      if (!v) {
        // 取消选择：清空成分表
        filterPanel.poolId = '';
        hotFilterStocks.value = [];
        tailBuyList.value = []; tailBuyTotal.value = 0; tailBuyNote.value = '';
        clearTailBuyHits();
        return;
      }
      // 我的概念选股板块：直接把 poolId 指到该板块，成分表自动渲染其成分股（filterPoolStocks 已支持 's-<id>'）
      if (!filterPanel.locked) resetHotFilterRanges();
      filterPanel.poolId = v;
      const sp = (D.sectorPools || []).find(p => 's-' + p.id === v);
      const n = sp ? (sp.stocks || []).length : 0;
      // 让「板块成分股」表所在面板同步滚动可见（与栏目联动）
      hotBoardActive.value = sp ? sp.name : '';
      tailBuyList.value = []; tailBuyTotal.value = 0; tailBuyNote.value = '';
      clearTailBuyHits();
      if (sp && !n) {
        showToast(`「${sp.name}」暂无成分股：请到「选股」页打开该板块并补充成分股`, 'error');
      } else if (sp) {
        showToast(`已载入「${sp.name}」成分股 ${n} 只，显示在下方成分表`, 'success');
      }
    }
    function cancelAllAFilter() { allAFilter.show = false; }
    /**
     * A 股全网筛选：拉取全部 A 股 → 按弹窗勾选的规则剔除 → 载入下方「板块成分股」。
     * 与「热门板块」载入成分股同一套写入路径（hotFilterStocks + Store daily stocks），
     * 保证字段与格式完全一致。
     */
    async function confirmAllAFilter() {
      allAFilter.show = false;
      if (allAFilter.loading) return;
      allAFilter.loading = true;
      tailBuyLoading.value = true;   // 复用尾盘面板的 loading 展示
      hotFilterStocks.value = [];
      tailBuyList.value = []; tailBuyTotal.value = 0; tailBuyNote.value = '';
      showToast('正在拉取 A 股全部股票行情…', 'info');
      try {
        const all = await StockAPI.getAllAStocks((done, total) => {
          if (done % 500 === 0) showToast(`正在拉取 A 股全部股票… ${done}/${total}`, 'info');
        });
        if (!all || !all.length) {
          showToast('未获取到 A 股行情（可能受网络/接口限流），请稍后重试', 'error');
          return;
        }
        // 剔除规则判定（代码前缀 + 名称 + 退市）
        const excluded = (s) => {
          const pure = String(pureCode(s.code) || '');
          const name = String(s.name || '');
          if (isDelistedStock({ name: name, code: s.code, price: s.price, changePercent: s.changePercent })) return true; // 退市股始终剔除
          if (allAFilter.noBj && /^(4|8|92)/.test(pure)) return true;
          if (allAFilter.noStar && /^(688|689)/.test(pure)) return true;
          if (allAFilter.no688 && /^688/.test(pure)) return true;
          if (allAFilter.noChiNext && /^(300|301)/.test(pure)) return true;
          if (allAFilter.noST && /ST/i.test(name)) return true;
          return false;
        };
        const list = all.filter(s => !excluded(s));
        const removed = all.length - list.length;
        if (!list.length) {
          showToast('全部股票均被所选规则剔除，请放宽条件后重试', 'error');
          return;
        }
        // 载入「板块成分股」，字段与热门板块成分股一致
        const daily = Store.getDailyStocks(hotDate.value);
        daily.stocks = list.map(s => {
          const ns = _newStock(s);
          ns.dailyChange = s.changePercent;
          ns.todayPrice = s.price;
          if (s.marketCap != null) ns.totalMarketCap = s.marketCap;
          return ns;
        });
        hotBoardActive.value = `A股全部（剔除后 ${list.length} 只）`;
        hotDetailIsStock.value = false;
        if (!filterPanel.locked) resetHotFilterRanges();
        filterPanel.poolId = 'hot';
        tailPoolPick.value = '__allA__';   // batch26：同步尾盘面板下拉显示
        hotFilterStocks.value = daily.stocks;
        showToast(`A 股全部筛选完成：保留 ${list.length} 只（已剔除 ${removed} 只），已载入「板块成分股」`, 'success');
        // 复用既有补全逻辑刷新字段
        await refreshHotStocks();
      } catch (e) {
        console.warn('A 股全部筛选失败', e);
        showToast('A 股全部筛选失败：' + (e && e.message ? e.message : e), 'error');
      } finally {
        allAFilter.loading = false;
        tailBuyLoading.value = false;
      }
    }

    // ============================================================
    //  筛选板块（热门板块页 · 板块筛选 + 市值比区间筛选）
    // ============================================================
    const filterPanel = reactive({
      show: false,
      poolId: '',       // 's-板块id' 或 'p-股票池id'
      locked: false,      // 是否固定筛选区间（切换板块/重置时保持不变）
      pbMin: null, pbMax: null,   // 市净比区间
      pkMin: null, pkMax: null,   // 市扣比区间
      prMin: null, prMax: null,   // 市营比区间
      q24Min: null, q24Max: null,   // 24营比区间
      q24kMin: null, q24kMax: null, // 24扣比区间
      posMin: null, posMax: null,   // 正数统计区间（今涨跌→扣非环比 中为正的字段个数）
      ratioFilter: false,            // 比值筛选：924涨跌 < 24营比 + 24扣比
      industry: '',                  // 行业筛选（单选下拉，兼容旧值）
      industries: [],                // 行业筛选（多选勾选，与 sector 详情一致；勾选优先于 industry）
      mainBusiness: ''               // 主业产品筛选：关键字模糊匹配「主业与主要产品」文本，'' 表示不限
    });
    const filterIndustryOpen = ref(false); // 筛选栏「行业」勾选下拉是否展开
    // 各表初始列宽（px）：与 STOCK_COLUMNS 宽度一一对应（见下方 SORT_STATES 之后的定义）。

    // 列宽拖拽调整（鼠标拖动非冻结列右边缘）。通用：传入表格选择器、对应的存储键、
    // 以及初始列宽数组，以便「筛选板块」与「概念板块详情弹窗」各自独立保存列宽，
    // 且首次打开即有贴合内容的合理初始宽度。
    /**
     * 按 <colgroup> 各列「实际宽度」累加，动态写入冻结列的 left 偏移。
     * 冻结列宽度可被用户拖拽改变，若 left 仍用硬编码值，就会出现表头与内容错位、
     * 冻结列相互重叠或与滚动列之间留出无法消除的空档——故每次列宽变化后都必须同步。
     */
    function syncStickyOffsets(table) {
      if (!table) return;
      const cols = table.querySelectorAll('colgroup col');
      if (!cols.length) return;
      let acc = 0;
      for (let i = 0; i < cols.length; i++) {
        const cells = table.querySelectorAll('.col-sticky-' + i);
        if (!cells.length) break;                 // 已越过最后一个冻结列
        const left = acc + 'px';
        cells.forEach(c => { c.style.left = left; });
        acc += parseFloat(cols[i].style.width) || cols[i].getBoundingClientRect().width || 0;
      }
    }

    function initColResize(tableSelector, storageKey, defaultWidths) {
      const table = document.querySelector(tableSelector);
      if (!table) return;
      const header = table.querySelector('thead tr');
      if (!header) return;
      const ths = [...header.children];
      const thead = table.querySelector('thead');
      let colgroup = table.querySelector('colgroup');
      if (!colgroup) { colgroup = document.createElement('colgroup'); table.insertBefore(colgroup, thead); }
      const saved = Store.data[storageKey] || {};
      ths.forEach((th, i) => {
        // 列宽按「列 key」存储（而非索引），这样重排列后已保存的自定义宽度仍能正确对应到列
        const m = th.className.match(/col-([A-Za-z0-9_]+)/);
        const key = th.getAttribute('data-colkey') || (m ? m[1] : null);
        let col = colgroup.children[i];
        if (!col) { col = document.createElement('col'); colgroup.appendChild(col); }
        if (key) col.setAttribute('data-colkey', key);
        let w;
        if (key != null && saved[key] != null) w = saved[key];
        else if (defaultWidths && defaultWidths[i] != null) w = defaultWidths[i];
        else w = Math.round(th.getBoundingClientRect().width);
        col.style.width = w + 'px';
      });
      while (colgroup.children.length > ths.length) colgroup.removeChild(colgroup.lastChild);
      const applyTotal = () => {
        let total = 0;
        [...colgroup.children].forEach(c => { total += parseFloat(c.style.width) || 0; });
        table.style.width = total + 'px';
        // 表格总宽变化后，同步刷新屏幕最下方横向滚动条的可滚动宽度
        if (window.__ghostSync) window.__ghostSync();
      };
      applyTotal();
      syncStickyOffsets(table);
      ths.forEach((th, i) => {
        // 冻结列同样可拖拽调宽（拖后由 syncStickyOffsets 实时重算 left，保证不错位）
        if (th.querySelector('.col-resize-handle')) return;
        const h = document.createElement('div');
        h.className = 'col-resize-handle';
        h.addEventListener('mousedown', e => startColResize(e, i, table, applyTotal, storageKey));
        th.appendChild(h);
      });
    }
    function startColResize(e, colIndex, table, applyTotal, storageKey) {
      e.preventDefault(); e.stopPropagation();
      const col = table.querySelector('colgroup').children[colIndex];
      const startX = e.clientX;
      const startW = parseFloat(col.style.width) || 80;
      const colKey = col.getAttribute('data-colkey');
      const onMove = ev => {
        const w = Math.max(40, startW + (ev.clientX - startX));
        col.style.width = w + 'px';
        applyTotal();
        syncStickyOffsets(table);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const widths = Object.assign({}, Store.data[storageKey] || {});
        if (colKey != null) widths[colKey] = parseFloat(col.style.width);
        else widths[colIndex] = parseFloat(col.style.width);
        Store.data[storageKey] = widths;
        Store.saveNow();   // 立即落盘，避免刷新后列宽丢失
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    /** 当前板块成分股涉及的全部行业（去重、中文排序），供行业下拉筛选 */
    const filterIndustries = computed(() => {
      const set = new Set();
      filterPoolStocks.value.forEach(s => set.add(s.industry || '未知'));
      return [...set].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    });
    function openFilterPanel() {
      filterPanel.show = true;
    }
    /** 一键固定/取消固定筛选区间：固定后切换板块、重置均不再清空已填的区间值 */
    function toggleFilterLock() {
      filterPanel.locked = !filterPanel.locked;
      if (filterPanel.locked) {
        showToast('已固定筛选区间，切换板块/重置将保留当前区间', 'success');
      } else {
        showToast('已取消固定筛选区间', 'info');
      }
    }
    function resetFilter() {
      if (filterPanel.locked) {
        showToast('筛选区间已固定，请先点击「固定筛选」解锁后再重置', 'error');
        return;
      }
      filterPanel.poolId = '';
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
      hotFilterStocks.value = [];   // 同步清空热门板块联动的筛选列表
    }
    /** 切换板块后重置区间筛选；若已固定则保留区间 */
    function applyFilterPool() {
      if (filterPanel.locked) return;
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
    }
    /** 切换热门板块时清空筛选区间（不触碰 poolId，由调用方设置）；调用方需自行判断「固定筛选」开关 */
    function resetHotFilterRanges() {
      filterPanel.pbMin = null; filterPanel.pbMax = null;
      filterPanel.pkMin = null; filterPanel.pkMax = null;
      filterPanel.prMin = null; filterPanel.prMax = null;
      filterPanel.q24Min = null; filterPanel.q24Max = null;
      filterPanel.q24kMin = null; filterPanel.q24kMax = null;
      filterPanel.posMin = null; filterPanel.posMax = null;
      filterPanel.ratioFilter = false; filterPanel.industry = '';
      filterPanel.industries = []; filterPanel.mainBusiness = '';
    }
    /** 区间判断工具：v 在 [min,max] 内（含边界），边界均为空则不限（含 null） */
    function inRange(v, min, max) {
      if (min == null && max == null) return true;   // 未设边界，全部通过
      if (v == null || isNaN(v)) return false;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
      return true;
    }
    /** 所选板块的所有原始股票 */
    const filterPoolStocks = computed(() => {
      const id = filterPanel.poolId;
      if (!id) return [];
      if (id === 'hot') return hotFilterStocks.value;   // 点击热门板块 4 子版块载入的成分股
      if (id.startsWith('s-')) {
        const sp = (D.sectorPools || []).find(p => 's-' + p.id === id);
        return sp ? (sp.stocks || []) : [];
      }
      const pp = (D.stockPools || []).find(p => 'p-' + p.id === id);
      return pp ? (pp.stocks || []) : [];
    });
    /**
     * 通用区间/比值/行业筛选：对单只股票 s 应用筛选对象 f。
     * f 需包含 pbMin/pbMax/pkMin/pkMax/prMin/prMax/q24Min/q24Max/q24kMin/q24kMax/
     * posMin/posMax/ratioFilter/industry。筛选板块与板块详情共用同一套规则。
     */
    function passFilter(s, f) {
      const r = sRatio(s);
      if (!inRange(r.pbRatio, f.pbMin, f.pbMax)) return false;
      if (!inRange(r.pkRatio, f.pkMin, f.pkMax)) return false;
      if (!inRange(r.prRatio, f.prMin, f.prMax)) return false;
      if (!inRange(s.q24Rev, f.q24Min, f.q24Max)) return false;
      if (!inRange(s.q24Kcf, f.q24kMin, f.q24kMax)) return false;
      if (!inRange(positiveCount(s), f.posMin, f.posMax)) return false;
      // 行业筛选
      // 行业筛选：兼容「单选字符串(industry)」与「多选勾选(industries 数组)」
      {
        const multi = (f.industries && f.industries.length) ? f.industries : null;
        const picked = multi || (f.industry ? [f.industry] : []);
        if (picked.length && picked.indexOf(s.industry || '未知') === -1) return false;
      }
      // 比值筛选：924涨跌 < 24营比/2 + 24扣比/2（924涨跌 小于二者均值，三值均须有效）
      if (f.ratioFilter) {
        const c9 = s.change924, rv = s.q24Rev, kc = s.q24Kcf;
        if (c9 == null || isNaN(c9) || rv == null || isNaN(rv) || kc == null || isNaN(kc)) return false;
        if (!(c9 < rv / 2 + kc / 2)) return false;
      }
      // 主业产品筛选：关键字模糊匹配「主业与主要产品」文本（mainBusiness 为 {name,ratio} 数组）
      if (f.mainBusiness && f.mainBusiness.trim()) {
        const kw = f.mainBusiness.trim();
        const mb = s.mainBusiness;
        const text = Array.isArray(mb)
          ? mb.map(x => (x && x.name) || x).join(' ')
          : (mb ? String(mb) : '');
        if (text.indexOf(kw) === -1) return false;
      }
      return true;
    }
    /** 按板块 + 市净比/市扣比/市营比/24营比/24扣比区间过滤后的股票 */
    const filteredFilterStocks = computed(() => {
      return filterPoolStocks.value.filter(s => passFilter(s, filterPanel));
    });

    // 筛选结果排序
    const filterSort = reactive({ key: 'dailyChange', dir: 'desc' });
    const sortedFilterStocks = computed(() => {
      const list = [...filteredFilterStocks.value];
      const k = filterSort.key;
      const dir = filterSort.dir === 'asc' ? 1 : -1;
      if (k === '__idx') {
        const pos = new Map(list.map((s, i) => [s, i]));
        list.sort((a, b) => (pos.get(a) - pos.get(b)) * dir);
      } else {
        list.sort((a, b) => compareForSort(a, b, k) * dir);
      }
      return list;
    });
    function sortFilterBy(key) {
      if (filterSort.key === key) {
        filterSort.dir = filterSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        filterSort.key = key;
        filterSort.dir = 'desc';
      }
    }
    function filterSortIcon(key) {
      if (filterSort.key !== key) return '⇅';
      return filterSort.dir === 'asc' ? '↑' : '↓';
    }

    // 四表排序状态汇总（此时 filterSort/poolDetailSort/sectorDetailSort 均已声明）
    const SORT_STATES = { fav: favSort, filter: filterSort, pool: poolDetailSort, sector: sectorDetailSort, hot: hotSort };

    // 列宽默认值：与 STOCK_COLUMNS 宽度一一对应（收藏表额外 3 列）
    const STOCK_COL_WIDTHS = STOCK_COLUMNS.map(c => c.width);
    const FAV_COL_WIDTHS = STOCK_COL_WIDTHS.concat(FAV_EXTRA_COLUMNS.map(c => c.width));
    const FILTER_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const SECTOR_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const POOL_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    const FAV_DEFAULT_COL_WIDTHS = FAV_COL_WIDTHS;
    const HOT_DEFAULT_COL_WIDTHS = STOCK_COL_WIDTHS;
    // 列宽拖拽：初次挂载、切到对应页/打开弹窗、以及列表变化后均重新初始化（幂等）
    // 五张股票表（筛选 / 概念详情 / 股票池详情 / 收藏 / 当日股票明细）各自独立保存列宽
    const initResizeFor = (sel, key, widths) => {
      const el = document.querySelector(sel);
      if (el) initColResize(sel, key, widths);
    };
    /**
     * 把表格的横向滚动条「复制」一份固定在屏幕最下方：
     * 表格自带横向滚动条位于容器底部，纵向翻页时会随容器一起上移甚至移出视口，
     * 想左右拉动就得先滚到容器底部。这里用一个 fixed 底栏与真实滚动容器双向同步 scrollLeft，
     * 使其永远停留在屏幕最下方。
     */
    function initGhostHScroll() {
      let bar = document.getElementById('ghost-hscroll');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ghost-hscroll';
        bar.innerHTML = '<div class="ghs-spacer"></div>';
        document.body.appendChild(bar);
      }
      const spacer = bar.querySelector('.ghs-spacer');
      let target = null;    // 当前同步的真实滚动容器
      let lock = false;     // 防止双向同步互相触发形成回环
      let queued = false;

      /** 向上找到真正产生横向滚动的容器 */
      const containerOf = (tb) => {
        let el = tb.parentElement;
        while (el && el !== document.body) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === 'auto' || ox === 'scroll') return el;
          el = el.parentElement;
        }
        return null;
      };
      /** 选取当前视口内可见面积最大、且确实横向溢出的表格容器 */
      const pick = () => {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        // 有弹窗打开时，只认最上层弹窗内的表格（否则会误选被遮住的页面表格）
        const overlays = [...document.querySelectorAll('.modal-overlay')].filter(o => o.offsetParent !== null);
        const scope = overlays.length ? overlays[overlays.length - 1] : document;
        let best = null, bestArea = 0;
        for (const tb of scope.querySelectorAll('.pool-detail-table')) {
          if (!tb.offsetParent) continue;
          const box = containerOf(tb);
          if (!box || box.scrollWidth - box.clientWidth < 4) continue;
          const r = tb.getBoundingClientRect();
          const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
          if (visible <= 0) continue;
          const area = visible * Math.min(r.width, vw);
          if (area > bestArea) { bestArea = area; best = box; }
        }
        return best;
      };
      const sync = () => {
        const t = pick();
        target = t;
        if (!t) { bar.classList.remove('show'); return; }
        bar.classList.add('show');
        spacer.style.width = t.scrollWidth + 'px';
        if (Math.abs(bar.scrollLeft - t.scrollLeft) > 1) {
          lock = true;
          bar.scrollLeft = t.scrollLeft;
          requestAnimationFrame(() => { lock = false; });
        }
      };
      const scheduleSync = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; sync(); });
      };

      // 拖动底栏 → 同步给真实表格容器
      bar.addEventListener('scroll', () => {
        if (lock || !target) return;
        lock = true;
        target.scrollLeft = bar.scrollLeft;
        requestAnimationFrame(() => { lock = false; });
      });
      // scroll 事件不冒泡，用捕获阶段统一监听（页面滚动 / 弹窗内滚动 / 容器横向滚动）
      document.addEventListener('scroll', (e) => {
        if (lock) return;
        if (e.target === target) {
          lock = true;
          bar.scrollLeft = e.target.scrollLeft;
          requestAnimationFrame(() => { lock = false; });
        } else {
          scheduleSync();
        }
      }, true);
      window.addEventListener('resize', scheduleSync);
      // 弹窗开关、翻页、数据刷新等 DOM 变化后重新判定当前该同步哪张表
      if (window.MutationObserver) {
        new MutationObserver(scheduleSync).observe(document.body, { childList: true, subtree: true });
      }
      window.__ghostSync = scheduleSync;   // 供列宽拖拽后主动刷新底栏宽度
      sync();
    }

    onMounted(() => {
      // batch57：防御浏览器「表单自动填充 / 会话恢复」把上次搜过的关键词回填进搜索框。
      // 业务上 briefKeyword 默认就是空，这里挂载时再强行清一次，保证两个每日快讯搜索框在任意设备都默认为空。
      try { briefKeyword.value = ''; } catch (e) { /* ignore */ }
      // 进入系统后补写本次登录的 IP / 归属地 / 设备（异步、失败不影响使用）
      syncLoginMeta();
      // 账号隔离上线后，本账号的持仓若是从旧共享数据里认领过来的，明确告知一声
      // （旧版本所有账号共用一份数据，只有持仓本来就是按用户名分开存的）
      if (Store.migratedHoldings) {
        showToast('已把你在旧版本的 ' + Store.migratedHoldings + ' 条持仓搬到本账号；其他数据属于各自账号，不会互相继承', 'info');
      }
      nextTick(() => {
        initGhostHScroll();
        // batch42：备注列默认宽度 132 → 240。若用户曾在旧版拖窄过备注列，Store 里存着的旧宽度会盖掉新默认值，
        // 表现就是"明明说要加长，怎么没变"。这里一次性清掉五张表里 __note 这一列的旧存值（只清这一列，不动别的），
        // 用 noteColW2 标记保证只跑一次 —— 之后用户再拖会正常记住，不会被每次刷新重置。
        // 只清「比新默认值小的」存值：用户要是自己拖得更宽，那是他的选择，保留。
        try {
          if (Store.data && !Store.data.noteColW2) {
            for (const k of ['favColWidths', 'filterColWidths', 'poolColWidths', 'sectorColWidths', 'hotColWidths']) {
              const m = Store.data[k];
              if (m && typeof m === 'object' && typeof m.__note === 'number' && m.__note < 240) delete m.__note;
            }
            Store.data.noteColW2 = true;
          }
        } catch (e) { /* 老数据异常不影响使用 */ }
        initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS);
        if (currentPage.value === 'filter') {
          initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS);
        }
        if (currentPage.value === 'hot') {
          initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS);
        }
      });
      // 点击页面其他位置时收起用户菜单（菜单内部与触发按钮已用 @click.stop 阻止冒泡）
      document.addEventListener('click', () => { userMenuOpen.value = false; });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') userMenuOpen.value = false;
      });

      // batch60：回顶按钮——监听页面滚动（passive，不阻塞滚动渲染）
      window.addEventListener('scroll', _updateBackTop, { passive: true });
      _updateBackTop();

      // ===== 注册申请提醒 =====
      // 初次扫描（例如刷新页面后发现有待审核）＋ 消费注册者发来的导入链接
      scanPending();
      // 页面已经开着时点导入链接只换 hash、浏览器不会重载，交给这个回调处理
      if (typeof AuthUI !== 'undefined' && AuthUI.setImportHandler) {
        AuthUI.setImportHandler(consumeImportLink);
      }
      consumeImportLink();
      // 同一浏览器其他标签页写入账号表（同设备另开窗口注册）时立即刷新
      window.addEventListener('storage', (e) => {
        if (e.key === 'snt-auth-users-v1') scanPending();
      });
      // 兜底轮询：**只读 localStorage，不产生任何网络请求**，因此与
      // 「暂停数据刷新」的约定（进入页面不自动抓取数据）不冲突
      setInterval(scanPending, 8000);
      // 浏览器会把后台标签页的定时器节流（可能拖到每分钟一次），
      // 所以「切回本站 / 重新聚焦窗口」时立刻补扫一次——管理员从微信点完链接切回来就能看到
      document.addEventListener('visibilitychange', () => { if (!document.hidden) scanPending(); });
      window.addEventListener('focus', scanPending);
    });
    watch(currentPage, (k) => {
      if (k === 'finance') autoLoadHotTopics();
      maybeAutoLoadBriefs(k);   // batch52：新闻追踪 / 全球信息 两页都要加载每日快讯
    }, { immediate: true });
    watch(sortedFilterStocks, () => nextTick(() => initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS)), { flush: 'post' });
    watch(currentPage, (k) => {
      if (k === 'filter') {
        nextTick(() => initResizeFor('.filter-scroll table', 'filterColWidths', FILTER_DEFAULT_COL_WIDTHS));
        nextTick(() => initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS));
      }
      if (k === 'hot') {
        nextTick(() => initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS));
      }
    });
    // 当日股票明细表（hot 页）：列表变化后重新初始化列宽拖拽
    watch(sortedHotStocks, () => {
      if (currentPage.value === 'hot') nextTick(() => initResizeFor('.hot-stock-table', 'hotColWidths', HOT_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 概念板块详情弹窗：打开弹窗、排序/筛选结果变化后，重新初始化列宽拖拽
    watch(() => sectorDetail.show, (v) => {
      if (v) nextTick(() => initResizeFor('.sector-detail-modal .pool-detail-table', 'sectorColWidths', SECTOR_DEFAULT_COL_WIDTHS));
    });
    watch(sortedSectorDetailStocks, () => {
      if (sectorDetail.show) nextTick(() => initResizeFor('.sector-detail-modal .pool-detail-table', 'sectorColWidths', SECTOR_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 股票池详情弹窗
    watch(() => poolDetail.show, (v) => {
      if (v) nextTick(() => initResizeFor('.pool-detail-modal .pool-detail-table', 'poolColWidths', POOL_DEFAULT_COL_WIDTHS));
    });
    watch(sortedPoolDetailStocks, () => {
      if (poolDetail.show) nextTick(() => initResizeFor('.pool-detail-modal .pool-detail-table', 'poolColWidths', POOL_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });
    // 收藏板块（位于 筛选板块 页，筛选栏下方）
    watch(sortedFavorites, () => {
      if (currentPage.value === 'filter') nextTick(() => initResizeFor('.fav-panel table', 'favColWidths', FAV_DEFAULT_COL_WIDTHS));
    }, { flush: 'post' });

    // 刷新筛选板块下所有股票的行情/财务数据
    const filterRefreshing = ref(false);
    // 筛选板块页：顶部筛选栏与「字段含义」说明的一键收起/展开（收起以显示更多股票内容）
    const filterFilterOpen = ref(true);
    // 收藏板块折叠开关（收藏板块位于筛选结果表下方，可通过工具栏「收起收藏」隐藏）
    const favPanelOpen = ref(true);
    async function refreshFilterStocks() {
      const list = filterPoolStocks.value;
      if (!list || !list.length) {
        showToast('请先选择板块', 'error');
        return;
      }
      if (filterRefreshing.value) return;
      filterRefreshing.value = true;
      showToast(`正在刷新 ${list.length} 只股票...`, 'info');
      try {
        // 1) 实时行情（腾讯）
        const codes = list.map(s => s.code).filter(Boolean);
        let quotes = {};
        try { quotes = await StockAPI.getQuotes(codes); } catch (e) { console.warn('实时行情刷新失败', e); }
        for (const s of list) {
          const q = quotes[s.code];
          if (q) {
            s.name = s.name || q.name;
            s.dailyChange = q.changePercent;
            s.amplitude = q.amplitude;
            s.turnover = q.turnover;
            s.todayPrice = q.price || s.todayPrice;
            if (q.totalMarketCap) s.totalMarketCap = q.totalMarketCap;
          }
        }
        // 2) 补充财务/股东数据（东方财富，best-effort）
        const works = list.filter(s => s.code);
        // 并发补全：成分股数量多时串行会显著拖慢并触发限流
        let done = 0;
        await runWithConcurrency(works, 6, async (s) => {
          try {
            const [flow, fin] = await Promise.all([
              StockAPI.getCapitalFlow(s.code),
              StockAPI.getFinance(s.code)
            ]);
            if (flow != null) s.capitalFlow = flow;
            if (fin.profitYoY != null) s.profitYoY = fin.profitYoY;
            if (fin.revenueYoY != null) s.revenueYoY = fin.revenueYoY;
            if (fin.hbGrowth != null) s.hbGrowth = fin.hbGrowth;
            if (fin.kcfYoY != null) s.kcfYoY = fin.kcfYoY;
            if (fin.revHb != null) s.revHb = fin.revHb;
            if (fin.kcfHb != null) s.kcfHb = fin.kcfHb;
            if (fin.netProfit != null) s.netProfit = fin.netProfit;
            if (fin.kcfjcxjlr != null) s.kcfjcxjlr = fin.kcfjcxjlr;
            if (fin.revenue != null) s.revenue = fin.revenue;
            if (fin.contractLiab != null) s.contractLiab = fin.contractLiab;
            if (fin.shareholderCount != null) s.shareholderCount = fin.shareholderCount;
            if (fin.prevShareholderCount != null) s.prevShareholderCount = fin.prevShareholderCount;
          } catch (e) {
            console.warn('财务数据获取失败', s.code, e);
          }
          // 所属行业（best-effort）
          try {
            if (!s.industry) {
              const ind = await StockAPI.getIndustry(s.code);
              if (ind) s.industry = ind;
            }
          } catch (e) {
            console.warn('行业获取失败', s.code, e);
          }
          // 主营构成（公司主业 + 占比，best-effort）
          try {
            if (!s.mainBusiness) {
              const mb = await StockAPI.getMainBusiness(s.code);
              if (mb) s.mainBusiness = mb;
            }
          } catch (e) {
            console.warn('主营构成获取失败', s.code, e);
          }
          // 24营比 / 24扣比（季报对比2024同期）
          try {
            const q24 = await StockAPI.getQuarterlyFinance(s.code);
            if (q24.q24Rev != null) s.q24Rev = q24.q24Rev;
            if (q24.q24Kcf != null) s.q24Kcf = q24.q24Kcf;
          } catch (e) {
            console.warn('季报对比获取失败', s.code, e);
          }
          // 历史价：优先「一次请求取四项」，取不到的项再逐项兜底（各自独立 try，互不连坐）
          try {
            const hb = await StockAPI.getHistoryBundle(s.code);
            if (hb) {
              if (hb.yearStartPrice != null) s.yearStartPrice = hb.yearStartPrice;
              if (hb.price924 != null) s.price924 = hb.price924;
              if (hb.yearHighPrice != null) s.yearHighPrice = hb.yearHighPrice;
              if (hb.yearLowPrice != null) s.yearLowPrice = hb.yearLowPrice;
              if (hb.yearHighDate != null) s.yearHighDate = hb.yearHighDate;
              if (hb.yearLowDate != null) s.yearLowDate = hb.yearLowDate;
              if (hb.weekAgoClose != null) s.weekAgoClose = hb.weekAgoClose;
              if (hb.monthAgoClose != null) s.monthAgoClose = hb.monthAgoClose;
            }
          } catch (e) {
            console.warn('历史价批量获取失败', s.code, e);
          }
          if (s.yearStartPrice == null) {
            try {
              const yp = await StockAPI.getYearStartPrice(s.code);
              if (yp != null) s.yearStartPrice = yp;
            } catch (e) {
              console.warn('年初价获取失败', s.code, e);
            }
          }
          if (s.price924 == null) {
            try {
              const p924 = await StockAPI.get924Price(s.code);
              if (p924 != null) s.price924 = p924;
            } catch (e) {
              console.warn('924价获取失败', s.code, e);
            }
          }
          // 今年最高/最低价（用于「今年高价 / 距高价 / 今年低价 / 距低价」字段）
          if (s.yearHighPrice == null || s.yearLowPrice == null) {
            try {
              const yhl = await StockAPI.getYearHighLow(s.code);
              if (yhl) {
                if (yhl.high != null) s.yearHighPrice = yhl.high;
                if (yhl.low != null) s.yearLowPrice = yhl.low;
              }
            } catch (e) {
              console.warn('今年高低价获取失败', s.code, e);
            }
          }
          if (s.todayPrice && s.yearStartPrice) {
            s.yearChange = +(((s.todayPrice - s.yearStartPrice) / s.yearStartPrice) * 100).toFixed(2);
          }
          if (s.todayPrice && s.price924) {
            s.change924 = +(((s.todayPrice - s.price924) / s.price924) * 100).toFixed(2);
          }
          // 一周涨跌 / 一月涨跌
          if (s.todayPrice && s.weekAgoClose) {
            s.weekChange = +(((s.todayPrice - s.weekAgoClose) / s.weekAgoClose) * 100).toFixed(2);
          }
          if (s.todayPrice && s.monthAgoClose) {
            s.monthChange = +(((s.todayPrice - s.monthAgoClose) / s.monthAgoClose) * 100).toFixed(2);
          }
          done++;
          if (done % 25 === 0) showToast(`已补全 ${done}/${works.length} 只...`, 'info');
        });
        showToast('刷新完成', 'success');
      } finally {
        filterRefreshing.value = false;
      }
    }

    // ============================================================
    //  设置 / 导入导出
    // ============================================================
    const showSettings = ref(false);
    const showPrefs = ref(false);
    const settingsText = ref('');
    const proxyUrl = ref('');
    // batch29：行情加速站点地址（可选，留空即完全走原直连线路）
    const accelBase = ref('');
    const aiEndpoint = ref('');
    const aiKey = ref('');
    const aiModel = ref('');
    // 跨设备免码登录（GitHub 注册表）配置：独立本地键，不进 D.settings（避免随设置导出泄露）
    const authAdminToken = ref('');
    const remotePending = ref([]);
    const remotePendingLoading = ref(false);

    /* ---------- AI 解读：常见厂商一键预设 + 连接测试 ----------
     * 下列五家国内厂商的接口**允许浏览器直连**（经真实浏览器实测：CORS 预检通过、
     * 带 Authorization 的 POST 能拿到可读响应体），所以在国内无需任何代理即可用。
     * OpenAI 则被拦截（8s 无响应），列出来只为提示风险，模型名用户可以自己改。 */
    const AI_PRESETS = [
      { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', tip: '国内可直连 · 站长常用' },
      { name: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct', tip: '国内可直连 · 注册有免费额度' },
      { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', tip: '国内可直连 · glm-4-flash 免费' },
      { name: '阿里百炼', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', tip: '国内可直连' },
      { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', tip: '国内可直连' },
      { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', tip: '⚠️ 国内无法直连，需自备代理' }
    ];
    const aiTesting = ref(false);
    const aiTestResult = reactive({ state: '', text: '' });

    /** 点厂商名 → 填入接口地址与模型名（Key 必须用户自己填，不能代填） */
    function applyAiPreset(p) {
      aiEndpoint.value = p.endpoint;
      aiModel.value = p.model;
      aiTestResult.state = '';
      aiTestResult.text = '';
      showToast('已填入「' + p.name + '」的接口地址与模型名，请再填你自己的 API Key', 'success');
    }

    /**
     * 「🧪 测试连接」：分两步定位问题，而不是笼统报「失败」。
     *   第 1 步 no-cors 探针 → 判网络层通不通（被墙/DNS 失败在这一步就会被抓出来）
     *   第 2 步 真实最小调用 → 判 Key / 模型 / 额度（能拿到状态码就说明 CORS 是通的）
     */
    async function aiTestConnection() {
      const ep = (aiEndpoint.value || '').trim();
      const key = (aiKey.value || '').trim();
      const model = (aiModel.value || '').trim();
      if (!ep || !key || !model) {
        aiTestResult.state = 'fail';
        aiTestResult.text = '请先把「API 地址 / API Key / 模型名」三项都填上，再点测试。';
        return;
      }
      aiTesting.value = true;
      aiTestResult.state = '';
      aiTestResult.text = '第 1 步：检查网络能否连通该地址…';
      try {
        const net = await probeEndpointReachable(ep, 8000);
        if (!net.ok) {
          aiTestResult.state = 'fail';
          aiTestResult.text = net.timeout
            ? '❌ 第 1 步不通过：8 秒内没有任何响应，该域名在当前网络多半被拦截。'
              + '这不是 CORS 问题——请换国内可直连的厂商（点上方的厂商按钮即可），或自备代理地址。'
            : '❌ 第 1 步不通过：地址解析不到或网络已断开（' + net.error + '）。请检查地址是否拼错、网络是否正常。';
          return;
        }
        aiTestResult.text = '✅ 第 1 步通过：网络可达。第 2 步：用你的 Key 真实调用一次…';
        const t0 = Date.now();
        const res = await callOpenAICompat(
          [{ role: 'user', content: '只回复两个字：收到' }],
          { maxTokens: 16, timeoutMs: 30000, cfg: { endpoint: ep, key, model } }
        );
        const ms = Date.now() - t0;
        if (res.ok) {
          const changed = ep !== (D.settings.aiEndpoint || '') || model !== (D.settings.aiModel || '') || key !== (D.settings.aiKey || '');
          aiTestResult.state = 'ok';
          aiTestResult.text = '🎉 全部通过（' + ms + 'ms）。模型回复：' + res.content.trim().slice(0, 40)
            + (changed ? '　——注意：改动还没保存，记得点右下角「保存设置」。' : '');
        } else {
          aiTestResult.state = 'fail';
          aiTestResult.text = '❌ 第 1 步网络可达（说明 CORS 是通的），但第 2 步调用失败：' + res.error;
        }
      } finally {
        aiTesting.value = false;
      }
    }

    watch(showSettings, v => {
      if (v) {
        settingsText.value = (D.settings.categories || []).join('\n');
        proxyUrl.value = D.settings.proxyUrl || '';
        accelBase.value = (typeof StockAPI !== 'undefined' && StockAPI && StockAPI.getAccelBase)
          ? StockAPI.getAccelBase() : '';
        aiEndpoint.value = D.settings.aiEndpoint || '';
        aiKey.value = D.settings.aiKey || '';
        aiModel.value = D.settings.aiModel || '';
        aiTesting.value = false;
        try {
          authAdminToken.value = (localStorage.getItem('snt-auth-admin-token') || '').trim();
        } catch (e) { /* ignore */ }
        aiTestResult.state = '';
        aiTestResult.text = '';
      }
    });
    const dataStats = computed(() => ({
      news: D.news.length,
      pools: D.stockPools.length
    }));
    function saveSettings() {
      const cats = settingsText.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!cats.length) {
        showToast('至少保留一个分类', 'error');
        return;
      }
      Store.setCategories(cats);
      // 保存代理地址（去除末尾斜杠）
      D.settings.proxyUrl = (proxyUrl.value || '').trim().replace(/\/+$/, '');
      // 保存行情加速站点（可选；存独立本地键，不进 D.settings）
      try {
        if (typeof StockAPI !== 'undefined' && StockAPI && StockAPI.setAccelBase) {
          StockAPI.setAccelBase((accelBase.value || '').trim().replace(/\/+$/, ''));
        }
      } catch (e) { console.warn('保存行情加速地址失败', e); }
      // 保存 AI 解读配置
      D.settings.aiEndpoint = (aiEndpoint.value || '').trim();
      D.settings.aiKey = (aiKey.value || '').trim();
      D.settings.aiModel = (aiModel.value || '').trim();
      // 保存跨设备登录令牌（独立键，不进 D.settings）
      try {
        localStorage.setItem('snt-auth-admin-token', (authAdminToken.value || '').trim());
      } catch (e) { /* ignore */ }
      showToast('设置已保存', 'success');
      showSettings.value = false;
    }
    function clearAllData() {
      if (!confirm('确认清空全部数据？此操作不可恢复！建议先导出备份。')) return;
      Store.clearAll();
      showToast('已清空全部数据', 'success');
      showSettings.value = false;
    }

    function exportData() {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock-news-backup-${Store.today()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('数据已导出', 'success');
    }
    function importData(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          Store.importJSON(ev.target.result);
          showToast('数据已导入', 'success');
        } catch (err) {
          showToast('导入失败：文件格式错误', 'error');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    }

    // ============================================================
    //  云端登录与数据同步（GitHub Gist）
    // ============================================================
    const cloud = reactive({
      loggedIn: false,
      user: '',
      token: '',
      gistId: '',
      autoSync: false,
      lastSync: '',
      syncing: false
    });
    const cloudModal = reactive({ show: false, token: '' });
    let _autoSyncTimer = null;
    let _autoSyncUnwatch = null;

    // 初始化：恢复登录状态
    (function initCloud() {
      // 云同步凭据同样按账号隔离（普通账号拿不到管理员的 Token）
      CloudSync.setAccount(A && A.user ? A.user.username : '');
      CloudSync.adoptLegacyCreds(A && A.user ? A.user.role : '');
      const creds = CloudSync.getCreds();
      if (creds && creds.token) {
        cloud.token = creds.token;
        cloud.gistId = creds.gistId || '';
        cloud.autoSync = creds.autoSync || false;
        // 后台验证 token 是否仍然有效
        CloudSync.verifyToken(creds.token).then(u => {
          cloud.loggedIn = true;
          cloud.user = u.name || u.login;
          cloud.lastSync = creds.lastSync || '';
          if (cloud.autoSync) setupAutoSync();
        }).catch(() => {
          // token 失效，清除
          CloudSync.clearCreds();
        });
      }
    })();

    function openCloudModal() {
      cloudModal.token = cloud.token || '';
      cloudModal.show = true;
    }

    async function cloudLogin() {
      const token = (cloudModal.token || '').trim();
      if (!token) { showToast('请输入 GitHub Token', 'error'); return; }
      cloud.syncing = true;
      try {
        const result = await CloudSync.loginAndLoad(token);
        cloud.token = token;
        cloud.user = result.user.name || result.user.login;
        cloud.gistId = result.gistId || '';
        cloud.loggedIn = true;
        CloudSync.setCreds({ token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        // 如果云端有数据，提示加载
        if (result.cloudData) {
          if (confirm('云端已有数据，是否加载到本地？（会覆盖当前本地数据）')) {
            loadCloudData(result.cloudData);
            cloud.lastSync = new Date().toLocaleString('zh-CN');
            CloudSync.setCreds({ token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
            showToast('已从云端加载数据', 'success');
          }
        } else {
          showToast('登录成功！可点「保存到云端」备份当前数据', 'success');
        }
        cloudModal.show = false;
      } catch (e) {
        showToast('登录失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    async function syncToCloud() {
      if (!cloud.token) { showToast('请先登录', 'error'); return; }
      cloud.syncing = true;
      try {
        const newId = await CloudSync.save(cloud.token, cloud.gistId, Store.exportJSON() ? JSON.parse(Store.exportJSON()) : D);
        cloud.gistId = newId;
        cloud.lastSync = new Date().toLocaleString('zh-CN');
        CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        showToast('已保存到云端 ✓', 'success');
      } catch (e) {
        showToast('保存失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    async function syncFromCloud() {
      if (!cloud.token || !cloud.gistId) { showToast('云端暂无数据，请先保存', 'error'); return; }
      if (!confirm('从云端加载会覆盖当前本地数据，是否继续？')) return;
      cloud.syncing = true;
      try {
        const data = await CloudSync.loadGist(cloud.token, cloud.gistId);
        loadCloudData(data);
        cloud.lastSync = new Date().toLocaleString('zh-CN');
        CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
        showToast('已从云端加载 ✓', 'success');
      } catch (e) {
        showToast('加载失败：' + e.message, 'error');
      } finally {
        cloud.syncing = false;
      }
    }

    function loadCloudData(data) {
      // 用云端数据覆盖本地
      if (data.news) { D.news.splice(0, D.news.length, ...data.news); }
      if (data.stockPools) { D.stockPools.splice(0, D.stockPools.length, ...data.stockPools); }
      // 恢复「选股」板块（含 AI 语义搜索保存的板块及其相关度字段），否则跨设备从云端加载会丢失
      if (data.sectorPools) { D.sectorPools.splice(0, D.sectorPools.length, ...data.sectorPools); }
      if (data.dailyData) { Object.keys(D.dailyData).forEach(k => delete D.dailyData[k]); Object.assign(D.dailyData, data.dailyData); }
      if (data.settings) { Object.assign(D.settings, data.settings); }
      if (data.hotBoards) D.hotBoards = data.hotBoards;
      if (data.hotStocks) D.hotStocks = data.hotStocks;
      if (data.preMarketBoards) D.preMarketBoards = data.preMarketBoards;
      if (data.amplitudeBoards) D.amplitudeBoards = data.amplitudeBoards;
      // 新上市股票：保留云端最后一次刷新的数据（与热门板块同口径恢复）
      if (data.newListedStocks) { D.newListedStocks = data.newListedStocks; newListedStocks.value = data.newListedStocks; }
      // 迁移 relatedStocks
      D.news.forEach(n => {
        if (typeof n.relatedStocks === 'string') n.relatedStocks = StockAPI.parseStockInput(n.relatedStocks);
        else if (!Array.isArray(n.relatedStocks)) n.relatedStocks = [];
      });
    }

    function cloudLogout() {
      CloudSync.clearCreds();
      stopAutoSync();
      cloud.loggedIn = false;
      cloud.user = '';
      cloud.token = '';
      cloud.gistId = '';
      cloud.autoSync = false;
      showToast('已退出云端登录', 'info');
    }

    function toggleAutoSync() {
      CloudSync.setCreds({ token: cloud.token, gistId: cloud.gistId, autoSync: cloud.autoSync, lastSync: cloud.lastSync });
      if (cloud.autoSync) { setupAutoSync(); showToast('已开启自动同步', 'success'); }
      else { stopAutoSync(); showToast('已关闭自动同步', 'info'); }
    }

    function setupAutoSync() {
      if (_autoSyncUnwatch) { _autoSyncUnwatch(); _autoSyncUnwatch = null; }
      if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
      _autoSyncUnwatch = Vue.watch(() => JSON.stringify(D), () => {
        if (!cloud.loggedIn || !cloud.autoSync) return;
        // 暂停自动刷新时同步暂停「自动云同步」（手动点「立即同步」仍可用）
        if (autoRefreshPaused()) return;
        clearTimeout(_autoSyncTimer);
        _autoSyncTimer = setTimeout(() => {
          syncToCloud();
        }, 10000); // 数据变化后 10 秒自动同步
      }, { deep: true });
    }

    function stopAutoSync() {
      if (_autoSyncUnwatch) { _autoSyncUnwatch(); _autoSyncUnwatch = null; }
      if (_autoSyncTimer) { clearTimeout(_autoSyncTimer); _autoSyncTimer = null; }
    }

    // 暴露到模板
    return {
      // 全局
      D, currentPage, tabs, goPage,
      toast, showToast,
      // 数据刷新总开关（顶部「暂停」按钮）
      dataPaused, autoRefreshPaused, toggleDataPause,
      allCategories, fmt, fmtPct, fmtSigned, fmtDateCN, numClass, pctClass, parseStocks, stocksText, pureCode,
      fmtYi, sRatio,
      showSettings, showPrefs, settingsText, proxyUrl, accelBase, saveSettings, clearAllData, dataStats,
      aiEndpoint, aiKey, aiModel, aiConfigured, aiGenerating, callOpenAICompat, generateNewsInterpretation,
      AI_PRESETS, applyAiPreset, aiTesting, aiTestResult, aiTestConnection,
      exportData, importData,
      // 云端同步
      cloud, cloudModal, openCloudModal, cloudLogin, syncToCloud, syncFromCloud, cloudLogout, toggleAutoSync,
      // 页面1
      newsFilter, selectedNewsIds, sortedNews, filteredNews,
      doubaoSearch,
      financePush, toggleFinanceLock,
      financePushNews, onFinanceStockSearch, addFinanceStock, removeFinanceStock, pushFinanceNews,
      sortKey, sortDir, sortBy, sortIcon,
      allNewsSelected, toggleSelectAll, invertSelection, selectAllNews, clearSelection, deleteSelectedNews,
      newsModal, openAddNews, editNews, saveNews, deleteNews,
      onStockSearchInput, addStock, removeStock, closeStockSuggestions,
      fillPriceForNews, refreshAllPrices, priceLoading,
      importModal, openImportDialog, previewImportCount, doPasteImport, doScrapeImport,
      // 页面2
      pools: D.stockPools, sortedPools, poolLoading,
      poolModal, openAddPool, openEditPool, savePool, deletePool, pickDailyStocks,
      poolDetail, openPoolDetail, startEditPoolName, savePoolName, refreshPoolPrices, refreshPoolDetail,
      addPoolStocks, removePoolStock, sortedPoolDetailStocks, sortPoolDetailBy, poolSortIcon,
      poolDetailStocksView, poolDetailNoteCount, clearPoolNoteQuery,
      // batch41：各子版块一键置顶 + 通用股票备注（所有表格均可编辑，按代码跨表共享）
      togglePoolPin, stockNoteOf, setStockNote,
      // 页面2.5：选股
      sectorSearch, sectorResults, sectorSearching, sectorLoading,
      sectorLoadError, sectorLoadingAll, reloadSectors, loadAllSectors, refreshSectorData,
      // 同类股票（同主营业务/产品的 A 股公司）
      similar, runSimilarBusiness, applySimilarOptions,
      similarNewOption, addSimilarOption, removeSimilarOption, setSimilarOptionValue,
      sectorDetail, sortedSectorPools, searchSector, addSectorFromSearch,
      sectorSubKeyword, searchSubSectors, clearSubSectorSearch, filteredSectorPools,
      // 板块卡片拖动排序 + 一键刷新（仅日涨跌）
      poolDragId, poolDropId, onPoolDragStart, onPoolDragOver, onPoolDrop, onPoolDragEnd,
      openPoolCard, resetPoolOrder, sectorPoolsRefreshing, refreshSectorPoolsDailyChange,
      // 个股搜索添加（板块详情 / 热门明细 / 筛选板块三处共用）
      quickAdd, quickAddSearch, quickAddBlur, quickAddPick, quickAddSubmit,
    sectorResultsMain, sectorResultsSub, sectorResultsIdx,
      sectorPick, sectorPickCount, toggleSelectAllSector, confirmSectorPick,
      visibleSectorPickStocks, sectorPickFiltered, computeSectorPickRelevance, pickChg, sectorPickEmptyHint,
      sectorPickIndustries, sectorPickIndustryLoaded, loadSectorPickIndustries,
      sectorSel, sectorSelCount, sectorSelIntersecting, sectorSelError,
      addSubSector, removeSubSector, clearSectorSel, startIntersectFilter, openSectorSelPick,
      loadSectorStocks, refreshSectorDetail, openSectorDetail, startEditSectorName,
      saveSectorName, deleteSectorPool, removeSectorStock,
      sortedSectorDetailStocks, sortSectorDetailBy, sectorSortIcon,
      sectorFilter, sectorDetailIndustries, filteredSectorDetailStocks,
      resetSectorFilter, toggleSectorFilterLock, sectorIndustryOpen,
      computeSectorDetailRelevance,
      sectorFilterOpen, sectorInfoOpen, favInfoOpen, filterInfoOpen, poolInfoOpen, sectorUsageOpen,
      // AI 语义选股（含结果 增删改）
      semantic, semanticSearch, saveSemanticAsPool,
      recomputeSemanticStocks, onConceptChanged, onBoardChanged,
      editingConceptIdx, conceptDraft, newConceptText, startEditConcept, commitEditConcept, cancelEditConcept, removeConcept, addConcept,
      editingBoardIdx, boardDraft, boardAddKw, boardAddMatches, boardAdding, startEditBoard, commitEditBoard, cancelEditBoard, removeBoard, searchBoardForAdd, addBoard, matchKindLabel,
      editingStockCode, stockNameDraft, stockRoleDraft, stockConceptsDraft, stockAddCode, stockAdding, startEditStock, commitEditStock, cancelEditStock, removeStock, addStockByCode,
      // batch60：恢复按钮 + 回顶按钮
      resetSectorPanel, showBackTop, scrollToTop,
      // 反推业务
      reverse, reverseSorted, reverseSort, setReverseSort, reverseBusiness, reverseSortIcon,
      // 页面3
      hotDate, hotLoading, hotBoards, hotStocks, newListedStocks, preMarketBoards, amplitudeBoards, conceptFreq,
      hotBoardActive, hotBoardLoading, hotDetailIsStock, openHotBoard, openHotStock, clearHotBoard,
      hotExclude, askHotExclude, cancelHotExclude, confirmHotExclude,
      hotFilterStocks,
      tailBuyList, tailBuyLoading, tailBuyTotal, tailBuyNote, runTailBuyFilter,
      // batch25：选股页「尾盘选股法」（作用于当前概念选股板块详情）
      sectorTailBuyList, sectorTailBuyLoading, sectorTailBuyTotal, sectorTailBuyNote,
      runTailBuyForSector, clearSectorTailBuy,
      allAFilter, askAllAFilter, cancelAllAFilter, confirmAllAFilter,
      // batch26：尾盘买入法面板「筛选板块」下拉
      tailPoolPick, onTailPoolChange,
      // batch24：命中标红（筛选板块表里把尾盘买入法命中的行标红）
      tailBuyHit, isTailBuyHit, clearTailBuyHits,
      hotSearchCode, hotSearchName, clearHotSearch,
      sortedHotStocks, sortHotBy, hotSortIcon, removeHotStock,
      // batch55：每日快讯子类 → 成分股（新闻追踪页当日股票明细，独立于热门板块点击）+ 序/增/数 排序
      dailyStockRows, briefCatStocks, briefCatActive, briefCatLoading, briefCatIsFallback,
      openBriefCat, clearBriefCat, briefCatSort, sortByBriefField, prevBriefLoading,
      loadHotData, fetchHotBoards, refreshHotStocks,
      refreshAmplitudeBoards, ampLoading, hotPanelsHidden, financePushHidden,
      // batch23（请求F）：六个子版块独立刷新按钮
      refreshHotBoardsOnly, hotBoardsLoading, refreshNewListedStocks, newListedLoading,
      refreshHotStocksOnly, hotStocksLoading, refreshPreMarketBoards, preMarketLoading,
      // 全球信息页：火热话题 + 格隆汇每日快讯
      hotTopicsSources, hotTopicsMerged, hotTopicsLoading, hotTopicsUpdated, refreshHotTopics,
      dailyWinStart, dailyWinEnd, dailyWinText, refreshDailyTopics, resetDailyWin,
      briefDates, briefDate, briefItems, briefKeyword, briefLoading, briefError, briefUi, briefPaused,
      briefFiltered, briefSearching, briefStatsList, briefBase,
      briefThemeStats, briefConceptStats, briefIndustryStats,
      briefSourceName, briefSourceInput, briefSourceCustom, briefSourcePresets,
      onBriefSourcePick, commitBriefSource,
      briefDimMode, briefDimModes, setBriefDim, briefDimLabel, briefDimCount,
      briefWindow, briefWindowItems, refreshBriefCloseWindow, clearBriefWindow,
      // batch16：可编辑统计时间窗口（15:00 换日，三板块统一）
      briefWinStart, briefWinEnd, briefWinText, resetBriefWin,
      onBriefDateChange, toggleBriefCat, moreBriefNews, hlBrief, autoLoadBriefs, loadBriefsNow,
      htTab, htMode, htLiveNote, hotTopicDate, hotTopicDateHasData, htCatFilter, htCategories, htRangeOptions, localSnapshotDates,
      analysisRange, analysisLoading, analysisResult, filteredHotSources,
      siteStatsDim, siteCatDimOptions, siteStatModal, openSiteStatNews, closeSiteStatNews, recomputeSiteStats, scDimName, scDimColor,
      // batch16：统计分析的统计时间窗口（15:00 换日，与快讯板块同口径）
      analysisWinStart, analysisWinEnd, analysisWinText, resetAnalysisWin,
      catColor, catLabel, htSourceColor, htSourceName, ratioClass, setHtMode, onHotTopicDateChange, runAnalysis,
      toggleThemeTopic, moreThemeNews,
      // 筛选板块
      filterPanel, openFilterPanel, resetFilter, applyFilterPool, toggleFilterLock,
      filteredFilterStocks, sortedFilterStocks, sortFilterBy, filterSortIcon,
      positiveCount, POSITIVE_KEYS,
      mainBusinessText, mainBizKcfRatio, stockConcepts, contractLiabCell,
      // 统一股票表（四表共用列定义与单元格渲染）
      getColumns, cellHtml, cellClass, isNumCol, onStockSort, stockSortIcon, onTableClick, onTableChange, STOCK_COLUMNS,
      filterIndustries, filterIndustryOpen,
      filterRefreshing, refreshFilterStocks, filterFilterOpen, favPanelOpen,
      sortedSectorPools, sortedPools,
      // 通用：收藏
      favorites, sortedFavorites, isFav, toggleFavorite, removeFavorite,
      updateFavNote, favDays,
      favAddCode, favAddName, favAdding, addFavoriteManual,
      favRefreshing, refreshFavorites
      ,
      // 用户持仓
      myHoldings, sortedHoldings, holdingSummary, holdingModal, openAddHolding, editHolding,
      saveHolding, deleteHoldingRow, refreshHoldingPrices, holdingRefreshing,
      onHoldingStockSearch, pickHoldingStock, fetchEntryPrice,
      holdingSortKey, holdingSortDir, sortHoldingBy, holdingSortIcon,
      holdingDays, holdingCost, holdingMarketValue, holdingChangePct, holdingProfit, holdingProfitPct,
      // 会员服务
      membershipModal, openMembershipService
      ,
      // 用户须知
      userNoticeModal, openUserNotice
      ,
      // 本地数据管理
      localDataModal, localDataRows, localDataUsageText, localDataKeyText,
      openLocalData, previewLocalData, closeLocalDataPreview,
      askDeleteLocalData, cancelDeleteLocalData, doDeleteLocalData,
      askClearLocalBusinessData, doClearLocalBusinessData
      ,
      // 登录账号与权限
      authUser, authInitial, authExpiryText, can, fmtDateTime, doLogout, userMenuOpen,
      userModal, userList, openUserManage, addUserByAdmin, changeUserRole,
      toggleUserDisabled, removeUserByAdmin,
      resetPw, openResetPassword, cancelResetPassword, genResetPassword, submitResetPassword,
      setUserRegisterDate, setUserQuota, isExpiredDate,
      trialDayOptions, grantUserTrial, revokeUserTrial,
      exportUsersTable, importUsersTable,
      pwModal, openChangePassword, submitChangePassword,
      // 登录档案与注册审核
      fmtDuration, badgeClass, passwordText, revealedPw, expandedUser,
      approveUserByAdmin, rejectUserByAdmin, importRequestCode,
      // 跨设备免码登录（GitHub 注册表）
      authAdminToken, remotePending, remotePendingLoading,
      loadRemotePending, approveRemoteByAdmin, rejectRemoteByAdmin, syncAllToRegistryByAdmin,
      showApproveCode, toggleRevealPassword, revealPendingPassword,
      copyPassword, toggleLoginLog,
      // batch16：准入码面板（管理员把授权转达给用户）
      approveCodeModal, copyApproveCode,
      // 注册申请站内提醒
      pendingCount, pendingNewCount, adminAlert, dismissAdminAlert, goReviewPending
    };
  }
});

app.mount('#app');
