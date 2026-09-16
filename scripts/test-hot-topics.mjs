/* 火热话题核心逻辑断言测试（Node，无需浏览器）
 * 验证 classify / clusterItems / siteCategoryStats 在合成数据 + 真实种子数据上正确。 */
import { readFileSync } from 'node:fs';
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
