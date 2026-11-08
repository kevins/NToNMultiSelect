import { normalizeId } from "./types";

/* The parts of the model-driven client API for the host column (FormBridge has those for subgrids and saves). */
interface XrmFieldControl {
    getControlType?(): string;
    getDisabled?(): boolean;
    setDisabled?(disabled: boolean): void;
}

interface XrmAttribute {
    getValue(): unknown;
    setValue(value: string | null): void;
    fireOnChange?(): void;
    addOnChange?(handler: () => void): void;
    removeOnChange?(handler: () => void): void;
    getSubmitMode?(): string;
    setSubmitMode?(mode: string): void;
    getIsDirty?(): boolean;
    getRequiredLevel?(): string;
    setRequiredLevel?(level: string): void;
    controls?: { get(): XrmFieldControl[] };
}

interface XrmProcess {
    addOnStageChange?(handler: () => void): void;
    removeOnStageChange?(handler: () => void): void;
    addOnStageSelected?(handler: () => void): void;
    removeOnStageSelected?(handler: () => void): void;
}

interface XrmHostForm {
    data?: {
        entity?: { getId(): string; getEntityName(): string };
        process?: XrmProcess | null;
    };
    getAttribute?(name: string): XrmAttribute | null;
}

/** window.Xrm of one page: the app has one for the page and one for each dialog or quick create form over it. */
export interface XrmPage {
    Page?: XrmHostForm;
}

/** window.Xrm now: that of the form the app shows on top (see HostField). */
export function currentPage(): XrmPage | null {
    return (window as unknown as { Xrm?: XrmPage }).Xrm ?? null;
}

/** The control's own type as the client API names it, of any publisher: "customcontrol:<namespace>.NToNMultiSelect". */
const OWN_CONTROL = /\.NToNMultiSelect$/i;

/** The copies of a host column on one form that need its requirement lifted (see HostField.liftRequirement). */
interface Lift {
    /** The column whose requirement is lifted, or null while it isn't. */
    attribute: XrmAttribute | null;
    copies: Set<HostField>;
}

/** By window.Xrm of the form (see currentPage), then by table and column. */
const lifts = new WeakMap<object, Map<string, Lift>>();

/**
 * Names put back in a row (see HostField.show), each within PUT_BACK_WINDOW_MS of the one before, run OnChange at most
 * this many times, per record; the count starts again after PUT_BACK_WINDOW_MS without one.
 */
const PUT_BACK_LIMIT = 3;
const PUT_BACK_WINDOW_MS = 2000;

/**
 * Whether the form saves the column: "never" (the names are only shown), or "dirty" while changes wait for the record's
 * save ("Save the selection" = With the record): the form then shows unsaved changes, until the control's own OnSave
 * handler switches the column back to "never" (see markNever), so the form never writes it.
 */
export type SubmitMode = "never" | "dirty";

/** With "Selection on the form" = Event, what HostField.show tells the form. */
export interface Report {
    /** The records changed since the copy last showed them. */
    changed: boolean;
    /** The first names this copy shows for the record: what an earlier form noted for it (see Shown) is dropped. */
    first: boolean;
    /**
     * The first names shown for the record, a new record's picks still being linked, or names kept while writes are on
     * their way: names put back run no OnChange.
     */
    quiet: boolean;
    /**
     * A new record's picks have just been linked, or the writes the names were kept for are done: OnChange runs if its
     * last run saw other names (see Shown.saw).
     */
    linked: boolean;
}

/** What the column showed last on the form of a record (see HostField.show). */
interface Shown {
    recordId: string | null;
    /** The records, as sorted ids: a change of them counts even when the names stay the same (a column too short). */
    ids: string;
    /** The value the control set. */
    value: string | null;
    /** An OnChange ran since, while the column held another value than `value`: its handlers saw that value. */
    seen?: boolean;
    /** The column's value when its OnChange last ran, as far as the control knows (undefined: none yet). */
    saw?: string | null;
    /** The names put back in a row that ran OnChange (see PUT_BACK_LIMIT), and when the last one was put back. */
    putBacks: number;
    lastPutBack?: number;
}

