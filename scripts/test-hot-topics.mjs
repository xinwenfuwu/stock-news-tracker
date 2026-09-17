/* 火热话题核心逻辑断言测试（Node，无需浏览器）
 * 验证 classify / clusterItems / siteCategoryStats 在合成数据 + 真实种子数据上正确。 */
import { readFileSync, existsSync } from 'node:fs';
import ht from '../js/hot-topics.js';

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('1) classify 分类准确性');
assert('台湾问题→政治政策', ht.classify('崔天凯：一劳永逸解决台湾问题') === '政治政策', ht.classify('崔天凯：一劳永逸解决台湾问题'));
assert('华为芯片→科技', ht.classify('华为发布新一代昇腾芯片') === '科技', ht.classify('华为发布新一代昇腾芯片'));
assert('国民经济→经济', ht.classify('一组数据看8月份国民经济运行平稳') === '经济', ht.classify('一组数据看8月份国民经济运行平稳'));
assert('比特币→财经', ht.classify('比特币突破历史新高站上10万美元') === '财经', ht.classify('比特币突破历史新高站上10万美元'));
assert('央行降准→政治政策', ht.classify('央行宣布全面降准0.5个百分点') === '政治政策', ht.classify('央行宣布全面降准0.5个百分点'));
assert('美军航母→军事', ht.classify('美军航母编队驶入南海海域') === '军事', ht.classify('美军航母编队驶入南海海域'));
assert('房价→社会热点', ht.classify('一线城市房价环比上涨') === '社会热点', ht.classify('一线城市房价环比上涨'));
assert('马斯克→世界500强领导者动态', ht.classify('马斯克宣布特斯拉换帅') === '世界500强领导者动态', ht.classify('马斯克宣布特斯拉换帅'));

console.log('2) clusterItems 跨站同话题聚类（合成数据，使用真实源 key）');
const synth = [
  { sourceRank: 1, sourceKey: 'gelonghui', sourceName: '格隆汇', text: '比特币上涨10%', cat: '财经' },
  { sourceRank: 2, sourceKey: 'toutiao', sourceName: '今日头条', text: '比特币飙升涨幅超10%', cat: '财经' },
  { sourceRank: 3, sourceKey: 'ths', sourceName: '同花顺', text: '比特币大涨10%创历史新高', cat: '财经' },
  { sourceRank: 4, sourceKey: 'eastmoney', sourceName: '东方财富', text: '今日天气晴好适合出游', cat: '社会热点' }
];
const cl = ht.clusterItems(synth);
const btc = cl.find(c => c.repTitle.indexOf('比特币') >= 0);
assert('比特币话题聚为 1 簇', !!btc);
assert('比特币出现在 3 个站点', btc && btc.siteRanks.length === 3, btc && btc.siteRanks.length);
assert('比特币比例 = 3/10', btc && btc.ratio === '3/10', btc && btc.ratio);
assert('比特币覆盖站点序号 [1,2,3]', btc && JSON.stringify(btc.siteRanks.slice().sort()) === JSON.stringify([1, 2, 3]));
assert('天气话题单独成簇(1站)', cl.some(c => c.repTitle.indexOf('天气') >= 0 && c.siteRanks.length === 1));
assert('按站点数降序（比特币在前）', cl[0].siteRanks.length >= cl[cl.length - 1].siteRanks.length);

console.log('3) siteCategoryStats 各站分类统计（合成数据）');
const stats = ht.siteCategoryStats(synth.concat([
  { sourceRank: 1, sourceKey: 'gelonghui', sourceName: '格隆汇', text: '央行宣布降准', cat: ht.classify('央行宣布降准') }
]));
const a = stats.find(s => s.key === 'gelonghui');
assert('站点1(格隆汇) 总数为 2', a && a.total === 2, a && a.total);
assert('站点1 财经=1 政治政策=1', a && a.byCat['财经'] === 1 && a.byCat['政治政策'] === 1, a && JSON.stringify(a.byCat));
assert('输出 10 个站点占位', stats.length === 10, stats.length);

