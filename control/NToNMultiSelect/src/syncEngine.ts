import { Item, compareItems } from "./types";

export interface SyncExecutor {
    associate(recordId: string, targetId: string): Promise<void>;
    disassociate(recordId: string, targetId: string): Promise<void>;
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
}

const MAX_PARALLEL = 4;

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
        this.sortedCache = null;
        this.version++;
        this.callbacks.onChange();
        this.pump();
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
        return this.desired.has(id) || this.confirmed.has(id) || this.inFlight.has(id) || this.uncertain.has(id);
    }

    /**
     * Records that take a place toward Maximum selections without being selected, because they may end up saved: a
     * saved record whose removal hasn't succeeded yet (it may fail and bring the record back), an add the user undid
     * while it was on its way (it may land and need a removal, which may fail), and an add that failed in a way that
     * may still have saved it, until a read of the saved links settles it.
     */
    public placeHolders(): Set<string> {
        const ids = new Set<string>();
        for (const id of this.confirmed.keys()) {
            if (!this.desired.has(id)) ids.add(id);
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
            this.sortedCache = null;
            this.version++;
            this.callbacks.onChange();
            this.pump();
        }
    }

    /**
     * Drops every change that hasn't been sent yet (desired goes back to confirmed for those items). Writes already
     * on their way finish normally. Used when the server says the user isn't allowed to change these links: there
     * is no point sending the remaining 90 requests of a Select all just to get 90 more refusals.
     */
    public cancelQueued(): number {
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
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
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
            this.finishBatch();
        }
    }

    private nextOperation(): { item: Item; operation: "add" | "remove" } | null {
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

    private async run(item: Item, operation: "add" | "remove", recordId: string): Promise<void> {
        this.inFlight.set(item.id, operation);
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
            // Roll the item back to its saved state so the UI never shows something that is not stored.
            if (operation === "add") {
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
