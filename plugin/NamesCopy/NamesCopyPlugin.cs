using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Microsoft.Crm.Sdk.Messages;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Metadata.Query;
using Microsoft.Xrm.Sdk.Query;

namespace NToNMultiSelect.NamesCopy
{
    /// <summary>
    /// The names copy plug-in (an optional solution): rebuilds the host column copy of N:N Multi-Select ("Copy names
    /// into the host column") after every link made or removed elsewhere than in the control: subgrids, the other side
    /// of the relationship, imports, flows, integrations, the Web API. Installed, it copies; its steps deactivated or
    /// deleted, the control works as without it. Register it on
    /// Associate and Disassociate, no primary table, PostOperation, synchronous. Those steps run for every link in the
    /// environment (1:N and system relationships too), so the relationship name is first looked up in the settings of
    /// all active forms, read with one cached query: it returns at once unless a form has the control on this
    /// relationship with "Copy names into the host column" set to Yes.
    /// Deleting a linked record removes its links without a Disassociate, and renaming one changes no link: two optional
    /// steps on Delete (PreValidation and PostOperation, see ExecuteDelete) and one on Update (PreOperation, see
    /// ExecuteUpdate), all synchronous, rebuild the records linked to it. No solution contains them: the steps page
    /// creates them for each linked table, so that the deletes and updates of every other table pay nothing.
    /// A failed service call ends the link's transaction, so it is never caught and continued: it is thrown with a
    /// clear message and the link is rolled back. A setting that can't work (the relationship isn't N:N, the host
    /// column isn't text or can't be updated) is found after successful calls only: it is traced and skipped, and the
    /// link is kept.
    /// The instance is reused and shared across threads: it keeps nothing of one execution in fields.
    /// </summary>
    public sealed class NamesCopyPlugin : IPlugin
    {
        /// <summary>How long form settings and metadata are kept. A form published meanwhile counts after this time.</summary>
        private static readonly TimeSpan CacheTime = TimeSpan.FromMinutes(2);

        /// <summary>The time the caches go by: DateTime.UtcNow. Not read-only, so that it can be replaced.</summary>
        private static Func<DateTime> Clock = () => DateTime.UtcNow;

        /// <summary>The copy settings of the active forms of each organisation (see LoadForms).</summary>
        private static readonly ConcurrentDictionary<Guid, Cached<IReadOnlyDictionary<string, Host[]>>> Forms =
            new ConcurrentDictionary<Guid, Cached<IReadOnlyDictionary<string, Host[]>>>();

        /// <summary>The copy plans, by organisation, relationship, host table and host columns (see LoadPlan).</summary>
        private static readonly ConcurrentDictionary<string, Cached<CopyPlan>> Plans = new ConcurrentDictionary<string, Cached<CopyPlan>>();

        private const int PageSize = 5000;

        /// <summary>
        /// How long the copies of one delete or rename operation may take, from its first step that needs it (see
        /// Deadline). Dataverse stops a whole message operation after 2 minutes, with all its synchronous steps and
        /// cascaded deletes, and rolls it back; the records left when this time has passed keep the deleted or old
        /// name. Not read-only, so that it can be changed.
        /// </summary>
        private static TimeSpan CopiesTime = TimeSpan.FromSeconds(30);

        /// <summary>The SharedVariables key of the deadline of a delete or rename operation (see Deadline).</summary>
        private const string DeadlineKey = "NToNMultiSelect.NamesCopy.Deadline";

        /// <summary>
        /// The deadlines of the delete and rename operations by CorrelationId, for a cascaded or nested one whose
        /// contexts don't reach the SharedVariables of the first one (see Deadline). Dropped a few minutes after they
        /// pass.
        /// </summary>
        private static readonly ConcurrentDictionary<Guid, DateTime> Deadlines = new ConcurrentDictionary<Guid, DateTime>();

        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            if (context.MessageName == "Delete")
            {
                ExecuteDelete(serviceProvider, context);
                return;
            }
            if (context.MessageName == "Update")
            {
                ExecuteUpdate(serviceProvider, context);
                return;
            }
            if (context.MessageName != "Associate" && context.MessageName != "Disassociate") return;
            var target = Input<EntityReference>(context, "Target");
            var relationship = Input<Relationship>(context, "Relationship");
            var related = Input<EntityReferenceCollection>(context, "RelatedEntities");
            if (target == null || string.IsNullOrEmpty(relationship?.SchemaName) || related == null) return;

            var service = SystemService(serviceProvider);
            var forms = ReadForms(context, service);
            // Links of every other relationship end here, without a service call once the forms are read.
            if (!forms.TryGetValue(relationship.SchemaName.ToLowerInvariant(), out var hosts)) return;

            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var records = new[] { target }.Concat(related).ToList();
            var control = ControlCopy(context, relationship.SchemaName);
            foreach (var host in hosts)
            {
                // A self-referencing relationship has the table on both sides: both records are rebuilt.
                // The records are rebuilt in one order in every execution: by table (the hosts are in that order, see
                // LoadForms), then by id. Rebuild locks each record it updates until the link commits, so two requests
                // that link several of the same records, in another order each, would otherwise each wait for a
                // record the other one holds: a deadlock, and one of the links rolled back.
                var ids = records.Where(r => r.LogicalName == host.Table).Select(r => r.Id).Distinct()
                    .Where(id => !BeingDeleted(context, host.Table, id))
                    .OrderBy(id => id)
                    .ToList();
                if (ids.Count == 0) continue;
                var plan = CopyPlanOf(context, service, tracing, relationship.SchemaName, host);
                if (plan == null) continue;
                try
                {
                    foreach (var id in ids)
                    {
                        // The control's record: the other host columns, if any.
                        var copied = control != null && control.Table == host.Table && control.Id == id && ControlMayWrite(service.Value, context, plan, control)
                            ? Without(plan, control.Column)
                            : plan;
                        if (copied != null) Rebuild(service.Value, tracing, copied, id);
                    }
                }
                catch (Exception error)
                {
                    // The transaction has ended: the link is rolled back with this message.
                    throw new InvalidPluginExecutionException(
                        $"N:N Multi-Select could not copy the names into {ColumnNames(plan.Table, plan.Columns.Select(c => c.Name))}: {error.Message}", error);
                }
            }
        }

