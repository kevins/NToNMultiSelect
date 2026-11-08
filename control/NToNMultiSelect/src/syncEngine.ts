import { Item, compareItems } from "./types";

export interface SyncExecutor {
    associate(recordId: string, targetId: string): Promise<void>;
    disassociate(recordId: string, targetId: string): Promise<void>;
    /** Reads the links saved on the server (see SyncEngine.release: a required column's last saved value). */
    readSaved?(recordId: string): Promise<Item[]>;
}

export interface SyncCallbacks {
    /** Desired selection or pending state changed – re-render. */
    onChange(): void;
    /** A batch of server writes finished; `changed` is true when at least one write succeeded. */
    onSettled(changed: boolean): void;
    /**
     * A write failed and the item was rolled back to its saved state. Returns true when the write may have been saved
     * all the same (the connection dropped or it timed out): an add then keeps its place toward Maximum selections
     * until a read of the saved links (setConfirmed) settles it.
     */
    onError(item: Item, operation: "add" | "remove", error: unknown): boolean | void;
    /**
     * While holding (see SyncEngine.hold): whether a change whose write failed with `error` waits for the next release
     * instead of being rolled back (a passing problem: offline, too slow, busy). Asked before onError.
     */
    holdsAfterError?(error: unknown): boolean;
    /**
     * The read of the saved links that released changes waited for failed (see SyncEngine.release): `changes` were not
     * written. As when a write fails that way, they wait for the next release when holdsAfterError says so, and are
     * put back otherwise.
     */
    onCheckFailed?(changes: { item: Item; change: LinkChange }[], error: unknown): void;
}

const MAX_PARALLEL = 4;

/** A change of one record's link: added or taken away. */
export type LinkChange = "add" | "remove";

/**
 * Keeps the server's N:N links in line with what the user picked.
 *
 * The UI only ever edits the *desired* set. A worker compares it with the *confirmed* (saved) set and
 * performs the missing associate/disassociate calls – at most MAX_PARALLEL at once and never two for the
 * same item. Because it reconciles state instead of replaying clicks, rapid toggling (add → remove → add)
 * collapses to the minimum number of requests, and nothing is lost or duplicated.
 */
export class SyncEngine {
    private confirmed = new Map<string, Item>();
    private desired = new Map<string, Item>();
    /** Writes on their way, by record: whether each adds or removes the link. */
    private inFlight = new Map<string, "add" | "remove">();
    /** The records of the writes on their way. */
    private inFlightItems = new Map<string, Item>();
    /** Adds that failed in a way that may still have saved them, until the next read of the saved links. */
    private uncertain = new Set<string>();
    /** Removals that failed in a way that may still have taken the link away, until the next read of the saved links. */
    private uncertainRemovals = new Set<string>();
    private recordId: string | null = null;
    private running = false;
    private changedInBatch = false;
    private disposed = false;
    private idleWaiters: (() => void)[] = [];
    /** selected() result, kept until `desired` changes (sorting on every write would slow down a big Select all). */
    private sortedCache: Item[] | null = null;
    /**
     * "Save the selection" = With the record (see hold): changes wait until they are released, and only released ones
     * are written, each while it still changes the link the way it was released.
     */
    private holding = false;
    private released = new Map<string, LinkChange>();
    /**
     * The released removals must not leave the record without a saved link (a required field, see release): while no
     * selected link stays saved, they wait for an add to be saved, and they are put back if none is.
     */
    private keepOne = false;
    /**
     * keepOne, the released removals leave one saved value: until the links saved on the server are read again (see
     * checkSaved), no released change is written, and the batch isn't over (whenIdle waits for the outcome).
     */
    private checking = false;
    /** Waiting for the writes on their way to end (see checkSaved). */
    private writeWaiters: (() => void)[] = [];
    /** The last read of checkSaved found other links saved than the engine knew of (see takeCheckChange). */
    private checkChanged = false;
    /**
     * A new record's first save is on its way (see holdForCreate): the records its picks add, by id, until each is
     * written. A pick undone meanwhile is still written, as the save carried it.
     */
    private creating: Map<string, Item> | null = null;
    /** Incremented on every change to desired/confirmed state; lets callers detect concurrent edits. */
    public version = 0;

