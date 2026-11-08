import { DataverseClient, DataverseError, odataString } from "./dataverse";
import { QueryConfigError } from "./fetchQuery";
import { RelationshipInfo, isGuid, normalizeId } from "./types";

interface ManyToManyMetadata {
    SchemaName: string;
    Entity1LogicalName: string;
    Entity2LogicalName: string;
    Entity1NavigationPropertyName: string;
    Entity2NavigationPropertyName: string;
}

interface SavedQuery {
    savedqueryid: string;
    name: string;
    fetchxml: string | null;
    layoutxml?: string | null;
    returnedtypecode: string;
}

/** The parts of a column definition that decide whether and how it can be shown under each option. */
interface AttributeDefinition {
    LogicalName: string;
    AttributeType: string;
    AttributeTypeName?: { Value?: string } | null;
    /** Set on the helper columns of another one (such as the name of a lookup), which the Web API doesn't return. */
    AttributeOf?: string | null;
    IsValidForRead?: boolean | null;
    /** Column security is on: a user without read access gets no value, and a search on it may be refused. */
    IsSecured?: boolean | null;
}

/** The format of a text column (StringAttributeMetadata and MemoAttributeMetadata only). */
interface TextFormat {
    LogicalName: string;
    FormatName?: { Value?: string } | null;
}

/** "Columns under each option": where the columns come from. */
export type ListColumnSource = "none" | "typed" | "view";

/** A column shown under each name in the list ("Columns under each option"). */
export interface ListColumn {
    /** Logical name, as FetchXML and the setting name it. */
    name: string;
    /** The property a row holds it under: the name itself, or _name_value for a lookup. */
    property: string;
    /** Shown by its formatted value (choices, yes/no, numbers, dates, lookups) rather than as stored. */
    formatted: boolean;
    /**
     * A search on the server can match it (startswith or contains): text stored as it is shown. Not a choice, a number,
     * a date or a lookup, and not a column with column security (see listColumn).
     */
    text: boolean;
}

/** At most this many columns are shown under each name: more would not fit on the line. */
export const MAX_LIST_COLUMNS = 3;

interface EntityMetadata {
    LogicalName: string;
    EntitySetName: string;
    PrimaryIdAttribute: string;
    PrimaryNameAttribute: string | null;
    IsQuickCreateEnabled?: boolean;
    DisplayName?: { UserLocalizedLabel?: { Label?: string } | null } | null;
}

/**
 * Resolved relationships, kept for the life of the page so every form after the first skips the metadata requests.
 * (Not localStorage: Microsoft recommends that code components don't keep data in browser storage, and the few small
 * lookups run while the form is still loading anyway.)
 */
const cache = new Map<string, Promise<RelationshipInfo>>();
/** A system view used to filter the list: its FetchXML and its layout, read together from the same view. */
interface ViewRow {
    fetchXml: string;
    layoutXml: string | null;
}
/** The system views used to filter the list, kept the same way. */
const viewCache = new Map<string, Promise<ViewRow>>();
/** The columns under each option, per table and setting, kept the same way. */
const columnsCache = new Map<string, Promise<ListColumn[]>>();

/**
 * Discovers everything needed to read and edit an N:N relationship from its schema name.
 * Pass `refresh` to bypass the cache (used when a request suggests the cached metadata is out of date).
 */
export function resolveRelationship(client: DataverseClient, schemaName: string, currentEntity: string, refresh = false): Promise<RelationshipInfo> {
    // Each part a field of its own (fourth audit QUERY-01): a name typed in a setting can't run into the next part.
    const key = JSON.stringify([client.apiUrl, schemaName.trim().toLowerCase(), currentEntity.trim().toLowerCase()]);
    if (refresh) {
        cache.delete(key);
    }
    return cached(cache, key, () => load(client, schemaName.trim(), currentEntity.trim().toLowerCase()));
}

/**
 * The FetchXML of an active system view of `targetEntity`, found by its name or its id (braces optional). Throws
 * QueryConfigError when the table has no such view, naming the table the view belongs to, giving the id of a view
 * whose translated name was entered, or listing the views it has with their ids. `withLayout` for "Columns under each
 * option" = the view's columns (see resolveViewRow).
 */
