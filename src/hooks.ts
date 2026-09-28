import { createZToolkit } from "./utils/ztoolkit";
import { registerPrefsPane } from "./modules/preferences";
import {
  registerReaderPopup,
  unregisterReaderPopup,
} from "./modules/readerPopup";
import { closePanel } from "./modules/askPanel";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  registerPrefsPane();

  // The reader integration is the whole point of this plugin: add
  // "解释这段 / 翻译 / 有何作用" buttons to the PDF text-selection popup.
  registerReaderPopup();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // ztoolkit is per-window; the reader panel does not use it, but keeping it
  // initialized matches the template's expectations.
  addon.data.ztoolkit = createZToolkit();
  void win;
}

async function onMainWindowUnload(win: Window): Promise<void> {
  void win;
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  closePanel();
  unregisterReaderPopup();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