        private static T Input<T>(IPluginExecutionContext context, string name) where T : class
        {
            return context.InputParameters.TryGetValue(name, out object value) ? value as T : null;
        }

        /// <summary>What a tag of the control starts with (see ControlCopy).</summary>
        private const string ControlTag = "NToNMultiSelect|";

        /// <summary>A host column the control writes itself for the link being handled (see ControlCopy).</summary>
        private sealed class ControlColumn
        {
            public ControlColumn(string table, Guid id, string column)
            {
                Table = table;
                Id = id;
                Column = column;
            }

            public string Table { get; }
            public Guid Id { get; }
            public string Column { get; }
        }

        /// <summary>
        /// The host column the control writes itself for this link, or null. While "Copy names into the host column" is
        /// Yes, the control tags the links it makes and removes for the record its form shows (the Web API's tag
        /// parameter, which Dataverse passes on in SharedVariables): "NToNMultiSelect|relationship|table|id|column".
        /// It writes that column of that record itself once they are saved, as it does without the plug-in, so these
        /// steps leave that column of that record alone for that relationship, and the control's links cost no more
        /// than without the plug-in. The other records of the link and the other host columns are still rebuilt, and
        /// so are the links any other caller makes. Any caller can send a tag: it is followed only when the user could
        /// write that column themselves (see ControlMayWrite). The tag is looked for in the parent contexts too: a link another
        /// plug-in makes within the control's request, before its names are written. Not past an asynchronous one:
        /// work queued by the request runs later, maybe after the control has written the names, and its links count
        /// as made elsewhere.
        /// </summary>
        private static ControlColumn ControlCopy(IPluginExecutionContext context, string relationshipName)
        {
            for (var c = context; c != null && c.Mode == 0; c = c.ParentContext)
            {
                if (!c.SharedVariables.TryGetValue("tag", out object value) || !(value is string tag) || !tag.StartsWith(ControlTag, StringComparison.Ordinal)) continue;
                var parts = tag.Split('|');
                if (parts.Length == 5 && string.Equals(parts[1], relationshipName, StringComparison.OrdinalIgnoreCase) &&
                    !string.IsNullOrEmpty(parts[2]) && Guid.TryParse(parts[3], out var id) && !string.IsNullOrEmpty(parts[4]))
                {
                    return new ControlColumn(parts[2], id, parts[4]);
                }
            }
            return null;
        }

        /// <summary>
        /// Whether the tag may be followed: whether the user who made the link could write the tagged column of the
        /// tagged record themselves. Any caller can send a tag; one who could not write the column would otherwise keep
        /// it out of date. So the tag is followed only when the column has no column security and the user may write the
        /// record: Write access to it where Dataverse answers RetrievePrincipalAccess for the table (most tables owned
        /// by users or teams), the table's Write privilege for a table owned by the organization (one request, only for
        /// a tagged link). Otherwise the column is rebuilt as for any other link. The request must not fail: a failed
        /// request ends the transaction, so each table gets the one that works for it (see LoadPlan). The user is the
        /// one the request runs for (InitiatingUserId; with impersonation, the impersonated user).
        /// </summary>
        private static bool ControlMayWrite(IOrganizationService service, IPluginExecutionContext context, CopyPlan plan, ControlColumn control)
        {
            var column = plan.Columns.FirstOrDefault(c => c.Name == control.Column);
            if (column == null || column.Secured) return false;
            if (plan.PrincipalAccess)
            {
                var access = (RetrievePrincipalAccessResponse)service.Execute(new RetrievePrincipalAccessRequest
                {
                    Principal = new EntityReference("systemuser", context.InitiatingUserId),
                    Target = new EntityReference(control.Table, control.Id),
                });
                return (access.AccessRights & AccessRights.WriteAccess) != 0;
            }
            if (plan.Ownership == OwnershipTypes.OrganizationOwned && !string.IsNullOrEmpty(plan.WritePrivilege))
            {
                // Organization-owned: the privilege is for every record of the table. Roles of the user's teams count.
                var privileges = (RetrieveUserPrivilegeByPrivilegeNameResponse)service.Execute(new RetrieveUserPrivilegeByPrivilegeNameRequest
                {
                    PrivilegeName = plan.WritePrivilege,
                    UserId = context.InitiatingUserId,
                });
                return privileges.RolePrivileges != null && privileges.RolePrivileges.Length > 0;
            }
            return false;
        }

        /// <summary>
        /// Whether Dataverse answers RetrievePrincipalAccess for `table`. Not a matter of ownership alone: tables owned by
        /// the organization have no such answer, and neither have some tables owned by users. Each table's messages are
        /// listed in sdkmessagefilter, which can be read without failing.
        /// </summary>
        private static bool SupportsPrincipalAccess(IOrganizationService service, string table)
        {
            var query = new QueryExpression("sdkmessagefilter") { ColumnSet = new ColumnSet("sdkmessagefilterid"), TopCount = 1 };
            query.Criteria.AddCondition("primaryobjecttypecode", ConditionOperator.Equal, table);
            var message = query.AddLink("sdkmessage", "sdkmessageid", "sdkmessageid");
            message.LinkCriteria.AddCondition("name", ConditionOperator.Equal, "RetrievePrincipalAccess");
            return service.RetrieveMultiple(query).Entities.Count > 0;
        }

        /// <summary>`plan` without the host column `column`, or null when that was its only one.</summary>
        private static CopyPlan Without(CopyPlan plan, string column)
        {
            if (plan.Columns.All(c => c.Name != column)) return plan;
            var columns = plan.Columns.Where(c => c.Name != column).ToArray();
            if (columns.Length == 0) return null;
            return new CopyPlan
            {
                Table = plan.Table,
                TableId = plan.TableId,
                Ownership = plan.Ownership,
                PrincipalAccess = plan.PrincipalAccess,
                WritePrivilege = plan.WritePrivilege,
                Columns = columns,
                Intersect = plan.Intersect,
                HostAttribute = plan.HostAttribute,
                OtherAttribute = plan.OtherAttribute,
                OtherTable = plan.OtherTable,
                OtherId = plan.OtherId,
                OtherName = plan.OtherName,
            };
        }

