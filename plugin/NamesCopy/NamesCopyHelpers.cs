using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace NToNMultiSelect.NamesCopy
{
    /// <summary>A control on a form that asks for the names copy: its relationship and its host (bound) column.</summary>
    public sealed class CopySetting
    {
        public CopySetting(string relationshipName, string hostColumn)
        {
            RelationshipName = relationshipName;
            HostColumn = hostColumn;
        }

        /// <summary>Schema name of the N:N relationship, as typed in the control's settings.</summary>
        public string RelationshipName { get; }

        /// <summary>Logical name of the host column.</summary>
        public string HostColumn { get; }
    }

    /// <summary>A linked record: its id and its primary name, or "(No name)" when that is blank.</summary>
    public sealed class LinkedName
    {
        public LinkedName(string id, string name)
        {
            Id = id.ToLowerInvariant();
            Name = string.IsNullOrWhiteSpace(name) ? NamesCopyHelpers.NoName : name;
            SortKey = NamesCopyHelpers.SortKey(Name);
        }

        public string Id { get; }

        public string Name { get; }

        /// <summary>The key the name sorts by (NamesCopyHelpers.SortKey), computed once.</summary>
        public string SortKey { get; }
    }

    /// <summary>
    /// The rules of the names copy that don't need Dataverse: which form controls ask for it, and the text it writes.
    /// The text is the one the control writes: the names sorted by name, joined with "; ", cut to the column's maximum
    /// length with "…", and null when nothing is linked.
    /// </summary>
    public static class NamesCopyHelpers
    {
        /// <summary>The end of the control's name, after its publisher prefix and namespace (for example kv_KV.).</summary>
        public const string ControlName = ".NToNMultiSelect";

        public const string Separator = "; ";

        /// <summary>The name of a linked record without one, as the control shows it in English.</summary>
        public const string NoName = "(No name)";

        // Ignores case, accents and width, like the control's Intl.Collator with sensitivity "base". StringSort makes
        // the apostrophe of the sort key an ordinary symbol, which sorts before digits and letters, instead of nearly
        // ignoring it.
        private const CompareOptions NameOptions = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace |
            CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth | CompareOptions.StringSort;

        private static readonly CompareInfo Invariant = CultureInfo.InvariantCulture.CompareInfo;

        /// <summary>
        /// The ASCII space and punctuation characters in the browser's order (Intl.Collator, ICU's root order, the same
        /// in English): space first, $ last. Windows sorts them in another order.
        /// </summary>
        private const string Separators = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

        /// <summary>
        /// The controls of a published form (its formxml) that ask the plug-in for the names copy: N:N Multi-Select of
        /// any publisher, with a static relationship name and "Copy names into the host column" set to Yes. Each form
        /// factor has its own copy of the settings; any of them counts. Malformed XML gives nothing. Other parameters
        /// are ignored.
        /// </summary>
        public static IList<CopySetting> ParseFormXml(string formXml)
        {
            var settings = new List<CopySetting>();
            if (string.IsNullOrEmpty(formXml)) return settings;
            XDocument form;
            try
            {
                // No DTD and no external resources: form XML never has them.
                var options = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using (var reader = XmlReader.Create(new StringReader(formXml), options))
                {
                    form = XDocument.Load(reader);
                }
            }
            catch (XmlException)
            {
                return settings;
            }

            foreach (var control in form.Descendants().Where(e => e.Name.LocalName == "customControl"))
            {
                var name = (string)control.Attribute("name");
                var parameters = Child(control, "parameters");
                // Other controls end with the same name (ITAintBoring's N:N control): they have no copy settings.
                if (name == null || !name.EndsWith(ControlName, StringComparison.OrdinalIgnoreCase) || parameters == null) continue;
                var relationship = StaticValue(parameters, "relationshipName");
                var column = Child(parameters, "value")?.Value.Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(relationship) || string.IsNullOrEmpty(column) ||
                    StaticValue(parameters, "writeSummary") != "1")
                {
                    continue;
                }
                if (!settings.Any(s => string.Equals(s.RelationshipName, relationship, StringComparison.OrdinalIgnoreCase) && s.HostColumn == column))
                {
                    settings.Add(new CopySetting(relationship, column));
                }
            }
            return settings;
        }

        private static XElement Child(XElement parent, string localName)
        {
            return parent.Elements().FirstOrDefault(e => e.Name.LocalName == localName);
        }

        /// <summary>A parameter typed in the form designer (static="true"), or null. A bound parameter doesn't count.</summary>
        private static string StaticValue(XElement parameters, string localName)
        {
            var parameter = Child(parameters, localName);
            return parameter != null && string.Equals((string)parameter.Attribute("static"), "true", StringComparison.OrdinalIgnoreCase)
                ? parameter.Value.Trim()
                : null;
        }

        /// <summary>
        /// The key a name sorts by, so that the invariant culture compares names as the control's Intl.Collator does
        /// (case and accents ignored, numeric ordering). The whole key is compared in one go, so a digit of one name
        /// still meets the space or hyphen of the other ("Team 2" before "Team1", as in the browser).
        /// - Each run of digits becomes its length (4 digits) and its digits, without leading zeros but with at least
        ///   one digit: "Skill 2" comes before "Skill 10", and "007" equals "7".
        /// - Each ASCII space or punctuation character (or its full-width form) becomes an apostrophe and its 2-digit
        ///   rank in Separators: the apostrophe sorts before digits and letters, as punctuation does in the browser,
        ///   and the ranks keep the browser's order among them.
        /// - Every other space (Unicode's space separators: no-break, figure, narrow no-break, ideographic...) ranks as
        ///   the ASCII space, as in the browser: "Team 2" (a no-break space) comes before "Team 10".
        /// What can still differ: letters a language sorts its own way (å in Swedish, the browser uses its language),
        /// and symbols outside ASCII.
        /// </summary>
        public static string SortKey(string name)
        {
            var key = new StringBuilder(name.Length + 8);
            for (var i = 0; i < name.Length;)
            {
                var c = name[i];
                var rank = Separators.IndexOf(char.GetUnicodeCategory(c) == UnicodeCategory.SpaceSeparator ? ' '
                    : c >= '！' && c <= '～' ? (char)(c - 0xFEE0) : c);
                if (rank >= 0)
                {
                    key.Append('\'').Append(rank.ToString("D2", CultureInfo.InvariantCulture));
                    i++;
                }
                else if (char.IsDigit(c))
                {
                    var end = i + 1;
                    while (end < name.Length && char.IsDigit(name[end])) end++;
                    while (i < end - 1 && char.GetNumericValue(name[i]) == 0) i++;
                    key.Append((end - i).ToString("D4", CultureInfo.InvariantCulture));
                    for (; i < end; i++) key.Append((char)('0' + (int)char.GetNumericValue(name[i])));
                }
                else
                {
                    key.Append(c);
                    i++;
                }
            }
            return key.ToString();
        }

        /// <summary>Two sort keys (SortKey), in the invariant culture without case, accents or width.</summary>
        public static int CompareKeys(string a, string b)
        {
            return Invariant.Compare(a, b, NameOptions);
        }

        /// <summary>
        /// Natural order of names, the control's: case and accents are ignored, and numbers compare by value, so
        /// "Skill 2" comes before "Skill 10". To sort many names, compute each SortKey once and use CompareKeys.
        /// </summary>
        public static int CompareNames(string a, string b)
        {
            return CompareKeys(SortKey(a), SortKey(b));
        }

        /// <summary>The order of the names in the copy: by name, then by id so that equal names keep one order.</summary>
        public static int CompareLinks(LinkedName a, LinkedName b)
        {
            var byName = CompareKeys(a.SortKey, b.SortKey);
            return byName != 0 ? byName : string.CompareOrdinal(a.Id, b.Id);
        }

        /// <summary>
        /// The text of the copy: the names in order, joined with "; ", cut to `maxLength` with "…" when longer, or null
        /// when nothing is linked.
        /// </summary>
        public static string NamesText(IEnumerable<LinkedName> links, int? maxLength)
        {
            return NamesText(links, maxLength, out _);
        }

        /// <summary>
        /// NamesText, and whether the text was cut: then the names after the cut don't show, and other links can give
        /// the same text.
        /// </summary>
        public static string NamesText(IEnumerable<LinkedName> links, int? maxLength, out bool wasCut)
        {
            var sorted = links.ToList();
            sorted.Sort(CompareLinks);
            var value = string.Join(Separator, sorted.Select(link => link.Name));
            wasCut = maxLength > 0 && value.Length > maxLength;
            if (wasCut)
            {
                // The length counts UTF-16 code units: never keep the first half of a character outside the BMP (an emoji).
                var cut = maxLength.Value - 1;
                if (cut > 0 && char.IsHighSurrogate(value[cut - 1])) cut--;
                return value.Substring(0, cut) + "…";
            }
            return value.Length == 0 ? null : value;
        }
    }
}
