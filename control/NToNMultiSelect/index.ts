import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { DataverseClient, DataverseError, TimeoutError, friendlyError, isNetworkError, isPermissionError, isServerBusy } from "./src/dataverse";
import { FormBridge } from "./src/formBridge";
import { resolveRelationship } from "./src/metadata";
import { CopyWriter, NamesCopy, namesCopyFor } from "./src/namesCopy";
import { CLIENT_MODE_LIMIT, OptionsQuery, RelatedData, SERVER_PAGE_SIZE, isSearchable } from "./src/relatedData";
import { Strings, stringsFor } from "./src/strings";
import { SyncEngine } from "./src/syncEngine";
import { Item, OptionsMode, RelationshipInfo, isGuid, normalizeId } from "./src/types";
import { MultiSelectView, OptionsStatus } from "./src/view";

const CONTROL_NAME = "KV.NToNMultiSelect";
const SEARCH_DEBOUNCE_MS = 300;
const RESYNC_DEBOUNCE_MS = 400;
/** Subgrids are refreshed once the user pauses, not after every single click. */
const SUBGRID_REFRESH_DELAY_MS = 600;
/** The control's own subgrid refresh comes back as one OnLoad per grid within this time. */
const SELF_REFRESH_WINDOW_MS = 3000;
/** Default for the "Select all limit" setting: each record is its own request, so keep bulk changes reasonable. */
const DEFAULT_SELECT_ALL_LIMIT = 100;
const LOAD_RETRY_DELAYS_MS = [1000, 3000, 9000];
/** An initialisation that failed on a passing problem is tried again once after this pause (and when back online). */
const INIT_RETRY_DELAY_MS = 30_000;
/** Tables whose new-record save skips OnSave/PostSave (Microsoft docs), so picks can't wait for the first save. */
const NO_POST_SAVE_TABLES = ["appointment", "recurringappointmentmaster", "serviceappointment"];

interface Config {
    relationshipName: string;
    filter: string;
    /** System view of the related table (name or id) whose filters decide which records can be picked. */
    view: string;
    /** A complete FetchXML query, or filter and link-entity elements that narrow the list. */
    fetchXml: string;
    showInactive: boolean;
    subgrids: string[];
    /** Hide the subgrids this control takes the place of (see FormBridge.hideSubgrids). */
    hideSubgrids: boolean;
    placeholder: string;
    writeSummary: boolean;
    allowCreate: boolean;
    showSelectAll: boolean;
    /** 1..CLIENT_MODE_LIMIT (the setting's 0 is turned into CLIENT_MODE_LIMIT). */
    selectAllLimit: number;
    /** 0 = no limit. */
    maxSelections: number;
    searchMode: "startswith" | "contains";
    openOnClick: boolean;
    /** Each selected value is a link that opens its record in a new tab. */
    openRecords: boolean;
}

interface ContextInfo {
    entityId?: string;
    entityTypeName?: string;
}

interface OpenFormResult {
    savedEntityReference?: { id: string; name?: string }[];
}

interface XrmGlobal {
    App?: { addGlobalNotification?(notification: object): Promise<string> };
    Navigation?: { openAlertDialog?(alert: { text: string }): Promise<void> };
    Utility?: { getGlobalContext?(): { getClientUrl(): string; getCurrentAppUrl?(): string } };
}

/** "Copy names into the host column" of one record, as a control instance or a detached engine writes it. */
interface HostCopy {
    /** Shared by everything on the page that writes this record's host column (see namesCopyFor). */
    names: NamesCopy;
    writer: CopyWriter;
}

/**
 * An engine whose control is gone (the record was closed or switched) but which still has writes to finish.
 * It keeps writing to its own record, refreshes that record's subgrids if they're still on screen, writes the host
 * column copy once its links are saved (if they changed anything), reports failures through an app notification, and
 * releases itself once everything is saved.
 */
interface Detached {
    key: string;
    bridge: FormBridge;
    label: string;
    t: Strings;
    failures: number;
    firstError: string;
    /**
     * "Copy names into the host column", or null when it's off. It was set up with the record's table, the host
     * column and its length while the control was still there.
     */
    copy: HostCopy | null;
}
const detached = new Map<SyncEngine, Detached>();

/**
 * Picks made on an unsaved record by a control instance that was destroyed while the form stayed open (for example
 * a business rule hid and showed the field). The next instance on the same form adopts them, so the old instance
 * never writes stale picks on its own. Keyed by the form's entity object, then by relationship and host column.
 */
interface Orphan {
    engine: SyncEngine;
    bridge: FormBridge;
    release(): void;
}
const orphans = new WeakMap<object, Map<string, Orphan>>();

/**
 * Engines with links still to write or being written. While any of them has work left, leaving the page (closing
 * the tab, reloading) asks for confirmation, because unloading the page would cancel the requests. Normal in-app
 * navigation (including Save & Close) keeps the page alive, so the writes simply finish.
 */
const liveEngines = new Set<SyncEngine>();
/** Host column copies on their way to the server; leaving the page would cancel them too. */
let copiesWriting = 0;

/**
 * Control instances on the page. Two of them can show the same record (a copy of the field in the header, or two
 * columns bound to the same relationship): when one saves a change, the others read the links again (see
 * resyncPeers), whether or not a subgrid on the form would tell them.
 */