        /// <summary>
        /// As the system user: the copy holds every linked name, also those the editing user can't read, and it is
        /// written whatever column security the host column has. The audit history shows SYSTEM as Modified By.
        /// </summary>
        private static Lazy<IOrganizationService> SystemService(IServiceProvider serviceProvider)
        {
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            return new Lazy<IOrganizationService>(() => factory.CreateOrganizationService(null));
        }

        /// <summary>The copy settings of the active forms (see LoadForms), from the cache.</summary>
        private static IReadOnlyDictionary<string, Host[]> ReadForms(IPluginExecutionContext context, Lazy<IOrganizationService> service)
        {
            try
            {
                return FromCache(Forms, context.OrganizationId, () =>
                {
                    DropExpiredPlans();
                    return LoadForms(service.Value);
                });
            }
            catch (Exception error)
            {
                throw new InvalidPluginExecutionException(
                    $"N:N Multi-Select could not read which forms copy names: {error.Message}", error);
            }
        }

        /// <summary>
        /// Deleting a linked record removes its links without a Disassociate: the platform deletes the intersect rows
        /// itself, before PreOperation. The host records linked to it would keep its name, so two steps on Delete (the
        /// linked table, synchronous) rebuild them. PreValidation (stage 10), while the links are still there, notes
        /// the host records linked to the record in SharedVariables, under the record's key. PostOperation (stage 40),
        /// once the record and its links are gone, rebuilds them. Deletes of the other tables end after a dictionary
        /// lookup (in PreValidation) or without one (in PostOperation, nothing was noted).
        /// </summary>
        private static void ExecuteDelete(IServiceProvider serviceProvider, IPluginExecutionContext context)
        {
            var target = Input<EntityReference>(context, "Target");
            if (target == null || target.Id == Guid.Empty || string.IsNullOrEmpty(target.LogicalName)) return;
            var key = NotesKey(target);
            if (context.Stage == 10) NoteLinkedHosts(serviceProvider, context, target, key);
            else if (context.Stage == 40) RebuildNotedHosts(serviceProvider, context, target, key);
        }

        /// <summary>The SharedVariables key of the host records noted for the delete of `record`.</summary>
        private static string NotesKey(EntityReference record)
        {
            return "NToNMultiSelect.NamesCopy.Delete|" + record.LogicalName + "|" + record.Id;
        }

        /// <summary>
        /// Notes, in PreValidation, the host records linked to `target` that hold its name, one entry for each host
        /// and relationship: "relationship schema name|host table|host columns|id,id,...", joined with ";". Each entry
        /// holds what PostOperation needs, so that it reads neither the forms nor the routes. Nothing is noted when
        /// there are none. The first delete of a request runs this step outside a transaction: a call that fails there
        /// ends nothing, so it is traced and the delete goes on without the copies, as it would without the plug-in.
        /// In a transaction (a nested or cascaded delete) the failed call has ended it, and it is thrown.
        /// </summary>
        private static void NoteLinkedHosts(IServiceProvider serviceProvider, IPluginExecutionContext context, EntityReference target, string key)
        {
            var service = SystemService(serviceProvider);
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var notes = new List<string>();
            try
            {
                // Deletes of every other table end here, without a service call once the forms and routes are read.
                if (!ReadRoutes(context, service).TryGetValue(target.LogicalName, out var routes)) return;
                Deadline(context);
                foreach (var route in routes)
                {
                    var plan = CopyPlanOf(context, service, tracing, route.SchemaName, route.Host);
                    if (plan == null || plan.OtherTable != target.LogicalName) continue;
                    List<Guid> hosts;
                    try
                    {
                        hosts = ReadHosts(service.Value, tracing, plan, target);
                    }
                    catch (Exception error)
                    {
                        throw new InvalidPluginExecutionException(
                            $"N:N Multi-Select could not read the records whose {ColumnNames(plan.Table, plan.Columns.Select(c => c.Name))} hold the name of {target.LogicalName} {target.Id}: {error.Message}", error);
                    }
                    // A record linked to itself (a self-referencing relationship) is deleted with its copy.
                    hosts.RemoveAll(id => plan.Table == target.LogicalName && id == target.Id);
                    if (hosts.Count == 0) continue;
                    notes.Add(string.Join("|", route.SchemaName, plan.Table, string.Join(",", route.Host.Columns), string.Join(",", hosts)));
                }
            }
            catch (InvalidPluginExecutionException error) when (!context.IsInTransaction)
            {
                tracing.Trace("{0} The records linked to {1} {2} keep its name.", error.Message, target.LogicalName, target.Id);
                return;
            }
            if (notes.Count > 0) context.SharedVariables[key] = string.Join(";", notes);
        }

        /// <summary>
        /// Rebuilds, in PostOperation, the host records PreValidation noted for `target`, in the order of every
        /// rebuild (by table, then id), so that a delete and a link of the same records can't deadlock. Each costs
        /// about as much as a link; those left when the operation's deadline has passed keep the deleted name, which
        /// is traced, so that the delete itself doesn't run into the 2-minute limit. A failed call has ended the
        /// transaction: it is thrown with the record that can't be written, and the delete is rolled back.
        /// </summary>
        private static void RebuildNotedHosts(IServiceProvider serviceProvider, IPluginExecutionContext context, EntityReference target, string key)
        {
            // Stage 10 variables reach stage 40 through ParentContext (the PreValidation step runs in a context of its
            // own); the step's own variables are read first in case that changes.
            string noted = null;
            for (var c = context; c != null && noted == null; c = c.ParentContext)
            {
                if (c.SharedVariables.TryGetValue(key, out object value)) noted = value as string;
            }
            if (string.IsNullOrEmpty(noted)) return;

            var service = SystemService(serviceProvider);
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var work = new List<KeyValuePair<CopyPlan, Guid>>();
            foreach (var note in noted.Split(';').Select(n => n.Split('|')).Where(n => n.Length == 4))
            {
                var plan = CopyPlanOf(context, service, tracing, note[0], new Host(note[1], note[2].Split(',')));
                if (plan == null) continue;
                foreach (var id in note[3].Split(',').Select(Guid.Parse).Where(id => !BeingDeleted(context, plan.Table, id)))
                {
                    work.Add(new KeyValuePair<CopyPlan, Guid>(plan, id));
                }
            }
            // A record noted through two relationships is rebuilt once for each, one after the other.
            work = work.OrderBy(w => w.Key.Table, StringComparer.Ordinal).ThenBy(w => w.Value).ToList();

            var deadline = Deadline(context);
            for (var i = 0; i < work.Count; i++)
            {
                var plan = work[i].Key;
                var id = work[i].Value;
                if (Clock() > deadline)
                {
                    tracing.Trace("{0} {1}: the time for the copies of this delete ran out; {2} linked records keep its name until their links next change.",
                        target.LogicalName, target.Id, work.Count - i);
                    return;
                }
                try
                {
                    Rebuild(service.Value, tracing, plan, id);
                }
                catch (Exception error)
                {
                    throw new InvalidPluginExecutionException(
                        $"N:N Multi-Select could not copy the names into {ColumnNames(plan.Table, plan.Columns.Select(c => c.Name))} of {plan.Table} {id}: {error.Message}", error);
                }
            }
        }

