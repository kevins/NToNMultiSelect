import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { DataverseClient, DataverseError, TimeoutError, friendlyError, isNetworkError, isPermissionError, isServerBusy } from "./src/dataverse";
import { FormBridge, SaveEventArgs, saveEventArgs } from "./src/formBridge";
import { HostField, SubmitMode, XrmPage, currentPage } from "./src/hostField";
import { resolveRelationship } from "./src/metadata";
import { COMMA_SEPARATOR, CopyWriter, NamesCopy, SEPARATOR, namesCopyFor, namesText } from "./src/namesCopy";
import { CLIENT_MODE_LIMIT, ListColumnsSetting, OptionsQuery, RelatedData, SERVER_PAGE_SIZE, isSearchable, linkTag } from "./src/relatedData";
import { Strings, stringsFor } from "./src/strings";
import { LinkChange, SyncEngine } from "./src/syncEngine";
import { Item, OptionsMode, RelationshipInfo, compareItems, isGuid, normalizeId } from "./src/types";
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
/** A save that carries held changes reports within this time, or they count as unsaved again (see onHeldSave). */
const SAVE_REPORT_MS = 60_000;
/**
 * "Write the links" = Before: whether a save with `saveMode` (getSaveMode) can wait for the links and then be made
 * again. Only the user's own save commands can: Save (1, its button or Ctrl+S), Save & Close (2) and Save & New (59),
 * each known by the click or key that started it (see watchUserSaves). Any other save goes ahead, and the links are
 * written right after it, as with After:
 * - a save a script starts (formContext.data.save(), whatever save mode it passes: the mode only describes the save,
 *   and the script waits for the save to go on, to close the form or call an action);
 * - the auto-save (70), which a script's save with that mode can't be told apart from (owner, 2026-11-06);
 * - a save the form makes because the user leaves the record (auto-save when leaving, also mode 2; "Save and continue"
 *   in the form's prompt): cancelling it shows the form's "Unsaved changes" prompt for a moment and loses where the
 *   user was going (measured live);
 * - a command's save (Deactivate, Assign, Mark complete, Send...), which the control couldn't make again.
 * Decided once per save: the first field of the form whose handler asks (`asker`, its HoldState) uses up the user's click
 * or key, and the other fields of the form get the same answer for that save (see saveDecision). A field that asks again
 * asks for another save.
 */
function savesBefore(saveMode: number, asker: object): boolean {
    if (saveDecision?.saveMode === saveMode && !saveDecision.askers.has(asker)) {
        saveDecision.askers.add(asker);
        return saveDecision.before;
    }
    let active: Element | null = null;
    try {
        active = document.activeElement;
    } catch {
        // No document: not in a browser.
    }
    const intent = userSave;
    // The form's prompt ("Save and continue") is a dialog.
    const inDialog = !!active?.closest?.('[role="dialog"], [role="alertdialog"]');
    const kind = USER_SAVE_MODES[saveMode];
    const before = !inDialog && !!kind && intent?.kind === kind && Date.now() - intent.at < USER_SAVE_MS;
    // Used up: a save a script starts after it (even with the focus still on the Save button) goes ahead.
    if (before) userSave = null;
    const decision = { saveMode, before, askers: new Set([asker]) };
    saveDecision = decision;
    // Every OnSave handler of a save runs before this (measured live: they run one after the other, at once).
    setTimeout(() => {
        if (saveDecision === decision) saveDecision = null;
    }, 0);
    return before;
}

/** The user's save commands (see watchUserSaves), by the save mode their save has. */
type UserSaveKind = "save" | "saveAndClose" | "saveAndNew";
const USER_SAVE_MODES: Record<number, UserSaveKind | undefined> = { 1: "save", 2: "saveAndClose", 59: "saveAndNew" };
/** A save starts this soon after the user's click or key that started it (it starts within milliseconds, measured). */
const USER_SAVE_MS = 2000;
/** The user's last save command, until a save uses it up, the user does something else, or USER_SAVE_MS passes. */
let userSave: { kind: UserSaveKind; at: number } | null = null;
interface SaveDecision {
    saveMode: number;
    before: boolean;
    askers: Set<object>;
}
/** The answer of savesBefore for the save whose OnSave handlers are running, and the fields that asked it. */
let saveDecision: SaveDecision | null = null;
let watchingUserSaves = false;

/**
 * The save command a click or a key of the user is, if any: the command bar's Save, Save & Close or Save & New (by
 * their data-id, measured live), or Ctrl+S. (A click on the save status in the form's header doesn't save, measured.)
 */
function userSaveKind(event: Event): UserSaveKind | null {
    const key = event as KeyboardEvent;
    if (event.type === "keydown") {
        if ((key.ctrlKey || key.metaKey) && !key.altKey && typeof key.key === "string" && key.key.toLowerCase() === "s") return "save";
        // Enter or Space on a command button that has the focus (the button's own click follows).
        if (key.key !== "Enter" && key.key !== " ") return null;
    }
    let target: Element | null = null;
    try {
        target = (event.target as Element | null)?.closest?.("[data-id]") ?? null;
    } catch {
        // Not an element.
    }
    // Only the command bar's own buttons, "<table>|NoRelationship|Form|Mscrm.Form.<table>.Save" (measured live): the
    // button of a custom command whose id merely holds these words starts a script's save, which goes ahead (safety
    // review C5).
    const command = /(?:^|\|)Mscrm\.Form\.[^.|]+\.(SaveAndClose|SaveAndNew|Save)\b/.exec(target?.getAttribute("data-id") ?? "")?.[1];
    if (command === "SaveAndClose") return "saveAndClose";
    if (command === "SaveAndNew") return "saveAndNew";
    if (command === "Save") return "save";
    return null;
}

/**
 * Notes the user's save commands, for savesBefore: once for the page, on the window, before the page's own handlers of
 * the same event can stop it. Nothing is changed or stopped. Any other click or key forgets a command not used yet.
 */
function watchUserSaves(): void {
    if (watchingUserSaves) return;
    watchingUserSaves = true;
    try {
        const note = (event: Event) => {
            const kind = userSaveKind(event);
            userSave = kind ? { kind, at: Date.now() } : null;
        };
        for (const type of ["click", "keydown"]) window.addEventListener(type, note, true);
    } catch {
        // No window: not in a browser.
    }
}

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
    /** "Names separator": between the names in the host column, "; " (default) or ", " (see namesSeparator). */
    namesSeparator: string;
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
    /**
     * "Load the list": "atFormLoad" (default) loads the records that can be picked in the background as the form opens,
     * so the list opens at once; "whenOpened" waits until the list is opened or the user types (see warmOptions).
     */
    loadList: "atFormLoad" | "whenOpened";
    /** "Selection on the form": what the form is told about the selection, through the host column (see syncHost). */
    formSelection: FormSelection;
    /** "Save the selection": each change at once, or held until the record is saved (see holdsWrites). */
    saveMode: SaveMode;
    /** "Write the links": with saveMode "withRecord", after the record's save or before it (see onFormSave). */
    linkTiming: LinkTiming;
    /** "Columns under each option", "Columns to show" and "Search the columns under each option". */
    listColumns: ListColumnsSetting;
}

type FormSelection = "no" | "event";
const FORM_SELECTIONS: Record<string, FormSelection> = { "1": "event" };
type SaveMode = "atOnce" | "withRecord";
const SAVE_MODES: Record<string, SaveMode> = { "1": "withRecord" };
type LinkTiming = "after" | "before";
const LINK_TIMINGS: Record<string, LinkTiming> = { "1": "before" };
const LIST_COLUMN_SOURCES: Record<string, ListColumnsSetting["source"]> = { "1": "typed", "2": "view" };

interface ContextInfo {
    entityId?: string;
    entityTypeName?: string;
}

/**
 * "Save the selection" = With the record: the changes held for a saved record's save (see SyncEngine.hold), and what
 * its saves do with them. The instance showing the record keeps it; when the instance goes while a save that carries
 * changes is under way (Save & Close, or auto-save when leaving), it is kept until that save is done.
 */
interface HoldState {
    engine: SyncEngine;
    bridge: FormBridge;
    recordId: string;
    host: HostField;
    timing: LinkTiming;
    /**
     * "Copy names into the host column" = Yes: the record's save stores the names with it (they are what the column is
     * kept for), so the form compares the column with the saved names afterwards and any later change shows as unsaved.
     * Otherwise the column is never saved by the form (see onHeldSave).
     */
    savesNames: boolean;
    /**
     * The save under way (its OnSave ran) and the changes it carries, until its OnPostSave or, when the form has
     * nothing else to send, until just after OnSave: it then sends nothing and reports no OnPostSave. `keepOne`: the
     * column was required then (see SyncEngine.release). `names`: what the column held then, if the save stores it.
     */
    saving: { changes: Map<string, LinkChange>; keepOne: boolean; names?: string | null; timer: ReturnType<typeof setTimeout> } | null;
    /**
     * With the app's "Async save handler" on: a save that hadn't reported after SAVE_REPORT_MS, still perhaps waiting
     * for the promise of another OnSave handler (a dialog left open). Its OnPostSave, if it comes, still writes what it
     * carried; meanwhile the column stays out of it (see saveNotReported, syncHost).
     */
    lateSaving?: NonNullable<HoldState["saving"]>;
    /**
     * "Write the links" = Before the record is saved: the save cancelled while the control checks that no handler cancels
     * it and its links are written, with the other fields of the form whose changes it carries (see BeforeRound).
     */
    before: BeforeRound | null;
    /** The next OnSave is the save the control made again once the links were written: it goes ahead. */
    pass: boolean;
    /** The names that save carried (see savesNames), once its OnSave has run. */
    passNames?: string | null;
    /**
     * The names the record's last save stored (see savesNames), until the links it carried are written: if the links
     * end up otherwise (a change undone while the save was on its way, a refused link), the names copy puts them right.
     */
    storedNames?: string | null;
    /** The instance holding the changes; null once it is gone (see retireEngine). */
    owner: NToNMultiSelect | null;
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
    /** A write failed in a way that may still have saved it (see mayHaveSaved): the copy then reads the saved links. */
    unknown: boolean;
    /**
     * "Save the selection" = With the record: the record's save stored the names the form showed, so once the links are
     * written the copy checks them against the links saved on the server (see onSettled).
     */
    namesStored?: boolean;
    /**
     * "Copy names into the host column", or null when it's off. It was set up with the record's table, the host
     * column and its length while the control was still there.
     */
    copy: HostCopy | null;
    /** With the record: the instance's held changes, kept for a save under way (see letGoOfHeld, parkLate). */
    kept?: HoldState;
}
const detached = new Map<SyncEngine, Detached>();

/** A With the record field whose changes wait for a save of its form, as its OnSave handler saw that save. */
interface HeldSaveMember {
    control: NToNMultiSelect;
    state: HoldState;
    saving: NonNullable<HoldState["saving"]>;
    args: SaveEventArgs;
    /** The form had nothing left to send once this field's handler had run. */
    sendsNothing: boolean;
}
/** The fields whose changes wait for the save under way, by the form's entity (see onHeldSave). */
const heldSaves = new Map<object, HeldSaveMember[]>();

/**
 * "Write the links" = Before the record is saved: a save of a form whose With the record fields write their links first
 * (see onHeldSave). A handler that a script added to OnSave after a field's last change runs after that field's handler,
 * and can still cancel the save. So the first field of the save adds a handler of its own, which runs after the other
 * handlers of that save (measured live: a handler added while a save's handlers run runs in that save, after them). Only
 * there is it known whether one of them cancelled the save: if none did, that handler cancels it, the fields' links are
 * written, then the save is made again (see lastWord, finishBefore); if one did, nothing is written. The limit: a
 * handler that another handler adds to OnSave during the same save, after this one was added, runs after it, so its
 * cancel comes once the links are on their way. Handlers registered when the form loads, or added before the save, are
 * all seen.
 */
interface BeforeRound {
    /** The form's entity (see FormBridge.followedEntity). */
    key: object;
    /** The mode of the save to make again: Save, Save & Close, Save & New, auto-save. */
    saveMode: number;
    /** Collecting the fields of the save (its OnSave handlers), then writing their links. */
    phase: "collecting" | "writing";
    members: BeforeMember[];
    /** Takes the round's handler (see lastWord) off the form again, once the save's handlers have run. */
    removeLast: (() => void) | null;
    /** While writing: the fields whose links are still being written, those whose writes failed, and whether any did. */
    pending: Set<HoldState>;
    failedMembers: Set<HoldState>;
    failed: boolean;
    /** While writing: a save of the user's that the round may take (see absorb), until its handlers have all run. */
    absorbing: AbsorbedSave | null;
    /**
     * The save the round took last (see take), as savesBefore decided it for the fields: a Before field whose handler
     * runs later in that save joins at once (see absorb). That happens on a client that can't add the round's handler
     * during the save, where the round decides at once.
     */
    taken: SaveDecision | null;
}

/**
 * The user's save command while a round writes its links (see onHeldSave): the Save & Close or Save & New it asks for,
 * and the Before fields of the form whose changes it would add to the round. The round's handler for that save decides,
 * after the other handlers of the save (see absorbSave): taken (cancelled, and made again by the round) only when none
 * of them cancelled it.
 */
interface AbsorbedSave {
    mode?: number;
    joiners: BeforeMember[];
    /** The round's handler for that save, taken off once the save's handlers have run (see afterAbsorbing). */
    remove: (() => void) | null;
    /** The event arguments of the first field that saw that save (see afterAbsorbing). */
    args: SaveEventArgs;
}
interface BeforeMember {
    control: NToNMultiSelect;
    state: HoldState;
    /** The changes the save carries, and whether the column was required then (see SyncEngine.release). */
    changes: Map<string, LinkChange>;
    keepOne: boolean;
}
/** The rounds under way, by the form's entity. */
const beforeRounds = new Map<object, BeforeRound>();

/**
 * Picks made on an unsaved record by a control instance that was destroyed while the form stayed open (for example
 * a business rule hid and showed the field). The next instance on the same form adopts them, so the old instance
 * never writes stale picks on its own. Keyed by the form's entity object, then by relationship and host column.
 */