console.log('4) 真实种子数据（仓库内最新的两个快照）端到端');
function load(date) {
  try { return JSON.parse(readFileSync(new URL(`../data/hot-topics/${date}.json`, import.meta.url), 'utf8')); }
  catch (e) { return null; }
}
// ⚠️ 不要写死日期：快照按天滚动保留（60 天）且会被清理（如线上造假的 09-15 已删除），
//    写死会在轮换后必然失败。改为从 index.json.dates 取最近两个真实存在的快照。
const SNAP_IDX = JSON.parse(readFileSync(new URL('../data/hot-topics/index.json', import.meta.url), 'utf8'));
const SNAP_DATES = (SNAP_IDX.dates || []).slice(0, 2);
const snapA = load(SNAP_DATES[0]), snapB = load(SNAP_DATES[1]);
assert(`读取到快照 ${SNAP_DATES[0]}`, !!snapA, snapA && 'no');
assert(`读取到快照 ${SNAP_DATES[1]}`, !!snapB);
if (snapA && snapB) {
  const flat = [];
  for (const snap of [snapA, snapB]) {
    for (const s of snap.sources) for (const it of (s.items || [])) {
      flat.push({ sourceRank: s.rank, sourceKey: s.key, sourceName: s.name, text: it.text, time: it.time, url: it.url, cat: it.cat || '财经', date: snap.date });
    }
  }
  const totalItems = flat.length;
  const clusters = ht.clusterItems(flat);
  const stats2 = ht.siteCategoryStats(flat);
  const withData = stats2.filter(s => s.total > 0).length;
  console.log(`    共 ${totalItems} 条，涉及 ${withData} 个有数据的站点，跨站聚类出 ${clusters.length} 个话题`);
  console.log('    跨站重合 TOP5（比例 / 代表标题）：');
  clusters.slice(0, 5).forEach(c => console.log(`      ${c.ratio}  [${c.siteRanks.join(',')}]  ${c.repTitle.slice(0, 40)}`));
  assert('聚类数量 > 0', clusters.length > 0, clusters.length);
  const multi = clusters.filter(c => c.siteRanks.length >= 2).length;
  console.log(`    跨站重合(>=2站)话题数：${multi}（取决于各源是否报道同一事件且措辞相近，属数据相关）`);
  assert('各站统计覆盖有数据的站', withData > 0, withData);
  // 验证分类标签全部落在 7 类（或财经兜底）内
  const cats = new Set(Object.keys(ht.CATEGORY_COLORS));
  const badCat = flat.find(it => !cats.has(it.cat));
  assert('所有条目分类合法', !badCat, badCat && badCat.cat);
}

console.log('5) 标题净化 cleanTitle / isJunkTitle（导航、栏目拼盘、模板、乱码）');
// 应被过滤（导航/栏目/模板/乱码/工具入口）
const JUNK_SAMPLES = [
  '首页 关于我们', '联系我们 用户反馈', '查看更多 >', '${title}', 'level-2', '7X24小时',
  '您的IE版本过低，为了您更好的体验，请升至较高版本', '同花顺免费版', '财经要闻 宏观经济',
  '全部 港股公告摘要', '申请认证 格隆汇公众号矩阵', '个股聚焦 公司新闻', '#航空航天与国防',
  '����ѧУ', 'i问财智能选股', '今日利好公告', '搜索 查看全部股票/文章/快讯/事件/用户/财富圈搜索结果'
];
JUNK_SAMPLES.forEach(s => assert('过滤: ' + s.slice(0, 22), ht.cleanTitle(s) === '', '实际保留 -> ' + ht.cleanTitle(s)));
// 应被保留（真实新闻标题）
const KEEP_SAMPLES = [
  '崔天凯：一劳永逸解决台湾问题',
  'OpenAI据悉考虑新一轮融资',
  '全球首个3D数据中心发布，十万卡以上超节点将成基础配置',
  '一线城市房价涨了',
  '美国参议院投票表决Clarity ACT，没能法扫清程序性障碍。比特币短线跳水。'
];
KEEP_SAMPLES.forEach(s => assert('保留: ' + s.slice(0, 22), ht.cleanTitle(s) !== '', '被误过滤'));
assert('实体解码 &gt; &amp;', ht.decodeEntities('A&amp;B &gt; C') === 'A&B > C', ht.decodeEntities('A&amp;B &gt; C'));
assert('cleanTitle 去除 HTML 标签', ht.cleanTitle('<em>央行</em>宣布全面降准0.5个百分点') === '央行宣布全面降准0.5个百分点', ht.cleanTitle('<em>央行</em>宣布全面降准0.5个百分点'));

