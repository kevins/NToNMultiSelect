/*
 * Every piece of text the control shows, in English and French. French uses a non-breaking space (\u00a0) before
 * a colon and inside « », as French typography expects.
 *
 * The language follows the user's Dynamics language (context.userSettings.languageId). Whole sentences are kept per
 * language, rather than glued together from fragments, because word order and agreement differ between languages.
 * To add a language, copy the English block, translate it and add its LCIDs to LANGUAGES below.
 */

export interface Strings {
    placeholder: string;
    relatedRecords: string;
    noName: string;
    selectAll: string;
    itemCount(count: number): string;
    loading: string;
    noEntries: string;
    loadFailed: string;
    loadMoreFailed: string;
    searchFailed: string;
    showOptions: string;
    remove(name: string): string;
    openRecordTitle(name: string): string;
    less: string;
    /**
     * Names of the "+N" button (showAll) and the "less" button (showFewer). Each contains the text its button shows,
     * so that speech input users can say what they see.
     */
    showAll(hidden: number, count: number): string;
    showFewer: string;
    selectedValuesFor(label: string): string;
    selectionSummary(count: number, names: string[]): string;
    announceSelected(name: string): string;
    announceRemoved(name: string): string;
    announceAllSelected(count: number): string;
    announceAllRemoved(count: number): string;
    chipHelp(name: string): string;
    chipHelpOpen(name: string): string;
    dismiss: string;
    newRecord(table: string): string;
    maxNote(max: number): string;
    maxReached(max: number): string;
    heldHint: string;
    saveFirst: string;
    offline: string;
    notOnForm: string;
    noRelationship: string;
    notManyToMany(relationship: string, table: string, relationships: string[]): string;
    relationshipOtherTables(relationship: string, table1: string, table2: string, table: string): string;
    noPrimaryName(table: string): string;
    loadSelectedFailed: string;
    reloadToRetry: string;
    addFailed(name: string): string;
    removeFailed(name: string): string;
    manyFailed(count: number): string;
    createFailed: string;
    createdNotLinked(name: string): string;
    createdNotOffered(name: string): string;
    closedFailures(count: number, label: string): string;
    copyFailed(label: string, reason: string): string;
    noPermissionChange: string;
    noPermissionRead: string;
    noPermissionUpdate: string;
    sessionExpired: string;
    serverBusy: string;
    cannotReachServer: string;
    searchTooSlow: string;
    timedOut: string;
    filterWithQuery: string;
    fetchWithView: string;
    fetchNotXml(detail: string): string;
    fetchNotQuery: string;
    fetchOtherTable(table: string, expected: string): string;
    fetchAggregate: string;
    viewNotFound(view: string, table: string, views: string[]): string;
    viewTranslated(view: string, id: string): string;
    viewOtherTable(view: string, table: string, expected: string): string;
    queryTooLong: string;
}

