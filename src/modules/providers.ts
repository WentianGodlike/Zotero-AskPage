import { HIGHLIGHT_ASK_PROVIDERS } from "../data/providers.data";

/**
 * Provider preset helpers.
 *
 * The preset data itself lives in `src/data/providers.data.ts` so that the
 * settings pane (which runs outside this bundle) can load the same values with
 * `Services.scriptloader` instead of keeping a second copy in sync by hand.
 */

export const PROVIDERS: ProviderPresetData[] = HIGHLIGHT_ASK_PROVIDERS;

export function getProvider(key: string): ProviderPresetData {
  return PROVIDERS.find((p) => p.key === key) || PROVIDERS[0];
}

/* ------------------------------------------------------------------ */
/* Settings validation                                                 */
/*                                                                     */
/* These live here, rather than inline in the settings pane, so they    */
/* can be unit tested. The pane calls the bundle through               */
/* Zotero.HighlightAsk.api (see src/addon.ts).                          */
/* ------------------------------------------------------------------ */

export interface SettingsDraft {
  providerKey: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Extra request fields, as raw JSON text from the textarea. */
  thinkingParamsText: string;
  /** Temperature as raw text; empty means "do not send". */
  temperatureText: string;
}

export interface SettingsValidation {
  ok: boolean;
  /** First blocking problem, shown to the user. */
  error?: string;
  /** Non-blocking notifications. */
  warnings: string[];
  /** Normalised values, present only when ok. */
  value?: {
    providerKey: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    thinkingParamsText: string;
    temperatureText: string;
  };
}

/**
 * Validate and normalise what the user typed in the settings pane.
 * Never throws — the pane renders `error` directly.
 */
export function validateSettings(draft: SettingsDraft): SettingsValidation {
  const warnings: string[] = [];
  const provider = getProvider(draft.providerKey);

  // Every field is coerced defensively. This function promises never to throw,
  // and it reads preferences that can be hand-edited to any type — a numeric
  // `baseUrl` used to crash on `.trim()` instead of being reported as invalid.
  const text = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

  const baseUrl = text(draft.baseUrl).replace(/\/+$/, "");
  const model = text(draft.model);
  const apiKey = text(draft.apiKey);
  const temperatureText = text(draft.temperatureText);
  const thinkingParamsText = text(draft.thinkingParamsText);

  if (!baseUrl) {
    return { ok: false, error: "API 地址不能为空", warnings };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      ok: false,
      error: "API 地址需要以 http:// 或 https:// 开头",
      warnings,
    };
  }
  if (/\/chat\/completions\/?$/i.test(baseUrl)) {
    return {
      ok: false,
      error:
        "API 地址不要带 /chat/completions，插件会自动补上。填到域名或 /v1 即可。",
      warnings,
    };
  }
  if (!model) {
    return { ok: false, error: "模型名不能为空", warnings };
  }

  if (thinkingParamsText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(thinkingParamsText);
    } catch {
      return {
        ok: false,
        error: '请求参数不是合法 JSON，例如 {"reasoning_effort":"high"}',
        warnings,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "请求参数必须是一个 JSON 对象（用 {} 包起来）",
        warnings,
      };
    }
  }

  if (temperatureText !== "") {
    const t = Number(temperatureText);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return { ok: false, error: "温度需要在 0~2 之间，或留空", warnings };
    }
  }

  if (provider.requiresKey && !apiKey) {
    return {
      ok: false,
      error: `「${provider.label}」需要 API Key`,
      warnings,
    };
  }

  // Non-blocking: keeping one provider's address while another is selected is a
  // legitimate proxy setup, but it is also the most common misconfiguration.
  if (provider.key !== "custom" && provider.baseUrl) {
    try {
      const typedHost = new URL(baseUrl).host;
      const presetHost = new URL(provider.baseUrl).host;
      if (typedHost && presetHost && typedHost !== presetHost) {
        warnings.push(
          `当前服务商是「${provider.label}」，但地址指向 ${typedHost}` +
            `（该服务商默认是 ${presetHost}）。如果用中转/代理，把服务商改成「自定义」更不容易搞混。`,
        );
      }
    } catch {
      /* unparsable URL is already rejected above */
    }
  }

  return {
    ok: true,
    warnings,
    value: {
      providerKey: provider.key,
      apiKey,
      baseUrl,
      model,
      thinkingParamsText,
      temperatureText,
    },
  };
}

/**
 * Payload exposed to the settings pane.
 *
 * The pane runs outside this bundle (Zotero loads it as a plain script into the
 * preference window), so it cannot import these helpers. `src/addon.ts` merges
 * this object into `Zotero.<AddonInstance>.api`, which is the documented bridge
 * the pane calls — keeping one implementation of the rules instead of a second
 * copy in the pane that would silently drift.
 *
 * Assignment (not replacement) so it composes with whatever else contributes to
 * the same namespace.
 */
(globalThis as unknown as Record<string, unknown>).HIGHLIGHT_ASK_API = Object.assign(
  ((globalThis as unknown as Record<string, any>).HIGHLIGHT_ASK_API ??= {}),
  {
    providers: PROVIDERS,
    getProvider,
    validateSettings,
  },
);
