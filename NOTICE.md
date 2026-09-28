# NOTICE — 来源与许可

本插件（Highlight Ask）建立在 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
之上，并使用了若干第三方依赖。此文件说明各部分来源，以便遵守各自的许可条款。

## 1. 来自 zotero-plugin-template 的文件

以下文件自上游模板**原样**保留（未修改），版权归 windingwind 及模板贡献者，
许可为 **AGPL-3.0-or-later**：

| 文件 | 说明 |
| --- | --- |
| `addon/bootstrap.js` | 插件引导脚本。上游模板转引自 Zotero 官方的 [Make It Red](https://github.com/zotero/make-it-red) 示例，文件头的署名注释已原样保留 |
| `src/index.ts` | 插件实例注册 |
| `src/utils/ztoolkit.ts` | ztoolkit 实例工厂 |
| `src/utils/locale.ts` | Fluent 本地化封装 |
| `src/utils/window.ts` | 窗口工具 |
| `src/utils/prefs.ts` | 偏好项读写封装 |
| `typings/global.d.ts` | 全局类型声明 |

本项目的其余源码为独立编写。由于整体以模板为基础，**本项目整体沿用
AGPL-3.0-or-later**（见 `LICENSE`）。

> 为什么可以用：模板本身就是为「让别人据此开发插件」而发布的，采用 AGPL-3.0。
> 使用它的代价是衍生作品也必须以 AGPL-3.0 发布——本项目正是这么做的。

## 2. 运行时依赖

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) | **MIT** | 被 bundle 进 `content/scripts/highlightask.js`。MIT 与 AGPL-3.0 兼容。 |

构建工具链（esbuild、TypeScript、zotero-plugin-scaffold、zotero-types 等）
仅用于开发，不随插件分发。

## 3. 外部实现参考（无代码复制）

开发过程中**阅读过**以下项目的源码，用于确认 Zotero 的插件 API 用法。
这些是 API 的**调用方式**（公开接口，非受版权保护的表达），不是实现代码：

| 项目 | 许可 | 我们从中确认了什么 |
| --- | --- | --- |
| [zotero-deepseek](https://github.com/Loooookk/zotero-deepseek) | 声明 MIT（仓库内无 LICENSE 文件） | 确认 `Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID)` 的签名，以及 `params.annotation.text` / `reader._iframeWindow.getSelection()` 两条取选中文本的路径 |
| [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) | AGPL-3.0 | 仅用于比对 `manifest.json` 的兼容性字段写法，并用它做安装对照实验。**未参考其功能实现** |
| [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) | AGPL-3.0 | 见第 1 节 |

最终实现与上述项目均不相同，且修正了参考实现中存在的问题
（例如：Zotero 的 `append()` 会跨 iframe 克隆节点并**丢弃事件监听器**，
必须先插入、再在克隆体上绑定；参考实现是"先绑定后插入"）。
划词弹窗的按钮样式、面板 UI、Markdown 渲染器（零 `innerHTML`）、
流式 SSE 客户端、厂商预设与配置校验均为本项目独立实现。

## 4. 与 Zotero 官方的关系

本项目是**第三方插件**，与 [Zotero](https://www.zotero.org/) 官方无隶属关系，
未获其背书。名称中未使用 "Zotero" 商标作为产品标识。

## 5. 用户数据

插件不收集、不上传任何用户数据。API Key 与文献内容仅保存在本机 Zotero 配置中，
请求由用户的电脑直接发往用户自行配置的模型服务商。
