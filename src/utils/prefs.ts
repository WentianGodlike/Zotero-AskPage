import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

/**
 * Preference keys this plugin owns.
 *
 * Listed explicitly because Zotero's `Prefs.registerObserver` matches the
 * preference name **exactly** — registering a prefix such as
 * `extensions.zotero.highlightask` never fires, since the dispatch looks up
 * `_observers[fullPrefName]` and finds nothing. One observer per key is the
 * supported way.
 *
 * Kept in step with `addon/prefs.js`; `prefs.d.ts` is generated from it and the
 * two are checked by the preferences-pane tests.
 */
const OBSERVED_KEYS = [
  "provider",
  "apiKey",
  "baseUrl",
  "model",
  "thinkingParams",
  "temperature",
  "showReasoning",
  "sendNearby",
  "sendAnnotations",
  "sendSI",
  "sendScreenshot",
  "debugScreenshot",
  "screenshotDir",
  "sendFullText",
  "fullTextMaxChars",
  "saveToNote",
  "saveToJson",
  "logRequests",
  "retrievePassages",
  "alwaysRetrieve",
  "retrieveTopK",
] as const;

/**
 * Call `onChange(key)` whenever one of this plugin's preferences changes.
 *
 * The settings pane writes through `Prefs.set`, so a change reaches a running
 * plugin immediately. Without this, preferences read once at construction kept
 * their old value until Zotero restarted, which reads as "the setting does not
 * work" rather than as a restart requirement.
 *
 * Returns a function that removes every observer.
 */
export function observePrefs(onChange: (key: string) => void): () => void {
  const symbols: unknown[] = [];
  for (const key of OBSERVED_KEYS) {
    try {
      // The handler receives only the new value, so the key is captured here.
      const symbol = (Zotero.Prefs as any).registerObserver?.(
        `${PREFS_PREFIX}.${key}`,
        () => {
          try {
            onChange(key);
          } catch (e) {
            Zotero.debug(
              `[Highlight Ask] applying preference ${key} failed: ${
                (e as Error)?.message || e
              }`,
            );
          }
        },
        true,
      );
      if (symbol) {
        symbols.push(symbol);
      }
    } catch (e) {
      Zotero.debug(
        `[Highlight Ask] could not observe ${key}: ${(e as Error)?.message || e}`,
      );
    }
  }

  return () => {
    for (const symbol of symbols) {
      try {
        (Zotero.Prefs as any).unregisterObserver?.(symbol);
      } catch {
        /* already gone */
      }
    }
    symbols.length = 0;
  };
}
