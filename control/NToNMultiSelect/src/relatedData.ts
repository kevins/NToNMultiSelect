import { CollectionPage, DataverseClient, isAlreadyAssociated, isNotFound, odataString } from "./dataverse";
import { FetchCondition, QueryConfigError, buildListFetch, firstPageFetch, nextPageFetch, readFetchSetting } from "./fetchQuery";
import { resolveView } from "./metadata";
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
        private readonly rel: RelationshipInfo,
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
        if (query.view.trim() || query.fetchXml.trim()) {
            return this.loadFetchOptions(query, searchTerm, pageSize, nextLink, signal);
        }
        const page: CollectionPage<Record<string, unknown>> = await this.client.getPage<Record<string, unknown>>(nextLink ?? this.optionsPath(query, searchTerm), {
            maxPageSize: pageSize,
            signal,
        });
        const items = page.value.map((row) => this.toItem(row)).filter((item) => item.id !== query.excludeId);
        return { items, nextLink: page.nextLink };
    }

    /**
     * loadOptions for a list that comes from a view or FetchXML. FetchXML pages by the query's count rather than by
     * odata.maxpagesize, and the next link is the request for the following page, paging cookie included.
     */
    private async loadFetchOptions(query: OptionsQuery, searchTerm: string, pageSize: number, nextLink: string | null, signal?: AbortSignal): Promise<OptionsPage> {
        const path = nextLink ?? this.fetchPath(firstPageFetch(await this.listFetch(query), pageSize, this.fetchConditions(query, searchTerm)));
        const body = await this.client.get<FetchResult>(path, { prefer: [FETCH_ANNOTATIONS], signal });
        const rows = body.value ?? [];
        // Each record once, even if a query with links ever returned one twice: the list is keyed by id.
        const seen = new Set<string>();
        const items: Item[] = [];
        for (const row of rows) {
            const item = this.toItem(row);
            if (item.id === query.excludeId || seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
        }
        // Without the annotation this is the last page, even when it is full.
        if (body["@Microsoft.Dynamics.CRM.morerecords"] !== true) {
            return { items, nextLink: null };
        }
        const xml = decodeURIComponent(path.slice(path.indexOf(FETCH_PARAMETER) + FETCH_PARAMETER.length));
        try {
            return { items, nextLink: this.fetchPath(nextPageFetch(xml, body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"])) };
        } catch (error) {
            // The cookie holds the sorted values of the last record, so a long one can make the address too long:
            // the page number alone then does.
            if (!(error instanceof QueryConfigError && error.problem.kind === "tooLong")) throw error;
            return { items, nextLink: this.fetchPath(nextPageFetch(xml, undefined)) };
        }
    }

    /** The list's FetchXML before paging and search. A view's query is looked up once per page load. */
    private async listFetch(query: OptionsQuery): Promise<string> {
        const setting = readFetchSetting(query);
        const view = query.view.trim();
        const viewFetchXml = view ? await resolveView(this.client, this.rel.targetEntity, view) : null;
        return buildListFetch(this.rel, setting, viewFetchXml, query.showInactive);
    }

    /** The search and the record to leave out, as FetchXML conditions (the same rules as optionsPath). */
    private fetchConditions(query: OptionsQuery, searchTerm: string): FetchCondition[] {
        const { targetIdAttribute, targetNameAttribute } = this.rel;
        const conditions: FetchCondition[] = [];
        if (query.excludeId) {
            conditions.push({ attribute: targetIdAttribute, operator: "ne", value: query.excludeId });
        }
        const term = searchTerm.trim();
        if (term) {
            const pattern = escapeLikeWildcards(term);
            conditions.push({ attribute: targetNameAttribute, operator: "like", value: query.searchMode === "contains" ? `%${pattern}%` : `${pattern}%` });
        }
        return conditions;
    }

    private fetchPath(xml: string): string {
        const path = `${this.rel.targetEntitySet}${FETCH_PARAMETER}${encodeURIComponent(xml)}`;
        if (`${this.client.apiUrl}/${path}`.length > MAX_URL_LENGTH) {
            throw new QueryConfigError({ kind: "tooLong" });
        }
        return path;
    }

    public optionsPath(query: OptionsQuery, searchTerm: string): string {
        const { targetEntitySet, targetIdAttribute, targetNameAttribute } = this.rel;
        const filters = this.optionsFilters(query, searchTerm);
        let path = `${targetEntitySet}?$select=${targetIdAttribute},${targetNameAttribute}&$orderby=${targetNameAttribute} asc,${targetIdAttribute} asc`;
        if (filters.length) {
            path += `&$filter=${encodeURIComponent(filters.join(" and "))}`;
        }
        return path;
    }

    private optionsFilters(query: OptionsQuery, searchTerm: string): string[] {
        const { targetIdAttribute, targetNameAttribute, activeFilter } = this.rel;
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
            filters.push(`${query.searchMode}(${targetNameAttribute},${odataString(escapeLikeWildcards(term))})`);
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

    public async associate(recordId: string, targetId: string): Promise<void> {
        const { currentEntitySet, navigationProperty, targetEntitySet } = this.rel;
        try {
            await this.client.send("POST", `${currentEntitySet}(${recordId})/${navigationProperty}/$ref`, {
                "@odata.id": `${this.client.apiUrl}/${targetEntitySet}(${targetId})`,
            });
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

    public async disassociate(recordId: string, targetId: string): Promise<void> {
        const { currentEntitySet, navigationProperty } = this.rel;
        try {
            await this.client.send("DELETE", `${currentEntitySet}(${recordId})/${navigationProperty}(${targetId})/$ref`);
        } catch (error) {
            if (!isNotFound(error)) {
                throw error;
            }
        }
    }

    /**
     * Sets one column of the record the links belong to ("Copy names into the host column"). If-Match: * keeps it an
     * update: without it, a PATCH to a record that was just deleted would create it again.
     */
    public async updateRecord(recordId: string, column: string, value: string | null): Promise<void> {
        await this.client.send("PATCH", `${this.rel.currentEntitySet}(${recordId})`, { [column]: value }, { "If-Match": "*" });
    }

    private toItem(row: Record<string, unknown>): Item {
        const id = normalizeId(row[this.rel.targetIdAttribute] as string);
        const rawName = row[this.rel.targetNameAttribute];
        const name = typeof rawName === "string" && rawName.trim() ? rawName : this.noName;
        return { id, name };
    }
}

/**
 * A search made only of spaces, hyphens or apostrophes ("-", "'") becomes a pattern like '-%', which SQL can't
 * answer from an index and Dataverse throttles on big tables. The control doesn't send those; anything else is sent
 * as typed ('-abc%' and "'s-Her%" can use the index).
 */
export function isSearchable(term: string): boolean {
    return !/^[\s'’-]*$/.test(term);
}
