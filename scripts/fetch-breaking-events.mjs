/* ============================================================
 * fetch-breaking-events.mjs — 定时抓取「真实、及时」的突发 / 世界名人新闻
 *
 * 供 GitHub Actions 使用（也可本机 `node scripts/fetch-breaking-events.mjs`）：
 *   多源 best-effort 聚合 → 词典筛选 → 真实热度/飙升信号 → 生成
 *   data/breaking-events.json 与 data/celebrity-news.json
 *
 * 设计要点：
 *  1) 纯 Node 内置模块，无第三方依赖；任一新闻源失败不影响其它源。
 *  2) 全源近乎全挂（有效新闻 < 8）时 **不覆盖现有文件**，避免把页面刷空。
 *  3) 输出 { generatedAt, generatedBy, sourceCount, autoCount, events:[...] }，
 *     前端 fetchBreakingEvents / fetchCelebrityNews 已支持 j.events。
 *  4) 每条自动事件 id 由标题稳定 hash 生成 —— 同一新闻多次抓取 id 不变，
 *     前端 futureSeenIds 才能正确把「新抓到的事件」标红 🆕。
 *  5) 与人工精选底库（现有 json 中的 b 系列 / p 系列条目，含完整研判字段）按标题
 *     2-gram 相似度去重后合并：自动条目置顶，精选条目保留。
 *  6) heat / momentum 由真实信号计算，不再拍脑袋：
 *       heat     = 基础 + 跨源跨条重复提及次数 + 热榜话题相似度加成
 *       momentum = 基础 + 近 1 小时同主题出现密度 + 30 分钟内新发加成
 *  7) 头条热榜只有「话题」没有真实发生时间，因此只作热度信号，
 *     绝不作为突发/人物候选（否则会把科普、语录、榜单话题混进突发新闻）。
 *
 * 用法：node scripts/fetch-breaking-events.mjs
 * ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 20261109d：输出落在 data/hot-topics/ 下，复用现有 hot-topics.yml 的
// `git add -A data/hot-topics` 一并提交；Pages 为 legacy(main 根目录)，push 即自动发布。
// 这样无需新增/修改 .github/workflows 下的任何文件（该目录需要 workflow scope）。
const OUT_BREAK = join(ROOT, 'data', 'hot-topics', 'breaking-events.json');
const OUT_PEOPLE = join(ROOT, 'data', 'hot-topics', 'celebrity-news.json');
// 人工精选底库保留在旧路径（研判字段完整），每轮从这里读取、输出到上面的新路径
const SEED_BREAK = join(ROOT, 'data', 'breaking-events.json');
const SEED_PEOPLE = join(ROOT, 'data', 'celebrity-news.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const TIMEOUT = 9000;
const MAX_AUTO_BREAK = 18;   // 自动突发最多保留条数
const MAX_AUTO_PEOPLE = 16;  // 自动人物最多保留条数
const KEEP_HOURS = 72;       // 只保留近 72 小时的真实新闻

/* ---------------- 基础工具 ---------------- */

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))
  ]);
}

