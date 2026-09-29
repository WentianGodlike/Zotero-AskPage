# 设置页预览

把设置页单独渲染出来，用于肉眼检查布局。

## 为什么需要

设置页只在 Zotero 里运行，所以"提示词文本框糊在一起"这类问题在迭代时看不到。
它本身只是普通 DOM 加两个脚本，单独渲染即可复现真实样式。

## 用法

```sh
scripts/prefs-preview/run.sh
```

产物在 `out/preview.png`（整页）与 `out/preview.html`。

只截取提示词区域时，可在 `preview.html` 上注入：

```css
fieldset {
  display: none !important;
}
fieldset:has(#prompt-fields) {
  display: block !important;
}
```

## 已知限制

插件 bundle 在普通页面里**不会初始化** `Zotero.<AddonInstance>.api`，因此预览会
显示"读不到提示词定义"（这正是插件自身的降级行为）。

要看到提示词编辑器，需要把 `promptFields()` 的结果注入进去：

```sh
npx esbuild src/modules/prompts.ts --bundle --platform=node --format=esm \
  --outfile=.scaffold/pf.mjs
# 然后导出 window.__PROMPT_FIELDS，并在页面里替身 api()
```

依赖：`firefox`（无头截图）与 Python 3.8+。
