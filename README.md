# Highlight Ask

在 Zotero 的 PDF 阅读器里**划选一段文字 → 点一个按钮 → 让 AI 当场讲清楚**。

为「读论文时卡在一个公式/一段推导上」这个场景做的。不用切窗口、不用复制粘贴、不用重新交代上下文。

```
┌─ 划选公式 ────────────────────────────────┐
│  … the bound follows from  Σᵢ αᵢ K(xᵢ,x)  │
│                            [解释这段][翻译][有何作用]
└───────────────────────────────────────────┘
                    ↓ 点「解释这段」
┌─ Highlight Ask ───────────────────────[复制][存为笔记][✕]─┐
│ 选中内容                                                   │
│  the bound follows from Σᵢ αᵢ K(xᵢ,x)                     │
├────────────────────────────────────────────────────────────┤
│ 问  请解释这段内容。                                        │
│                                                            │
│ 答  这是一个核展开式。Σᵢ 表示对全部支持向量求和，αᵢ 是…    │
│     $$ f(x) = \sum_i \alpha_i K(x_i, x) $$                 │
│     其中 αᵢ 为对偶变量，K 为核函数…                        │
├────────────────────────────────────────────────────────────┤
│ [继续追问…                                    ] [发送]      │
└────────────────────────────────────────────────────────────┘
```

## 功能

- **划词三连**：`解释这段` / `翻译` / `有何作用`，直接出现在 Zotero 自带的划词弹窗里
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
npm run test:local  # 60 个纯逻辑单测（不需要 Zotero）
npm run check:manifest  # 只校验已构建产物的 manifest
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
    readerPopup.ts       划词弹窗按钮；选中文本清洗（含 arXiv base64 清洗）
    askPanel.ts          浮动面板：流式渲染、追问、复制、存笔记
    deepseek.ts          流式 API 客户端（SSE 分块缓冲 + 参数不支持时自动重试）
    providers.ts         厂商预设查询 + 配置校验（可单测）
    markdown.ts          Markdown → DOM，保护 $公式$，零 innerHTML
    prompts.ts           提示词与快捷动作
    preferences.ts       注册 Zotero 设置面板
addon/
  content/preferences.*  设置界面
  prefs.js               默认配置
scripts/
  check-manifest.py      构建后校验 manifest（防安装失败）
  make-icons.py          按声明尺寸生成图标
test/local.test.ts       纯逻辑单测
```

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
