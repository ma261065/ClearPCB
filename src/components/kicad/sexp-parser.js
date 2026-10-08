/**
 * KiCad S-expression parser owns tokenizing and parsing nested KiCad list
 * syntax shared by symbol and footprint conversion.
 */





    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Parse S-expression string into nested arrays
     * @param {string} str - S-expression string
     * @returns {Array<any>} Parsed structure
     */
export function _parseSExp(fetcher, str) {
    const tokens = fetcher._tokenize(str);
    let pos = 0;

    const parse = () => {
        if (pos >= tokens.length) return null;

        const token = tokens[pos++];

        if (token === '(') {
            const list = [];
            while (pos < tokens.length && tokens[pos] !== ')') {
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

    return parse();
}





    /**
 * @param {import('../KiCadFetcher.js').KiCadFetcher} fetcher
     * Tokenize S-expression string
     */
export function _tokenize(fetcher, str) {
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