    constructor(
        private readonly executor: SyncExecutor,
        private readonly callbacks: SyncCallbacks,
    ) {}

    /** Record id, or null while the record has not been created yet (changes then stay pending). */
    public setRecordId(recordId: string | null): void {
        this.recordId = recordId || null;
        this.pump();
    }

    public getRecordId(): string | null {
        return this.recordId;
    }

    /** Loads the saved state from the server, keeping any local edits that are not written yet. */
    public setConfirmed(items: Item[]): void {
        this.mergeConfirmed(items);
        this.callbacks.onChange();
        this.pump();
    }

    /** setConfirmed without telling anyone yet (see checkSaved). */
    private mergeConfirmed(items: Item[]): void {
        const pendingAdds = [...this.desired.values()].filter((i) => !this.confirmed.has(i.id));
        const pendingRemoves = [...this.confirmed.keys()].filter((id) => !this.desired.has(id));
        this.confirmed = new Map(items.map((i) => [i.id, i]));
        this.desired = new Map(this.confirmed);
        // The saved links are known again: an add or a removal whose outcome wasn't known is settled by them.
        this.uncertain.clear();
        this.uncertainRemovals.clear();
        for (const item of pendingAdds) {
            this.desired.set(item.id, item);
        }
        for (const id of pendingRemoves) {
            this.desired.delete(id);
        }
        this.pruneReleased();
        this.sortedCache = null;
        this.version++;
    }

    /**
     * From now on, changes wait until they are released (see release): nothing is sent for them meanwhile. Changes
     * already pending go on being written.
     */
    public hold(): void {
        if (this.holding) return;
        for (const [id, change] of this.pendingChanges()) this.released.set(id, change);
        this.holding = true;
        this.version++;
    }

    /**
     * "Save the selection" = With the record: a new record's save starts. The picks made so far are what it carries:
     * they are written once the record exists (see setRecordId), and those made from now on wait for the next save, as
     * on a saved record (see hold). A carried pick undone meanwhile is written all the same, and its removal waits for the
     * next save. Each save of the new record takes what it carries again; one that doesn't create it lets go (stopHolding).
     */
    public holdForCreate(): void {
        if (this.recordId) return;
        this.released = this.pendingChanges();
        this.creating = new Map([...this.desired].filter(([id]) => this.released.get(id) === "add"));
        this.keepOne = false;
        this.holding = true;
        this.version++;
    }

    /** What a new record's first save carries (see holdForCreate), while the engine holds for it. */
    public carriedByCreate(): Item[] {
        return this.holding && !this.recordId && this.creating ? [...this.creating.values()] : [];
    }

    /** Whether changes wait to be released (see hold). */
    public isHolding(): boolean {
        return this.holding;
    }

    /** Stops holding: every change is written as soon as it is made, those waiting now too. */
    public stopHolding(): void {
        if (!this.holding) return;
        this.holding = false;
        this.released.clear();
        this.creating = null;
        this.keepOne = false;
        this.checking = false;
        this.version++;
        this.callbacks.onChange();
        this.pump();
    }

    /**
     * The changes waiting to be released: pending and not released. A write on its way that the user has undone since
     * counts as the change that undoes it once it lands (its record is picked again, or taken away again).
     */
    public heldChanges(): Map<string, LinkChange> {
        const held = new Map<string, LinkChange>();
        if (!this.holding) return held;
        for (const [id, change] of this.pendingChanges()) {
            if (this.released.get(id) !== change && !this.inFlight.has(id)) held.set(id, change);
        }
        for (const [id, operation] of this.inFlight) {
            const undone = operation === "add" ? !this.desired.has(id) : this.desired.has(id);
            const change: LinkChange = operation === "add" ? "remove" : "add";
            if (undone && this.released.get(id) !== change) held.set(id, change);
        }
        // Carried by a new record's first save (see holdForCreate) and undone before its write started: it is still
        // written, so its removal waits for a save, as for a write on its way.
        for (const id of this.creating?.keys() ?? []) {
            if (!this.inFlight.has(id) && !this.desired.has(id) && !this.confirmed.has(id) && this.released.get(id) === "add") held.set(id, "remove");
        }
        return held;
    }

    public hasHeldChanges(): boolean {
        return this.holding && this.heldChanges().size > 0;
    }