export function resolveView(client: DataverseClient, targetEntity: string, view: string, withLayout = false): Promise<string> {
    return resolveViewRow(client, targetEntity, view, withLayout).then((row) => row.fetchXml);
}

/**
 * The view of resolveView. `withLayout`, for the columns under each option: with its layout, read in the same request,
 * so that the list's query and those columns never come from two views that share a name. Without it the request asks
 * for no layout, as without the setting.
 */
function resolveViewRow(client: DataverseClient, targetEntity: string, view: string, withLayout: boolean): Promise<ViewRow> {
    const key = JSON.stringify([client.apiUrl, targetEntity, viewKey(view), withLayout]);
    return cached(viewCache, key, () => loadView(client, targetEntity, view.trim(), withLayout));
}

/** A view as a cache key: its id, or its name in lower case. */
function viewKey(view: string): string {
    const id = normalizeId(view);
    return isGuid(id) ? id : view.trim().toLowerCase();
}

/**
 * The columns shown under each name in the list ("Columns under each option"): the `typed` logical names, or the
 * columns of `view` ("Records from view"), or of the related table's default lookup view when no view is set, the way
 * a lookup shows them. The name and the id are left out (the name is the line above), and so are a view's columns of
 * other tables; at most the first MAX_LIST_COLUMNS are kept. A typed name the table doesn't have, or a column that
 * can't be shown (an image, a file, a party list), is a QueryConfigError; in a view, such a column is passed over.
 */
export function resolveListColumns(client: DataverseClient, rel: RelationshipInfo, source: ListColumnSource, typed: string[], view: string): Promise<ListColumn[]> {
    if (source === "none") return Promise.resolve([]);
    const from = source === "typed" ? typed.map((n) => n.trim().toLowerCase()) : viewKey(view);
    const key = JSON.stringify([client.apiUrl, rel.targetEntity, source, from]);
    return cached(columnsCache, key, () => loadListColumns(client, rel, source, typed, view.trim()));
}

function cached<T>(map: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
    let pending = map.get(key);
    if (!pending) {
        pending = start();
        map.set(key, pending);
        // Never cache failures: a later attempt (e.g. after the admin fixes the configuration) must retry.
        pending.catch(() => {
            if (map.get(key) === pending) map.delete(key);
        });
    }
    return pending;
}

/** Forgets the relationship and view metadata read so far, so the next lookup asks the server again. */
export function clearMetadataCache(): void {
    cache.clear();
    viewCache.clear();
    columnsCache.clear();
}

async function load(client: DataverseClient, schemaName: string, currentEntity: string): Promise<RelationshipInfo> {
    if (!schemaName) {
        throw new QueryConfigError({ kind: "noRelationship" });
    }
    const select = "?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,IsQuickCreateEnabled,DisplayName";
    const currentPromise = client.get<EntityMetadata>(`EntityDefinitions(LogicalName=${odataString(currentEntity)})${select}`);
    currentPromise.catch(() => undefined); // awaited below; avoid an unhandled rejection if the relationship lookup throws first
    const relationship = await findRelationship(client, schemaName, currentEntity);

    // For a self-referencing relationship both sides are the current table and both navigation property names are
    // the same. Links are then read and written from the Entity1 side, which is also the side a native subgrid on
    // the form shows by default.
    let targetEntity: string;
    let navigationProperty: string;
    if (relationship.Entity1LogicalName === currentEntity) {
        targetEntity = relationship.Entity2LogicalName;
        navigationProperty = relationship.Entity1NavigationPropertyName;
    } else if (relationship.Entity2LogicalName === currentEntity) {
        targetEntity = relationship.Entity1LogicalName;
        navigationProperty = relationship.Entity2NavigationPropertyName;
    } else {
        throw new QueryConfigError({
            kind: "relationshipOtherTables",
            relationship: schemaName,
            tables: [relationship.Entity1LogicalName, relationship.Entity2LogicalName],
            table: currentEntity,
        });
    }
    const selfReferencing = targetEntity === currentEntity;

    const [current, target, active] = await Promise.all([
        currentPromise,
        selfReferencing ? Promise.resolve<EntityMetadata | null>(null) : client.get<EntityMetadata>(`EntityDefinitions(LogicalName=${odataString(targetEntity)})${select}`),
        activeFilterFor(client, targetEntity),
    ]);
    const targetMeta = target ?? current;
    if (!targetMeta.PrimaryNameAttribute) {
        throw new QueryConfigError({ kind: "noPrimaryName", table: targetEntity });
    }

    return {
        schemaName: relationship.SchemaName,
        currentEntity,
        currentEntitySet: current.EntitySetName,
        currentNameAttribute: current.PrimaryNameAttribute ?? null,
        targetEntity,
        targetEntitySet: targetMeta.EntitySetName,
        targetIdAttribute: targetMeta.PrimaryIdAttribute,
        targetNameAttribute: targetMeta.PrimaryNameAttribute,
        targetDisplayName: targetMeta.DisplayName?.UserLocalizedLabel?.Label || targetEntity,
        navigationProperty,
        ...active,
        targetQuickCreate: targetMeta.IsQuickCreateEnabled === true,
        selfReferencing,
    };
}

