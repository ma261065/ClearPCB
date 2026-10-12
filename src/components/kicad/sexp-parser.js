/**
 * KiCad S-expression parser owns tokenizing and parsing nested KiCad list
 * syntax shared by symbol and footprint conversion.
 */

/** @typedef {string|number|boolean|SExprList} SExpr */
/** Heterogeneous parser output; consumers narrow by node tag before reading fields. */
/** @typedef {Array<*>} SExprList */





    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse S-expression string into nested arrays
     * @param {string} str - S-expression string
     * @returns {SExprList|null} Parsed structure
     */
export function _parseSExp(fetcher, str) {
    const tokens = fetcher._tokenize(str);
    let pos = 0;

    /** @returns {SExpr|null} */
    const parse = () => {
        if (pos >= tokens.length) return null;

        const token = tokens[pos++];

        if (token === '(') {
            /** @type {SExprList} */
            const list = [];
            while (pos < tokens.length && tokens[pos] !== ')') {
                /** @type {SExpr|null} */
                const item = parse();
                if (item !== null) list.push(item);
            }
            pos++; // Skip ')'
            return list;
        } else if (token === ')') {
            return null;
        } else {
            // Return as string or number
            const num = parseFloat(token);
            return isNaN(num) ? token.replace(/^"|"$/g, '') : num;
        }
    };

    return /** @type {SExprList|null} */ (parse());
}





    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Tokenize S-expression string
     * @param {string} str - S-expression string
     * @returns {string[]} Tokens
     */
export function _tokenize(fetcher, str) {
    /** @type {string[]} */
    const tokens = [];
    let i = 0;

    while (i < str.length) {
        const char = str[i];

        // Skip whitespace
        if (/\s/.test(char)) {
            i++;
            continue;
        }

        // Parentheses
        if (char === '(' || char === ')') {
            tokens.push(char);
            i++;
            continue;
        }

        // Quoted string
        if (char === '"') {
            let token = '"';
            i++;
            while (i < str.length && str[i] !== '"') {
                if (str[i] === '\\' && i + 1 < str.length) {
                    token += str[i] + str[i + 1];
                    i += 2;
                } else {
                    token += str[i];
                    i++;
                }
            }
            token += '"';
            i++; // Skip closing quote
            tokens.push(token);
            continue;
        }

        // Other token (symbol, number)
        let token = '';
        while (i < str.length && !/[\s()]/.test(str[i])) {
            token += str[i];
            i++;
        }
        if (token) tokens.push(token);
    }

    return tokens;
}
