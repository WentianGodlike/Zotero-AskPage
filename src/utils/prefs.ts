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
 * Call `onChange` whenever one of this plugin's preferences changes.
 *
 * Zotero exposes `Prefs.registerObserver`, and the settings pane writes through
 * `Prefs.set`, so a change in the pane reaches a running plugin immediately.
 * Without this, preferences read once at construction (the capture-preview
 * button, the popup width) kept their old value until Zotero restarted — which
 * looks like the setting not working rather than like a restart requirement.
 *
 * Returns a function that removes the observer. Zotero's own cleanup takes care
 * of this at shutdown; call it when a view is destroyed so a stale closure does
 * not keep reacting.
 */
export function observePrefs(onChange: (key: string) => void): () => void {
  try {
    const symbol = (Zotero.Prefs as any).registerObserver?.(
      PREFS_PREFIX,
      (value: unknown, _old: unknown, prefName?: string) => {
        try {
          // `prefName` is the full pref key; callers only care about the leaf,
          // which is the key they passed to `getPref`.
          const leaf = String(prefName || "").split(".").pop() || "";
          onChange(leaf);
        } catch (e) {
          Zotero.debug(
            `[Highlight Ask] pref observer failed: ${(e as Error)?.message || e}`,
          );
        }
      },
      true,
    );
    if (!symbol) {
      return () => {};
    }
    return () => {
      try {
        (Zotero.Prefs as any).unregisterObserver?.(symbol);
      } catch {
        /* already gone */
      }
    };
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] could not observe preferences: ${(e as Error)?.message || e}`,
    );
    return () => {};
  }
}