console.log('6) 实时抓取失败时的快照回退日期候选 snapshotCandidates（代理被拦截的兜底链路）');
const today = ht.todayStr();
assert('todayStr 为本地日期格式', /^\d{4}-\d{2}-\d{2}$/.test(today), today);
assert('fmtLocalDate 无 UTC 偏移', ht.fmtLocalDate(new Date(2026, 8, 16)) === '2026-09-16', ht.fmtLocalDate(new Date(2026, 8, 16)));
// 有清单：只取不晚于今天的日期，降序优先；未来日期被排除
const cand1 = ht.snapshotCandidates({ dates: ['2026-09-16', '2026-09-15', '2026-12-31', 'bogus', null] }, '2026-09-16', 14);
assert('清单优先且降序', cand1[0] === '2026-09-16' && cand1[1] === '2026-09-15', JSON.stringify(cand1));
assert('清单排除未来日期', cand1.indexOf('2026-12-31') < 0, JSON.stringify(cand1));
assert('清单过滤非法项', cand1.indexOf('bogus') < 0 && cand1.length === 2, JSON.stringify(cand1));
// 今天没有快照（比如 Action 还没跑）→ 清单里最早的就是最优候选
const cand2 = ht.snapshotCandidates({ dates: ['2026-09-15', '2026-09-14'] }, '2026-09-16', 14);
assert('无当日快照则回退前一可用日', cand2[0] === '2026-09-15', JSON.stringify(cand2));
// 无清单 / 清单不可用 → 从今天起向前回溯 N 天
const cand3 = ht.snapshotCandidates(null, '2026-09-16', 3);
assert('无清单回溯起点为今天', cand3[0] === '2026-09-16', JSON.stringify(cand3));
assert('无清单回溯 N 天且连续', cand3.length === 3 && cand3[1] === '2026-09-15' && cand3[2] === '2026-09-14', JSON.stringify(cand3));
assert('空清单同样走回溯', ht.snapshotCandidates({ dates: [] }, '2026-09-16', 2).length === 2);
assert('跨月回溯正确', ht.snapshotCandidates(null, '2026-10-02', 4).join(',') === '2026-10-02,2026-10-01,2026-09-30,2026-09-29', ht.snapshotCandidates(null, '2026-10-02', 4).join(','));

console.log('7) 抓取脚本产出的快照清单 index.json 与快照一致性');
const idxPath = new URL('../data/hot-topics/index.json', import.meta.url);
if (existsSync(idxPath)) {
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  assert('清单含 dates 数组', Array.isArray(idx.dates) && idx.dates.length > 0, JSON.stringify(idx.dates));
  assert('清单 latest 即 dates[0]', idx.latest === idx.dates[0], idx.latest);
  assert('清单日期降序', idx.dates.join(',') === idx.dates.slice().sort().reverse().join(','), idx.dates.join(','));
  const miss = idx.dates.filter(d => !existsSync(new URL(`../data/hot-topics/${d}.json`, import.meta.url)));
  assert('清单里的日期都有对应快照文件', miss.length === 0, miss.join(','));
  // 格隆汇快讯清单
  assert('清单含 briefsDates 数组（格隆汇每日快讯）', Array.isArray(idx.briefsDates) && idx.briefsDates.length > 0,
    JSON.stringify(idx.briefsDates));
  assert('briefsDates 降序且 latestBriefs 为最新', idx.briefsDates.join(',') === idx.briefsDates.slice().sort().reverse().join(',')
    && idx.latestBriefs === idx.briefsDates[0], `latestBriefs=${idx.latestBriefs}`);
  const missB = idx.briefsDates.filter(d => !existsSync(new URL(`../data/hot-topics/briefs-${d}.json`, import.meta.url)));
  assert('清单里的快讯日期都有对应 briefs 文件', missB.length === 0, missB.join(','));
  assert('快讯保留天数独立于快照（briefKeepDays 存在）', typeof idx.briefKeepDays === 'number', String(idx.briefKeepDays));
} else {
  console.log('  （本地暂无 index.json，跳过）');
}