const RELATIONSHIP_SELECT = "$select=SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName";

/**
 * Looks the relationship up by schema name. The metadata key lookup is case-sensitive, so on a miss the table's
 * N:N relationships are searched case-insensitively and a name entered in any casing still works. If nothing
 * matches, the error lists the valid names.
 */
async function findRelationship(client: DataverseClient, schemaName: string, currentEntity: string): Promise<ManyToManyMetadata> {
    try {
        return await client.get<ManyToManyMetadata>(
            `RelationshipDefinitions(SchemaName=${odataString(schemaName)})/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?${RELATIONSHIP_SELECT}`,
        );
    } catch (error) {
        if (!(error instanceof DataverseError) || (error.status !== 404 && error.status !== 400)) {
            throw error;
        }
    }
    let candidates: ManyToManyMetadata[] = [];
    try {
        const body = await client.get<{ value: ManyToManyMetadata[] }>(
            `EntityDefinitions(LogicalName=${odataString(currentEntity)})/ManyToManyRelationships?${RELATIONSHIP_SELECT}`,
        );
        candidates = body.value ?? [];
    } catch (error) {
        // Only "no such table/relationship" means the name is wrong; anything else (busy, offline) is reported as is.
        if (!(error instanceof DataverseError) || (error.status !== 400 && error.status !== 404)) throw error;
        candidates = [];
    }
    const match = candidates.find((r) => r.SchemaName.toLowerCase() === schemaName.toLowerCase());
    if (match) {
        return match;
    }
    const relationships = candidates.map((r) => r.SchemaName).sort();
    throw new QueryConfigError({ kind: "notManyToMany", relationship: schemaName, table: currentEntity, relationships });
}

/**
 * What "active records only" means for the target table, in OData and as a FetchXML condition: users are switched
 * off with isdisabled, most other tables use statecode 0 = Active. Tables with neither (e.g. team) get no filter.
 */
async function activeFilterFor(client: DataverseClient, entity: string): Promise<Pick<RelationshipInfo, "activeFilter" | "activeCondition">> {
    if (entity === "systemuser") {
        return { activeFilter: "isdisabled eq false", activeCondition: { attribute: "isdisabled", value: "0" } };
    }
    return (await hasAttribute(client, entity, "statecode"))
        ? { activeFilter: "statecode eq 0", activeCondition: { attribute: "statecode", value: "0" } }
        : { activeFilter: null, activeCondition: null };
}

async function hasAttribute(client: DataverseClient, entity: string, attribute: string): Promise<boolean> {
    try {
        await client.get(`EntityDefinitions(LogicalName=${odataString(entity)})/Attributes(LogicalName=${odataString(attribute)})?$select=LogicalName`);
        return true;
    } catch (error) {
        if (error instanceof DataverseError && (error.status === 404 || error.status === 400)) {
            return false;
        }
        throw error;
    }
}

