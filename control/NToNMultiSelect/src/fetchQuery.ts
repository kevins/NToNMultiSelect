import { Strings, english } from "./strings";
import { RelationshipInfo } from "./types";

/*
 * FetchXML for the list of records that can be picked, when the form designer chose a system view or gave FetchXML.
 * Everything here is a pure function on DOMParser and XMLSerializer, which every supported browser provides.
 * Values only ever go in through setAttribute, so a search term or a paging cookie is escaped by the serializer and
 * can never change the shape of the query.
 */

/**
 * What is wrong with the relationship or the list settings. QueryConfigError turns it into a sentence in the user's
 * language.
 */
export type QueryProblem =
    | { kind: "noRelationship" }
    | { kind: "notManyToMany"; relationship: string; table: string; relationships: string[] }
    | { kind: "relationshipOtherTables"; relationship: string; tables: [string, string]; table: string }
    | { kind: "noPrimaryName"; table: string }
    | { kind: "filterWithQuery" }
    | { kind: "fetchWithView" }
    | { kind: "notXml"; detail: string }
    | { kind: "notQuery" }
    | { kind: "otherTable"; table: string; expected: string }
    | { kind: "aggregate" }
    | { kind: "viewNotFound"; view: string; table: string; views: { name: string; id: string }[] }
    | { kind: "viewTranslated"; view: string; id: string }
    | { kind: "viewOtherTable"; view: string; table: string; expected: string }
    | { kind: "tooLong" };

/** Enough names to spot a typo, few enough to keep the message readable. */
const NAMES_SHOWN = 12;

/** Settings that can't work. Trying again won't help: whoever set up the form has to change them. */
export class QueryConfigError extends Error {
    constructor(public readonly problem: QueryProblem) {
        super(describe(problem, english));
        this.name = "QueryConfigError";
    }

    public describe(t: Strings): string {
        return describe(this.problem, t);
    }
}

function describe(problem: QueryProblem, t: Strings): string {
    switch (problem.kind) {
        case "noRelationship":
            return t.noRelationship;
        case "notManyToMany":
            return t.notManyToMany(problem.relationship, problem.table, firstNames(problem.relationships));
        case "relationshipOtherTables":
            return t.relationshipOtherTables(problem.relationship, problem.tables[0], problem.tables[1], problem.table);
        case "noPrimaryName":
            return t.noPrimaryName(problem.table);
        case "filterWithQuery":
            return t.filterWithQuery;
        case "fetchWithView":
            return t.fetchWithView;
        case "notXml":
            return t.fetchNotXml(problem.detail);
        case "notQuery":
            return t.fetchNotQuery;
        case "otherTable":
            return t.fetchOtherTable(problem.table, problem.expected);
        case "aggregate":
            return t.fetchAggregate;
        case "viewNotFound":
            // With the id, as a name shown in one language may not be found in another (see viewTranslated).
            return t.viewNotFound(problem.view, problem.table, firstNames(problem.views.map((v) => `${v.name} (${v.id})`)));
        case "viewTranslated":
            return t.viewTranslated(problem.view, problem.id);
        case "viewOtherTable":
            return t.viewOtherTable(problem.view, problem.table, problem.expected);
        case "tooLong":
            return t.queryTooLong;
    }
}

function firstNames(names: string[]): string[] {
    return names.length > NAMES_SHOWN ? [...names.slice(0, NAMES_SHOWN), "..."] : names;
}

/** The settings that decide which records can be picked. */
export interface ListSettings {
    /** Name or id of a system view of the related table, or "". */
    view: string;
    /** A complete <fetch>, one or more <filter> and <link-entity> elements, or "". */
    fetchXml: string;
    extraFilter: string;
}

/** The FetchXML setting once read: a complete query, or elements to add to the view or to a generated query. */
export interface FetchSetting {
    query: Element | null;
    parts: Element[];
}

export interface FetchCondition {
    attribute: string;
    operator: string;
    value: string;
}

/**
 * Reads the FetchXML setting of a list that uses a view or FetchXML, and checks that the settings go together.
 * Nothing has been requested at this point, so a mistake in the settings is reported straight away.
 */