/**
 * What the column showed last, by window.Xrm of the form, then by table and column. The copies of the field on the
 * form share it, so they report a change once between them.
 */
const shownSelections = new WeakMap<object, Map<string, Shown>>();

/**
 * The host column on the control's own form. Its value there follows the picks (their names, as the names copy writes
 * them), marked never to be saved by the form: the form doesn't write the column and isn't made dirty by it, but still
 * checks it like any column. Whatever makes the column required (Business required, a business rule, a required step
 * of a business process flow) then blocks saving or moving to the next stage until something is picked, with the
 * form's own messages. The column's other controls on the form (in the header, in a stage of the process) are made
 * read-only, so that typing there can't stand in for picks. While the control can't hold picks before the record is
 * saved, the requirement is lifted instead, so that the record can be created at all. The copies of the field on the
 * form share the column, so they share that too: the requirement comes back once the last copy that needs it lifted
 * is done. With "Selection on the form" = Event, show also runs the column's OnChange when the selection changes.
 *
 * The form is the one of the page the control was created on: the app gives each dialog and quick create form a
 * window.Xrm of its own, in place of the page's while it is on top, so the control keeps the one it found when it
 * started. A side pane doesn't get one: a control there finds the page's form, which is used only when it shows the
 * same record.
 */
export class HostField {
    /** The host column locked last, and the process whose stage changes lock it again. */
    private locked: XrmAttribute | null = null;
    private process: XrmProcess | null = null;
    private readonly lockAgain = (): void => {
        if (this.locked) lockCopies(this.locked);
    };
    /** The host column whose OnChange is watched (with Event, see show). */
    private watched: XrmAttribute | null = null;
    /** With every OnChange of the column (the form's own, a script's, the control's): what did its handlers see? */
    private readonly watch = (): void => {
        const shown = this.page ? shownSelections.get(this.page)?.get(`${this.entityName}|${this.column}`) : undefined;
        if (!this.watched || !shown) return;
        try {
            const value = (this.watched.getValue() as string | null | undefined) ?? null;
            shown.saw = value;
            if (value !== shown.value) shown.seen = true;
        } catch {
            // The form is being closed.
        }
    };

    constructor(
        /** window.Xrm when the control was created (see currentPage). */
        private readonly page: XrmPage | null,
        private readonly entityName: string,
        private readonly column: string,
    ) {}

    /** Whether `other` is the same column on the same form: another copy of the field there. */
    public sameField(other: HostField | null): boolean {
        return !!other && other.page === this.page && other.entityName === this.entityName && other.column === this.column;
    }

    /** Whether `other` is bound to the same column of the same table, on any form of the page (see sameField). */
    public sameColumn(other: HostField | null): boolean {
        return !!other && other.entityName === this.entityName && other.column === this.column;
    }

