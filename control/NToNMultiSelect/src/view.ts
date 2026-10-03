import { Strings } from "./strings";
import { GLYPH, ensureStyles } from "./styles";
import { Item } from "./types";

export type OptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ViewState {
    /** Current (desired) selection, sorted. */
    selected: Item[];
    /** Items whose change is still being written. */
    pending: Set<string>;
    /** Rows to list in the menu (already filtered by the search term). */
    options: Item[];
    optionsStatus: OptionsStatus;
    optionsError: string | null;
    /** More rows can be loaded by scrolling (server mode). */
    hasMore: boolean;
    loadingMore: boolean;
    /** A "load more" page failed; shown at the end of the list (scrolling retries). */
    loadMoreError: string | null;
    /** Show the "Select all" row (every matching row is loaded and the form's settings allow it). */
    canSelectAll: boolean;
    /** The "Maximum selections" setting is reached: unselected rows can't be picked until something is removed. */
    maxReached: boolean;
    /** Short hint shown at the top of the list (used for the selection limit), or null. */
    note: string | null;
    /** False until metadata and the saved values are loaded (the field shows blank instead of a misleading "---"). */
    ready: boolean;
    disabled: boolean;
    label: string;
    placeholder: string;
    /** Last write error (shown under the field until dismissed or the next successful change). */
    error: string | null;
    /** Grey text under the field, e.g. "Your selections are linked when you save the record." */
    hint: string | null;
    /** Configuration/metadata problem: the control cannot work at all. */
    fatalError: string | null;
    /** Text of the optional "+ New ..." button; null hides it. */
    createLabel: string | null;
    /** Clicking into the box opens the list (off by default: the native control opens it from the chevron only). */
    openOnClick: boolean;
    /** "Open selected records": each selected value is a link that opens its record in a new tab. */
    openRecords: boolean;
    /**
     * The links can't simply be followed here (the mobile app, Outlook, offline): a click on one goes to onOpenRecord
     * instead of the browser.
     */
    interceptLinks: boolean;
}

export interface ViewCallbacks {
    onToggle(item: Item, select: boolean): void;
    onToggleAll(items: Item[], select: boolean): void;
    onSearch(term: string): void;
    onOpen(): void;
    onLoadMore(): void;
    onDismissError(): void;
    onCreate(): void;
    /** Address of the item's record for "Open selected records", or null when it can't be linked to. */
    recordUrl(item: Item): string | null;
    /** Opens the item's record in a new tab: Enter on a highlighted chip, and link clicks while interceptLinks is set. */
    onOpenRecord(item: Item): void;
}

const ERROR_ICON =
    '<svg class="ntnms-error-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="7.5" fill="#a4262c"/><path d="M8 4v5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="1" fill="#fff"/></svg>';

/** Height of the list's scrolling part: four 35px rows, the same as the native control. */
const LIST_MAX_HEIGHT = 140;
/** Tallest the whole list can get (padding, Select all, note, rows, + New, borders); used to pick a side once. */
const MENU_MAX_HEIGHT = 13 + 35 + 22 + LIST_MAX_HEIGHT + 35 + 2;
/** Chips rendered while the field is collapsed. More are only built when the user expands the field. */
const MAX_COLLAPSED_CHIPS = 50;
/** Names spelled out for screen readers before switching to just the count. */
const MAX_SPOKEN_NAMES = 10;

/**
 * What the list rows were last drawn with, so the next refresh only has to touch the rows that changed since. The sets
 * are kept as they are, not copied: the controller passes new ones when the selection or the writes change, and the
 * view starts a new visitedRows set when the selection changes.
 */
interface DrawnRows {
    selected: ReadonlySet<string>;
    pending: ReadonlySet<string>;
    visited: ReadonlySet<string>;
    maxReached: boolean;
    /** Row with the keyboard highlight: an index into state.options, or null. */
    current: number | null;
}

let instanceCounter = 0;

/** Renders the control with plain DOM (no framework) so it is tiny, fast and has no style conflicts. */
export class MultiSelectView {
    private readonly uid = `ntnms${++instanceCounter}`;
    private readonly root: HTMLDivElement;
    private readonly viewText: HTMLDivElement;
    private readonly chipsList: HTMLUListElement;
    private readonly moreWrap: HTMLDivElement;
    private readonly moreButton: HTMLButtonElement;
    private readonly input: HTMLInputElement;
    private readonly caretButton: HTMLButtonElement;
    private readonly caretGlyph: HTMLSpanElement;
    private readonly summary: HTMLSpanElement;
    private readonly menu: HTMLDivElement;
    private readonly selectAllRow: HTMLDivElement;
    private readonly selectAllCheck: HTMLSpanElement;
    private readonly countText: HTMLDivElement;
    private readonly note: HTMLDivElement;
    private readonly list: HTMLUListElement;
    private readonly status: HTMLDivElement;
    private readonly createButton: HTMLButtonElement;
    private readonly live: HTMLDivElement;
    private readonly errorBox: HTMLDivElement;
    private readonly errorText: HTMLSpanElement;
    private readonly hint: HTMLDivElement;

    private state: ViewState | null = null;
    private selectedIds = new Set<string>();
    /**
     * Selected rows the mouse has left since the selection last changed. The native list draws them lighter until it
     * is drawn again, which it does on every change of the selection. The mouse only adds to this set (and draws that
     * row itself); a change of the selection replaces it, so refreshRows can tell which rows to draw again.
     */
    private visitedRows = new Set<string>();
    private renderedOptions: Item[] | null = null;
    private optionRows = new Map<string, HTMLLIElement>();
    /** Null while the rows have not been drawn since they were built (the next refresh draws them all). */
    private drawnRows: DrawnRows | null = null;
    private active = false;
    private focused = false;
    private open = false;
    private expanded = false;
    /** Highlighted menu row: an index into state.options, -1 = "Select all", options.length = "+ New", null = none. */
    private current: number | null = null;
    /**
     * Id of the highlighted chip's record when navigating chips with the keyboard. An id, not a position: the highlight
     * stays on its record when the selection changes around it.
     */
    private chipCurrent: string | null = null;
    private searchTerm = "";
    private destroyed = false;
    private lastStatus = "";
    private measureFrame = 0;
    /** The list was opened with the keyboard before its rows arrived: highlight the first row once they do. */
    private highlightWhenLoaded = false;
    /** Side of the field the open list is on. Chosen once per opening so the list never jumps while in use. */
    private placeAbove = false;
    /** The field had a size when the list opened. If it didn't (not laid out), the out-of-view check is skipped. */
    private openedVisible = false;
    /** Scrolling containers around the field (the form body, sections): the field is only visible inside them. */
    private clippingAncestors: HTMLElement[] = [];
    /** The current highlight came from the keyboard, so it gets the black focus outline (mouse clicks don't). */
    private keyboardHighlight = false;
    /** requestAnimationFrame loop that keeps the open list attached to the field (see followField). */
    private followFrame = 0;
    private lastPlacementKey = "";
    /** The selection the read-only value was last drawn as links for (see renderViewLinks); null while it is plain text. */
    private viewLinksFor: Item[] | null = null;
    /**
     * The chips were already showing when the current press started (pointerdown). A tap on the idle names shows them
     * only on its way in (the browser's emulated mouseenter), then lands on a chip link, an x or the +N button the user
     * never saw. A mouse always sees them first.
     */
    private chipsShownAtPress = true;
    /** The chip link, x or +N button such a tap landed on: the tap only focuses the box, so its click is ignored. */
    private tapped: Element | null = null;
    /** Measures the chips again when the field changes size; null where ResizeObserver is missing. */
    private resizeObserver: ResizeObserver | null = null;
    /** Enter just opened the highlighted chip's record, whose new tab takes the window's focus (see the focusout handler). */
    private openedRecord = false;
    /** Messages waiting to be said together, and whether more can still join them (see announce). */
    private announcing: string[] = [];
    private announceBatchOpen = false;
    private announceTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly onDocumentPointerDown = (event: Event): void => {
        const target = event.target as Node;
        if (this.open && !this.root.contains(target) && !this.menu.contains(target)) {
            this.closeMenu();
        }
    };

