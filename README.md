# SCBOY 二楼竞猜 · LLM 智能辅助

一个 **Tampermonkey 油猴脚本**，用大模型帮你分析 [SCBOY](https://www.scboy.cc/) 二楼「老板请上二楼」竞猜盘口的胜率，并按 **Half-Kelly** 公式给出建议下注金额，支持 **一键填入** 或 **一键下注**。

- 仓库：<https://github.com/Dddota/scboy-2floor>
- 一键安装：<https://raw.githubusercontent.com/Dddota/scboy-2floor/main/scboy-bet-helper.user.js>
- 反馈 / Issue：<https://github.com/Dddota/scboy-2floor/issues>

> ⚠️ **免责声明**：本脚本仅供学习和研究用途。竞猜有风险，LLM 判断存在错误可能，任何金币损失自负。**不要用真金白银场景**。

---

## 特性

- 🧠 **LLM 分析**：调用任意 OpenAI 兼容 API（DeepSeek / Kimi / OpenAI / OpenRouter / 本地 Ollama…），估算双方真实胜率
- 🔎 **抓取 liquipedia**：如果详情页描述里带 `liquipedia.net` 链接，自动抓正文喂给 LLM，显著提升准确率
- 💰 **Half-Kelly 仓位管理**：按分数凯利公式计算最优下注比例，兼顾收益与波动
- 🌀 **动态赔率修正**：SCBOY 用 parimutuel（奖池分摊）机制，你自己的下注会稀释同侧赔率，脚本做 3 步不动点迭代逼近真实收益
- 🛡️ **多重安全阀**：EV 阈值、单笔上限、硬下限硬上限、二次确认
- 🎛️ **半自动模式**：脚本只**推荐**，你决定是否点「一键下注」

---

## 安装

### 1. 安装 Tampermonkey

- **Chrome / Edge**: [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Firefox**: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/)

### 2. 安装脚本

打开 `scboy-bet-helper.user.js`，把整个文件内容粘到 Tampermonkey：
1. 点 Tampermonkey 图标 → **管理面板**
2. 顶部 tab 切到 **`+`（添加脚本）**
3. 清空默认模板，粘入本文件全部内容
4. Ctrl+S 保存

或者：把该文件直接拖到 Tampermonkey 图标上。

### 3. 配置 LLM（快速通道 · 推荐）

点 Tampermonkey 图标 → 找到本脚本条目 → 点 **🎯 选择服务预设**，按编号选一个，脚本会自动填好 `base_url`、模型示例，然后向你要 API Key。

也可以点 **⚙️ 设置** 手动逐项填写：

| 字段 | 说明 | 示例 |
|---|---|---|
| `base_url` | OpenAI 兼容 API 的 base URL，末尾不加 `/` | `https://api.deepseek.com` |
| `api_key` | 你的 API Key | `sk-xxxxxxxx` |
| `model` | 模型名 | `deepseek-v4-flash` |
| `temperature` | 采样温度，越低越保守 | `0.2` |
| `凯利折扣` | 0.5=Half-Kelly（推荐）；1=Full 太激进；0.25=更保守 | `0.5` |
| `最小 EV 阈值` | 边际低于此值不推荐下注 | `0.05` (即 5%) |
| `单笔上限%` | 单笔最多用多少余额（防梭哈） | `0.15` (即 15%) |
| `硬下限` | 站点最低 100 | `100` |
| `硬上限` | 站点最高 10000 | `10000` |
| `调试日志` | true / false | `false` |

设完后，点 Tampermonkey → **🔌 测试 LLM 连通性** 验证 key。

---

## 使用

### 详情页：LLM 分析 + 一键下注

进入任意竞猜详情页（URL 形如 `/?bet-detail-5537.htm`，二选一 / 三选一 / 四选一均支持），页面顶部会自动注入一个面板：

```
🤖 LLM 竞猜辅助                 [v0.1]
[开始分析]  将调用大模型并抓取 liquipedia 分析。
```

点 **开始分析**，脚本会：
1. 抓详情页里的 liquipedia 链接（如果有）
2. 组装 prompt 调用你配置的 LLM
3. 展示每方胜率、EV、Half-Kelly 建议金额、理由
4. 额外一行 **「LLM vs 市场」分歧**：LLM 胜率 − 市场隐含胜率（按资金池比例算的市场共识），分歧越大越"偏离市场"，是本脚本产生正 EV 的唯一来源
5. 三个按钮：
   - **📝 一键填入**：只勾选选项 + 填金额，不提交
   - **🎯 一键下注**：填完之后模拟点「下注」按钮（会先弹一个 confirm，然后触发站点原生的 `popDialog()` 二次确认）
   - **🔄 重新分析**：重跑一次

### 列表页：市场信息徽章（不调用 LLM）

在竞猜首页 `https://www.scboy.cc/`，脚本会给每条**「竞猜中」**的行注入一个 🔍 分析按钮和一个徽章（最多 20 条，超过就不注入了）。

**两种模式**（Tampermonkey 菜单里切换）：

- **⬜ 手动模式**（默认）：只注入按钮，你点哪个抓哪个。低调，不像爬虫。
- **✅ 自动扫描模式**：进列表页后按 200ms 间隔排队自动跑一遍未缓存的行，命中缓存的直接展示不重发请求。

**共同规则**：
- 徽章初始状态 `⚪ 未分析`。
- 分析时后台抓一次该场的详情页 HTML（不打开新标签），解析两边资金池 → 算**市场隐含胜率**和**失衡幅度**，显示为 `🔵 BASILISK 67% · 失衡 34%`。
- **这一步完全不调用 LLM，也不算推荐**——只是把详情页里的市场信息前置到列表，帮你筛选值得深挖的场次（比如极度一边倒的、或者 50-50 势均力敌的）。
- 结果缓存 **15 分钟**（同一场再进会立刻从缓存显示，并附带 `⏱N m 前` 标记，到期前不再重复请求）。
- 悬停徽章可看两侧详细的池/赔率。
- 后台并发限制 2，带随机抖动（150-600ms），避免被网站当爬虫。
- 菜单里的 `🧹 清空列表页缓存` 可以强制刷新。

> **市场隐含胜率不是真概率**——它是资金池按比例分摊出来的市场共识。盲跟市场押 EV=0，要产生正 EV 必须**偏离市场**，那才是详情页里 LLM 分析的价值。列表页徽章只帮你选择"看哪一场"，不告诉你"该押谁"。

> ⚠️ **反爬提醒**：开启自动扫描等于进列表页就发最多 20 个请求。虽然有 2 并发 + 抖动，但如果 scboy 管理不希望这么做，请保持手动模式。

---

## 核心公式

### 期望值 EV
对某一选项，赔率 `odds`（含本金）、LLM 估计胜率 `p`：
```
EV = p * odds - 1
```
`EV > 0` 才是理论盈利下注。

### Half-Kelly
Kelly 最优比例：
```
b = odds - 1   (净收益倍率)
q = 1 - p
f* = (b*p - q) / b
```
最终下注金额：
```
stake = floor(balance * f* * kellyFrac)
stake = min(stake, balance * maxStakePct, maxStake)
```
若 `stake < minStake` 或 `EV < minEV`，脚本不推荐下注。

### 动态赔率修正
SCBOY 用 parimutuel 机制：赢方按同侧下注比例瓜分对手奖池。若你下注 `x` 到 side A：
```
newOdds_A = 1 + poolB / (poolA + x)
```
脚本迭代 3 次不动点，逼近真实 EV。

---

## 常见问题

**Q: 面板没出现？**
- URL 一定要是 `/?bet-detail-XXX.htm` 形式（详情页）
- 已经下注过就不显示（防重复分析）
- 大小盘等特殊玩法暂不支持
- F12 → Console，看有没有 `[SCBOY-Bet]` 报错

**Q: LLM 返回 401 / 403?**
- API Key 错了，或者 base_url 末尾多带了 `/`
- 用「🔌 测试 LLM 连通性」诊断

**Q: 抓 liquipedia 失败？**
- 首次运行 Tampermonkey 可能弹出询问「是否允许连接 liquipedia.net」，选 **总是允许**
- 如果没弹窗，去脚本管理里检查 `@connect liquipedia.net`

**Q: 建议金额看着太保守？**
- 凯利折扣调到 `0.75` 或 `1.0`（不推荐 Full Kelly，方差极大）
- 单笔上限 `maxStakePct` 调大
- 但 **动态赔率机制** 决定了你砸太多会自己稀释赔率，反而不划算

**Q: LLM 给的胜率不靠谱？**
- 换更强的模型（如 `gpt-4o` / `claude-3-5-sonnet` / `gemini-2.5-pro`）
- 换支持联网搜索的模型（Kimi / OpenRouter 的 `:online` 后缀）
- 提高 `最小 EV 阈值` 到 `0.1`，只吃大边际

---

## 支持的盘口

- ✅ 二选一（胜负、A vs B）
- ✅ 多选一（3/4/5... 选一，K 选一 LLM+Kelly 已支持；scboy 表单一次只能押一个，脚本会自动选 EV 最高的那一侧）
- ❌ 大小盘、区间猜分、复杂玩法 —— 未来版本

---

## 支持的 LLM 服务示例

| 服务 | base_url | 示例模型 | 备注 |
|---|---|---|---|
| **DeepSeek (V4)** | `https://api.deepseek.com` | `deepseek-v4-flash`, `deepseek-v4-pro` | 国内快，性价比首选。旧 `deepseek-chat`/`deepseek-reasoner` 2026/07/24 弃用 |
| **阿里千问 Qwen（国内）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`, `qwen-max`, `qwen-turbo`, `qwen3-max` | 国内直连快 |
| **阿里千问 Qwen（国际）** | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 同上 | 海外/香港节点 |
| **字节方舟 Doubao** | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-1-6-250615`, `doubao-1-5-pro-32k-250115`, 或控制台创建的 `ep-xxx` | ⚠️ **必须先在方舟控制台开通模型或创建接入点**，否则报错 |
| **Kimi 月之暗面** | `https://api.moonshot.ai/v1` | `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code` | 长上下文强。旧域名 `api.moonshot.cn` 仍兼容国内 key。⚠️ `kimi-k3` 强制 `temperature=1.0` |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o`, `gpt-4o-mini`, `gpt-4.1` | 需自备网络 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o`, `anthropic/claude-sonnet-4.6`, `google/gemini-2.5-pro:online` | 一 key 用全家桶；`:online` 后缀可联网 |
| **本地 Ollama** | `http://localhost:11434/v1` | `qwen2.5:32b`, `deepseek-r1:14b` | api_key 填任意字符串 |
| **GitHub Copilot（本地代理）** | `http://localhost:4141/v1` | `gpt-4o`, `claude-sonnet-4.5`, `gemini-2.5-pro` | 见下方专门小节 |

> 想加新家？只要它是 OpenAI 兼容的 `/chat/completions` 接口就行，用「⚙️ 设置」手填 base_url 即可。

### ⚠️ 字节方舟第一次用要注意

方舟不像 DeepSeek 开箱即用，必须先去 [方舟控制台](https://console.volcengine.com/ark) 做**一次**开通：

**方式 A（简单）**：在【模型广场】找到 Doubao 系列，点击「立即使用」→ 完成开通协议 → 直接用官方 endpoint id 如 `doubao-seed-1-6-250615`。

**方式 B（灵活）**：在【在线推理】创建【接入点】，选一个模型 → 会得到 `ep-XXXXXX` 形式的 ID → 把这个 ID 填到脚本 model 字段。

如果第一次调用返回 `The model does not exist or you do not have access`，就是没做上面这步。

### 如果你有 GitHub Copilot 订阅，想用它

Copilot 官方不支持第三方直接调用（有封号风险），所以脚本**不内嵌 Copilot 登录**。推荐用开源本地代理把 Copilot 包装成标准 OpenAI 兼容端点：

```bash
# 本地起代理服务（第一次会引导你在浏览器登录 GitHub）
npx copilot-api@latest start
# 默认监听 http://localhost:4141
```

然后在脚本里：
1. 点 **🎯 选择服务预设** → 选 `GitHub Copilot（本地代理）`
2. api_key 随便填一个字符串（比如 `x`）
3. 模型选 `gpt-4o` / `claude-sonnet-4.5` / `gemini-2.5-pro`

参考项目：https://github.com/ericc-ch/copilot-api

> **风险自负**：用第三方代理调用 Copilot 违反 GitHub 官方 ToS，重度使用有账号被限制的风险。如果只是每天分析几十次竞猜盘口，量很小，一般不会触发风控 —— 但你要清楚这个前提。

---

## 项目结构

```
scboy-2floor/
├── scboy-bet-helper.user.js   # 主脚本（单文件）
├── samples/                    # 页面 HTML 样本（供选择器调整参考）
│   ├── list-item.html
│   └── detail-bet.html
└── README.md
```

---

## 反馈

- 🐛 Bug / 页面结构变化 / 新盘口需求 → [提 issue](https://github.com/Dddota/scboy-2floor/issues/new)
- 想调 LLM prompt → 直接改 `buildPrompt()` 函数
- Pull Request 欢迎

---

## 作者 & 许可

- 作者：**Dddota**（脚本由 [OpenCode](https://opencode.ai) 协助生成）
- 许可：[MIT](https://opensource.org/licenses/MIT)
- 项目主页：<https://github.com/Dddota/scboy-2floor>