export function readFetchSetting(settings: ListSettings): FetchSetting {
    if (settings.extraFilter.trim()) {
        throw new QueryConfigError({ kind: "filterWithQuery" });
    }
    const text = settings.fetchXml.trim();
    if (!text) {
        return { query: null, parts: [] };
    }
    // Wrapped so that several elements parse as one document (an XML declaration can't be wrapped, so it goes). The
    // wrapper sits on the same line as the text, so it doesn't shift the line numbers in a parser error.
    const wrapper = parseXml(`<setting>${text.replace(/^<\?xml[^>]*\?>/, "")}</setting>`).documentElement;
    const elements = Array.from(wrapper.children);
    const strayText = Array.from(wrapper.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && !!node.nodeValue?.trim());
    if (elements.length === 1 && elements[0].nodeName === "fetch" && !strayText) {
        if (settings.view.trim()) {
            throw new QueryConfigError({ kind: "fetchWithView" });
        }
        return { query: elements[0], parts: [] };
    }
    if (strayText || !elements.length || elements.some((el) => el.nodeName !== "filter" && el.nodeName !== "link-entity")) {
        throw new QueryConfigError({ kind: "notQuery" });
    }
    return { query: null, parts: elements };
}

/** One sort order of the list. `link` is set for a column of a table reached through a lookup. */
interface ListOrder {
    attribute: string;
    descending: boolean;
    link: Element | null;
}

/**
 * The link-entities directly under the entity that follow a lookup: an inner or outer join on the linked table's
 * primary key, so each record meets at most one linked row and sorting on it can't list a record twice. The other
 * link types (exists, in, any, all...) only filter, and a link to child records can match many rows.
 */
function lookupLinks(entity: Element): Element[] {
    return childElements(entity, "link-entity").filter((link) => {
        const type = (link.getAttribute("link-type") ?? "inner").trim().toLowerCase();
        const table = (link.getAttribute("name") ?? "").trim().toLowerCase();
        const from = (link.getAttribute("from") ?? "").trim().toLowerCase();
        return (type === "inner" || type === "outer") && table !== "" && from === `${table}id` && !!link.getAttribute("to")?.trim();
    });
}

function readOrder(order: Element, link: Element | null): ListOrder | null {
    // An order without a column (<order alias="...">) belongs to aggregate queries.
    const attribute = (order.getAttribute("attribute") ?? "").trim();
    if (!attribute) return null;
    return { attribute, descending: xmlTrue(order.getAttribute("descending")), link };
}

/**
 * The sort order of a view or complete query, in the sequence Dataverse applies it: the entity's own orders (an
 * order with entityname names a link), then the orders inside lookup links, which Dataverse applies after the
 * entity's. Orders the list can't follow are left out; a column sorted twice keeps its first order.
 */
