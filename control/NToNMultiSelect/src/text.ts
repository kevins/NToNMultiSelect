/*
 * Text helpers: cutting text to a length without breaking a character, and text on one line (the names copy, and the line
 * under each option in the list, see relatedData.columnText).
 */

/**
 * `text` cut to at most `max` UTF-16 code units, never between the two halves of a character outside the BMP (an emoji):
 * such a character is left out whole.
 */
export function cutText(text: string, max: number): string {
    if (text.length <= max) return text;
    let cut = Math.max(0, max);
    if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
    return text.slice(0, cut);
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

/** `text` on one line: each run of white space becomes one space, without any at the ends, and at most `max` long. */
export function oneLine(text: string, max: number): string {
    return cutText(text.replace(/\s+/g, " ").trim(), max).trimEnd();
}
