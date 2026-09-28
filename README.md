# Highlight Ask

在 Zotero 的 PDF 阅读器里**划选一段文字 → 点一个按钮 → 让 AI 当场讲清楚**。

为「读论文时卡在一个公式/一段推导上」这个场景做的。不用切窗口、不用复制粘贴、不用重新交代上下文。

```
┌─ 在 PDF 里划选 ─────────────────┐
│  … the bound follows from      │
│     Σᵢ αᵢ K(xᵢ,x)              │
│  [解释这段][翻译][有何作用]      │
└────────────────────────────────┘
              ↓ 点「解释这段」
┌─ 右侧边栏 · AI 助手 ──────────[全文][复制][清空]─┐
│ 选中内容                                        │
│  the bound follows from Σᵢ αᵢ K(xᵢ,x)          │
├─────────────────────────────────────────────────┤
│ 上下文：选中片段 + 相邻段落                     │
├─────────────────────────────────────────────────┤
│ 问  请解释这段内容。                            │
│                                                 │
│ 答  这是一个核展开式。Σᵢ 表示对全部支持向量…   │
│     $$ f(x) = \sum_i \alpha_i K(x_i, x) $$      │
│     其中 αᵢ 为对偶变量，K 为核函数…             │
├─────────────────────────────────────────────────┤
│ [问点什么…                          ] [发送]     │
└─────────────────────────────────────────────────┘
```


## 功能

- **右侧边栏**：对话常驻在阅读器侧边栏，随文献切换，不遮挡正文
- **划词三连**：`解释这段` / `翻译` / `有何作用`，出现在 Zotero 自带的划词弹窗里，点了就把问题送进侧栏
- **流式回答**：逐字输出，不用干等
- **显示推理过程**：`deepseek-flash` 默认开思考模式，推理链折叠显示在答案上方（看不懂公式时，这段往往比结论更有用）
- **多轮追问**：面板里可以直接接着问
- **存为笔记**：一问一答存成该文献的子笔记，含选中原文
- **公式友好**：回答里的 `$...$` / `$$...$$` 会被单独渲染成 LaTeX 源码块，不会被 Markdown 的斜体规则吃掉

## 安装

1. 取 [`release/highlight-ask-0.1.0.xpi`](release/highlight-ask-0.1.0.xpi)
2. Zotero → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File…** → 选这个 `.xpi`
3. 重启 Zotero

要求 Zotero **7.9.9 – 10.9.9**（在 10.0.3 上开发）。

## 配置

Zotero → 编辑 → 设置 → **Highlight Ask**。模型服务完全可自定义，不绑定 DeepSeek。

### 服务商预设

下拉里内置了 9 家 + 自定义，选中后会自动填好地址和候选模型，**每一项都可以再手改**：

| 服务商 | 默认地址 |
| --- | --- |
| DeepSeek（官方） | `https://api.deepseek.com` |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter（聚合多家） | `https://openrouter.ai/api/v1` |
| 阿里云百炼 / 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |
| Google Gemini（兼容层） | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Ollama（本地，免 Key） | `http://localhost:11434/v1` |
| 自定义 | 自己填，中转/代理/自建都走这个 |

> ⚠️ **除 DeepSeek 外，地址和模型名都只是"预填"**——厂商改模型名很频繁，我没法逐一核实。
> 所以设置页有「**获取模型列表**」按钮，直接问接口 `/models` 拿真实清单，比内置表准。

### 字段说明

| 项 | 说明 |
| --- | --- |
| API Key | 只存本机 Zotero 配置。选 Ollama 时留空即可（本地端点不发 `Authorization` 头） |
| API 地址 | 填到域名或 `/v1` 都行，**别带 `/chat/completions`**（插件会自动补，带了会被校验拦下） |
| 模型 | 可从下拉选，也能手填。标了「视觉」的才能看图 |
| 获取模型列表 | 调 `/models` 拉真实可用模型，填进下拉框 |
| 测试连接 | 真发一次 `chat/completions` 请求，验证地址+Key+模型整条链路 |
| 温度 | 0~2，**留空则不发送该参数**（思考型模型会忽略它） |
| 折叠显示推理过程 | 思考型模型会先输出推理再给结论，不懂公式时这段往往更有用 |

### 高级：请求参数（JSON）

不同家的"思考/推理"开关字段名不一样，所以这里让你直接写 JSON，会**原样合并进请求体**：

| 服务商 | 建议值 |
| --- | --- |
| DeepSeek | `{"reasoning_effort":"high"}`（可选 `low` / `high` / `max`） |
| OpenAI | `{"reasoning_effort":"medium"}` |
| 其它 | 留空，或按厂商文档填 |

