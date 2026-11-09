/// <reference types="astro/client" />

declare module '*.astro' {
    const Component: any;
    export default Component;
}

/**
 * This file is NOT published (it is not in "files"): it only lets
 * `tsc` compile the package in isolation.
 */