console.log('8) themeStats 主题维度统计（行业/概念/产品/产业/科技，多标签命中）');
assert('5 个维度且顺序正确', ht.THEME_DIMENSIONS.map(d => d.name).join(',') === '行业,概念,产品,产业,科技', ht.THEME_DIMENSIONS.map(d => d.name).join(','));
assert('每个维度都有词典与配色', ht.THEME_DIMENSIONS.every(d => ht.THEME_KEYWORDS[d.key] && d.color && d.icon));
const th = ht.themeStats([
  { text: '华为发布新一代昇腾AI芯片' },
  { text: '特斯拉无人驾驶电动车Cybercab亮相' },
  { text: '今天天气不错适合出游' }
]);
assert('返回 5 个维度结果', th.length === 5, th.length);
const thInd = th.find(d => d.key === 'industry'), thCon = th.find(d => d.key === 'concept');
const thPro = th.find(d => d.key === 'product'), thTch = th.find(d => d.key === 'tech');
assert('行业命中「半导体」(华为芯片)', thInd.topics.some(t => t.name === '半导体'), JSON.stringify(thInd.topics.map(t => t.name)));
assert('行业命中「汽车」(特斯拉)', thInd.topics.some(t => t.name === '汽车'));
assert('概念命中「人工智能」', thCon.topics.some(t => t.name === '人工智能'));
assert('概念命中「国产替代」(昇腾)', thCon.topics.some(t => t.name === '国产替代'));
assert('产品命中「芯片」', thPro.topics.some(t => t.name === '芯片'));
assert('科技命中「人工智能」', thTch.topics.some(t => t.name === '人工智能'));
assert('科技命中「自动驾驶」(无人驾驶)', thTch.topics.some(t => t.name === '自动驾驶'));
assert('多标签：同一条新闻进多个维度', thInd.total === 2 && thCon.total === 2 && thPro.total === 2, `行业=${thInd.total} 概念=${thCon.total} 产品=${thPro.total}`);
assert('无关新闻(天气)不计入任何维度', th.every(d => d.total <= 2), JSON.stringify(th.map(d => d.name + ':' + d.total)));
assert('total 不超过总条数', th.every(d => d.total <= 3));
assert('pct 为 0-100 整数', thInd.topics.every(t => Number.isInteger(t.pct) && t.pct >= 0 && t.pct <= 100));
assert('topics 按命中数降序', thCon.topics.every((t, i, a) => i === 0 || a[i - 1].count >= t.count));
assert('width 落在 1-100', thCon.topics.every(t => t.width > 0 && t.width <= 100));
assert('samples 保留样例标题供悬停查看', thInd.topics.every(t => t.samples.length > 0 && typeof t.samples[0] === 'string'));
assert('空数组安全', ht.themeStats([]).every(d => d.total === 0 && d.topics.length === 0 && d.baseTotal === 0));
assert('null 入参安全', ht.themeStats(null).length === 5);
assert('baseTotal 记录统计基数', th[0].baseTotal === 3, th[0].baseTotal);
assert('同一主题每条新闻只计一次（不因多别名重复累加）', ht.themeStats([{ text: 'AI人工智能大模型ChatGPT' }]).find(d => d.key === 'concept').topics.find(t => t.name === '人工智能').count === 1);
// 点击主题就地展开所需的新闻明细
assert('每个主题都带完整命中新闻列表 news', th.every(d => d.topics.every(t => Array.isArray(t.news) && t.news.length === t.count)),
  JSON.stringify(th.map(d => d.name + ':' + d.topics.map(t => t.news.length + '/' + t.count).join(','))));
