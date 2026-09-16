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

console.log('4) 真实种子数据（2026-09-15 + 2026-09-16）端到端');
function load(date) {
  try { return JSON.parse(readFileSync(new URL(`../data/hot-topics/${date}.json`, import.meta.url), 'utf8')); }
  catch (e) { return null; }
}
const snap15 = load('2026-09-15'), snap16 = load('2026-09-16');
assert('读取到 09-15 快照', !!snap15, snap15 && 'no');
assert('读取到 09-16 快照', !!snap16);
if (snap15 && snap16) {
  const flat = [];
  for (const snap of [snap15, snap16]) {
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

if (snap15 && snap16) {
  const flatTheme = [];
  for (const snap of [snap15, snap16]) for (const s of snap.sources) for (const it of (s.items || [])) flatTheme.push({ text: it.text, date: snap.date, sourceRank: s.rank, sourceKey: s.key, sourceName: s.name, time: it.time, url: it.url });
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
