import { createChatView, ensureStyles, type ChatView } from "./chatView";

/**
 * Reader sidebar integration.
 *
 * Zotero renders plugin sections via `Zotero.ItemPaneManager.registerSection`.
 * The section's `body` element is a plain container, so the shared chat view
 * renders straight into it.
 *
 * Two things are easy to get wrong here, and both caused real bugs:
 *
 *  1. **Several instances can exist at once.** The item pane is re-created per
 *     displayed item and there may be more than one pane host. A single
 *     module-level "the current view" is therefore wrong; views are kept in a
 *     registry keyed by item id.
 *
 *  2. **The pane's item is not necessarily the reader's item.** A reader's
 *     `itemID` is the PDF *attachment*, while the item pane commonly shows the
 *     *parent* item (that is what the info pane lists attachments and tags
 *     for). An exact id comparison therefore fails for ordinary papers, so
 *     matching walks up to the parent and down to attachments.
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

/**
 * Resolve a Fluent message id for this addon.
 *
 * `l10nID` must be the FULL message id including the addon's namespace prefix —
 * the scaffold rewrites `addon.ftl` keys to `<addonRef>-<key>`. Passing a bare
 * key does not throw; Zotero simply falls back to displaying the raw id as the
 * label, which is why this is easy to get wrong quietly.
 */
function sectionL10nID(key: string): string {
  return `${pluginConfig().addonRef}-${key}`;
}

interface MountedView {
  itemID: number;
  view: ChatView;
  /** The element the view rendered into, used to detect a stale mount. */
  container: HTMLElement;
}

/** Every mounted chat view, keyed by the item id Zotero rendered it for. */
const views = new Map<number, MountedView>();

/** A question waiting for its section to mount. */
let pending: { itemID: number; selection: string; question: string } | null = null;

export function registerReaderSidebar(): void {
  try {
    Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: pluginConfig().addonID,
      header: {
        l10nID: sectionL10nID("pane-header"),
        icon: `chrome://${pluginConfig().addonRef}/content/icons/favicon.png`,
      },
      sidenav: {
        l10nID: sectionL10nID("pane-sidenav"),
        icon: `chrome://${pluginConfig().addonRef}/content/icons/favicon.png`,
      },

      onItemChange: ({ setEnabled, tabType }) => {
        // Only meaningful while a PDF/EPUB reader tab is showing.
        setEnabled(tabType === "reader");
        return true;
      },

      onRender: ({ body, doc, item }) => {
        if (!item) {
          return;
        }
        const container = body as unknown as HTMLElement;
        const ownerDoc = doc as unknown as Document;
        ensureStyles(ownerDoc);

        // Zotero re-renders the section for the same item, so drop any previous
        // view before mounting a new one — otherwise a streaming request leaks,
        // still writing into a container that is no longer in the document.
        const previous = views.get(item.id);
        if (previous) {
          previous.view.destroy();
          views.delete(item.id);
        }

        const view = createChatView({
          container,
          doc: ownerDoc,
          itemID: item.id,
          hooks: {
            onStatus: (message, kind) => {
              if (kind === "error") {
                Zotero.logError(new Error(`[Highlight Ask] ${message}`));
              }
            },
          },
        });
        views.set(item.id, { itemID: item.id, view, container });

        if (pending && matchesItem(pending.itemID, item.id)) {
          const request = pending;
          pending = null;
          view.ask(request.selection, request.question);
        }
      },

      onDestroy: () => {
        // `onDestroy` receives only the basic props (paneID/doc/body) — there is
        // no `item` here, so a specific view cannot be looked up by id. Instead
        // reap every view whose container has left the document.
        reapDetachedViews();
      },
    });
  } catch (e) {
    Zotero.logError(
      new Error(
        `[Highlight Ask] could not register sidebar: ${(e as Error)?.message || e}`,
      ),
    );
  }
}

export function unregisterReaderSidebar(): void {
  try {
    for (const mounted of views.values()) {
      mounted.view.destroy();
    }
    views.clear();
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Are these two ids the same item, or the same paper seen from two sides?
 *
 * The reader reports the PDF attachment; the item pane usually shows the parent
 * item. Walking the relationship in both directions makes the match work for
 * both shapes (attachment-first and parent-first).
 */
export function matchesItem(a: number, b: number): boolean {
  if (a === b) {
    return true;
  }
  try {
    const item = Zotero.Items.get(a);
    if (!item) {
      return false;
    }
    // Up: this attachment's parent.
    if (item.parentItemID && item.parentItemID === b) {
      return true;
    }
    // Down: b is one of this item's attachments.
    const attachments: number[] = item.getAttachments?.() || [];
    if (attachments.includes(b)) {
      return true;
    }
  } catch (e) {
    Zotero.debug(
      `[Highlight Ask] item comparison failed: ${(e as Error)?.message || e}`,
    );
  }
  return false;
}

/**
 * Destroy views whose container is no longer in the document.
 *
 * `isConnected` is the reliable signal: Zotero removes the section element when
 * the pane is torn down, and the container goes with it. This avoids depending
 * on Zotero internals to know when a view is stale.
 */
function reapDetachedViews(): void {
  for (const [itemID, mounted] of [...views.entries()]) {
    let connected = true;
    try {
      connected = Boolean(mounted.container?.isConnected);
    } catch {
      // A dead wrapper means the document itself is gone.
      connected = false;
    }
    if (!connected) {
      mounted.view.destroy();
      views.delete(itemID);
    }
  }
}

export interface SidebarAskRequest {
  itemID: number;
  selection: string;
  question: string;
}

/** First mounted view that belongs to the requested paper. */
function findViewFor(itemID: number): ChatView | null {
  const direct = views.get(itemID);
  if (direct) {
    return direct.view;
  }
  for (const mounted of views.values()) {
    if (matchesItem(itemID, mounted.itemID)) {
      return mounted.view;
    }
  }
  return null;
}

/**
 * Route a selection-popup question into the sidebar.
 *
 * Returns false when no view for this paper is mounted yet, so the caller can
 * tell the user something useful instead of appearing to do nothing.
 */
export function askInSidebar(request: SidebarAskRequest): boolean {
  reapDetachedViews();
  const view = findViewFor(request.itemID);
  if (view) {
    view.ask(request.selection, request.question);
    return true;
  }
  pending = request;
  return false;
}

/** Number of mounted views; used for diagnostics and tests. */
export function mountedViewCount(): number {
  return views.size;
}

/** Whether any reader pane is currently mounted. */
export function anyViewMounted(): boolean {
  return views.size > 0;
}
