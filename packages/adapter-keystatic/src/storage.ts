/**
 * Where Keystatic's files live. Keystatic has the same two modes: a local folder,
 * and a GitHub repository. Each write to GitHub is a commit, so the real history
 * and undo are git's.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface KeystaticStorage {
    readonly name: string;
    /** The content, or null if it does not exist */
    read(path: string): Promise<string | null>;
    write(path: string, content: string, message: string): Promise<void>;
    remove(path: string, message: string): Promise<void>;
    /** Names inside a folder. Empty if it does not exist */
    list(directory: string): Promise<string[]>;
}

// ============================================
// Local
// ============================================

export function localStorage(config: { root?: string } = {}): KeystaticStorage {
    const root = resolve(config.root ?? '.');
    let tempCounter = 0;

    /** No path leaves the root, wherever it comes from */
    const inside = (path: string): string => {
        const target = resolve(root, path);
        if (target !== root && !target.startsWith(root + sep)) {
            throw new Error(`Path "${path}" is outside the content root`);
        }
        return target;
    };

    return {
        name: 'local',
        async read(path) {
            try {
                return await readFile(inside(path), 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        async write(path, content) {
            const target = inside(path);
            await mkdir(dirname(target), { recursive: true });
            // Temp file + rename: a failure halfway does not leave a truncated file
            const temp = join(dirname(target), `.inti-${process.pid}-${tempCounter++}.tmp`);
            await writeFile(temp, content, 'utf8');
            await rename(temp, target);
        },
        async remove(path) {
            await rm(inside(path), { force: true });
        },
        async list(directory) {
            try {
                return await readdir(inside(directory));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw error;
            }
        }
    };
}

// ============================================
// GitHub
// ============================================

export interface GitHubStorageConfig {
    /** `owner/repo` */
    repo: string;
    /** Token with write permission on the repo. Server only */
    token: string;
    /** Default: the repo's default branch */
    branch?: string;
    /** Content folder inside the repo, if it is not the root */
    pathPrefix?: string;
    /** Only for tests or GitHub Enterprise */
    apiUrl?: string;
}

export function githubStorage(config: GitHubStorageConfig): KeystaticStorage {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo ?? '')) {
        throw new Error('githubStorage: `repo` has to be "owner/repo".');
    }
    if (!config.token) {
        throw new Error('githubStorage: `token` is required, and only belongs on the server.');
    }

    const api = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    const prefix = config.pathPrefix ? `${config.pathPrefix.replace(/^\/|\/$/g, '')}/` : '';
    const encodedPath = (path: string) => `${prefix}${path}`.split('/').map(encodeURIComponent).join('/');
    const ref = config.branch ? `?ref=${encodeURIComponent(config.branch)}` : '';

    const request = (path: string, init: RequestInit = {}) =>
        fetch(`${api}/repos/${config.repo}/contents/${encodedPath(path)}${init.method ? '' : ref}`, {
            ...init,
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${config.token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                ...(init.body ? { 'Content-Type': 'application/json' } : {})
            }
        });

    /** Never includes the token: the error reaches the editor */
    const failure = async (action: string, path: string, response: Response) =>
        new Error(`GitHub rejected ${action} of "${path}": ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);

    /** The file and its sha, which GitHub requires so as not to overwrite someone else's change */
    async function fetchFile(path: string): Promise<{ sha: string; content: string } | null> {
        const response = await request(path);
        if (response.status === 404) return null;
        if (!response.ok) throw await failure('reading', path, response);

        const body = (await response.json()) as { sha: string; content?: string; encoding?: string };
        return { sha: body.sha, content: Buffer.from(body.content ?? '', 'base64').toString('utf8') };
    }

    return {
        name: 'github',
        async read(path) {
            return (await fetchFile(path))?.content ?? null;
        },
        async write(path, content, message) {
            const current = await fetchFile(path);
            const response = await request(path, {
                method: 'PUT',
                body: JSON.stringify({
                    message,
                    content: Buffer.from(content, 'utf8').toString('base64'),
                    ...(current ? { sha: current.sha } : {}),
                    ...(config.branch ? { branch: config.branch } : {})
                })
            });
            if (!response.ok) throw await failure('writing', path, response);
        },
        async remove(path, message) {
            const current = await fetchFile(path);
            if (!current) return;
            const response = await request(path, {
                method: 'DELETE',
                body: JSON.stringify({
                    message,
                    sha: current.sha,
                    ...(config.branch ? { branch: config.branch } : {})
                })
            });
            if (!response.ok) throw await failure('deleting', path, response);
        },
        async list(directory) {
            const response = await request(directory);
            if (response.status === 404) return [];
            if (!response.ok) throw await failure('listing', directory, response);

            const body = await response.json();
            return Array.isArray(body) ? body.map((entry: { name: string }) => entry.name) : [];
        }
    };
}