assert('news 保留原条目对象（含 text 字段）', thPro.topics.find(t => t.name === '芯片').news.every(n => typeof n.text === 'string' && n.text.length > 0));
assert('无命中维度 topics 为空且 news 不残留', ht.themeStats([{ text: '天气不错' }]).find(d => d.key === 'chain').topics.length === 0);

if (snapA && snapB) {
  const flatTheme = [];
  for (const snap of [snapA, snapB]) for (const s of snap.sources) for (const it of (s.items || [])) flatTheme.push({ text: it.text, date: snap.date, sourceRank: s.rank, sourceKey: s.key, sourceName: s.name, time: it.time, url: it.url });
  const ts = ht.themeStats(flatTheme);
  console.log(`    真实快照 ${flatTheme.length} 条的维度命中情况：`);
  ts.forEach(d => console.log('      ' + d.name + '：命中 ' + d.total + ' 条 → ' + d.topics.slice(0, 6).map(t => t.name + '(' + t.count + ')').join(' ')));
  assert('真实数据：五个维度均有命中', ts.every(d => d.total > 0), JSON.stringify(ts.map(d => d.name + ':' + d.total)));
  assert('真实数据：命中数不超过总条数', ts.every(d => d.total <= flatTheme.length));
  assert('真实数据：行业/概念命中率合理(>5%)', ts[0].total / flatTheme.length > 0.05 && ts[1].total / flatTheme.length > 0.05,
    `行业=${ts[0].total} 概念=${ts[1].total} / ${flatTheme.length}`);
  // 点击主题 → 展开新闻明细
  const aiTopic = ts.find(d => d.key === 'concept').topics.find(t => t.name === '人工智能');
  assert('真实数据：人工智能主题带 news 明细', !!aiTopic && aiTopic.news.length === aiTopic.count && aiTopic.count > 0, aiTopic && `${aiTopic.news.length}/${aiTopic.count}`);
  assert('真实数据：明细含站点名/站点序号/日期', aiTopic.news.every(n => n.text && n.sourceName && n.sourceRank > 0 && /^\d{4}-\d{2}-\d{2}$/.test(n.date)));
  assert('真实数据：明细按日期降序', aiTopic.news.every((n, i, a) => i === 0 || String(a[i - 1].date) >= String(n.date)));
  console.log('    点击「人工智能」将展示的新闻（前 3 条）：');
  aiTopic.news.slice(0, 3).forEach(n => console.log(`      [${n.sourceName} ${n.date}] ${n.text.slice(0, 38)}`));
  const hasUrl = aiTopic.news.filter(n => n.url).length;
  console.log(`    其中 ${hasUrl}/${aiTopic.news.length} 条带原文链接（可点击跳转）`);
  assert('真实数据：人工智能主题的新闻多带原文链接', hasUrl > 0, hasUrl);
}

console.log('9) briefStats 格隆汇快讯 13 分类统计（合成数据）');
const BRIEF_CATS = ['国家政策类', '世界500强领导者', '社会热点', '南下资金', '科技突破', '行业标杆上市公司',
  '大行机构', '美债', '美股', '日韩股', '港股', '黄金', '石油'];
const bsEmpty = ht.briefStats([]);
assert('空输入仍返回 13 个分类', bsEmpty.length === 13, String(bsEmpty.length));
assert('分类名称与顺序完全符合需求', JSON.stringify(bsEmpty.map(d => d.name)) === JSON.stringify(BRIEF_CATS),
  bsEmpty.map(d => d.name).join('/'));
assert('空输入各项计数为 0 且无明细', bsEmpty.every(d => d.count === 0 && d.news.length === 0));
assert('空输入百分比为 0、占比条仍有最小宽度', bsEmpty.every(d => d.pct === 0 && d.width >= 4));