留空则不附加任何字段。**若服务商报「不支持的参数」，插件会自动去掉这些字段重试一次**，不会直接失败。

## 提示词

提示词分三层，**都能在设置页直接改，不用重新打包插件**。留空 = 用内置默认值。

| 层 | 作用 | 改动频率 |
| --- | --- | --- |
| **角色** | 模型是谁、回答给谁看 | 很少动 |
| **阅读场景** | PDF 抽取的文本有什么毛病、公式该怎么处理 | **最值得调的一层** |
| **任务** | 三个快捷按钮各自实际发送的问题 | 按习惯调 |

「翻译」这条任务提示词单独说明一下，因为它踩过两次坑：

```
请把下面这段学术文本翻译成中文。

要求：
- 准确、通顺，符合中文学术表达习惯，按中文语序组织句子
- 不要中英对照：不要写成「中文（English）」这种括号夹注的形式
- 人名、模型名、缩写、符号保留原样；其余词汇正常译成中文
- 数学公式保持 LaTeX 原样，不要展开解释
- 不要逐词硬译，也不要意译到偏离原意

只输出译文本身：不要解释、不要总结、不要补充背景、不要评论、不要加标题。
如果原文因 PDF 抽取而残缺，按最可能的意思翻译，不要凭空补写内容。
```

两个**刻意与常见翻译插件不同**的地方：

- **不写「专业术语保留英文原词」**。这条指令会稳定地产生中英对照的括号夹注
  （`离散化 (discretization)`），读起来比纯译文更碎。只有人名、模型名、
  缩写和符号保留原样——那些确实没有通用译法。
- **保留「不要凭空补写」**。PDF 抽取的片段常是残缺的，一个"顺手润色"的
  翻译会把编造的内容混进原文，而读者分辨不出来。宁可直译。

默认的「阅读场景」层写着这个插件最核心的假设：

> 文本来自 PDF 自动抽取，公式被压平、数学字体私有编码导致符号丢失……
> 遇到疑似抽取错误时，先推断原文最可能是什么，说明推断依据，再作答。
> **不要因为文本残缺就拒绝回答。**

改这一层比改角色更能影响回答质量。设置页每项都有「恢复默认」，也可以一次全部恢复。

### 为什么系统提示词里不含选段

系统消息（角色 + 阅读场景）在**同一篇论文的所有提问中完全一致**，选段和问题都放在用户消息里。
这样前缀缓存（DeepSeek 的上下文缓存、Anthropic 的 prompt caching）才可能命中，长会话下能省不少钱。
这是刻意设计的，有测试保证。

## 上下文

面板顶部有个「**全文**」开关，默认关闭：

| 上下文 | 说明 |
| --- | --- |
| 选中片段 | 总是发送 |
| 相邻段落 | 默认开启。公式依赖的定义常常就在上一段，开销很小 |
| 论文全文 | 按需开启。**取自 Zotero 已建立的索引**，不必重新解析 PDF |

全文超过长度上限时**保留开头和结尾、截掉中间**——论文的摘要和结论通常比中间的方法细节更有用。
面板上的一行状态会实时显示当前实际发送了什么。

## 会话与日志

### 会话：笔记为主 + JSON 镜像

| 目的地 | 位置 | 用途 |
| --- | --- | --- |
| **Zotero 笔记** | 挂在该文献下，标题含「Highlight Ask 会话」 | 主要存档。随文献同步、可全文检索、能直接编辑 |
| JSON 镜像 | `<数据目录>/highlight-ask/sessions/<会话id>.json` | 结构化副本，便于以后做历史面板或导出 |

- **每回答一次就存一次**，不是关窗口才存。中途关掉阅读器不会丢已答的内容。
- 同一篇文献再次提问会**更新同一条笔记**，不会堆一堆。
- 回答在笔记里放在 `<pre>` 中，保证 LaTeX 源码原样保留（否则笔记编辑器会重排 `$...$` 和反斜杠）。
- 存储失败**不会**表现为"回答失败"——回答已经在屏幕上了，存档只是附带动作。

### 日志：只记元数据

`<数据目录>/highlight-ask/logs/requests.jsonl`，每行一条 JSON：

```json
{"ts":"2026-09-28T11:22:33.000Z","provider":"deepseek","model":"deepseek-flash",
 "firstTokenMs":820,"totalMs":6400,"totalTokens":1843,
 "selectionChars":120,"fullTextChars":0,"hasReasoning":true}
```

记：时间、模型、token 数、总耗时、**首字延迟**、选段长度、是否附带全文、是否出错。
**不记**：论文内容、AI 回答。