const en: Strings = {
    placeholder: "Select or search options",
    relatedRecords: "Related records",
    noName: "(No name)",
    selectAll: "Select all",
    itemCount: (n) => `${n} ${n === 1 ? "item" : "items"}`,
    loading: "Loading…",
    noEntries: "No entries found",
    loadFailed: "Couldn't load records.",
    loadMoreFailed: "Couldn't load more records. Scroll to try again.",
    searchFailed: "Search failed.",
    showOptions: "Show options",
    remove: (name) => `Remove ${name}`,
    openRecordTitle: (name) => `Open ${name} in a new tab`,
    less: "less",
    showAll: (hidden, n) => `+${hidden}, show all ${n} selected values`,
    showFewer: "Show less",
    selectedValuesFor: (label) => `Selected values for ${label}`,
    selectionSummary: (n, names) => (n === 0 ? "Nothing selected" : names.length ? `${n} selected: ${names.join(", ")}` : `${n} selected`),
    announceSelected: (name) => `${name} selected`,
    announceRemoved: (name) => `${name} removed`,
    announceAllSelected: (n) => (n === 1 ? "1 item selected" : `All ${n} items selected`),
    announceAllRemoved: (n) => (n === 1 ? "1 item removed" : `All ${n} items removed`),
    chipHelp: (name) => `${name}. Press Delete or Backspace to remove, arrow keys to move.`,
    chipHelpOpen: (name) => `${name}. Press Enter to open, Delete or Backspace to remove, arrow keys to move.`,
    dismiss: "Dismiss",
    newRecord: (table) => `New ${table}`,
    maxNote: (max) => `You can select up to ${max} ${max === 1 ? "record" : "records"}.`,
    maxReached: (max) => `Maximum reached: you can select up to ${max} ${max === 1 ? "record" : "records"}.`,
    heldHint: "Your selections are linked when you save the record.",
    saveFirst: "Save the record first, then pick values here.",
    offline: "Not available while you're offline.",
    notOnForm: "This control can only be used on a model-driven form.",
    noRelationship: "Set the N:N relationship schema name in the control properties.",
    notManyToMany: (relationship, table, relationships) =>
        `"${relationship}" is not a many-to-many relationship of ${table}. Check the relationship schema name in the control properties.${relationships.length ? ` Many-to-many relationships on ${table}: ${relationships.join(", ")}.` : ""}`,
    relationshipOtherTables: (relationship, table1, table2, table) => `Relationship "${relationship}" links ${table1} and ${table2}; it cannot be used on a ${table} form.`,
    noPrimaryName: (table) => `Table ${table} has no primary name column, so its records cannot be listed.`,
    loadSelectedFailed: "Couldn't load the selected values.",
    reloadToRetry: "Reload the form to try again.",
    addFailed: (name) => `Couldn't add "${name}".`,
    removeFailed: (name) => `Couldn't remove "${name}".`,
    manyFailed: (n) => `Couldn't save ${n} changes.`,
    createFailed: "Couldn't create the record.",
    createdNotLinked: (name) => `"${name}" was created but couldn't be linked here. Pick it from the list.`,
    createdNotOffered: (name) => `"${name}" was created, but it is not one of the records this field offers, so it was not selected.`,
    closedFailures: (n, label) => `${n} ${n === 1 ? "change" : "changes"} to ${label} couldn't be saved after the form was closed.`,
    copyFailed: (label, reason) => `The names could not be copied into ${label}: ${reason}`,
    noPermissionChange: "You don't have permission to change these related records.",
    noPermissionRead: "You don't have permission to see these related records.",
    noPermissionUpdate: "You don't have permission to change this record.",
    sessionExpired: "Your session has expired. Refresh the page and try again.",
    serverBusy: "The server is busy. Try again in a minute.",
    cannotReachServer: "Can't reach the server. Check your connection and try again.",
    searchTooSlow: "This search is too slow for this table. Search by the first letters of the name.",
    timedOut: "The server took too long to respond.",
    filterWithQuery: "The extra OData filter can't be combined with a view or a FetchXML filter. Put the condition in the FetchXML filter instead.",
    fetchWithView: "A complete FetchXML query can't be combined with a view. Use one of them, or narrow the view with <filter> and <link-entity> elements only.",
    fetchNotXml: (detail) => `The FetchXML filter isn't well-formed XML: ${detail}`,
    fetchNotQuery: "The FetchXML filter must be a complete <fetch> query, or <filter> and <link-entity> elements.",
    fetchOtherTable: (table, expected) => `The FetchXML query is for the table ${table}, but this relationship links ${expected} records.`,
    fetchAggregate: "An aggregate FetchXML query can't list records to pick.",
    viewNotFound: (view, table, views) => `There is no active view "${view}" for the table ${table}.${views.length ? ` Views of this table and their ids: ${views.join(", ")}.` : ""}`,
    viewTranslated: (view, id) => `"${view}" is a translated view name, which differs from one language to another. Enter the id of the view instead: ${id}.`,
    viewOtherTable: (view, table, expected) => `The view "${view}" belongs to the table ${table}, but this relationship links ${expected} records. Choose a view of ${expected}.`,
    queryTooLong: "The query is too long to send to the server. Shorten the filters of the view or the FetchXML filter.",
};

