/*
 * Highlight Ask — preference pane script.
 *
 * Runs inside the preference pane's own sandbox (see `_loadPane` in Zotero's
 * chrome/content/zotero/preferences/preferences.js). Two consequences shape
 * everything below:
 *
 *  1. It runs BEFORE the pane's XHTML is inserted into the document. Zotero
 *     loads `scripts`, then does `pane.container.append(markup)`. So
 *     `getElementById` returns null at top level — see `whenReady()`.
 *  2. It cannot import from the plugin bundle. The provider catalogue and the
 *     validation rules are reached through `Zotero.<AddonInstance>.api`.
 *
 */
(function () {
  "use strict";

  var PREFS = "extensions.zotero.highlightask.";

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, kind) {
    var el = $("status");
    if (!el) {
      return;
    }
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function readPref(key, fallback) {
    try {
      var value = Zotero.Prefs.get(PREFS + key, true);
      return value === undefined || value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  function writePref(key, value) {
    Zotero.Prefs.set(PREFS + key, value, true);
  }

  /**
   * The plugin bundle publishes the provider catalogue and the validation rules
   * at `Zotero.<AddonInstance>.api`. Going through it means the pane and the
   * plugin can never disagree about what a valid configuration is.
   */
  function api() {
    try {
      var instance = Zotero && Zotero.HighlightAsk;
      return (instance && instance.api) || null;
    } catch (e) {
      return null;
    }
  }

  /** Minimal stand-in used only if the bundle has not published its API. */
  var FALLBACK_PROVIDERS = [
    {
      key: "custom",
      label: "自定义（任意 OpenAI 兼容接口）",
      baseUrl: "",
      requiresKey: true,
      models: [],
    },
  ];

  function catalogue() {
    var a = api();
    if (a && Array.isArray(a.providers) && a.providers.length) {
      return a.providers;
    }
    if (
      typeof HIGHLIGHT_ASK_PROVIDERS !== "undefined" &&
      HIGHLIGHT_ASK_PROVIDERS.length
    ) {
      return HIGHLIGHT_ASK_PROVIDERS;
    }
    return FALLBACK_PROVIDERS;
  }

  function providerByKey(key) {
    var a = api();
    if (a && typeof a.getProvider === "function") {
      return a.getProvider(key);
    }
    var list = catalogue();
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) {
        return list[i];
      }
    }
    return list[0];
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function renderProviderOptions() {
    var select = $("provider");
    select.replaceChildren();
    catalogue().forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
  }

  function renderModels(provider, selectedModel) {
    var list = $("model-list");
    list.replaceChildren();
    (provider.models || []).forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m.id;
      opt.label = m.note ? m.id + " — " + m.note : m.id;
      list.appendChild(opt);
    });

    var desc = $("model-desc");
    var found = (provider.models || []).filter(function (m) {
      return m.id === selectedModel;
    })[0];

    if (found && found.note) {
      desc.textContent = found.note;
      desc.className = found.vision ? "desc ok" : "desc";
    } else if (!provider.models || !provider.models.length) {
      desc.textContent = "该服务商没有内置候选，请手动填写模型名，或点「获取模型列表」。";
      desc.className = "desc";
    } else {
      desc.textContent = "可从下拉里选，也可以手动填写。标了「视觉」的模型才能看图。";
      desc.className = "desc";
    }
  }

  /** Reflect the selected provider in the key field's help text. */
  function syncKeyField(provider) {
    var desc = $("key-desc");

    if (provider.local) {
      desc.textContent =
        "本地服务不需要 API Key（留空即可）。请确认服务已在运行：" +
        provider.baseUrl;
      desc.className = "desc";
      return;
    }
    if (provider.requiresKey && provider.keyUrl) {
      desc.replaceChildren();
      desc.appendChild(document.createTextNode("申请地址："));
      var a = document.createElement("a");
      a.href = "#";
      a.textContent = provider.keyUrl;
      a.addEventListener("click", function (e) {
        e.preventDefault();
        try {
          Zotero.launchURL(provider.keyUrl);
        } catch (err) {
          /* ignore */
        }
      });
      desc.appendChild(a);
      desc.className = "desc";
      return;
    }
    desc.textContent = "该地址不需要 API Key。";
    desc.className = "desc";
  }

  /**
   * Warn when the selected provider and the address disagree. Not an error —
   * proxies and mirrors are legitimate — but it is the most common mix-up.
   */
  function checkProviderMismatch() {
    var desc = $("provider-desc");
    var provider = providerByKey($("provider").value);
    var typed = $("baseUrl").value.trim();

    if (provider.key === "custom" || !typed || !provider.baseUrl) {
      desc.textContent =
        provider.key === "custom"
          ? "填任意 OpenAI 兼容接口地址，例如 https://your-host/v1。"
          : "选择后会填入该服务商的默认地址与模型，下面每一项都可以手动改。";
      desc.className = "desc";
      return;
    }

    var typedHost = "";
    var presetHost = "";
    try {
      typedHost = new URL(typed).host;
      presetHost = new URL(provider.baseUrl).host;
    } catch (e) {
      return;
    }

    if (typedHost && presetHost && typedHost !== presetHost) {
      desc.textContent =
        "注意：当前服务商是「" + provider.label + "」，但地址指向 " +
        typedHost + "（该服务商默认是 " + presetHost + "）。" +
        "如果用中转/代理，把服务商改成「自定义」更不容易搞混。";
      desc.className = "desc warn";
    } else {
      desc.textContent = "选择后会填入该服务商的默认地址与模型，下面每一项都可以手动改。";
      desc.className = "desc";
    }
  }

  /** Apply a provider preset to the editable fields. */
  function applyProvider(provider, opts) {
    var force = opts && opts.force;
    var baseUrlEl = $("baseUrl");
    var modelEl = $("model");

    if (force || !baseUrlEl.value.trim()) {
      baseUrlEl.value = provider.baseUrl || "";
    }
    if (force || !modelEl.value.trim()) {
      var first = (provider.models || [])[0];
      modelEl.value = first ? first.id : "";
    }
    if (force && provider.thinking) {
      $("thinkingParams").value = JSON.stringify(provider.thinking);
    }
    renderModels(provider, modelEl.value);
    syncKeyField(provider);
    checkProviderMismatch();
  }

  /* ---------------------------------------------------------------- */
  /* Prompt editor                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * The prompt catalogue lives in the plugin bundle, so the editor is built from
   * data rather than hardcoded fields — the defaults in the code and the labels
   * here can never disagree.
   */
  function promptFieldDefs() {
    var a = api();
    if (a && typeof a.promptFields === "function") {
      return a.promptFields();
    }
    return [];
  }

  function renderPromptFields() {
    var host = $("prompt-fields");
    if (!host) {
      return;
    }
    var defs = promptFieldDefs();
    host.replaceChildren();

    if (!defs.length) {
      var note = document.createElement("div");
      note.className = "desc warn";
      note.textContent =
        "读不到提示词定义（插件可能还没加载完成）。重启 Zotero 后再打开本页即可编辑。";
      host.appendChild(note);
      return;
    }

    defs.forEach(function (f) {
      var wrap = document.createElement("div");
      wrap.className = "field";

      var label = document.createElement("label");
      label.setAttribute("for", "prompt-" + f.prefKey);
      label.textContent = f.label;

      var help = document.createElement("div");
      help.className = "desc";
      help.textContent = f.help || "";

      var area = document.createElement("textarea");
      area.id = "prompt-" + f.prefKey;
      area.rows = f.rows || 4;
      area.spellcheck = false;
      // Empty means "use the built-in default", so show the default as the
      // placeholder rather than as a value — that keeps the two states distinct.
      area.placeholder = f.default || "";
      var saved = readPref(f.prefKey, "");
      area.value = typeof saved === "string" ? saved : "";

      var row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.alignItems = "center";
      row.style.marginBottom = "4px";

      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "tiny";
      reset.textContent = "恢复默认";
      reset.addEventListener("click", function () {
        area.value = "";
        area.placeholder = f.default || "";
        setStatus("已恢复「" + f.label + "」的默认值，点保存生效。");
      });

      row.appendChild(label);
      row.appendChild(reset);

      wrap.appendChild(row);
      wrap.appendChild(area);
      wrap.appendChild(help);
      host.appendChild(wrap);
    });
  }

  function resetAllPrompts() {
    promptFieldDefs().forEach(function (f) {
      var el = $("prompt-" + f.prefKey);
      if (el) {
        el.value = "";
      }
    });
    setStatus("所有提示词已恢复默认，点保存生效。");
  }

  /* ---------------------------------------------------------------- */
  /* Data location + log stats                                         */
  /* ---------------------------------------------------------------- */

  function paintDataDir() {
    var el = $("data-dir-desc");
    if (!el) {
      return;
    }
    var a = api();
    var dir = a && typeof a.dataDir === "function" ? a.dataDir() : "";
    el.textContent = dir
      ? "结构化的副本，便于以后做历史面板或导出。位置：" + dir
      : "结构化的副本，便于以后做历史面板或导出。";
  }

  async function paintLogStats() {
    var el = $("log-stats");
    if (!el) {
      return;
    }
    var a = api();
    if (!a || typeof a.summarizeLog !== "function") {
      el.textContent = "（插件未就绪，无法读取统计）";
      return;
    }
    try {
      var s = await a.summarizeLog();
      if (!s.requests) {
        el.textContent = "（尚无记录）";
        return;
      }
      var bits = [
        s.requests + " 次调用",
        s.totalTokens.toLocaleString() + " tokens",
        "平均 " + s.avgTotalMs + "ms",
      ];
      if (s.avgFirstTokenMs !== null) {
        bits.push("首字 " + s.avgFirstTokenMs + "ms");
      }
      if (s.errors) {
        bits.push(s.errors + " 次失败");
      }
      var models = Object.keys(s.byModel)
        .map(function (k) {
          return k + " ×" + s.byModel[k].requests;
        })
        .join("，");
      el.textContent = bits.join(" · ") + (models ? "（" + models + "）" : "");
    } catch (e) {
      el.textContent = "统计读取失败：" + ((e && e.message) || e);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Load / save                                                       */
  /* ---------------------------------------------------------------- */

  function load() {
    var list = catalogue();
    var key = String(readPref("provider", "deepseek"));
    // A saved provider that no longer exists must not leave the dropdown blank.
    var known = list.some(function (p) {
      return p.key === key;
    });
    if (!known) {
      key = list[0].key;
    }
    $("provider").value = key;
    $("apiKey").value = String(readPref("apiKey", ""));
    $("baseUrl").value = String(readPref("baseUrl", ""));
    $("model").value = String(readPref("model", ""));
    $("thinkingParams").value = String(readPref("thinkingParams", ""));
    $("temperature").value = String(readPref("temperature", ""));
    $("showReasoning").checked = Boolean(readPref("showReasoning", true));
    $("sendNearby").checked = Boolean(readPref("sendNearby", true));
    $("sendAnnotations").checked = Boolean(readPref("sendAnnotations", true));
    $("sendSI").checked = Boolean(readPref("sendSI", true));
    $("sendScreenshot").checked = Boolean(readPref("sendScreenshot", true));
    $("popupWidth").value = String(readPref("popupWidth", 320));
    $("screenshotDir").value = String(readPref("screenshotDir", ""));
    $("sendFullText").checked = Boolean(readPref("sendFullText", false));
    $("fullTextMaxChars").value = String(readPref("fullTextMaxChars", 120000));
    $("saveToNote").checked = Boolean(readPref("saveToNote", true));
    $("saveToJson").checked = Boolean(readPref("saveToJson", true));
    $("logRequests").checked = Boolean(readPref("logRequests", true));
    $("debugScreenshot").checked = Boolean(readPref("debugScreenshot", true));
    $("retrievePassages").checked = Boolean(readPref("retrievePassages", true));
    $("retrieveTopK").value = String(readPref("retrieveTopK", 5));
    $("alwaysRetrieve").checked = Boolean(readPref("alwaysRetrieve", true));
    renderPromptFields();
    paintDataDir();

    var provider = providerByKey(key);
    // Fields that were never saved fall back to the preset.
    if (!$("baseUrl").value.trim()) {
      $("baseUrl").value = provider.baseUrl || "";
    }
    if (!$("model").value.trim()) {
      var first = (provider.models || [])[0];
      $("model").value = first ? first.id : "";
    }
    renderModels(provider, $("model").value);
    syncKeyField(provider);
    checkProviderMismatch();
    setStatus("");
  }

  /**
   * Only used if the plugin bundle has not published its API. Deliberately
   * minimal — the authoritative rules live in the bundle.
   */
  function validateSettingsFallback(draft) {
    var baseUrl = String(draft.baseUrl || "").trim().replace(/\/+$/, "");
    var model = String(draft.model || "").trim();
    if (!baseUrl) {
      return { ok: false, error: "API 地址不能为空", warnings: [] };
    }
    if (!model) {
      return { ok: false, error: "模型名不能为空", warnings: [] };
    }
    return {
      ok: true,
      warnings: [],
      value: {
        providerKey: draft.providerKey,
        apiKey: String(draft.apiKey || "").trim(),
        baseUrl: baseUrl,
        model: model,
        thinkingParamsText: String(draft.thinkingParamsText || "").trim(),
        temperatureText: String(draft.temperatureText || "").trim(),
      },
    };
  }

  function save(silent) {
    var draft = {
      providerKey: $("provider").value,
      apiKey: $("apiKey").value,
      baseUrl: $("baseUrl").value,
      model: $("model").value,
      thinkingParamsText: $("thinkingParams").value,
      temperatureText: $("temperature").value,
    };

    // Validation lives in the plugin bundle so the pane and the plugin can never
    // disagree about what counts as a valid configuration.
    var a = api();
    var result =
      a && typeof a.validateSettings === "function"
        ? a.validateSettings(draft)
        : validateSettingsFallback(draft);

    if (!result.ok) {
      setStatus(result.error || "配置有误", "error");
      return false;
    }

    var v = result.value;
    writePref("provider", v.providerKey);
    writePref("apiKey", v.apiKey);
    writePref("baseUrl", v.baseUrl);
    writePref("model", v.model);
    writePref("thinkingParams", v.thinkingParamsText);
    writePref("temperature", v.temperatureText);
    writePref("showReasoning", $("showReasoning").checked);
    writePref("sendNearby", $("sendNearby").checked);
    writePref("sendAnnotations", $("sendAnnotations").checked);
    writePref("sendSI", $("sendSI").checked);
    writePref("sendScreenshot", $("sendScreenshot").checked);
    writePref("popupWidth", clampNumber($("popupWidth").value, 220, 800, 320));
    writePref("screenshotDir", String($("screenshotDir").value || "").trim());
    writePref("sendFullText", $("sendFullText").checked);
    writePref("saveToNote", $("saveToNote").checked);
    writePref("saveToJson", $("saveToJson").checked);
    writePref("logRequests", $("logRequests").checked);
    writePref("debugScreenshot", $("debugScreenshot").checked);
    writePref("retrievePassages", $("retrievePassages").checked);
    writePref("retrieveTopK", Number($("retrieveTopK").value) || 5);
    writePref("alwaysRetrieve", $("alwaysRetrieve").checked);

    var maxChars = Number($("fullTextMaxChars").value.trim());
    if (!isFinite(maxChars) || maxChars < 1000) {
      setStatus("全文长度上限需要是不小于 1000 的数字", "error");
      return false;
    }
    writePref("fullTextMaxChars", maxChars);

    // Prompts: store the raw text (empty string means "use the default").
    promptFieldDefs().forEach(function (f) {
      var el = $("prompt-" + f.prefKey);
      if (el) {
        writePref(f.prefKey, el.value);
      }
    });

    if (!silent) {
      if (result.warnings && result.warnings.length) {
        setStatus("✓ 已保存。" + result.warnings.join(" "), "busy");
      } else {
        setStatus("✓ 已保存");
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  function authHeaders() {
    var headers = { Accept: "application/json" };
    var key = $("apiKey").value.trim();
    if (key) {
      headers.Authorization = "Bearer " + key;
    }
    return headers;
  }

  /** GET /models to list what the endpoint actually offers. */
  async function fetchModels() {
    if (!save(true)) {
      return;
    }
    var btn = $("btn-models");
    btn.disabled = true;
    setStatus("正在获取模型列表…", "busy");
    try {
      var a = api();
      var ids = [];

      if (a && typeof a.listModels === "function") {
        // Prefer the plugin's implementation: it reads the saved prefs and
        // builds the request exactly like the chat call does.
        var models = await a.listModels();
        ids = (models || [])
          .map(function (m) {
            return m && m.id;
          })
          .filter(Boolean);
      } else {
        ids = await fetchModelsFallback();
      }

      if (!ids.length) {
        setStatus("接口返回了空列表，请手动填写模型名。", "busy");
        return;
      }

      var list = $("model-list");
      list.replaceChildren();
      ids.forEach(function (id) {
        var opt = document.createElement("option");
        opt.value = id;
        list.appendChild(opt);
      });
      $("model-desc").textContent =
        "已获取 " + ids.length + " 个模型，可从下拉里选。";
      $("model-desc").className = "desc ok";
      setStatus("✓ 获取到 " + ids.length + " 个模型");
    } catch (e) {
      setStatus("获取失败：" + ((e && e.message) || e), "error");
    } finally {
      btn.disabled = false;
    }
  }

  async function fetchModelsFallback() {
    var base = $("baseUrl").value.trim().replace(/\/+$/, "");
    var res = await fetch(base + "/models", {
      method: "GET",
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    var json = await res.json();
    var rows = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json.models)
        ? json.models
        : [];
    return rows
      .map(function (m) {
        return m && (m.id || m.name);
      })
      .filter(Boolean);
  }

  /** Send one real request so address + key + model are all proven at once. */
  async function testConnection() {
    if (!save(true)) {
      return;
    }
    var btn = $("btn-test");
    btn.disabled = true;
    setStatus("正在测试…", "busy");
    try {
      var base = $("baseUrl").value.trim().replace(/\/+$/, "");
      var payload = {
        model: $("model").value.trim(),
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      };
      var res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          authHeaders(),
        ),
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setStatus("✓ 连接成功，模型「" + payload.model + "」可用。");
        return;
      }

      var detail = "";
      try {
        detail = await res.text();
      } catch (e) {
        /* ignore */
      }
      var pretty = detail;
      try {
        var parsed = JSON.parse(detail);
        pretty = (parsed.error && parsed.error.message) || parsed.message || detail;
      } catch (e) {
        /* keep raw */
      }
      setStatus(
        "✗ HTTP " + res.status + " — " + String(pretty).slice(0, 300),
        "error",
      );
    } catch (e) {
      setStatus("✗ " + ((e && e.message) || "连接失败"), "error");
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  function init() {
    renderProviderOptions();
    load();

    $("provider").addEventListener("change", function () {
      applyProvider(providerByKey($("provider").value), { force: true });
      setStatus("已切换服务商，别忘点保存。");
    });

    $("model").addEventListener("input", function () {
      renderModels(providerByKey($("provider").value), $("model").value);
    });

    $("baseUrl").addEventListener("input", checkProviderMismatch);

    $("btn-save").addEventListener("click", function () {
      save(false);
    });
    $("btn-test").addEventListener("click", function () {
      testConnection();
    });
    $("btn-models").addEventListener("click", function () {
      fetchModels();
    });
    $("btn-reset-prompts").addEventListener("click", resetAllPrompts);
  }

  function start() {
    try {
      init();
      void paintLogStats();
    } catch (e) {
      // Never fail silently: a blank pane with no log is impossible to debug.
      Zotero.logError(
        new Error(
          "[Highlight Ask] preference pane failed to initialise: " +
            ((e && e.stack) || e),
        ),
      );
      try {
        setStatus("设置面板初始化失败：" + ((e && e.message) || e), "error");
      } catch (ignored) {
        /* nothing more we can do */
      }
    }
  }

  /**
   * Wait until this pane's markup is actually in the document, then run `run`.
   *
   * Zotero runs a pane's scripts BEFORE inserting its markup (`_loadPane`:
   * `loadSubScript(script, pane.scope)` happens first, `pane.container.append`
   * afterwards), so `getElementById` returns null at top level. A naive
   * `init()` call here throws and leaves the pane permanently blank — which is
   * exactly the bug this function exists to prevent.
   *
   * A MutationObserver covers the normal path; the interval is a fallback in
   * case the nodes arrive by a route that emits no childList mutation on the
   * observed root.
   *
   * `find`/`run` are injectable so this can be unit tested (see
   * test/local.test.ts) without a real Zotero preference window.
   */
  /** Clamp a numeric preference to a sane range. */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function whenReady(find, run) {
    find = find || function () {
      return $("provider");
    };
    run = run || start;

    if (find()) {
      run();
      return;
    }

    var done = false;
    var finish = function () {
      if (done) {
        return;
      }
      done = true;
      observer.disconnect();
      clearInterval(timer);
      run();
    };

    var observer = new MutationObserver(function () {
      if (find()) {
        finish();
      }
    });
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {
      Zotero.debug("[Highlight Ask] MutationObserver unavailable: " + e);
    }

    var tries = 0;
    var timer = setInterval(function () {
      if (find()) {
        finish();
        return;
      }
      if (++tries > 100) {
        done = true;
        observer.disconnect();
        clearInterval(timer);
        Zotero.logError(
          new Error(
            "[Highlight Ask] preference pane markup never appeared in the document",
          ),
        );
      }
    }, 50);
  }

  whenReady();
})();
