import { Item } from "./types";

/** How the names are joined in the host column, e.g. "API design; Automation". */
const SEPARATOR = "; ";

/**
 * The text "Copy names into the host column" writes: the selected names in the order shown, cut to the column's
 * maximum length with an ellipsis, or null when nothing is selected.
 */
export function namesText(selected: Item[], maxLength?: number): string | null {
    const value = selected.map((item) => item.name).join(SEPARATOR);
    if (maxLength && value.length > maxLength) {
        // The length counts UTF-16 code units: never keep the first half of a character outside the BMP (an emoji).
        let cut = Math.max(0, maxLength - 1);
        if (cut > 0 && isHighSurrogate(value.charCodeAt(cut - 1))) cut--;
        return value.slice(0, cut) + "…";
    }
    return value || null;
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

/** How a control instance, or the writes that finish after a record was closed, write a copy and report a failure. */
export interface CopyWriter {
    /** The host column's maximum length, which the names are cut to. */
    maxLength?: number;
    write(value: string | null): Promise<void>;
    onError(error: unknown): void;
}

/**
 * Keeps the host column copy of one record in line with its saved links. There is one for each record and host
 * column on the page (see namesCopyFor), shared by every control instance that shows the record and by the writes
 * that finish after it was closed, so updates go one at a time and a newer value waits for the one on its way: they
 * can't arrive out of order. A value the column is known to hold (the last one written or, before that, the one the
 * form loaded with) is not sent, so opening a record never writes to it.
 */
export class NamesCopy {
    /** What the column holds, or undefined when that isn't known. */
    private saved: string | null | undefined;
    private wanted: string | null;
    private writing = false;
    /** The writer of the latest update, dropped once the writes are done so that a closed control isn't kept alive. */
    private writer: CopyWriter | null = null;

    constructor(loaded: string | null) {
        this.saved = loaded;
        this.wanted = loaded;
    }

    /**
     * A control instance starts on the record with `loaded` in the host column. When that isn't what the column is
     * known to hold, either the form loaded before the last write (a control re-created on a form that is still open
     * starts from the value the form opened with) or the column was changed since. What it holds then isn't known, so
     * the next update writes. A write on its way settles it anyway.
     */
    public seen(loaded: string | null): void {
        if (loaded !== this.saved) {
            this.saved = undefined;
        }
    }

    /** Copies the names of `selected`; call it once their links are saved. */
    public update(selected: Item[], writer: CopyWriter): void {
        this.wanted = namesText(selected, writer.maxLength);
        this.writer = writer;
        if (!this.writing && this.wanted !== this.saved) {
            void this.run();
        }
    }

    private async run(): Promise<void> {
        this.writing = true;
        try {
            while (this.wanted !== this.saved) {
                const value = this.wanted;
                const writer = this.writer!;
                try {
                    await writer.write(value);
                    this.saved = value;
                } catch (error) {
                    // The links stay as they are. The write may still have reached the column (a timeout, or a
                    // connection lost after the server saved it), so its value isn't known and the next update writes.
                    this.saved = undefined;
                    writer.onError(error);
                    return;
                }
            }
        } finally {
            this.writing = false;
            this.writer = null;
        }
    }
}

/**
 * The copies on this page, by record, relationship and host column. They stay for the life of the page: a control
 * re-created on a form that is still open starts from the value the form loaded, and only the copy knows that a write
 * has made it out of date. An idle copy holds no more than two short strings.
 */
const copies = new Map<string, NamesCopy>();

/**
 * The copy for `key`. `loaded` is the host column value of the form asking: a new copy starts from it, and an
 * existing one compares it with what it last wrote (see NamesCopy.seen).
 */
export function namesCopyFor(key: string, loaded: string | null): NamesCopy {
    const existing = copies.get(key);
    if (existing) {
        existing.seen(loaded);
        return existing;
    }
    const copy = new NamesCopy(loaded);
    copies.set(key, copy);
    return copy;
}

/** Forgets the names copies of all records. */
export function clearNamesCopies(): void {
    copies.clear();
}