interface Orphan {
    engine: SyncEngine;
    bridge: FormBridge;
    /**
     * Until when the form's first save under way counts as under way (see newSaveDeadline), as its instance noted it, or
     * as its own OnSave handler did for a save that started after the instance went (see onNewRecordSave); 0 for none.
     */
    saveDeadline: number;
    release(): void;
}
const orphans = new WeakMap<object, Map<string, Orphan>>();
/** The orphan an engine belongs to (see onNewRecordSave). */
const orphanOf = new WeakMap<SyncEngine, Orphan>();

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

/**
 * Removals held back on a required field (see NToNMultiSelect.holdBackLast), by record and relationship (recordKey).
 * Every instance on the page that shows the record leaves those values out of its field and of the host column, and the
 * instance that holds them sends them once it may.
 */
interface Held {
    item: Item;
    holder: NToNMultiSelect;
    /**
     * Set while the removal waits for a read of the saved links before it may go (see holdBackLast): how many reads its
     * holder had done then (see readsDone).
     */
    readsAtHold?: number;
}
const heldRemovals = new Map<string, Map<string, Held>>();
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

async function trackCopy<T>(request: Promise<T>): Promise<T> {
    copiesWriting++;
    try {
        return await request;
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

/**
 * A write that failed this way may still have been saved: the connection dropped or the request timed out after it
 * reached the server, or a gateway or server error answered. Only a read of the saved links tells.
 */
function mayHaveSaved(error: unknown): boolean {
    return isNetworkError(error) || error instanceof TimeoutError || (error instanceof DataverseError && error.status >= 500);
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
    /**
     * window.Xrm when the control was made, that of its own form: the host column and every bridge read the form from it,
     * as window.Xrm is that of a dialog or quick create form while one is on top (see HostField, FormBridge).
     */
    private xrmPage: XrmPage | null = null;
    /** The host column on the control's own form (see syncHost). */
    private hostField: HostField | null = null;
    /** "Save the selection" = With the record, on a saved record whose saves are followed (see startHolding). */
    private hold: HoldState | null = null;
    /** A save stored the names while changes waited for it, and holding stopped before its links were written (see stopHolding). */
    private checkNamesLater = false;
    /** The warning that the host column is the record's own name was given (see copiesNames). */
    private warnedNameColumn = false;
    /**
     * With the record: a new record's save is under way (its OnSave ran), so the column isn't an unsaved change (see
     * onNewRecordSave).
     */
    private newSaveInFlight = false;
    /** Until when the new record's save under way counts as under way (see followNewRecordSave). */
    private newSaveDeadline = 0;
    /** The new record's latest save (see onNewRecordSave): the checks of an earlier one leave it alone. */
    private newSaveAttempt = 0;
    private newSaveTimer: ReturnType<typeof setTimeout> | undefined;
    /** With the record: the control wasn't on the page yet when the saved record's saves were to be followed. */
    private holdWhenPlaced = false;
    /**
     * The record ("" for a new one) whose names syncHost last worked out, those names and their records (sorted ids): a
     * later difference of the records is a change.
     */
    private hostSyncedFor: string | null = null;
    private hostText: string | null = null;
    private hostIds = "";
    /** syncHost last kept the names while writes were on their way: once they are done, OnChange answers what was seen. */
    private hostWaited = false;
    /** Subgrids hidden by "Hide related subgrids", shared with every bridge this instance makes (see FormBridge). */
    private readonly hiddenGrids = new Set<string>();

    // Options (menu) state.
    private mode: OptionsMode | null = null;
    private allOptions: Item[] = [];
    private allOptionsKeys: string[] = [];
    /**
     * "Columns under each option" found columns to show for the list (null: not loaded yet). Without any, the list looks
     * as with None (see render).
     */
    private columnsFound: boolean | null = null;
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
    /** A write of the current batch failed in a way that may still have saved it (see mayHaveSaved). */
    private batchUnknown = false;
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
    /**
     * Another instance on the page has changed the links this one shows since it last read them (see markPeersStale):
     * until it has read them again, it leaves the host column to the instances that know (see syncHost).
     */
    private hostStale = false;
    /** How often hostStale was set: a read that began before the last time doesn't clear it. */
    private staleMarks = 0;
    /** This instance has changed links since its last batch was done, so the other instances were marked stale. */
    private markedPeers = false;
    /** Reads of the saved links this instance has done (see loadSelected): a removal waiting for one counts on it. */
    private readsDone = 0;

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
    /** The selected records that are saved (see SyncEngine.savedSelected), kept with cachedSelected (see syncHost). */
    private cachedSaved: Item[] = [];
    private cachedPending = new Set<string>();
    /** The places taken toward Maximum selections (see SyncEngine.occupiedCount), kept with cachedSelected. */
    private cachedOccupied = 0;
    /** Records that take a place without being selected (see SyncEngine.placeHolders), kept with cachedSelected. */
    private cachedHeld = new Set<string>();

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
    /** Re-reads tried again in a row because a place is held by an add whose outcome isn't known (see loadSelected). */
    private resyncRetries = 0;
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

    constructor() {
        // A later copy of this bundle on the page makes its instances with the first copy's class (see firstCopy).
        if (firstCopy) return new firstCopy();
    }

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
        // Now, while window.Xrm is that of the control's own form (see HostField).
        this.xrmPage = currentPage();
        const host = (context.parameters.value as unknown as { attributes?: { LogicalName?: string } })?.attributes?.LogicalName;
        const table = (this.contextInfo(context).entityTypeName ?? "").toLowerCase();
        this.hostField = host && table ? new HostField(this.xrmPage, table, host) : null;
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
        if (this.holdWhenPlaced && this.view.element().isConnected && this.engine && this.bridge) {
            // With the record: the control is on the page now, so its record's saves can be followed.
            this.holdWhenPlaced = false;
            const recordId = this.engine.getRecordId();
            if (recordId) this.startHolding(this.engine, this.bridge, recordId);
        }
        // Grids can register after the control, so both are applied again on every update.
        const linkedRecordId = this.engine?.getRecordId() ?? null;
        this.applyHideSubgrids(linkedRecordId);
        this.bridge?.watchSubgrids(linkedRecordId, this.onSubgridLoad);
        this.render();
    }

    public getOutputs(): IOutputs {
        // The form never gets a value to save from this control, so it is never made dirty by it: the picks are shown in
        // the host column through the form's own API, never to be saved (see syncHost), and "Copy names into the host
        // column" writes to the record itself (see updateSummary).
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
        clearTimeout(this.newSaveTimer);
        this.searchAbort?.abort();
        window.removeEventListener("online", this.onOnline);
        liveControls.delete(this);
        this.view.destroy();
        this.retireEngine();
        this.hostField?.dispose();
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
            namesSeparator: String(p.namesSeparator?.raw ?? "0") === "1" ? COMMA_SEPARATOR : SEPARATOR,
            allowCreate: String(p.allowCreate?.raw ?? "0") === "1",
            showSelectAll: String(p.showSelectAll?.raw ?? "1") !== "0",
            // 0 means "as many as the list holds"; nothing above that is ever offered.
            selectAllLimit: Math.min(wholeNumber(p.selectAllLimit?.raw, DEFAULT_SELECT_ALL_LIMIT) || CLIENT_MODE_LIMIT, CLIENT_MODE_LIMIT),
            maxSelections: wholeNumber(p.maxSelections?.raw, 0),
            searchMode: String(p.searchMode?.raw ?? "0") === "1" ? "contains" : "startswith",
            openOnClick: String(p.openOnClick?.raw ?? "0") === "1",
            openRecords: String(p.openRecords?.raw ?? "0") === "1",
            loadList: String((p as unknown as { loadList?: { raw?: unknown } }).loadList?.raw ?? "0") === "1" ? "whenOpened" : "atFormLoad",
            formSelection: FORM_SELECTIONS[String(p.formSelection?.raw ?? "0")] ?? "no",
            saveMode: SAVE_MODES[String((p as unknown as { saveMode?: { raw?: unknown } }).saveMode?.raw ?? "0")] ?? "atOnce",
            linkTiming: LINK_TIMINGS[String((p as unknown as { linkTiming?: { raw?: unknown } }).linkTiming?.raw ?? "0")] ?? "after",
            listColumns: this.readListColumns(p as unknown as Partial<Record<"listColumns" | "listColumnNames" | "searchListColumns", { raw?: unknown }>>),
        };
    }

    /** "Columns under each option" (None by default: the names only, as today), the typed names and the search switch. */
    private readListColumns(p: Partial<Record<"listColumns" | "listColumnNames" | "searchListColumns", { raw?: unknown }>>): ListColumnsSetting {
        const source = LIST_COLUMN_SOURCES[String(p.listColumns?.raw ?? "0")] ?? "none";
        const names = String(p.listColumnNames?.raw ?? "")
            .split(/[,;]/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        return { source, names: source === "typed" ? names : [], search: source !== "none" && String(p.searchListColumns?.raw ?? "0") === "1" };
    }

    private applyConfig(context: ComponentFramework.Context<IInputs>): void {
        const config = this.readConfig(context);
        this.config = config;
        const relationshipKey = config.relationshipName.toLowerCase();
        const optionsKey = JSON.stringify([config.filter, config.view, config.fetchXml, config.showInactive, config.searchMode, config.listColumns]);
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
        // The record this instance worked on ("" for a new one), also while a new record's picks are still being linked.
        const previous = this.engine ? (this.engine.getRecordId() ?? "") : this.hostSyncedFor;
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
        // The links are read again from the start (after the other instances' writes, see peersIdle).
        this.hostStale = false;
        this.error = null;
        this.batchErrors = 0;
        this.batchUnknown = false;
        this.resyncRetries = 0;
        // A new record's create never sends the column (see onNewRecordSave): nothing is stored there yet, whatever the
        // form shows (an instance made again on an unsaved form finds the picks' names there, see adoptOrphan).
        this.loadedCopy = this.recordIdFrom(context) ? context.parameters.value?.raw || null : null;
        // Another record: its first names are no change, also after a new record the form didn't save (see syncHost).
        if ((this.recordIdFrom(context) ?? "") !== previous) this.hostSyncedFor = null;
        this.hostWaited = false;
        this.newSaveInFlight = false;
        clearTimeout(this.newSaveTimer);
        this.holdWhenPlaced = false;
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
            // The form is read from the control's own page, also when a bridge is made later on, while a dialog or a quick
            // create form of the same table is on top (a slow first load, the retry after a passing problem, reconnecting).
            const bridge = new FormBridge(entityName, rel.schemaName, config.subgrids, this.view.element(), rel.selfReferencing ? rel.navigationProperty : null, this.hiddenGrids, this.xrmPage);
            const engine: SyncEngine = new SyncEngine(
                {
                    associate: (recordId, targetId) => data.associate(recordId, targetId, this.linkTag(rel, recordId)),
                    disassociate: (recordId, targetId) => data.disassociate(recordId, targetId, this.linkTag(rel, recordId)),
                    // With the record, a required column's save that leaves it one saved value reads the links first (see
                    // SyncEngine.release), with the same read as At once's check (see holdBackLast).
                    readSaved: (recordId) => data.loadSelected(recordId),
                },
                {
                    onChange: () => {
                        if (engine === this.engine) this.render();
                    },
                    onSettled: (changed) => this.onSettled(engine, changed),
                    onError: (item, operation, error) => this.onWriteError(engine, item, operation, error),
                    // With the record, on a passing problem the change waits for the next save; not once the instance is
                    // gone, since nothing could save it then.
                    holdsAfterError: (error) => engine === this.engine && !this.destroyed && isTransient(error),
                    onCheckFailed: (changes, error) => this.onCheckFailed(engine, changes, error),
                },
            );
            this.engine = engine;
            this.bridge = bridge;
            liveEngines.add(engine);
            installUnloadGuard();

            // Use the latest context: the record may have been saved while the metadata was loading.
            const recordId = this.recordIdFrom(this.context);
            // Before the links are read, so that replaced subgrids disappear as early as possible.
            this.applyHideSubgrids(recordId);
            if (recordId) {
                engine.setRecordId(recordId);
                this.releaseAbandonedOrphan(bridge, recordId);
                if (this.copiesNames(rel)) {
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
                if (config.saveMode === "withRecord") {
                    // Once the control is placed, the form it is on is known (see startHolding).
                    await bridge.waitUntilPlaced();
                    if (token !== this.initToken) return;
                    this.startHolding(engine, bridge, recordId);
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
                const saveEvents = { onSave: (args: SaveEventArgs) => this.onNewRecordSave(engine, args), onFailed: () => this.onNewRecordSaveFailed(engine) };
                if (!bridge.onPostSave((id) => this.onRecordSaved(engine, bridge, id, schemaName, data), saveEvents)) {
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

    /**
     * Loads the list in the background so the first open is instant (not for read-only or offline controls). With "Load
     * the list" = When the list is first opened, nothing is loaded now: opening the list or typing in the box loads it
     * (see ensureOptions), so a form on which nobody picks sends no list request.
     */
    private warmOptions(token: number): void {
        if (this.saveFirst || this.offline || this.readOnly() || this.config?.loadList === "whenOpened") return;
        setTimeout(() => {
            if (token === this.initToken && !this.destroyed) void this.ensureOptions();
        }, 50);
    }

    /**
     * Lets the current engine go. If it still has changes to write, or writes on their way, for a saved record, it
     * keeps running on its own (see Detached), and so does one whose save's changes still wait for the read of the saved
     * links (see SyncEngine.release), even when the user has undone them since. Unsaved picks on a new record become an
     * orphan the next instance can adopt, unless `discardHeld` is set (the control has moved on to another record, so
     * they must not follow).
     */
    private retireEngine(discardHeld = false): void {
        this.handOverHeld();
        const engine = this.engine;
        const bridge = this.bridge;
        const copy = this.copy;
        this.engine = null;
        this.bridge = null;
        // A copy that is still on its way reports a failure in an app notification from now on (see onCopyFailed).
        this.copy = null;
        if (!engine || !bridge) return;
        bridge.unwatchSubgrids();
        const hold = this.hold;
        this.hold = null;
        const own = hold?.engine === engine ? hold : null;
        // With the record: a save under way (or that reported late) carries changes of this field. Its OnPostSave writes
        // them and stores names that the copy checks, also when the changes were undone since (see onHeldPostSave): the
        // engine stays for it, kept (see letGoOfHeld, dropKept; safety review of the S01 fix).
        const savePending = !!own && !!(own.saving ?? own.lateSaving);
        // Names an earlier save stored, whose check waited for changes this field lets go of now (see onSettled).
        const namesOwed = own?.storedNames !== undefined;
        // Write the links = Before: this field's links were written for a round that ends now without its save made again
        // (see letGoOfHeld), which would have stored their names (see onSettled): the copy writes them, as abandonRound
        // does for the fields that stay (links still on their way: see finishDetached).
        const roundNames = !!own?.before && own.before.phase === "writing" && own.savesNames && !own.before.failedMembers.has(own);
        if (own) this.letGoOfHeld(own);
        // (On a new record, what its first save under way carries counts too, even a pick undone since: see adoptOrphan.)
        // With the record, the released work counts too: the read of the saved links before a required column's last
        // removals, also when those were undone since (a rule hid the field meanwhile). Once it is answered, the copy
        // checks the names that save stored against the saved links (see finishDetached), as it would for this instance
        // (re-audit S01).
        if (!savePending && !engine.hasPendingChanges() && !engine.isBusy() && !engine.hasReleasedWork() && engine.carriedByCreate().length === 0) {
            // Nothing is left to write, but the check of names a save stored is still due (it waited for changes let go of
            // now), or a Before round's names are no save's any more: the copy makes the check, or writes them.
            const recordId = engine.getRecordId();
            if ((namesOwed || roundNames) && recordId && this.copiesNames()) {
                const names = copy ?? this.startCopy(recordId, this.recordKey(recordId), this.data);
                if (namesOwed) names?.names.refresh(names.writer, true);
                else names?.names.update(engine.selected(), names.writer);
            }
            liveEngines.delete(engine);
            engine.dispose();
            bridge.dispose();
            return;
        }
        const recordId = engine.getRecordId();
        if (recordId) {
            // Writes are queued or running (e.g. the user closed the record right after Select all), or a save's changes
            // wait for the read of the saved links: let them finish, and the host column copy after them.
            const key = this.recordKey(recordId);
            detached.set(engine, {
                key,
                bridge,
                label: this.context.mode.label || this.t.relatedRecords,
                t: this.t,
                failures: 0,
                firstError: "",
                // A write of the batch that failed but may have been saved: the copy reads the saved links at the end.
                unknown: this.batchUnknown,
                namesStored: namesOwed,
                kept: own ?? undefined,
                copy: this.copiesNames() ? (copy ?? this.startCopy(recordId, key, this.data)) : null,
            });
            this.batchUnknown = false;
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
            saveDeadline: this.newSaveInFlight ? this.newSaveDeadline : 0,
            release: () => {
                if (byKey.get(key) === orphan) byKey.delete(key);
                liveEngines.delete(engine);
                engine.dispose();
                bridge.dispose();
            },
        };
        byKey.set(key, orphan);
        orphanOf.set(engine, orphan);
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

    /**
     * Takes over picks left by a previous instance of this control on the same unsaved form (see `orphans`), and the
     * form's first save if it is still under way (the field was made again during it: a rule or a script hid and showed
     * it). This instance then follows that save as if it had started it, and links the picks once the record exists;
     * without it, the record's id would look like another record's and the picks would be let go (fifth audit).
     */
    private adoptOrphan(): void {
        const entity = this.bridge?.trackedEntity();
        if (!entity || !this.rel || !this.engine || !this.bridge) return;
        const orphan = orphans.get(entity)?.get(this.orphanKey());
        if (!orphan || orphan.engine.getRecordId()) return;
        const picks = orphan.engine.selected();
        const carried = orphan.engine.carriedByCreate();
        const saving = this.bridge.takeOverSave(orphan.bridge);
        orphan.release();
        if (saving && this.config?.saveMode === "withRecord") {
            // What that save carries, as the previous instance noted it: changes made since wait for the next save, and a
            // carried pick undone since is linked all the same, its removal waiting (see SyncEngine.holdForCreate). The save
            // counts as under way for the time it has left (see onNewRecordSaveLate).
            this.engine.setMany(carried, true);
            this.followNewRecordSave(this.engine, orphan.saveDeadline);
            this.engine.setMany(picks, true);
            const kept = new Set(picks.map((item) => item.id));
            this.engine.setMany(carried.filter((item) => !kept.has(item.id)), false);
        } else if (picks.length) {
            this.engine.setMany(picks, true);
        }
    }

    /**
     * Waits for writes to this record by other instances, so that a read that follows includes them: those that are
     * already gone (e.g. the record was just reopened) and those on the page (another copy of the field).
     */
    private async peersIdle(recordId: string): Promise<void> {
        const key = this.recordKey(recordId);
        const running = [...detached].filter(([engine, d]) => d.key === key && engine !== this.engine).map(([engine]) => engine.whenIdle());
        for (const control of liveControls) {
            const shown = control.engine?.getRecordId();
            if (control !== this && control.engine && shown && control.recordKey(shown) === key) running.push(control.engine.whenIdle());
        }
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
            const marks = this.staleMarks;
            const items = await data.loadSelected(recordId);
            if (token !== this.initToken || engine !== this.engine) return false;
            if (engine.version !== version || engine.isBusy()) {
                // The user changed something during the read; read again once those writes are done.
                this.scheduleResync();
                return true;
            }
            const before = engine.selected();
            engine.setConfirmed(items);
            this.readsDone++;
            // Read once the other instances' writes were done, and none of them has changed the links since.
            if (this.staleMarks === marks) this.hostStale = false;
            this.resyncRetries = 0;
            // The message of an earlier read that failed is out of date now (another message stays).
            if (this.error?.startsWith(this.t.loadSelectedFailed)) this.error = null;
            // Links changed elsewhere (a subgrid, another tab or user): a read-only field shows them but leaves the host
            // column alone, as its user can't edit it (the names copy plug-in, or the next change where the field can be
            // edited, copies them; safety review C4). Its own changes still finish with their copy (see onSettled).
            if (isResync && !this.readOnly() && !sameIds(before, engine.selected())) {
                this.updateSummary();
            }
            this.render();
            return true;
        } catch (error) {
            if (token !== this.initToken) return false;
            this.lastLoadError = error;
            this.error = `${this.t.loadSelectedFailed} ${friendlyError(error, this.t, "read")}`;
            console.error(`[${CONTROL_NAME}] loading related records failed`, error);
            // A place held by an add whose outcome isn't known is only freed by a read of the saved links: while there
            // is one, the read is tried again a few times (as the first load is).
            if (isResync && engine === this.engine && (engine.hasUncertain() || this.checksPending()) && this.resyncRetries < LOAD_RETRY_DELAYS_MS.length) {
                const delay = LOAD_RETRY_DELAYS_MS[this.resyncRetries++];
                clearTimeout(this.resyncTimer);
                this.resyncTimer = setTimeout(() => {
                    if (!this.destroyed && token === this.initToken) void this.loadSelected(token, true);
                }, delay);
            }
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
                const engine = this.engine;
                const bridge = this.bridge;
                const recordId = engine?.getRecordId();
                if (engine && bridge && recordId && this.config?.saveMode === "withRecord") this.startHolding(engine, bridge, recordId);
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
        // What the column showed on the unsaved form, and what its OnChange saw, now belong to the record (see syncHost):
        // before the engine gets the id, since with no picks to link it draws the field at once.
        if (engine === this.engine && !this.destroyed) this.hostField?.saved(recordId);
        // An instance that went during the save (a rule hid the field): nothing waits for a next save of it, so the picks
        // made during the save are written with the others, and a carried pick undone since isn't written at all (see
        // SyncEngine.holdForCreate). Before the engine gets the id, which starts the writes.
        if ((engine !== this.engine || this.destroyed) && engine.isHolding()) engine.stopHolding();
        engine.setRecordId(recordId);
        if (engine.hasPendingChanges()) liveEngines.add(engine);
        if (engine === this.engine && !this.destroyed) {
            clearTimeout(this.newSaveTimer);
            this.newSaveInFlight = false;
            // With the record: the picks of the first save are being linked, and later changes wait for the next save.
            this.startHolding(engine, bridge, recordId);
            // The changes can't wait for a save here after all (see startHolding): those made during the first save are
            // written at once too.
            if (this.hold?.engine !== engine && engine.isHolding()) engine.stopHolding();
            bridge.watchSubgrids(recordId, this.onSubgridLoad);
            // The create may have made links of its own (a plug-in, or the record was created from a related
            // record's subgrid): read them once the picks are written (loadSelected waits for that).
            this.scheduleResync();
            this.render();
        } else if (!engine.hasPendingChanges() && !engine.isBusy()) {
            // An orphan with nothing to write (a carried pick undone since, see above) goes now: no write will settle it.
            liveEngines.delete(engine);
            engine.dispose();
            bridge.dispose();
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
                unknown: false,
                copy: this.copiesNames(data?.rel ?? this.rel) ? this.startCopy(recordId, key, data) : null,
            });
        }
    }

    /** Reports a failed write; returns whether it may have been saved all the same (see mayHaveSaved). */
    private onWriteError(engine: SyncEngine, item: Item, operation: "add" | "remove", error: unknown): boolean {
        console.error(`[${CONTROL_NAME}] ${operation} failed for ${item.id}`, error);
        const reason = friendlyError(error, this.t, "change");
        // Every queued change would fail the same way (no permission, offline, server busy): drop them now and count
        // them as failed, instead of sending them one by one. While changes wait for the record's save (With the record),
        // those of a passing problem (offline, busy, too slow) wait for the next save instead: the form shows them as
        // unsaved again.
        const rehold = engine === this.engine && engine.isHolding() && isTransient(error);
        const cancelled = stopsBatch(error) ? engine.cancelQueued(rehold) : 0;
        const dropped = rehold ? 0 : cancelled;
        if (engine !== this.engine) {
            const away = detached.get(engine);
            if (away) {
                away.failures += 1 + dropped;
                if (!away.firstError) away.firstError = reason;
                if (mayHaveSaved(error)) away.unknown = true;
            }
            return mayHaveSaved(error);
        }
        if (mayHaveSaved(error)) this.batchUnknown = true;
        this.batchErrors += 1 + dropped;
        if (this.batchErrors === 1) {
            this.batchFirstError = reason;
            this.error = `${operation === "add" ? this.t.addFailed(item.name) : this.t.removeFailed(item.name)} ${reason}`;
        } else {
            if (this.batchErrors === 1 + dropped) this.batchFirstError = reason;
            this.error = `${this.t.manyFailed(this.batchErrors)} ${this.batchFirstError}`;
        }
        this.render();
        return mayHaveSaved(error);
    }

    /**
     * The read of the saved links that a required column's last removals waited for failed (see SyncEngine.release):
     * the save's changes weren't written. Reported like failed writes, so a save that writes its links first isn't made
     * again (see onSettled), with the existing messages ("Couldn't remove ...").
     */
    private onCheckFailed(engine: SyncEngine, changes: { item: Item; change: LinkChange }[], error: unknown): void {
        console.error(`[${CONTROL_NAME}] reading the saved links before ${changes.length} changes failed`, error);
        if (engine !== this.engine) {
            const away = detached.get(engine);
            if (away) {
                away.failures += changes.length;
                if (!away.firstError) away.firstError = friendlyError(error, away.t, "read");
            }
            return;
        }
        const reason = friendlyError(error, this.t, "read");
        if (this.batchErrors === 0) this.batchFirstError = reason;
        this.batchErrors += changes.length;
        const [{ item, change }] = changes;
        this.error = this.batchErrors === 1 ? `${change === "add" ? this.t.addFailed(item.name) : this.t.removeFailed(item.name)} ${reason}` : `${this.t.manyFailed(this.batchErrors)} ${this.batchFirstError}`;
        this.render();
    }

    private onSettled(engine: SyncEngine, changed: boolean): void {
        if (engine !== this.engine) {
            const away = detached.get(engine);
            if (away) this.finishDetached(engine, away, changed);
            return;
        }
        const hadErrors = this.batchErrors > 0;
        const unknown = this.batchUnknown;
        const markedPeers = this.markedPeers;
        this.batchErrors = 0;
        this.batchUnknown = false;
        this.markedPeers = false;
        if (unknown) {
            // A write may have been saved although it failed: the copy follows the links saved on the server, and the
            // re-read that settles it gets its own retries (see loadSelected).
            this.resyncRetries = 0;
            this.updateSummary(true);
        }
        // A write that may have been saved changes the links as much as one that was: subgrids and the other instances
        // on the page read them again.
        // Write the links = Before, names stored: the save made again once these links are written stores the names.
        const savedWithNames = this.hold?.engine === engine && !!this.hold.before && this.hold.savesNames && !hadErrors;
        if (changed || unknown) {
            this.scheduleSubgridRefresh();
            // Changes that wait for the next save (made while these were written, or a new record's carried pick taken
            // away meanwhile): the page's names aren't the saved ones, so the copy follows the links saved on the server.
            if (!unknown && !savedWithNames) this.updateSummary(engine.hasHeldChanges());
            const recordId = engine.getRecordId();
            if (recordId) this.resyncPeers(this.recordKey(recordId), engine);
        } else if (markedPeers) {
            // Nothing was saved after all (the writes failed or undid each other), but the other instances were told
            // their links are out of date: they read them again.
            const recordId = engine.getRecordId();
            if (recordId) this.resyncPeers(this.recordKey(recordId), engine, true);
        }
        // With the record: the record's save stored the names of the changes, but some were refused, or the read before a
        // required column's last removals found other links saved (another tab or user changed them, see
        // SyncEngine.release): the copy writes the names of the saved links. Not when the save made again once the links
        // are written stores them (Before).
        const checked = engine.takeCheckChange();
        const repairNames = (hadErrors || checked) && !changed && !unknown && this.hold?.engine === engine && this.hold.savesNames && !savedWithNames;
        let checkNames = false;
        // The record's save stored the names the form showed. Once its links are written, the copy checks them against
        // the links saved on the server (one read; a write only when they differ): someone may have changed the links
        // since the form read them (a name added elsewhere would be missing, a removed one back), or a change was undone
        // while that save was on its way.
        const stored = this.hold?.engine === engine ? this.hold.storedNames : undefined;
        if ((stored !== undefined || this.checkNamesLater) && !engine.isBusy() && !engine.hasReleasedWork() && !engine.hasPendingChanges()) {
            if (this.hold?.engine === engine) this.hold.storedNames = undefined;
            this.checkNamesLater = false;
            checkNames = true;
        }
        if (repairNames) this.updateSummary(true);
        else if (checkNames) this.updateSummary(true, true);
        if (hadErrors) {
            // A failure might not be what it seems (the connection dropped after the server saved): re-read.
            this.scheduleResync();
        }
        const hold = this.hold;
        if (hold?.engine === engine && hold.before) {
            // A link refused while the save waits for the links (one of them, or one already on its way when it started)
            // cancels the save: it isn't made again.
            if (hadErrors) {
                hold.before.failed = true;
                hold.before.failedMembers.add(hold);
            }
            // Not from inside the OnSave handler that released the writes (see lastWord, finishBefore).
            if (hold.before.phase === "writing" && !engine.isBusy() && !engine.hasReleasedWork()) setTimeout(() => this.finishBefore(hold, hadErrors), 0);
        }
        this.render();
    }

    private finishDetached(engine: SyncEngine, away: Detached, changed: boolean): void {
        if (changed || away.unknown) {
            away.bridge.refreshSubgrids(engine.getRecordId());
            this.resyncPeers(away.key, engine);
        } else {
            // Nothing was saved after all, but the instances told their links are out of date read them again.
            this.resyncPeers(away.key, engine, true);
        }
        if (engine.hasPendingChanges() || engine.isBusy()) {
            // Only a save that reported late is left to write what it carried: leaving the page needn't wait for it.
            if (away.kept) NToNMultiSelect.parkLate(away.kept);
            return;
        }
        // A later save of the form still carries changes of this field, undone since (see retireEngine): the engine stays
        // for its OnPostSave, whose names the copy checks then (see onHeldPostSave, dropKept). What is done now is
        // finished now: its failures reported and its names put right.
        const kept = away.kept;
        const savePending = !!kept && !!(kept.saving ?? kept.lateSaving);
        if (away.failures > 0) {
            notifyApp(`${away.t.closedFailures(away.failures, away.label)} ${away.firstError}`);
        }
        // Every link is saved (or has failed for good), so the copy can follow them, unless none of them changed
        // anything. Changes that were saved before the engine was detached have been copied already (updateSummary).
        // A write that failed may still have been saved (see mayHaveSaved): then the copy reads the saved links and
        // writes their names, whatever the page shows.
        if (away.copy) {
            // The read before a required column's last removals found other links saved (see SyncEngine.release).
            const checked = engine.takeCheckChange();
            if (away.unknown) away.copy.names.refresh(away.copy.writer);
            else if (away.namesStored) away.copy.names.refresh(away.copy.writer, true);
            else if (changed) away.copy.names.update(engine.selected(), away.copy.writer);
            // With the record, the record's save stored the names of its changes, but they were all refused.
            else if (checked || (away.failures > 0 && engine.isHolding())) away.copy.names.refresh(away.copy.writer);
        }
        if (savePending && kept) {
            away.failures = 0;
            away.firstError = "";
            away.unknown = false;
            away.namesStored = false;
            NToNMultiSelect.parkLate(kept);
            return;
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
     * those names into the shared copy with their next change. `onlyStale`: only those marked out of date (see
     * markPeersStale).
     */
    private resyncPeers(key: string, engine: SyncEngine, onlyStale = false): void {
        for (const control of liveControls) {
            const recordId = control.engine?.getRecordId();
            if (control.engine !== engine && !control.destroyed && recordId && control.recordKey(recordId) === key && (!onlyStale || control.hostStale)) {
                control.scheduleResync();
            }
        }
    }

    /**
     * `engine` has just changed the links of its record: every other instance on the page that shows them shows links
     * from before until it reads them again, so meanwhile it leaves the host column alone (see hostStale).
     */
    private markPeersStale(engine: SyncEngine): void {
        const recordId = engine.getRecordId();
        if (!recordId) return;
        const key = this.recordKey(recordId);
        for (const control of liveControls) {
            const shown = control.engine?.getRecordId();
            if (control !== this && !control.destroyed && shown && control.recordKey(shown) === key) {
                control.hostStale = true;
                control.staleMarks++;
                this.markedPeers = true;
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
    private updateSummary(force = false, check = false): void {
        const engine = this.engine;
        if (!engine || !this.hostCopy()) return;
        if (this.copy) {
            // `force`: read the saved links and write their names even when the page's names haven't changed.
            // `check`: only to make sure names the record's save stored match the saved links (see NamesCopy.refresh).
            if (force) this.copy.names.refresh(this.copy.writer, check);
            else this.copy.names.update(engine.selected(), this.copy.writer);
        }
    }

    /**
     * "Copy names into the host column" for this field: the setting, unless the field is bound to the record's own name
     * (the table's primary name column of `rel`), whose names would replace the record's name. That column is then never
     * written, by the copy or by the record's save, and the link requests aren't tagged (safety review C7).
     */
    private copiesNames(rel: RelationshipInfo | null = this.rel): boolean {
        if (!this.config?.writeSummary) return false;
        const host = (this.context.parameters.value as unknown as { attributes?: { LogicalName?: string } } | undefined)?.attributes?.LogicalName;
        const name = rel?.currentNameAttribute;
        if (!host || !name || host.toLowerCase() !== name.toLowerCase()) return true;
        if (!this.warnedNameColumn) {
            this.warnedNameColumn = true;
            console.warn(`[${CONTROL_NAME}] The host column ${host} is the record's own name: the names aren't copied into it.`);
        }
        return false;
    }

    /** Whether the field is bound to the record's own name: the table's primary name column (see copiesNames). */
    private boundToRecordName(): boolean {
        const host = (this.context.parameters.value as unknown as { attributes?: { LogicalName?: string } } | undefined)?.attributes?.LogicalName;
        const name = this.rel?.currentNameAttribute;
        return !!host && !!name && host.toLowerCase() === name.toLowerCase();
    }

    /**
     * The host column copy of this instance's record ("Copy names into the host column"), made the first time it is
     * needed, or null when there is none: the setting is off, the column is locked by column security (a change made
     * in a subgrid of the form is then left to the names copy plug-in, when it is installed), or no record.
     */
    private hostCopy(): HostCopy | null {
        const engine = this.engine;
        const recordId = engine?.getRecordId();
        if (this.destroyed || !this.copiesNames() || !engine || !recordId || this.columnLocked()) return null;
        this.copy ??= this.startCopy(recordId, this.recordKey(recordId), this.data);
        return this.copy;
    }

    /**
     * The tag of this control's link requests for `recordId` while it writes the host column copy itself (see
     * linkTag), or undefined when it doesn't: the names copy plug-in then copies its links like any others.
     */
    private linkTag(rel: RelationshipInfo, recordId: string): string | undefined {
        const host = (this.context.parameters.value as unknown as { attributes?: { LogicalName?: string } }).attributes?.LogicalName;
        return this.copiesNames(rel) && host ? linkTag(rel, recordId, host) : undefined;
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
        const separator = () => this.namesSeparator();
        const copy: HostCopy = {
            names: namesCopyFor(`${recordKey}|${host}`, this.loadedCopy),
            writer: {
                maxLength: attributes.MaxLength,
                // Asked at each write: the copies of the field on the page may come and go.
                get separator() {
                    return separator();
                },
                write: (value, version) => trackCopy(data.updateRecord(recordId, host, value, version)),
                onError: (error, step) => this.onCopyFailed(copy, error, label, t, step),
                // A quiet read (a check of names the record's save stored) doesn't keep the page from closing (see
                // installUnloadGuard): the save stored the names, so nothing is lost if the page goes meanwhile.
                readHostAndLinks: async (quiet) => {
                    const engine = this.engine;
                    const version = engine?.version;
                    const read = data.readHostAndLinks(recordId, host);
                    const saved = await (quiet ? read : trackCopy(read));
                    this.showSaved(engine, version, recordId, saved.items);
                    return saved;
                },
            },
        };
        return copy;
    }

    /**
     * Shows the links the names copy has just read from the server before writing their names (see
     * CopyWriter.readHostAndLinks): links made or removed elsewhere since the field read them (in another tab, by another
     * user, from the other side of the relationship, by a flow) then appear with the user's next change, without a
     * reload. Only while this instance still shows that record and nothing has changed in it since the read began.
     */
    private showSaved(engine: SyncEngine | null, version: number | undefined, recordId: string, items: Item[]): void {
        if (this.destroyed || !engine || engine !== this.engine || engine.getRecordId() !== recordId) return;
        if (engine.version !== version || engine.isBusy() || engine.hasPendingChanges()) return;
        const before = engine.selected();
        engine.setConfirmed(items);
        this.resyncRetries = 0;
        if (!sameIds(before, engine.selected())) this.render();
    }

    /**
     * A failed copy leaves the links as they are. It is explained under the field or, once the control has moved on
     * (the record was closed, or the control shows another one), in an app notification.
     */
    private onCopyFailed(copy: HostCopy, error: unknown, label: string, t: Strings, step: "read" | "write"): void {
        console.error(`[${CONTROL_NAME}] copying the names into the host column failed`, error);
        const message = t.copyFailed(label, friendlyError(error, t, step === "read" ? "read" : "update"));
        if (copy === this.copy && !this.destroyed) {
            this.error = message;
            this.render();
        } else {
            notifyApp(message);
        }
    }

    // ---------------------------------------------------------------- "Save the selection" = With the record

    /**
     * From now on the changes on the saved record `recordId` wait for its save (see HoldState). Not where the save can't
     * be followed (quick create, a dialog or side pane, the tables whose save skips OnSave and OnPostSave), without the
     * host column on the form, while column security locks it, with another copy of the field showing the record, or
     * for a field bound to the record's own name in an app with "Async save handler" on: changes are then saved at
     * once, as with At once.
     */
    private startHolding(engine: SyncEngine, bridge: FormBridge, recordId: string): void {
        const config = this.config;
        const host = this.hostField;
        const table = (this.contextInfo(this.context).entityTypeName ?? "").toLowerCase();
        if (config?.saveMode !== "withRecord" || !host || this.hold || engine !== this.engine || this.destroyed) return;
        if (NO_POST_SAVE_TABLES.includes(table) || this.columnLocked() || !host.isOnForm(recordId)) return;
        if (this.recordPeers(this.recordKey(recordId)).length > 0) return;
        // Bound to the record's own name, in an app with "Async save handler" on: a save there builds its request only
        // once the app's OnSave handlers are done, and could carry the names that a change made meanwhile shows in the
        // column into the record's name (review of the fixes, fourth round). Its changes are saved at once there.
        if (this.boundToRecordName() && bridge.waitsForSaveHandlers()) return;
        const state: HoldState = { engine, bridge, recordId, host, timing: config.linkTiming, savesNames: this.copiesNames(), saving: null, before: null, pass: false, owner: this };
        const followed = bridge.followSaves(recordId, {
            onSave: (args) => this.onHeldSave(state, args),
            onPostSave: (success, savedId) => this.onHeldPostSave(state, success, savedId),
            onDataLoad: (loadState) => this.onHeldDataLoad(state, loadState),
        });
        if (!followed) {
            // Not on the page yet (the platform can attach the control late): tried again once it is (see updateView).
            this.holdWhenPlaced = !this.view.element().isConnected;
            return;
        }
        this.hold = state;
        engine.hold();
        watchUserSaves();
    }

    /** Another copy of the field shows the record: from now on its changes are saved at once (see startHolding). */
    private stopHolding(): void {
        const hold = this.hold;
        if (!hold) return;
        this.hold = null;
        if (hold.before) NToNMultiSelect.abandonRound(hold.before);
        // A save stored the names and its links are still being written: the copy checks them once they are.
        if (hold.storedNames !== undefined) this.checkNamesLater = true;
        if (hold.saving) clearTimeout(hold.saving.timer);
        hold.saving = null;
        hold.lateSaving = undefined;
        hold.bridge.unfollowSaves();
        hold.engine.stopHolding();
    }

    /**
     * OnSave of the record whose changes are held. Write the links = After the record is saved (default): the column
     * isn't part of the save (the form never writes it), and the changes held now are written once the save is done.
     * Before the record is saved: the field joins the save's round (see BeforeRound), whose own handler, after every
     * other handler of the save, cancels it when no other handler did; the links are written, then the save is made
     * again (see lastWord, finishBefore). Runs for an instance that is gone too, while a save it held changes for is
     * under way.
     */
    private onHeldSave(state: HoldState, args: SaveEventArgs): void {
        const { engine, host, recordId } = state;
        const key = state.bridge.followedEntity() ?? state;
        if (state.pass) {
            // The save made again once the links were written: it goes ahead, with the names when they are stored.
            state.pass = false;
            // Changes made while the links were written wait for the next save: the column then holds their names too,
            // so it stays out of this save (and the names copy writes the names of the saved links, see saveAgain).
            if (state.savesNames && !engine.hasHeldChanges()) state.passNames = host.isDirty(recordId) === true ? host.valueOn(recordId) : undefined;
            else host.markNever(recordId);
            NToNMultiSelect.noteWhatSaveSends(key);
            return;
        }
        const round = beforeRounds.get(key);
        const saveMode = args.getSaveMode?.() ?? 1;
        // Asked first: the user's save command is used up by the first save after it, also when a handler before this
        // one cancelled that save. A validation script that then saves the form itself mustn't find it (see savesBefore).
        const userCommand = state.timing === "before" && savesBefore(saveMode, state);
        // With the app's "Async save handler" on, a handler can't see another one cancel the save (measured live): the
        // links can't go first there without being written for a save that a script cancels, so they follow the
        // record's save, as with After (owner, 2026-11-06).
        const before = userCommand && !state.bridge.waitsForSaveHandlers();
        // Another Before field of the form started a round in this save, or writes its links and the user saved again:
        // this field's changes go with it, even when a handler between the two cancelled the save (a collecting round's
        // last handler sees that, see lastWord; a writing round cancels the user's save and makes it again).
        const joining = !!round && state.timing === "before" && !state.before && (round.phase === "collecting" || (round.phase === "writing" && before));
        // Cancelled by a handler that ran before this one (a validation script, a script that turns auto-save off):
        // nothing is released, and the changes keep waiting.
        if (args.isDefaultPrevented?.() === true && !joining) return;
        if (state.before) {
            if (before) {
                // Its links are still being written (Save clicked again): unless another handler of this save cancels it,
                // the round takes it, and its save made again saves the record, and closes the form or opens a new one if
                // this click asked for it (see absorb).
                NToNMultiSelect.absorb(state.before, saveMode, null, state, args);
                return;
            }
            // The user leaves the record (or a command or a script saves it) while those links are written: this save goes
            // ahead, and nothing is saved again, for any field of the round. Their columns go out of it (the names were for
            // the save made again), after another field of the form may have looked at what it sends (review of the
            // fixes, fourth round).
            const unsaved = state.bridge.followedIsDirty() === true;
            NToNMultiSelect.abandonRound(state.before);
            if (unsaved) NToNMultiSelect.noteWhatSaveSends(key);
        }
        // A kept state (its instance is gone) waits for a save under way, or one that reported late (see lateSaving):
        // another save of the form starting means that one is over (a form saves one at a time), cancelled unseen if it
        // never reported (Async save handler on). Nothing can carry its changes now: they are dropped.
        if (!state.owner && (state.saving || state.lateSaving)) {
            // (Asked first: the form says it has no unsaved changes once it sends a save, see noteWhatSaveSends.)
            const unsaved = state.bridge.followedIsDirty() === true;
            this.endSave(state);
            state.lateSaving = undefined;
            this.dropKept(state);
            if (unsaved) NToNMultiSelect.noteWhatSaveSends(key);
            return;
        }
        // A save that reported late is over once another one starts: this one carries what waits.
        state.lateSaving = undefined;
        const changes = engine.heldChanges();
        if (changes.size === 0 || !state.owner) return;
        if (state.saving) {
            // A save already on its way carries the changes held then; it writes them when it is done. Those made since
            // wait for a later save, and without Copy names their column goes out of this one: the fields of this save
            // that looked at what it sends see it again (see noteWhatSaveSends; the view of the save on its way isn't
            // touched: it may be sending already).
            if (!state.savesNames) {
                const unsaved = state.bridge.followedIsDirty() === true;
                host.markNever(recordId);
                if (unsaved) NToNMultiSelect.noteWhatSaveSends(key);
            }
            return;
        }
        const keepOne = host.isRequired(recordId);
        // Before the record is saved: only for saves the control can make again (see savesBefore); any other save goes
        // ahead, its links after it.
        if (before) {
            if (round && round.phase === "writing") {
                // Other fields of the form write their links, and the user saved again: unless another handler of this
                // save cancels it, this field's are written with them, and the round's save made again saves the record
                // once they all are (see absorb, finishBefore).
                NToNMultiSelect.absorb(round, saveMode, { control: this, state, changes, keepOne }, state, args);
                return;
            }
            // The form never saves the column without Copy names (see HoldState.savesNames), whatever becomes of this save.
            if (!state.savesNames) host.markNever(recordId);
            const member: BeforeMember = { control: this, state, changes, keepOne };
            if (round) {
                round.members.push(member);
                state.before = round;
                return;
            }
            const started: BeforeRound = { key, saveMode, phase: "collecting", members: [member], removeLast: null, pending: new Set(), failedMembers: new Set(), failed: false, absorbing: null, taken: null };
            beforeRounds.set(key, started);
            state.before = started;
            // The round's handler: it runs after the other handlers of this save, those a script added after this
            // field's included (see BeforeRound).
            started.removeLast = state.bridge.addSaveHandler((ctx) => NToNMultiSelect.lastWord(started, saveEventArgs(ctx) ?? {}));
            if (!started.removeLast) {
                // It can't be added: the save is cancelled now (a handler added to OnSave after this field's could
                // still cancel it unseen), and the links are written.
                NToNMultiSelect.lastWord(started, args);
                return;
            }
            // Once this save's handlers have run, the round's handler comes off again (see afterSaveHandlers).
            setTimeout(() => NToNMultiSelect.afterSaveHandlers(started, args), 0);
            return;
        }
        // The form saves the names with the record only when they are stored (see HoldState.savesNames).
        const names = state.savesNames && host.isDirty(recordId) === true ? host.valueOn(recordId) : undefined;
        if (!state.savesNames) host.markNever(recordId);
        const saving: NonNullable<HoldState["saving"]> = { changes, keepOne, names, timer: setTimeout(() => this.saveNotReported(state, saving), SAVE_REPORT_MS) };
        state.saving = saving;
        // Whether the save has anything to send, seen here: once the form starts sending it says it has no unsaved
        // changes any more (measured), so this can't be asked later. Other With the record fields of this form take their
        // columns out of the save in their own OnSave handlers, which may run after this one: the decision is made once
        // all of them have run, on what the last of them saw (see settleHeldSaves).
        const sendsNothing = state.bridge.followedIsDirty() === false;
        const member: HeldSaveMember = { control: this, state, saving, args, sendsNothing };
        const members = heldSaves.get(key);
        if (members) {
            members.push(member);
        } else {
            heldSaves.set(key, [member]);
            setTimeout(() => NToNMultiSelect.settleHeldSaves(key), 0);
        }
    }

    /**
     * A field's OnSave handler took its column out of the save (the save made again, see finishRound; a kept state
     * dropping what it held, or a change made while an earlier save is on its way, review of the fixes, third round; a
     * Before round that a save going ahead ends, fourth round)
     * after an After field of the form had looked at what it sends (see onHeldSave): whether it has anything to send is
     * seen again, for the fields that wait for it (settleHeldSaves decides on the last view). Seen through the last of
     * them: the field that took its column out may have let go of the form already (see dropKept). Not for a save that
     * a handler of a later save would see sending (the form then says it has nothing unsaved): only when the form still
     * had unsaved changes as the column went.
     */
    private static noteWhatSaveSends(key: object): void {
        const members = heldSaves.get(key);
        const last = members?.[members.length - 1];
        if (last) last.sendsNothing = last.state.bridge.followedIsDirty() === false;
    }

    /**
     * Once every OnSave handler of a save has run (see onHeldSave): a save one of them cancelled leaves the changes
     * waiting; a save left with nothing to send (the fields' columns taken out, nothing else changed) sends nothing and
     * reports no OnPostSave, and nothing can refuse it, so their changes are written now. Otherwise they wait for
     * OnPostSave.
     */
    private static settleHeldSaves(key: object): void {
        const members = heldSaves.get(key) ?? [];
        heldSaves.delete(key);
        if (members.length === 0) return;
        const cancelled = members.some((member) => member.args.isDefaultPrevented?.() === true);
        const sendsNothing = members[members.length - 1].sendsNothing;
        for (const { control, state, saving } of members) {
            if (state.saving !== saving) continue;
            if (cancelled) {
                control.endSave(state);
                if (!state.owner) control.dropKept(state);
            } else if (sendsNothing) {
                control.endSave(state);
                control.releaseHeld(state, saving.changes, saving.keepOne);
            }
        }
    }

    /** OnPostSave of the record whose changes are held: a successful save writes the changes it carried. */
    private onHeldPostSave(state: HoldState, success: boolean | null, savedId: string | null): void {
        // A save that reported late (see lateSaving) is done after all.
        const late = !state.saving ? state.lateSaving : undefined;
        if (late) {
            state.lateSaving = undefined;
            state.saving = late;
        }
        const saving = state.saving;
        if (!saving) return;
        // Without getIsSaveSuccess (on-premises), a save that left the form without unsaved changes counts as done.
        const done = (success ?? state.bridge.followedIsDirty() === false) && savedId === state.recordId;
        this.endSave(state);
        if (done && saving.names !== undefined) {
            (state.owner?.copy ?? detached.get(state.engine)?.copy)?.names.stored(saving.names);
            state.storedNames = saving.names;
            // The instance is gone (Save & Close): the links it carried are written on their own (see finishDetached).
            const away = detached.get(state.engine);
            if (away) away.namesStored = true;
        }
        if (done) this.releaseHeld(state, saving.changes, saving.keepOne);
        else if (!state.owner) this.dropKept(state);
    }

    /**
     * The form's data was loaded again. A refresh (Discard changes in the form's prompt, or a script's
     * formContext.data.refresh(false)) drops the form's unsaved changes, so the held ones go too; the changes a save under
     * way carries stay. The reload after a save changes nothing.
     */
    private onHeldDataLoad(state: HoldState, loadState: number | null): void {
        if (loadState !== 3) return;
        // A save that reported late (see lateSaving) may still be saved: what it carries stays too.
        const carried = state.saving ?? state.lateSaving;
        const engine = state.engine;
        engine.dropHeld(carried ? new Set(carried.changes.keys()) : undefined);
        // The check of names a save stored waited for the changes dropped now (see onSettled): it is made now (safety
        // review of the S01 fix).
        if (state.storedNames !== undefined && state.owner && !carried && !engine.isBusy() && !engine.hasReleasedWork() && !engine.hasPendingChanges()) {
            state.storedNames = undefined;
            state.owner.updateSummary(true, true);
        }
    }

    /** The save carrying held changes is over (see HoldState.saving): what is still held counts as unsaved again. */
    private endSave(state: HoldState): void {
        if (state.saving) clearTimeout(state.saving.timer);
        state.saving = null;
        state.owner?.render();
    }

    /** The save never said how it went: its changes count as unsaved again (and are dropped once the instance is gone). */
    private saveNotReported(state: HoldState, saving: NonNullable<HoldState["saving"]>): void {
        if (state.saving !== saving) return;
        // With the app's "Async save handler" on, the save may still wait for the promise of another OnSave handler (a
        // dialog left open): its OnPostSave, if it comes, still writes what it carried (see onHeldPostSave).
        if (state.bridge.waitsForSaveHandlers()) state.lateSaving = saving;
        this.endSave(state);
        if (!state.owner && !state.lateSaving) this.dropKept(state);
        else NToNMultiSelect.parkLate(state);
    }

    /**
     * A kept state (its instance is gone) that only waits for a save that reported late (see lateSaving): nothing is on
     * its way, and the save may never report (cancelled unseen), so leaving the page doesn't ask about it (see liveEngines).
     * Its OnPostSave, if it comes, puts the engine back (see releaseHeld).
     */
    private static parkLate(state: HoldState): void {
        if (!state.owner && state.lateSaving && !state.saving && !state.engine.isBusy() && !state.engine.hasReleasedWork()) liveEngines.delete(state.engine);
    }

    /** Lets `changes` be written (see SyncEngine.release); `keepOne` for a required column. */
    private releaseHeld(state: HoldState, changes: Map<string, LinkChange>, keepOne: boolean): void {
        // Writes on their way again (a kept state's late save succeeded, see parkLate): leaving the page asks about them.
        if (!state.owner) liveEngines.add(state.engine);
        state.engine.release(changes, keepOne);
        // Nothing left to write (the changes were undone): a kept state lets go.
        if (!state.owner && !state.engine.isBusy() && !state.engine.hasPendingChanges()) this.dropKept(state);
    }

    /**
     * Write the links = Before: the round's handler, after the other OnSave handlers of the save (see BeforeRound). When
     * one of them cancelled the save, a link was refused meanwhile or a field went, nothing is written and the changes
     * keep waiting. Otherwise the save is cancelled now and the fields' links are written; once they all are, the record
     * is saved, and the form closed or a new one opened as that save would have done (see finishBefore).
     */
    private static lastWord(round: BeforeRound, args: SaveEventArgs): void {
        if (beforeRounds.get(round.key) !== round || round.phase !== "collecting") return;
        if (args.isDefaultPrevented?.() === true || round.failed || !NToNMultiSelect.roundIntact(round)) {
            NToNMultiSelect.dropRound(round);
            return;
        }
        NToNMultiSelect.take(round, args);
        round.phase = "writing";
        for (const { state } of round.members) round.pending.add(state);
        for (const { state, changes, keepOne } of round.members) state.engine.release(changes, keepOne);
    }

    /**
     * Once the OnSave handlers of the save that started `round` have run (`args`: its first field's): the round's handler
     * comes off the form again. If the platform didn't run it (a client that doesn't run a handler added during a save;
     * Dynamics runs it, measured), the round ends here: a save that a handler cancelled writes nothing; for one that went
     * ahead, the links are written at once, while the record is being saved, without waiting for its outcome as After
     * would.
     */
    private static afterSaveHandlers(round: BeforeRound, args: SaveEventArgs): void {
        round.removeLast?.();
        round.removeLast = null;
        if (beforeRounds.get(round.key) !== round || round.phase !== "collecting") return;
        if (args.isDefaultPrevented?.() === true) {
            NToNMultiSelect.dropRound(round);
            return;
        }
        beforeRounds.delete(round.key);
        for (const { state, changes, keepOne } of round.members) {
            if (state.before === round) state.before = null;
            state.engine.release(changes, keepOne);
        }
    }

    /**
     * The user saved again while `round` writes its links (see AbsorbedSave): notes what this field's handler saw, and adds
     * the round's handler for that save once, which decides after the other handlers of the save (see absorbSave). A
     * client that can't add it has it decided at once.
     */
    private static absorb(round: BeforeRound, saveMode: number, joiner: BeforeMember | null, state: HoldState, args: SaveEventArgs): void {
        // The round has taken this save already (decided at once, see BeforeRound.taken): this field joins at once.
        if (round.taken && round.taken === saveDecision) {
            if (saveMode === 2 || saveMode === 59) round.saveMode = saveMode;
            if (joiner && !round.failed) NToNMultiSelect.join(round, joiner);
            return;
        }
        let save = round.absorbing;
        if (!save) {
            const added: AbsorbedSave = { joiners: [], remove: null, args };
            round.absorbing = added;
            added.remove = state.bridge.addSaveHandler((ctx) => NToNMultiSelect.absorbSave(round, added, saveEventArgs(ctx) ?? {}));
            if (added.remove) setTimeout(() => NToNMultiSelect.afterAbsorbing(round, added), 0);
            save = added;
        }
        if (saveMode === 2 || saveMode === 59) save.mode = saveMode;
        if (joiner) save.joiners.push(joiner);
        if (!save.remove) NToNMultiSelect.absorbSave(round, save, args);
    }

    /**
     * The round's handler for a save of the user's while it writes (see absorb), after the other handlers of that save. A
     * save one of them cancelled is left alone: nothing joins, and its Save & Close or Save & New asks for nothing. Otherwise
     * the round takes it: it is cancelled, its command goes to the round's save made again, and the other Before fields of
     * the form with changes have their links written with the round's (unless a link of the round was refused).
     */
    private static absorbSave(round: BeforeRound, save: AbsorbedSave, args: SaveEventArgs): void {
        if (round.absorbing !== save) return;
        round.absorbing = null;
        if (beforeRounds.get(round.key) !== round || round.phase !== "writing") return;
        if (args.isDefaultPrevented?.() === true) return;
        NToNMultiSelect.take(round, args);
        if (save.mode !== undefined) round.saveMode = save.mode;
        if (round.failed) return;
        for (const joiner of save.joiners) NToNMultiSelect.join(round, joiner);
    }

    /** The round takes the save under way: it is cancelled, and made again once the links are written. */
    private static take(round: BeforeRound, args: SaveEventArgs): void {
        args.preventDefault?.();
        round.taken = saveDecision;
    }

    /** A Before field's changes join the writing `round`: its links are written with the round's. */
    private static join(round: BeforeRound, joiner: BeforeMember): void {
        const { control, state, changes, keepOne } = joiner;
        if (beforeRounds.get(round.key) !== round || round.phase !== "writing") return;
        if (state.before || state.owner !== control || control.hold !== state) return;
        // The form never saves the column without Copy names (see HoldState.savesNames).
        if (!state.savesNames) state.host.markNever(state.recordId);
        round.members.push(joiner);
        round.pending.add(state);
        state.before = round;
        state.engine.release(changes, keepOne);
    }

    /**
     * Once the handlers of a save the round may take have run (see absorb): its handler comes off again. If the platform
     * didn't run it, the save went ahead unless another handler cancelled it, and the round ends, as for any save that goes
     * ahead while it writes (see abandonRound).
     */
    private static afterAbsorbing(round: BeforeRound, save: AbsorbedSave): void {
        save.remove?.();
        save.remove = null;
        if (round.absorbing !== save) return;
        round.absorbing = null;
        if (save.args.isDefaultPrevented?.() !== true) NToNMultiSelect.abandonRound(round);
    }

    /** Every field of the round still holds its changes for it (none went, showed another record or left the round). */
    private static roundIntact(round: BeforeRound): boolean {
        return round.members.length > 0 && round.members.every(({ control, state }) => state.before === round && state.owner === control && control.hold === state);
    }

    /** The round ends without writing (or without saving again): its fields' changes keep waiting for the next save. */
    private static dropRound(round: BeforeRound): void {
        if (beforeRounds.get(round.key) === round) beforeRounds.delete(round.key);
        for (const { state } of round.members) {
            if (state.before === round) state.before = null;
            state.owner?.render();
        }
    }

    /**
     * The round ends without the save made again: a save of the form goes ahead (the user leaves the record, a command or
     * a script saves it), or one of its fields went (the form closes, a rule hid it). The links on their way are still
     * written; with Copy names into the host column, the copy writes the names of the links already written (those still
     * on their way do it once written, see onSettled), as no save stores them.
     */
    private static abandonRound(round: BeforeRound): void {
        if (beforeRounds.get(round.key) === round) beforeRounds.delete(round.key);
        const writing = round.phase === "writing";
        for (const { state } of round.members) {
            if (state.before !== round) continue;
            state.before = null;
            if (writing && state.savesNames && !round.pending.has(state) && !round.failedMembers.has(state)) state.owner?.updateSummary();
            state.owner?.render();
        }
        round.pending.clear();
    }

    /** A field of the round has written its links (see onSettled): once they all have, the save is made again. */
    private finishBefore(state: HoldState, failed: boolean): void {
        const round = state.before;
        if (!round || round.phase !== "writing" || !round.pending.has(state)) return;
        // Asked by a pick's settle from before the links were released: they are still being written, and their own
        // settle comes once they are.
        if (state.engine.isBusy() || state.engine.hasReleasedWork()) return;
        round.pending.delete(state);
        if (failed) {
            round.failed = true;
            round.failedMembers.add(state);
        }
        if (round.pending.size === 0) NToNMultiSelect.finishRound(round);
    }

    private static finishRound(round: BeforeRound): void {
        if (beforeRounds.get(round.key) === round) beforeRounds.delete(round.key);
        const members = round.members;
        const intact = NToNMultiSelect.roundIntact(round);
        for (const { state } of members) if (state.before === round) state.before = null;
        if (round.failed || !intact) {
            for (const { state } of members) {
                // No save stores the names of the links that were written (onSettled left them to the save made
                // again): the copy writes them.
                if (state.savesNames && !round.failedMembers.has(state)) state.owner?.updateSummary();
                state.owner?.render();
            }
            return;
        }
        for (const { state } of members) {
            state.pass = true;
            state.passNames = undefined;
        }
        void NToNMultiSelect.saveAgain(members.map((member) => member.state), round.saveMode);
    }

    /** Makes the cancelled save again (see FormBridge.saveAgain), for the fields whose links were written first. */
    private static async saveAgain(states: HoldState[], saveMode: number): Promise<void> {
        // Taken now: a field may be gone (Save & Close) by the time the save is done, and the copy still checks the names.
        const copies = states.map((state) => (state.savesNames ? (state.owner?.hostCopy() ?? detached.get(state.engine)?.copy ?? null) : null));
        // Changes made while the links were written count as unsaved again, before Save & Close or Save & New leaves the
        // form: it then asks first.
        const saved = await states[0].bridge.saveAgain(saveMode, () => {
            for (const state of states) {
                state.pass = false;
                state.owner?.render();
            }
        });
        states.forEach((state, i) => NToNMultiSelect.afterSavedAgain(state, saved, copies[i]));
    }

    /** The save made again is done (`saved`: the record was saved): the names copy follows it (see HoldState.savesNames). */
    private static afterSavedAgain(state: HoldState, saved: boolean, copy: HostCopy | null): void {
        state.pass = false;
        if (state.savesNames) {
            if (saved && state.passNames !== undefined) {
                // The save stored the names the form showed: the copy checks them against the links saved on the server
                // (one read; a write only when they differ), as someone may have changed the links since the form read them.
                copy?.names.stored(state.passNames);
                if (state.owner) state.owner.updateSummary(true, true);
                else if (copy) copy.names.refresh(copy.writer, true);
            } else if (state.owner) {
                // It didn't store them: the copy writes them.
                state.owner.updateSummary();
            } else if (copy) {
                // The field is gone and how that save went isn't known: the copy follows the saved links.
                copy.names.refresh(copy.writer);
            }
        }
        state.passNames = undefined;
        state.owner?.render();
    }

    /**
     * The instance lets go of its held changes (it goes, or shows another record). A save under way that carries some
     * (Save & Close, auto-save when leaving, or a save that reported late, see lateSaving) still writes those once it is
     * done, on their own like any changes left to write (see Detached); the others can't be saved any more. Without one
     * (Discard, another record, the field hidden by a rule), they are dropped, and the column no longer counts as unsaved.
     */
    private letGoOfHeld(hold: HoldState): void {
        hold.owner = null;
        // Write the links = Before: its round ends (see abandonRound). The column holds the round's names, for the save
        // that won't be made again: the form's later saves leave it alone, and the copy writes the names once the links
        // on their way are done (see finishDetached; safety review of the S01 fix).
        if (hold.before) {
            NToNMultiSelect.abandonRound(hold.before);
            if (hold.savesNames) hold.host.markNever(hold.recordId);
        }
        const engine = hold.engine;
        // A save that reported late (see lateSaving) is still under way too: its OnPostSave, if it comes, writes them.
        const carried = hold.saving ?? hold.lateSaving;
        if (carried) {
            // Changes made since that save started can't be saved any more: dropped, and the column shows what the save
            // carries, no longer as an unsaved change, so the form's later saves leave it alone (review of the fixes).
            // With the app's "Async save handler" on, that save may still wait for another OnSave handler and build its
            // request only then: when it stores the names, the column stays part of it, with what it carries (its
            // OnPostSave, or dropKept, settles the column).
            if (engine.dropHeld(new Set(carried.changes.keys())) > 0) {
                const selected = engine.selected();
                const maxLength = (this.context.parameters.value as unknown as { attributes?: { MaxLength?: number } }).attributes?.MaxLength;
                const inSave = hold.savesNames && carried.names !== undefined && hold.bridge.waitsForSaveHandlers();
                hold.host.show(hold.recordId, namesText(selected, maxLength, this.namesSeparator()), selected.map((item) => item.id).sort().join(), null, inSave ? "dirty" : "never");
            }
            NToNMultiSelect.parkLate(hold);
            return;
        }
        hold.bridge.unfollowSaves();
        if (engine.dropHeld() === 0) return;
        const saved = engine.savedSelected();
        const maxLength = (this.context.parameters.value as unknown as { attributes?: { MaxLength?: number } }).attributes?.MaxLength;
        hold.host.show(hold.recordId, namesText(saved, maxLength, this.namesSeparator()), saved.map((item) => item.id).sort().join(), null, "never");
    }

    /** A kept state (see letGoOfHeld) whose save didn't save its changes: they are dropped, and it lets go. */
    private dropKept(state: HoldState): void {
        const { engine, bridge } = state;
        const away = detached.get(engine);
        if (engine.dropHeld() > 0) {
            // The form may still be open (the field was hidden by a rule): its column shows the saved names again.
            const saved = engine.savedSelected();
            const maxLength = (this.context.parameters.value as unknown as { attributes?: { MaxLength?: number } }).attributes?.MaxLength;
            state.host.show(state.recordId, namesText(saved, maxLength, this.namesSeparator()), saved.map((item) => item.id).sort().join(), null, "never");
        }
        // Writes released before are still on their way: the engine lets go once they are done (see finishDetached).
        if (engine.isBusy() || engine.hasPendingChanges()) return;
        // Failures counted while the field was gone (a refused write, or a failed read of the saved links), reported as
        // finishDetached does (safety review of the S01 fix).
        if (away && away.failures > 0) {
            notifyApp(`${away.t.closedFailures(away.failures, away.label)} ${away.firstError}`);
            away.failures = 0;
        }
        // An earlier save stored the names (or a write may have been saved): the copy still makes sure of them.
        if (away?.copy && away.unknown) away.copy.names.refresh(away.copy.writer);
        else if (away?.copy && away.namesStored) away.copy.names.refresh(away.copy.writer, true);
        detached.delete(engine);
        liveEngines.delete(engine);
        engine.dispose();
        bridge.dispose();
    }

    /**
     * With the record: a new record's save starts. Its picks are linked once it exists, so the column isn't part of the
     * create (the form never writes it); it counts as unsaved again if the save is cancelled or fails.
     */
    private onNewRecordSave(engine: SyncEngine, args: SaveEventArgs): void {
        if (this.config?.saveMode !== "withRecord") return;
        // Also for picks left by an instance that is gone (the field hidden by a rule, see orphans).
        this.hostField?.markNever(null);
        if (engine !== this.engine || this.destroyed) {
            // Those picks as they are now: not what an earlier save carried that never reported (cancelled unseen, see
            // onNewRecordSaveLate). A save is over once another one starts; this one is under way for the instance that
            // adopts them (see adoptOrphan).
            engine.holdForCreate();
            const orphan = orphanOf.get(engine);
            if (orphan) orphan.saveDeadline = Date.now() + SAVE_REPORT_MS;
            return;
        }
        const attempt = this.followNewRecordSave(engine);
        // Only this save's own cancel: a save made again at once (a script) is another attempt (fourth audit CREATE-02).
        setTimeout(() => {
            if (attempt === this.newSaveAttempt && args.isDefaultPrevented?.() === true) this.onNewRecordSaveFailed(engine);
        }, 0);
    }

    /**
     * The new record's save under way carries the picks made so far; those made while it is on its way wait for the next
     * save, as on a saved record (see SyncEngine.holdForCreate). It counts as under way until `deadline` (see
     * onNewRecordSaveLate; a save taken over from an orphan keeps its own). Returns the attempt (see newSaveAttempt).
     */
    private followNewRecordSave(engine: SyncEngine, deadline = Date.now() + SAVE_REPORT_MS): number {
        engine.holdForCreate();
        const attempt = ++this.newSaveAttempt;
        clearTimeout(this.newSaveTimer);
        const left = deadline - Date.now();
        this.newSaveInFlight = left > 0;
        this.newSaveDeadline = deadline;
        if (left > 0) this.newSaveTimer = setTimeout(() => this.onNewRecordSaveLate(engine, attempt), left);
        return attempt;
    }

    /**
     * A new record's save that has said nothing for SAVE_REPORT_MS (an OnSave handler of the app keeps it waiting, or
     * cancelled it unseen): it no longer counts as under way, so a change of the picks counts as unsaved again, and a new
     * save carries them all. What it carried stays noted (fourth audit CREATE-01): if it is reported saved after all,
     * exactly that is linked, and later changes wait for the next save, as when it reports in time. The picks it carried
     * don't count as unsaved on their own: it may still be sent, and never with the column (fifth audit, see syncHost).
     */
    private onNewRecordSaveLate(engine: SyncEngine, attempt: number): void {
        if (attempt !== this.newSaveAttempt || engine !== this.engine || this.destroyed || !this.newSaveInFlight || engine.getRecordId()) return;
        this.newSaveInFlight = false;
        this.render();
    }

    private onNewRecordSaveFailed(engine: SyncEngine): void {
        if (engine !== this.engine || this.destroyed || engine.getRecordId()) return;
        // (A failure reported after SAVE_REPORT_MS, see onNewRecordSaveLate: what that save carried is let go too.)
        if (!this.newSaveInFlight && !engine.isHolding()) return;
        clearTimeout(this.newSaveTimer);
        this.newSaveInFlight = false;
        // The record wasn't created: every pick waits for the next save again (see SyncEngine.holdForCreate).
        engine.stopHolding();
        this.render();
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

    /**
     * The form or the field is read-only, or column security doesn't let the user update the host column the control is
     * bound to: then the control is read-only too, as a native field on that column would be.
     */
    private readOnly(): boolean {
        return this.context.mode.isControlDisabled || this.columnLocked();
    }

    /** Column security doesn't let the user update the host column (when it isn't secured, the form doesn't say). */
    private columnLocked(): boolean {
        return this.context.parameters.value?.security?.editable === false;
    }

    private canEdit(): boolean {
        return !!this.engine && this.selectedLoaded && !this.readOnly() && !this.saveFirst && !this.offline;
    }

    private onToggle(items: Item[], select: boolean): void {
        const engine = this.engine;
        if (!engine || !this.canEdit()) return;
        const max = this.config?.maxSelections ?? 0;
        if (select && max > 0) {
            // A record whose removal is still on its way keeps its place, since the removal may fail and bring it
            // back: the limit counts it until the removal succeeded, and picking it again takes no new place. A value
            // whose removal is held back gives its place to the pick that replaces it (see holdBackLast), so picking it
            // again takes a place like a new one.
            const held = this.heldHere();
            const adding = items.filter((i) => !engine.occupies(i.id) || !!held?.has(i.id)).length;
            // A pick that takes no new place is never refused (the record may hold more links than the limit already).
            if (adding > 0 && engine.occupiedCount() - this.heldCount() + adding > max) {
                // The view already blocks this; the check here also covers + New and anything else that selects.
                this.error = this.t.maxNote(max);
                this.render();
                return;
            }
        }
        this.error = null;
        const send = select ? this.takeBack(items) : this.holdBackLast(engine, items);
        const version = engine.version;
        if (send.length) engine.setMany(send, select);
        if (engine.version === version) {
            // Only a held-back removal changed: nothing to send, but the field shows it.
            this.render();
            return;
        }
        this.markPeersStale(engine);
        // Changes made on links another instance had changed: read them again once these are written.
        if (this.hostStale) this.scheduleResync();
        // Waiting for the save: a handler a script added to OnSave since the form loaded runs before the control's, so a
        // save it cancels writes nothing (see FormBridge.keepSaveHandlerLast).
        if (this.hold?.engine === engine) this.hold.bridge.keepSaveHandlerLast();
    }

    /**
     * Removals that would leave a required field without a saved value are held back: the values disappear from the
     * field and from the host column, so the form's own check stops a save, but nothing is sent, so leaving the record
     * keeps them, as leaving an emptied required field without saving does. They are sent once another value is saved,
     * or the field isn't required any more (see releaseHeldBack). Every instance on the page that shows the record
     * shares them (see heldRemovals). A removal that would leave one value waits for a read of the saved links first:
     * another tab or user may have removed that value since this instance read them. Returns the removals to send now.
     */
    private holdBackLast(engine: SyncEngine, items: Item[]): Item[] {
        const recordId = engine.getRecordId();
        // While changes wait for the record's save, the form's own check covers the column, and a save that replaces the
        // last value removes it only once its replacement is linked (see SyncEngine.release).
        if (!recordId || engine.isHolding() || !this.hostField?.isRequired(recordId)) return items;
        const left = this.survivors(recordId, new Set(items.map((item) => item.id))).length;
        if (left > 1) return items;
        const readsAtHold = left === 1 ? this.readsDone : undefined;
        const key = this.recordKey(recordId);
        const held = heldRemovals.get(key) ?? new Map<string, Held>();
        const send: Item[] = [];
        // The picks of a new record's first save that are still being linked count as saved: the record was saved with
        // them (see syncHost).
        const firstSave = this.hostSyncedFor === "" ? new Set(this.hostIds.split(",")) : null;
        for (const item of items) {
            // A pick still on its way isn't saved: undoing it is sent as usual.
            if (engine.isConfirmed(item.id) || firstSave?.has(item.id)) held.set(item.id, { item, holder: this, readsAtHold });
            else send.push(item);
        }
        if (held.size) heldRemovals.set(key, held);
        this.renderPeers(key);
        if (send.length < items.length && readsAtHold !== undefined) void this.loadSelected(this.initToken, true);
        // Its own count couldn't be trusted (see survivors): the hold is settled once the links are read again.
        else if (this.hostStale) this.scheduleResync();
        return send;
    }

    /** Whether a removal this instance holds still waits for a read of the saved links (see holdBackLast). */
    private checksPending(): boolean {
        const held = this.heldHere();
        if (!held) return false;
        for (const entry of held.values()) {
            if (entry.holder === this && entry.readsAtHold !== undefined && this.readsDone <= entry.readsAtHold) return true;
        }
        return false;
    }

    /**
     * The selected links of `recordId` known to stay saved, as far as the instances on the page know (see
     * SyncEngine.savedSelected): less `removing`, the values held back, and those another instance is removing. None
     * while this instance hasn't read the links since another one changed them (see hostStale): its count can't be
     * trusted then. An instance in another tab, or another user, isn't known here.
     */
    private survivors(recordId: string, removing: Set<string>): Item[] {
        if (!this.engine || this.hostStale) return [];
        const key = this.recordKey(recordId);
        const peers = this.recordPeers(key);
        const gone = new Set(removing);
        heldRemovals.get(key)?.forEach((_, id) => gone.add(id));
        for (const peer of peers) peer.engine?.removals().forEach((id) => gone.add(id));
        const found = new Map<string, Item>();
        for (const control of [this as NToNMultiSelect, ...peers.filter((peer) => !peer.hostStale)]) {
            for (const item of control.engine?.savedSelected() ?? []) {
                if (!gone.has(item.id)) found.set(item.id, item);
            }
        }
        return [...found.values()];
    }

    /** Picking a value whose removal is held back keeps it: nothing is sent for it (see holdBackLast). */
    private takeBack(items: Item[]): Item[] {
        const recordId = this.engine?.getRecordId();
        const key = recordId ? this.recordKey(recordId) : null;
        const held = key ? heldRemovals.get(key) : undefined;
        if (!key || !held) return items;
        const send: Item[] = [];
        for (const item of items) {
            if (!held.delete(item.id) || !this.engine?.isSelected(item.id)) send.push(item);
        }
        if (!held.size) heldRemovals.delete(key);
        this.renderPeers(key);
        return send;
    }

    /**
     * Sends the removals this instance holds back (see holdBackLast) once the field has another saved value, or isn't
     * required any more. Values no longer selected at all (the links were read again without them) are simply let go.
     */
    private releaseHeldBack(): void {
        const engine = this.engine;
        const recordId = engine?.getRecordId();
        const key = recordId ? this.recordKey(recordId) : null;
        const held = key ? heldRemovals.get(key) : undefined;
        if (!engine || !recordId || !key || !held) return;
        const required = this.hostField?.isRequired(recordId);
        const mine: Item[] = [];
        for (const [id, entry] of [...held]) {
            if (entry.holder !== this) continue;
            if (!engine.isSelected(id)) held.delete(id);
            // Not while it waits for a read of the saved links (see holdBackLast).
            else if (!required || entry.readsAtHold === undefined || this.readsDone > entry.readsAtHold) mine.push(entry.item);
        }
        if (!held.size) heldRemovals.delete(key);
        if (!mine.length) return;
        if (required && this.survivors(recordId, new Set()).length === 0) return;
        for (const item of mine) held.delete(item.id);
        if (!held.size) heldRemovals.delete(key);
        const version = engine.version;
        engine.setMany(mine, false);
        if (engine.version !== version) this.markPeersStale(engine);
        this.renderPeers(key);
    }

    /**
     * The removals this instance holds back, when it goes or starts again: another instance on the page that shows the
     * record takes them over; without one they are dropped, and the values stay on the record (see holdBackLast).
     */
    private handOverHeld(): void {
        const recordId = this.engine?.getRecordId();
        const key = recordId ? this.recordKey(recordId) : null;
        const held = key ? heldRemovals.get(key) : undefined;
        if (!key || !held) return;
        const heir = this.recordPeers(key)[0];
        for (const [id, entry] of [...held]) {
            if (entry.holder !== this) continue;
            if (!heir) {
                held.delete(id);
                continue;
            }
            entry.holder = heir;
            // A removal still waiting for a read waits for one of the new holder's.
            if (entry.readsAtHold !== undefined) {
                entry.readsAtHold = heir.readsDone;
                heir.scheduleResync();
            }
        }
        if (!held.size) heldRemovals.delete(key);
        this.renderPeers(key);
    }

    /** The removals held back on the record this instance shows (see heldRemovals). */
    private heldHere(): Map<string, Held> | undefined {
        const recordId = this.engine?.getRecordId();
        return recordId ? heldRemovals.get(this.recordKey(recordId)) : undefined;
    }

    /** How many held-back values this instance has selected: each gives its place to its replacement. */
    private heldCount(): number {
        const held = this.heldHere();
        let count = 0;
        held?.forEach((_, id) => {
            if (this.engine?.isSelected(id)) count++;
        });
        return count;
    }

    /** `items` without the values whose removal is held back (see holdBackLast). */
    private shown(items: Item[]): Item[] {
        const held = this.heldHere();
        return held?.size ? items.filter((item) => !held.has(item.id)) : items;
    }

    /**
     * Between the names in the host column: the "Names separator" of the copies of this field on the page (the same
     * relationship and column: in the header, on another tab, in a dialog), which share the column and the names copy
     * and so must agree, or each would put its own text back over the other's. The comma when they all say Comma,
     * otherwise the semicolon. Those with Copy names decide when there are any: the names copy plug-in reads only
     * those, and keeps the semicolon too when the forms don't agree.
     */
    private namesSeparator(): string {
        const host = this.hostField;
        const copies: NToNMultiSelect[] = [this];
        for (const control of liveControls) {
            if (control !== this && control.config && control.rel?.schemaName === this.rel?.schemaName && host?.sameColumn(control.hostField)) copies.push(control);
        }
        const copying = copies.filter((control) => control.copiesNames());
        return (copying.length > 0 ? copying : copies).every((control) => control.config?.namesSeparator === COMMA_SEPARATOR) ? COMMA_SEPARATOR : SEPARATOR;
    }

    /**
     * The names that a save of a kept state of this field on this form stores (an earlier instance went, see
     * letGoOfHeld), while that save may still wait for another OnSave handler before it builds its request (see building
     * in syncHost); undefined when there is none.
     */
    private keptSaveNames(recordId: string): string | null | undefined {
        const key = this.recordKey(recordId);
        for (const away of detached.values()) {
            const kept = away.kept;
            const save = kept && !kept.owner ? (kept.saving ?? kept.lateSaving) : undefined;
            if (!kept || away.key !== key || save?.names === undefined) continue;
            const entity = kept.bridge.followedEntity();
            if (entity && entity === this.bridge?.hostEntity(recordId) && kept.host.sameColumn(this.hostField) && kept.bridge.waitsForSaveHandlers()) return save.names;
        }
        return undefined;
    }

    /** The other instances on the page that show the links of `key` (see recordKey). */
    private recordPeers(key: string): NToNMultiSelect[] {
        return [...liveControls].filter((control) => {
            const shown = control.engine?.getRecordId();
            return control !== this && !control.destroyed && !!shown && control.recordKey(shown) === key;
        });
    }

    /** Draws the other instances that show the links of `key` again: what they leave out has changed. */
    private renderPeers(key: string): void {
        for (const control of this.recordPeers(key)) control.render();
    }

    /**
     * The other copies of this field on this unsaved form (a copy in the header, on another tab). Picks wait in each
     * copy until the record is saved, and each copy links its own then.
     */
    private unsavedPeers(): NToNMultiSelect[] {
        const host = this.hostField;
        if (!host) return [];
        return [...liveControls].filter((control) => {
            const engine = control.engine;
            if (control === this || !engine || engine.getRecordId() || !control.selectedLoaded || control.saveFirst) return false;
            return control.rel?.schemaName === this.rel?.schemaName && host.sameField(control.hostField);
        });
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
            let result: OpenFormResult | undefined;
            try {
                result = await navigation.openForm({ entityName: rel.targetEntity, useQuickCreateForm: true });
            } finally {
                // Quick create has closed: the field it left focused takes the focus back (see MultiSelectView.startCreate).
                if (!this.destroyed) this.view.createDone();
            }
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
            columns: config.listColumns,
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
        this.columnsFound = null;
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
                this.columnsFound = page.hasColumns === true;
                if (!page.nextLink) {
                    this.mode = "client";
                    this.allOptions = page.items;
                    // With "Search the columns under each option", the text under the name is searched too, as shown.
                    const searchesDetails = this.config?.listColumns.search === true;
                    this.allOptionsKeys = page.items.map((i) => searchKey(searchesDetails && i.details ? `${i.name}\n${i.details}` : i.name));
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
            this.loadingMore = false;
            this.loadMoreError = null;
            this.shownOptions = [];
            this.shownNext = null;
            this.optionsStatus = "ready";
            this.render();
            return;
        }
        if (immediate) {
            void this.serverSearch(trimmed);
            return;
        }
        // The rows on screen belong to the previous search. They go now rather than when the request starts, so that in
        // the meantime nothing of that search can act: a page of it still on its way is dropped, and a click, Enter or
        // Select all can't link its records under the new search text.
        this.searchToken++;
        this.loadingMore = false;
        this.loadMoreError = null;
        this.optionsStatus = "loading";
        this.shownOptions = [];
        this.shownNext = null;
        this.render();
        this.searchTimer = setTimeout(() => void this.serverSearch(trimmed), SEARCH_DEBOUNCE_MS);
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
        if (this.destroyed || !this.data || this.mode !== "server" || !this.shownNext || this.loadingMore) return;
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
        this.releaseHeldBack();
        const engine = this.engine;
        if (engine) {
            const recordId = engine.getRecordId();
            if (engine.version !== this.renderedVersion || recordId !== this.renderedRecordId) {
                this.renderedVersion = engine.version;
                this.renderedRecordId = recordId;
                this.cachedSelected = engine.selected();
                this.cachedSaved = recordId ? engine.savedSelected() : [];
                // Show the "saving" look only for real writes, not for values waiting for a new record's first save or for
                // the record's save (With the record).
                this.cachedPending = recordId ? engine.writingIds() : new Set<string>();
                this.cachedHeld = engine.placeHolders();
                this.cachedOccupied = this.cachedSelected.length + this.cachedHeld.size;
            }
        } else if (this.cachedSelected.length || this.cachedPending.size || this.cachedOccupied) {
            this.cachedSelected = [];
            this.cachedSaved = [];
            this.cachedPending = new Set<string>();
            this.cachedHeld = new Set<string>();
            this.cachedOccupied = 0;
            this.renderedVersion = -1;
        }
        const t = this.t;
        const mode = this.context.mode;
        const config = this.config;
        const max = config?.maxSelections ?? 0;
        // Records whose removal is still on its way count until it succeeded (see SyncEngine.occupiedCount); a value
        // whose removal is held back gives its place to the pick that replaces it (see holdBackLast).
        const occupied = this.cachedOccupied - this.heldCount();
        const maxReached = max > 0 && occupied >= max;

        // Select all only appears when every matching row is loaded, the setting allows it, the list is within the
        // limit (0 = as many as one load holds, 500) and selecting them all stays within Maximum selections.
        const allLoaded = this.mode === "client" || (this.mode === "server" && !this.shownNext && this.searchTerm.trim() !== "");
        const limit = config && config.selectAllLimit > 0 ? config.selectAllLimit : CLIENT_MODE_LIMIT;
        let canSelectAll = allLoaded && !!config?.showSelectAll && this.shownOptions.length > 0 && this.shownOptions.length <= limit;
        if (canSelectAll && max > 0 && engine) {
            const extra = this.shownOptions.filter((i) => !engine.occupies(i.id)).length;
            canSelectAll = occupied + extra <= max;
        }
        const note = max > 0 ? (maxReached ? t.maxReached(max) : t.maxNote(max)) : null;

        // No hint under the field (owner's choice): the field is read-only while offline, and picks held for a save show
        // as the form's own unsaved changes.
        const hint: string | null = null;

        const canCreate = !!config?.allowCreate && !!this.rel?.targetQuickCreate && !maxReached;
        const fatalError = this.fatalError ?? (this.saveFirst ? t.saveFirst : null);
        // "Open selected records" needs the related table from the metadata, and isn't offered while the control can't work.
        const openRecords = !!config?.openRecords && !!this.rel && !fatalError;
        this.view.render({
            selected: this.shown(this.cachedSelected),
            pending: this.cachedPending,
            held: this.cachedHeld,
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
            disabled: this.readOnly() || this.saveFirst || this.offline,
            label: mode.label || t.relatedRecords,
            placeholder: config?.placeholder ?? t.placeholder,
            error: this.error,
            hint,
            fatalError,
            createLabel: canCreate ? t.newRecord(this.rel!.targetDisplayName) : null,
            openOnClick: !!config?.openOnClick,
            openRecords,
            interceptLinks: openRecords && this.opensRecordsInApp(),
            withDetails: !!config && config.listColumns.source !== "none" && this.columnsFound !== false,
        });
        this.syncHost();
    }

    /**
     * Shows the picks in the host column on the control's own form (see HostField), once they are known. For a saved
     * record, those that are saved: a pick still on its way may yet fail, and a required column must not let the form
     * save the record meanwhile as if it had been made. Values whose removal is held back are left out (see
     * holdBackLast). For a new record, the picks held for its first save. Before
     * that, or when they can't be read, the column keeps the value the form has, so that a required column is never
     * filled or emptied by mistake; so it does while another instance has changed the links since this one read them
     * (see hostStale). Where picks can only be made once the record is saved, a required column would keep it from
     * being saved at all: its requirement is lifted until then.
     *
     * With "Selection on the form" = Event, the column's OnChange runs too when the selection changes, and a saved
     * record's column stands for its saved selection instead, once the changes being written are done: OnChange only
     * runs for changes that were saved, for a removal once it has gone through, and never for one that failed. Only a
     * required field whose saved values are all going (their removals are on their way, or held back) shows nothing at
     * once, as with No, so that the form's own check blocks the save. The selection worked out first for a record is no
     * change (the form has just opened); every later difference of its records is one, even under the same names. A new
     * record just saved compares with the picks of its first save, and reports no change while they are being linked;
     * once they are, OnChange runs if one ran meanwhile and saw other names. OnChange also runs when the names go back
     * over a value the form or a script put into the column, but not for the first names of a record or while a new
     * record's picks are being linked (see HostField.show).
     */
    private syncHost(): void {
        const host = this.hostField;
        if (!host) return;
        if (this.saveFirst) {
            host.liftRequirement();
            return;
        }
        host.restoreRequirement();
        const engine = this.engine;
        // Column security keeps the user from updating the column: it stays as the form shows it, as the field would.
        if (!engine || !this.selectedLoaded || this.fatalError || this.columnLocked()) return;
        const recordId = engine.getRecordId();
        // With the record: another copy of the field shows the record now, so its changes are saved at once (see
        // startHolding).
        if (recordId && this.hold?.engine === engine && this.recordPeers(this.recordKey(recordId)).length > 0) this.stopHolding();
        if (recordId && this.hostStale) return;
        const formSelection = this.config?.formSelection ?? "no";
        const key = recordId ?? "";
        // A new record just saved: the picks of its first save stay the ones to compare with, so the save is no change.
        // While they are still being linked (until the last write is back, a refused one too, and a write whose outcome
        // isn't known is settled by a read), the column shows the links saved so far, as for any saved record (the
        // record was saved without the names, so the form's refresh after the save finds the same value), and no change
        // is reported: the names coming back as the picks are linked are none either.
        const justSaved = key !== "" && this.hostSyncedFor === "";
        // (While changes wait for the record's save, only the first save's writes count: held changes aren't linking.)
        const linking = justSaved && ((engine.isHolding() ? engine.hasReleasedWork() : engine.hasPendingChanges()) || engine.isBusy() || engine.hasUncertain());
        const first = this.hostSyncedFor !== key && !justSaved;
        // With the record: the changes waiting for the record's save, and the writes once it is saved.
        const hold = recordId && this.hold?.engine === engine ? this.hold : null;
        const held = hold ? engine.heldChanges() : null;
        const waitingForSave = !!held && held.size > 0;
        // The field was hidden and shown again while a save that its earlier instance held changes for may still build
        // its request (Async save handler on, see letGoOfHeld): until that save reports, the column stays as that save
        // is to send it, while it still shows those names and this instance has no change of its own (not after a
        // Discard, nor once a change is made here; review of the fixes, fourth and fifth rounds).
        const keptNames = recordId && !waitingForSave ? this.keptSaveNames(recordId) : undefined;
        if (keptNames !== undefined && host.isDirty(recordId) === true && host.valueOn(recordId) === keptNames) return;
        const releasing = !!hold && !waitingForSave && !justSaved && engine.hasReleasedWork();
        let items: Item[] | null = recordId ? this.shown(this.cachedSaved) : this.picksOnUnsavedForm();
        if (waitingForSave || (releasing && formSelection !== "event")) {
            // The selection as the record's save is to have it: an unsaved change of the form (its own check and its
            // scripts see it), then while its changes are written.
            items = this.cachedSelected;
        } else if (recordId && formSelection === "event" && !linking && (items.length > 0 || !host.isRequired(recordId) || releasing)) {
            // (While the changes of a save are written, a required column keeps its names too: the save is done.)
            // The saved selection, once nothing is being written and every outcome is known (null: the column keeps what
            // it stands for meanwhile).
            if (!engine.isBusy() && !engine.hasPendingChanges() && !engine.hasUncertain()) items = this.cachedSelected;
            else if (!first) items = null;
        }
        const maxLength = (this.context.parameters.value as unknown as { attributes?: { MaxLength?: number } }).attributes?.MaxLength;
        const text = items ? namesText(items, maxLength, this.namesSeparator()) : this.hostText;
        const ids = items ? items.map((item) => item.id).sort().join() : this.hostIds;
        const changed = !first && !linking && ids !== this.hostIds;
        if (!linking) {
            this.hostSyncedFor = key;
            this.hostText = text;
            this.hostIds = ids;
        }
        // While the column waits for writes (items null), names put back run no OnChange either; once the writes are
        // done, OnChange answers what the handlers saw meanwhile (see HostField.show).
        const waiting = items === null;
        const settled = !linking && !waiting && (justSaved || this.hostWaited);
        this.hostWaited = waiting;
        let submit: SubmitMode = "never";
        if (held && waitingForSave) {
            // Unsaved until the control's own OnSave handler: changes that a save under way carries don't count again
            // (nor, without Copy names, those of a save that reports late, see lateSaving: the column stays out of it).
            // With the app's "Async save handler" on, a save that stores the names may still wait for another OnSave
            // handler and build its request only then: the column stays part of it, with what it carries, until it
            // reports (review of the fixes, third round).
            const building = !!hold?.saving && hold.saving.names !== undefined && hold.bridge.waitsForSaveHandlers();
            const carried = building ? undefined : hold?.saving?.changes ?? (hold && !hold.savesNames ? hold.lateSaving?.changes : undefined);
            for (const [id, change] of held) {
                if (carried?.get(id) !== change) {
                    submit = "dirty";
                    break;
                }
            }
        } else if (hold?.before && hold.savesNames) {
            // Write the links = Before, names stored: the save made again once the links are written carries the names.
            submit = "dirty";
        } else if (!recordId && this.config?.saveMode === "withRecord" && !this.newSaveInFlight && !(engine.isHolding() && !engine.hasHeldChanges())) {
            // A new record's picks: unsaved changes of the form until its first save (see onNewRecordSave). Not those that
            // a first save carries that hasn't said how it went (see onNewRecordSaveLate): it may still wait for an OnSave
            // handler of the app and then send the column with the record (fifth audit); a change made since counts.
            submit = "dirty";
        }
        // When the names equal the value the form compares the column with (what it read when the record opened, or just
        // after a save, before the links were written; or the column is too short, or two records share a name), the form
        // can't show the changes as unsaved: they still wait for the next save, like any other (owner, 2026-11-05).
        host.show(recordId, text, ids, formSelection === "event" ? { changed, first, quiet: first || linking || waiting, linked: settled } : null, submit);
    }

    /**
     * The picks held by this copy of the field and the others on this unsaved form (see unsavedPeers), each record once:
     * all of them are linked when the record is saved, so the column shows them all, and no copy empties or replaces
     * what another one holds.
     */
    private picksOnUnsavedForm(): Item[] {
        const peers = this.unsavedPeers();
        if (peers.length === 0) return this.cachedSelected;
        const byId = new Map<string, Item>();
        for (const control of [this, ...peers]) {
            for (const item of control.cachedSelected) byId.set(item.id, item);
        }
        return [...byId.values()].sort(compareItems);
    }
}

/** True when both lists hold the same records (in the same, sorted order). */
function sameIds(a: Item[], b: Item[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    return a.every((item, i) => item.id === b[i].id);
}

/**
 * The class of the first copy of this bundle on the page whose code is the same as this copy's, when this copy isn't
 * that one. The platform can load the bundle more than once on a page: when a hidden field is shown again, it adds the
 * bundle again from another address (measured live, fifth audit SAVE-HANDOFF-01), and each load makes its own
 * copy of every module. Instances of different copies wouldn't see what the instances of a page share here (the picks a
 * hidden field leaves on an unsaved record, the save rounds of a form, writes still on their way), so a later copy makes
 * its instances with the first copy's class (see the constructor). A copy whose class has other code (a newer version
 * loaded while the page stays open) makes its own instances; one whose changes are all outside the class makes the first
 * copy's until the page reloads, so the page stays on one build.
 */
let firstCopy: typeof NToNMultiSelect | null = null;

// Also expose the constructor as window.KV.NToNMultiSelect and register it by name. The platform normally loads
// this bundle itself; in environments that send the control to the form without its resources, the form library
// (formloader.js) loads it instead and checks these to see that the control is ready.
(function registerGlobally(): void {
    const w = window as unknown as {
        KV?: Record<string, unknown>;
        ComponentFramework?: { registerControl?: (name: string, ctor: unknown) => void };
    } & Record<string, unknown>;
    const copies = (w[`${CONTROL_NAME} copies`] ??= []) as (typeof NToNMultiSelect)[];
    const code = NToNMultiSelect.toString();
    firstCopy = copies.find((copy) => copy !== NToNMultiSelect && copy.toString() === code) ?? null;
    if (!firstCopy) copies.push(NToNMultiSelect);
    w.KV = w.KV || {};
    w.KV.NToNMultiSelect = NToNMultiSelect;
    try {
        w.ComponentFramework?.registerControl?.(CONTROL_NAME, NToNMultiSelect);
    } catch {
        // ignore – the default lookup above still works
    }
})();
