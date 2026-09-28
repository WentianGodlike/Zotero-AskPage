/**
 * Minimal DeepSeek (OpenAI-compatible) streaming client.
 *
 * Uses `fetch` + ReadableStream, which is available inside Zotero's
 * privileged chrome scope. The previous generation of Zotero plugins used
 * `Zotero.HTTP.request`, which cannot stream; we need streaming so the
 * answer appears token by token in the reader panel.
 */

import { getPref } from "../utils/prefs";
import { getProvider } from "./providers";

export type ChatMessage =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string | ContentPart[] };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface StreamCallbacks {
  /** Called for each chunk of the visible answer. */
  onDelta?: (fullText: string, delta: string) => void;
  /**
   * Called for each chunk of the chain-of-thought. `deepseek-flash` runs in
   * thinking mode by default, and the reasoning stream arrives separately as
   * `reasoning_content`.
   */
  onReasoning?: (fullReasoning: string, delta: string) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no-key"
      | "http"
      | "network"
      | "aborted"
      | "empty" = "http",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }

  /**
   * Whether retrying the same request could plausibly succeed.
   *
   * A missing API key or a bad model name will fail identically every time, so
   * offering "retry" there just wastes the user's attention. Network failures,
   * 5xx and truncated streams are worth another attempt.
   */
  get retryable(): boolean {
    if (this.kind === "no-key" || this.kind === "aborted") {
      return false;
    }
    if (this.kind === "network" || this.kind === "empty") {
      return true;
    }
    if (this.kind === "http") {
      // 4xx (other than 429) means the request itself is wrong.
      return !this.status || this.status >= 500 || this.status === 429;
    }
    return false;
  }
}

/** Join baseUrl + path without producing a double slash. */
export function buildEndpoint(baseUrl: string, path: string): string {
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (!base) {
    throw new DeepSeekError("未配置 API 地址", "no-key");
  }
  return base + suffix;
}

