# 渲染回归检查

在真实的 Gecko 里渲染公式，并与 KaTeX 原生输出并排对比。

## 为什么需要它

有三类问题**读代码看不出来**，只有渲染出来才会暴露：

| 问题                           | 症状                                   |
| ------------------------------ | -------------------------------------- |
| SVG 元素建在 HTML 命名空间     | 范数竖线、大括号消失，公式其余部分正常 |
| `viewBox` 被小写化成 `viewbox` | SVG 失去坐标系，路径完全不画           |
| 字体未加载                     | 上下标挤在一起、字形扁平               |

前两类都真实发生过，而且都被误判为"样式问题"排查了多轮。

## 用法

```sh
scripts/render-check/run.sh          # 生成对照图并截图
scripts/render-check/run.sh --open   # 生成后直接用浏览器打开
```

产物在 `scripts/render-check/out/`：`compare.html` 与 `compare.png`。

依赖：`firefox`（无头截图）、`node`、以及项目已构建（`.scaffold/kt.mjs` 由脚本自行生成）。
