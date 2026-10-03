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
    /** A write failed and the item was rolled back to its saved state. */
    onError(item: Item, operation: "add" | "remove", error: unknown): void;
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
    private inFlight = new Set<string>();
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

    /** Desired selection, sorted by name. The same array is returned until the selection changes. */
    public selected(): Item[] {
        if (!this.sortedCache) {
            this.sortedCache = [...this.desired.values()].sort(compareItems);
        }
        return this.sortedCache;
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
        this.inFlight.add(item.id);
        try {
            if (operation === "add") {
                await this.executor.associate(recordId, item.id);
                this.confirmed.set(item.id, item);
            } else {
                await this.executor.disassociate(recordId, item.id);
                this.confirmed.delete(item.id);
            }
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
            this.callbacks.onError(item, operation, error);
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