    /**
     * Lets `changes` be written, each only while it still changes the link that way (a change undone since is
     * skipped). `keepOne`: the released removals never leave the record without a saved link (see keepOne). When they
     * would leave one saved value, another tab or user may have removed that value since the links were read: the
     * released changes then wait until the links saved on the server are read again (see checkSaved), as a removal
     * that leaves one value does without holding (acceptance audit R05; owner, 2026-11-07). Two or more values left: no read.
     */
    public release(changes: Map<string, LinkChange>, keepOne = false): void {
        if (!this.holding || changes.size === 0) return;
        for (const [id, change] of changes) this.released.set(id, change);
        this.keepOne = keepOne;
        this.pruneReleased();
        const check = keepOne && !this.checking && this.executor.readSaved !== undefined && this.leavesOneSaved();
        if (check) this.checking = true;
        this.version++;
        this.callbacks.onChange();
        this.pump();
        if (check) void this.checkSaved();
    }

    /** Released changes that are still to be written or on their way, or that wait for a read (see checkSaved). */
    public hasReleasedWork(): boolean {
        return this.holding && (this.released.size > 0 || this.inFlight.size > 0 || this.checking);
    }

    /** Whether the released changes wait for a read of the saved links (see release). */
    public isChecking(): boolean {
        return this.checking;
    }

    /**
     * Whether a released removal is still to be made and the saved links that stay (see staysSaved: never a pick still
     * to be written) come to exactly one.
     */
    private leavesOneSaved(): boolean {
        let removes = false;
        for (const [id, change] of this.released) {
            if (change === "remove" && !this.inFlight.has(id) && this.confirmed.has(id) && !this.desired.has(id)) removes = true;
        }
        if (!removes) return false;
        let staying = 0;
        for (const id of this.confirmed.keys()) {
            if (this.staysSaved(id) && ++staying > 1) return false;
        }
        return staying === 1;
    }

    /**
     * The read the released changes wait for (see release), once the writes on their way are done (nothing new starts
     * meanwhile, so the read can't miss one). The links read become the saved ones, the changes not written yet kept
     * (see setConfirmed); then keepOne decides: the removals go while a value stays saved, wait for a released add
     * otherwise, and are put back when none is saved (the field shows the value still linked). No read when nothing is
     * left for it to settle by then (the removals were undone, or a failed write took them back). When the read fails,
     * nothing more is written, as when a write fails that way (see cancelQueued): the released changes wait for the next
     * release on a passing problem (holdsAfterError), and are put back otherwise.
     */
    private async checkSaved(): Promise<void> {
        const recordId = this.recordId;
        try {
            while (this.inFlight.size > 0 && this.checking && !this.disposed) await new Promise<void>((resolve) => this.writeWaiters.push(resolve));
            if (this.disposed || !this.checking) return;
            if (!this.leavesOneSaved()) {
                this.checking = false;
                this.pump();
                return;
            }
            if (!recordId || recordId !== this.recordId) throw new Error("The record changed.");
            const items = await this.executor.readSaved!(recordId);
            if (this.disposed || !this.checking) return;
            this.checking = false;
            // Other links saved than the engine knew of (another tab or user changed them): the names a save stored may be
            // wrong, which the caller learns once the batch is over (see takeCheckChange).
            if (items.map((item) => item.id).sort().join() !== [...this.confirmed.keys()].sort().join()) this.checkChanged = true;
            this.mergeConfirmed(items);
            // keepOne decides before anyone sees the links read: a removal that can't go is back at once, so the field and
            // a required column are never shown empty in between.
            if (this.inFlight.size === 0 && this.removalsMustWait() && !this.releasedAddsLeft()) this.putBackWaitingRemovals(false);
            this.callbacks.onChange();
            this.pump();
        } catch (error) {
            if (this.disposed || !this.checking) return;
            this.checking = false;
            const taken: { item: Item; change: LinkChange }[] = [];
            for (const [id, change] of this.released) {
                if (this.inFlight.has(id)) continue;
                const item = change === "add" ? this.desired.get(id) : this.desired.has(id) ? undefined : this.confirmed.get(id);
                if (item && (change === "remove" || !this.confirmed.has(id))) taken.push({ item, change });
            }
            this.cancelReleased(this.callbacks.holdsAfterError?.(error) === true);
            if (taken.length) this.callbacks.onCheckFailed?.(taken, error);
            this.callbacks.onChange();
            this.pump();
        }
    }