    constructor(
        private readonly container: HTMLDivElement,
        private readonly callbacks: ViewCallbacks,
        private readonly t: Strings,
    ) {
        ensureStyles(container.ownerDocument);
        const doc = container.ownerDocument;
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
            const node = doc.createElement(tag);
            if (className) node.className = className;
            return node;
        };

        this.root = el("div", "ntnms is-empty");

        // Idle presentation: bold comma separated values.
        const view = el("div", "ntnms-view");
        this.viewText = el("div", "ntnms-view-text");
        view.appendChild(this.viewText);

        // Selected values as chips.
        const chipsRow = el("div", "ntnms-chips-row");
        this.chipsList = el("ul", "ntnms-chips");
        this.chipsList.setAttribute("role", "list");
        this.moreWrap = el("div", "ntnms-more is-hidden");
        this.moreButton = el("button", "ntnms-more-button");
        this.moreButton.type = "button";
        this.moreButton.tabIndex = -1;
        this.moreWrap.appendChild(this.moreButton);
        chipsRow.append(this.chipsList, this.moreWrap);

        // Search box + chevron.
        const inner = el("div", "ntnms-inner");
        const inputWrap = el("div", "ntnms-input-wrap");
        this.input = el("input", "ntnms-input");
        this.input.type = "text";
        this.input.autocomplete = "off";
        this.input.spellcheck = false;
        this.input.setAttribute("role", "combobox");
        this.input.setAttribute("aria-autocomplete", "list");
        this.input.setAttribute("aria-expanded", "false");
        this.input.setAttribute("aria-controls", `${this.uid}-list`);
        inputWrap.appendChild(this.input);
        const caret = el("div", "ntnms-caret");
        this.caretButton = el("button", "ntnms-caret-button");
        this.caretButton.type = "button";
        this.caretButton.tabIndex = -1;
        this.caretButton.setAttribute("aria-label", t.showOptions);
        this.caretGlyph = el("span", "ntnms-glyph");
        this.caretGlyph.setAttribute("aria-hidden", "true");
        this.caretGlyph.textContent = GLYPH.chevronDown;
        this.caretButton.appendChild(this.caretGlyph);
        caret.appendChild(this.caretButton);
        inner.append(inputWrap, caret);

        // What a screen reader hears about the current selection (the input's own name stays the field label).
        this.summary = el("span", "ntnms-a11y");
        this.summary.id = `${this.uid}-summary`;

        // Drop-down list. The whole layer is the listbox, so "Select all", the records and "+ New" are all options
        // of one list (the keyboard highlight moves between them with aria-activedescendant).
        this.menu = el("div", "ntnms-menu");
        this.menu.id = `${this.uid}-list`;
        this.menu.setAttribute("role", "listbox");
        this.menu.setAttribute("aria-multiselectable", "true");
        this.selectAllRow = el("div", "ntnms-option ntnms-select-all");
        this.selectAllRow.id = `${this.uid}-all`;
        this.selectAllRow.setAttribute("role", "option");
        this.selectAllRow.setAttribute("aria-selected", "false");
        this.selectAllCheck = el("span", "ntnms-check");
        this.selectAllCheck.setAttribute("aria-hidden", "true");
        this.selectAllCheck.textContent = GLYPH.unchecked;
        const selectAllText = el("div", "ntnms-option-text");
        selectAllText.textContent = t.selectAll;
        this.countText = el("div", "ntnms-count");
        this.selectAllRow.append(this.selectAllCheck, selectAllText, this.countText);
        // Screen readers hear these through the live region instead (status changes such as "No entries found", and the
        // limit note when a pick is refused), so the elements themselves are hidden from the accessibility tree.
        this.note = el("div", "ntnms-note");
        this.note.style.display = "none";
        this.note.setAttribute("aria-hidden", "true");
        this.status = el("div", "ntnms-status");
        this.status.setAttribute("aria-hidden", "true");
        this.list = el("ul", "ntnms-list");
        this.list.setAttribute("role", "group");
        this.createButton = el("button", "ntnms-create");
        this.createButton.type = "button";
        this.createButton.tabIndex = -1;
        this.createButton.id = `${this.uid}-create`;
        this.createButton.setAttribute("role", "option");
        this.createButton.setAttribute("aria-selected", "false");
        this.createButton.style.display = "none";
        this.menu.append(this.selectAllRow, this.note, this.status, this.list, this.createButton);

        this.live = el("div", "ntnms-a11y");
        this.live.setAttribute("aria-live", "polite");
        this.live.setAttribute("aria-atomic", "true");

        this.root.append(view, chipsRow, inner, this.summary, this.live);
        // The list lives in a layer on <body>: form sections clip overflow, so it could not drop down otherwise.
        this.menu.setAttribute("data-ntnms-owner", this.uid);
        doc.body.appendChild(this.menu);

        this.errorBox = el("div", "ntnms-error");
        this.errorBox.id = `${this.uid}-error`;
        this.errorBox.hidden = true;
        this.errorBox.setAttribute("role", "alert");
        this.errorBox.innerHTML = ERROR_ICON;
        this.errorText = el("span");
        const dismiss = el("button", "ntnms-error-dismiss");
        dismiss.type = "button";
        dismiss.textContent = t.dismiss;
        dismiss.addEventListener("click", () => {
            // The button disappears with the message: the focus goes back to the field instead of to the page.
            if (doc.activeElement === dismiss && this.editable()) this.input.focus();
            this.callbacks.onDismissError();
        });
        this.errorBox.append(this.errorText, dismiss);

        this.hint = el("div", "ntnms-hint");
        this.hint.id = `${this.uid}-hint`;
        this.hint.hidden = true;