        /// <summary>
        /// The time by which the copies of the current delete or rename operation stop (see CopiesTime). The first
        /// delete or rename of a request sets it in its SharedVariables; a nested or cascaded one finds it through
        /// ParentContext, or else in Deadlines by the request's CorrelationId (when it runs in the same sandbox worker),
        /// so that all the deletes and renames of one operation share one budget.
        /// </summary>
        private static DateTime Deadline(IPluginExecutionContext context)
        {
            for (var c = context; c != null; c = c.ParentContext)
            {
                if (c.SharedVariables.TryGetValue(DeadlineKey, out object value) && value is long ticks) return new DateTime(ticks, DateTimeKind.Utc);
            }
            var now = Clock();
            var deadline = now + CopiesTime;
            if (context.CorrelationId != Guid.Empty)
            {
                foreach (var old in Deadlines.Where(d => d.Value < now - CacheTime))
                {
                    ((ICollection<KeyValuePair<Guid, DateTime>>)Deadlines).Remove(old);
                }
                deadline = Deadlines.GetOrAdd(context.CorrelationId, deadline);
            }
            context.SharedVariables[DeadlineKey] = deadline.Ticks;
            return deadline;
        }

        /// <summary>
        /// Renaming a linked record changes none of its links, so the host records linked to it would keep its old
        /// name: a step on Update (synchronous, PreOperation) rebuilds them with the new one. PreOperation, so that the
        /// old name can still be read: an update that doesn't set the name, or sets the one it already has (an import
        /// or an integration that sends every column), writes nothing. The links are read before the new name is
        /// saved, so the rebuilds put it in place of the old one (see ReadLinks). Updates of the other tables end after
        /// a dictionary lookup, and those of a linked table that don't set its name after the cached copy plans, without
        /// a service call. The update runs in a transaction: a failed call has ended it, so it is thrown with a clear
        /// message and the rename is rolled back. The records left when the operation's time has passed (see
        /// CopiesTime) keep the old name, which is traced.
        /// </summary>
        private static void ExecuteUpdate(IServiceProvider serviceProvider, IPluginExecutionContext context)
        {
            if (context.Stage != 20) return;
            var target = Input<Entity>(context, "Target");
            if (target == null || target.Id == Guid.Empty || string.IsNullOrEmpty(target.LogicalName)) return;
            var service = SystemService(serviceProvider);
            // Updates of every other table end here, without a service call once the forms and routes are read.
            if (!ReadRoutes(context, service).TryGetValue(target.LogicalName, out var routes)) return;
            var tracing = (ITracingService)serviceProvider.GetService(typeof(ITracingService));
            var plans = routes.Select(route => CopyPlanOf(context, service, tracing, route.SchemaName, route.Host))
                .Where(plan => plan != null && plan.OtherTable == target.LogicalName && target.Contains(plan.OtherName))
                .ToList();
            if (plans.Count == 0) return;

            // Every plan reads the same column: the table's primary name.
            var rename = new LinkedName(target.Id.ToString(), target.GetAttributeValue<string>(plans[0].OtherName));
            var work = new List<KeyValuePair<CopyPlan, Guid>>();
            try
            {
                var saved = ReadOther(service.Value, plans[0], target.Id);
                // Compared as the copies show them: no name and a blank one are both "(No name)".
                if (saved == null || new LinkedName(rename.Id, saved.GetAttributeValue<string>(plans[0].OtherName)).Name == rename.Name) return;
                foreach (var plan in plans)
                {
                    foreach (var id in ReadHosts(service.Value, tracing, plan, target.ToEntityReference()).Where(id => !BeingDeleted(context, plan.Table, id)))
                    {
                        work.Add(new KeyValuePair<CopyPlan, Guid>(plan, id));
                    }
                }
            }
            catch (Exception error)
            {
                throw new InvalidPluginExecutionException(
                    $"N:N Multi-Select could not read the records that hold the name of {target.LogicalName} {target.Id}: {error.Message}", error);
            }
            // In the order of every rebuild (by table, then id), so that a rename and a link of the same records can't
            // deadlock. A record linked through two relationships is rebuilt once for each, one after the other.
            work = work.OrderBy(w => w.Key.Table, StringComparer.Ordinal).ThenBy(w => w.Value).ToList();

            var deadline = Deadline(context);
            for (var i = 0; i < work.Count; i++)
            {
                var plan = work[i].Key;
                var id = work[i].Value;
                if (Clock() > deadline)
                {
                    tracing.Trace("{0} {1}: the time for the copies of this rename ran out; {2} linked records keep its old name until their links next change.",
                        target.LogicalName, target.Id, work.Count - i);
                    return;
                }
                try
                {
                    if (plan.Table == target.LogicalName && id == target.Id) CopyIntoTarget(service.Value, plan, target, rename);
                    else Rebuild(service.Value, tracing, plan, id, rename);
                }
                catch (Exception error)
                {
                    throw new InvalidPluginExecutionException(
                        $"N:N Multi-Select could not copy the names into {ColumnNames(plan.Table, plan.Columns.Select(c => c.Name))} of {plan.Table} {id}: {error.Message}", error);
                }
            }
        }