    /**
     * Whether the last read of the saved links before released removals (see checkSaved) found other links saved than
     * the engine knew of; asked once, when the batch is over.
     */
    public takeCheckChange(): boolean {
        const changed = this.checkChanged;
        this.checkChanged = false;
        return changed;
    }

    /**
     * Drops the held changes (see heldChanges) but those in `keep`: what the user picked goes back to what is saved.
     * Returns how many were dropped.
     */
    public dropHeld(keep?: ReadonlySet<string>): number {
        let dropped = 0;
        for (const [id, change] of this.heldChanges()) {
            if (keep?.has(id)) continue;
            if (change === "add") {
                this.desired.delete(id);
            } else {
                const item = this.confirmed.get(id) ?? this.inFlightItems.get(id) ?? this.creating?.get(id);
                if (!item) continue;
                this.desired.set(id, item);
            }
            dropped++;
        }
        if (dropped) {
            this.sortedCache = null;
            this.version++;
            this.callbacks.onChange();
        }
        return dropped;
    }

    /**
     * Ids being written or about to be: pending, and released (or not holding). Changes waiting to be released and
     * those waiting for a new record's id (see setRecordId) aren't included.
     */
    public writingIds(): Set<string> {
        const ids = this.pendingIds();
        if (!this.holding) return ids;
        for (const id of ids) {
            if (!this.released.has(id) && !this.inFlight.has(id)) ids.delete(id);
        }
        return ids;
    }

