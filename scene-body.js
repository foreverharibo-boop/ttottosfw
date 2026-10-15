// Kept only to validate and migrate a pre-0.2.15 snapshot against its own body.
export function stripLegacyAuxiliarySceneReports(text) {
    return String(text ?? '').replace(
        /\s*<\s*charm[-_]?now\s*>(?:(?!<\s*charm[-_]?now\s*>)[\s\S])*?<\s*\/\s*charm[-_]?now\s*>\s*/gi,
        '\n',
    ).trimEnd();
}

const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

// Comparison only. Never write this result into a message or an analysis prompt.
// All tag names are eligible, including unknown extension protocols and HTML.
export function stripAuxiliarySceneReports(text) {
    const source = String(text ?? '');
    const tokens = /<!--[\s\S]*?(?:-->|$)|<\s*(\/?)\s*([\p{L}_][\p{L}\p{N}_.:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*?>/gu;
    const stack = [], outside = [];
    let cursor = 0;
    for (const token of source.matchAll(tokens)) {
        if (!stack.length) outside.push(source.slice(cursor, token.index));
        cursor = token.index + token[0].length;
        if (!token[2]) continue; // Comments carry no narrative for comparison.
        const name = token[2].toLowerCase();
        if (token[1]) {
            const open = stack.lastIndexOf(name);
            if (open >= 0) stack.length = open;
        } else if (!/\/\s*>$/.test(token[0]) && !VOID_TAGS.has(name)) {
            stack.push(name);
        }
    }
    // An unclosed opening tag owns the remainder, just like our report tags.
    if (!stack.length) outside.push(source.slice(cursor));
    // Tag cleanup often also removes its surrounding empty lines/indentation.
    return outside.join('').replace(/\s+/g, ' ').trim();
}
