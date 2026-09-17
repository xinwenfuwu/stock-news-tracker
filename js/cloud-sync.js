/**
 * 云端同步模块 - 基于 GitHub Gist（免费）
 * 用 GitHub 用户名 + Token 登录，数据存储在私有 Gist 中，跨浏览器/跨设备同步。
 */
const CloudSync = {
  API: 'https://api.github.com',
  GIST_FILENAME: 'stock-news-data.json',
  // 云同步凭据也按账号隔离：否则同一浏览器上换成普通账号登录，
  // 会直接继承管理员的 GitHub Token，能读写管理员的私有 Gist 备份。
  CREDS_KEY: 'cloud-creds-v1',        // 兼容保留：升级前所有账号共用这一个键
  ACCOUNT_SEP: '::',
  LEGACY_CREDS_OWNER_KEY: 'snt-cloud-creds-owner-v1',
  account: '',

  /** 由 app.js 在初始化时告知当前账号 */
  setAccount(username) {
    this.account = String(username || '').trim().toLowerCase();
  },

  /** 当前账号专属的凭据键 */
  credsKey() {
    return this.account ? this.CREDS_KEY + this.ACCOUNT_SEP + this.account : this.CREDS_KEY;
  },

  /**
   * 接管升级前的旧凭据：只允许管理员、只接管一次。
   * 普通账号继承不到，自然也就碰不到管理员的云端备份。
   */
  adoptLegacyCreds(role) {
    if (!this.account) return false;
    let mine = '', legacy = '';
    try {
      mine = this.credsKey();
      if (localStorage.getItem(mine) !== null) return false;
      legacy = localStorage.getItem(this.CREDS_KEY);
      if (legacy === null) return false;
      if (role !== 'admin') return false;
      if (localStorage.getItem(this.LEGACY_CREDS_OWNER_KEY)) return false;
      localStorage.setItem(mine, legacy);
      localStorage.setItem(this.LEGACY_CREDS_OWNER_KEY, this.account);
      return true;
    } catch (e) { return false; }
  },

  /** 读取当前账号本地保存的登录凭证 */
  getCreds() {
    try {
      const raw = localStorage.getItem(this.credsKey());
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  /** 保存当前账号的登录凭证 */
  setCreds(creds) {
    localStorage.setItem(this.credsKey(), JSON.stringify(creds));
  },

  /** 清除当前账号的登录凭证 */
  clearCreds() {
    localStorage.removeItem(this.credsKey());
  },

  /** 验证 Token 是否有效 */
  async verifyToken(token) {
    const resp = await fetch(`${this.API}/user`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (!resp.ok) throw new Error('Token 无效或已过期');
    const data = await resp.json();
    return { login: data.login, name: data.name || data.login };
  },

  /** 查找用户已有的数据 Gist */
  async findDataGist(token) {
    const resp = await fetch(`${this.API}/gists?per_page=100`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (!resp.ok) return null;
    const gists = await resp.json();
    const found = gists.find(g => g.files && g.files[this.GIST_FILENAME]);
    return found ? found.id : null;
  },

  /** 创建新 Gist */
  async createGist(token, data) {
    const resp = await fetch(`${this.API}/gists`, {
      method: 'POST',
      headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: '股市信息分析系统 - 数据备份（自动生成，请勿手动修改）',
        public: false,
        files: { [this.GIST_FILENAME]: { content: JSON.stringify(data) } }
      })
    });
    if (!resp.ok) throw new Error('创建云端存储失败: ' + resp.status);
    const gist = await resp.json();
    return gist.id;
  },

  /** 更新已有 Gist */
  async updateGist(token, gistId, data) {
    const resp = await fetch(`${this.API}/gists/${gistId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: { [this.GIST_FILENAME]: { content: JSON.stringify(data) } }
      })
    });
    if (!resp.ok) throw new Error('保存到云端失败: ' + resp.status);
  },

  /** 从 Gist 加载数据 */
  async loadGist(token, gistId) {
    const resp = await fetch(`${this.API}/gists/${gistId}`, {
      headers: { 'Authorization': `token ${token}` }
    });
    if (!resp.ok) throw new Error('从云端加载失败: ' + resp.status);
    const gist = await resp.json();
    const file = gist.files && gist.files[this.GIST_FILENAME];
    if (!file || !file.content) throw new Error('云端无数据文件');
    return JSON.parse(file.content);
  },

  /** 保存数据到云端（自动创建或更新） */
  async save(token, gistId, data) {
    if (gistId) {
      await this.updateGist(token, gistId, data);
      return gistId;
    }
    return await this.createGist(token, data);
  },

  /** 登录并加载云端数据，返回 { user, gistId, data } */
  async loginAndLoad(token) {
    const user = await this.verifyToken(token);
    let gistId = await this.findDataGist(token);
    let cloudData = null;
    if (gistId) {
      try { cloudData = await this.loadGist(token, gistId); } catch (e) { cloudData = null; }
    }
    return { user, gistId, cloudData };
  }
};
