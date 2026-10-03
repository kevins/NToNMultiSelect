import { normalizeId } from "./types";

/* Minimal typings for the parts of the model-driven client API the control uses. Everything is optional because the
   control must keep working (without subgrid sync) in hosts where Xrm is not available. */
interface XrmGridControl {
    getName(): string;
    getControlType(): string;
    getRelationship?(): { name?: string; navigationPropertyName?: string } | null;
    getVisible?(): boolean;
    setVisible?(visible: boolean): void;
    refresh(): void;
    addOnLoad?(handler: () => void): void;
    removeOnLoad?(handler: () => void): void;
}

interface XrmFormContext {
    data?: {
        entity?: {
            getId(): string;
            getEntityName(): string;
            addOnPostSave?(handler: (ctx: unknown) => void): void;
            removeOnPostSave?(handler: (ctx: unknown) => void): void;
            addOnSave?(handler: (ctx: unknown) => void): void;
            removeOnSave?(handler: (ctx: unknown) => void): void;
        };
    };
    ui?: {
        controls?: { get(): XrmGridControl[] };
        getFormType?(): number;
    };
    getControl?(name: string): XrmGridControl | null;
}

function formContext(): XrmFormContext | null {
    const xrm = (window as unknown as { Xrm?: { Page?: XrmFormContext } }).Xrm;
    const page = xrm?.Page;
    return page && page.data && page.data.entity ? page : null;
}

/** The part of the save event arguments (executionContext.getEventArgs() in OnSave) the control reads. */
interface SaveEventArgs {
    isDefaultPrevented?(): boolean;
}

function saveEventArgs(ctx: unknown): SaveEventArgs | null {
    try {
        return (ctx as { getEventArgs?(): SaveEventArgs | null } | null)?.getEventArgs?.() ?? null;
    } catch {
        return null;
    }
}

/** Containers in which the page-level form API (Xrm.Page) describes another form than the control's. */
const OVERLAY = '[role="dialog"], [aria-modal="true"], [data-id*="quickCreate" i], [id*="quickCreate" i], [data-id*="sidePane" i]';

/**
 * Connects the control to the surrounding form: refreshes the related subgrids when the control asks (once a burst
 * of changes is saved), follows changes made through those subgrids, hides them when the control takes their place,
 * and reports when a new record has been saved.
 */
export class FormBridge {
    private gridHandlers: { grid: XrmGridControl; handler: () => void }[] = [];
    private postSaveHandler: ((ctx: unknown) => void) | null = null;
    private saveHandler: ((ctx: unknown) => void) | null = null;
    private postSaveEntity: NonNullable<NonNullable<XrmFormContext["data"]>["entity"]> | null = null;
    /** The last save of the tracked form (OnSave) started while it was still a new record, without an id. */
    private savingNew = false;
    /** The event arguments of that save, which tell whether a handler cancelled it. */
    private saveArgs: SaveEventArgs | null = null;

    constructor(
        private readonly entityName: string,
        private readonly relationshipName: string,
        private explicitSubgrids: string[],
        /** The control's own DOM element, used to tell the page form apart from quick create panes and dialogs. */
        private readonly element: HTMLElement | null = null,
        /**
         * For a self-referencing relationship both sides share one relationship name, so subgrids are matched on
         * the navigation property too (when the client reports it), to leave the other side's grid alone.
         */
        private readonly selfReferencingNavigation: string | null = null,
        /**
         * Names of the subgrids hidden by "Hide related subgrids". The control owns the set and hands it to every
         * bridge it makes, so it outlives a restart (for example for another record) and only grids the control hid
         * are ever shown again.
         */
        private readonly hiddenGrids = new Set<string>(),
    ) {}

    public setSubgrids(names: string[]): void {
        this.unwatchSubgrids();
        this.explicitSubgrids = names;
    }

    /** "Subgrids to refresh" = none: subgrids are neither refreshed nor followed. */
    private syncOff(): boolean {
        return this.explicitSubgrids.length === 1 && this.explicitSubgrids[0].toLowerCase() === "none";
    }

    /**
     * True when the control is rendered on the page's own form. In a quick create pane, a dialog or a side pane the
     * page-level form API (Xrm.Page) describes a different record, so it must not be used for save tracking.
     */
    private onPageForm(): boolean {
        if (!this.element) return true;
        // Not on the page yet means its place can't be known; "no" is the safe answer (the control then asks the
        // user to save first instead of possibly following another form's save).
        if (!this.element.isConnected) return false;
        return !this.inOverlay();
    }

    /** True when the control is on the page inside a quick create pane, a dialog or a side pane. */
    private inOverlay(): boolean {
        if (!this.element?.isConnected) return false;
        try {
            return !!this.element.closest(OVERLAY);
        } catch {
            return false;
        }
    }

