/**
 * 数据存储层 - 基于 localStorage 的持久化
 * 管理新闻、股票池、每日数据、设置
 */
const Store = {
  // ===== 存储隔离：一个账号一份数据 =====
  // 早期只用一个键，同一浏览器上所有账号共用同一份数据 —— 换账号等于换了个门牌，
  // 数据还是同一批（管理员的新闻/股票池会出现在普通用户眼前）。
  // 现在改成「一个账号一个键」：`stock-news-tracker-v1::<username>`。
  // BASE_KEY 保留为「升级前的共享数据」，只允许管理员接管一次，之后可由管理员手动清理。
  STORAGE_KEY: 'stock-news-tracker-v1',    // 当前账号实际使用的键（init 时解析，见 resolveKey）
  BASE_KEY: 'stock-news-tracker-v1',
  ACCOUNT_SEP: '::',
  LEGACY_OWNER_KEY: 'snt-store-owner-v1',  // 记录旧共享数据被哪个账号接管
  account: '',                             // 当前登录账号（统一小写）
  legacyClaimed: false,                    // 本次登录是否刚完成了旧数据接管
  migratedHoldings: 0,                     // 本次登录从旧共享数据里搬过来的「本账号持仓」条数

  DEFAULT_CATEGORIES: [
    '主线实体', '个股实体', '主线概念', '个股概念', '利空概念',
    '行业动态', '政策利好', '政策利空', '业绩预告', '业绩快报',
    '重组并购', '增持回购', '减持解禁', '监管处罚', '海外市场'
  ],

  // 默认数据结构
  _default() {
    return {
      news: [],
      stockPools: [],
      sectorPools: [],        // 概念/行业选股板块：[{id, name, bk, type, date, stocks: [...]}]
      favorites: [],          // 收藏股票：[{code, name, favDate, note}]
      holdings: {},            // 用户持仓：{ [username]: [{id, code, name, entryDate, entryPrice, currentPrice, shares, direction, fee, note, createdAt, updatedAt}] }
      holdingColWidths: {},    // 持仓页：各列宽度(px)，按列位置索引
      financePush: { url: '', locked: false }, // 财经推送：右侧嵌入的财经网址（锁定后持久化）
      filterColWidths: {},      // 筛选板块：各列宽度(px)，按列位置索引（0,1,2...）
      sectorColWidths: {},      // 概念板块详情弹窗：各列宽度(px)，按列位置索引（0,1,2...）
      dailyData: {},          // { "2024-07-08": { stocks: [...] } }
      hotTopicSnapshots: {},  // 火热话题每日快照 { "YYYY-MM-DD": { date, generatedAt, sources:[...] } }
      hotBoards: [],          // 缓存最近一次热门板块
      hotStocks: [],          // 缓存最近一次热门股票
      preMarketBoards: [],    // 缓存最近一次盘前热点板块
      amplitudeBoards: [],    // 缓存最近一次振幅板块
      settings: {
        categories: [...this.DEFAULT_CATEGORIES],
        proxyUrl: '',            // Cloudflare Worker 代理地址，用于一键抓取新闻
        // AI 解读（可选）：OpenAI 兼容接口，浏览器端调用，密钥仅存本地
        aiEndpoint: '',          // 如 https://api.deepseek.com/v1/chat/completions
        aiKey: '',               // 用户自己的 LLM API Key（仅存本地 localStorage）
        aiModel: ''              // 模型名，如 deepseek-chat
      }
    };
  },

  data: null,

  /** 账号 → 该账号专属的存储键。未登录（理论上不会发生）时退回共享键 */
  _keyFor(username) {
    const u = String(username || '').trim().toLowerCase();
    return u ? this.BASE_KEY + this.ACCOUNT_SEP + u : this.BASE_KEY;
  },

  _rawGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },

  _rawSet(key, val) {
    try {
      localStorage.setItem(key, val);
      return true;
    } catch (e) {
      console.error('保存失败（可能超出存储上限）', e);
      return false;
    }
  },

  /**
   * 解析当前账号应该使用哪个存储键。
   * 升级前的数据全堆在 BASE_KEY 里（当时所有账号共用一份），那份数据属于「这台设备原来的主人」，
   * 所以只允许**管理员**接管，并且只接管一次；普通账号一律从空数据开始，
   * 这样即便在同一台电脑、同一个浏览器上，账号之间也互不可见。
   */
  resolveKey(username, role) {
    const mine = this._keyFor(username);
    if (!username) return mine;
    if (this._rawGet(mine) !== null) return mine;      // 本账号已有自己的数据
    const legacy = this._rawGet(this.BASE_KEY);
    if (legacy === null) return mine;                  // 没有旧数据可接管
    if (role === 'admin' && !this._rawGet(this.LEGACY_OWNER_KEY)) {
      if (this._rawSet(mine, legacy)) {
        this._rawSet(this.LEGACY_OWNER_KEY, String(username).trim().toLowerCase());
        this.legacyClaimed = true;
      }
    }
    return mine;
  },

  /** 「升级前的共享数据」现状（供「本地数据」面板展示与清理） */
  legacyInfo() {
    const raw = this._rawGet(this.BASE_KEY);
    return {
      key: this.BASE_KEY,
      exists: raw !== null,
      size: raw ? raw.length : 0,
      owner: this._rawGet(this.LEGACY_OWNER_KEY) || '',
      isCurrent: this.STORAGE_KEY === this.BASE_KEY
    };
  },

  /** 删除升级前的共享数据。当前账号正使用它时拒绝执行（防止把自己正在用的数据删掉） */
  clearLegacy() {
    if (this.STORAGE_KEY === this.BASE_KEY) return false;
    try {
      localStorage.removeItem(this.BASE_KEY);
      localStorage.removeItem(this.LEGACY_OWNER_KEY);
      return true;
    } catch (e) { return false; }
  },

  /**
   * 从「升级前的共享数据」里，把**本账号自己的持仓**搬到新命名空间。
   * 旧版本里所有业务数据都是共用的，只有 holdings 是按用户名分开存的（D.holdings[username]），
   * 所以那部分确实属于这个账号自己 —— 不搬的话，普通账号升级后会凭空少掉自己的持仓。
   * 其余字段一概不碰（那些属于设备原来的主人/管理员）。
   * @returns {number} 实际搬过来的持仓条数
   */
  adoptLegacyHoldings() {
    let n = 0;
    try {
      const raw = this._rawGet(this.BASE_KEY);
      if (!raw) return 0;
      const legacy = JSON.parse(raw);
      const all = (legacy && legacy.holdings) || {};
      // 旧数据里的用户名大小写不一定和现在的账号一致，忽略大小写匹配
      const key = Object.keys(all).find(k => String(k).toLowerCase() === this.account);
      const list = key ? all[key] : null;
      if (Array.isArray(list) && list.length) {
        this.data.holdings = this.data.holdings || {};
        this.data.holdings[this.account] = list;
        n = list.length;
        this.saveNow();
      }
    } catch (e) { /* 旧数据坏了就安静跳过，不影响登录 */ }
    return n;
  },

  /** 初始化（需传入 Vue 以建立响应式；account = { username, role }） */
  init(Vue, account) {
    const username = (account && account.username) || '';
    const role = (account && account.role) || '';
    this.account = String(username).trim().toLowerCase();
    this.STORAGE_KEY = this.resolveKey(username, role);   // 每个账号读自己的那份
    let saved = null;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (e) {
      console.warn('数据解析失败，使用默认数据', e);
    }
    const defaults = this._default();
    // 合并已存数据与默认结构
    this.data = Vue.reactive(Object.assign(defaults, saved || {}));
    if (!this.data.settings || !this.data.settings.categories) {
      this.data.settings = { categories: [...this.DEFAULT_CATEGORIES], proxyUrl: '' };
    }
    if (!this.data.settings.proxyUrl) this.data.settings.proxyUrl = '';
    if (typeof this.data.settings.aiEndpoint !== 'string') this.data.settings.aiEndpoint = '';
    if (typeof this.data.settings.aiKey !== 'string') this.data.settings.aiKey = '';
    if (typeof this.data.settings.aiModel !== 'string') this.data.settings.aiModel = '';
    // 快讯来源名（可在「全球信息」页右栏标题上改）与分类维度（题材/概念/行业）
    if (typeof this.data.settings.briefSource !== 'string' || !this.data.settings.briefSource.trim()) {
      this.data.settings.briefSource = '格隆汇';
    }
    if (['theme', 'concept', 'industry'].indexOf(this.data.settings.briefDimMode) < 0) {
      this.data.settings.briefDimMode = 'theme';
    }
    // 兼容迁移：老用户若仍是旧的5项默认分类，自动升级为新的15项默认分类
    const OLD_DEFAULTS = ['主线实体', '个股实体', '主线概念', '个股概念', '利空概念'];
    const cur = this.data.settings.categories || [];
    if (cur.length === OLD_DEFAULTS.length &&
        OLD_DEFAULTS.every(c => cur.includes(c)) &&
        cur.every(c => OLD_DEFAULTS.includes(c))) {
      this.data.settings.categories = [...this.DEFAULT_CATEGORIES];
    }
    if (!this.data.dailyData) this.data.dailyData = {};
    if (!this.data.hotTopicSnapshots || typeof this.data.hotTopicSnapshots !== 'object') {
      this.data.hotTopicSnapshots = {};
    }
    if (!this.data.stockPools) this.data.stockPools = [];
    if (!this.data.sectorPools) this.data.sectorPools = [];
    if (!this.data.favorites) this.data.favorites = [];
    if (!this.data.news) this.data.news = [];
    if (!this.data.financePush || typeof this.data.financePush !== 'object') {
      this.data.financePush = { url: '', locked: false };
    }
    if (typeof this.data.filterColWidths !== 'object' || this.data.filterColWidths === null) {
      this.data.filterColWidths = {};
    }
    if (typeof this.data.sectorColWidths !== 'object' || this.data.sectorColWidths === null) {
      this.data.sectorColWidths = {};
    }
    if (typeof this.data.poolColWidths !== 'object' || this.data.poolColWidths === null) {
      this.data.poolColWidths = {};
    }
    if (typeof this.data.favColWidths !== 'object' || this.data.favColWidths === null) {
      this.data.favColWidths = {};
    }
    if (typeof this.data.hotColWidths !== 'object' || this.data.hotColWidths === null) {
      this.data.hotColWidths = {};
    }
    if (!this.data.holdings || typeof this.data.holdings !== 'object') {
      this.data.holdings = {};
    }
    if (typeof this.data.holdingColWidths !== 'object' || this.data.holdingColWidths === null) {
      this.data.holdingColWidths = {};
    }

    // 升级兼容：本账号是全新命名空间（saved 为空）时，从旧共享数据里认领「自己的持仓」。
    // 管理员那次已经整份接管了旧数据（legacyClaimed），不需要再单独搬。
    this.migratedHoldings = 0;
    if (username && !saved && !this.legacyClaimed) {
      this.migratedHoldings = this.adoptLegacyHoldings();
    }

    // 自动保存
    this._setupAutosave(Vue);
  },

  _setupAutosave(Vue) {
    let timer = null;
    Vue.watch(
      () => JSON.stringify(this.data),
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
          } catch (e) {
            console.error('保存失败（可能超出存储上限）', e);
          }
        }, 300);
      },
      { deep: true }
    );
  },

  /** 立即同步持久化（列宽拖拽等需要即时落盘的场景，绕过自动保存的 300ms 防抖） */
  saveNow() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('保存失败（可能超出存储上限）', e);
    }
  },

  /** 生成唯一 ID */
  uid(prefix = 'id') {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  },

  /** 今天日期 YYYY-MM-DD */
  today() {
    const d = new Date();
    return this.fmtDate(d);
  },

  fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /** 计算距今天数 */
  daysSince(dateStr) {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    const now = new Date();
    return Math.max(0, Math.floor((now - d) / 86400000));
  },

  // ===== 新闻 CRUD =====
  addNews(item) {
    item.id = this.uid('n');
    item.createdAt = Date.now();
    // 归属人：记录创建者用户名（多用户协作时区分来源）；Auth 由 auth-boot 注入，正常已登录
    if (!item.owner) {
      try {
        const u = (typeof Auth !== 'undefined' && Auth && Auth.user) ? Auth.user.username : null;
        item.owner = u || '—';
      } catch (e) { item.owner = '—'; }
    }
    this.data.news.unshift(item);
    return item;
  },

  updateNews(id, patch) {
    const item = this.data.news.find(n => n.id === id);
    if (item) Object.assign(item, patch);
    return item;
  },

  deleteNews(id) {
    const i = this.data.news.findIndex(n => n.id === id);
    if (i >= 0) this.data.news.splice(i, 1);
  },

  deleteNewsBatch(ids) {
    const set = new Set(ids);
    this.data.news = this.data.news.filter(n => !set.has(n.id));
  },

  // ===== 股票池 CRUD =====
  addPool(pool) {
    pool.id = this.uid('p');
    pool.createdAt = Date.now();
    this.data.stockPools.push(pool);
    return pool;
  },

  updatePool(id, patch) {
    const p = this.data.stockPools.find(p => p.id === id);
    if (p) Object.assign(p, patch);
    return p;
  },

  deletePool(id) {
    const i = this.data.stockPools.findIndex(p => p.id === id);
    if (i >= 0) this.data.stockPools.splice(i, 1);
  },

  // ===== 概念/行业选股板块 =====
  addSectorPool(sector) {
    sector.id = this.uid('sp');
    sector.createdAt = Date.now();
    this.data.sectorPools.push(sector);
    return sector;
  },
  updateSectorPool(id, patch) {
    const p = this.data.sectorPools.find(p => p.id === id);
    if (p) Object.assign(p, patch);
    return p;
  },
  deleteSectorPool(id) {
    const i = this.data.sectorPools.findIndex(p => p.id === id);
    if (i >= 0) this.data.sectorPools.splice(i, 1);
  },

  // ===== 收藏 =====
  isFavorite(code) {
    return this.data.favorites.some(f => f.code === code);
  },
  addFavorite(fav) {
    // 已存在则忽略
    if (this.data.favorites.some(f => f.code === fav.code)) return false;
    fav.id = this.uid('fav');
    if (!fav.favDate) fav.favDate = this.today();
    this.data.favorites.push(fav);
    return true;
  },
  removeFavorite(code) {
    const i = this.data.favorites.findIndex(f => f.code === code);
    if (i >= 0) { this.data.favorites.splice(i, 1); return true; }
    return false;
  },
  updateFavoriteNote(id, note) {
    const f = this.data.favorites.find(f => f.id === id);
    if (f) { f.note = note; return true; }
    return false;
  },

  // ===== 用户持仓（按用户名隔离，各自只看各自） =====
  getUserHoldings(username) {
    if (!username) return [];
    if (!this.data.holdings[username]) this.data.holdings[username] = [];
    return this.data.holdings[username];
  },
  addHolding(username, h) {
    if (!username) return null;
    if (!this.data.holdings[username]) this.data.holdings[username] = [];
    h.id = this.uid('h');
    h.createdAt = Date.now();
    h.updatedAt = Date.now();
    this.data.holdings[username].push(h);
    return h;
  },
  updateHolding(username, id, patch) {
    const list = this.data.holdings[username] || [];
    const it = list.find(x => x.id === id);
    if (it) { Object.assign(it, patch, { updatedAt: Date.now() }); return it; }
    return null;
  },
  deleteHolding(username, id) {
    const list = this.data.holdings[username];
    if (!list) return false;
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) { list.splice(i, 1); return true; }
    return false;
  },
  /** 批量写入现价（刷新后）；priceMap: { code: currentPrice } */
  setHoldingPrices(username, priceMap) {
    const list = this.data.holdings[username] || [];
    for (const it of list) {
      if (priceMap[it.code] != null && !isNaN(priceMap[it.code])) {
        it.currentPrice = +priceMap[it.code];
        it.updatedAt = Date.now();
      }
    }
  },

  // ===== 每日数据 =====
  getDailyStocks(date) {
    if (!this.data.dailyData[date]) {
      this.data.dailyData[date] = { stocks: [] };
    }
    return this.data.dailyData[date];
  },

  // ===== 设置 =====
  getCategories() {
    return this.data.settings.categories || [...this.DEFAULT_CATEGORIES];
  },

  setCategories(cats) {
    this.data.settings.categories = cats.filter(c => c.trim());
  },

  // ===== 导入导出 =====
  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  },

  importJSON(jsonStr) {
    const obj = JSON.parse(jsonStr);
    const defaults = this._default();
    Object.assign(this.data, Object.assign(defaults, obj));
  },

  clearAll() {
    const defaults = this._default();
    Object.keys(this.data).forEach(k => {
      if (k === 'settings') {
        this.data.settings.categories = [...this.DEFAULT_CATEGORIES];
      } else if (Array.isArray(this.data[k])) {
        this.data[k].splice(0, this.data[k].length);
      } else if (typeof this.data[k] === 'object') {
        Object.keys(this.data[k]).forEach(key => delete this.data[k][key]);
      }
    });
  }
};
