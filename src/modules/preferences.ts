import { config } from "../../package.json";

/** Register the plugin's pane in Zotero's Settings window. */
export function registerPrefsPane(): void {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    scripts: [
      // Defines the HIGHLIGHT_ASK_PROVIDERS global. Must load before the pane
      // script, which reads it.
      rootURI + "content/providers.data.js",
      rootURI + "content/preferences.js",
    ],
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  }).catch((e: unknown) => {
    Zotero.logError(e as any);
  });
}