async function loadView(client: DataverseClient, targetEntity: string, view: string, withLayout: boolean): Promise<ViewRow> {
    const id = normalizeId(view);
    const match = isGuid(id) ? `savedqueryid eq ${id}` : `name eq ${odataString(view)}`;
    const columns = withLayout ? "savedqueryid,name,fetchxml,layoutxml,returnedtypecode" : "savedqueryid,name,fetchxml,returnedtypecode";
    const own = await client.get<{ value?: SavedQuery[] }>(
        `savedqueries?$select=${columns}&$filter=${encodeURIComponent(`${match} and returnedtypecode eq ${odataString(targetEntity)} and statecode eq 0`)}`,
    );
    const row = own.value?.[0];
    if (row?.fetchxml) {
        return { fetchXml: row.fetchxml, layoutXml: row.layoutxml ?? null };
    }
    // Help whoever set up the form: a view of some other table is a likely mix-up, and a list of this table's public
    // and lookup views shows the ones that would work.
    const [elsewhere, views] = await Promise.all([
        client.get<{ value?: SavedQuery[] }>(`savedqueries?$select=returnedtypecode&$filter=${encodeURIComponent(`${match} and statecode eq 0`)}&$top=1`),
        isGuid(id)
            ? Promise.resolve<{ value?: SavedQuery[] }>({})
            : client.get<{ value?: SavedQuery[] }>(
                  `savedqueries?$select=savedqueryid,name&$filter=${encodeURIComponent(`returnedtypecode eq ${odataString(targetEntity)} and statecode eq 0 and (querytype eq 0 or querytype eq 64)`)}&$orderby=name asc`,
              ),
    ]);
    const other = elsewhere.value?.[0]?.returnedtypecode;
    if (other && other !== targetEntity) {
        throw new QueryConfigError({ kind: "viewOtherTable", view, table: other, expected: targetEntity });
    }
    const listed = (views.value ?? []).map((v) => ({ name: v.name, id: normalizeId(v.savedqueryid) }));
    // The list comes back in the user's language. A name in it that the lookup above didn't find is a translation,
    // and translated names differ from one language to another, so only the id works for every user.
    const translated = listed.find((v) => v.name.toLowerCase() === view.toLowerCase());
    if (translated) {
        throw new QueryConfigError({ kind: "viewTranslated", view, id: translated.id });
    }
    throw new QueryConfigError({ kind: "viewNotFound", view, table: targetEntity, views: listed });
}

async function loadListColumns(client: DataverseClient, rel: RelationshipInfo, source: ListColumnSource, typed: string[], view: string): Promise<ListColumn[]> {
    // A view that can't be used fails here as it fails the list (the same request, kept by resolveView), so "no columns"
    // is never kept for it: once the view exists, the next attempt reads its columns.
    const names = source === "typed" ? typed : await viewColumnNames(client, rel.targetEntity, view);
    const skip = new Set([rel.targetNameAttribute.toLowerCase(), rel.targetIdAttribute.toLowerCase()]);
    const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()))].filter((n) => n && !skip.has(n));
    // Typed: the first three are shown (any more are ignored, as the setting says). A view: the first three that can be.
    const asked = source === "typed" ? wanted.slice(0, MAX_LIST_COLUMNS) : wanted;
    if (!asked.length) return [];
    const { definitions, formats } = await attributeDefinitions(client, rel.targetEntity, asked);
    const columns: ListColumn[] = [];
    for (const name of asked) {
        const column = listColumn(definitions.get(name), formats.get(name));
        if (!column) {
            if (source === "typed") throw new QueryConfigError({ kind: "columnNotFound", column: name, table: rel.targetEntity });
            continue;
        }
        columns.push(column);
        if (columns.length === MAX_LIST_COLUMNS) break;
    }
    return columns;
}

/**
 * The columns of a view in the order it shows them, from its layout: `view` (a name or an id) of the table, read with
 * the list's query (see resolveViewRow), or the table's default lookup view when `view` is empty. A view that can't be
 * used fails as the list does (see resolveView).
 */
async function viewColumnNames(client: DataverseClient, targetEntity: string, view: string): Promise<string[]> {
    if (view) {
        const { layoutXml } = await resolveViewRow(client, targetEntity, view, true);
        return layoutXml ? layoutColumns(layoutXml) : [];
    }
    const filter = `returnedtypecode eq ${odataString(targetEntity)} and statecode eq 0 and querytype eq 64 and isdefault eq true`;
    const body = await client.get<{ value?: SavedQuery[] }>(`savedqueries?$select=layoutxml&$filter=${encodeURIComponent(filter)}&$top=1`);
    const layout = body.value?.[0]?.layoutxml;
    return layout ? layoutColumns(layout) : [];
}

