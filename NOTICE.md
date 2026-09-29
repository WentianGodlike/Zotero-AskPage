# NOTICE — 来源与许可

本插件（AskPage）建立在 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
之上，并使用了若干第三方依赖。此文件说明各部分来源，以便遵守各自的许可条款。

## 1. 来自 zotero-plugin-template 的文件

以下文件自上游模板**原样**保留（未修改），版权归 windingwind 及模板贡献者，
许可为 **AGPL-3.0-or-later**：

| 文件                    | 说明                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `addon/bootstrap.js`    | 插件引导脚本。上游模板转引自 Zotero 官方的 [Make It Red](https://github.com/zotero/make-it-red) 示例，文件头的署名注释已原样保留 |
| `src/index.ts`          | 插件实例注册                                                                                                                     |
| `src/utils/ztoolkit.ts` | ztoolkit 实例工厂                                                                                                                |
| `src/utils/locale.ts`   | Fluent 本地化封装                                                                                                                |
| `src/utils/window.ts`   | 窗口工具                                                                                                                         |
| `src/utils/prefs.ts`    | 偏好项读写封装                                                                                                                   |
| `typings/global.d.ts`   | 全局类型声明                                                                                                                     |

本项目的其余源码为独立编写。由于整体以模板为基础，**本项目整体沿用
AGPL-3.0-or-later**（见 `LICENSE`）。

> 为什么可以用：模板本身就是为「让别人据此开发插件」而发布的，采用 AGPL-3.0。
> 使用它的代价是衍生作品也必须以 AGPL-3.0 发布——本项目正是这么做的。

## 2. 运行时依赖

| 组件                                                                          | 许可    | 用途                                                                                                                                         |
| ----------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [KaTeX](https://katex.org/)                                                   | **MIT** | 数学排版。库被 bundle 进 `content/scripts/highlightask.js`，样式表输出为 `content/katex.css`，字体随插件分发（见下）。MIT 与 AGPL-3.0 兼容。 |
| [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) | **MIT** | 被 bundle 进 `content/scripts/highlightask.js`。MIT 与 AGPL-3.0 兼容。                                                                       |

### 关于 KaTeX 字体

字体**随插件分发**（`addon/assets/fonts/` 下 20 个 woff2，约 296 KB）。

早期版本改为复用 Zotero 笔记编辑器自带的副本，以省下这点体积，但那是错的：
Zotero 的字体文件名带**构建期内容哈希**（`KaTeX_AMS-Regular.73ea273a.woff2`），
而按固定名改写出的 URL（`KaTeX_AMS-Regular.woff2`）**一个也不存在**。结果是每个
字体请求都失败、浏览器回退到系统衬线体，公式的字形变得扁平——看起来像"公式
渲染坏了"，而不是"字体没加载"。该目录名在 Zotero 各版本间也不稳定，没有可靠的
名字可以引用。

因此自带字体，换取零外部依赖。`katex.css` 中的 `@font-face` 只保留 woff2 一项
（woff / ttf 回退会被去掉，因为包里没有那些文件），字体 URL 在构建期改写为相对
路径 `../assets/fonts/`。
