// 本地快照逻辑断言测试（复刻 app.js 的存取逻辑）
const HT_SNAPSHOT_KEEP_DAYS = 60;
let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? ('=> ' + JSON.stringify(extra)) : ''); }
}
function fmtDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getLocalHotTopicSnapshot(Store, date) {
  const m = Store.data && Store.data.hotTopicSnapshots;
  return (m && m[date]) || null;
}
function saveLocalHotTopicSnapshot(Store, sources, dateStr) {
  if (!sources || !sources.length) return;
  if (!Store.data.hotTopicSnapshots) Store.data.hotTopicSnapshots = {};
  const slim = sources.map(s => ({
    rank: s.rank, key: s.key, name: s.name, color: s.color,
    items: (s.items || []).map(it => ({ text: it.text, time: it.time, url: it.url, cat: it.cat }))
  }));
  if (!slim.some(s => s.items.length)) return;
  Store.data.hotTopicSnapshots[dateStr] = { date: dateStr, generatedAt: new Date().toISOString(), sources: slim };
  const keys = Object.keys(Store.data.hotTopicSnapshots).sort();
  while (keys.length > HT_SNAPSHOT_KEEP_DAYS) {
    delete Store.data.hotTopicSnapshots[keys.shift()];
  }
}
const mk = (n) => ([
  { rank: 1, key: 'gelonghui', name: '格隆汇', color: '#c8102e', items: [{ text: 't' + n, time: '2026-09-16 10:00', url: 'u', cat: '财经' }] }
]);

console.log('1) 保存后可读回，且结构精简');
const S = { data: { hotTopicSnapshots: {} } };
saveLocalHotTopicSnapshot(S, mk(1), '2026-09-16');
const snap = getLocalHotTopicSnapshot(S, '2026-09-16');
assert('快照可读回', !!snap);
assert('date 字段正确', snap && snap.date === '2026-09-16', snap && snap.date);
assert('含 generatedAt', !!(snap && snap.generatedAt));
assert('sources 结构完整', !!(snap && snap.sources[0].rank === 1 && snap.sources[0].key === 'gelonghui' && snap.sources[0].items[0].text === 't1'));
assert('未知日期返回 null', getLocalHotTopicSnapshot(S, '2000-01-01') === null);

console.log('2) 全空源不覆盖已有快照');
const before = JSON.stringify(getLocalHotTopicSnapshot(S, '2026-09-16'));
saveLocalHotTopicSnapshot(S, [{ rank: 1, key: 'x', name: 'X', color: '#000', items: [] }], '2026-09-16');
assert('空数据未覆盖', JSON.stringify(getLocalHotTopicSnapshot(S, '2026-09-16')) === before);
saveLocalHotTopicSnapshot(S, [], '2026-09-16');
assert('空数组未覆盖', JSON.stringify(getLocalHotTopicSnapshot(S, '2026-09-16')) === before);

console.log('3) 超过 60 天自动裁剪最旧');
const S2 = { data: { hotTopicSnapshots: {} } };
for (let i = 0; i < 65; i++) {
  const d = new Date('2026-01-01T00:00:00'); d.setDate(d.getDate() + i);
  saveLocalHotTopicSnapshot(S2, mk(i), fmtDate(d));
}
const keys = Object.keys(S2.data.hotTopicSnapshots).sort();
assert('保留天数 = 60', keys.length === 60, keys.length);
assert('最旧保留日 = 2026-01-06（前5天被裁剪）', keys[0] === '2026-01-06', keys[0]);
assert('最新日 = 2026-03-06', keys[keys.length - 1] === '2026-03-06', keys[keys.length - 1]);

console.log('4) 反向兼容：Store.data 缺失字段时自动初始化');
const S3 = { data: {} };
saveLocalHotTopicSnapshot(S3, mk(1), '2026-09-16');
assert('缺失时自动建对象', !!(S3.data.hotTopicSnapshots && S3.data.hotTopicSnapshots['2026-09-16']));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
