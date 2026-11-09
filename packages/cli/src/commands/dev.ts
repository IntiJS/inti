export async function devCommand(args: string[] = []) {
    console.log('🚀 Starting Inti development server...\n');
    
    // TODO: Implement dev server with hot reload
    // For now, just pass through to astro dev
    
    const { spawn } = await import('child_process');
    const astro = spawn('astro', ['dev', ...args], {
        stdio: 'inherit',
        shell: true
    });

    astro.on('close', (code) => {
        process.exit(code || 0);
    });
}