    /**
     * Waits (briefly) until the control's element is on the page, so onPageForm() can tell a quick create pane or
     * dialog apart from the main form. The platform sometimes calls init before the container is attached.
     */
    public async waitUntilPlaced(timeoutMs = 3000): Promise<void> {
        const element = this.element;
        if (!element || element.isConnected) return;
        const start = Date.now();
        while (!element.isConnected && Date.now() - start < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    /** The form entity object whose OnPostSave is being tracked (identity used to hand over picks between instances). */
    public trackedEntity(): object | null {
        return this.postSaveEntity;
    }

    /** Returns the form only if it is the one hosting this control (same table and, when known, same record). */
    private form(recordId: string | null): XrmFormContext | null {
        // Under a dialog or side pane the page form is the one underneath, even when it shows the same record.
        if (this.inOverlay()) return null;
        const form = formContext();
        const entity = form?.data?.entity;
        if (!form || !entity) {
            return null;
        }
        try {
            if (entity.getEntityName().toLowerCase() !== this.entityName) {
                return null;
            }
            if (recordId && normalizeId(entity.getId()) && normalizeId(entity.getId()) !== recordId) {
                return null;
            }
        } catch {
            return null;
        }
        return form;
    }

    /**
     * The page form only when it certainly hosts this control: the same saved record or, for a new record (no id to
     * compare), an unsaved record of this table with the control on the page itself rather than in a quick create
     * pane or dialog over it. Used where acting on the wrong form would be visible, such as hiding its subgrids.
     */
    private hostForm(recordId: string | null): XrmFormContext | null {
        if (!recordId) {
            return this.newRecordForm();
        }
        const form = this.form(recordId);
        try {
            return form && normalizeId(form.data?.entity?.getId()) === recordId ? form : null;
        } catch {
            return null;
        }
    }

    /** The page form, when it is an unsaved record of this table and the control is on it (see onPageForm). */
    private newRecordForm(): XrmFormContext | null {
        const form = this.form(null);
        const entity = form?.data?.entity;
        if (!form || !entity || !this.onPageForm()) {
            return null;
        }
        try {
            if (normalizeId(entity.getId())) {
                return null; // the page form is an existing record, so it is not the form hosting this new record
            }
            const formType = form.ui?.getFormType?.();
            return formType === undefined || formType === 1 ? form : null;
        } catch {
            return null;
        }
    }

    /** The form entity object of the saved record `recordId`, when the page form is the one hosting this control. */
    public hostEntity(recordId: string): object | null {
        return this.hostForm(recordId)?.data?.entity ?? null;
    }

    public subgrids(recordId: string | null): XrmGridControl[] {
        // "Subgrids to refresh" = none turns subgrid syncing off completely.
        return this.syncOff() ? [] : this.relatedSubgrids(this.form(recordId), this.explicitSubgrids);
    }

    /** The subgrids named in `names` or, without names, every subgrid on `form` that shows this relationship. */
    private relatedSubgrids(form: XrmFormContext | null, names: string[]): XrmGridControl[] {
        if (!form) {
            return [];
        }
        const found = new Map<string, XrmGridControl>();
        for (const name of names) {
            const control = form.getControl?.(name);
            if (control && typeof control.refresh === "function") {
                found.set(control.getName(), control);
            }
        }
        if (names.length === 0) {
            let controls: XrmGridControl[] = [];
            try {
                controls = form.ui?.controls?.get() ?? [];
            } catch {
                controls = [];
            }
            for (const control of controls) {
                try {
                    if (control.getControlType() !== "subgrid" || typeof control.getRelationship !== "function") {
                        continue;
                    }
                    const relationship = control.getRelationship();
                    if (!relationship?.name || relationship.name.toLowerCase() !== this.relationshipName.toLowerCase()) {
                        continue;
                    }
                    const navigation = relationship.navigationPropertyName;
                    if (this.selfReferencingNavigation && navigation && navigation.toLowerCase() !== this.selfReferencingNavigation.toLowerCase()) {
                        continue;
                    }
                    found.set(control.getName(), control);
                } catch {
                    // Ignore controls that are not fully initialised yet.
                }
            }
        }
        return [...found.values()];
    }

    /** Refreshes the related subgrids and returns how many were refreshed (each will fire OnLoad once). */
    public refreshSubgrids(recordId: string | null): number {
        let refreshed = 0;
        for (const grid of this.subgrids(recordId)) {
            try {
                // Nobody sees a grid this control hid, so reloading it would be a wasted request.
                if (this.hiddenGrids.has(grid.getName())) continue;
                grid.refresh();
                refreshed++;
            } catch {
                // A grid that is collapsed/not rendered yet will load fresh data when shown.
            }
        }
        return refreshed;
    }

    /**
     * "Hide related subgrids": hides the subgrids this control takes the place of, which are the ones named in
     * Subgrids to refresh or, when that is empty or none, every subgrid on the form that shows the relationship.
     * Only visible grids are hidden (and remembered), so a grid that the form designer or a script hid is never the
     * control's to show again. Safe to call repeatedly: grids that register later are hidden too.
     */
    public hideSubgrids(recordId: string | null): void {
        const form = this.hostForm(recordId);
        for (const grid of this.relatedSubgrids(form, this.syncOff() ? [] : this.explicitSubgrids)) {
            try {
                if (typeof grid.setVisible !== "function" || grid.getVisible?.() !== true) continue;
                grid.setVisible(false);
                this.hiddenGrids.add(grid.getName());
            } catch {
                // Ignore controls that are not fully initialised yet.
            }
        }
    }

    /** Shows again the subgrids this control hid (Hide related subgrids was turned off) and returns how many. */
    public showHiddenSubgrids(recordId: string | null): number {
        if (!this.hiddenGrids.size) {
            return 0;
        }
        const form = this.hostForm(recordId);
        let shown = 0;
        for (const name of [...this.hiddenGrids]) {
            try {
                const grid = form?.getControl?.(name);
                if (typeof grid?.setVisible !== "function") continue;
                grid.setVisible(true);
                this.hiddenGrids.delete(name);
                shown++;
            } catch {
                // Still remembered, so the next call tries again.
            }
        }
        return shown;
    }

    /**
     * Calls `handler` whenever a synced subgrid (re)loads, e.g. after Add Existing / Remove in the grid.
     * Safe to call repeatedly: grids that are already watched are skipped, grids that appeared later are added.
     */
    public watchSubgrids(recordId: string | null, handler: () => void): void {
        for (const grid of this.subgrids(recordId)) {
            if (typeof grid.addOnLoad !== "function" || this.gridHandlers.some((h) => h.grid === grid)) {
                continue;
            }
            try {
                grid.addOnLoad(handler);
                this.gridHandlers.push({ grid, handler });
            } catch {
                // ignore
            }
        }
    }

    public unwatchSubgrids(): void {
        for (const { grid, handler } of this.gridHandlers) {
            try {
                grid.removeOnLoad?.(handler);
            } catch {
                // ignore
            }
        }
        this.gridHandlers = [];
    }

    /**
     * Calls `handler(newId)` once, after the form has saved the new record (used to write pending links for a
     * brand-new record). Only attaches to an unsaved create form of the control's own table; returns false otherwise
     * (for example on a quick create form, where the page-level form API describes a different record).
     */
    public onPostSave(handler: (recordId: string) => void): boolean {
        const entity = this.newRecordForm()?.data?.entity;
        if (!entity || typeof entity.addOnPostSave !== "function") {
            return false;
        }
        this.removePostSave();
        this.saveArgs = null;
        if (typeof entity.addOnSave === "function") {
            this.savingNew = false;
            this.saveHandler = (ctx) => {
                this.saveArgs = saveEventArgs(ctx);
                try {
                    // A form that already has an id saves an update, or another record it moved on to.
                    this.savingNew = !normalizeId(entity.getId());
                } catch {
                    this.savingNew = true; // can't tell
                }
            };
            entity.addOnSave(this.saveHandler);
        } else {
            this.savingNew = true; // can't tell; assume an id change means a save
        }
        let reported = false;
        this.postSaveHandler = () => {
            // Later saves of the same form are updates of that record, or saves of another record the form moved on
            // to: the handler stays attached until dispose, but only the save that creates the record is reported.
            if (reported) return;
            try {
                const id = normalizeId(entity.getId());
                if (id && this.savingNew) {
                    reported = true;
                    handler(id);
                } else if (!id && this.saveHandler) {
                    // The save failed: only a later save (OnSave again) can still create the record.
                    this.savingNew = false;
                }
            } catch {
                // ignore
            }
        };
        entity.addOnPostSave(this.postSaveHandler);
        this.postSaveEntity = entity;
        return true;
    }

    /**
     * True when a save of the tracked new-record form that neither failed nor was cancelled made it the given record.
     * Used to tell a real first save apart from the control being moved to some other existing record.
     */
    public savedAs(recordId: string): boolean {
        if (!this.postSaveEntity || !this.savingNew) return false;
        try {
            return this.saveArgs?.isDefaultPrevented?.() !== true && normalizeId(this.postSaveEntity.getId()) === recordId;
        } catch {
            return false;
        }
    }

    public removePostSave(): void {
        if (!this.postSaveHandler) {
            return;
        }
        try {
            this.postSaveEntity?.removeOnPostSave?.(this.postSaveHandler);
            if (this.saveHandler) this.postSaveEntity?.removeOnSave?.(this.saveHandler);
        } catch {
            // ignore
        }
        this.postSaveHandler = null;
        this.saveHandler = null;
        this.postSaveEntity = null;
    }

    public dispose(): void {
        this.unwatchSubgrids();
        this.removePostSave();
    }
}