        /// <summary>
        /// The copy of the renamed record itself, when a self-referencing relationship links it to itself: put into the
        /// update being saved, rather than written by a second Update of the same record within this one, which would
        /// change its row version before the first is saved (and fail an update that checks it).
        /// </summary>
        private static void CopyIntoTarget(IOrganizationService service, CopyPlan plan, Entity target, LinkedName rename)
        {
            var links = ReadLinks(service, plan, target.Id, rename);
            foreach (var column in plan.Columns) target[column.Name] = NamesCopyHelpers.NamesText(links, column.MaxLength);
        }

        /// <summary>
        /// Record `id` of the table whose names `plan` copies, with its name column, or null when it doesn't exist. A
        /// query rather than Retrieve, as in ReadRecord.
        /// </summary>
        private static Entity ReadOther(IOrganizationService service, CopyPlan plan, Guid id)
        {
            var query = new QueryExpression(plan.OtherTable) { ColumnSet = new ColumnSet(plan.OtherName) };
            query.Criteria.AddCondition(plan.OtherId, ConditionOperator.Equal, id);
            return service.RetrieveMultiple(query).Entities.FirstOrDefault();
        }

        /// <summary>
        /// The copy plan of a host and relationship, from the cache, or null when it copies nothing. A setting that
        /// can't work is kept for the cache time like a working plan, so that it costs no service call either; it is
        /// traced once in each execution that meets it, and the link or delete is kept. A failed load is thrown with
        /// a clear message.
        /// </summary>
        private static CopyPlan CopyPlanOf(IPluginExecutionContext context, Lazy<IOrganizationService> service, ITracingService tracing,
            string relationshipName, Host host)
        {
            CopyPlan plan;
            try
            {
                plan = FromCache(Plans,
                    $"{context.OrganizationId}|{relationshipName.ToLowerInvariant()}|{host.Table}|{string.Join(",", host.Columns)}",
                    () => LoadPlan(service.Value, relationshipName, host.Table, host.Columns));
            }
            catch (Exception error)
            {
                throw new InvalidPluginExecutionException(
                    $"N:N Multi-Select could not copy the names into {ColumnNames(host.Table, host.Columns)}: {error.Message}", error);
            }
            foreach (var problem in plan.Problems) tracing.Trace("{0}", problem);
            return plan.Columns.Length == 0 ? null : plan;
        }

        /// <summary>
        /// A host and relationship whose copy holds the names of another table's records: the copies to rebuild when
        /// one of those records is deleted.
        /// </summary>
        private sealed class Route
        {
            public Route(string schemaName, Host host)
            {
                SchemaName = schemaName;
                Host = host;
            }

            /// <summary>As in the metadata, for RetrieveRelationship.</summary>
            public string SchemaName { get; }

            public Host Host { get; }
        }

        /// <summary>The routes of one organisation and the forms they were built from (see ReadRoutes).</summary>
        private sealed class RouteTable
        {
            public RouteTable(IReadOnlyDictionary<string, Host[]> forms, IReadOnlyDictionary<string, Route[]> byTable)
            {
                Forms = forms;
                ByTable = byTable;
            }

            public IReadOnlyDictionary<string, Host[]> Forms { get; }
            public IReadOnlyDictionary<string, Route[]> ByTable { get; }
        }

        /// <summary>The routes of each organisation (see ReadRoutes).</summary>
        private static readonly ConcurrentDictionary<Guid, RouteTable> Routes = new ConcurrentDictionary<Guid, RouteTable>();

        /// <summary>
        /// The routes of the cached forms (see LoadRoutes), by the table whose names they copy. They are built again
        /// whenever the forms are, so that a delete follows a form setting as soon as a link does.
        /// </summary>
        private static IReadOnlyDictionary<string, Route[]> ReadRoutes(IPluginExecutionContext context, Lazy<IOrganizationService> service)
        {
            var forms = ReadForms(context, service);
            if (Routes.TryGetValue(context.OrganizationId, out var known) && ReferenceEquals(known.Forms, forms)) return known.ByTable;
            try
            {
                var routes = new RouteTable(forms, LoadRoutes(service.Value, forms));
                Routes[context.OrganizationId] = routes;
                return routes.ByTable;
            }
            catch (Exception error)
            {
                throw new InvalidPluginExecutionException(
                    $"N:N Multi-Select could not read which tables' names are copied: {error.Message}", error);
            }
        }

        /// <summary>
        /// For each table, the hosts and relationships whose copies hold the names of its records. One metadata query
        /// of the host tables' N:N relationships: a relationship named in a form that doesn't exist (any more) is left
        /// out without a failed call, which would end the transaction of every delete. The other table is the one
        /// LoadPlan copies from: Entity2 when the host is Entity1, also when both are (a self-referencing relationship).
        /// </summary>
        private static IReadOnlyDictionary<string, Route[]> LoadRoutes(IOrganizationService service, IReadOnlyDictionary<string, Host[]> forms)
        {
            var tables = forms.Values.SelectMany(hosts => hosts).Select(host => host.Table).Distinct().ToArray();
            if (tables.Length == 0) return new Dictionary<string, Route[]>();
            var query = new EntityQueryExpression
            {
                Criteria = new MetadataFilterExpression(LogicalOperator.And),
                Properties = new MetadataPropertiesExpression("LogicalName", "ManyToManyRelationships"),
                RelationshipQuery = new RelationshipQueryExpression
                {
                    Criteria = new MetadataFilterExpression(LogicalOperator.And),
                    Properties = new MetadataPropertiesExpression("SchemaName", "Entity1LogicalName", "Entity2LogicalName"),
                },
            };
            query.Criteria.Conditions.Add(new MetadataConditionExpression("LogicalName", MetadataConditionOperator.In, tables));
            var response = (RetrieveMetadataChangesResponse)service.Execute(new RetrieveMetadataChangesRequest { Query = query });
            var routes = new List<KeyValuePair<string, Route>>();
            foreach (var table in response.EntityMetadata)
            {
                foreach (var relationship in table.ManyToManyRelationships ?? new ManyToManyRelationshipMetadata[0])
                {
                    // The forms dictionary has the names in lower case; the metadata keeps the schema name's case.
                    if (string.IsNullOrEmpty(relationship.SchemaName) ||
                        !forms.TryGetValue(relationship.SchemaName.ToLowerInvariant(), out var hosts)) continue;
                    var host = hosts.FirstOrDefault(h => h.Table == table.LogicalName);
                    if (host == null) continue;
                    var other = relationship.Entity1LogicalName == host.Table ? relationship.Entity2LogicalName : relationship.Entity1LogicalName;
                    if (string.IsNullOrEmpty(other)) continue;
                    routes.Add(new KeyValuePair<string, Route>(other, new Route(relationship.SchemaName, host)));
                }
            }
            return routes
                .GroupBy(route => route.Key)
                .ToDictionary(byTable => byTable.Key, byTable => byTable.Select(route => route.Value)
                    // A self-referencing relationship can be listed twice.
                    .GroupBy(route => route.SchemaName + "|" + route.Host.Table).Select(same => same.First())
                    .ToArray());
        }

