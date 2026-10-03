/** A record that can be picked in the control. Ids are always lower-case GUIDs without braces. */
export interface Item {
    id: string;
    name: string;
}

/** Everything the control needs to know about the N:N relationship, discovered from metadata. */
export interface RelationshipInfo {
    schemaName: string;
    currentEntity: string;
    currentEntitySet: string;
    targetEntity: string;
    targetEntitySet: string;
    targetIdAttribute: string;
    targetNameAttribute: string;
    /** Singular display name of the target table in the user's language, e.g. "Skill" (used by "+ New"). */
    targetDisplayName: string;
    /** Collection-valued navigation property on the current table that returns the related target rows. */
    navigationProperty: string;
    /**
     * OData filter that means "active" for the target table, or null when the table has no such notion:
     * "statecode eq 0" for most tables, "isdisabled eq false" for users.
     */
    activeFilter: string | null;
    /** The same as a FetchXML condition (attribute eq value): statecode 0, or isdisabled 0 for users. */
    activeCondition: { attribute: string; value: string } | null;
    /** The related table allows quick create, so "+ New" can open it without leaving the form. */
    targetQuickCreate: boolean;
    /** Both sides are the same table (e.g. "related projects"). Links are then read and written in one direction. */
    selfReferencing: boolean;
}

export type OptionsMode = "client" | "server";

/** Normalises a GUID from any Dataverse/Xrm source ("{ABC-...}", "ABC-...") to "abc-...". */
export function normalizeId(id: string | null | undefined): string {
    if (!id) {
        return "";
    }
    return id.replace(/[{}]/g, "").trim().toLowerCase();
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isGuid(id: string): boolean {
    return GUID.test(id);
}

// One shared collator: String.localeCompare with options builds a new one on every call, which makes sorting a
// few hundred selected records noticeably slow.
const nameCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Locale-aware, case-insensitive name comparison used everywhere items are sorted. */
export function compareItems(a: Item, b: Item): number {
    const byName = nameCollator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
