import { createChatView, ensureStyles, type ChatView } from "./chatView";

/**
 * Reader sidebar integration.
 *
 * Zotero 7+ renders plugin sections in the reader's right-hand sidebar via
 * `Zotero.ItemPaneManager.registerSection`. The section's `body` element is a
 * plain container, so the shared chat view renders straight into it — the same
 * view a floating panel would use, which keeps one implementation.
 *
 * The section body is rebuilt whenever Zotero re-renders it (switching items,
 * re-opening the reader), so the view is recreated per render and any previous
 * instance is destroyed first to avoid leaking a streaming request.
 */

const PANE_ID = "highlight-ask-pane";

/**
 * The live plugin instance, assigned in src/index.ts.
 *
 * Read lazily rather than at module scope: a top-level read would run (and
 * throw) as soon as anything imports this module, including the unit tests that
 * never touch Zotero.
 */
declare const addon: import("../addon").default;
function pluginConfig() {
  return addon.data.config;
}

/** The chat view for the currently shown reader tab. */
let activeView: ChatView | null = null;
/** Item id the active view belongs to. */
let activeItemID: number | null = null;
/** Section body element, used to open the sidebar from the selection popup. */
let activeBody: HTMLElement | null = null;

export interface SidebarAskRequest {
  itemID: number;
  selection: string;
  question: string;
}

/** Pending request, used when the sidebar is not open yet. */
let pending: SidebarAskRequest | null = null;

export function registerReaderSidebar(): void {
  try {
    Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: pluginConfig().addonID,
      header: {
        l10nID: "highlight-ask-pane-header",
        icon: `chrome://${pluginConfig().addonRef}/content/icons/favicon.png`,
      },
      sidenav: {
        l10nID: "highlight-ask-pane-sidenav",
        icon: `chrome://${pluginConfig().addonRef}/content/icons/favicon.png`,
      },

      onItemChange: ({ setEnabled, tabType }) => {
        // Only meaningful while a PDF/EPUB reader tab is showing.
        setEnabled(tabType === "reader");
        return true;
      },

      onRender: ({ body, doc, item }) => {
        activeBody = body as unknown as HTMLElement;
        if (!item) {
          return;
        }
        ensureStyles(doc as unknown as Document);
        // A fresh render means the previous view's container is gone.
        activeView?.destroy();
        activeView = createChatView({
          container: body as unknown as HTMLElement,
          doc: doc as unknown as Document,
          itemID: item.id,
          hooks: {
            onStatus: (message, kind) => {
              if (kind === "error") {
                Zotero.logError(new Error(`[Highlight Ask] ${message}`));
              }
            },
          },
        });
        activeItemID = item.id;

        if (pending && pending.itemID === item.id) {
          const request = pending;
          pending = null;
          activeView.ask(request.selection, request.question);
        }
      },

      onDestroy: () => {
        activeView?.destroy();
        activeView = null;
        activeItemID = null;
        activeBody = null;
      },
    });
  } catch (e) {
    Zotero.logError(
      new Error(`[Highlight Ask] could not register sidebar: ${(e as Error)?.message || e}`),
    );
  }
}

export function unregisterReaderSidebar(): void {
  try {
    activeView?.destroy();
    activeView = null;
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Route a selection-popup question into the sidebar.
 *
 * Returns false when the sidebar is not currently mounted; the caller can then
 * decide whether to fall back to a floating panel or tell the user to open it.
 */
export function askInSidebar(request: SidebarAskRequest): boolean {
  if (activeView && activeItemID === request.itemID) {
    activeView.ask(request.selection, request.question);
    return true;
  }
  pending = request;
  return false;
}

/** True when a chat view is mounted and ready for a question. */
export function sidebarReady(): boolean {
  return Boolean(activeView);
}