        /// <summary>
        /// The host records linked to `record` of the other table: one page, PageSize records. More can't be rebuilt
        /// within one delete's or rename's time anyway (see CopiesTime); the others keep its name, which is traced.
        /// </summary>
        private static List<Guid> ReadHosts(IOrganizationService service, ITracingService tracing, CopyPlan plan, EntityReference record)
        {
            var query = new QueryExpression(plan.Intersect)
            {
                ColumnSet = new ColumnSet(plan.HostAttribute),
                PageInfo = new PagingInfo { Count = PageSize, PageNumber = 1 },
            };
            query.Criteria.AddCondition(plan.OtherAttribute, ConditionOperator.Equal, record.Id);
            var page = service.RetrieveMultiple(query);
            if (page.MoreRecords)
            {
                tracing.Trace("{0} {1} has more than {2} records linked through {3}; the others keep its name.",
                    record.LogicalName, record.Id, page.Entities.Count, plan.Intersect);
            }
            return page.Entities.Select(row => row.GetAttributeValue<Guid>(plan.HostAttribute)).Distinct().ToList();
        }

        private static string ColumnNames(string table, IEnumerable<string> columns)
        {
            return string.Join(", ", columns.Select(column => table + "." + column));
        }

        /// <summary>
        /// Whether record `id` is being deleted by a Delete this execution runs within: a Disassociate of a plug-in or
        /// caller removing its links first, or the copies of a linked record deleted in the same cascade. There is no
        /// copy to write into that record.
        /// </summary>
        private static bool BeingDeleted(IPluginExecutionContext context, string table, Guid id)
        {
            for (var parent = context.ParentContext; parent != null; parent = parent.ParentContext)
            {
                if (parent.MessageName == "Delete" && parent.PrimaryEntityName == table && parent.PrimaryEntityId == id) return true;
            }
            return false;
        }

        /// <summary>The host columns of one table that copy the names of a relationship.</summary>
        private sealed class Host
        {
            public Host(string table, string[] columns)
            {
                Table = table;
                Columns = columns;
            }

            public string Table { get; }

            /// <summary>Logical names, in ordinal order.</summary>
            public string[] Columns { get; }
        }

        /// <summary>
        /// The copy settings of all active forms of the organisation, by relationship schema name in lower case: the
        /// tables and host columns to rebuild, in the ordinal order of the tables (see Execute). One query for every
        /// table, so that a link of any other relationship costs a dictionary lookup. The dictionary is never changed
        /// once built.
        /// </summary>
        private static IReadOnlyDictionary<string, Host[]> LoadForms(IOrganizationService service)
        {
            // RetrieveMultiple returns the published form XML. The like filter leaves out the forms without the control;
            // an inactive form (formactivationstate 0) isn't shown to anyone, so its settings don't count.
            var query = new QueryExpression("systemform") { ColumnSet = new ColumnSet("objecttypecode", "formxml") };
            query.Criteria.AddCondition("formxml", ConditionOperator.Like, "%" + NamesCopyHelpers.ControlName + "%");
            query.Criteria.AddCondition("formactivationstate", ConditionOperator.Equal, 1);
            return service.RetrieveMultiple(query).Entities
                .SelectMany(form => NamesCopyHelpers.ParseFormXml(form.GetAttributeValue<string>("formxml")).Select(setting => new
                {
                    Relationship = setting.RelationshipName.ToLowerInvariant(),
                    Table = form.GetAttributeValue<string>("objecttypecode"),
                    Column = setting.HostColumn,
                }))
                .Where(setting => !string.IsNullOrEmpty(setting.Table))
                .GroupBy(setting => setting.Relationship)
                .ToDictionary(byRelationship => byRelationship.Key, byRelationship => byRelationship
                    .GroupBy(setting => setting.Table)
                    .OrderBy(byTable => byTable.Key, StringComparer.Ordinal)
                    .Select(byTable => new Host(byTable.Key,
                        byTable.Select(setting => setting.Column).Distinct().OrderBy(column => column, StringComparer.Ordinal).ToArray()))
                    .ToArray());
        }

        /// <summary>A host column, its maximum length, and whether it has column security.</summary>
        private sealed class HostColumn
        {
            public HostColumn(string name, int maxLength, bool secured)
            {
                Name = name;
                MaxLength = maxLength;
                Secured = secured;
            }

            public string Name { get; }
            public int MaxLength { get; }
            public bool Secured { get; }
        }

        /// <summary>
        /// Where the names of one table's host columns come from: the tables and columns to read, and the lengths. The
        /// columns that can't take the copy are left out, with the reason in Problems. Never changed once built.
        /// </summary>
        private sealed class CopyPlan
        {
            public string Table { get; set; }
            public string TableId { get; set; }
            /// <summary>
            /// How the host table is owned, whether Dataverse answers RetrievePrincipalAccess for it, and the name of its
            /// Write privilege (see ControlMayWrite).
            /// </summary>
            public OwnershipTypes? Ownership { get; set; }
            public bool PrincipalAccess { get; set; }
            public string WritePrivilege { get; set; }
            public HostColumn[] Columns { get; set; } = new HostColumn[0];
            public string[] Problems { get; set; } = new string[0];
            public string Intersect { get; set; }
            public string HostAttribute { get; set; }
            public string OtherAttribute { get; set; }
            public string OtherTable { get; set; }
            public string OtherId { get; set; }
            public string OtherName { get; set; }
        }

