/**
 * 云端同步模块 - 基于 GitHub Gist（免费）
 * 用 GitHub 用户名 + Token 登录，数据存储在私有 Gist 中，跨浏览器/跨设备同步。
 */
const CloudSync = {
  API: 'https://api.github.com',
  GIST_FILENAME: 'stock-news-data.json',
  CREDS_KEY: 'cloud-creds-v1',

  /** 读取本地保存的登录凭证 */
  getCreds() {
    try {
      const raw = localStorage.getItem(this.CREDS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  /** 保存登录凭证 */
  setCreds(creds) {
    localStorage.setItem(this.CREDS_KEY, JSON.stringify(creds));
  },

  /** 清除登录凭证 */
  clearCreds() {
    localStorage.removeItem(this.CREDS_KEY);
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
        description: '股市新闻追踪分析系统 - 数据备份（自动生成，请勿手动修改）',
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
