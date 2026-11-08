import { CollectionPage, DataverseClient, isAlreadyAssociated, isNotFound, odataString } from "./dataverse";
import { FetchCondition, FetchTerm, QueryConfigError, buildListFetch, firstPageFetch, nextPageFetch, readFetchSetting } from "./fetchQuery";
import { ListColumn, ListColumnSource, resolveListColumns, resolveView } from "./metadata";
import { cutText, oneLine } from "./text";
import { Item, RelationshipInfo, normalizeId } from "./types";

/** When the whole target table has at most this many selectable rows, it is loaded once and filtered locally. */
export const CLIENT_MODE_LIMIT = 500;
/** Page size used for server-side search when the target table is larger. */
export const SERVER_PAGE_SIZE = 100;

/**
 * FetchXML paging needs the paging cookie and the "more records" flag, which Dataverse only sends when asked, and
 * only on a page that is not the last.
 */
const FETCH_ANNOTATIONS = 'odata.include-annotations="Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords"';
/** The text Dataverse shows for a value (a choice's label, a lookup's name, a date in the user's format). */
const FORMATTED_VALUE = "OData.Community.Display.V1.FormattedValue";
/** FETCH_ANNOTATIONS with the formatted values, for a list with columns under each option. */
const FETCH_ANNOTATIONS_FORMATTED = `odata.include-annotations="Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords,${FORMATTED_VALUE}"`;
const FORMATTED_ANNOTATIONS = `odata.include-annotations="${FORMATTED_VALUE}"`;
/** The values under each option are joined with this on their line. */
export const DETAILS_SEPARATOR = " \u00b7 ";
const NO_COLUMNS: ListColumn[] = [];
const FETCH_PARAMETER = "?fetchXml=";
/** FetchXML travels in the URL, and Dataverse turns away GET requests with much longer URLs. */
const MAX_URL_LENGTH = 30_000;

interface FetchResult {
    value?: Record<string, unknown>[];
    "@Microsoft.Dynamics.CRM.morerecords"?: boolean;
    "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"?: string;
}

export interface OptionsPage {
    items: Item[];
    nextLink: string | null;
    /** "Columns under each option" found columns to show; left out without any (the list then looks as with None). */
    hasColumns?: boolean;
}

/** The host column of a record as saved, the version the record had then (its ETag), and the records linked to it. */
export interface SavedHost {
    value: string | null;
    version: string;
    items: Item[];
}

export interface OptionsQuery {
    showInactive: boolean;
    extraFilter: string;
    /** System view (name or id) whose filters decide which records can be picked, or "". */
    view: string;
    /** FetchXML setting: a complete <fetch>, or <filter> and <link-entity> elements to add, or "". */
    fetchXml: string;
    /** How a typed search matches names on the server: "startswith" can use an index, "contains" can't. */
    searchMode: "startswith" | "contains";
    /** Record to leave out of the list (the current record, in a self-referencing relationship). */
    excludeId: string | null;
    /** "Columns under each option" and "Search the columns under each option"; without it, the name only. */
    columns?: ListColumnsSetting;
}

/** The settings for the columns shown under each name in the list. */
export interface ListColumnsSetting {
    /** None (the name only), the columns typed in "Columns to show", or the view's columns. */
    source: ListColumnSource;
    /** The logical names typed in "Columns to show". */
    names: string[];
    /** A search also matches the columns: their text as shown when the list is filtered locally, text columns on the server. */
    search: boolean;
}

/**
 * The tag of a link the control makes or removes while it writes the host column copy itself ("Copy names into the
 * host column"). The Web API hands it to the plug-ins of the request (in SharedVariables), and the names copy plug-in
 * (part of the optional solution with the plug-in) then leaves that column of that record alone: the control writes it
 * once the links are saved, so a link costs what it costs without the plug-in, which copies the links made elsewhere.
 */
export function linkTag(rel: RelationshipInfo, recordId: string, hostColumn: string): string {
    return `NToNMultiSelect|${rel.schemaName}|${rel.currentEntity}|${recordId}|${hostColumn}`;
}