        private static CopyPlan Skipped(string table, string problem)
        {
            return new CopyPlan { Table = table, Problems = new[] { problem } };
        }

        private static CopyPlan LoadPlan(IOrganizationService service, string relationshipName, string table, string[] columns)
        {
            var into = ColumnNames(table, columns);
            var relationship = ((RetrieveRelationshipResponse)service.Execute(
                new RetrieveRelationshipRequest { Name = relationshipName })).RelationshipMetadata as ManyToManyRelationshipMetadata;
            if (relationship == null)
            {
                return Skipped(table, $"{relationshipName} is not an N:N relationship: nothing is copied into {into}.");
            }
            // The side the control reads: Entity1 when the table is on both sides (a self-referencing relationship).
            var first = relationship.Entity1LogicalName == table;
            if (!first && relationship.Entity2LogicalName != table)
            {
                return Skipped(table, $"{relationshipName} doesn't link {table}: nothing is copied into {into}.");
            }
            var otherTable = first ? relationship.Entity2LogicalName : relationship.Entity1LogicalName;
            var tables = TableMetadata(service, new[] { table, otherTable }.Distinct().ToArray(), columns);
            if (!tables.TryGetValue(table, out var host) || !tables.TryGetValue(otherTable, out var other))
            {
                return Skipped(table, $"The tables of {relationshipName} were not found: nothing is copied into {into}.");
            }
            if (other.PrimaryNameAttribute == null)
            {
                return Skipped(table, $"{otherTable} has no primary name column: nothing is copied into {into}.");
            }

            var copies = new List<HostColumn>();
            var problems = new List<string>();
            foreach (var column in columns)
            {
                var attribute = host.Attributes?.FirstOrDefault(a => a.LogicalName == column);
                var maxLength = (attribute as StringAttributeMetadata)?.MaxLength ?? (attribute as MemoAttributeMetadata)?.MaxLength;
                if (attribute == null) problems.Add($"{table}.{column} doesn't exist: nothing is copied into it.");
                else if (!(attribute is StringAttributeMetadata) && !(attribute is MemoAttributeMetadata)) problems.Add($"{table}.{column} is not a text column: nothing is copied into it.");
                // Its Update would fail and roll every link of the relationship back. SourceType 0 is a simple column;
                // above 0 (calculated, rollup, formula) Dataverse computes the value itself.
                else if (attribute.SourceType > 0) problems.Add($"{table}.{column} is a calculated, rollup or formula column: nothing is copied into it.");
                else if (attribute.IsValidForUpdate == false) problems.Add($"{table}.{column} can't be updated: nothing is copied into it.");
                else if (maxLength == null) problems.Add($"{table}.{column} has no maximum length: nothing is copied into it.");
                else copies.Add(new HostColumn(column, maxLength.Value, attribute.IsSecured == true));
            }

            return new CopyPlan
            {
                Table = table,
                TableId = host.PrimaryIdAttribute,
                Ownership = host.OwnershipType,
                PrincipalAccess = SupportsPrincipalAccess(service, table),
                WritePrivilege = host.Privileges?.FirstOrDefault(privilege => privilege.PrivilegeType == PrivilegeType.Write)?.Name,
                Columns = copies.ToArray(),
                Problems = problems.ToArray(),
                Intersect = relationship.IntersectEntityName,
                HostAttribute = first ? relationship.Entity1IntersectAttribute : relationship.Entity2IntersectAttribute,
                OtherAttribute = first ? relationship.Entity2IntersectAttribute : relationship.Entity1IntersectAttribute,
                OtherTable = otherTable,
                OtherId = other.PrimaryIdAttribute,
                OtherName = other.PrimaryNameAttribute,
            };
        }

        /// <summary>
        /// The primary id and name columns of `tables`, with those of `columns` they have (all their properties). A
        /// metadata query rather than RetrieveAttribute, so that a column that doesn't exist is found without a failed
        /// call.
        /// </summary>
        private static Dictionary<string, EntityMetadata> TableMetadata(IOrganizationService service, string[] tables, string[] columns)
        {
            var query = new EntityQueryExpression
            {
                Criteria = new MetadataFilterExpression(LogicalOperator.And),
                Properties = new MetadataPropertiesExpression("LogicalName", "PrimaryIdAttribute", "PrimaryNameAttribute", "OwnershipType", "Privileges", "Attributes"),
                AttributeQuery = new AttributeQueryExpression
                {
                    Criteria = new MetadataFilterExpression(LogicalOperator.And),
                    Properties = new MetadataPropertiesExpression { AllProperties = true },
                },
            };
            query.Criteria.Conditions.Add(new MetadataConditionExpression("LogicalName", MetadataConditionOperator.In, tables));
            query.AttributeQuery.Criteria.Conditions.Add(new MetadataConditionExpression("LogicalName", MetadataConditionOperator.In, columns));
            var response = (RetrieveMetadataChangesResponse)service.Execute(new RetrieveMetadataChangesRequest { Query = query });
            return response.EntityMetadata.ToDictionary(metadata => metadata.LogicalName);
        }

