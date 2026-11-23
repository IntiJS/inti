#!/usr/bin/env node
/**
 * Starts one or more servers, waits for their ports, runs a command and stops the servers.
 *
 * Usage:
 *   node with-server.mjs --server "npm run dev" --port 4330 [--server "..." --port N]
 *                        [--timeout 120] -- node my-script.mjs
 *
 * The first port is exposed to the command as BASE_URL (http://localhost:<port>) unless
 * BASE_URL is already set. A port that already answers is reused and left running.
 */

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: node with-server.mjs --server "<cmd>" --port <n> [--server "<cmd>" --port <n>] [--timeout <s>] -- <command> [args]

  --server   command that starts a server (repeatable, pairs with --port in order)
  --port     port that server listens on
  --timeout  seconds to wait for each port (default 120)
  --         everything after it is the command to run once the ports answer`);
    process.exit(0);
}

const separator = argv.indexOf('--');
const options = separator === -1 ? argv : argv.slice(0, separator);
const command = separator === -1 ? [] : argv.slice(separator + 1);

const servers = [];
const ports = [];
let timeout = 120;

for (let i = 0; i < options.length; i++) {
    const value = options[i + 1];
    if (options[i] === '--server') servers.push(value), i++;
    else if (options[i] === '--port') ports.push(Number(value)), i++;
    else if (options[i] === '--timeout') timeout = Number(value), i++;
    else {
        console.error(`Unknown option: ${options[i]}`);
        process.exit(2);
    }
}

if (command.length === 0 || servers.length === 0 || servers.length !== ports.length || ports.some(Number.isNaN)) {
    console.error('Need a command after "--" and one --port for each --server. See --help.');
    process.exit(2);
}

/** True when something accepts connections on the port, on either IPv4 or IPv6 loopback. */
function isOpen(port) {
    const attempt = (host) =>
        new Promise((resolve) => {
            const socket = net.connect({ port, host });
            socket.setTimeout(500);
            socket.once('connect', () => (socket.destroy(), resolve(true)));
            socket.once('timeout', () => (socket.destroy(), resolve(false)));
            socket.once('error', () => resolve(false));
        });
    return Promise.all([attempt('127.0.0.1'), attempt('::1')]).then(([a, b]) => a || b);
}

const children = [];

/** Kills the server and what it started: `npm run dev` leaves grandchildren that hold the port. */
function stop(child) {
    if (child.exitCode !== null || !child.pid) return;
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(-child.pid, 'SIGTERM');
        }
    } catch {
        /* already gone */
    }
}

function stopAll() {
    children.forEach(stop);
}

process.on('SIGINT', () => (stopAll(), process.exit(130)));
process.on('SIGTERM', () => (stopAll(), process.exit(143)));

try {
    for (let i = 0; i < servers.length; i++) {
        if (await isOpen(ports[i])) {
            console.log(`Port ${ports[i]} already answers: reusing it.`);
            continue;
        }
        console.log(`Starting: ${servers[i]}`);
        const child = spawn(servers[i], {
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        });
        // Keep the output quiet but available if the server dies before it listens.
        let output = '';
        child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-4000)));
        child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-4000)));
        child.once('exit', (code) => {
            if (!child.ready) {
                console.error(`Server exited with code ${code} before port ${ports[i]} answered:\n${output}`);
                stopAll();
                process.exit(1);
            }
        });
        children.push(child);

        const deadline = Date.now() + timeout * 1000;
        while (!(await isOpen(ports[i]))) {
            if (Date.now() > deadline) {
                console.error(`Port ${ports[i]} did not answer within ${timeout}s:\n${output}`);
                stopAll();
                process.exit(1);
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        child.ready = true;
        console.log(`Port ${ports[i]} is up.`);
    }

    const env = { ...process.env, BASE_URL: process.env.BASE_URL ?? `http://localhost:${ports[0]}` };
    const runner = spawn(command[0], command.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
    const code = await new Promise((resolve) => runner.once('exit', (c) => resolve(c ?? 1)));
    stopAll();
    process.exit(code);
} catch (error) {
    console.error(error);
    stopAll();
    process.exit(1);
}