interface ChatOptions extends StreamCallbacks {
  messages: ChatMessage[];
  /**
   * Cancellation signal. Optional because Zotero's plugin sandbox does not
   * expose `AbortController` (see `canAbort()`), and `fetch` accepts
   * `signal: undefined`.
   */
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * Whether this environment can abort an in-flight request.
 *
 * Zotero runs plugins in a sandbox whose globals come from an explicit
 * allowlist (`wantGlobalProperties` in chrome/content/zotero/xpcom/plugins.js).
 * `fetch` is allowed; `AbortController`/`AbortSignal` are not. Referencing the
 * constructor directly therefore throws `ReferenceError` and kills the whole
 * request, so callers must check first.
 */
export function canAbort(): boolean {
  try {
    return typeof AbortController !== "undefined";
  } catch {
    // Touching an undeclared global in some sandboxes throws rather than
    // returning "undefined".
    return false;
  }
}

/** Create an abort controller, or null when the sandbox has none. */
export function makeAbortController(): {
  controller: AbortController;
  signal: AbortSignal;
} | null {
  if (!canAbort()) {
    return null;
  }
  try {
    // The guard sits on the same line as the construction on purpose: it is the
    // contract that makes the direct global reference safe, and keeping them
    // together makes that obvious to a reader and to the sandbox-globals check.
    if (typeof AbortController === "undefined") { return null; }
    const controller = new AbortController();
    return { controller, signal: controller.signal };
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] abort support unusable: ${(e as Error)?.message || e}`,
    );
    return null;
  }
}

/** Everything needed to talk to the configured endpoint. */
export interface ResolvedConfig {
  provider: ProviderPresetData;
  apiKey: string;
  baseUrl: string;
  model: string;
  endpoint: string;
  temperature?: number;
  /** Extra provider-specific request fields, already parsed. */
  extra: Record<string, unknown>;
}

/**
 * Read the current provider settings.
 * Throws a user-facing error when the configuration is incomplete.
 */
export function resolveConfig(): ResolvedConfig {
  const provider = getProvider(getPref("provider") || "deepseek");

  const baseUrl = (getPref("baseUrl") || provider.baseUrl || "").trim();
  if (!baseUrl) {
    throw new DeepSeekError(
      "还没有配置 API 地址。\n\n打开 Zotero → 编辑 → 设置 → Highlight Ask 填写。",
      "no-key",
    );
  }

  const model = (getPref("model") || "").trim();
  if (!model) {
    throw new DeepSeekError(
      "还没有配置模型名。\n\n打开 Zotero → 编辑 → 设置 → Highlight Ask 填写。",
      "no-key",
    );
  }

  const apiKey = (getPref("apiKey") || "").trim();
  if (!apiKey && provider.requiresKey) {
    throw new DeepSeekError(
      `还没有配置 ${provider.label} 的 API Key。\n\n` +
        "打开 Zotero → 编辑 → 设置 → Highlight Ask 填入。" +
        (provider.keyUrl ? `\n申请地址：${provider.keyUrl}` : ""),
      "no-key",
    );
  }

  // temperature is unsupported (and ignored) by thinking models; only send it
  // when the user has actually set one.
  const rawTemp = (getPref("temperature") || "").trim();
  const temperature = rawTemp === "" ? undefined : Number(rawTemp);

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    endpoint: buildEndpoint(baseUrl, "/chat/completions"),
    temperature: Number.isFinite(temperature as number)
      ? (temperature as number)
      : undefined,
    extra: parseThinkingParams(getPref("thinkingParams")),
  };
}

/**
 * Parse the user's provider-specific request fields.
 * Malformed JSON must never break a question, so we degrade to "no extras".
 */
export function parseThinkingParams(raw: string): Record<string, unknown> {
  const text = (raw || "").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    Zotero.debug(
      "[Highlight Ask] thinkingParams is not valid JSON; ignoring it",
    );
    return {};
  }
}

/** Build the request body, optionally dropping the optional fields. */
function buildBody(
  config: ResolvedConfig,
  messages: ChatMessage[],
  maxTokens: number | undefined,
  includeExtras: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }
  if (maxTokens) {
    body.max_tokens = maxTokens;
  }
  if (includeExtras) {
    // User-supplied fields win, so a provider can override anything above.
    Object.assign(body, config.extra);
  }
  return body;
}

/** Does this error look like "you sent a parameter I don't understand"? */
function looksLikeUnsupportedParam(text: string): boolean {
  return /unsupported|not supported|unknown (parameter|field|argument)|unrecognized|invalid[_ ]?(parameter|field)|does not support/i.test(
    text,
  );
}

/**
 * Send a streaming chat completion request.
 * @returns the full assistant text once the stream ends.
 */
export async function streamChat(options: ChatOptions): Promise<StreamResult> {
  const { messages, signal, onDelta, onReasoning, maxTokens } = options;

  const config = resolveConfig();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // Local endpoints such as Ollama reject an empty bearer token.
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const send = async (includeExtras: boolean): Promise<Response> => {
    try {
      return await fetch(config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildBody(config, messages, maxTokens, includeExtras),
        ),
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new DeepSeekError("已取消", "aborted");
      }
      throw new DeepSeekError(
        `网络请求失败：${e?.message || e}\n\n请求地址：${config.endpoint}`,
        "network",
      );
    }
  };

  let res = await send(true);

  // Some providers reject unknown body fields outright. Rather than making the
  // user debug their JSON, retry once without the provider-specific extras.
  if (
    !res.ok &&
    (res.status === 400 || res.status === 422) &&
    Object.keys(config.extra).length > 0
  ) {
    const probe = await res
      .clone()
      .text()
      .catch(() => "");
    if (looksLikeUnsupportedParam(probe)) {
      Zotero.debug(
        "[Highlight Ask] provider rejected extra params; retrying without them",
      );
      res = await send(false);
    }
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    // Surface the most useful part of an OpenAI-style error body.
    let pretty = detail;
    try {
      const parsed = JSON.parse(detail);
      pretty = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* keep raw */
    }
    if (res.status === 401 || res.status === 403) {
      throw new DeepSeekError(
        `API Key 无效或没有权限（HTTP ${res.status}）。\n${pretty}`,
        "no-key",
        res.status,
      );
    }
    if (res.status === 404) {
      throw new DeepSeekError(
        `接口不存在（HTTP 404）。\n请求地址：${config.endpoint}\n` +
          "请检查设置里的 API 地址是否写对了。",
        "http",
        res.status,
      );
    }
    if (res.status === 400 && /model/i.test(pretty)) {
      throw new DeepSeekError(
        `模型名可能不对（HTTP 400）。当前用的是「${config.model}」。\n${pretty}`,
        "http",
        res.status,
      );
    }
    throw new DeepSeekError(
      `API 返回 HTTP ${res.status}\n${pretty}`,
      "http",
      res.status,
    );
  }

  if (!res.body) {
    throw new DeepSeekError("响应没有可读的流", "network");
  }

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let reasoning = "";
  let usage: StreamResult["usage"];

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      // A chunk boundary split the JSON; keep it in the buffer and retry.
      buffer = line + "\n";
      return;
    }
    const delta: string | undefined = json?.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta?.(full, delta);
    }
    const rdelta: string | undefined = json?.choices?.[0]?.delta?.reasoning_content;
    if (rdelta) {
      reasoning += rdelta;
      onReasoning?.(reasoning, rdelta);
    }
    if (json?.usage) {
      usage = json.usage;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // IMPORTANT: an SSE event can be split across chunk boundaries, so we
      // only consume complete lines and keep the trailing partial line.
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    }
    // Flush whatever is left (stream ended without a trailing newline).
    if (buffer.trim()) {
      handleLine(buffer);
      buffer = "";
    }
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new DeepSeekError("已取消", "aborted");
    }
    throw new DeepSeekError(`读取响应流失败：${e?.message || e}`, "network");
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }

  if (!full.trim()) {
    // "Stream ended with nothing" has several very different causes; without
    // this detail the user only sees "empty response" and cannot tell whether
    // the model, the endpoint or the parameters are at fault.
    const gotReasoningOnly = Boolean(reasoning.trim());
    throw new DeepSeekError(
      "模型返回了空内容。\n\n" +
        `模型：${config.model}\n` +
        `地址：${config.endpoint}\n` +
        (gotReasoningOnly
          ? "只收到了推理内容、没有正式回答。可能是「思考强度」或请求参数不被该模型支持，" +
            "可在设置里把「请求参数」留空后重试。"
          : "完全没有收到内容。请检查模型名是否正确、该模型是否可用，" +
            "以及服务商是否需要额外的请求参数。"),
      "empty",
    );
  }

  return { content: full, reasoning, usage };
}

export function isConfigured(): boolean {
  try {
    resolveConfig();
    return true;
  } catch {
    return false;
  }
}

export interface ModelInfo {
  id: string;
}

/**
 * Ask the configured endpoint which models it offers.
 * Used by the settings pane's "detect models" button.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const config = resolveConfig();
  const url = buildEndpoint(config.baseUrl, "/models");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (e: any) {
    throw new DeepSeekError(
      `无法连接：${e?.message || e}\n\n请求地址：${url}`,
      "network",
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    let pretty = detail;
    try {
      const parsed = JSON.parse(detail);
      pretty = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* keep raw */
    }
    throw new DeepSeekError(
      `获取模型列表失败（HTTP ${res.status}）\n${pretty}`,
      res.status === 401 || res.status === 403 ? "no-key" : "http",
      res.status,
    );
  }

  const json: any = await res.json();
  const rows = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.models)
      ? json.models
      : [];
  return rows
    .map((m: any) => ({ id: String(m?.id ?? m?.name ?? "") }))
    .filter((m: ModelInfo) => m.id);
}

