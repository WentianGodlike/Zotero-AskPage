/**
 * Shared provider/model preset data — the single source of truth.
 *
 * Why plain data instead of a module of helpers: the settings pane script
 * (`addon/content/preferences.js`) runs outside the bundled plugin and cannot
 * import from `src/`. It loads this exact file via `Services.scriptloader`
 * (loading a plain script into the pane's scope binds `HIGHLIGHT_ASK_PROVIDERS`
 * as a global), while the plugin bundle imports it normally. One definition,
 * two consumers, no drift.
 *
 * Accuracy: only the DeepSeek entry is verified against official docs
 * (api-docs.deepseek.com, 2026-09-28). Everything else is a prefill — vendors
 * rename models often, so the UI always allows overriding the base URL and
 * model, and offers a "detect models" button that queries `/models`.
 *
 * `vision: true` means the model accepts image input.
 */
export const HIGHLIGHT_ASK_PROVIDERS: ProviderPresetData[] = [
  {
    key: "deepseek",
    label: "DeepSeek（官方）",
    baseUrl: "https://api.deepseek.com",
    requiresKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    thinking: { reasoning_effort: "high" },
    models: [
      {
        id: "deepseek-flash",
        vision: true,
        note: "V4.1 Flash：便宜，且是唯一支持视觉的（能看图/看公式截图）",
      },
      {
        id: "deepseek-v4-pro",
        vision: false,
        note: "V4 Pro：推理更强，贵约 4 倍，不支持视觉",
      },
    ],
  },
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5", vision: true },
      { id: "gpt-5-mini", vision: true },
      { id: "gpt-4o", vision: true },
    ],
  },
  {
    key: "openrouter",
    label: "OpenRouter（聚合多家）",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    keyUrl: "https://openrouter.ai/keys",
    models: [
      { id: "anthropic/claude-sonnet-4.5", vision: true },
      { id: "google/gemini-2.5-pro", vision: true },
      { id: "deepseek/deepseek-chat", vision: false },
    ],
  },
  {
    key: "dashscope",
    label: "阿里云百炼 / 通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    requiresKey: true,
    keyUrl: "https://bailian.console.aliyun.com/",
    models: [
      { id: "qwen-max", vision: false },
      { id: "qwen-vl-max", vision: true, note: "视觉模型" },
      { id: "qwen-plus", vision: false },
    ],
  },
  {
    key: "moonshot",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    requiresKey: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    models: [{ id: "kimi-k2-0905-preview", vision: false }],
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    requiresKey: true,
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: [
      { id: "glm-4.6", vision: false },
      { id: "glm-4v-plus", vision: true, note: "视觉模型" },
    ],
  },
  {
    key: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    requiresKey: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    models: [
      { id: "deepseek-ai/DeepSeek-V3.2", vision: false },
      { id: "Qwen/Qwen3-VL-235B-A22B-Instruct", vision: true },
    ],
  },
  {
    key: "gemini",
    label: "Google Gemini（OpenAI 兼容层）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    models: [{ id: "gemini-2.5-pro", vision: true }],
  },
  {
    key: "ollama",
    label: "Ollama（本地，无需 Key）",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    local: true,
    models: [
      { id: "qwen3-vl:8b", vision: true },
      { id: "qwen3:8b", vision: false },
    ],
  },
  {
    key: "custom",
    label: "自定义（任意 OpenAI 兼容接口）",
    baseUrl: "",
    requiresKey: true,
    models: [],
  },
];

/**
 * Expose the catalogue as a global.
 *
 * This file is bundled twice: once into the plugin (which imports it), and once
 * as a standalone IIFE that the settings pane loads with `loadSubScript`. In the
 * IIFE build the `const` above lives inside the wrapper function and is NOT a
 * global, so the pane could not see it. Assigning explicitly fixes that, and in
 * the bundled plugin the assignment is a harmless no-op on a global object.
 */
(globalThis as unknown as Record<string, unknown>).HIGHLIGHT_ASK_PROVIDERS =
  HIGHLIGHT_ASK_PROVIDERS;