设置页会显示聚合统计（调用次数 / 总 token / 平均耗时 / 首字延迟 / 各模型分布）。
JSONL 格式意味着可以直接 `jq`、`grep`，或拖进表格软件算成本。



## 公式渲染

回答里的 `$...$` / `$$...$$` 会真正排版出来，而不是显示 LaTeX 源码。

**没有打包 KaTeX**：Zotero 为笔记编辑器自带了 KaTeX 的样式与字体，插件直接复用
（约 50 KB 的 CSS + 20 个 woff2 字体），因此 XPI 体积没有明显增加，字形也与
Zotero 其余部分一致。

两个实现细节：

- Zotero 的 `editor.css` 里还混着 ProseMirror 和笔记编辑器的样式，
  **必须过滤**，否则会污染阅读器面板。过滤 + 字体路径重写见
  `extractKatexCss()`，有单测覆盖。
- 字体在 CSS 里是**相对路径**，注入到阅读器文档后会被解析到错误位置，
  所以统一改写成 `resource://zotero/note-editor/...` 绝对路径。
  字体文件名带**内容哈希**（Zotero 升级就会变），因此不能硬编码。

渲染器是自写的 LaTeX 子集引擎（`src/modules/katex.ts`），支持分式、根号、
上下标、希腊字母、常用运算符、求和/积分及其上下限、`\text` 等。
**不是 TeX 引擎**：遇到不认识的命令会原样显示，而不是猜——宁可露出源码，
也不给出一个看起来很确定但错误的符号。上下标优先用 Unicode 上/下标字符
（`x²`、`xᵢ`），没有对应字符时才用 CSS 位移。

若样式表加载失败，数学会退回成等宽的 LaTeX 源码块，而不是空白。

## 关于 DeepSeek 模型的选择

这两个是当前在售的（价格单位：每 1M tokens，非高峰价为高峰价一半）：

| 模型 | 视觉 | 输入（缓存未命中） | 输出 | 说明 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | ✅ | $0.15~0.3 | $0.6~1.2 | **默认选它。** 唯一支持视觉的 |
| `deepseek-v4-pro` | ❌ | $0.66~1.32 | $1.98~3.96 | 推理更强，贵约 4 倍，**不支持视觉** |

关键结论：**以后做「公式截图问 AI」必须用 `deepseek-flash`**，`v4-pro` 收不了图片。
日常划词讲解用 flash 也完全够，text-only 任务没必要上 pro。

