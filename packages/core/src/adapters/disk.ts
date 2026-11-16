/**
 * Writes to disk that cannot happen where the site runs.
 *
 * A serverless function (Vercel, Netlify, AWS Lambda) runs on a read-only disk, or one that
 * is gone after the call. The stores that keep JSON next to the app fail there with a bare
 * `EROFS`, which says nothing about what to change: this says it.
 */

const READ_ONLY = new Set(['EROFS', 'EACCES']);

/** Is this a platform where the app's disk is read-only or does not survive a request? */
export function onServerlessPlatform(env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}): boolean {
    return Boolean(env.VERCEL || env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT);
}

/** The error to throw when writing `file` failed; untouched unless the disk refused it */
export function explainDiskWrite(error: unknown, file: string, instead: string): unknown {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !READ_ONLY.has(code)) return error;
    return new Error(
        `Cannot write ${file}: the disk is read-only here (${code}). Serverless platforms such as Vercel, Netlify or AWS Lambda give a function no writable disk, and what is written in one call is gone in the next. ${instead}`
    );
}