function sourceOrders(entity: Element): ListOrder[] {
    const links = lookupLinks(entity);
    const found: (ListOrder | null)[] = [];
    for (const order of childElements(entity, "order")) {
        const alias = (order.getAttribute("entityname") ?? "").trim().toLowerCase();
        const link = alias ? links.find((l) => (l.getAttribute("alias") ?? "").trim().toLowerCase() === alias) : null;
        if (!alias || link) found.push(readOrder(order, link ?? null));
    }
    for (const link of links) {
        for (const order of childElements(link, "order")) found.push(readOrder(order, link));
    }
    const seen = new Set<string>();
    return found.filter((order): order is ListOrder => {
        if (!order) return false;
        const key = `${order.link ? links.indexOf(order.link) : -1}|${order.attribute.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * The alias an order on a linked column refers to. A link without one gets its table name, which keeps working any
 * condition that names the link by its table, unless the query's own table or another link-entity already uses that
 * name (a link to the same table, such as a parent record): the link's orders are then left out (null).
 */
function linkAlias(doc: Document, link: Element): string | null {
    const alias = link.getAttribute("alias")?.trim();
    if (alias) return alias;
    const table = link.getAttribute("name")!.trim();
    const root = childElement(doc.documentElement, "entity")?.getAttribute("name");
    const taken =
        root?.trim().toLowerCase() === table.toLowerCase() ||
        Array.from(doc.getElementsByTagName("link-entity")).some(
            (other) => other !== link && [other.getAttribute("alias"), other.getAttribute("name")].some((v) => v?.trim().toLowerCase() === table.toLowerCase()),
        );
    if (taken) return null;
    link.setAttribute("alias", table);
    return table;
}

/**
 * The FetchXML that lists the records that can be picked: the view's query, the complete query from the setting or
 * one generated for the related table, narrowed by the setting's filter and link-entity elements (sibling filters
 * under an entity are combined with AND). The filters and the sort order of a view or complete query are kept: the
 * entity's orders, then the orders of lookup links (moved to the entity with entityname, where Dataverse applies them
 * after the entity's own), and the id last, so that the order is unique, which paging needs. A generated query, or
 * one with no order the list can follow, is sorted by name and then id. The columns become the id and the name, and
 * any paging or row limit in the source is dropped.
 */
export function buildListFetch(rel: RelationshipInfo, setting: FetchSetting, viewFetchXml: string | null, showInactive: boolean): string {
    let doc: Document;
    if (viewFetchXml !== null) {
        doc = parseXml(viewFetchXml);
    } else if (setting.query) {
        doc = parseXml(serialize(setting.query));
    } else {
        doc = parseXml("<fetch><entity/></fetch>");
        doc.documentElement.firstElementChild!.setAttribute("name", rel.targetEntity);
    }
    const fetch = doc.documentElement;
    const entity = fetch.nodeName === "fetch" ? childElement(fetch, "entity") : null;
    if (!entity) {
        throw new QueryConfigError({ kind: "notQuery" });
    }
    if (xmlTrue(fetch.getAttribute("aggregate"))) {
        throw new QueryConfigError({ kind: "aggregate" });
    }
    const table = (entity.getAttribute("name") ?? "").toLowerCase();
    if (table !== rel.targetEntity) {
        throw new QueryConfigError({ kind: "otherTable", table, expected: rel.targetEntity });
    }

    // Read before the setting's elements are added: they only filter, and never change the order.
    const orders = viewFetchXml !== null || setting.query ? sourceOrders(entity) : [];
    for (const part of setting.parts) {
        entity.appendChild(doc.importNode(part, true));
    }
    for (const name of ["attribute", "all-attributes", "order"]) {
        for (const el of Array.from(doc.getElementsByTagName(name))) el.remove();
    }
    // A Quick Find view carries the search box's own filter, with a {0} placeholder for the typed text. Sent as is,
    // it matches nothing; the control does its own searching, so only the view's other filters are kept.
    for (const el of Array.from(doc.getElementsByTagName("filter"))) {
        if (el.getAttribute("isquickfindfields") === "1") el.remove();
    }
    for (const name of ["top", "count", "page", "paging-cookie", "returntotalrecordcount"]) {
        fetch.removeAttribute(name);
    }
    const sorted: Record<string, string>[] = [];
    for (const order of orders) {
        const alias = order.link ? linkAlias(doc, order.link) : null;
        if (order.link && !alias) continue;
        sorted.push({ ...(alias ? { entityname: alias } : {}), attribute: order.attribute, ...(order.descending ? { descending: "true" } : {}) });
    }
    if (!sorted.length) {
        sorted.push({ attribute: rel.targetNameAttribute });
    }
    if (!sorted.some((order) => !order.entityname && order.attribute.toLowerCase() === rel.targetIdAttribute)) {
        sorted.push({ attribute: rel.targetIdAttribute });
    }
    entity.prepend(
        element(doc, "attribute", { name: rel.targetIdAttribute }),
        element(doc, "attribute", { name: rel.targetNameAttribute }),
        ...sorted.map((order) => element(doc, "order", order)),
    );
    // A link to the "many" side returns a row per match; the list needs each record once.
    if (entity.getElementsByTagName("link-entity").length) {
        fetch.setAttribute("distinct", "true");
    }
    // A view or a complete query decides for itself which records are usable; only a generated one follows
    // "Show inactive records".
    if (viewFetchXml === null && !setting.query && !showInactive && rel.activeCondition) {
        entity.appendChild(andFilter(doc, [{ ...rel.activeCondition, operator: "eq" }]));
    }
    return serialize(doc.documentElement);
}

/** The first page of `count` records of a list query, narrowed by extra conditions (the search, the record itself). */
export function firstPageFetch(xml: string, count: number, conditions: FetchCondition[]): string {
    const doc = parseXml(xml);
    const fetch = doc.documentElement;
    fetch.setAttribute("count", String(count));
    fetch.setAttribute("page", "1");
    if (conditions.length) {
        childElement(fetch, "entity")!.appendChild(andFilter(doc, conditions));
    }
    return serialize(doc.documentElement);
}

/**
 * The page after the one `xml` asks for. With Dataverse's paging cookie the server carries on after the last record
 * it sent instead of counting rows again; without one, the page number alone is used. The page number is always
 * counted on from `xml`; only the cookie is taken from the annotation. Two lists always go by page number:
 *  - one sorted on a linked column: the cookie only records the entity's own columns, and Dataverse says such queries
 *    "might not support" it;
 *  - one with useraworderby, which sorts choices by value: the cookie still records their labels, so Dataverse would
 *    repeat and skip records (seen on a live environment).
 */
export function nextPageFetch(xml: string, pagingCookie: string | undefined): string {
    const doc = parseXml(xml);
    const fetch = doc.documentElement;
    const entity = childElement(fetch, "entity");
    const linkedOrder = !!entity && childElements(entity, "order").some((order) => order.hasAttribute("entityname"));
    const cookie = pagingCookie && !linkedOrder && !xmlTrue(fetch.getAttribute("useraworderby")) ? parsePagingCookie(pagingCookie) : null;
    fetch.setAttribute("page", String(Number(fetch.getAttribute("page") || "1") + 1));
    if (cookie?.cookie) {
        fetch.setAttribute("paging-cookie", cookie.cookie);
    } else {
        fetch.removeAttribute("paging-cookie");
    }
    return serialize(doc.documentElement);
}

/**
 * Reads the @Microsoft.Dynamics.CRM.fetchxmlpagingcookie annotation, which looks like
 * <cookie pagenumber="2" pagingcookie="%253ccookie%2520page..." istracking="False" />: the page to ask for next, and
 * the cookie for it, which arrives URL-encoded twice. Null when it can't be read (paging then goes by page number).
 */
export function parsePagingCookie(annotation: string): { page: number; cookie: string } | null {
    try {
        const cookie = new DOMParser().parseFromString(annotation, "application/xml").documentElement;
        const page = Number(cookie.getAttribute("pagenumber"));
        if (cookie.nodeName !== "cookie" || !Number.isInteger(page) || page < 1) {
            return null;
        }
        return { page, cookie: decodeURIComponent(decodeURIComponent(cookie.getAttribute("pagingcookie") ?? "")) };
    } catch {
        return null;
    }
}

function parseXml(text: string): Document {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const error = doc.getElementsByTagName("parsererror")[0];
    if (error) {
        // Chromium puts the message in a div between two headings; Firefox puts it straight in the element.
        const message = (error.getElementsByTagName("div")[0] ?? error).textContent ?? "";
        const detail = message
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean);
        throw new QueryConfigError({ kind: "notXml", detail: detail ?? "" });
    }
    return doc;
}

function serialize(el: Element): string {
    return new XMLSerializer().serializeToString(el);
}

function childElement(parent: Element, name: string): Element | null {
    return Array.from(parent.children).find((child) => child.nodeName === name) ?? null;
}

function childElements(parent: Element, name: string): Element[] {
    return Array.from(parent.children).filter((child) => child.nodeName === name);
}

/** An XML Schema boolean attribute: "true" or "1" (in any case, as Dataverse reads them). */
function xmlTrue(value: string | null): boolean {
    const v = (value ?? "").trim().toLowerCase();
    return v === "true" || v === "1";
}

function element(doc: Document, name: string, attributes: Record<string, string>): Element {
    const el = doc.createElement(name);
    for (const [key, value] of Object.entries(attributes)) {
        el.setAttribute(key, value);
    }
    return el;
}

function andFilter(doc: Document, conditions: FetchCondition[]): Element {
    const el = element(doc, "filter", { type: "and" });
    for (const condition of conditions) {
        el.appendChild(element(doc, "condition", { attribute: condition.attribute, operator: condition.operator, value: condition.value }));
    }
    return el;
}