const liveControls = new Set<NToNMultiSelect>();
let unloadGuardInstalled = false;
function installUnloadGuard(): void {
    if (unloadGuardInstalled) return;
    unloadGuardInstalled = true;
    window.addEventListener("beforeunload", (event) => {
        if (copiesWriting > 0 || [...liveEngines].some((engine) => engine.hasPendingChanges() || engine.isBusy())) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
}

async function trackCopy(write: Promise<void>): Promise<void> {
    copiesWriting++;
    try {
        await write;
    } finally {
        copiesWriting--;
    }
}

function xrm(): XrmGlobal | undefined {
    return (window as unknown as { Xrm?: XrmGlobal }).Xrm;
}

/** Shows a message that stays visible after the form is gone (an app-level notification bar). */
function notifyApp(message: string): void {
    try {
        const app = xrm()?.App;
        if (app?.addGlobalNotification) {
            void app.addGlobalNotification({ type: 2, level: 2, message, showCloseButton: true });
            return;
        }
    } catch {
        // fall through to the dialog
    }
    try {
        void xrm()?.Navigation?.openAlertDialog?.({ text: message });
    } catch {
        console.error(`[${CONTROL_NAME}] ${message}`);
    }
}

/** Reads an optional whole-number setting. Empty or invalid values fall back to the default; negatives count as 0. */
function wholeNumber(raw: number | null | undefined, fallback: number): number {
    if (raw === null || raw === undefined || !Number.isFinite(raw)) return fallback;
    return Math.max(0, Math.floor(raw));
}

/** Folds case and accents so "resume" finds "Résumé", like the native search. */
function searchKey(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // the accent marks NFD split off the letters
        .toLowerCase();
}

/** Errors after which the rest of a batch would only fail the same way: no permission, offline, busy, too slow. */
function stopsBatch(error: unknown): boolean {
    return isPermissionError(error) || isNetworkError(error) || error instanceof TimeoutError || isServerBusy(error);
}

/** Errors that can pass by themselves (offline, too slow, throttled, server trouble), unlike a wrong setting. */
function isTransient(error: unknown): boolean {
    return isNetworkError(error) || error instanceof TimeoutError || isServerBusy(error) || (error instanceof DataverseError && error.status >= 500);
}

function isOffline(context: ComponentFramework.Context<IInputs>): boolean {
    try {
        return context.client?.isOffline?.() === true;
    } catch {
        return false;
    }
}

/** The app runs in a browser, not the mobile app, Outlook or Unified Service Desk (an unknown client counts as one). */
function isWebClient(context: ComponentFramework.Context<IInputs>): boolean {
    try {
        const client = context.client?.getClient?.();
        return !client || client === "Web";
    } catch {
        return true;
    }
}

export class NToNMultiSelect implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private context!: ComponentFramework.Context<IInputs>;
    private view!: MultiSelectView;
    private t: Strings = stringsFor(1033);
    private config: Config | null = null;
    /** Null until the first configuration is applied, so that even an empty relationship name gets initialised. */
    private relationshipKey: string | null = null;
    private optionsKey = "";
    private subgridsKey = "";
    private initToken = 0;
    private destroyed = false;

    private rel: RelationshipInfo | null = null;
    private data: RelatedData | null = null;
    private engine: SyncEngine | null = null;
    private bridge: FormBridge | null = null;
    /** Subgrids hidden by "Hide related subgrids", shared with every bridge this instance makes (see FormBridge). */
    private readonly hiddenGrids = new Set<string>();

    // Options (menu) state.
    private mode: OptionsMode | null = null;
    private allOptions: Item[] = [];
    private allOptionsKeys: string[] = [];
    private baseOptions: Item[] = [];
    private baseNext: string | null = null;
    private shownOptions: Item[] = [];
    private shownNext: string | null = null;
    /** Page size the shown list was requested with; "load more" must keep using it. */
    private shownPageSize = SERVER_PAGE_SIZE;
    private optionsStatus: OptionsStatus = "idle";
    private optionsError: string | null = null;
    private loadingMore = false;
    private loadMoreError: string | null = null;
    private searchTerm = "";
    private optionsPromise: Promise<void> | null = null;
    /** Bumped whenever the list is reset, so a first page loaded for the old settings can't fill the new list. */
    private optionsToken = 0;
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private searchAbort: AbortController | null = null;
    /** Bumped by every search and every reset: a search or a "load more" only fills the list it was started for. */
    private searchToken = 0;

    // Feedback.
    private error: string | null = null;
    private batchErrors = 0;
    private batchFirstError = "";
    private fatalError: string | null = null;
    /** New record on a form whose save cannot be observed (e.g. quick create): selection must wait for a saved record. */
    private saveFirst = false;
    /** saveFirst was set only because the control wasn't on the page yet when it started (see initialize). */
    private saveFirstUnplaced = false;
    /** The first read failed for good; coming back online tries again. */
    private loadGaveUp = false;
    /** Initialisation failed on a passing problem; coming back online tries again (see retryInitialize). */
    private initGaveUp = false;
    /** The one timed retry of a failed initialisation is used up. */
    private initRetried = false;
    private offline = false;
    private selectedLoaded = false;
    /** A re-read was asked for while the first read was still on its way (see scheduleResync). */
    private resyncWanted = false;

    // "Copy names into the host column".
    /**
     * The host column value the form loaded with: the copy isn't written while the names still say the same (see
     * namesCopyFor).
     */
    private loadedCopy: string | null = null;
    /** The copy of the current record, set up once it is first needed (see updateSummary). */
    private copy: HostCopy | null = null;

    // Render caching.
    private renderedVersion = -1;
    /** A new record's first save changes what counts as saving, without a new engine version (see render). */
    private renderedRecordId: string | null = null;
    private cachedSelected: Item[] = [];
    private cachedPending = new Set<string>();

    // "Open selected records".
    /** The page records open at, with the app id (see recordPageBase). Worked out once per initialise, when first needed. */
    private recordBase: string | null = null;
    /** Set once: the kind of client the app runs in doesn't change while the page is open. */
    private webClient = true;

    /** Set when metadata looked out of date: the next initialise re-reads it from the server. */
    private refreshMetadata = false;
    private metadataRetried = false;
    private lastLoadError: unknown = null;
    private resyncTimer: ReturnType<typeof setTimeout> | undefined;
    private loadRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private subgridTimer: ReturnType<typeof setTimeout> | undefined;
    /** Subgrid reloads still expected from the control's own refresh: they are echoes, not someone else's change. */
    private echoesLeft = 0;
    private echoesUntil = 0;
    private readonly onSubgridLoad = (): void => {
        if (this.echoesLeft > 0 && Date.now() < this.echoesUntil) {
            this.echoesLeft--;
            return;
        }
        this.scheduleResync();
    };
    private readonly onOnline = (): void => {
        this.offline = isOffline(this.context);
        if (this.initGaveUp) {
            void this.initialize(this.context);
            return;
        }
        if (this.loadGaveUp && this.engine?.getRecordId()) {
            this.loadGaveUp = false;
            this.fatalError = null;
            clearTimeout(this.loadRetryTimer);
            this.retryInitialLoad(this.initToken, 0);
        } else {
            this.scheduleResync();
        }
        this.render();
    };

    public init(context: ComponentFramework.Context<IInputs>, _notifyOutputChanged: () => void, _state: ComponentFramework.Dictionary, container: HTMLDivElement): void {
        this.context = context;
        this.t = stringsFor(context.userSettings?.languageId);
        this.offline = isOffline(context);
        this.webClient = isWebClient(context);
        this.view = new MultiSelectView(
            container,
            {
                onToggle: (item, select) => this.onToggle([item], select),
                onToggleAll: (items, select) => this.onToggle(items, select),
                onSearch: (term) => this.onSearch(term),
                onOpen: () => void this.ensureOptions(),
                onLoadMore: () => void this.loadMore(),
                onDismissError: () => {
                    this.error = null;
                    this.render();
                },
                onCreate: () => void this.createRecord(),
                recordUrl: (item) => this.recordUrl(item),
                onOpenRecord: (item) => void this.openRecord(item),
            },
            this.t,
        );
        window.addEventListener("online", this.onOnline);
        liveControls.add(this);
        this.applyConfig(context);
        this.render();
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this.context = context;
        this.offline = isOffline(context);
        this.applyConfig(context);
        const recordId = this.recordIdFrom(context);
        const engine = this.engine;
        if (engine && this.bridge && this.rel) {
            const current = engine.getRecordId();
            if (this.saveFirst && recordId) {
                // The record was saved inside a dialog or side pane: start over as an existing record.
                void this.initialize(context);
                return;
            }
            if (this.saveFirst && this.saveFirstUnplaced && !recordId && this.view.element().isConnected) {
                // The control is on the page now, so it can follow the save after all.
                void this.initialize(context);
                return;
            }
            if (!current && recordId) {
                // A new record got an id. Only a save of the followed form counts; anything else means the control
                // is now showing some other record, and picks made for the unsaved one must not end up there.
                if (this.bridge.savedAs(recordId)) {
                    this.onRecordSaved(engine, this.bridge, recordId, this.rel.schemaName, this.data);
                } else {
                    this.retireEngine(true);
                    void this.initialize(context);
                    return;
                }
            } else if (current && recordId !== current) {
                // The same control instance now shows a different record (or a new one): never carry state over.
                void this.initialize(context);
                return;
            }
        }
        // Grids can register after the control, so both are applied again on every update.
        const linkedRecordId = this.engine?.getRecordId() ?? null;
        this.applyHideSubgrids(linkedRecordId);
        this.bridge?.watchSubgrids(linkedRecordId, this.onSubgridLoad);
        this.render();
    }

    public getOutputs(): IOutputs {
        // The host column is only an anchor, so the form never gets a value from this control and is never made
        // dirty by it. "Copy names into the host column" writes to the record itself (see updateSummary).
        return {};
    }

    public destroy(): void {
        this.destroyed = true;
        this.initToken++;
        clearTimeout(this.searchTimer);
        clearTimeout(this.resyncTimer);
        clearTimeout(this.loadRetryTimer);
        clearTimeout(this.initRetryTimer);
        clearTimeout(this.subgridTimer);
        this.searchAbort?.abort();
        window.removeEventListener("online", this.onOnline);
        liveControls.delete(this);
        this.view.destroy();
        this.retireEngine();
    }

    // ---------------------------------------------------------------- configuration & loading

    private readConfig(context: ComponentFramework.Context<IInputs>): Config {
        const p = context.parameters;
        return {
            relationshipName: (p.relationshipName?.raw ?? "").trim(),
            filter: (p.filter?.raw ?? "").trim(),
            view: (p.view?.raw ?? "").trim(),
            fetchXml: (p.fetchXml?.raw ?? "").trim(),
            showInactive: String(p.showInactive?.raw ?? "0") === "1",
            subgrids: (p.subgrids?.raw ?? "")
                .split(/[,;]/)
                .map((s) => s.trim())
                .filter(Boolean),
            hideSubgrids: String(p.hideSubgrids?.raw ?? "0") === "1",
            placeholder: (p.placeholder?.raw ?? "").trim() || this.t.placeholder,
            writeSummary: String(p.writeSummary?.raw ?? "0") === "1",
            allowCreate: String(p.allowCreate?.raw ?? "0") === "1",
            showSelectAll: String(p.showSelectAll?.raw ?? "1") !== "0",
            // 0 means "as many as the list holds"; nothing above that is ever offered.
            selectAllLimit: Math.min(wholeNumber(p.selectAllLimit?.raw, DEFAULT_SELECT_ALL_LIMIT) || CLIENT_MODE_LIMIT, CLIENT_MODE_LIMIT),
            maxSelections: wholeNumber(p.maxSelections?.raw, 0),
            searchMode: String(p.searchMode?.raw ?? "0") === "1" ? "contains" : "startswith",
            openOnClick: String(p.openOnClick?.raw ?? "0") === "1",
            openRecords: String(p.openRecords?.raw ?? "0") === "1",
        };
    }

    private applyConfig(context: ComponentFramework.Context<IInputs>): void {
        const config = this.readConfig(context);
        this.config = config;
        const relationshipKey = config.relationshipName.toLowerCase();
        const optionsKey = JSON.stringify([config.filter, config.view, config.fetchXml, config.showInactive, config.searchMode]);
        const subgridsKey = config.subgrids.join(",");
        if (relationshipKey !== this.relationshipKey) {
            this.relationshipKey = relationshipKey;
            this.optionsKey = optionsKey;
            this.subgridsKey = subgridsKey;
            void this.initialize(context);
            return;
        }
        if (optionsKey !== this.optionsKey) {
            // Only the list of offered records changes; picks and queued writes are kept.
            this.optionsKey = optionsKey;
            const warmed = this.optionsStatus !== "idle";
            this.resetOptions();
            if (warmed) void this.ensureOptions();
        }
        if (subgridsKey !== this.subgridsKey) {
            this.subgridsKey = subgridsKey;
            this.bridge?.setSubgrids(config.subgrids);
            this.bridge?.watchSubgrids(this.engine?.getRecordId() ?? null, this.onSubgridLoad);
        }
    }

    private contextInfo(context: ComponentFramework.Context<IInputs>): ContextInfo {
        return ((context.mode as unknown as { contextInfo?: ContextInfo }).contextInfo ?? {}) as ContextInfo;
    }

    /**
     * The record id comes only from the control's own context. (The page-level form API is deliberately not used
     * here: on a quick create form it describes the record underneath, which would link values to the wrong record.)
     */
    private recordIdFrom(context: ComponentFramework.Context<IInputs>): string | null {
        const id = normalizeId(this.contextInfo(context).entityId);
        return isGuid(id) && id !== "00000000-0000-0000-0000-000000000000" ? id : null;
    }

    private clientUrl(context: ComponentFramework.Context<IInputs>): string {
        const page = (context as unknown as { page?: { getClientUrl?: () => string } }).page;
        try {
            const url = page?.getClientUrl?.();
            if (url) return url;
        } catch {
            // fall through
        }
        try {
            const url = xrm()?.Utility?.getGlobalContext?.().getClientUrl();
            if (url) return url;
        } catch {
            // fall through
        }
        return window.location.origin;
    }

    /** Identifies "this relationship on this record", shared by every instance on the page. */
    private recordKey(recordId: string): string {
        return `${recordId}|${this.rel?.schemaName.toLowerCase() ?? ""}`;
    }

    private async initialize(context: ComponentFramework.Context<IInputs>): Promise<void> {
        const token = ++this.initToken;
        const config = this.config!;
        this.retireEngine();
        this.data = null;
        this.rel = null;
        this.fatalError = null;
        this.saveFirst = false;
        this.saveFirstUnplaced = false;
        this.loadGaveUp = false;
        this.initGaveUp = false;
        this.selectedLoaded = false;
        this.resyncWanted = false;
        this.error = null;
        this.batchErrors = 0;
        this.loadedCopy = context.parameters.value?.raw || null;
        this.recordBase = null;
        clearTimeout(this.loadRetryTimer);
        clearTimeout(this.initRetryTimer);
        clearTimeout(this.resyncTimer);
        clearTimeout(this.subgridTimer);
        this.resetOptions();
        this.render();

        const entityName = (this.contextInfo(context).entityTypeName ?? "").toLowerCase();
        if (!entityName) {
            this.fatalError = this.t.notOnForm;
            this.render();
            return;
        }
        if (!config.relationshipName) {
            this.fatalError = this.t.noRelationship;
            this.render();
            return;
        }

        try {
            const client = new DataverseClient(this.clientUrl(context));
            const rel = await resolveRelationship(client, config.relationshipName, entityName, this.refreshMetadata);
            this.refreshMetadata = false;
            if (token !== this.initToken) return;
            this.initRetried = false;
            this.rel = rel;
            const data = (this.data = new RelatedData(client, rel, this.t.noName));
            const bridge = new FormBridge(entityName, rel.schemaName, config.subgrids, this.view.element(), rel.selfReferencing ? rel.navigationProperty : null, this.hiddenGrids);
            const engine: SyncEngine = new SyncEngine(
                {
                    associate: (recordId, targetId) => data.associate(recordId, targetId),
                    disassociate: (recordId, targetId) => data.disassociate(recordId, targetId),
                },
                {
                    onChange: () => {
                        if (engine === this.engine) this.render();
                    },
                    onSettled: (changed) => this.onSettled(engine, changed),
                    onError: (item, operation, error) => this.onWriteError(engine, item, operation, error),
                },
            );
            this.engine = engine;
            this.bridge = bridge;
            liveEngines.add(engine);
            installUnloadGuard();
            this.warnAboutRequiredHost();

            // Use the latest context: the record may have been saved while the metadata was loading.
            const recordId = this.recordIdFrom(this.context);
            // Before the links are read, so that replaced subgrids disappear as early as possible.
            this.applyHideSubgrids(recordId);
            if (recordId) {
                engine.setRecordId(recordId);
                this.releaseAbandonedOrphan(bridge, recordId);
                if (config.writeSummary) {
                    // Join the record's copy now, with the value the form loaded. Another instance on the record (a copy
                    // of the field in the header) may write it before this one changes anything; joining only then
                    // would take that write for a change made elsewhere and write the same names again (NamesCopy.seen).
                    this.copy = this.startCopy(recordId, this.recordKey(recordId), data);
                }
                const loaded = await this.loadSelected(token, false);
                if (token !== this.initToken) return;
                if (!loaded && !this.metadataRetried && this.lastLoadError instanceof DataverseError && (this.lastLoadError.status === 400 || this.lastLoadError.status === 404)) {
                    // The relationship may have changed since its metadata was read (e.g. renamed): re-read it once.
                    this.metadataRetried = true;
                    this.refreshMetadata = true;
                    this.error = null;
                    void this.initialize(this.context);
                    return;
                }
                if (!loaded) {
                    if (isPermissionError(this.lastLoadError)) {
                        // Retrying won't help: the user can't read these records.
                        this.fatalError = friendlyError(this.lastLoadError, this.t, "read");
                        this.error = null;
                        this.render();
                        return;
                    }
                    // Never let the user edit against an unknown baseline: stay read-only and retry.
                    this.retryInitialLoad(token, 0);
                    bridge.watchSubgrids(recordId, this.onSubgridLoad);
                    this.render();
                    return;
                }
            } else if (NO_POST_SAVE_TABLES.includes(entityName)) {
                this.saveFirst = true;
            } else {
                await bridge.waitUntilPlaced();
                if (token !== this.initToken) return;
                if (engine.getRecordId() || this.recordIdFrom(this.context)) {
                    // The record was saved in the meantime: start again as an existing record.
                    void this.initialize(this.context);
                    return;
                }
                const schemaName = rel.schemaName;
                if (!bridge.onPostSave((id) => this.onRecordSaved(engine, bridge, id, schemaName, data))) {
                    // Without a save event (quick create, or a form that can't be identified) picked values could not
                    // be linked.
                    this.saveFirst = true;
                    this.saveFirstUnplaced = !this.view.element().isConnected;
                } else {
                    this.adoptOrphan();
                    // Only now that the control is placed can a new record's form be told apart from a quick create pane.
                    this.applyHideSubgrids(null);
                }
            }
            if (token !== this.initToken) return;
            this.firstLoadDone();
            bridge.watchSubgrids(recordId, this.onSubgridLoad);
            this.render();
            this.warmOptions(token);
        } catch (error) {
            if (token !== this.initToken) return;
            this.fatalError = friendlyError(error, this.t, "read");
            console.error(`[${CONTROL_NAME}] initialisation failed`, error);
            // A wrong setting fails the same way every time; anything else may pass.
            if (isTransient(error)) this.retryInitialize(token);
            this.render();
        }
    }

    /** Initialisation failed on a passing problem: it is tried again once after a pause, and when back online. */
    private retryInitialize(token: number): void {
        this.initGaveUp = true;
        if (this.initRetried) return;
        this.initRetried = true;
        this.initRetryTimer = setTimeout(() => {
            if (token === this.initToken && !this.destroyed && this.initGaveUp) void this.initialize(this.context);
        }, INIT_RETRY_DELAY_MS);
    }

    /** Loads the list in the background so the first open is instant (not for read-only or offline controls). */
    private warmOptions(token: number): void {
        if (this.saveFirst || this.offline || this.context.mode.isControlDisabled) return;
        setTimeout(() => {
            if (token === this.initToken && !this.destroyed) void this.ensureOptions();
        }, 50);
    }

    /**
     * The control never fills its host column on the form ("Copy names into the host column" writes to the record
     * instead), so a Business Required host column would block every save. Easy to miss when setting up a form, so
     * say so in the console.
     */
    private warnAboutRequiredHost(): void {
        const required = (this.context.parameters.value as unknown as { attributes?: { RequiredLevel?: number } })?.attributes?.RequiredLevel;
        if (required === 1 || required === 2) {
            console.warn(`[${CONTROL_NAME}] The host column is required, but this control never fills it on the form, so the form can't be saved while it's empty. Use a column that isn't required.`);
        }
    }

    /**
     * Lets the current engine go. If it still has changes to write, or writes on their way, for a saved record, it
     * keeps running on its own (see Detached). Unsaved picks on a new record become an orphan the next instance can
     * adopt, unless `discardHeld` is set (the control has moved on to another record, so they must not follow).
     */
    private retireEngine(discardHeld = false): void {
        const engine = this.engine;
        const bridge = this.bridge;
        const copy = this.copy;
        this.engine = null;
        this.bridge = null;
        // A copy that is still on its way reports a failure in an app notification from now on (see onCopyFailed).
        this.copy = null;
        if (!engine || !bridge) return;
        bridge.unwatchSubgrids();
        if (!engine.hasPendingChanges() && !engine.isBusy()) {
            liveEngines.delete(engine);
            engine.dispose();
            bridge.dispose();
            return;
        }
        const recordId = engine.getRecordId();
        if (recordId) {
            // Writes are queued or running (e.g. the user closed the record right after Select all): let them finish,
            // and the host column copy after them.
            const key = this.recordKey(recordId);
            detached.set(engine, {
                key,
                bridge,
                label: this.context.mode.label || this.t.relatedRecords,
                t: this.t,
                failures: 0,
                firstError: "",
                copy: this.config?.writeSummary ? (copy ?? this.startCopy(recordId, key, this.data)) : null,
            });
            return;
        }
        const entity = bridge.trackedEntity();
        if (!entity || !this.rel || discardHeld) {
            liveEngines.delete(engine);
            engine.dispose();
            bridge.dispose();
            return;
        }
        // New record: keep the post-save hook so the picks are still linked on Save & Close. If the form stays open
        // and a new instance of this control starts, it adopts these picks instead. Until the record is saved the
        // orphan doesn't hold up leaving the page (there is nothing it could write yet).
        liveEngines.delete(engine);
        const byKey = orphans.get(entity) ?? new Map<string, Orphan>();
        orphans.set(entity, byKey);
        const key = this.orphanKey();
        const existing = byKey.get(key);
        if (existing && !existing.engine.getRecordId()) {
            // Another copy of the field on the same form (header and body) left picks too: one orphan links them all.
            existing.engine.setMany(engine.selected(), true);
            engine.dispose();
            bridge.dispose();
            return;
        }
        // An orphan that has a record id is saved and finishes its writes on its own (see Detached).
        const orphan: Orphan = {
            engine,
            bridge,
            release: () => {
                if (byKey.get(key) === orphan) byKey.delete(key);
                liveEngines.delete(engine);
                engine.dispose();
                bridge.dispose();
            },
        };
        byKey.set(key, orphan);
    }

    /** Relationship plus host column, so two controls for the same relationship on one form never mix their picks. */
    private orphanKey(): string {
        const host = (this.context.parameters.value as unknown as { attributes?: { LogicalName?: string } })?.attributes?.LogicalName ?? "";
        return `${this.rel?.schemaName.toLowerCase() ?? ""}|${host}`;
    }

    /**
     * Lets go of picks left on an unsaved record when the same form now shows the saved record `recordId` without
     * having created it (it moved on to another record): a later save on that form must never link them.
     */
    private releaseAbandonedOrphan(bridge: FormBridge, recordId: string): void {
        const entity = bridge.hostEntity(recordId);
        const orphan = entity ? orphans.get(entity)?.get(this.orphanKey()) : undefined;
        if (orphan && !orphan.engine.getRecordId() && !orphan.bridge.savedAs(recordId)) orphan.release();
    }

    /** Takes over picks left by a previous instance of this control on the same unsaved form (see `orphans`). */
    private adoptOrphan(): void {
        const entity = this.bridge?.trackedEntity();
        if (!entity || !this.rel || !this.engine) return;
        const orphan = orphans.get(entity)?.get(this.orphanKey());
        if (!orphan || orphan.engine.getRecordId()) return;
        const picks = orphan.engine.selected();
        orphan.release();
        if (picks.length) this.engine.setMany(picks, true);
    }

    /** Waits for writes to this record by instances that are already gone (e.g. the record was just reopened). */
    private async peersIdle(recordId: string): Promise<void> {
        const key = this.recordKey(recordId);
        const running = [...detached].filter(([engine, d]) => d.key === key && engine !== this.engine).map(([engine]) => engine.whenIdle());
        if (running.length) await Promise.all(running);
    }

    /**
     * Reads the saved links. `isResync` is true for a re-read after the first load (subgrid edits, reconnecting,
     * failed writes); only then can the host-column copy be out of date. Returns false when the read failed.
     */
    private async loadSelected(token: number, isResync: boolean): Promise<boolean> {
        const engine = this.engine;
        const data = this.data;
        const recordId = engine?.getRecordId();
        if (!engine || !data || !recordId) return false;
        try {
            await this.peersIdle(recordId);
            await engine.whenIdle();
            const version = engine.version;
            const items = await data.loadSelected(recordId);
            if (token !== this.initToken || engine !== this.engine) return false;
            if (engine.version !== version || engine.isBusy()) {
                // The user changed something during the read; read again once those writes are done.
                this.scheduleResync();
                return true;
            }
            const before = engine.selected();
            engine.setConfirmed(items);
            if (isResync && !sameIds(before, engine.selected())) {
                this.updateSummary();
            }
            this.render();
            return true;
        } catch (error) {
            if (token !== this.initToken) return false;
            this.lastLoadError = error;
            this.error = `${this.t.loadSelectedFailed} ${friendlyError(error, this.t, "read")}`;
            console.error(`[${CONTROL_NAME}] loading related records failed`, error);
            this.render();
            return false;
        }
    }

    private retryInitialLoad(token: number, attempt: number): void {
        if (attempt >= LOAD_RETRY_DELAYS_MS.length) {
            // Give up until the connection comes back (see onOnline), with a message that can't be dismissed: the
            // field has nothing to show until the read works.
            this.loadGaveUp = true;
            this.fatalError = `${this.t.loadSelectedFailed} ${this.t.reloadToRetry}`;
            this.error = null;
            this.render();
            return;
        }
        this.loadRetryTimer = setTimeout(async () => {
            if (token !== this.initToken || this.destroyed) return;
            const loaded = await this.loadSelected(token, false);
            if (token !== this.initToken || this.destroyed) return;
            if (loaded) {
                this.error = null;
                this.firstLoadDone();
                this.render();
                this.warmOptions(token);
            } else if (isPermissionError(this.lastLoadError)) {
                this.fatalError = friendlyError(this.lastLoadError, this.t, "read");
                this.error = null;
                this.render();
            } else {
                this.retryInitialLoad(token, attempt + 1);
            }
        }, LOAD_RETRY_DELAYS_MS[attempt]);
    }

    private scheduleResync(): void {
        clearTimeout(this.resyncTimer);
        this.resyncTimer = setTimeout(() => {
            if (this.destroyed) return;
            if (this.selectedLoaded) void this.loadSelected(this.initToken, true);
            // The first read may have been answered before the change: read again once it is done.
            else this.resyncWanted = true;
        }, RESYNC_DEBOUNCE_MS);
    }

    /** The first read is done, so the field can be edited; a re-read asked for in the meantime runs now. */
    private firstLoadDone(): void {
        this.selectedLoaded = true;
        if (this.resyncWanted) {
            this.resyncWanted = false;
            this.scheduleResync();
        }
    }

    /**
     * A new record was saved: queued picks can now be linked (and then copied into the host column). `schemaName`
     * and `data` are captured when the save hook is set up, because by the time an orphan's form saves, this instance
     * may be showing something else.
     */
    private onRecordSaved(engine: SyncEngine, bridge: FormBridge, recordId: string, schemaName: string, data: RelatedData | null): void {
        // An engine belongs to one record for good. Once it has an id, a later save of the same form is an update, or
        // the save of another record the form has moved on to, whose links must never get this record's picks.
        if (engine.getRecordId()) return;
        engine.setRecordId(recordId);
        if (engine.hasPendingChanges()) liveEngines.add(engine);
        if (engine === this.engine && !this.destroyed) {
            bridge.watchSubgrids(recordId, this.onSubgridLoad);
            // The create may have made links of its own (a plug-in, or the record was created from a related
            // record's subgrid): read them once the picks are written (loadSelected waits for that).
            this.scheduleResync();
            this.render();
        } else if (!detached.has(engine)) {
            // An orphan whose form was saved and closed (Save & Close): it now writes on its own.
            const key = `${recordId}|${schemaName.toLowerCase()}`;
            detached.set(engine, {
                key,
                bridge,
                label: this.context.mode.label || this.t.relatedRecords,
                t: this.t,
                failures: 0,
                firstError: "",
                copy: this.config?.writeSummary ? this.startCopy(recordId, key, data) : null,
            });
        }
    }

    private onWriteError(engine: SyncEngine, item: Item, operation: "add" | "remove", error: unknown): void {
        console.error(`[${CONTROL_NAME}] ${operation} failed for ${item.id}`, error);
        const reason = friendlyError(error, this.t, "change");
        // Every queued change would fail the same way (no permission, offline, server busy): drop them now and count
        // them as failed, instead of sending them one by one.
        const dropped = stopsBatch(error) ? engine.cancelQueued() : 0;
        if (engine !== this.engine) {
            const away = detached.get(engine);
            if (away) {
                away.failures += 1 + dropped;
                if (!away.firstError) away.firstError = reason;
            }
            return;
        }
        this.batchErrors += 1 + dropped;
        if (this.batchErrors === 1) {
            this.batchFirstError = reason;
            this.error = `${operation === "add" ? this.t.addFailed(item.name) : this.t.removeFailed(item.name)} ${reason}`;
        } else {
            if (this.batchErrors === 1 + dropped) this.batchFirstError = reason;
            this.error = `${this.t.manyFailed(this.batchErrors)} ${this.batchFirstError}`;
        }
        this.render();
    }

    private onSettled(engine: SyncEngine, changed: boolean): void {
        if (engine !== this.engine) {
            const away = detached.get(engine);
            if (away) this.finishDetached(engine, away, changed);
            return;
        }
        const hadErrors = this.batchErrors > 0;
        this.batchErrors = 0;
        if (changed) {
            this.scheduleSubgridRefresh();
            this.updateSummary();
            const recordId = engine.getRecordId();
            if (recordId) this.resyncPeers(this.recordKey(recordId), engine);
        }
        if (hadErrors) {
            // A failure might not be what it seems (the connection dropped after the server saved): re-read.
            this.scheduleResync();
        }
        this.render();
    }

    private finishDetached(engine: SyncEngine, away: Detached, changed: boolean): void {
        if (changed) {
            away.bridge.refreshSubgrids(engine.getRecordId());
            this.resyncPeers(away.key, engine);
        }
        if (engine.hasPendingChanges() || engine.isBusy()) return;
        if (away.failures > 0) {
            notifyApp(`${away.t.closedFailures(away.failures, away.label)} ${away.firstError}`);
        }
        // Every link is saved (or has failed for good), so the copy can follow them, unless none of them changed
        // anything. Changes that were saved before the engine was detached have been copied already (updateSummary).
        if (changed && away.copy) {
            away.copy.names.update(engine.selected(), away.copy.writer);
        }
        detached.delete(engine);
        liveEngines.delete(engine);
        engine.dispose();
        away.bridge.dispose();
    }

    /**
     * `engine` saved changes to the links of `key` (see recordKey): every other instance on the page that shows them
     * reads them again. A subgrid's OnLoad reaches them only when the form has a visible subgrid of the relationship;
     * otherwise they would keep showing the links from before and, with "Copy names into the host column", write
     * those names into the shared copy with their next change.
     */
    private resyncPeers(key: string, engine: SyncEngine): void {
        for (const control of liveControls) {
            const recordId = control.engine?.getRecordId();
            if (control.engine !== engine && !control.destroyed && recordId && control.recordKey(recordId) === key) {
                control.scheduleResync();
            }
        }
    }

    private scheduleSubgridRefresh(): void {
        clearTimeout(this.subgridTimer);
        this.subgridTimer = setTimeout(() => {
            if (this.destroyed || !this.bridge) return;
            this.echoesLeft = this.bridge.refreshSubgrids(this.engine?.getRecordId() ?? null);
            this.echoesUntil = Date.now() + SELF_REFRESH_WINDOW_MS;
        }, SUBGRID_REFRESH_DELAY_MS);
    }

    /**
     * "Hide related subgrids": hides the subgrids this control takes the place of or, once the setting is turned off,
     * shows again the ones it hid.
     */
    private applyHideSubgrids(recordId: string | null): void {
        const bridge = this.bridge;
        if (!bridge) return;
        if (this.config?.hideSubgrids) {
            bridge.hideSubgrids(recordId);
        } else if (bridge.showHiddenSubgrids(recordId) > 0) {
            // They weren't refreshed while hidden, so they may still show links from before.
            this.scheduleSubgridRefresh();
        }
    }

    /**
     * "Copy names into the host column": once links are saved, the selected names are written to the record itself,
     * with an update of its own. The form is never made dirty, and a new record gets nothing before its first save
     * (its links are written first, then the copy).
     */
    private updateSummary(): void {
        const engine = this.engine;
        const recordId = engine?.getRecordId();
        if (this.destroyed || !this.config?.writeSummary || !engine || !recordId) return;
        this.copy ??= this.startCopy(recordId, this.recordKey(recordId), this.data);
        if (this.copy) {
            this.copy.names.update(engine.selected(), this.copy.writer);
        }
    }

    /**
     * Sets up the host column copy of `recordId`. With the host column, `recordKey` picks the copy the page shares for
     * that record (see namesCopyFor). Everything it needs (the table, the host column and its length, the label and
     * language for messages) is taken now, so it keeps working once this instance has moved on.
     */
    private startCopy(recordId: string, recordKey: string, data: RelatedData | null): HostCopy | null {
        const attributes = (this.context.parameters.value as unknown as { attributes?: { LogicalName?: string; MaxLength?: number } }).attributes;
        const host = attributes?.LogicalName;
        if (!host) {
            console.warn(`[${CONTROL_NAME}] The host column's logical name isn't available, so the names can't be copied into it.`);
            return null;
        }
        if (!data) return null;
        const label = this.context.mode.label || this.t.relatedRecords;
        const t = this.t;
        const copy: HostCopy = {
            names: namesCopyFor(`${recordKey}|${host}`, this.loadedCopy),
            writer: {
                maxLength: attributes.MaxLength,
                write: (value) => trackCopy(data.updateRecord(recordId, host, value)),
                onError: (error) => this.onCopyFailed(copy, error, label, t),
            },
        };
        return copy;
    }

    /**
     * A failed copy leaves the links as they are. It is explained under the field or, once the control has moved on
     * (the record was closed, or the control shows another one), in an app notification.
     */
    private onCopyFailed(copy: HostCopy, error: unknown, label: string, t: Strings): void {
        console.error(`[${CONTROL_NAME}] copying the names into the host column failed`, error);
        const message = t.copyFailed(label, friendlyError(error, t, "update"));
        if (copy === this.copy && !this.destroyed) {
            this.error = message;
            this.render();
        } else {
            notifyApp(message);
        }
    }

    // ---------------------------------------------------------------- user actions

    /**
     * "Open selected records": the main.aspx page that records open at, so they open in the same app. That is the
     * current app's own address when the platform gives it, otherwise the organisation's main.aspx with the app id of
     * this page (without one, the user's default app opens).
     */
    private recordPageBase(context: ComponentFramework.Context<IInputs>): string {
        try {
            const url = xrm()?.Utility?.getGlobalContext?.().getCurrentAppUrl?.();
            if (url) return url;
        } catch {
            // fall through
        }
        let appId = "";
        try {
            appId = (context as unknown as { page?: { appId?: string } }).page?.appId ?? "";
        } catch {
            // fall through
        }
        if (!appId) {
            try {
                appId = new URLSearchParams(window.location.search).get("appid") ?? "";
            } catch {
                // no app id
            }
        }
        const base = `${this.clientUrl(context).replace(/\/+$/, "")}/main.aspx`;
        return appId ? `${base}?appid=${encodeURIComponent(appId)}` : base;
    }

    /** Address of a related record's form, or null when it can't be linked to (no metadata yet, or not a record id). */
    private recordUrl(item: Item): string | null {
        const rel = this.rel;
        if (!rel || !isGuid(item.id)) return null;
        const base = (this.recordBase ??= this.recordPageBase(this.context));
        const separator = /[?&]$/.test(base) ? "" : base.includes("?") ? "&" : "?";
        return `${base}${separator}pagetype=entityrecord&etn=${encodeURIComponent(rel.targetEntity)}&id=${encodeURIComponent(item.id)}`;
    }

    /** Records open through the app instead of a browser tab: in the mobile app or Outlook, and while offline. */
    private opensRecordsInApp(): boolean {
        return !this.webClient || isOffline(this.context);
    }

    /** Opens a selected record in a new tab: Enter on a highlighted chip, and link clicks the view hands over. */
    private async openRecord(item: Item): Promise<void> {
        const rel = this.rel;
        if (!rel || !isGuid(item.id)) return;
        if (!this.opensRecordsInApp()) {
            const url = this.recordUrl(item);
            // Only noopener and noreferrer: any other window feature makes browsers open a popup window, not a tab.
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            return;
        }
        try {
            await this.context.navigation.openForm({ entityName: rel.targetEntity, entityId: item.id, openInNewWindow: true });
        } catch (error) {
            console.error(`[${CONTROL_NAME}] opening the record ${item.id} failed`, error);
        }
    }

    private canEdit(): boolean {
        return !!this.engine && this.selectedLoaded && !this.context.mode.isControlDisabled && !this.saveFirst && !this.offline;
    }

    private onToggle(items: Item[], select: boolean): void {
        const engine = this.engine;
        if (!engine || !this.canEdit()) return;
        const max = this.config?.maxSelections ?? 0;
        if (select && max > 0) {
            const adding = items.filter((i) => !engine.isSelected(i.id)).length;
            if (engine.selectedCount() + adding > max) {
                // The view already blocks this; the check here also covers + New and anything else that selects.
                this.error = this.t.maxNote(max);
                this.render();
                return;
            }
        }
        this.error = null;
        engine.setMany(items, select);
    }

    private async createRecord(): Promise<void> {
        const rel = this.rel;
        const engine = this.engine;
        const data = this.data;
        const token = this.initToken;
        if (!rel || !engine || !data) return;
        let item: Item;
        try {
            const navigation = this.context.navigation as unknown as { openForm(options: object): Promise<OpenFormResult> };
            const result = await navigation.openForm({ entityName: rel.targetEntity, useQuickCreateForm: true });
            const saved = result?.savedEntityReference?.[0];
            if (!saved || this.destroyed) return;
            item = { id: normalizeId(saved.id), name: saved.name || this.t.noName };
        } catch (error) {
            this.error = `${this.t.createFailed} ${friendlyError(error, this.t, "change")}`;
            this.render();
            return;
        }
        // The control may have moved on (another record, or it can't be edited now): never link to the wrong place.
        const movedOn = (): boolean => token !== this.initToken || engine !== this.engine || !this.canEdit();
        if (movedOn()) {
            this.error = this.t.createdNotLinked(item.name);
            this.render();
            return;
        }
        // Reload the list so the new record appears in its place in the list's order, if the list offers it.
        this.resetOptions();
        void this.ensureOptions();
        // Quick create knows nothing of the list's filter, view or FetchXML, so check the new record against them.
        let offered: boolean;
        try {
            offered = await data.isOffered(this.optionsQuery(), item.id);
        } catch (error) {
            console.error(`[${CONTROL_NAME}] checking the new record against the list failed`, error);
            this.error = `${this.t.createdNotLinked(item.name)} ${friendlyError(error, this.t, "read")}`;
            this.render();
            return;
        }
        if (movedOn()) {
            this.error = this.t.createdNotLinked(item.name);
        } else if (!offered) {
            this.error = this.t.createdNotOffered(item.name);
        } else {
            this.onToggle([item], true);
            return;
        }
        this.render();
    }

    private optionsQuery(): OptionsQuery {
        const config = this.config!;
        return {
            showInactive: config.showInactive,
            extraFilter: config.filter,
            view: config.view,
            fetchXml: config.fetchXml,
            searchMode: config.searchMode,
            // A record can't sensibly be linked to itself in a self-referencing relationship.
            excludeId: this.rel?.selfReferencing ? (this.engine?.getRecordId() ?? null) : null,
        };
    }

    private resetOptions(): void {
        this.optionsToken++;
        // A search or a page of "load more" still on its way was asked for with the old settings (or for the old
        // record): it must not fill the new list.
        this.searchToken++;
        this.searchAbort?.abort();
        clearTimeout(this.searchTimer);
        this.mode = null;
        this.allOptions = [];
        this.allOptionsKeys = [];
        this.baseOptions = [];
        this.baseNext = null;
        this.shownOptions = [];
        this.shownNext = null;
        this.shownPageSize = SERVER_PAGE_SIZE;
        this.optionsStatus = "idle";
        this.optionsError = null;
        this.optionsPromise = null;
        this.loadingMore = false;
        this.loadMoreError = null;
    }

    private ensureOptions(): Promise<void> {
        if (!this.data || !this.config) return Promise.resolve();
        if (this.optionsPromise && this.optionsStatus !== "error") return this.optionsPromise;
        const data = this.data;
        const query = this.optionsQuery();
        const token = this.initToken;
        const listToken = this.optionsToken;
        this.optionsStatus = "loading";
        this.optionsError = null;
        this.render();
        this.optionsPromise = (async () => {
            try {
                // One request decides the mode: if everything fits in one page of 500, filter locally from then on.
                const page = await data.loadOptions(query, "", CLIENT_MODE_LIMIT, null);
                if (token !== this.initToken || listToken !== this.optionsToken) return;
                if (!page.nextLink) {
                    this.mode = "client";
                    this.allOptions = page.items;
                    this.allOptionsKeys = page.items.map((i) => searchKey(i.name));
                } else {
                    this.mode = "server";
                    this.baseOptions = page.items;
                    this.baseNext = page.nextLink;
                }
                this.optionsStatus = "ready";
                this.applySearch(this.searchTerm, true);
            } catch (error) {
                if (token !== this.initToken || listToken !== this.optionsToken) return;
                this.optionsStatus = "error";
                this.optionsError = `${this.t.loadFailed} ${friendlyError(error, this.t, "read")}`;
                console.error(`[${CONTROL_NAME}] loading options failed`, error);
                this.render();
            }
        })();
        return this.optionsPromise;
    }

    private onSearch(term: string): void {
        this.searchTerm = term;
        if (!this.mode) {
            // The first page has not loaded yet (or failed); ensureOptions applies the latest term when it arrives.
            void this.ensureOptions();
            return;
        }
        // applySearch aborts an in-flight search and debounces the new one, so no keystroke is ever dropped.
        this.applySearch(term, false);
    }

    private applySearch(term: string, immediate: boolean): void {
        clearTimeout(this.searchTimer);
        this.searchAbort?.abort();
        this.searchAbort = null;
        const trimmed = term.trim();
        if (this.mode === "client") {
            if (!trimmed) {
                this.shownOptions = this.allOptions;
            } else {
                const key = searchKey(trimmed);
                this.shownOptions = this.allOptions.filter((_, i) => this.allOptionsKeys[i].includes(key));
            }
            this.shownNext = null;
            this.render();
            return;
        }
        if (this.mode !== "server") return;
        if (!trimmed) {
            this.searchToken++;
            this.loadingMore = false;
            this.loadMoreError = null;
            this.shownOptions = this.baseOptions;
            this.shownNext = this.baseNext;
            this.shownPageSize = CLIENT_MODE_LIMIT;
            this.optionsStatus = "ready";
            this.render();
            return;
        }
        if (!isSearchable(trimmed)) {
            // Only hyphens or apostrophes: nothing to search for, and the query would scan the whole table.
            this.searchToken++;
            this.shownOptions = [];
            this.shownNext = null;
            this.optionsStatus = "ready";
            this.render();
            return;
        }
        const run = (): void => void this.serverSearch(trimmed);
        if (immediate) run();
        else this.searchTimer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    }

    private async serverSearch(term: string): Promise<void> {
        if (!this.data || !this.config) return;
        const token = ++this.searchToken;
        const abort = new AbortController();
        this.searchAbort = abort;
        this.loadingMore = false;
        this.loadMoreError = null;
        this.optionsStatus = "loading";
        this.shownOptions = [];
        this.shownNext = null;
        this.render();
        try {
            const page = await this.data.loadOptions(this.optionsQuery(), term, SERVER_PAGE_SIZE, null, abort.signal);
            if (token !== this.searchToken) return;
            this.shownOptions = page.items;
            this.shownNext = page.nextLink;
            this.shownPageSize = SERVER_PAGE_SIZE;
            this.optionsStatus = "ready";
        } catch (error) {
            if (token !== this.searchToken || abort.signal.aborted) return;
            this.optionsStatus = "error";
            this.optionsError = `${this.t.searchFailed} ${friendlyError(error, this.t, "read")}`;
            console.error(`[${CONTROL_NAME}] searching failed`, error);
        }
        this.render();
    }

    private async loadMore(): Promise<void> {
        if (!this.data || this.mode !== "server" || !this.shownNext || this.loadingMore) return;
        const token = this.searchToken;
        const next = this.shownNext;
        const pageSize = this.shownPageSize;
        const isBase = this.shownOptions === this.baseOptions;
        this.loadingMore = true;
        this.loadMoreError = null;
        this.render();
        try {
            // The next link already carries the filter, search term and ordering; it must keep its page size.
            const page = await this.data.loadOptions(this.optionsQuery(), "", pageSize, next);
            if (token !== this.searchToken) return;
            const seen = new Set(this.shownOptions.map((i) => i.id));
            const merged = this.shownOptions.concat(page.items.filter((i) => !seen.has(i.id)));
            this.shownOptions = merged;
            this.shownNext = page.nextLink;
            if (isBase) {
                this.baseOptions = merged;
                this.baseNext = page.nextLink;
            }
        } catch (error) {
            if (token !== this.searchToken) return;
            this.loadMoreError = `${this.t.loadMoreFailed} ${friendlyError(error, this.t, "read")}`;
            console.error(`[${CONTROL_NAME}] loading more records failed`, error);
        } finally {
            // A superseded request must not clear the flag of a newer one, but the view always re-renders.
            if (token === this.searchToken) this.loadingMore = false;
            this.render();
        }
    }

    // ---------------------------------------------------------------- rendering

    private render(): void {
        if (this.destroyed || !this.view) return;
        const engine = this.engine;
        if (engine) {
            const recordId = engine.getRecordId();
            if (engine.version !== this.renderedVersion || recordId !== this.renderedRecordId) {
                this.renderedVersion = engine.version;
                this.renderedRecordId = recordId;
                this.cachedSelected = engine.selected();
                // Show the "saving" look only for real writes, not for values waiting for a new record's first save.
                this.cachedPending = recordId ? engine.pendingIds() : new Set<string>();
            }
        } else if (this.cachedSelected.length || this.cachedPending.size) {
            this.cachedSelected = [];
            this.cachedPending = new Set<string>();
            this.renderedVersion = -1;
        }
        const t = this.t;
        const mode = this.context.mode;
        const config = this.config;
        const max = config?.maxSelections ?? 0;
        const maxReached = max > 0 && this.cachedSelected.length >= max;

        // Select all only appears when every matching row is loaded, the setting allows it, the list is within the
        // limit (0 = as many as one load holds, 500) and selecting them all stays within Maximum selections.
        const allLoaded = this.mode === "client" || (this.mode === "server" && !this.shownNext && this.searchTerm.trim() !== "");
        const limit = config && config.selectAllLimit > 0 ? config.selectAllLimit : CLIENT_MODE_LIMIT;
        let canSelectAll = allLoaded && !!config?.showSelectAll && this.shownOptions.length > 0 && this.shownOptions.length <= limit;
        if (canSelectAll && max > 0 && engine) {
            const extra = this.shownOptions.filter((i) => !engine.isSelected(i.id)).length;
            canSelectAll = engine.selectedCount() + extra <= max;
        }
        const note = max > 0 ? (maxReached ? t.maxReached(max) : t.maxNote(max)) : null;

        let hint: string | null = null;
        if (this.offline) hint = t.offline;
        else if (engine && !engine.getRecordId() && engine.hasPendingChanges() && !this.saveFirst) hint = t.heldHint;

        const canCreate = !!config?.allowCreate && !!this.rel?.targetQuickCreate && !maxReached;
        const fatalError = this.fatalError ?? (this.saveFirst ? t.saveFirst : null);
        // "Open selected records" needs the related table from the metadata, and isn't offered while the control can't work.
        const openRecords = !!config?.openRecords && !!this.rel && !fatalError;
        this.view.render({
            selected: this.cachedSelected,
            pending: this.cachedPending,
            options: this.shownOptions,
            optionsStatus: this.optionsStatus,
            optionsError: this.optionsError,
            hasMore: !!this.shownNext,
            loadingMore: this.loadingMore,
            loadMoreError: this.loadMoreError,
            canSelectAll,
            maxReached,
            note,
            ready: !!engine && this.selectedLoaded,
            disabled: mode.isControlDisabled || this.saveFirst || this.offline,
            label: mode.label || t.relatedRecords,
            placeholder: config?.placeholder ?? t.placeholder,
            error: this.error,
            hint,
            fatalError,
            createLabel: canCreate ? t.newRecord(this.rel!.targetDisplayName) : null,
            openOnClick: !!config?.openOnClick,
            openRecords,
            interceptLinks: openRecords && this.opensRecordsInApp(),
        });
    }
}

/** True when both lists hold the same records (in the same, sorted order). */
function sameIds(a: Item[], b: Item[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    return a.every((item, i) => item.id === b[i].id);
}

// Also expose the constructor as window.KV.NToNMultiSelect and register it by name. The platform normally loads
// this bundle itself; in environments that send the control to the form without its resources, the form library
// (formloader.js) loads it instead and checks these to see that the control is ready.
(function registerGlobally(): void {
    const w = window as unknown as {
        KV?: Record<string, unknown>;
        ComponentFramework?: { registerControl?: (name: string, ctor: unknown) => void };
    };
    w.KV = w.KV || {};
    w.KV.NToNMultiSelect = NToNMultiSelect;
    try {
        w.ComponentFramework?.registerControl?.(CONTROL_NAME, NToNMultiSelect);
    } catch {
        // ignore – the default lookup above still works
    }
})();
