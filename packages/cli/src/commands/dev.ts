export async function devCommand(args: string[] = []) {
    // Runs `astro dev` with the given arguments. It adds nothing of its own.
    console.log('Running astro dev…\n');

    const { spawn } = await import('child_process');
    const astro = spawn('astro', ['dev', ...args], {
        stdio: 'inherit',
        shell: true
    });

    astro.on('close', (code) => {
        process.exit(code || 0);
    });
}