/** The query string that hands `tag` to the plug-ins of a request, or "" without one. */
function tagQuery(tag?: string): string {
    return tag ? `?tag=${encodeURIComponent(tag)}` : "";
}

/**
 * Dataverse evaluates contains() and startswith() as SQL LIKE, so %, _ and [ act as wildcards. Wrapping them in
 * brackets makes a search for e.g. "50%" or "C_Sharp" match literally.
 */
export function escapeLikeWildcards(term: string): string {
    return term.replace(/[[%_]/g, (ch) => `[${ch}]`);
}

/** Reads and writes the related rows of one N:N relationship (and the host column copy of their names). */
export class RelatedData {
    constructor(
        private readonly client: DataverseClient,
        public readonly rel: RelationshipInfo,
        private readonly noName = "(No name)",
    ) {}

    /** All target rows currently associated with the record (no filter: inactive related rows still show as selected). */
    public async loadSelected(recordId: string, signal?: AbortSignal): Promise<Item[]> {
        const { currentEntitySet, navigationProperty, targetIdAttribute, targetNameAttribute } = this.rel;
        // Ordered by name and id: paging over a non-unique order can skip or repeat rows.
        const path =
            `${currentEntitySet}(${recordId})/${navigationProperty}` +
            `?$select=${targetIdAttribute},${targetNameAttribute}&$orderby=${targetNameAttribute} asc,${targetIdAttribute} asc`;
        const rows = await this.client.getAll<Record<string, unknown>>(path, { maxPageSize: 5000, signal });
        return rows.map((row) => this.toItem(row));
    }

    /**
     * Reads one page of selectable rows. Follow-up pages must be requested with the page size of the first one,
     * so callers pass the same `pageSize` together with the `nextLink` they got.
     */
    public async loadOptions(query: OptionsQuery, searchTerm: string, pageSize: number, nextLink: string | null, signal?: AbortSignal): Promise<OptionsPage> {
        let columns = NO_COLUMNS;
        if (query.columns && query.columns.source !== "none") {
            // The list's view is read meanwhile (the request listFetch then waits for), not after the columns.
            const view = query.view.trim();
            if (view && !nextLink) void resolveView(this.client, this.rel.targetEntity, view, query.columns.source === "view").catch(() => undefined);
            columns = await resolveListColumns(this.client, this.rel, query.columns.source, query.columns.names, query.view);
        }
        if (query.view.trim() || query.fetchXml.trim()) {
            return this.loadFetchOptions(query, columns, searchTerm, pageSize, nextLink, signal);
        }
        const page: CollectionPage<Record<string, unknown>> = await this.client.getPage<Record<string, unknown>>(nextLink ?? this.optionsPath(query, searchTerm, columns), {
            maxPageSize: pageSize,
            ...(columns.some((c) => c.formatted) ? { prefer: [FORMATTED_ANNOTATIONS] } : {}),
            signal,
        });
        const items = page.value.map((row) => this.toItem(row, columns)).filter((item) => item.id !== query.excludeId);
        return { items, nextLink: page.nextLink, ...(columns.length > 0 ? { hasColumns: true } : {}) };
    }

    /**
     * loadOptions for a list that comes from a view or FetchXML. FetchXML pages by the query's count rather than by
     * odata.maxpagesize, and the next link is the request for the following page, paging cookie included.
     */
    private async loadFetchOptions(query: OptionsQuery, columns: ListColumn[], searchTerm: string, pageSize: number, nextLink: string | null, signal?: AbortSignal): Promise<OptionsPage> {
        const path = nextLink ?? this.fetchPath(firstPageFetch(await this.listFetch(query, columns), pageSize, this.fetchConditions(query, searchTerm, columns)));
        const body = await this.client.get<FetchResult>(path, { prefer: [columns.some((c) => c.formatted) ? FETCH_ANNOTATIONS_FORMATTED : FETCH_ANNOTATIONS], signal });
        const rows = body.value ?? [];
        // Each record once, even if a query with links ever returned one twice: the list is keyed by id.
        const seen = new Set<string>();
        const items: Item[] = [];
        for (const row of rows) {
            const item = this.toItem(row, columns);
            if (item.id === query.excludeId || seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
        }
        // Only when there are columns: without them the page is as it always was.
        const found = columns.length > 0 ? { hasColumns: true } : {};
        // Without the annotation this is the last page, even when it is full.
        if (body["@Microsoft.Dynamics.CRM.morerecords"] !== true) {
            return { items, nextLink: null, ...found };
        }
        const xml = decodeURIComponent(path.slice(path.indexOf(FETCH_PARAMETER) + FETCH_PARAMETER.length));
        try {
            return { items, nextLink: this.fetchPath(nextPageFetch(xml, body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"])), ...found };
        } catch (error) {
            // The cookie holds the sorted values of the last record, so a long one can make the address too long:
            // the page number alone then does.
            if (!(error instanceof QueryConfigError && error.problem.kind === "tooLong")) throw error;
            return { items, nextLink: this.fetchPath(nextPageFetch(xml, undefined)), ...found };
        }
    }

    /** The list's FetchXML before paging and search. A view's query is looked up once per page load. */
    private async listFetch(query: OptionsQuery, columns: ListColumn[] = NO_COLUMNS): Promise<string> {
        const setting = readFetchSetting(query);
        const view = query.view.trim();
        // (The same request as the columns of the view, when the list shows them: see resolveViewRow.)
        const viewFetchXml = view ? await resolveView(this.client, this.rel.targetEntity, view, query.columns?.source === "view") : null;
        return buildListFetch(this.rel, setting, viewFetchXml, query.showInactive, columns.map((c) => c.name));
    }

    /** The search and the record to leave out, as FetchXML conditions (the same rules as optionsPath). */
    private fetchConditions(query: OptionsQuery, searchTerm: string, columns: ListColumn[] = NO_COLUMNS): FetchTerm[] {
        const { targetIdAttribute } = this.rel;
        const conditions: FetchTerm[] = [];
        if (query.excludeId) {
            conditions.push({ attribute: targetIdAttribute, operator: "ne", value: query.excludeId });
        }
        const term = searchTerm.trim();
        if (term) {
            const pattern = escapeLikeWildcards(term);
            const value = query.searchMode === "contains" ? `%${pattern}%` : `${pattern}%`;
            const matches: FetchCondition[] = this.searchedColumns(query, columns).map((attribute) => ({ attribute, operator: "like", value }));
            conditions.push(matches.length > 1 ? { anyOf: matches } : matches[0]);
        }
        return conditions;
    }

    /**
     * The columns a search on the server matches: the name, and with "Search the columns under each option" the text
     * columns among them (a choice, a number or a lookup can't be matched with startswith or contains).
     */
    private searchedColumns(query: OptionsQuery, columns: ListColumn[]): string[] {
        const searched = [this.rel.targetNameAttribute];
        if (query.columns?.search) searched.push(...columns.filter((c) => c.text).map((c) => c.name));
        return searched;
    }

    private fetchPath(xml: string): string {
        const path = `${this.rel.targetEntitySet}${FETCH_PARAMETER}${encodeURIComponent(xml)}`;
        if (`${this.client.apiUrl}/${path}`.length > MAX_URL_LENGTH) {
            throw new QueryConfigError({ kind: "tooLong" });
        }
        return path;
    }

    public optionsPath(query: OptionsQuery, searchTerm: string, columns: ListColumn[] = NO_COLUMNS): string {
        const { targetEntitySet, targetIdAttribute, targetNameAttribute } = this.rel;
        const filters = this.optionsFilters(query, searchTerm, columns);
        const select = [targetIdAttribute, targetNameAttribute, ...columns.map((c) => c.property)].join(",");
        let path = `${targetEntitySet}?$select=${select}&$orderby=${targetNameAttribute} asc,${targetIdAttribute} asc`;
        if (filters.length) {
            path += `&$filter=${encodeURIComponent(filters.join(" and "))}`;
        }
        return path;
    }

    private optionsFilters(query: OptionsQuery, searchTerm: string, columns: ListColumn[] = NO_COLUMNS): string[] {
        const { targetIdAttribute, activeFilter } = this.rel;
        const filters: string[] = [];
        if (activeFilter && !query.showInactive) {
            filters.push(activeFilter);
        }
        const extra = query.extraFilter.trim();
        if (extra) {
            filters.push(`(${extra})`);
        }
        if (query.excludeId) {
            filters.push(`${targetIdAttribute} ne ${query.excludeId}`);
        }
        const term = searchTerm.trim();
        if (term) {
            const pattern = odataString(escapeLikeWildcards(term));
            const matches = this.searchedColumns(query, columns).map((attribute) => `${query.searchMode}(${attribute},${pattern})`);
            filters.push(matches.length > 1 ? `(${matches.join(" or ")})` : matches[0]);
        }
        return filters;
    }

    /**
     * True when the list offers the record `targetId`: the same query as loadOptions (filter, view or FetchXML),
     * narrowed to that one record. Used for a record made with + New, which quick create knows nothing about.
     */
    public async isOffered(query: OptionsQuery, targetId: string): Promise<boolean> {
        const { targetEntitySet, targetIdAttribute } = this.rel;
        if (query.view.trim() || query.fetchXml.trim()) {
            const conditions = [...this.fetchConditions(query, ""), { attribute: targetIdAttribute, operator: "eq", value: targetId }];
            const body = await this.client.get<FetchResult>(this.fetchPath(firstPageFetch(await this.listFetch(query), 1, conditions)));
            return (body.value ?? []).length > 0;
        }
        const filters = [...this.optionsFilters(query, ""), `${targetIdAttribute} eq ${targetId}`];
        const page = await this.client.getPage<Record<string, unknown>>(`${targetEntitySet}?$select=${targetIdAttribute}&$filter=${encodeURIComponent(filters.join(" and "))}`);
        return page.value.length > 0;
    }

    /** Links `targetId` to the record. A `tag` goes with the request to the plug-ins (see linkTag). */
    public async associate(recordId: string, targetId: string, tag?: string): Promise<void> {
        const { currentEntitySet, navigationProperty, targetEntitySet } = this.rel;
        try {
            // With keepalive: once on its way, the browser finishes it even if the user closes the page meanwhile (a save
            // with "Save the selection" = With the record writes its links right after the record, as the user leaves).
            await this.client.send(
                "POST",
                `${currentEntitySet}(${recordId})/${navigationProperty}/$ref${tagQuery(tag)}`,
                { "@odata.id": `${this.client.apiUrl}/${targetEntitySet}(${targetId})` },
                {},
                { keepalive: true },
            );
        } catch (error) {
            // Only accept a "duplicate" error when the link really exists; a plugin could use similar wording for a
            // real failure, and the UI must never show a link that was not saved.
            if (!isAlreadyAssociated(error) || !(await this.isLinked(recordId, targetId))) {
                throw error;
            }
        }
    }

    /** True when the link exists. Throws on anything other than a clean "no" so a failed check isn't read as "no". */
    private async isLinked(recordId: string, targetId: string): Promise<boolean> {
        const { currentEntitySet, navigationProperty, targetIdAttribute } = this.rel;
        try {
            const page = await this.client.getPage<Record<string, unknown>>(
                `${currentEntitySet}(${recordId})/${navigationProperty}?$select=${targetIdAttribute}&$filter=${targetIdAttribute} eq ${targetId}`,
            );
            return page.value.length > 0;
        } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
        }
    }

    /** Unlinks `targetId` from the record. A `tag` goes with the request to the plug-ins (see linkTag). */
    public async disassociate(recordId: string, targetId: string, tag?: string): Promise<void> {
        const { currentEntitySet, navigationProperty } = this.rel;
        try {
            await this.client.send("DELETE", `${currentEntitySet}(${recordId})/${navigationProperty}(${targetId})/$ref${tagQuery(tag)}`, undefined, {}, { keepalive: true });
        } catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
        }
    }

    /**
     * `column` of the record the links belong to as saved now, with the record's version (see updateRecord), and the
     * records linked to it as loadSelected reads them: one request, as quick as reading the links alone. A record with
     * more links than one page holds gets the others from the pages that follow.
     */
    public async readHostAndLinks(recordId: string, column: string): Promise<SavedHost> {
        const { currentEntitySet, navigationProperty, targetIdAttribute, targetNameAttribute } = this.rel;
        const expand = `${navigationProperty}($select=${targetIdAttribute},${targetNameAttribute};$orderby=${targetNameAttribute} asc,${targetIdAttribute} asc)`;
        const row = await this.client.get<Record<string, unknown>>(`${currentEntitySet}(${recordId})?$select=${column}&$expand=${expand}`, { maxPageSize: 5000, noCache: true });
        const rows = (row[navigationProperty] as Record<string, unknown>[] | undefined) ?? [];
        const next = row[`${navigationProperty}@odata.nextLink`];
        if (typeof next === "string") rows.push(...(await this.client.getAll<Record<string, unknown>>(next, { maxPageSize: 5000, noCache: true })));
        const value = row[column];
        return {
            value: typeof value === "string" ? value : null,
            version: typeof row["@odata.etag"] === "string" ? row["@odata.etag"] : "*",
            items: rows.map((link) => this.toItem(link)),
        };
    }

    /**
     * Writes `value` into `column` of the record the links belong to ("Copy names into the host column"). With the
     * `version` readHostAndLinks gave, only while the record still has it: once anyone has changed the record since,
     * Dataverse refuses the write (412) instead of letting older names replace newer ones. If-Match keeps it an update
     * either way: without it, a PATCH to a record that was just deleted would create it again. Sent with keepalive:
     * once on its way, the browser finishes it even if the user closes the page meanwhile (see SendOptions.keepalive).
     */
    public async updateRecord(recordId: string, column: string, value: string | null, version = "*"): Promise<void> {
        await this.client.send("PATCH", `${this.rel.currentEntitySet}(${recordId})`, { [column]: value }, { "If-Match": version }, { keepalive: true });
    }

    private toItem(row: Record<string, unknown>, columns: ListColumn[] = NO_COLUMNS): Item {
        const id = normalizeId(row[this.rel.targetIdAttribute] as string);
        const rawName = row[this.rel.targetNameAttribute];
        const name = typeof rawName === "string" && rawName.trim() ? rawName : this.noName;
        if (!columns.length) return { id, name };
        const details = columns
            .map((column) => columnText(row, column))
            .filter(Boolean)
            .join(DETAILS_SEPARATOR);
        return details ? { id, name, details } : { id, name };
    }
}

/**
 * A column's value as the list shows it under the name: the formatted value for a choice, a yes/no, a number, a date
 * or a lookup (as Dataverse shows it to the user), the text itself otherwise, on one line. "" when it's empty, and for
 * a lookup to a record that has no name: its id would mean nothing to the user. (Rich text isn't shown, see
 * listColumn in metadata.ts.)
 */
function columnText(row: Record<string, unknown>, column: ListColumn): string {
    const formatted = column.formatted ? row[`${column.property}@${FORMATTED_VALUE}`] : undefined;
    if (typeof formatted === "string") return oneLine(formatted, MAX_COLUMN_TEXT);
    if (column.property !== column.name) return "";
    const value = row[column.property];
    if (value === null || value === undefined) return "";
    // A long text only shows its start: the rest isn't read or kept for every row of the list.
    return oneLine(cutText(String(value), MAX_COLUMN_SOURCE), MAX_COLUMN_TEXT);
}

/** The most of a plain text read for its line. */
const MAX_COLUMN_SOURCE = 20_000;
/** The most of a column's text kept for its line: far more than the line shows. */
const MAX_COLUMN_TEXT = 300;

/**
 * A search made only of spaces, hyphens or apostrophes ("-", "'") becomes a pattern like '-%', which SQL can't
 * answer from an index and Dataverse throttles on big tables. The control doesn't send those; anything else is sent
 * as typed ('-abc%' and "'s-Her%" can use the index).
 */
export function isSearchable(term: string): boolean {
    return !/^[\s'’-]*$/.test(term);
}