/**
 * The cells of a view's layout (layoutxml), in order: the logical names of the columns it shows. Hidden cells and
 * cells of linked tables (named alias.column) are left out.
 */
export function layoutColumns(layoutXml: string): string[] {
    const doc = new DOMParser().parseFromString(layoutXml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return [];
    const names: string[] = [];
    for (const cell of Array.from(doc.getElementsByTagName("cell"))) {
        const name = (cell.getAttribute("name") ?? "").trim();
        const hidden = (cell.getAttribute("ishidden") ?? "").trim().toLowerCase();
        if (!name || name.includes(".") || hidden === "1" || hidden === "true") continue;
        names.push(name);
    }
    return names;
}

/**
 * The definitions of the `names` columns of `entity` that exist, by logical name, and the formats of the text ones
 * among them. Three small requests, sent together: the format is only on the text types of column, which the metadata
 * API serves on their own (selecting it on all columns is silently ignored, measured live).
 */
async function attributeDefinitions(client: DataverseClient, entity: string, names: string[]): Promise<{ definitions: Map<string, AttributeDefinition>; formats: Map<string, string> }> {
    const filter = encodeURIComponent(names.map((name) => `LogicalName eq ${odataString(name)}`).join(" or "));
    const columns = `EntityDefinitions(LogicalName=${odataString(entity)})/Attributes`;
    const textFormats = (type: string) => client.get<{ value?: TextFormat[] }>(`${columns}/Microsoft.Dynamics.CRM.${type}?$select=LogicalName,FormatName&$filter=${filter}`);
    const [body, strings, memos] = await Promise.all([
        client.get<{ value?: AttributeDefinition[] }>(`${columns}?$select=LogicalName,AttributeType,AttributeTypeName,AttributeOf,IsValidForRead,IsSecured&$filter=${filter}`),
        textFormats("StringAttributeMetadata"),
        textFormats("MemoAttributeMetadata"),
    ]);
    const formats = new Map<string, string>();
    for (const format of [...(strings.value ?? []), ...(memos.value ?? [])]) {
        if (format.FormatName?.Value) formats.set(format.LogicalName.toLowerCase(), format.FormatName.Value);
    }
    return { definitions: new Map((body.value ?? []).map((definition) => [definition.LogicalName.toLowerCase(), definition])), formats };
}

const FORMATTED_TYPES = new Set(["Picklist", "State", "Status", "Boolean", "Integer", "BigInt", "Decimal", "Double", "Money", "DateTime"]);
const LOOKUP_TYPES = new Set(["Lookup", "Customer", "Owner"]);

/**
 * How a column is read and shown under each option, or null when it can't be (images, files, party lists...). Rich
 * text, and a multiple lines of text column in the e-mail format (an e-mail's body), hold HTML: they can't be shown
 * (owner, 2026-11-06: rich text isn't supported under the options). A search on the server leaves out a column with
 * column security, which Dataverse may refuse to search for a user who can't read it.
 */
function listColumn(definition: AttributeDefinition | undefined, format?: string): ListColumn | null {
    if (!definition || definition.AttributeOf || definition.IsValidForRead === false) return null;
    const name = definition.LogicalName.toLowerCase();
    const type = definition.AttributeType;
    if (type === "String" || type === "Memo") {
        if (format === "RichText" || (type === "Memo" && format === "Email")) return null;
        return { name, property: name, formatted: false, text: definition.IsSecured !== true };
    }
    if (LOOKUP_TYPES.has(type)) return { name, property: `_${name}_value`, formatted: true, text: false };
    if (FORMATTED_TYPES.has(type)) return { name, property: name, formatted: true, text: false };
    if (type === "Virtual" && definition.AttributeTypeName?.Value === "MultiSelectPicklistType") return { name, property: name, formatted: true, text: false };
    if (type === "Uniqueidentifier") return { name, property: name, formatted: false, text: false };
    return null;
}