        container.append(this.root, this.errorBox, this.hint);
        this.wireEvents();
        // A narrower field (a resized window, a rotated phone) wraps chips under the first line: "+N" has to count them.
        const Observer = doc.defaultView?.ResizeObserver;
        if (Observer) {
            this.resizeObserver = new Observer(() => this.scheduleMeasure());
            this.resizeObserver.observe(this.root);
        }
    }

    // ---------------------------------------------------------------- rendering

    public render(state: ViewState): void {
        if (this.destroyed) {
            return;
        }
        const previous = this.state;
        this.state = state;
        if (!previous || previous.selected !== state.selected) {
            this.selectedIds = new Set(state.selected.map((i) => i.id));
            if (this.visitedRows.size) this.visitedRows = new Set();
        }

        if (state.disabled && (this.open || this.focused)) {
            this.closeMenu();
            this.focused = false;
        }
        if (this.open && !this.editable()) {
            this.closeMenu(); // e.g. the control is reloading after a record change
        }
        // The box already had focus while the control was loading (e.g. the record changed): show the focused look
        // now that it can be used.
        if (this.editable() && !this.focused && this.container.ownerDocument.activeElement === this.input) {
            this.focused = true;
        }

        const names = state.selected.map((i) => i.name).join(", ");
        const viewText = state.fatalError ? state.fatalError : names || (state.ready ? "---" : "");
        if (this.showsViewLinks(state)) {
            // The same text, as links: built again only when the selection changes, never on every render.
            if (this.viewLinksFor !== state.selected) this.renderViewLinks(state);
            // The links are tab stops, and the box and the chips that carry the field's label are hidden: name the field
            // they belong to.
            this.viewText.setAttribute("role", "group");
            this.viewText.setAttribute("aria-label", this.t.selectedValuesFor(state.label));
        } else {
            if (this.viewLinksFor) {
                this.viewLinksFor = null;
                this.viewText.scrollLeft = 0;
                this.viewText.removeAttribute("role");
                this.viewText.removeAttribute("aria-label");
            }
            this.viewText.textContent = viewText;
        }
        this.viewText.title = viewText;
        this.input.placeholder = state.placeholder;
        this.input.disabled = state.disabled || !!state.fatalError;
        // While loading, the box can't be used yet: keep it out of the tab order and don't accept typing.
        this.input.tabIndex = state.ready ? 0 : -1;
        this.input.readOnly = !state.ready;
        this.root.setAttribute("aria-busy", String(!state.ready && !state.fatalError));
        this.input.setAttribute("aria-label", state.label);
        this.summary.textContent = this.spokenSelection(state.selected);
        this.chipsList.setAttribute("aria-label", this.t.selectedValuesFor(state.label));
        this.menu.setAttribute("aria-label", state.label);

        if (!previous || previous.selected !== state.selected || previous.disabled !== state.disabled || previous.openRecords !== state.openRecords) {
            this.renderChips(state);
        } else if (previous.pending !== state.pending) {
            this.updateChipStates(state);
        }
        this.renderMenu(state, previous);

        this.createButton.textContent = state.createLabel ? `+ ${state.createLabel}` : "";
        this.createButton.style.display = state.createLabel ? "" : "none";

        this.errorText.textContent = state.error ?? "";
        this.errorBox.hidden = !state.error;
        this.input.setAttribute("aria-invalid", String(!!state.error));
        // Screen readers hear the hint as well: for a new record, it is the only sign that the picks wait for the save.
        const described = [`${this.uid}-summary`];
        if (state.error) described.push(`${this.uid}-error`);
        if (state.hint) described.push(`${this.uid}-hint`);
        this.input.setAttribute("aria-describedby", described.join(" "));
        this.hint.textContent = state.hint ?? "";
        this.hint.hidden = !state.hint;

        this.applyClasses();
        this.scheduleMeasure();
    }

    private spokenSelection(selected: Item[]): string {
        const names = selected.length <= MAX_SPOKEN_NAMES ? selected.map((i) => i.name) : [];
        return this.t.selectionSummary(selected.length, names);
    }

    private applyClasses(): void {
        const s = this.state;
        const cls = this.root.classList;
        cls.toggle("is-empty", !s || s.selected.length === 0);
        cls.toggle("is-disabled", !!s && (s.disabled || !!s.fatalError));
        cls.toggle("is-active", this.active && this.editable());
        cls.toggle("is-focused", this.focused);
        cls.toggle("is-open", this.open);
        this.menu.classList.toggle("is-open", this.open);
        cls.toggle("is-expanded", this.expanded);
        this.input.setAttribute("aria-expanded", String(this.open));
        this.caretGlyph.textContent = this.open ? GLYPH.chevronUp : GLYPH.chevronDown;
    }

    private renderChips(state: ViewState): void {
        const doc = this.container.ownerDocument;
        this.chipsList.textContent = "";
        // A record can have hundreds of links; only build what can be seen unless the user expanded the field.
        const shown = this.expanded || this.chipCurrent !== null ? state.selected : state.selected.slice(0, MAX_COLLAPSED_CHIPS);
        // The keyboard highlight stays on its record; once that record is no longer selected, the chip navigation ends.
        if (this.chipCurrent !== null && !state.selected.some((i) => i.id === this.chipCurrent)) this.chipCurrent = null;
        shown.forEach((item) => {
            const chip = doc.createElement("li");
            chip.className = "ntnms-chip";
            chip.dataset.id = item.id;
            if (state.pending.has(item.id)) chip.classList.add("is-saving");
            if (item.id === this.chipCurrent) chip.classList.add("is-current");
            chip.title = item.name;
            chip.setAttribute("aria-label", item.name);
            const url = state.openRecords ? this.callbacks.recordUrl(item) : null;
            if (url) {
                // Only the name is the link: the rest of the chip still just focuses the box. The keyboard opens it with
                // Enter on the highlighted chip (see onChipKey), so the link itself stays out of the tab order.
                const link = this.recordLink(url, item.name, "ntnms-chip-text ntnms-chip-link");
                link.tabIndex = -1;
                chip.appendChild(link);
            } else {
                const text = doc.createElement("span");
                text.className = "ntnms-chip-text";
                text.textContent = item.name;
                chip.appendChild(text);
            }
            if (!state.disabled) {
                const remove = doc.createElement("button");
                remove.type = "button";
                remove.className = "ntnms-chip-remove";
                remove.tabIndex = -1;
                remove.setAttribute("aria-label", this.t.remove(item.name));
                remove.title = this.t.remove(item.name);
                const glyph = doc.createElement("span");
                glyph.className = "ntnms-glyph";
                glyph.setAttribute("aria-hidden", "true");
                glyph.textContent = GLYPH.remove;
                remove.appendChild(glyph);
                remove.addEventListener("mousedown", (e) => e.preventDefault());
                remove.addEventListener("click", (e) => {
                    e.stopPropagation();
                    if (remove === this.tapped) {
                        // The end of a tap that focused the box (see mousedown): the x wasn't showing when it started.
                        this.tapped = null;
                        return;
                    }
                    this.toggle(item, false);
                });
                chip.appendChild(remove);
            }
            this.chipsList.appendChild(chip);
        });
    }

    /** Read-only with "Open selected records" and something selected: the value shows the names as links. */
    private showsViewLinks(state: ViewState): boolean {
        return state.disabled && state.openRecords && !state.fatalError && state.selected.length > 0;
    }

    /**
     * The read-only value as links, separated by ", " like the plain text, so it looks the same. Like the chips, only
     * the first MAX_COLLAPSED_CHIPS names become links; the others follow as plain text (past the ellipsis anyway).
     * Editable, the value stays plain text: hovering or focusing the field shows the chips, whose names are links.
     */
    private renderViewLinks(state: ViewState): void {
        const fragment = this.container.ownerDocument.createDocumentFragment();
        const linked = Math.min(state.selected.length, MAX_COLLAPSED_CHIPS);
        for (let index = 0; index < linked; index++) {
            const item = state.selected[index];
            if (index > 0) fragment.append(", ");
            const url = this.callbacks.recordUrl(item);
            if (url) {
                const link = this.recordLink(url, item.name, "ntnms-view-link");
                link.dataset.id = item.id;
                fragment.appendChild(link);
            } else {
                fragment.append(item.name);
            }
        }
        if (state.selected.length > linked) {
            const rest = state.selected.slice(linked).map((i) => i.name);
            fragment.append(`, ${rest.join(", ")}`);
        }
        this.viewText.textContent = "";
        this.viewText.appendChild(fragment);
        this.viewText.scrollLeft = 0; // a link that had the focus may have scrolled the line (see wireEvents)
        this.viewLinksFor = state.selected;
    }

    /** A link that opens a record in a new tab ("Open selected records"). */
    private recordLink(url: string, name: string, className: string): HTMLAnchorElement {
        const link = this.container.ownerDocument.createElement("a");
        link.className = className;
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = name;
        // Screen readers hear what the link does (which includes the name it shows) once, not the name and then the tooltip.
        link.title = this.t.openRecordTitle(name);
        link.setAttribute("aria-label", link.title);
        return link;
    }

    /** Only the "saving" look changed (a write finished): update the existing chips instead of rebuilding them. */
    private updateChipStates(state: ViewState): void {
        for (const chip of Array.from(this.chipsList.children) as HTMLElement[]) {
            chip.classList.toggle("is-saving", state.pending.has(chip.dataset.id ?? ""));
        }
    }

    private renderMenu(state: ViewState, previous: ViewState | null): void {
        // Header row.
        const allSelected = state.options.length > 0 && state.options.every((o) => this.isSelected(o.id));
        this.selectAllRow.style.display = state.canSelectAll && state.options.length > 0 ? "" : "none";
        this.selectAllRow.setAttribute("aria-selected", String(allSelected));
        this.selectAllCheck.textContent = allSelected ? GLYPH.checked : GLYPH.unchecked;
        this.countText.textContent = this.t.itemCount(state.options.length);
        this.selectAllRow.classList.toggle("is-current", this.keyboardHighlight && this.current === -1);

        this.note.textContent = state.note ?? "";
        this.note.style.display = state.note ? "" : "none";

        // Status line (loading / empty / error).
        let status = "";
        if (state.optionsStatus === "loading" && state.options.length === 0) status = this.t.loading;
        else if (state.optionsStatus === "error") status = state.optionsError || this.t.loadFailed;
        else if (state.optionsStatus === "ready" && state.options.length === 0) status = this.t.noEntries;
        this.status.textContent = status;
        this.status.style.display = status ? "" : "none";
        if (status !== this.lastStatus) {
            this.lastStatus = status;
            if (this.open && status && status !== this.t.loading) this.announce(status);
        }

        // Rows: rebuild when the list changed, otherwise only refresh the selection state.
        if (state.options !== this.renderedOptions || state.loadingMore !== previous?.loadingMore || state.loadMoreError !== previous?.loadMoreError) {
            this.rebuildRows(state);
        } else {
            this.refreshRows(state);
        }
        if (this.highlightWhenLoaded && this.open && state.options.length > 0) {
            this.highlightFirstRow();
        }
        this.createButton.classList.toggle("is-current", this.keyboardHighlight && !!state.createLabel && this.current === state.options.length);
    }

    private rebuildRows(state: ViewState): void {
        const doc = this.container.ownerDocument;
        const previous = this.renderedOptions;
        // "Load more" only appends rows: keep the existing ones and the scroll position.
        const appended = previous !== null && previous.length > 0 && state.options.length >= previous.length && previous.every((o, i) => state.options[i] === o);
        const onCreate = !!state.createLabel && previous !== null && this.current === previous.length;
        const scrollTop = this.list.scrollTop;
        this.renderedOptions = state.options;
        this.list.querySelectorAll("li.ntnms-status").forEach((row) => row.remove());
        if (!appended) {
            this.optionRows.clear();
            this.list.textContent = "";
        }
        const fragment = doc.createDocumentFragment();
        const start = appended ? previous!.length : 0;
        for (let index = start; index < state.options.length; index++) {
            const item = state.options[index];
            const row = doc.createElement("li");
            row.className = "ntnms-option";
            row.id = `${this.uid}-opt-${index}`;
            row.setAttribute("role", "option");
            row.title = item.name;
            const check = doc.createElement("span");
            check.className = "ntnms-check";
            check.setAttribute("aria-hidden", "true");
            const text = doc.createElement("div");
            text.className = "ntnms-option-text";
            text.textContent = item.name;
            row.append(check, text);
            row.dataset.index = String(index);
            this.optionRows.set(item.id, row);
            fragment.appendChild(row);
        }
        if (state.loadingMore || state.loadMoreError) {
            const more = doc.createElement("li");
            more.className = "ntnms-status";
            more.setAttribute("role", "presentation");
            more.setAttribute("aria-hidden", "true");
            more.textContent = state.loadingMore ? this.t.loading : (state.loadMoreError ?? "");
            fragment.appendChild(more);
        }
        this.list.appendChild(fragment);
        if (onCreate) {
            this.current = state.options.length; // "+ New" is always last
        } else if (this.current !== null && this.current >= state.options.length) {
            this.current = state.options.length ? state.options.length - 1 : null;
        }
        this.drawnRows = null; // the new rows have no look yet
        this.refreshRows(state);
        this.list.scrollTop = appended ? scrollTop : 0;
    }

    private refreshRows(state: ViewState): void {
        // Nobody sees the rows while the list is closed, yet a Select all re-renders once for every record it saves:
        // with thousands of rows loaded, leave them as they are. openMenu brings them up to date.
        if (!this.open) return;
        const drawn = this.drawnRows;
        const current = this.keyboardHighlight ? this.current : null;
        if (!drawn || drawn.maxReached !== state.maxReached) {
            // New rows, or the limit was reached or lifted (which changes every unselected row): draw them all.
            state.options.forEach((item, index) => {
                const row = this.optionRows.get(item.id);
                if (row) this.drawRow(state, row, item.id, index);
            });
        } else {
            // Otherwise only the rows that were picked or removed, started or finished saving, lost their lighter
            // grey, or gained or lost the highlight. Redrawing every loaded row for each finished write and each arrow
            // key takes tens of milliseconds a time once thousands of rows are loaded.
            const changed = new Set<string>();
            addDifference(changed, drawn.selected, this.selectedIds);
            addDifference(changed, drawn.pending, state.pending);
            addDifference(changed, drawn.visited, this.visitedRows);
            if (drawn.current !== current) {
                for (const index of [drawn.current, current]) {
                    const item = index === null ? undefined : state.options[index];
                    if (item) changed.add(item.id);
                }
            }
            for (const id of changed) {
                const row = this.optionRows.get(id);
                if (row) this.drawRow(state, row, id, Number(row.dataset.index));
            }
        }
        this.drawnRows = { selected: this.selectedIds, pending: state.pending, visited: this.visitedRows, maxReached: state.maxReached, current };
        this.updateActiveDescendant();
    }

    /**
     * Gives one row the look of its record: selected (lighter once the mouse has left it), saving, highlighted by the
     * keyboard or blocked by the limit.
     */
    private drawRow(state: ViewState, row: HTMLLIElement, id: string, index: number): void {
        const selected = this.isSelected(id);
        const blocked = state.maxReached && !selected;
        row.classList.toggle("is-selected", selected);
        row.classList.toggle("is-visited", selected && this.visitedRows.has(id));
        row.classList.toggle("is-saving", state.pending.has(id));
        row.classList.toggle("is-current", this.keyboardHighlight && this.current === index);
        row.classList.toggle("is-disabled", blocked);
        row.setAttribute("aria-selected", String(selected));
        row.setAttribute("aria-disabled", String(blocked));
        const check = row.firstChild as HTMLSpanElement;
        const glyph = selected ? GLYPH.checked : GLYPH.unchecked;
        if (check.textContent !== glyph) check.textContent = glyph;
    }

    private isSelected(id: string): boolean {
        return this.selectedIds.has(id);
    }

    /** Shows "+N" when chips overflow the first line (like the native control) and keeps the menu placed. */
    private scheduleMeasure(): void {
        if (this.measureFrame) return;
        const win = this.container.ownerDocument.defaultView;
        if (!win) return;
        this.measureFrame = win.requestAnimationFrame(() => {
            this.measureFrame = 0;
            if (this.destroyed) return;
            this.measureOverflow();
            if (this.open) this.positionMenu();
        });
    }

    private measureOverflow(): void {
        const width = this.moreButton.offsetWidth;
        this.countOverflow();
        // The chips were measured next to the button's previous text ("less", another count), whose width decides how
        // many fit on the first line: measure once more next to the new one.
        if (this.moreButton.offsetWidth !== width) this.countOverflow();
    }

    private countOverflow(): void {
        const chips = Array.from(this.chipsList.children) as HTMLElement[];
        const total = this.state?.selected.length ?? 0;
        if (chips.length === 0) {
            this.moreWrap.classList.add("is-hidden");
            this.expanded = false;
            this.chipsList.scrollTop = 0;
            this.applyClasses();
            return;
        }
        const firstTop = chips[0].offsetTop;
        if (this.expanded) {
            // Like the native control, "less" is only offered when collapsing would hide something: the field is also
            // expanded for keyboard navigation of the chips, often with values that fit on one line.
            const wraps = total > chips.length || chips.some((c) => c.offsetTop > firstTop + 2);
            this.moreButton.textContent = this.t.less;
            this.moreButton.setAttribute("aria-label", this.t.showFewer);
            this.moreWrap.classList.toggle("is-hidden", !wraps);
            return;
        }
        const hidden = chips.filter((c) => c.offsetTop > firstTop + 2).length + (total - chips.length);
        this.moreButton.textContent = `+${hidden}`;
        this.moreButton.setAttribute("aria-label", this.t.showAll(hidden, total));
        this.moreWrap.classList.toggle("is-hidden", hidden === 0);
    }

    /** The part of the window the user can actually see (smaller than the window when a phone keyboard is up). */
    private visibleArea(): { top: number; bottom: number } {
        const win = this.container.ownerDocument.defaultView!;
        const vv = win.visualViewport;
        return vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: win.innerHeight };
    }

    /** The part of the screen where the field can be seen: the window, cut down by any scrolling container around it. */
    private clipArea(): { top: number; bottom: number } {
        const area = this.visibleArea();
        for (const ancestor of this.clippingAncestors) {
            const r = ancestor.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            area.top = Math.max(area.top, r.top);
            area.bottom = Math.min(area.bottom, r.bottom);
        }
        return area;
    }

    /**
     * Places the list under the field (or above it), on the side chosen when it opened, and shrinks the scrolling
     * part when the window is too short to show all four rows (200% zoom, landscape phones). With `closeIfOutOfView`
     * the list closes once the field has scrolled out of sight (including under the form's header or command bar,
     * which sit outside the form's scrolling area) or has disappeared.
     */
    private positionMenu(closeIfOutOfView = false): void {
        const win = this.container.ownerDocument.defaultView;
        if (!win || !this.open) return;
        const rect = this.root.getBoundingClientRect();
        const area = this.visibleArea();
        if (closeIfOutOfView && this.openedVisible) {
            const clip = this.clipArea();
            const gone = rect.width === 0 && rect.height === 0;
            if (gone || rect.bottom <= clip.top + 1 || rect.top >= clip.bottom - 1) {
                this.closeMenu(false);
                return;
            }
        }
        const style = this.menu.style;
        style.left = `${Math.round(rect.left)}px`;
        style.width = `${Math.round(rect.width)}px`;

        const room = (this.placeAbove ? rect.top - area.top : area.bottom - rect.bottom) - 8;
        const fixedPart = this.menu.offsetHeight - this.list.offsetHeight;
        if (room > 0 && this.menu.offsetHeight > 0) {
            this.list.style.maxHeight = `${Math.max(35, Math.min(LIST_MAX_HEIGHT, Math.floor(room - fixedPart)))}px`;
        }
        if (this.placeAbove) {
            style.top = "";
            // position:fixed is measured against the layout viewport, which is what clientHeight reports.
            style.bottom = `${Math.round(this.container.ownerDocument.documentElement.clientHeight - rect.top - 1)}px`;
        } else {
            style.bottom = "";
            // Overlap the field's bottom border so the two borders read as one line, like the native control.
            style.top = `${Math.round(rect.bottom - 1)}px`;
        }
    }

    /**
     * While the list is open, checks once per frame whether the field moved or resized (a subgrid above it
     * refreshed, the form scrolled, a notification appeared, the window or phone keyboard changed size) and
     * moves the list with it. Only one list is open at a time, so this costs one rectangle read per frame.
     */
    private followField(): void {
        const win = this.container.ownerDocument.defaultView;
        if (!win?.requestAnimationFrame) return;
        const tick = (): void => {
            this.followFrame = 0;
            if (!this.open || this.destroyed) return;
            const r = this.root.getBoundingClientRect();
            const area = this.clipArea();
            const key = `${r.top}|${r.left}|${r.width}|${r.height}|${area.top}|${area.bottom}`;
            if (key !== this.lastPlacementKey) {
                this.lastPlacementKey = key;
                this.positionMenu(true);
            }
            if (this.open) this.followFrame = win.requestAnimationFrame(tick);
        };
        this.followFrame = win.requestAnimationFrame(tick);
    }

    // ---------------------------------------------------------------- interaction

    private wireEvents(): void {
        this.root.addEventListener("mouseenter", () => {
            this.active = true;
            this.applyClasses();
            this.scheduleMeasure();
        });
        this.root.addEventListener("mouseleave", () => {
            this.active = false;
            this.applyClasses();
        });
        // Every press starts with pointerdown. For a tap, that is before the emulated mouseenter switches to the chips.
        this.root.addEventListener("pointerdown", () => {
            const cls = this.root.classList;
            this.chipsShownAtPress = cls.contains("is-active") || cls.contains("is-focused");
            this.tapped = null;
        });
        // Same as the native control: clicking into the box only focuses it. The list opens from the chevron, the Down
        // arrow key, Enter or typing (or on click, when the "Open list on click" setting is on).
        this.root.addEventListener("mousedown", (e) => {
            if (!this.editable()) return;
            const target = e.target as HTMLElement;
            if (target === this.input) {
                // Let the browser place the text cursor.
                if (this.state?.openOnClick && !this.open) this.openMenu();
                return;
            }
            const button = target.closest(".ntnms-chip-remove, .ntnms-more-button");
            if (button && this.chipsShownAtPress) {
                e.preventDefault(); // keep focus in the search box
                return;
            }
            const link = target.closest(".ntnms-chip-link");
            if (link && this.chipsShownAtPress) {
                // "Open selected records": the click follows the link (Ctrl+click and middle-click as well). The focus
                // stays where it is, nothing is selected or dragged, and the list is neither opened nor closed.
                e.preventDefault();
                return;
            }
            // A tap on the idle names, which only became chips on its way in: it focuses the box, whatever it landed on.
            this.tapped = button ?? link;
            e.preventDefault();
            this.focusInput();
            if (target.closest(".ntnms-caret-button")) {
                if (this.open) this.closeMenu();
                else this.openMenu();
            } else if (this.state?.openOnClick && !this.open) {
                this.openMenu();
            }
        });
        // "Open selected records" where a link can't simply be followed (see ViewState.interceptLinks): the controller
        // opens the record instead. Everywhere else the browser follows the link.
        this.root.addEventListener("click", (e) => {
            const s = this.state;
            const link = (e.target as HTMLElement).closest(".ntnms-chip-link, .ntnms-view-link");
            if (!link) return;
            if (link === this.tapped) {
                // The end of a tap that focused the box (see mousedown): the link wasn't showing when it started.
                this.tapped = null;
                e.preventDefault();
                return;
            }
            if (!s?.interceptLinks) return;
            e.preventDefault();
            const id = (link.closest("[data-id]") as HTMLElement | null)?.dataset.id;
            const item = s.selected.find((i) => i.id === id);
            if (item) this.callbacks.onOpenRecord(item);
        });
        this.input.addEventListener("focus", () => {
            this.openedRecord = false;
            if (!this.editable()) return;
            this.focused = true;
            this.applyClasses();
            this.scheduleMeasure();
        });
        this.root.addEventListener("focusout", (e) => {
            const next = e.relatedTarget as Node | null;
            if (next && (this.root.contains(next) || this.menu.contains(next))) return;
            if (!next && this.openedRecord && this.chipCurrent !== null && !this.container.ownerDocument.hasFocus()) {
                // The record Enter opened took the window's focus with its new tab. The box keeps the focus for when the
                // user comes back (as a link would), so they carry on from the same chip.
                this.closeMenu();
                return;
            }
            this.focused = false;
            this.chipCurrent = null;
            this.closeMenu();
            // Text left from a list that closed by itself (the field scrolled away) shouldn't linger either.
            if (this.input.value) this.clearSearch();
            const wasExpanded = this.expanded;
            this.expanded = false;
            // Collapsed too, the chip navigation may have scrolled the list to a lower line: back to the first one.
            this.chipsList.scrollTop = 0;
            this.applyClasses();
            if (this.state && wasExpanded) this.renderChips(this.state);
            else if (this.state) this.clearChipHighlight();
        });
        // A read-only link past the ellipsis scrolls the line to show itself when it gets the focus: once the focus has
        // left the links, the line starts at the first name again.
        this.viewText.addEventListener("focusout", (e) => {
            if (!this.viewText.contains(e.relatedTarget as Node | null)) this.viewText.scrollLeft = 0;
        });
        this.input.addEventListener("input", () => {
            if (!this.editable()) return;
            if (this.chipCurrent !== null) {
                // Text that came without a key of its own (a paste, an IME, a phone keyboard) also returns to search.
                this.chipCurrent = null;
                this.clearChipHighlight();
            }
            this.searchTerm = this.input.value;
            this.current = null;
            this.highlightWhenLoaded = false;
            if (!this.open) this.openMenu();
            this.callbacks.onSearch(this.searchTerm);
        });
        this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
        this.moreButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.moreButton === this.tapped) {
                // The end of a tap that focused the box (see mousedown): the button wasn't showing when it started.
                this.tapped = null;
                return;
            }
            this.expanded = !this.expanded;
            // Collapsed, the list still keeps its scroll position (it only hides what overflows): back to the first line.
            if (!this.expanded) this.chipsList.scrollTop = 0;
            this.applyClasses();
            if (this.state) this.renderChips(this.state);
            this.scheduleMeasure();
        });
        this.menu.addEventListener("mousedown", (e) => e.preventDefault());
        this.selectAllRow.addEventListener("click", () => this.toggleAll());
        this.createButton.addEventListener("click", () => {
            if (!this.editable()) return;
            this.closeMenu();
            this.callbacks.onCreate();
        });
        this.list.addEventListener("click", (e) => {
            const row = (e.target as HTMLElement).closest("li.ntnms-option") as HTMLLIElement | null;
            if (!row || !this.state) return;
            const index = Number(row.dataset.index);
            const item = this.state.options[index];
            if (!item) return;
            this.current = index;
            this.keyboardHighlight = false;
            this.toggle(item, !this.isSelected(item.id));
        });
        // A selected row the mouse leaves stays lighter, like in the native list (see visitedRows). One listener for
        // the whole list, which can hold thousands of rows; moving between the parts of a row doesn't count.
        this.list.addEventListener("mouseout", (e) => {
            const row = (e.target as HTMLElement).closest("li.ntnms-option") as HTMLLIElement | null;
            if (!row || row.contains(e.relatedTarget as Node | null)) return;
            const item = this.state?.options[Number(row.dataset.index)];
            if (!item || !this.isSelected(item.id) || this.visitedRows.has(item.id)) return;
            this.visitedRows.add(item.id);
            row.classList.add("is-visited");
        });
        this.list.addEventListener("scroll", () => {
            const s = this.state;
            if (!s || !s.hasMore || s.loadingMore) return;
            if (this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 70) {
                this.callbacks.onLoadMore();
            }
        });
    }

    private onKeyDown(e: KeyboardEvent): void {
        const s = this.state;
        if (!s || !this.editable()) return;
        this.keyboardHighlight = true;
        this.openedRecord = false;
        const count = s.options.length;
        const firstIndex = s.canSelectAll && count > 0 ? -1 : 0;
        // The optional "+ New" button is the last keyboard stop (index === count).
        const lastIndex = s.createLabel ? count : count - 1;
        const empty = lastIndex < 0;

        if (this.chipCurrent !== null) {
            this.onChipKey(e);
            return;
        }

        switch (e.key) {
            case "ArrowDown": {
                e.preventDefault();
                if (!this.open) {
                    // Down and Alt+Down open the list with the first row already highlighted, like the native control.
                    this.openMenu();
                    this.highlightFirstRow();
                    return;
                }
                if (empty) return;
                this.current = this.current === null ? firstIndex : Math.min(this.current + 1, lastIndex);
                this.refreshRowsAndScroll();
                return;
            }
            case "ArrowUp": {
                e.preventDefault();
                if (this.open && e.altKey) {
                    this.closeMenu();
                    return;
                }
                if (!this.open || empty) return;
                this.current = this.current === null ? lastIndex : Math.max(this.current - 1, firstIndex);
                this.refreshRowsAndScroll();
                return;
            }
            case "PageDown":
            case "PageUp": {
                if (!this.open || empty) return;
                e.preventDefault();
                const step = e.key === "PageDown" ? 4 : -4;
                this.current = Math.max(firstIndex, Math.min(lastIndex, (this.current ?? 0) + step));
                this.refreshRowsAndScroll();
                return;
            }
            case "Home":
            case "End": {
                if (!this.open || empty || !e.ctrlKey) return;
                e.preventDefault();
                this.current = e.key === "Home" ? firstIndex : lastIndex;
                this.refreshRowsAndScroll();
                return;
            }
            case "Enter": {
                if (!this.open) {
                    e.preventDefault();
                    this.openMenu();
                    return;
                }
                e.preventDefault();
                this.activateCurrent();
                return;
            }
            case " ": {
                if (this.open && this.current !== null && this.input.value === "") {
                    e.preventDefault();
                    this.activateCurrent();
                }
                return;
            }
            case "Escape": {
                if (this.open) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.closeMenu();
                } else if (this.input.value) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.clearSearch();
                }
                return;
            }
            case "Backspace": {
                if (this.input.value === "" && s.selected.length > 0) {
                    e.preventDefault();
                    // Backspace held down to clear the search text stops there: only a new press goes on to the chips.
                    if (e.repeat) return;
                    this.expanded = true;
                    const last = s.selected.length - 1;
                    this.chipCurrent = s.selected[last].id;
                    // Collapsed, only the first chips exist: build them all, once. Otherwise only the highlight is new.
                    if (this.chipsList.children.length < s.selected.length) this.renderChips(s);
                    else this.highlightChip(last);
                    this.applyClasses();
                    this.scrollChipIntoView(last);
                    this.scheduleMeasure();
                    const name = s.selected[last].name;
                    this.announce(s.openRecords ? this.t.chipHelpOpen(name) : this.t.chipHelp(name));
                }
                return;
            }
            case "Tab": {
                this.closeMenu();
                return;
            }
            default:
                return;
        }
    }

    private onChipKey(e: KeyboardEvent): void {
        let s = this.state!;
        let index = s.selected.findIndex((i) => i.id === this.chipCurrent);
        if (index < 0) {
            // Safety net: renderChips already ends the navigation when the record is no longer selected.
            this.chipCurrent = null;
            this.clearChipHighlight();
            return;
        }
        let key = e.key;
        if ((key === "ArrowLeft" || key === "ArrowRight") && this.rightToLeft()) {
            // The chips follow the text direction: right to left, the previous chip is the one on the right.
            key = key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
        }
        switch (key) {
            case "ArrowLeft":
                e.preventDefault();
                index = Math.max(0, index - 1);
                break;
            case "ArrowRight":
                e.preventDefault();
                if (index >= s.selected.length - 1) {
                    this.chipCurrent = null;
                    this.clearChipHighlight();
                    return;
                }
                index += 1;
                break;
            case "Backspace":
            case "Delete": {
                e.preventDefault();
                // One chip per press: a held key doesn't go on removing one chip after another.
                if (e.repeat) return;
                const item = s.selected[index];
                if (item) this.toggle(item, false);
                // The controller re-rendered synchronously: continue from the new selection, never the old snapshot.
                s = this.state!;
                index = Math.min(index, s.selected.length - 1);
                if (index < 0) {
                    this.chipCurrent = null;
                    this.renderChips(s);
                    return;
                }
                break;
            }
            case "Enter": {
                // "Open selected records": opens the highlighted chip's record. Without it, Enter does nothing here.
                if (!s.openRecords) return;
                e.preventDefault();
                const item = s.selected[index];
                if (item) {
                    this.openedRecord = true;
                    this.callbacks.onOpenRecord(item);
                }
                return;
            }
            case "Escape":
                e.preventDefault();
                e.stopPropagation();
                this.chipCurrent = null;
                this.clearChipHighlight();
                if (this.open) this.closeMenu();
                return;
            case "ArrowDown":
            case "Tab":
                this.chipCurrent = null;
                this.clearChipHighlight();
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    this.openMenu();
                    this.highlightFirstRow();
                }
                return;
            default:
                if (e.key.length === 1) {
                    // Typing returns to search.
                    this.chipCurrent = null;
                    this.clearChipHighlight();
                }
                return;
        }
        const item = s.selected[index];
        this.chipCurrent = item.id;
        // Every chip is built while the keyboard is on them (a Delete was already redrawn by the controller's
        // render), so only the highlight moves: rebuilding thousands of chips per key press would make this sluggish.
        this.highlightChip(index);
        this.scrollChipIntoView(index);
        this.announce(item.name);
    }

    /** The expanded chip list scrolls; keep the chip the keyboard is on visible. */
    private scrollChipIntoView(index: number): void {
        const chip = this.chipsList.children[index] as HTMLElement | undefined;
        if (!chip) return;
        const top = chip.offsetTop - this.chipsList.offsetTop;
        const bottom = top + chip.offsetHeight;
        if (top < this.chipsList.scrollTop) this.chipsList.scrollTop = top;
        else if (bottom > this.chipsList.scrollTop + this.chipsList.clientHeight) this.chipsList.scrollTop = bottom - this.chipsList.clientHeight;
    }

    private clearChipHighlight(): void {
        this.chipsList.querySelectorAll(".ntnms-chip.is-current").forEach((chip) => chip.classList.remove("is-current"));
    }

    /** Moves the keyboard highlight to another chip, leaving the rest of the chips alone. */
    private highlightChip(index: number): void {
        this.clearChipHighlight();
        const chip = this.chipsList.children[index] as HTMLElement | undefined;
        if (chip) chip.classList.add("is-current");
    }

    private activateCurrent(): void {
        const s = this.state;
        if (!s || this.current === null) return;
        if (this.current === -1) {
            this.toggleAll();
            return;
        }
        if (s.createLabel && this.current === s.options.length) {
            this.closeMenu();
            this.callbacks.onCreate();
            return;
        }
        const item = s.options[this.current];
        if (item) this.toggle(item, !this.isSelected(item.id));
    }

    private toggle(item: Item, select: boolean): void {
        if (!this.editable()) return;
        if (select && this.state?.maxReached) {
            if (this.state.note) this.announce(this.state.note);
            return;
        }
        this.callbacks.onToggle(item, select);
        this.announce(select ? this.t.announceSelected(item.name) : this.t.announceRemoved(item.name));
    }

    private toggleAll(): void {
        const s = this.state;
        if (!s || !this.editable() || !s.canSelectAll || s.options.length === 0) return;
        const allSelected = s.options.every((o) => this.isSelected(o.id));
        this.callbacks.onToggleAll(s.options, !allSelected);
        // During a search only the listed matches change, so both messages give the count.
        this.announce(allSelected ? this.t.announceAllRemoved(s.options.length) : this.t.announceAllSelected(s.options.length));
    }

    /** Highlights "Select all" (or the first record). If the list is still loading, that happens when it arrives. */
    private highlightFirstRow(): void {
        const s = this.state;
        if (!s || s.options.length === 0) {
            this.highlightWhenLoaded = true;
            return;
        }
        this.highlightWhenLoaded = false;
        this.current = s.canSelectAll ? -1 : 0;
        this.refreshRowsAndScroll();
    }

    private refreshRowsAndScroll(): void {
        if (!this.state) return;
        this.refreshRows(this.state);
        this.selectAllRow.classList.toggle("is-current", this.keyboardHighlight && this.current === -1);
        this.createButton.classList.toggle("is-current", this.keyboardHighlight && !!this.state.createLabel && this.current === this.state.options.length);
        const row = this.current !== null && this.current >= 0 ? (this.list.children[this.current] as HTMLElement | undefined) : undefined;
        if (row) {
            const top = row.offsetTop;
            const bottom = top + row.offsetHeight;
            if (top < this.list.scrollTop) this.list.scrollTop = top;
            else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
        }
    }

    private updateActiveDescendant(): void {
        const s = this.state;
        let id: string | null = null;
        if (this.open && this.current !== null && s) {
            if (this.current === -1) id = this.selectAllRow.id;
            else if (s.createLabel && this.current === s.options.length) id = this.createButton.id;
            else if (this.current < s.options.length) id = `${this.uid}-opt-${this.current}`;
        }
        // Safety net: only point at an element that is in the document.
        if (id && !this.container.ownerDocument.getElementById(id)) {
            id = null;
            this.current = null;
        }
        if (id) this.input.setAttribute("aria-activedescendant", id);
        else this.input.removeAttribute("aria-activedescendant");
    }

    private editable(): boolean {
        return !!this.state && this.state.ready && !this.state.disabled && !this.state.fatalError;
    }

    /** The form is written right to left (Arabic, Hebrew): the field's direction, inherited from the page. */
    private rightToLeft(): boolean {
        try {
            return this.container.ownerDocument.defaultView?.getComputedStyle(this.root).direction === "rtl";
        } catch {
            return false;
        }
    }

    private focusInput(): void {
        if (this.container.ownerDocument.activeElement !== this.input) {
            this.input.focus();
        }
    }

    private openMenu(): void {
        if (this.open || !this.editable()) return;
        this.open = true;
        this.current = null;
        this.callbacks.onOpen();
        // Catch up on what changed while the list was closed (nothing is left to do if onOpen's own render did).
        if (this.state) this.refreshRows(this.state);
        this.applyClasses();
        this.updateActiveDescendant();
        const doc = this.container.ownerDocument;
        // pointerdown as well: touch scrolling and some taps never produce a mousedown.
        doc.addEventListener("mousedown", this.onDocumentPointerDown, true);
        doc.addEventListener("pointerdown", this.onDocumentPointerDown, true);
        this.clippingAncestors = this.findClippingAncestors();
        this.menu.dir = this.rightToLeft() ? "rtl" : "ltr";
        // Pick the side once, using the tallest the list can get, so it doesn't jump when rows arrive or are filtered.
        const rect = this.root.getBoundingClientRect();
        const area = this.visibleArea();
        const below = area.bottom - rect.bottom;
        const above = rect.top - area.top;
        this.placeAbove = below < MENU_MAX_HEIGHT + 8 && above > below;
        this.openedVisible = rect.width > 0 || rect.height > 0;
        this.lastPlacementKey = "";
        this.positionMenu();
        this.followField();
        this.scheduleMeasure();
    }

    /** Closes the list. `clearSearchText` is false when the close wasn't the user's choice (the field scrolled away). */
    private closeMenu(clearSearchText = true): void {
        if (!this.open) return;
        this.open = false;
        this.current = null;
        this.highlightWhenLoaded = false;
        const win = this.container.ownerDocument.defaultView;
        if (this.followFrame && win) win.cancelAnimationFrame(this.followFrame);
        this.followFrame = 0;
        this.list.style.maxHeight = "";
        this.clippingAncestors = [];
        // Clear the highlight outline now; the next opening starts without one.
        this.selectAllRow.classList.remove("is-current");
        this.createButton.classList.remove("is-current");
        this.list.querySelectorAll(".is-current").forEach((row) => row.classList.remove("is-current"));
        if (this.drawnRows) this.drawnRows.current = null;
        this.container.ownerDocument.removeEventListener("mousedown", this.onDocumentPointerDown, true);
        this.container.ownerDocument.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
        if (clearSearchText && this.input.value) {
            this.clearSearch();
        }
        this.applyClasses();
        this.updateActiveDescendant();
    }

    /** Elements around the field that cut off what's outside them (overflow other than visible). */
    private findClippingAncestors(): HTMLElement[] {
        const doc = this.container.ownerDocument;
        const win = doc.defaultView;
        const found: HTMLElement[] = [];
        if (!win) return found;
        for (let el = this.root.parentElement; el && el !== doc.body && el !== doc.documentElement; el = el.parentElement) {
            const style = win.getComputedStyle(el);
            if (style.overflowX !== "visible" || style.overflowY !== "visible") found.push(el);
        }
        return found;
    }

    private clearSearch(): void {
        this.input.value = "";
        this.searchTerm = "";
        this.callbacks.onSearch("");
    }

    /**
     * Says `message` through the live region. Messages made in one go (a chip removed, then the chip highlighted next)
     * are read together: written one after the other, the last would replace the others before screen readers notice
     * them. A message from a later event (the next key press) replaces one that hasn't been said yet.
     */
    private announce(message: string): void {
        if (this.announceBatchOpen) {
            if (!this.announcing.includes(message)) this.announcing.push(message);
            return;
        }
        this.announcing = [message];
        this.announceBatchOpen = true;
        queueMicrotask(() => {
            this.announceBatchOpen = false;
        });
        this.live.textContent = "";
        clearTimeout(this.announceTimer);
        // A tick later so screen readers notice the change even when the same text repeats.
        this.announceTimer = setTimeout(() => {
            if (!this.destroyed) this.live.textContent = this.announcing.join(". ");
        }, 30);
    }

    /** The control's root element (used by the form bridge to detect quick create panes and dialogs). */
    public element(): HTMLElement {
        return this.root;
    }

    public destroy(): void {
        this.closeMenu(false);
        this.destroyed = true;
        clearTimeout(this.announceTimer);
        this.resizeObserver?.disconnect();
        const win = this.container.ownerDocument.defaultView;
        if (this.measureFrame && win) win.cancelAnimationFrame(this.measureFrame);
        this.root.remove();
        this.menu.remove();
        this.errorBox.remove();
        this.hint.remove();
    }
}

/** Adds to `target` the ids that are in only one of the two sets. */
function addDifference(target: Set<string>, a: ReadonlySet<string>, b: ReadonlySet<string>): void {
    if (a === b) return;
    for (const id of a) {
        if (!b.has(id)) target.add(id);
    }
    for (const id of b) {
        if (!a.has(id)) target.add(id);
    }
}
