/*
 * Visual spec measured from the platform's own multi-select choice control (MultiSelectPicklist) on the same form,
 * so both controls look identical side by side:
 *  - idle: bold, comma separated values (or "---"), no border
 *  - hover: 1px #666 border, values as #efefef chips with a remove (x) button
 *  - focused: chips + "Select or search options" box + chevron; the list opens from the chevron or the keyboard,
 *    below the field, or above it when there is no room
 *  - list: "Select all" + item count, 35px rows with CRM MDL2 checkbox glyphs, 4 visible rows
 *  - list rows: #f0f0f0 under the mouse; selected #bdbdbd, #c7c7c7 under the mouse and #e6e6e6 once the mouse has
 *    left the row, until the selection changes (see visitedRows in view.ts)
 *  - read-only: grey box, 44px high, like the native read-only field
 * The CSS is injected from code (once per page) rather than shipped as a PCF css resource, because some environments
 * send code components to the form without their resources and the bundle is then loaded by the form library.
 */
const CSS = `
.ntnms{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:100%;min-height:42px;padding:0 0 6px;border:1px solid transparent;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;line-height:19.6px;color:#333;text-align:start}
.ntnms *,.ntnms *::before,.ntnms *::after{box-sizing:content-box}
.ntnms button{margin:0;padding:0;border:0;background:transparent;color:inherit;font-family:inherit;font-size:1em;outline:none;cursor:pointer}
.ntnms button::-moz-focus-inner{padding:0;border:0}
.ntnms-glyph{display:flex;align-items:center;justify-content:center;width:16px;height:16px;font-family:"CRM MDL2","Segoe Fluent Icons","Segoe MDL2 Assets";font-size:16px;font-style:normal;line-height:1;speak:none}
.ntnms-a11y{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);border:0;white-space:nowrap}

.ntnms.is-active:not(.is-disabled),.ntnms.is-focused:not(.is-disabled){border-color:#666}

/* idle (view) mode */
.ntnms-view{position:absolute;top:0;left:0;display:flex;align-items:center;width:100%;height:100%;min-height:inherit;color:#242424;cursor:pointer}
.ntnms-view-text{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:SegoeUI,"Segoe UI",Helvetica,Arial,sans-serif;font-weight:600;line-height:28px}
.ntnms.is-active:not(.is-disabled) .ntnms-view,.ntnms.is-focused:not(.is-disabled) .ntnms-view{display:none}

/* selected values as chips */
.ntnms-chips-row{display:none;justify-content:space-between}
.ntnms.is-active:not(.is-empty) .ntnms-chips-row,.ntnms.is-focused:not(.is-empty) .ntnms-chips-row{display:flex}
.ntnms-chips{display:flex;flex-wrap:wrap;flex:1 1 auto;min-width:0;max-height:34px;margin:0;padding:0;padding-inline-start:13px;overflow:hidden;list-style:none;outline:none}
.ntnms.is-expanded .ntnms-chips{max-height:136px;overflow-y:auto}
.ntnms-chip{position:relative;display:flex;max-width:100%;height:28px;margin:6px 0 0;margin-inline-end:7px;border:0;background:#efefef;color:#333;line-height:28px;cursor:default;outline:none}
.ntnms-chip.is-saving{opacity:.6}
.ntnms-chip.is-current::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border:1px solid #000;pointer-events:none}
.ntnms-chip-text{overflow:hidden;padding:0;padding-inline:7px 3.5px;white-space:nowrap;text-overflow:ellipsis;pointer-events:none}
.ntnms-chip-text:last-child{padding-inline-end:7px}
/* "Open selected records": the name is a link to the record (the rest of the chip still only focuses the box) */
.ntnms .ntnms-chip-link{color:inherit;text-decoration:none;cursor:pointer;pointer-events:auto}
.ntnms .ntnms-chip-link:hover,.ntnms .ntnms-chip.is-current .ntnms-chip-link{text-decoration:underline}
.ntnms .ntnms-chip-link:focus-visible{outline:1px solid #000;outline-offset:-1px}
.ntnms .ntnms-chip-remove{position:relative;display:flex;align-items:center;height:28px;padding:0;padding-inline:3.5px 7px;color:#333}
.ntnms .ntnms-chip-remove:hover{background:#b3b3b3;color:#000}
.ntnms .ntnms-chip-remove:focus-visible::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border:1px solid #000}
.ntnms-more{display:flex;width:min-content;padding:6px 0 0}
.ntnms.is-expanded .ntnms-more{margin-top:auto}
.ntnms .ntnms-more-button{height:28px;padding:0 7px;line-height:28px;white-space:nowrap;color:#2975b2}
.ntnms .ntnms-more-button:hover{color:#6199d1}
.ntnms .ntnms-more-button:focus-visible{outline:1px solid #000;outline-offset:-2px}
.ntnms-more.is-hidden{visibility:hidden}

/* search box + chevron */
.ntnms-inner{display:flex;position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;align-items:center;background:#fff}
.ntnms.is-focused .ntnms-inner,.ntnms.is-active.is-empty .ntnms-inner{position:relative;width:auto;height:auto;margin:0;padding:6px 0 0;overflow:visible;clip:auto;white-space:normal}
/* An empty box uses 4px instead of 6px, whether it is hovered, focused or both, so the field never changes height
   when the mouse moves between the box and the open list. The doubled class makes this rule win over both rules
   above, and over the same rules from an older copy of this control loaded on the same page. */
.ntnms.ntnms.is-empty.is-focused .ntnms-inner,.ntnms.ntnms.is-empty.is-active .ntnms-inner{padding-top:4px}
.ntnms-input-wrap{display:flex;flex:1 1 auto;align-items:center;min-width:0;min-height:28px;height:30px;padding:0;padding-inline-start:13px}
.ntnms .ntnms-input{flex:1 1 auto;min-width:0;width:100%;height:30px;margin:0;padding:0;border:0!important;outline:none;box-shadow:none;background:transparent;color:#242424;font-family:SegoeUI,"Segoe UI";font-size:14px}
.ntnms .ntnms-input::placeholder{color:#757575;opacity:1}
.ntnms .ntnms-input::-ms-clear{display:none}
.ntnms-caret{display:flex;align-items:center;min-height:28px;height:30px}
.ntnms .ntnms-caret-button{display:flex;align-items:center;height:30px;padding:7px 0;padding-inline:7px 6px;box-sizing:border-box;color:#242424}
.ntnms .ntnms-caret-button:focus-visible{outline:1px solid #000;outline-offset:-2px}

/* drop-down list: rendered in a layer on <body> (position: fixed) so form sections that clip overflow cannot cut it off */
.ntnms-menu{display:none;position:fixed;z-index:1000000;box-sizing:border-box;flex-direction:column;margin:0;padding-top:13px;border:1px solid #5d5a58;background:#fff;color:#242424;background-clip:padding-box;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;font-weight:400;line-height:19.6px;text-align:start}
.ntnms-menu *,.ntnms-menu *::before,.ntnms-menu *::after{box-sizing:content-box}
.ntnms-menu.is-open{display:flex}
.ntnms-option{position:relative;display:flex;align-items:center;min-height:35px;cursor:pointer;outline:none}
.ntnms-option:hover{background:#f0f0f0;color:#000}
.ntnms-option.is-selected{background:#bdbdbd}
/* the hover rule comes after this one, with the same specificity, so a row the mouse comes back to is #c7c7c7 again */
.ntnms-option.is-selected.is-visited{background:#e6e6e6}
.ntnms-option.is-selected:hover{background:#c7c7c7}
.ntnms-option.is-current::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border:1px solid #000;pointer-events:none}
.ntnms-option.is-saving{opacity:.6}
.ntnms-option.is-disabled{color:#a19f9d;cursor:default}
.ntnms-option.is-disabled:hover{background:transparent;color:#a19f9d}
.ntnms-note{padding:0 13px 6px;color:#616161;font-size:12px;line-height:16px;cursor:default}
.ntnms-check{position:absolute;inset-inline-start:14px;top:50%;margin-top:-6px;width:12px;height:12px;font-family:"CRM MDL2","Segoe Fluent Icons","Segoe MDL2 Assets";font-size:12px;line-height:12px;speak:none}
.ntnms-option-text{flex:1 1 auto;min-width:0;padding:8px 0 7px;padding-inline-start:35px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ntnms-count{flex:0 0 auto;padding:0 14px;color:#242424;white-space:nowrap}
.ntnms-list{position:relative;margin:0;padding:0;list-style:none;max-height:140px;overflow-x:hidden;overflow-y:auto;outline:none}
.ntnms-menu .ntnms-create{position:relative;display:block;box-sizing:border-box;width:100%;height:35px;margin:0;padding:0 13px;border:0;border-top:1px solid #e1dfdd;background:transparent;color:#2975b2;font:inherit;text-align:start;cursor:pointer;outline:none}
.ntnms-menu .ntnms-create.is-current::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border:1px solid #000;pointer-events:none}
.ntnms-menu .ntnms-create:hover{background:#efefef;color:#6199d1}
.ntnms-status{height:35px;padding-inline-start:13px;line-height:35px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#242424;cursor:default}

/* Windows high contrast: the grey backgrounds disappear, so mark selected rows with the system highlight colours,
   also under the mouse and once the mouse has left them (the rules above would otherwise win). forced-color-adjust is
   inherited, so the keyboard outline of a selected row keeps its literal black unless it gets the matching colour.
   Rows blocked by Maximum selections would lose their grey text as well: they get the system colour for disabled text. */
@media (forced-colors:active){.ntnms-option.is-selected,.ntnms-option.is-selected.is-visited,.ntnms-option.is-selected:hover{forced-color-adjust:none;background:Highlight;color:HighlightText}.ntnms-option.is-selected.is-current::after{border-color:HighlightText}.ntnms-option.is-disabled,.ntnms-option.is-disabled:hover{color:GrayText}}

/* read-only */
.ntnms.is-disabled{padding:0;padding-inline-start:13px;border:1px solid #efefef;background-color:#efefef;color:#333}
.ntnms.is-disabled .ntnms-view{position:relative;cursor:default}
.ntnms.is-disabled .ntnms-chips-row,.ntnms.is-disabled .ntnms-inner{display:none!important}
/* "Open selected records" on a read-only field: the names are links */
.ntnms .ntnms-view-link{color:inherit;text-decoration:none;cursor:pointer}
.ntnms .ntnms-view-link:hover,.ntnms .ntnms-view-link:focus-visible{text-decoration:underline}

/* inline error, styled like a model-driven field notification */
.ntnms-error{display:flex;align-items:flex-start;gap:6px;margin-top:4px;color:#a4262c;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;line-height:16px}
.ntnms-error[hidden]{display:none}
.ntnms-hint{margin-top:4px;color:#616161;font-family:"Segoe UI",Helvetica,Arial,sans-serif;font-size:12px;line-height:16px}
.ntnms-hint[hidden]{display:none}
.ntnms-error-icon{flex:0 0 auto;width:14px;height:14px;margin-top:1px}
.ntnms-error-dismiss{margin-inline-start:auto;padding:0 2px;border:0;background:transparent;color:#a4262c;font-size:12px;cursor:pointer;text-decoration:underline}
`;

const STYLE_ID = "ntnms-styles-v8";

export function ensureStyles(doc: Document = document): void {
    if (doc.getElementById(STYLE_ID)) {
        return;
    }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
}

/** CRM MDL2 glyph code points used by the native control. */
export const GLYPH = {
    remove: "",
    chevronDown: "",
    chevronUp: "",
    unchecked: "",
    checked: "",
};
