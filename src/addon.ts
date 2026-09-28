import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import { PROVIDERS, getProvider, validateSettings } from "./modules/providers";
import { listModels } from "./modules/deepseek";
import { promptFields } from "./modules/prompts";
import { summarizeLog } from "./modules/requestLog";
import { pluginRootDir } from "./modules/storage";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialog?: DialogHelper;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  /**
   * Bridge for code that runs outside this bundle.
   *
   * The settings pane is loaded by Zotero as a plain script into the preference
   * window, so it cannot import these modules. It reaches them through
   * `Zotero.<AddonInstance>.api` instead — one implementation of the provider
   * catalogue and the validation rules, no duplicated copy to drift.
   */
  public api: {
    providers: ProviderPresetData[];
    getProvider: typeof getProvider;
    validateSettings: typeof validateSettings;
    /** Queries the configured endpoint's /models. */
    listModels: typeof listModels;
    /** Editable prompts plus their defaults, for the settings editor. */
    promptFields: typeof promptFields;
    /** Aggregated request-log statistics. */
    summarizeLog: typeof summarizeLog;
    /** Where this plugin writes its files. */
    dataDir: typeof pluginRootDir;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {
      providers: PROVIDERS,
      getProvider,
      validateSettings,
      listModels,
      promptFields,
      summarizeLog,
      dataDir: pluginRootDir,
    };
  }
}

export default Addon;
