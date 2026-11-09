/**
 * Pulls complete blocks out of the `{"blocks":[...]}` JSON as it arrives.
 *
 * Showing a block as soon as it is finished is what makes streaming useful, and
 * only a whole object can be validated. It does not try to guess half-written JSON:
 * a block comes out when its brace closes, or not at all.
 */

export class BlockStreamParser {
    private buffer = '';
    private position = 0;
    private inArray = false;
    private depth = 0;
    private start = -1;
    private inString = false;
    private escaped = false;
    private finished = false;

    /** Appends text and returns the blocks it has completed */
    push(chunk: string): unknown[] {
        this.buffer += chunk;
        if (this.finished) return [];

        if (!this.inArray) {
            const key = /"blocks"\s*:\s*\[/.exec(this.buffer.slice(this.position));
            if (!key) return [];
            this.position += key.index + key[0].length;
            this.inArray = true;
        }

        const found: unknown[] = [];

        for (; this.position < this.buffer.length; this.position++) {
            const char = this.buffer[this.position];

            if (this.inString) {
                if (this.escaped) this.escaped = false;
                else if (char === '\\') this.escaped = true;
                else if (char === '"') this.inString = false;
                continue;
            }

            if (char === '"') {
                this.inString = true;
            } else if (char === '{' || char === '[') {
                if (this.depth === 0) this.start = this.position;
                this.depth++;
            } else if (char === '}' || char === ']') {
                if (this.depth === 0) {
                    // Closing of the blocks array itself
                    this.finished = true;
                    break;
                }
                this.depth--;
                if (this.depth === 0) {
                    try {
                        found.push(JSON.parse(this.buffer.slice(this.start, this.position + 1)));
                    } catch {
                        // Malformed: validation drops it because it never arrives
                    }
                    this.start = -1;
                }
            }
        }

        return found;
    }
}