const fr: Strings = {
    placeholder: "Sélectionner ou rechercher des options",
    relatedRecords: "Enregistrements associés",
    noName: "(Sans nom)",
    selectAll: "Sélectionner tout",
    itemCount: (n) => `${n} ${n <= 1 ? "élément" : "éléments"}`,
    loading: "Chargement…",
    noEntries: "Aucune entrée trouvée",
    loadFailed: "Impossible de charger les enregistrements.",
    loadMoreFailed: "Impossible de charger plus d'enregistrements. Faites défiler pour réessayer.",
    searchFailed: "La recherche a échoué.",
    showOptions: "Afficher les options",
    remove: (name) => `Retirer ${name}`,
    openRecordTitle: (name) => `Ouvrir ${name} dans un nouvel onglet`,
    less: "moins",
    showAll: (hidden, n) => `+${hidden}, afficher les ${n} valeurs sélectionnées`,
    showFewer: "Afficher moins de valeurs sélectionnées",
    selectedValuesFor: (label) => `Valeurs sélectionnées pour ${label}`,
    selectionSummary: (n, names) => {
        const count = n === 0 ? "Aucune sélection" : n === 1 ? "1 élément sélectionné" : `${n} éléments sélectionnés`;
        return n > 0 && names.length ? `${count}\u00a0: ${names.join(", ")}` : count;
    },
    announceSelected: (name) => `${name}\u00a0: sélectionné`,
    announceRemoved: (name) => `${name}\u00a0: retiré`,
    announceAllSelected: (n) => (n === 1 ? "1 élément sélectionné" : `Les ${n} éléments sont sélectionnés`),
    announceAllRemoved: (n) => (n === 1 ? "1 élément retiré" : `Les ${n} éléments ont été retirés`),
    chipHelp: (name) => `${name}. Appuyez sur Suppr ou Retour arrière pour le retirer, sur les flèches pour vous déplacer.`,
    chipHelpOpen: (name) => `${name}. Appuyez sur Entrée pour l'ouvrir, sur Suppr ou Retour arrière pour le retirer, sur les flèches pour vous déplacer.`,
    dismiss: "Fermer",
    newRecord: (table) => `Nouveau (${table})`,
    maxNote: (max) => `Vous pouvez sélectionner jusqu'à ${max} ${max <= 1 ? "enregistrement" : "enregistrements"}.`,
    maxReached: (max) => `Maximum atteint\u00a0: vous pouvez sélectionner jusqu'à ${max} ${max <= 1 ? "enregistrement" : "enregistrements"}.`,
    heldHint: "Vos choix seront liés lorsque vous enregistrerez la fiche.",
    saveFirst: "Enregistrez d'abord la fiche, puis choisissez des valeurs ici.",
    offline: "Non disponible hors connexion.",
    notOnForm: "Ce contrôle ne peut être utilisé que sur un formulaire d'application pilotée par modèle.",
    noRelationship: "Indiquez le nom de schéma de la relation N:N dans les propriétés du contrôle.",
    notManyToMany: (relationship, table, relationships) =>
        `«\u00a0${relationship}\u00a0» n'est pas une relation N:N de la table ${table}. Vérifiez le nom de schéma de la relation dans les propriétés du contrôle.${relationships.length ? ` Relations N:N de la table ${table}\u00a0: ${relationships.join(", ")}.` : ""}`,
    relationshipOtherTables: (relationship, table1, table2, table) =>
        `La relation «\u00a0${relationship}\u00a0» lie les tables ${table1} et ${table2}. Elle ne peut pas être utilisée sur un formulaire de la table ${table}.`,
    noPrimaryName: (table) => `La table ${table} n'a pas de colonne de nom principal. Ses enregistrements ne peuvent donc pas être listés.`,
    loadSelectedFailed: "Impossible de charger les valeurs sélectionnées.",
    reloadToRetry: "Rechargez le formulaire pour réessayer.",
    addFailed: (name) => `Impossible d'ajouter «\u00a0${name}\u00a0».`,
    removeFailed: (name) => `Impossible de retirer «\u00a0${name}\u00a0».`,
    manyFailed: (n) => `Impossible d'enregistrer ${n} modifications.`,
    createFailed: "Impossible de créer l'enregistrement.",
    createdNotLinked: (name) => `«\u00a0${name}\u00a0» a été créé, mais n'a pas pu être lié ici. Sélectionnez-le dans la liste.`,
    createdNotOffered: (name) =>
        `«\u00a0${name}\u00a0» a été créé, mais comme il ne fait pas partie des enregistrements proposés par ce champ, il n'a pas été sélectionné.`,
    closedFailures: (n, label) =>
        n <= 1
            ? `Une modification de ${label} n'a pas pu être enregistrée après la fermeture du formulaire.`
            : `${n} modifications de ${label} n'ont pas pu être enregistrées après la fermeture du formulaire.`,
    copyFailed: (label, reason) => `Les noms n'ont pas pu être copiés dans ${label}\u00a0: ${reason}`,
    noPermissionChange: "Vous n'avez pas l'autorisation de modifier ces enregistrements associés.",
    noPermissionRead: "Vous n'avez pas l'autorisation d'afficher ces enregistrements associés.",
    noPermissionUpdate: "Vous n'avez pas l'autorisation de modifier cet enregistrement.",
    sessionExpired: "Votre session a expiré. Actualisez la page et réessayez.",
    serverBusy: "Le serveur est occupé. Réessayez dans une minute.",
    cannotReachServer: "Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.",
    searchTooSlow: "Cette recherche est trop lente pour cette table. Recherchez par les premières lettres du nom.",
    timedOut: "Le serveur a mis trop de temps à répondre.",
    filterWithQuery: "Le filtre OData supplémentaire ne peut pas être combiné avec une vue ou un filtre FetchXML. Placez plutôt la condition dans le filtre FetchXML.",
    fetchWithView:
        "Une requête FetchXML complète ne peut pas être combinée avec une vue. Utilisez l'une ou l'autre, ou limitez la vue avec des éléments <filter> et <link-entity> seulement.",
    fetchNotXml: (detail) => `Le filtre FetchXML n'est pas un XML bien formé\u00a0: ${detail}`,
    fetchNotQuery: "Le filtre FetchXML doit être une requête <fetch> complète, ou des éléments <filter> et <link-entity>.",
    fetchOtherTable: (table, expected) => `La requête FetchXML porte sur la table ${table}, alors que cette relation lie des enregistrements de ${expected}.`,
    fetchAggregate: "Une requête FetchXML d'agrégation ne peut pas lister des enregistrements à sélectionner.",
    viewNotFound: (view, table, views) =>
        `Aucune vue active «\u00a0${view}\u00a0» n'existe pour la table ${table}.${views.length ? ` Vues de cette table et leurs identifiants\u00a0: ${views.join(", ")}.` : ""}`,
    viewTranslated: (view, id) => `«\u00a0${view}\u00a0» est un nom de vue traduit, qui change d'une langue à l'autre. Indiquez plutôt l'identifiant de la vue\u00a0: ${id}.`,
    viewOtherTable: (view, table, expected) =>
        `La vue «\u00a0${view}\u00a0» appartient à la table ${table}, alors que cette relation lie des enregistrements de ${expected}. Choisissez une vue de ${expected}.`,
    queryTooLong: "La requête est trop longue pour être envoyée au serveur. Raccourcissez les filtres de la vue ou le filtre FetchXML.",
};

/** French LCIDs: France, Canada, Belgium, Switzerland, Luxembourg, Monaco. */
const LANGUAGES: { lcids: number[]; strings: Strings }[] = [{ lcids: [1036, 3084, 2060, 4108, 5132, 6156], strings: fr }];

/** Text for the given Dynamics language id; English when the language isn't translated. */
export function stringsFor(languageId: number | null | undefined): Strings {
    const match = LANGUAGES.find((l) => languageId !== null && languageId !== undefined && l.lcids.includes(languageId));
    return match ? match.strings : en;
}

export const english = en;
