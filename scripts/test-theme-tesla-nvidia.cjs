/* 题材归类新增「特斯拉 / 英伟达」子类回归测试
 * 验证：
 *  1) 题材归类维度新增 t_特斯拉 / t_英伟达 两个子类；
 *  2) 与特斯拉/马斯克有关的新闻归入「特斯拉」子类；
 *  3) 与英伟达/黄仁勋有关的新闻归入「英伟达」子类；
 *  4) 题材归类特有的多标签逻辑：上述新闻可同时出现在其它子类
 *     （英伟达新闻同时出现在「半导体」；特斯拉/马斯克新闻同时出现在「汽车」）；
 *  5) 品牌词从「世界百强(fortune500)」移除，避免歧义折价导致单提一次无法归类。
 */
const HT = require('../js/hot-topics.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
}

const mode = HT.BRIEF_MODES.find(m => m.key === 'theme');
const dimKeys = mode.dims.map(d => d.key);
const nameOfKey = {};
mode.dims.forEach(d => { nameOfKey[d.key] = d.name; });
function cats(text) {
  return HT.scoreEntries(text, mode.dict, dimKeys, k => nameOfKey[k]).map(r => r.key);
}
function has(text, key) { return cats(text).includes(key); }

console.log('1) 题材归类维度应包含新子类');
assert(mode.dims.some(d => d.key === 't_特斯拉' && d.name === '特斯拉'), '存在 t_特斯拉 / 特斯拉 子类');
assert(mode.dims.some(d => d.key === 't_英伟达' && d.name === '英伟达'), '存在 t_英伟达 / 英伟达 子类');

console.log('2) 词表挂载正确');
assert((mode.dict['t_特斯拉'] || []).some(w => w === '特斯拉' || w === '马斯克'), 't_特斯拉 含 特斯拉/马斯克');
assert((mode.dict['t_英伟达'] || []).some(w => w === '英伟达' || w === '黄仁勋'), 't_英伟达 含 英伟达/黄仁勋');
assert(!(mode.dict['fortune500'] || []).includes('特斯拉'), '世界百强 已移除 特斯拉（消除歧义折价）');
assert(!(mode.dict['fortune500'] || []).includes('英伟达'), '世界百强 已移除 英伟达');
assert(!(mode.dict['fortune500'] || []).includes('马斯克'), '世界百强 已移除 马斯克');
assert(!(mode.dict['fortune500'] || []).includes('黄仁勋'), '世界百强 已移除 黄仁勋');

console.log('3) 特斯拉/马斯克新闻 → 特斯拉 子类');
assert(has('马斯克宣布特斯拉Optimus人形机器人量产计划', 't_特斯拉'), '马斯克新闻进入「特斯拉」');
assert(has('特斯拉上海超级工厂交付量创历史新高', 't_特斯拉'), '单提「特斯拉」也能进入「特斯拉」（无歧义折价）');
assert(has('特斯拉Model Y降价搅动汽车板块', 't_特斯拉'), '特斯拉汽车新闻进入「特斯拉」');

console.log('4) 英伟达/黄仁勋新闻 → 英伟达 子类');
assert(has('英伟达发布新一代Blackwell GPU，黄仁勋称算力需求爆发', 't_英伟达'), '英伟达新闻进入「英伟达」');
assert(has('黄仁勋：英伟达下一代芯片量产在即', 't_英伟达'), '黄仁勋新闻进入「英伟达」');
assert(has('NVIDIA盘中大涨创历史新高', 't_英伟达'), 'NVIDIA 英文也能进入「英伟达」');

console.log('5) 题材归类多标签：同时出现在其它子类');
assert(has('英伟达发布新一代Blackwell GPU，黄仁勋称算力需求爆发', 't_半导体'), '英伟达新闻也出现在「半导体」子类（用户示例）');
assert(has('特斯拉Model Y降价搅动汽车板块', 't_汽车'), '特斯拉新闻也出现在「汽车」子类');
assert(has('马斯克宣布特斯拉Optimus计划', 't_汽车'), '马斯克新闻也出现在「汽车」子类');

console.log('6) 一条新闻可同时命中多个子类（多标签机制）');
const n = cats('英伟达发布新一代Blackwell GPU，黄仁勋称算力需求爆发').length;
const t = cats('特斯拉Model Y降价搅动汽车板块').length;
assert(n >= 2, '英伟达新闻命中子类数 >= 2（实际 ' + n + '）');
assert(t >= 2, '特斯拉新闻命中子类数 >= 2（实际 ' + t + '）');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