    /** Every pending change, by id: an add or a removal. */
    private pendingChanges(): Map<string, LinkChange> {
        const changes = new Map<string, LinkChange>();
        for (const id of this.desired.keys()) {
            if (!this.confirmed.has(id)) changes.set(id, "add");
        }
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id)) changes.set(id, "remove");
        }
        return changes;
    }

    /** Released changes that no longer change anything that way (undone, saved, or rolled back) are let go. */
    private pruneReleased(): void {
        for (const [id, change] of [...this.released]) {
            if (this.inFlight.has(id)) continue;
            // A new record's first save carried it (see holdForCreate): written even if undone since.
            const carried = this.creating?.has(id) === true;
            const pending = change === "add" ? (this.desired.has(id) || carried) && !this.confirmed.has(id) : this.confirmed.has(id) && !this.desired.has(id);
            if (!pending) {
                this.released.delete(id);
                this.creating?.delete(id);
            }
        }
    }

    /** A held removal: waiting to be released, so it frees its place toward Maximum selections (see occupies). */
    private isHeldRemoval(id: string): boolean {
        return this.holding && this.confirmed.has(id) && !this.desired.has(id) && this.released.get(id) !== "remove" && !this.inFlight.has(id) && !this.uncertainRemovals.has(id);
    }

    /**
     * With keepOne: whether every selected link would be gone if the released removals went now, so that they must wait
     * for an add (none of the links still selected stays saved).
     */
    private removalsMustWait(): boolean {
        if (!this.keepOne) return false;
        for (const id of this.confirmed.keys()) {
            if (this.desired.has(id) && this.inFlight.get(id) !== "remove" && !this.uncertainRemovals.has(id)) return false;
        }
        return true;
    }

    /**
     * Whether a saved link stays saved when the released removals go (see leavesOneSaved): it is selected, or its removal
     * waits for a later save (held, see isHeldRemoval: it stays linked until then, and that save is checked again); not
     * while its removal is on its way or its outcome is unknown.
     */
    private staysSaved(id: string): boolean {
        return this.confirmed.has(id) && this.inFlight.get(id) !== "remove" && !this.uncertainRemovals.has(id) && (this.desired.has(id) || this.isHeldRemoval(id));
    }

    /** Whether any add is still to be made: picked and not saved, released or not. */
    private addsPending(): boolean {
        for (const id of this.desired.keys()) {
            if (!this.confirmed.has(id)) return true;
        }
        return false;
    }

    /** Whether a released add is still to be written or on its way. */
    private releasedAddsLeft(): boolean {
        for (const [id, change] of this.released) {
            if (change === "add" && (this.inFlight.get(id) === "add" || (this.desired.has(id) && !this.confirmed.has(id)))) return true;
        }
        return false;
    }

    /**
     * keepOne, once every released add is done and none was saved: the released removals waiting for one are put back
     * (the field shows those values again; the add's failure says why).
     */
    private putBackWaitingRemovals(notify = true): void {
        let putBack = 0;
        for (const [id, change] of [...this.released]) {
            if (change !== "remove" || this.inFlight.has(id) || !this.confirmed.has(id) || this.desired.has(id)) continue;
            this.desired.set(id, this.confirmed.get(id)!);
            this.released.delete(id);
            putBack++;
        }
        if (putBack) {
            this.sortedCache = null;
            this.version++;
            if (notify) this.callbacks.onChange();
        }
    }

    /** True while writes are on their way to the server (even ones the user has since undone). */
    public isBusy(): boolean {
        return this.inFlight.size > 0;
    }

    public isSelected(id: string): boolean {
        return this.desired.has(id);
    }

    public selectedCount(): number {
        return this.desired.size;
    }

    /**
     * Whether `id` takes a place toward Maximum selections: it is selected, or it may end up saved (see placeHolders).
     */
    public occupies(id: string): boolean {
        return this.desired.has(id) || (this.confirmed.has(id) && !this.isHeldRemoval(id)) || this.inFlight.has(id) || this.uncertain.has(id);
    }

    /**
     * Records that take a place toward Maximum selections without being selected, because they may end up saved: a
     * saved record whose removal hasn't succeeded yet (it may fail and bring the record back), an add the user undid
     * while it was on its way (it may land and need a removal, which may fail), and an add that failed in a way that
     * may still have saved it, until a read of the saved links settles it. A removal waiting to be released (see hold)
     * takes no place: it goes with the save that also writes the picks replacing it.
     */
    public placeHolders(): Set<string> {
        const ids = new Set<string>();
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id) && !this.isHeldRemoval(id)) ids.add(id);
        }
        for (const id of this.inFlight.keys()) {
            if (!this.desired.has(id)) ids.add(id);
        }
        for (const id of this.uncertain) {
            if (!this.desired.has(id)) ids.add(id);
        }
        return ids;
    }

    /**
     * Whether a write whose outcome isn't known waits for a read of the saved links to settle it: an add that may hold a
     * place, or a removal that may have taken the link away.
     */
    public hasUncertain(): boolean {
        return this.uncertain.size > 0 || this.uncertainRemovals.size > 0;
    }

    /** How many records take a place toward Maximum selections: the selected ones and the placeHolders(). */
    public occupiedCount(): number {
        return this.desired.size + this.placeHolders().size;
    }

    /** Desired selection, sorted by name. The same array is returned until the selection changes. */
    public selected(): Item[] {
        if (!this.sortedCache) {
            this.sortedCache = [...this.desired.values()].sort(compareItems);
        }
        return this.sortedCache;
    }

    /**
     * The selected records known to stay saved. Left out: picks still on their way or waiting for a new record's first
     * save, a record picked again while its removal is on its way (the removal goes through first, then the record is
     * linked again), and one whose removal failed in a way that may still have taken the link away. Sorted by name, like
     * selected().
     */
    public savedSelected(): Item[] {
        return this.selected().filter((item) => this.confirmed.has(item.id) && this.inFlight.get(item.id) !== "remove" && !this.uncertainRemovals.has(item.id));
    }

    /** The records the server has answered are linked, sorted by name (held removals and writes on their way included). */
    public confirmedItems(): Item[] {
        return [...this.confirmed.values()].sort(compareItems);
    }

    /** Whether the server has answered that `id` is linked (see savedSelected for whether it stays so). */
    public isConfirmed(id: string): boolean {
        return this.confirmed.has(id);
    }

    /** Records whose link this engine is taking away: removals waiting, on their way, or of unknown outcome. */
    public removals(): Set<string> {
        const ids = new Set(this.uncertainRemovals);
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id)) ids.add(id);
        }
        for (const [id, operation] of this.inFlight) {
            if (operation === "remove") ids.add(id);
        }
        return ids;
    }

    /**
     * Ids where what the user picked differs from what is saved (queued, being written, or waiting for a record id).
     * A write that is still on its way but no longer changes anything (the user undid it) isn't included; see isBusy().
     */
    public pendingIds(): Set<string> {
        const ids = new Set<string>();
        for (const id of this.desired.keys()) {
            if (!this.confirmed.has(id)) ids.add(id);
        }
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id)) ids.add(id);
        }
        return ids;
    }

    public hasPendingChanges(): boolean {
        for (const id of this.desired.keys()) {
            if (!this.confirmed.has(id)) return true;
        }
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id)) return true;
        }
        return false;
    }

    public set(item: Item, selected: boolean): void {
        this.setMany([item], selected);
    }

    public setMany(items: Item[], selected: boolean): void {
        let changed = false;
        for (const item of items) {
            if (selected && !this.desired.has(item.id)) {
                this.desired.set(item.id, item);
                changed = true;
            } else if (!selected && this.desired.has(item.id)) {
                this.desired.delete(item.id);
                changed = true;
            }
        }
        if (changed) {
            // A released change the user has undone since isn't written; doing it again later waits for its own save.
            this.pruneReleased();
            this.sortedCache = null;
            this.version++;
            this.callbacks.onChange();
            this.pump();
        }
    }

    /**
     * Drops every change that hasn't been sent yet (desired goes back to confirmed for those items). Writes already
     * on their way finish normally. Used when the server says the user isn't allowed to change these links: there
     * is no point sending the remaining 90 requests of a Select all just to get 90 more refusals. While holding (see
     * hold) only released changes are dropped, and with `rehold` they wait for the next release instead (the problem
     * may pass: offline, busy). Returns how many were dropped or held again.
     */
    public cancelQueued(rehold = false): number {
        if (this.holding) return this.cancelReleased(rehold);
        let cancelled = 0;
        for (const [id] of [...this.desired]) {
            if (!this.confirmed.has(id) && !this.inFlight.has(id)) {
                this.desired.delete(id);
                cancelled++;
            }
        }
        for (const [id, item] of this.confirmed) {
            if (!this.desired.has(id) && !this.inFlight.has(id)) {
                this.desired.set(id, item);
                cancelled++;
            }
        }
        if (cancelled) {
            this.sortedCache = null;
            this.version++;
            this.callbacks.onChange();
        }
        return cancelled;
    }

    /**
     * cancelQueued while holding: the released changes not sent yet are dropped, or held again with `rehold`. With
     * keepOne, a removal waiting for an add (see removalsMustWait) is held again only while some add would still replace
     * it; otherwise it is put back, as when the add is refused, so the field never shows nothing while the old value
     * stays linked.
     */
    private cancelReleased(rehold: boolean): number {
        let cancelled = 0;
        const entries = [...this.released].filter(([id]) => !this.inFlight.has(id));
        // Adds first, so that what still replaces a waiting removal is known.
        entries.sort((a, b) => (a[1] === b[1] ? 0 : a[1] === "add" ? -1 : 1));
        for (const [id, change] of entries) {
            this.released.delete(id);
            // No longer carried by a new record's first save either (see holdForCreate).
            this.creating?.delete(id);
            const pending = change === "add" ? this.desired.has(id) && !this.confirmed.has(id) : this.confirmed.has(id) && !this.desired.has(id);
            if (!pending) continue;
            const putBack = !rehold || (change === "remove" && this.keepOne && this.removalsMustWait() && !this.addsPending());
            if (putBack) {
                if (change === "add") this.desired.delete(id);
                else this.desired.set(id, this.confirmed.get(id)!);
            }
            cancelled++;
        }
        if (cancelled) {
            this.sortedCache = null;
            this.version++;
            this.callbacks.onChange();
        }
        return cancelled;
    }

    /** Resolves once every pending write that can run has finished (straight away if idle or disposed). */
    public whenIdle(): Promise<void> {
        if (!this.running || this.disposed) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    public dispose(): void {
        this.disposed = true;
        // Nothing will run any more, so nobody should keep waiting for it.
        const waiters = [...this.idleWaiters, ...this.writeWaiters];
        this.idleWaiters = [];
        this.writeWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    private pump(): void {
        if (this.disposed || !this.recordId) {
            return;
        }
        if (!this.running) {
            this.running = true;
            this.changedInBatch = false;
        }
        while (this.inFlight.size < MAX_PARALLEL) {
            const next = this.nextOperation();
            if (!next) {
                break;
            }
            void this.run(next.item, next.operation, this.recordId);
        }
        if (this.inFlight.size === 0) {
            const waiters = this.writeWaiters;
            this.writeWaiters = [];
            waiters.forEach((resolve) => resolve());
            // A read of the saved links is due (see checkSaved): the batch goes on until it is answered.
            if (this.checking) return;
            // keepOne: no add was saved to stay in their place, so the removals waiting for one don't go.
            if (this.holding && this.removalsMustWait() && !this.releasedAddsLeft()) this.putBackWaitingRemovals();
            this.finishBatch();
        }
    }

    private nextOperation(): { item: Item; operation: "add" | "remove" } | null {
        if (this.holding) return this.nextReleased();
        for (const [id, item] of this.desired) {
            if (!this.confirmed.has(id) && !this.inFlight.has(id)) {
                return { item, operation: "add" };
            }
        }
        for (const [id, item] of this.confirmed) {
            if (!this.desired.has(id) && !this.inFlight.has(id)) {
                return { item, operation: "remove" };
            }
        }
        return null;
    }

    /**
     * While holding: the next released change, adds first (with keepOne, removals wait for them, see keepOne). None
     * while the saved links are read again (see checkSaved): a write landing during that read could be missed by it.
     */
    private nextReleased(): { item: Item; operation: "add" | "remove" } | null {
        if (this.checking) return null;
        for (const [id, change] of this.released) {
            if (change !== "add" || this.inFlight.has(id)) continue;
            const item = this.desired.get(id) ?? this.creating?.get(id);
            if (item && !this.confirmed.has(id)) return { item, operation: "add" };
        }
        if (this.removalsMustWait()) return null;
        for (const [id, change] of this.released) {
            if (change !== "remove" || this.inFlight.has(id)) continue;
            const item = this.confirmed.get(id);
            if (item && !this.desired.has(id)) return { item, operation: "remove" };
        }
        return null;
    }

    private async run(item: Item, operation: "add" | "remove", recordId: string): Promise<void> {
        this.inFlight.set(item.id, operation);
        this.inFlightItems.set(item.id, item);
        try {
            if (operation === "add") {
                await this.executor.associate(recordId, item.id);
                this.confirmed.set(item.id, item);
                this.uncertain.delete(item.id);
            } else {
                await this.executor.disassociate(recordId, item.id);
                this.confirmed.delete(item.id);
            }
            this.uncertainRemovals.delete(item.id);
            this.changedInBatch = true;
        } catch (error) {
            if (this.disposed) {
                return;
            }
            if (this.holding && this.callbacks.holdsAfterError?.(error) === true) {
                // A passing problem while changes wait for a save: this change waits for the next one, with the user's
                // other changes (the field and the form keep showing it as unsaved).
                this.released.delete(item.id);
            } else if (operation === "add") {
                // Roll the item back to its saved state so the UI never shows something that is not stored.
                this.desired.delete(item.id);
            } else {
                this.desired.set(item.id, this.confirmed.get(item.id) ?? item);
            }
            this.sortedCache = null;
            // A write that may have been saved all the same is settled only by a read of the saved links.
            if (this.callbacks.onError(item, operation, error) === true) {
                (operation === "add" ? this.uncertain : this.uncertainRemovals).add(item.id);
            }
        } finally {
            this.inFlight.delete(item.id);
            this.inFlightItems.delete(item.id);
            // Carried by a new record's first save (see holdForCreate): written now, or failed.
            this.creating?.delete(item.id);
            // Written (or rolled back): what was released for it goes, unless it still changes the link (the user undid it
            // during the write, then saved).
            if (this.holding) this.pruneReleased();
            this.version++;
        }
        if (this.disposed) {
            return;
        }
        this.callbacks.onChange();
        this.pump();
    }

    private finishBatch(): void {
        if (!this.running) {
            return;
        }
        this.running = false;
        const changed = this.changedInBatch;
        this.changedInBatch = false;
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        waiters.forEach((resolve) => resolve());
        this.callbacks.onSettled(changed);
    }
}
