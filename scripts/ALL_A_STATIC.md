# 全 A 股静态名单 · 启用说明（第2项）

## 它解决什么问题

「尾盘买入法 → 对 A 股全部股票筛选」原本要向东方财富翻 25~60 页才能凑齐名单，
现在代码已经改成：

- **首页探测自适应**：用第 1 页探测服务端真实每页上限，支持大页就一次拉完
  （若服务端允许 `pz=6000`，**25 次请求降到 1 次**）
- **批内并发 6 + 批间 40ms**：取代原来的「串行 + 每页死等 150ms」
- **名单缓存**：优先读静态名单 → 本机 localStorage 名单 → 直接走实时分页

**这些优化不需要下面任何操作，已经全部生效。** 下面的步骤是「锦上添花」：
把每天只变化几只的股票名单预先算好存成静态文件，让页数计算更精确。

> ⚠️ 重要：**名单里不会缓存价格/涨跌幅/市值**。那些是盘中数据，静态化会过期，
> 用来做尾盘筛选会得出错误结论。价格始终由实时接口补齐。

---

## 启用方式 A：GitHub Actions 自动生成（推荐，一次设置永久有效）

因为 fine-grained Token 没有 Workflows 写权限，这一步需要你在 GitHub 网页上操作一次
（纯网页，不用装 git）：

1. 打开 `https://github.com/xinwenfuwu/stock-news-tracker`
2. 点顶部 **Actions** → 左侧 **New workflow**
3. 页面右上 … → **set up a workflow yourself**（或直接编辑空白模板）
4. 文件名填 `all-a-stocks.yml`，把下面整段粘进去 → **Commit changes**

```yaml
name: all-a-stocks
on:
  schedule:
    - cron: '0 1,7 * * 1-5'    # 北京时间每天 09:00 / 15:00（周一~周五各两次）
  workflow_dispatch:            # 也支持手动点「Run workflow」

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: 生成全 A 股名单
        run: node scripts/fetch-all-a-stocks.mjs
      - name: 提交
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          if [ -n "$(git status --porcelain)" ]; then
            git add data/stocks/all-a.json
            git commit -m "chore: refresh all-a stock list"
            git push
          else
            echo "名单无变化，跳过提交"
          fi
```

提交后可以立刻手动跑一次验证：Actions → **all-a-stocks** → **Run workflow**。
跑完后仓库里会出现 `data/stocks/all-a.json`（约 5000+ 只，350KB 左右，gzip 后不到 60KB）。

---

## 启用方式 B：在本机跑一次

前提：你的网络能直连 `push2.eastmoney.com`（用这个软件的环境一般都可以）。

```bash
git clone https://github.com/xinwenfuwu/stock-news-tracker.git
cd stock-news-tracker
node scripts/fetch-all-a-stocks.mjs
git add data/stocks/all-a.json && git commit -m "chore: all-a list" && git push
```

脚本自带两道保护，不会产生坏数据：

- 抓到的数量少于 1000 只 → 判定失败，**不写文件**
- 比上一次少了 20% 以上 → 判定网络抖动残缺，**保留上一次的好文件**

---

## 完全不启用会怎样？

**没有影响，该有的提速已经在代码里生效了。** 分级降级是这样的：

| 名单来源 | 状态 | 表现 |
|---|---|---|
| `data/stocks/all-a.json` | 未生成 | 跳过 |
| 本机 localStorage | 第一次拉取后自动写入，7 天有效 | **命中**：页数精确，少发探测请求 |
| 实时分页自带 | 兜底 | 与旧版本一致，但因为并发 + pz 自适应，仍快很多 |

每个用户第一次点「对 A 股全部股票筛选」成功之后，名单就自动落到本机，
之后 7 天内都按「名单已知」的方式跑，不需要任何服务端配合。

---

## 文件说明

- `scripts/fetch-all-a-stocks.mjs` —— 生成脚本
- `data/stocks/all-a.json` —— 产物（Actions 自动维护，不要手改）
  ```json
  { "date":"2026-09-19", "generatedAt":"...", "source":"eastmoney-clist",
    "total":5432, "items":[{"code":"sh600000","pureCode":"600000","name":"浦发银行"}] }
  ```
