/**
 * 数据存储层 - 基于 localStorage 的持久化
 * 管理新闻、股票池、每日数据、设置
 */
const Store = {
  STORAGE_KEY: 'stock-news-tracker-v1',
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
      dailyData: {},          // { "2024-07-08": { stocks: [...] } }
      hotBoards: [],          // 缓存最近一次热门板块
      hotStocks: [],          // 缓存最近一次热门股票
      settings: {
        categories: [...this.DEFAULT_CATEGORIES],
        proxyUrl: ''             // Cloudflare Worker 代理地址，用于一键抓取新闻
      }
    };
  },

  data: null,

  /** 初始化（需传入 Vue 以建立响应式） */
  init(Vue) {
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
    // 兼容迁移：老用户若仍是旧的5项默认分类，自动升级为新的15项默认分类
    const OLD_DEFAULTS = ['主线实体', '个股实体', '主线概念', '个股概念', '利空概念'];
    const cur = this.data.settings.categories || [];
    if (cur.length === OLD_DEFAULTS.length &&
        OLD_DEFAULTS.every(c => cur.includes(c)) &&
        cur.every(c => OLD_DEFAULTS.includes(c))) {
      this.data.settings.categories = [...this.DEFAULT_CATEGORIES];
    }
    if (!this.data.dailyData) this.data.dailyData = {};
    if (!this.data.stockPools) this.data.stockPools = [];
    if (!this.data.sectorPools) this.data.sectorPools = [];
    if (!this.data.news) this.data.news = [];

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
