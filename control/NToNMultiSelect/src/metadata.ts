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
    returnedtypecode: string;
}

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
/** FetchXML of the system views used to filter the list, kept the same way. */
const viewCache = new Map<string, Promise<string>>();

/**
 * Discovers everything needed to read and edit an N:N relationship from its schema name.
 * Pass `refresh` to bypass the cache (used when a request suggests the cached metadata is out of date).
 */
export function resolveRelationship(client: DataverseClient, schemaName: string, currentEntity: string, refresh = false): Promise<RelationshipInfo> {
    const key = `${client.apiUrl}|${schemaName.trim().toLowerCase()}|${currentEntity.trim().toLowerCase()}`;
    if (refresh) {
        cache.delete(key);
    }
    return cached(cache, key, () => load(client, schemaName.trim(), currentEntity.trim().toLowerCase()));
}

/**
 * The FetchXML of an active system view of `targetEntity`, found by its name or its id (braces optional). Throws
 * QueryConfigError when the table has no such view, naming the table the view belongs to, giving the id of a view
 * whose translated name was entered, or listing the views it has with their ids.
 */
export function resolveView(client: DataverseClient, targetEntity: string, view: string): Promise<string> {
    const id = normalizeId(view);
    const key = `${client.apiUrl}|${targetEntity}|${isGuid(id) ? id : view.trim().toLowerCase()}`;
    return cached(viewCache, key, () => loadView(client, targetEntity, view.trim()));
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

async function loadView(client: DataverseClient, targetEntity: string, view: string): Promise<string> {
    const id = normalizeId(view);
    const match = isGuid(id) ? `savedqueryid eq ${id}` : `name eq ${odataString(view)}`;
    const own = await client.get<{ value?: SavedQuery[] }>(
        `savedqueries?$select=savedqueryid,name,fetchxml,returnedtypecode&$filter=${encodeURIComponent(`${match} and returnedtypecode eq ${odataString(targetEntity)} and statecode eq 0`)}`,
    );
    const fetchXml = own.value?.[0]?.fetchxml;
    if (fetchXml) {
        return fetchXml;
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