> ⚠️ `deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 停用**，写到设置里会直接报 400。


## 开发

```bash
npm install
npm run build       # 打包 .xpi + 类型检查 + manifest 兼容性校验
npm run check       # 类型检查 + 本地单测
npm run test:local  # 90 个纯逻辑单测（不需要 Zotero）
npm run check:manifest  # 只校验已构建产物的 manifest
npm run check:pane      # 按 Zotero 的方式校验设置页标记
npm run diagnose        # 对真实产物做端到端诊断（不用装进 Zotero）
npm run icons       # 重新生成图标（尺寸必须与 manifest 声明一致）
```

> 本机沙箱环境提示：构建工具要写 `~/.cache`，在受限环境下需要
> `XDG_CACHE_HOME=$PWD/../.xdgcache`；`pnpm` 还会被 `zotero-types` 的 git
> 依赖卡住，直接用 `npm install` 即可。

## 踩坑记录：Zotero 报「可能无法与该版本的 Zotero 兼容」

这个报错极具误导性——它看着像版本区间不对，实际是 **Gecko 拒绝了 manifest 本身**。
当时 manifest 里有三处问题，全部修掉才能装上：

| 问题 | 为什么致命 |
| --- | --- |
| `update_url: ""` | **主因。** 空字符串不是合法 URL，manifest 解析直接失败。正确做法是给一个格式合法的 http(s) 地址；本插件从本地文件安装、实际不会走自动更新 |
| 图标尺寸与声明不符 | manifest 声明 `48`/`96`，实际 PNG 是 `16x16`/`32x32`。已由 `scripts/make-icons.py` 按声明尺寸重新生成 |
| `homepage_url` 是编造的地址 | 已从构建配置里移除，不再注入 |

`strict_min_version` / `strict_max_version` 反而是**无辜的**（`7.9.9` / `10.9.9`
和能正常工作的 zotero-pdf-translate 完全一致）。

为了避免再被这个错误信息浪费时间，`scripts/check-manifest.py` 会在每次
`npm run build` 时自动检查上述所有不变量——`update_url` 是否为空或非法、
ID 是否像邮箱、图标实际尺寸、版本区间是否自相矛盾（含是否排除了 Zotero 10）。

### 排查这类问题的正确姿势

报错文案来自 `standalone.addonInstallationFailed.body`（见 Zotero 源码
`chrome/content/zotero/standalone/standalone.js`），它由 Gecko 的
`addon-install-failed` 事件触发。**真正的校验代码编译在 libxul 里，
`omni.ja` 中查不到源码**，所以别指望从 Zotero 源码里找到判定逻辑。

有效手段是：

1. `npx web-ext lint --source-dir .scaffold/build/addon` —— Mozilla 官方校验器，
   能列出 manifest 的 errors / warnings
2. 拿一个**确定能在本机装上的插件**（如 zotero-pdf-translate）逐字段对比 manifest
3. 用 `scripts/check-manifest.py` 把已知不变量固化下来，防止回归

> ⚠️ 别用「把 xpi 丢进 `profile/extensions/`」来测试能否安装：Zotero 10 下
> 这条路**不会触发 AddonManager 注册**，会得到全是假阴性的结果（实测连
> 只改了 id 的 zotero-pdf-translate 都不会被登记）。真正的安装动作要走
> Zotero 界面里的「Install Plugin From File…」。


## 代码结构

```
src/
  hooks.ts               生命周期：注册阅读器事件 + 设置面板
  addon.ts               通过 Zotero.<实例>.api 暴露给设置页的桥接
  data/
    providers.data.ts    厂商/模型预设表（单一数据源，设置页也读它）
  modules/
    sidebar.ts           阅读器侧边栏注册（ItemPaneManager），对话宿主
    chatView.ts          对话视图：流式渲染、追问、上下文开关、存档
    readerPopup.ts       划词弹窗按钮；选中文本清洗（含 arXiv base64 清洗）
    deepseek.ts          流式 API 客户端（SSE 分块缓冲 + 参数不支持时自动重试）
    providers.ts         厂商预设查询 + 配置校验（可单测）
    markdown.ts          Markdown → DOM，保护 $公式$，零 innerHTML
    katex.ts             复用 Zotero 的 KaTeX 样式；LaTeX 子集渲染器（节点树输出）
    prompts.ts           三层提示词、上下文拼装、全文截断（可单测）
    fulltext.ts          读 Zotero 已索引的全文（带缓存）
    notes.ts             会话模型：Zotero 笔记渲染 + JSON 镜像
    requestLog.ts        元数据日志（JSONL）+ 聚合统计
    storage.ts           插件数据目录与文件读写
    preferences.ts       注册 Zotero 设置面板
addon/
  content/preferences.*  设置界面
  prefs.js               默认配置
scripts/
  check-manifest.py      校验 manifest（防安装失败）
  check-pane.py          按 Zotero 的方式解析设置页标记
  check-package.py       校验 XPI 内容完整性（引用与归档是否一致）
  diagnose-pane.mjs      对真实产物做端到端诊断，不用装进 Zotero
  make-icons.py          按声明尺寸生成图标