async function fetchRaw(url, headers = {}) {
  const r = await withTimeout(fetch(url, {
    headers: Object.assign({
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    }, headers)
  }), TIMEOUT, url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** 真实 UTC 毫秒 → 北京时间 'YYYY-MM-DD HH:mm' */
function fmtBJ(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** 多源时间归一 → 真实 UTC 毫秒（无时间则用当前时间） */
function parseTs(v) {
  if (v == null || v === '') return Date.now();
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  // 'YYYY-MM-DD HH:mm:ss' 视为北京时间字符串：先按 UTC parse，再减 8h 得真实 UTC
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) {
    const ms = Date.parse(m[1] + 'T' + m[2] + ':00Z') - 8 * 3600 * 1000;
    if (!isNaN(ms)) return ms;
  }
  const d = Date.parse(s);
  return isNaN(d) ? Date.now() : d;
}

function cleanText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/^\s*财联社\d{1,2}月\d{1,2}日电[，,、：:]?\s*/, '')
    .replace(/^\s*【[^】]{1,20}】\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(s, n) {
  s = cleanText(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 快讯常见「【标题】正文」格式：优先把【】内内容作为干净标题 */
function cleanTitle(s) {
  const t = String(s || '');
  const m = t.match(/^\s*【([^】]{1,80})】/);
  return (m ? m[1] : t).trim();
}

/** 稳定 hash（djb2 → base36），用于新事件红色标识 */
function stableId(title, prefix) {
  let h = 5381;
  const s = String(title || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return prefix + h.toString(36);
}

/** 中文 2-gram 相似度（用于去重 / 热榜话题匹配） */
function bigrams(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function similar(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size);
}

/* ---------------- 真实新闻源（best-effort） ----------------
 * 统一条目：{ title, summary, tsMs, url, source, hot, heatOnly }
 * heatOnly=true 的源只有话题、无真实发生时间，仅作热度信号。
 * ---------------------------------------------------------- */

async function srcSinaRoll() {
  const items = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const u = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=50&page=${page}&_=${Date.now()}`;
      const j = await fetchRaw(u, { Referer: 'https://finance.sina.com.cn/' });
      const arr = (j && j.result && Array.isArray(j.result.data)) ? j.result.data : [];
      for (const it of arr) {
        const title = cut(it.title, 90);
        if (!title) continue;
        items.push({
          title, summary: cut(it.intro || it.title, 190),
          tsMs: parseTs(it.ctime), url: it.url || 'https://finance.sina.com.cn/',
          source: it.media_name || '新浪财经', hot: 0
        });
      }
    } catch (e) { console.warn(`  [新浪滚动 p${page}] ${e.message}`); }
  }
  return items;
}

async function srcCls() {
  try {
    const u = 'https://www.cls.cn/v1/roll/get_roll_list?app=CailianpressWeb&category=&last_time=&os=web&refresh_type=1&rn=50&sv=7.7.5&sign=d41556984a26bb242d388ce81c66a176';
    const j = await fetchRaw(u, { Referer: 'https://www.cls.cn/telegraph' });
    const arr = (j && j.data && j.data.roll_data) || [];
    return arr.map(it => {
      const raw = it.title || it.brief || it.content;
      const title = cut(raw, 90);
      return {
        title, summary: cut(it.brief || it.content || raw, 190),
        tsMs: parseTs(it.ctime || it.time),
        url: it.id ? ('https://www.cls.cn/detail/' + it.id) : 'https://www.cls.cn/telegraph',
        source: '财联社', hot: 0
      };
    }).filter(x => x.title);
  } catch (e) { console.warn('  [财联社] ' + e.message); return []; }
}

async function srcWscn() {
  try {
    const u = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=50';
    const j = await fetchRaw(u);
    const arr = (j && j.data && j.data.items) || [];
    return arr.map(it => {
      const raw = it.content_text || it.title || it.content;
      const title = cut(raw, 90);
      return {
        title, summary: cut(raw, 190),
        tsMs: parseTs(it.display_time || it.created_at || it.time),
        url: (typeof it.uri === 'string' && /^https?:/.test(it.uri)) ? it.uri : 'https://wallstreetcn.com/live/global',
        source: '华尔街见闻', hot: 0
      };
    }).filter(x => x.title);
  } catch (e) { console.warn('  [华尔街见闻] ' + e.message); return []; }
}

async function srcSina7x24() {
  try {
    const u = 'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=50&zhibo_id=152&tag_id=0&dire=f&dpc=1&_=' + Date.now();
    const j = await fetchRaw(u, { Referer: 'https://finance.sina.com.cn/7x24/' });
    const feed = j && j.result && j.result.data && j.result.data.feed;
    const arr = (feed && feed.list) || [];
    return arr.map(it => {
      const raw = it.rich_text || it.content || it.text;
      const title = cut(raw, 90);
      return {
        title, summary: cut(raw, 190),
        tsMs: parseTs(it.create_time || it.time),
        url: it.docurl || 'https://finance.sina.com.cn/7x24/',
        source: '新浪7×24', hot: 0
      };
    }).filter(x => x.title);
  } catch (e) { console.warn('  [新浪7x24] ' + e.message); return []; }
}

async function srcToutiao() {
  try {
    const u = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';
    const j = await fetchRaw(u, { Referer: 'https://www.toutiao.com/' });
    const arr = (j && j.data) || [];
    return arr.map(it => {
      const title = cut(it.Title || it.title, 90);
      return {
        title, summary: cut(it.Title || it.title, 190),
        tsMs: Date.now(),
        url: it.Url || 'https://www.toutiao.com/',
        source: '今日头条热榜',
        hot: Number(it.HotValue || it.hot_value || 0) || 0,
        heatOnly: true
      };
    }).filter(x => x.title);
  } catch (e) { console.warn('  [头条热榜] ' + e.message); return []; }
}

async function srcGelonghui() {
  try {
    const u = 'https://www.gelonghui.com/api/live-channels/all/lives/v4';
    const j = await fetchRaw(u, { Referer: 'https://www.gelonghui.com/live' });
    let arr = (j && j.result && j.result.data) || (j && j.data) || [];
    if (!Array.isArray(arr)) arr = arr.list || arr.items || [];
    return arr.map(it => {
      const raw = it.content || it.title || it.text;
      const title = cut(raw, 90);
      return {
        title, summary: cut(raw, 190),
        tsMs: parseTs(it.created_at || it.time || it.ctime),
        url: 'https://www.gelonghui.com/live', source: '格隆汇', hot: 0
      };
    }).filter(x => x.title);
  } catch (e) { console.warn('  [格隆汇] ' + e.message); return []; }
}

const SOURCES = [
  ['新浪滚动', srcSinaRoll], ['财联社', srcCls], ['华尔街见闻', srcWscn],
  ['新浪7×24', srcSina7x24], ['今日头条热榜', srcToutiao], ['格隆汇', srcGelonghui]
];

/* ---------------- 分类词典 ---------------- */

/** 突发大事件信号词（权重）；候选需累计权重 >= 4 */
const BREAK_RULES = [
  { re: /(爆炸|袭击|遇袭|空袭|爆炸案|恐怖袭击)/, w: 5 },
  { re: /(丑闻|婚外情|私情|性侵|被捕|逮捕|起诉|定罪|辞职|下台|弹劾)/, w: 4 },
  { re: /(突发|紧急|刚刚|骤然|意外|紧急召开)/, w: 3 },
  { re: /(崩盘|熔断|暴跌|闪崩|违约|破产|清算|退市|停牌)/, w: 4 },
  { re: /(被盗|泄露|黑客|网络攻击|数据泄露|芯片失窃)/, w: 4 },
  { re: /(制裁|禁令|断供|出口管制|关税|贸易战)/, w: 3 },
  { re: /(地震|海啸|台风|洪水|火灾|坠机|沉船)/, w: 4 },
  { re: /(IPO|上市|收购|并购|重组|分拆|万亿融资|巨额融资)/, w: 3 },
  { re: /(停火|开战|战争|冲突升级|军事行动|政变)/, w: 4 },
  { re: /(降息|加息|降准|QE|量化宽松|紧急救市)/, w: 3 },
  { re: /(断交|峰会破裂|谈判破裂|退群|脱钩)/, w: 3 },
  { re: /(黄仁勋|英伟达CEO|CEO.*(辞|涉|被|承认|爆))/, w: 4 }
];

/** 明显不是「突发新闻」的科普 / 盘点 / 常识 / 观点类 */
const NOISE_RE = /(注意事项|指南|科普|盘点|如何|怎么办|复盘|回顾|周报|日报|早报|晚报|汇总|一览|须知|攻略|小贴士|有哪些|是什么|为何|为什么|解读|点评|观察|深度|专题)/;

/** 世界名人（含常见别名 / 关联实体），每人最多保留 2 条，保证多样性 */
const PEOPLE = [
  { name: '马斯克', re: /(马斯克|Musk|特斯拉|xAI|SpaceX|星链)/i },
  { name: '黄仁勋', re: /(黄仁勋|Jensen Huang|英伟达CEO)/i },
  { name: '特朗普', re: /(特朗普|Trump)/i },
  { name: '拜登', re: /(拜登|Biden)/i },
  { name: '普京', re: /(普京|Putin)/i },
  { name: '巴菲特', re: /(巴菲特|Buffett)/i },
  { name: '奥尔特曼', re: /(奥尔特曼|Altman|OpenAI)/i },
  { name: '扎克伯格', re: /(扎克伯格|Zuckerberg)/i },
  { name: '库克', re: /(库克|Tim Cook)/i },
  { name: '贝佐斯', re: /(贝佐斯|Bezos)/i },
  { name: '孙正义', re: /(孙正义|软银)/ },
  { name: '索罗斯', re: /(索罗斯|Soros)/i },
  { name: '达利欧', re: /(达利欧|Dalio|桥水)/i },
  { name: '马云', re: /(马云|阿里巴巴创始人)/ },
  { name: '马化腾', re: /(马化腾)/ },
  { name: '雷军', re: /(雷军)/ },
  { name: '任正非', re: /(任正非)/ },
  { name: '王传福', re: /(王传福)/ },
  { name: '余承东', re: /(余承东)/ },
  { name: '张一鸣', re: /(张一鸣)/ },
  { name: '李彦宏', re: /(李彦宏)/ },
  { name: '鲍威尔', re: /(鲍威尔|Powell)/i },
  { name: '耶伦', re: /(耶伦|Yellen)/i },
  { name: '拉加德', re: /(拉加德|Lagarde)/i },
  { name: '马克龙', re: /(马克龙|Macron)/i },
  { name: '默克尔', re: /(默克尔|Merkel)/i },
  { name: '内塔尼亚胡', re: /(内塔尼亚胡|Netanyahu)/i },
  { name: '泽连斯基', re: /(泽连斯基|Zelensky)/i },
  { name: '莫迪', re: /(莫迪|Modi)/i },
  { name: '苏姿丰', re: /(苏姿丰|Lisa Su)/i },
  { name: '纳德拉', re: /(纳德拉|Nadella)/i },
  { name: '皮查伊', re: /(皮查伊|Pichai)/i },
  { name: '戴蒙', re: /(戴蒙|Jamie Dimon)/i },
  { name: '芬克', re: /(芬克|Larry Fink)/i },
  { name: '盖茨', re: /(比尔·盖茨|Bill Gates)/i },
  { name: '阿莫迪', re: /(阿莫迪|Dario Amodei)/i },
  { name: '哈萨比斯', re: /(哈萨比斯|Hassabis)/i }
];
const SPEECH_RE = /(表示|称|宣布|警告|透露|回应|发文|发帖|呼吁|批评|暗示|表态|宣称|炮轰|敦促|接受采访|专访|演讲|发声|建议|预计|预测|否认|承认|道歉|誓言|承诺|说|指出|强调)/;

/** 主题 → 三套区域下的合法 concept 键 + 利好/利空研判（与前端 CONCEPT_SCOPE 对齐） */
const TOPICS = [
  { key: 'ai', re: /(AI|人工智能|英伟达|NVIDIA|算力|大模型|GPU|OpenAI|Anthropic|ChatGPT|数据中心|芯片|半导体|台积电|AMD|昇腾|光刻)/i,
    concept: { world: 'ai', us: 'aiCapex', cn: 'llm' }, tag: '科技/AI',
    bull: ['AI算力', '半导体', '国产替代'], bear: ['传统软件'],
    bullInd: ['半导体', 'AI应用', '算力基础设施'], bearInd: ['传统IT服务'], stocks: ['英伟达', '微软', '台积电'] },
  { key: 'finance', re: /(美联储|降息|加息|利率|美债|通胀|CPI|美元|美股|华尔街|央行|流动性|国债|收益率|降准)/,
    concept: { world: 'finance', us: 'usFinance', cn: 'bank' }, tag: '金融/宏观',
    bull: ['黄金', '防御板块'], bear: ['高估值成长股'],
    bullInd: ['银行', '黄金'], bearInd: ['高杠杆地产'], stocks: ['美股科技', '黄金'] },
  { key: 'energy', re: /(原油|油价|OPEC|天然气|黄金|金价|贵金属|锂|稀土|电力|能源|煤炭|核电|光伏)/,
    concept: { world: 'energy', us: 'shale', cn: 'elec' }, tag: '能源/资源',
    bull: ['油气', '贵金属'], bear: ['高耗能制造'],
    bullInd: ['石油开采', '贵金属'], bearInd: ['航空运输', '化工'], stocks: ['中国石油', '紫金矿业'] },
  { key: 'trade', re: /(关税|贸易|出口|进口|WTO|供应链|航运|港口|出口管制|断供)/,
    concept: { world: 'trade', us: 'antitrust', cn: 'crossEcom' }, tag: '贸易/供应链',
    bull: ['内需', '国产替代'], bear: ['出口链'],
    bullInd: ['跨境电商', '内需消费'], bearInd: ['出口制造', '航运'], stocks: ['跨境电商', '航运'] },
  { key: 'geo', re: /(袭击|爆炸|战争|冲突|导弹|军事|地缘|停火|抗议|政变|选举|制裁|谈判|峰会)/,
    concept: { world: 'macro', us: 'defense', cn: 'core' }, tag: '地缘/政治',
    bull: ['军工', '避险资产'], bear: ['风险资产'],
    bullInd: ['军工', '黄金'], bearInd: ['航空', '旅游'], stocks: ['军工', '黄金'] },
  { key: 'ev', re: /(特斯拉|电动车|新能源车|电池|比亚迪|自动驾驶|FSD|储能)/,
    concept: { world: 'green', us: 'evTax', cn: 'nev' }, tag: '新能源车',
    bull: ['智能驾驶', '动力电池'], bear: ['传统车企'],
    bullInd: ['智能驾驶', '锂电池'], bearInd: ['传统汽车制造'], stocks: ['特斯拉', '比亚迪'] },
  { key: 'crypto', re: /(比特币|以太坊|加密|币安|区块链|稳定币|数字货币|爆仓)/,
    concept: { world: 'crypto', us: 'stable', cn: 'dataEl' }, tag: '数字货币',
    bull: ['区块链', '稳定币'], bear: ['高杠杆投机'],
    bullInd: ['金融科技', '区块链'], bearInd: ['传统支付'], stocks: ['Coinbase', 'MicroStrategy'] },
  { key: 'pharma', re: /(医药|医保|集采|疫苗|药企|FDA|减肥药)/i,
    concept: { world: 'pharma', us: 'medicare', cn: 'vbp' }, tag: '医药/医疗',
    bull: ['创新药'], bear: ['仿制药'],
    bullInd: ['创新药', '医疗器械'], bearInd: ['仿制药'], stocks: ['创新药', '医药'] },
  { key: 'consum', re: /(消费|零售|电商|旅游|白酒|奢侈品|票房|餐饮)/,
    concept: { world: 'luxury', us: 'retail', cn: 'consume' }, tag: '消费/零售',
    bull: ['内需消费'], bear: ['高端可选消费'],
    bullInd: ['零售', '文旅'], bearInd: ['奢侈品'], stocks: ['消费龙头'] },
  { key: 'macro', re: /.*/, concept: { world: 'macro', us: 'usMacro', cn: 'broker' }, tag: '宏观/综合',
    bull: ['防御板块'], bear: ['周期股'], bullInd: ['公用事业'], bearInd: ['顺周期'], stocks: ['宽基指数'] }
];

function detectRegion(text) {
  if (/(中国|A股|沪深|上证|深证|人民币|国务院|发改委|商务部|央行|港股|内地)/.test(text) && !/(美国|美方|美元|美联储)/.test(text)) return '中国';
  if (/(美国|美联储|美元|美股|白宫|特朗普|拜登|硅谷|纳斯达克|美债|华盛顿|纽约|华尔街)/.test(text)) return '美国';
  if (/(欧洲|欧盟|德国|法国|英国|意大利|西班牙|欧央行|伦敦|巴黎|柏林|布鲁塞尔)/.test(text)) return '欧洲';
  return '全球';
}

function classify(text) {
  const t = TOPICS.find(x => x.re.test(text)) || TOPICS[TOPICS.length - 1];
  const region = detectRegion(text);
  const scope = region === '美国' ? 'us' : (region === '中国' ? 'cn' : 'world');
  return { topic: t, region, concept: t.concept[scope] };
}

/* ---------------- 主流程 ---------------- */

function loadSeed(file) {
  try {
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : (j && j.events) || [];
    // 幂等：只保留人工精选底库；上一轮自动抓取的条目(_auto)必须丢弃，否则每小时累积膨胀
    return Array.isArray(arr) ? arr.filter(x => x && !x._auto) : [];
  } catch (e) { console.warn('  读取底库失败 ' + file + ': ' + e.message); return []; }
}

/** 从标题抽特征词，用于统计「跨条重复提及」 */
function keywords(title) {
  const t = String(title).replace(/[，,。、：:；;！!？?（）()【】\[\]"'\s]/g, ' ');
  const parts = t.split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const cn = p.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
    const en = p.match(/[A-Za-z]{3,}/g) || [];
    out.push(...cn.slice(0, 3), ...en.slice(0, 2));
  }
  return Array.from(new Set(out)).slice(0, 8);
}

function buildEvent(it, kind, signals) {
  const cls = classify(it.title + ' ' + it.summary);
  const t = cls.topic;
  const kws = keywords(it.title);
  // 真实热度信号：该条关键词在全部抓取条目（含热榜话题）里被多少条提到
  let rawMentions = 0;
  for (const kw of kws) {
    if (kw.length < 2) continue;
    rawMentions += signals.byKw.get(kw) || 0;
  }
  // 减去自身对每个关键词的 1 次贡献，只留「被其它新闻重复报道」的真实信号
  const mentions = Math.max(0, rawMentions - kws.length);
  let hotBonus = 0;
  for (const ht of signals.hotTitles) {
    if (similar(it.title, ht) >= 0.30) { hotBonus = 22; break; }
  }
  const heat = clamp(Math.round(24 + Math.min(mentions, 14) * 4.5 + hotBonus), 0, 100);
  const ageH = (Date.now() - it.tsMs) / 3600000;
  const rawRecent = kws.reduce((s, kw) => s + (signals.recentByKw.get(kw) || 0), 0);
  const recentCnt = Math.max(0, rawRecent - kws.length);
  const momentum = clamp(Math.round(18 + Math.min(recentCnt, 12) * 5 + (ageH <= 0.5 ? 18 : ageH <= 2 ? 8 : 0)), 0, 100);
  const person = kind === 'people' ? (signals.personOf(it.title) || '名人') : null;

  return {
    id: stableId(it.title, kind === 'people' ? 'ap' : 'ab'),
    title: it.title,
    tag: person ? ('人物/' + person) : t.tag,
    region: cls.region,
    concept: cls.concept,
    time: fmtBJ(it.tsMs),
    datetime: fmtBJ(it.tsMs),
    source: it.source,
    url: it.url,
    summary: it.summary || it.title,
    relatedStocks: t.stocks,
    bullConcepts: t.bull,
    bearConcepts: t.bear,
    bullIndustries: t.bullInd,
    bearIndustries: t.bearInd,
    heat, momentum,
    _auto: true
  };
}

export async function main() {
  console.log('开始多源抓取真实突发 / 名人新闻 ...');
  const all = [];
  let okSources = 0;
  for (const [name, fn] of SOURCES) {
    const got = await fn();
    if (got.length) okSources++;
    console.log(`  ${name}: ${got.length} 条`);
    all.push(...got);
  }

  // 时间窗 + 标题去重
  const cutoff = Date.now() - KEEP_HOURS * 3600000;
  const seen = new Set();
  const items = all.filter(it => {
    if (!it.title || it.tsMs < cutoff) return false;
    it.title = cleanTitle(it.title);
    const key = it.title.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 26);
    if (key.length < 6 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 热榜只有话题无真实时间，只作热度信号，绝不进入候选
  const newsItems = items.filter(it => !it.heatOnly);
  const hotTitles = items.filter(it => it.heatOnly).map(it => it.title);
  console.log(`合计 ${all.length} 条 → 去重/时效过滤后 ${items.length} 条（真实新闻 ${newsItems.length} + 热榜信号 ${hotTitles.length}），可用源 ${okSources}/${SOURCES.length}`);

  if (newsItems.length < 8) {
    console.warn('⚠️ 有效新闻过少（疑似网络异常），保留现有 json 不覆盖。');
    return;
  }

  // 建立真实热度信号：关键词 → 出现条数 / 近 1 小时出现条数
  const byKw = new Map(), recentByKw = new Map();
  for (const it of items) {
    const isRecent = (Date.now() - it.tsMs) <= 3600000;
    for (const kw of keywords(it.title)) {
      byKw.set(kw, (byKw.get(kw) || 0) + 1);
      if (isRecent) recentByKw.set(kw, (recentByKw.get(kw) || 0) + 1);
    }
  }
  const personOf = (title) => {
    const p = PEOPLE.find(x => x.re.test(title));
    return p ? p.name : null;
  };
  const signals = { byKw, recentByKw, hotTitles, personOf };

  // 候选筛选：突发要求高权重信号且非科普盘点；人物要求「发言 / 表态 / 主角」
  const breakCand = newsItems.filter(it => {
    if (NOISE_RE.test(it.title)) return false;
    let w = 0;
    for (const r of BREAK_RULES) if (r.re.test(it.title + ' ' + it.summary)) w += r.w;
    return w >= 4;
  });
  const peopleCand = newsItems.filter(it => {
    if (NOISE_RE.test(it.title)) return false;
    const p = PEOPLE.find(x => x.re.test(it.title));
    if (!p) return false;
    const idx = it.title.indexOf(p.name);
    return SPEECH_RE.test(it.title) || /[：:]/.test(it.title) || (idx >= 0 && idx <= 12);
  });
  console.log(`候选：突发 ${breakCand.length} 条 / 人物 ${peopleCand.length} 条`);

  const score = it => (Date.now() - it.tsMs < 3600000 ? 14 : 0)
    + keywords(it.title).reduce((s, kw) => s + Math.min(byKw.get(kw) || 0, 5), 0);
  const pick = (cand, max, kind) => {
    const sorted = [...cand].sort((a, b) => score(b) - score(a) || b.tsMs - a.tsMs);
    const perPerson = new Map();
    const out = [];
    for (const it of sorted) {
      if (out.length >= max) break;
      if (out.some(o => similar(o.title, it.title) >= 0.42)) continue;  // 自动条目内部去重
      if (kind === 'people') {
        const p = personOf(it.title) || '其他';
        const n = perPerson.get(p) || 0;
        if (n >= 2) continue;          // 每人最多 2 条，避免个别名人刷屏
        perPerson.set(p, n + 1);
      }
      out.push(buildEvent(it, kind, signals));
    }
    return out;
  };

  const autoBreak = pick(breakCand, MAX_AUTO_BREAK, 'breaking');
  const autoPeople = pick(peopleCand, MAX_AUTO_PEOPLE, 'people');

  // 与人工精选底库去重后合并（自动条目置顶，保留研判完整的历史条目）
  const merge = (seed, auto) => {
    const kept = seed.filter(s => !auto.some(a => similar(a.title, s.title) >= 0.42));
    return [...auto, ...kept];
  };
  const seedBreak = loadSeed(SEED_BREAK);
  const seedPeople = loadSeed(SEED_PEOPLE);
  const eventsBreak = merge(seedBreak, autoBreak);
  const eventsPeople = merge(seedPeople, autoPeople);

  const generatedAt = fmtBJ(Date.now());
  const meta = { generatedAt, generatedBy: 'GitHub Actions · 多源实时聚合', sourceCount: okSources, autoCount: 0, events: [] };
  const write = (file, events, autoCount) => {
    const body = { ...meta, autoCount, events };
    writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
    console.log(`✓ ${file.replace(ROOT, '')}：${events.length} 条（自动 ${autoCount} + 精选 ${events.length - autoCount}）`);
  };
  write(OUT_BREAK, eventsBreak, autoBreak.length);
  write(OUT_PEOPLE, eventsPeople, autoPeople.length);
  console.log('完成，数据时间 ' + generatedAt + '（北京时间）');
}

// 被 fetch-hot-topics.mjs 动态 import 时用 top-level await 等待抓取完成，
// 否则 import 返回后主进程可能已退出、抓取被中断；单独运行时独立执行并保留非零退出码。
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fetch-breaking-events.mjs')) {
  main().catch(e => { console.error('抓取脚本异常：', e); process.exit(1); });
} else {
  await main();
}