    /** The column's value on the form of `recordId` (undefined when the form isn't found). */
    public valueOn(recordId: string | null): string | null | undefined {
        const attribute = this.attribute(recordId);
        try {
            return attribute ? ((attribute.getValue() as string | null | undefined) ?? null) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Whether the column is on the form of `recordId` (see attribute). */
    public isOnForm(recordId: string | null): boolean {
        return !!this.attribute(recordId);
    }

    /** Whether the column is required on the form of `recordId`: Business required, or made so by a rule or script. */
    public isRequired(recordId: string | null): boolean {
        try {
            return this.attribute(recordId)?.getRequiredLevel?.() === "required";
        } catch {
            return false;
        }
    }

    /** The host column on the form, when the form shows `recordId` (null: a new record of the control's table). */
    private attribute(recordId: string | null): XrmAttribute | null {
        try {
            const form = this.page?.Page;
            const entity = form?.data?.entity;
            if (!form || !entity || entity.getEntityName().toLowerCase() !== this.entityName) return null;
            if ((normalizeId(entity.getId()) || null) !== recordId) return null;
            return form.getAttribute?.(this.column) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Shows `text` (the names of the records `ids`, or null for none) as the column's value on the form of `recordId`,
     * and makes the column's other controls there read-only. False when that form isn't found.
     *
     * With a `report` ("Selection on the form" = Event) it also runs the column's OnChange:
     * - when the records `changed`, for a new value or new records under the same names, unless another copy of the
     *   field has shown them already;
     * - when it puts the names back over a value something else put into the column since (the form's refresh after a
     *   save or a reload, Discard, a script) while an OnChange ran (see watch), so that the last OnChange sees the
     *   selection; not while `quiet`. A handler that rewrites the column in that very OnChange gets the names back
     *   without another one (its OnChange is noted on what show is about to replace). One that rewrites it each time a
     *   moment later gets PUT_BACK_LIMIT runs in a row, then the names back without OnChange, so it isn't started again;
     * - when a new record's picks are `linked`, or the writes the names were kept for are done, and the last OnChange saw
     *   other names (see Shown.saw).
     *
     * `submit` "dirty": the names are changes waiting for the record's save (see SubmitMode).
     */
    public show(recordId: string | null, text: string | null, ids: string, report: Report | null = null, submit: SubmitMode = "never"): boolean {
        const attribute = this.attribute(recordId);
        if (!attribute) return false;
        if (report) this.watchOnChange(attribute);
        const before = report?.first ? undefined : this.shownOn(recordId);
        const now = Date.now();
        const inRow = before?.lastPutBack !== undefined && now - before.lastPutBack < PUT_BACK_WINDOW_MS;
        let putBacks = inRow ? before.putBacks : 0;
        let lastPutBack = before?.lastPutBack;
        let told = false;
        try {
            // First, so that the value counts as a change to save only while it waits for the save (see SubmitMode).
            if (attribute.getSubmitMode?.() !== submit) attribute.setSubmitMode?.(submit);
            const value = (attribute.getValue() as string | null | undefined) ?? null;
            const newValue = value !== text;
            if (newValue) attribute.setValue(text);
            if (report) {
                const change = report.changed && (newValue || before?.ids !== ids);
                const putBack = !report.quiet && !!before?.seen && newValue && value !== before.value;
                if (putBack) lastPutBack = now;
                const answer = putBack && !change && putBacks < PUT_BACK_LIMIT;
                if (answer) putBacks++;
                told = change || answer || (report.linked && before?.saw !== undefined && before.saw !== text);
                if (told) attribute.fireOnChange?.();
            }
        } catch {
            // The form is being closed.
        }
        this.noteShown({ recordId, ids, value: text, saw: told ? text : before?.saw, putBacks, lastPutBack });
        this.lock(attribute);
        return true;
    }

    /**
     * The form is saving (OnSave): the column isn't part of the save. Its value stays, so scripts in OnSave and the
     * form's check still see the names.
     */
    public markNever(recordId: string | null): void {
        const attribute = this.attribute(recordId);
        try {
            if (attribute && attribute.getSubmitMode?.() !== "never") attribute.setSubmitMode?.("never");
        } catch {
            // The form is being closed.
        }
    }

    /**
     * Whether the column counts as an unsaved change on the form of `recordId`; null when the form doesn't say. The form
     * compares the value with the one it loaded: names equal to those make no change.
     */
    public isDirty(recordId: string | null): boolean | null {
        const attribute = this.attribute(recordId);
        try {
            const dirty = attribute?.getIsDirty?.();
            return typeof dirty === "boolean" ? dirty : null;
        } catch {
            return null;
        }
    }

    /** The new record on the form was saved as `recordId`: what its column showed there is that record's now. */
    public saved(recordId: string): void {
        const shown = this.shownOn(null);
        if (shown) shown.recordId = recordId;
    }

    /** Watches the OnChange of `attribute`, the column on the form (see watch). */
    private watchOnChange(attribute: XrmAttribute): void {
        if (attribute === this.watched) return;
        this.unwatch();
        try {
            attribute.addOnChange?.(this.watch);
            this.watched = attribute;
        } catch {
            // The form is being closed.
        }
    }

    private unwatch(): void {
        try {
            this.watched?.removeOnChange?.(this.watch);
        } catch {
            // The form is being closed.
        }
        this.watched = null;
    }

    /** What the column showed last on the form of `recordId` (see shownSelections). */
    private shownOn(recordId: string | null): Shown | undefined {
        const shown = this.page ? shownSelections.get(this.page)?.get(`${this.entityName}|${this.column}`) : undefined;
        return shown?.recordId === recordId ? shown : undefined;
    }

    private noteShown(shown: Shown): void {
        if (!this.page) return;
        let byColumn = shownSelections.get(this.page);
        if (!byColumn) shownSelections.set(this.page, (byColumn = new Map()));
        byColumn.set(`${this.entityName}|${this.column}`, shown);
    }

    /** What the copies of the column on this form share about its lifted requirement; null without a form. */
    private lift(create: boolean): Lift | null {
        if (!this.page) return null;
        let byColumn = lifts.get(this.page);
        if (!byColumn) {
            if (!create) return null;
            lifts.set(this.page, (byColumn = new Map()));
        }
        const key = `${this.entityName}|${this.column}`;
        let lift = byColumn.get(key) ?? null;
        if (!lift && create) byColumn.set(key, (lift = { attribute: null, copies: new Set() }));
        return lift;
    }

    /**
     * Lifts a requirement of the column on the form of the new record until restoreRequirement. A requirement another
     * copy of the field lifted stays lifted until this copy gives it back too.
     */
    public liftRequirement(): void {
        const attribute = this.attribute(null);
        const lift = attribute && this.lift(true);
        if (!attribute || !lift) return;
        try {
            if (attribute.getRequiredLevel?.() === "required") {
                attribute.setRequiredLevel?.("none");
                lift.attribute = attribute;
            }
        } catch {
            // The form is being closed.
            return;
        }
        if (lift.attribute) lift.copies.add(this);
    }

    /** Gives back this copy's part of a lifted requirement: the last copy to give it back restores it. */
    public restoreRequirement(): void {
        const lift = this.lift(false);
        if (!lift?.copies.delete(this) || lift.copies.size > 0) return;
        const attribute = lift.attribute;
        lift.attribute = null;
        try {
            // Unless something else (a business rule, a script) has set a level of its own since.
            if (attribute?.getRequiredLevel?.() === "none") attribute.setRequiredLevel?.("required");
        } catch {
            // The form is being closed.
        }
    }

    public dispose(): void {
        this.restoreRequirement();
        this.dropProcess();
        this.unwatch();
        this.locked = null;
    }

    private lock(attribute: XrmAttribute): void {
        lockCopies(attribute);
        if (attribute === this.locked) return;
        this.locked = attribute;
        // A business process flow makes the controls of a stage when it moves to the stage, or when one is selected.
        const process = this.page?.Page?.data?.process ?? null;
        if (process === this.process) return;
        this.dropProcess();
        try {
            process?.addOnStageChange?.(this.lockAgain);
            process?.addOnStageSelected?.(this.lockAgain);
            this.process = process;
        } catch {
            // No process on this form.
        }
    }

    private dropProcess(): void {
        try {
            this.process?.removeOnStageChange?.(this.lockAgain);
            this.process?.removeOnStageSelected?.(this.lockAgain);
        } catch {
            // The form is being closed.
        }
        this.process = null;
    }
}

/** Makes every control of `attribute` read-only but those of N:N Multi-Select itself. */
function lockCopies(attribute: XrmAttribute): void {
    let controls: XrmFieldControl[];
    try {
        controls = attribute.controls?.get() ?? [];
    } catch {
        return;
    }
    for (const control of controls) {
        try {
            if (OWN_CONTROL.test(control.getControlType?.() ?? "")) continue;
            if (control.getDisabled?.() !== true) control.setDisabled?.(true);
        } catch {
            // A control that isn't fully made yet: locked at the next update.
        }
    }
}