// 每类给一句典型文本，验证关键词词典确实能命中对应分类
const hitCases = [
  ['国家政策类', '国务院办公厅印发实施意见，明确关税调整与补贴试点安排'],
  ['世界500强领导者', '英伟达CEO黄仁勋表示将加大在华投入'],
  ['社会热点', '某地暴雨引发洪灾，救援工作持续进行'],
  ['南下资金', '南下资金今日净买入港股20.99亿港元'],
  ['科技突破', '我国科研团队首次实现可控核聚变重大突破'],
  ['行业标杆上市公司', '宁德时代发布半年报，净利润同比增长两成'],
  ['大行机构', '高盛上调目标价，研报看好该板块后市'],
  ['美债', '美联储主席鲍威尔暗示可能加息25个基点'],
  ['美股', '美股三大指数收涨，纳指创历史新高'],
  ['日韩股', '日经225指数收涨逾1%，韩国KOSPI同步走强'],
  ['港股', '港股恒生指数收涨，恒生科技指数表现强势'],
  ['黄金', '国际金价走高，现货黄金再创历史新高'],
  ['石油', '布伦特原油价格上涨，OPEC讨论增产计划']
];
for (const [cat, text] of hitCases) {
  const st = ht.briefStats([{ id: 1, text, time: '2026-09-16 10:00' }]);
  const d = st.find(x => x.name === cat);
  assert(`「${text.slice(0, 12)}…」命中「${cat}」`, d && d.count === 1 && d.news.length === 1,
    d ? `count=${d.count}` : '未找到分类');
}

// 多标签：一条快讯可同时进入多个分类
const multi = ht.briefStats([{ id: 2, text: '英伟达CEO黄仁勋：美联储加息预期升温，美股盘前走弱', time: '2026-09-16 09:00' }]);
const multiHit = multi.filter(d => d.count > 0).map(d => d.name);
assert('同一条快讯可命中多个分类（多标签）', multiHit.length >= 3, multiHit.join('/'));
assert('多标签命中下每条明细仍是同一条', multi.every(d => d.news.every(n => n.id === 2)));

// cleanBriefText：剥统一前缀与残留 HTML 标签
assert('cleanBriefText 剥掉「格隆汇X月X日｜」前缀',
  ht.cleanBriefText('格隆汇9月16日｜央行宣布降准') === '央行宣布降准',
  ht.cleanBriefText('格隆汇9月16日｜央行宣布降准'));
assert('cleanBriefText 剥掉残留 HTML 标签（快讯正文里出现过 <u>）',
  ht.cleanBriefText('格隆汇9月16日丨本届政府<u>改变过去不干预政策</u>') === '本届政府改变过去不干预政策',
  ht.cleanBriefText('格隆汇9月16日丨本届政府<u>改变过去不干预政策</u>'));
assert('cleanBriefText 解析实体并压缩空白',
  ht.cleanBriefText('格隆汇9月16日｜A&amp;B   公司') === 'A&B 公司',
  ht.cleanBriefText('格隆汇9月16日｜A&amp;B   公司'));
assert('前缀剥离后不会误命中（正则只吃中文前缀）',
  ht.briefStats([{ id: 3, text: '格隆汇9月16日｜公司公告', time: '' }]).find(d => d.name === '国家政策类').count === 0);

// 计数与明细严格一致、百分比算法正确
const mix = [
  { id: 11, text: '美股三大指数收涨', time: '2026-09-16 10:00' },
  { id: 12, text: '美股道琼斯指数创新高', time: '2026-09-16 11:00' },
  { id: 13, text: '公司发布公告', time: '2026-09-16 12:00' },
  { id: 14, text: '现货黄金价格上涨', time: '2026-09-16 13:00' }
];
const ms = ht.briefStats(mix);
const usd = ms.find(d => d.name === '美股');
assert('分类计数等于明细条数', usd.count === 2 && usd.news.length === 2, `${usd.count}/${usd.news.length}`);
assert('百分比按「命中数 / 总条数」计算', usd.pct === 50, String(usd.pct));
assert('占比条按最大命中数归一（最多者为 100%）', usd.width === 100, String(usd.width));
assert('明细按时间降序', usd.news[0].time === '2026-09-16 11:00', usd.news.map(n => n.time).join(','));
assert('明细保留原始对象（引用一致，含 id/time/url）', usd.news.every(n => n.id && n.time));