        /// <summary>
        /// Writes the names linked to record `id` into its host columns: those whose text differs, and those whose
        /// text is cut even when it is the same (see below). `rename`, when given, is a linked record renamed in this
        /// transaction whose new name isn't saved yet (see ExecuteUpdate).
        /// </summary>
        private static void Rebuild(IOrganizationService service, ITracingService tracing, CopyPlan plan, Guid id, LinkedName rename = null)
        {
            var record = ReadRecord(service, plan, id);
            if (record == null)
            {
                tracing.Trace("{0} {1} no longer exists.", plan.Table, id);
                return;
            }
            var links = ReadLinks(service, plan, id, rename);
            // Written even when the text stays the same (a link to a record already linked, an unlink of one that
            // wasn't, a name after the cut of a cut text): the Update takes the record's lock, which the second read
            // below relies on.
            var update = Changes(plan, id, record, links, true);
            service.Update(update);
            tracing.Trace("{0} {1}: {2} updated ({3} links).", plan.Table, id, string.Join(", ", update.Attributes.Keys), links.Count);

            // Links to one record can be saved in parallel transactions (other users, flows and integrations link too,
            // and requests can run side by side). A transaction sees its own link but
            // not the links of the others until they commit, so the one that writes last could leave out a link saved
            // meanwhile. The Update above takes the record's row lock and holds it until this transaction commits; if
            // another transaction held it, this one waited until that one had committed. Reading the links and the
            // value again now therefore includes every link committed before this transaction got the lock, and a
            // second Update writes them. The next transaction to get the lock includes this one the same way.
            // The first Update is sent even when the text is the same, so this transaction always holds the lock:
            // whichever of two parallel transactions gets it second reads the other's change under it, and writes it.
            record = ReadRecord(service, plan, id);
            if (record == null) return;
            links = ReadLinks(service, plan, id, rename);
            update = Changes(plan, id, record, links, false);
            if (update == null) return;
            service.Update(update);
            tracing.Trace("{0} {1}: {2} updated again with links saved meanwhile ({3} links).",
                plan.Table, id, string.Join(", ", update.Attributes.Keys), links.Count);
        }

        /// <summary>
        /// The host columns of record `id`, or null when it no longer exists. A query rather than Retrieve, so that a
        /// record deleted meanwhile is skipped without a failed call, which would end the link's transaction.
        /// </summary>
        private static Entity ReadRecord(IOrganizationService service, CopyPlan plan, Guid id)
        {
            var query = new QueryExpression(plan.Table) { ColumnSet = new ColumnSet(plan.Columns.Select(c => c.Name).ToArray()) };
            query.Criteria.AddCondition(plan.TableId, ConditionOperator.Equal, id);
            return service.RetrieveMultiple(query).Entities.FirstOrDefault();
        }

        /// <summary>
        /// Every link of record `id`, with the linked record's name (all pages); `rename`, when given, in place of the
        /// saved name of its record.
        /// </summary>
        private static List<LinkedName> ReadLinks(IOrganizationService service, CopyPlan plan, Guid id, LinkedName rename = null)
        {
            var query = new QueryExpression(plan.Intersect)
            {
                ColumnSet = new ColumnSet(plan.OtherAttribute),
                PageInfo = new PagingInfo { Count = PageSize, PageNumber = 1 },
            };
            query.Criteria.AddCondition(plan.HostAttribute, ConditionOperator.Equal, id);
            var linked = query.AddLink(plan.OtherTable, plan.OtherAttribute, plan.OtherId, JoinOperator.Inner);
            linked.EntityAlias = "t";
            linked.Columns = new ColumnSet(plan.OtherName);
            var links = new List<LinkedName>();
            for (;;)
            {
                var page = service.RetrieveMultiple(query);
                foreach (var row in page.Entities)
                {
                    var other = row.GetAttributeValue<Guid>(plan.OtherAttribute).ToString();
                    var name = row.GetAttributeValue<AliasedValue>("t." + plan.OtherName)?.Value as string;
                    links.Add(rename != null && rename.Id == other ? rename : new LinkedName(other, name));
                }
                if (!page.MoreRecords) break;
                query.PageInfo.PageNumber++;
                query.PageInfo.PagingCookie = page.PagingCookie;
            }
            return links;
        }

        /// <summary>The columns to write: every copied column when `all`, otherwise those whose text differs (or null).</summary>
        private static Entity Changes(CopyPlan plan, Guid id, Entity record, List<LinkedName> links, bool all)
        {
            var update = new Entity(plan.Table, id);
            foreach (var column in plan.Columns)
            {
                var text = NamesCopyHelpers.NamesText(links, column.MaxLength);
                if (all || record.GetAttributeValue<string>(column.Name) != text) update[column.Name] = text;
            }
            return update.Attributes.Count == 0 ? null : update;
        }

        /// <summary>A cached value and when it expires. The value is never changed: a newer one replaces it whole.</summary>
        private sealed class Cached<T>
        {
            /// <summary>1 once a thread loads the value again (see FromCache), 0 before or after a failed load.</summary>
            private int reloading;

            public Cached(T value)
            {
                Value = value;
                Expires = Clock() + CacheTime;
            }

            public T Value { get; }
            public DateTime Expires { get; }

            /// <summary>True for one thread only, the first to ask: that one loads the value again.</summary>
            public bool StartReload()
            {
                return Interlocked.CompareExchange(ref reloading, 1, 0) == 0;
            }

            /// <summary>After a failed load: the next thread to ask loads the value again.</summary>
            public void ReloadFailed()
            {
                Interlocked.Exchange(ref reloading, 0);
            }
        }

        /// <summary>
        /// The value kept under `key`, loaded again once it is older than CacheTime. One thread loads it again, the
        /// first to find it expired; the others keep the old value meanwhile instead of all sending the same query at
        /// once (every link in the environment reads the forms). The new value replaces the old one in one step, so
        /// other threads read either. With no value at all, each thread loads its own. Failures are thrown, not kept:
        /// the next thread to ask loads again.
        /// </summary>
        private static T FromCache<TKey, T>(ConcurrentDictionary<TKey, Cached<T>> cache, TKey key, Func<T> load)
        {
            if (cache.TryGetValue(key, out var cached) && (cached.Expires > Clock() || !cached.StartReload())) return cached.Value;
            T value;
            try
            {
                value = load();
            }
            catch
            {
                cached?.ReloadFailed();
                throw;
            }
            cache[key] = new Cached<T>(value);
            return value;
        }

        /// <summary>Drops the plans of settings no longer used, so that the cache doesn't grow as forms change.</summary>
        private static void DropExpiredPlans()
        {
            var now = Clock();
            foreach (var plan in Plans)
            {
                // Removes the entry only if no other thread has replaced it meanwhile.
                if (plan.Value.Expires <= now) ((ICollection<KeyValuePair<string, Cached<CopyPlan>>>)Plans).Remove(plan);
            }
        }
    }
}