test/local.test.ts       纯逻辑单测
```

## 界面结构

对话住在**阅读器右侧边栏**（`Zotero.ItemPaneManager.registerSection`），而不是浮在 PDF 上面。

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 侧边栏「AI 助手」 | 阅读器右侧 | 常驻对话：历史、追问、上下文开关、复制、清空 |
| 划词弹窗按钮 | Zotero 自带弹窗 | 把选中的文字和问题送进侧边栏 |

两个设计取舍：

- **对话视图与宿主解耦**。`chatView.ts` 只认一个容器元素，不假设自己是浮层。
  侧边栏是宿主，将来若要加浮层或独立窗口，复用同一份实现，不会出现两套走样。
- **每次渲染重建视图**。Zotero 会在切换条目、重开阅读器时重新渲染 section，
  所以 `onRender` 里先销毁旧视图再建新的——否则上一个流式请求会泄漏。

侧边栏只在**阅读器标签页**出现（`onItemChange` 里按 `tabType === "reader"` 启用）。

**切换文献时，会自动载入该文献最近一次对话**（读 JSON 镜像），所以关掉再打开不丢上下文。

## 三个关键实现决定

### 1. 用官方 `renderTextSelectionPopup`，但必须「先插入、后绑定」

Zotero 7+ 的划词事件把节点**跨 iframe 克隆**（`cloneInto` + `cloneFunctions`）。

**事件监听器不会被克隆保留** —— 先 `addEventListener` 再 `append()` 的写法，按钮点上去没反应。所以 `readerPopup.ts` 是：

```js
append(row);                                    // 先插入
const mounted = doc.querySelector(".ha-selection-actions") ?? row;
wireButtons(mounted, reader, selection);        // 再在克隆体上绑定
```

另外 `append` 必须在事件回调里**同步**调用，否则 Zotero 会抛
`Append must be called directly and synchronously in the event`。

### 2. 选中文本必须先清洗

PDF 文本层不是给人用的。`normalizeSelection()` 处理三类噪声：

- **硬换行/断词**：`hyphen-\nation` → `hyphenation`，其余换行合成段落
- **arXiv 的 LaTeX 垃圾**：很多预印本把每条公式的源码以
  `latexit sha1_base64="..."` + 几千字符 base64 塞进不可见文本层。
  跨公式划选会把这一大坨一起选进来，**token 直接爆掉并严重干扰模型**。
  这里按 `latexit` 标记和「超长 base64 连续串」双重规则清掉。
- **零宽/双向控制字符**：无意义，但会让模型困惑、白烧 token

### 3. Markdown 渲染全程不碰 `innerHTML`

模型输出是不可信内容。`markdown.ts` 只用 `createElement` + `textContent`
构建 DOM，从结构上就不可能注入。

公式在**行内解析之前**就被抽出来存成占位符，否则 `$a_i * b_j$` 里的
`_` 和 `*` 会被当成斜体/粗体标记啃掉。

## 构建期校验

`npm run build` 会依次跑四项检查，任何一项失败都会中断：

| 脚本 | 检查对象 | 防的是什么 |
| --- | --- | --- |
| `tsc --noEmit` | 源码 | 类型错误 |
| `check-manifest.py` | 构建目录的 manifest | `update_url` 为空等导致 Zotero 报「可能无法兼容」 |
| `check-pane.py` | 设置页标记 | 按 **Zotero 的包装方式**解析；XML 声明、id 对不上 |
| `check-package.py` | **打好的 XPI** | 代码引用了但没打进包的文件；Fluent 消息 id 是否真能解析 |
| `check-sandbox-globals.py` | 源码 | 使用了 Zotero 插件沙箱**不提供**的浏览器 API；快捷动作的提示词是否解析成了真字符串 |

前三项看的是**构建目录**，最后一项看的是**真正会被加载的 XPI**。这个区别很关键：
只要「构建目录里有、包里没有」，前三项全过，运行时才炸——而且只留一行控制台错误。

### 两个踩过的坑（都已固化为校验）

1. **`providers.data.js` 没进包**。设置页加载它失败 → 整页空白。
   原因是我只验证了构建目录，没验证归档。现在由 `check-package.py` 覆盖。
2. **`l10nID` 必须写完整消息 id**。脚手架会把 `addon.ftl` 的键改写成
   `<addonRef>-<key>`，所以 Zotero 侧要传 `highlightask-pane-header` 而不是
   `pane-header`。**传错不报错**——界面只会把原始 id 当文字显示出来。
   现在由 `check-package.py` 交叉核对源码里的 `l10nID` 与包内 `.ftl`。

3. **`AbortController` 在沙箱里不存在**。Zotero 用显式白名单
   （`wantGlobalProperties`）构造插件作用域：`fetch` 在，`AbortController` /
   `AbortSignal` 不在。直接 `new AbortController()` 会在运行时抛
   `ReferenceError`，**把整个请求流程打断**，而日志里只有一行。
   现在改为 `canAbort()` 能力检测 + 优雅降级：无法取消时不传 signal，
   「停止」按钮相应不显示。检测见 `check-sandbox-globals.py`。

## 已知限制

这个版本刻意做小，以下几点**还没做**：

- **公式仍然只能靠文本层**。PDF 里划选公式拿到的往往是残缺/乱码的线性文本
  （分式压平、上下标错位、希腊字母丢失）。**没有任何 Zotero 插件能从 PDF
  划出真正的 LaTeX 源码**——这是 PDF 格式本身的限制，不是插件的问题。
  当前策略是：把残缺文本交给模型去猜，并让它用 LaTeX 复述。
- **图片型公式完全无解**（没有文本层，划不中）。
- 没有全文上下文，只发选中片段（省 token，但牺牲了一部分准确度）。

### 下一步候选

1. **截图 + 视觉模型** —— 把选中区域从 PDF canvas 裁成 PNG，连同文字一起发。
   `deepseek-flash` 是原生多模态的，这条路已经通了，是解决公式问题的正解。
2. 结合论文全文（Zotero 已有索引缓存，可直接读）。
3. 划词弹窗里加「附上本页截图」按钮，交给用户按需触发。

## 许可

AGPL-3.0-or-later（沿用 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)）。