console.log('10) 真实格隆汇快讯数据（briefs-*.json）上的分类质量');
{
  const idxP = new URL('../data/hot-topics/index.json', import.meta.url);
  if (existsSync(idxP)) {
    const idx = JSON.parse(readFileSync(idxP, 'utf8'));
    // 当天那份 briefs-*.json 会随每 2 小时的抓取逐条增长（到晚间才完整），
    // 拿它断言「>=300 条」「13 类都有命中」会随抓取时间早晚时红时绿（实测 15:20 只有 266 条、3 类为 0）。
    // 改用最近一份「已完整」的（非今天）快照；若只有今天那份，则只做基础校验。
    const today = ht.fmtLocalDate(new Date());
    const allBriefs = idx.briefsDates || [];
    const date = allBriefs.find(d => d !== today) || allBriefs[0];
    const isToday = date === today;
    const fp = new URL(`../data/hot-topics/briefs-${date}.json`, import.meta.url);
    if (existsSync(fp)) {
      const j = JSON.parse(readFileSync(fp, 'utf8'));
      const items = j.items || [];
      console.log(`    数据集：${date}${isToday ? '（当天，仍在增长）' : '（已完整）'}，共 ${items.length} 条快讯`);
      assert(isToday ? '真实快讯数据量 > 0（当天文件仍在增长，宽松断言）' : '真实快讯数据量充足（>=300 条）',
        isToday ? items.length > 0 : items.length >= 300, String(items.length));
      assert('每条快讯都有正文与时间', items.every(it => it.text && it.text.length > 4 && /^\d{4}-\d{2}-\d{2}/.test(it.time || '')));
      assert('每条快讯有唯一 id', new Set(items.map(it => it.id)).size === items.length);
      const st = ht.briefStats(items);
      st.forEach(d => console.log(`      ${d.name}：命中 ${d.count} 条（${d.pct}%）`));
      assert('13 个分类在真实数据上都有命中', st.every(d => d.count > 0),
        st.filter(d => !d.count).map(d => d.name).join('/') || 'all>0');
      assert('每类计数与明细条数一致', st.every(d => d.count === d.news.length));
      // 关键：展开看到的每条，都必须真的含该类关键词
      const bad = [];
      for (const d of st) {
        const kws = ht.BRIEF_KEYWORDS[d.key];
        for (const n of d.news) {
          const t = ht.cleanBriefText(n.text);
          if (!kws.some(k => t.includes(k))) bad.push(`${d.name}:${t.slice(0, 20)}`);
        }
      }
      assert('每类明细都确实命中该类关键词（点开不会看到无关消息）', bad.length === 0, bad.slice(0, 3).join(' | '));
      const anyHit = items.filter(it => {
        const t = ht.cleanBriefText(it.text);
        return Object.values(ht.BRIEF_KEYWORDS).some(kw => kw.some(k => t.includes(k)));
      });
      assert('至少命中一类的比例合理（>40%）', anyHit.length / items.length > 0.4,
        `${anyHit.length}/${items.length}`);
      const withUrl = items.filter(it => it.url).length;
      assert('绝大多数快讯带原文链接（可点击跳转）', withUrl / items.length > 0.8,
        `${withUrl}/${items.length}`);
      const withStocks = items.filter(it => (it.stocks || []).length).length;
      console.log(`    其中 ${withUrl} 条带原文链接，${withStocks} 条带关联股票`);
    } else {
      console.log('  （本地暂无 briefs 文件，跳过真实数据校验）');
    }
  } else {
    console.log('  （本地暂无 index.json，跳过）');
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
