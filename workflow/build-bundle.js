'use strict';

/**
 * Bundle the TypeScript output into a small set of CommonJS runtime files.
 *
 * The Host API is intentionally one bundle: its modules share stateful
 * singletons, so separate API bundles would evaluate the same source more
 * than once in a single PinK utility process. Worker entry points stay split
 * because each runs in its own child process.
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const bundleDir = path.join(distRoot, 'bundle');

const entries = {
    // Main entry points.
    cli: path.join(distRoot, 'cli.js'),
    index: path.join(distRoot, 'index.js'),

    // PinK loads this once and selects the exported API namespace.
    'host-api': path.join(distRoot, 'lib', 'host-api.js'),

    // Child-process entry points.
    'scene-process-main': path.join(distRoot, 'core', 'scene', 'scene-process', 'main.js'),
    'engine-compile-worker': path.join(distRoot, 'core', 'engine', 'compile-worker.js'),
    'scripting-compile-worker': path.join(distRoot, 'core', 'scripting', 'compile-worker.js'),
    'effect-compile-process': path.join(distRoot, 'core', 'assets', 'asset-handler', 'assets', 'effect-compile-process.js'),
    'builder-sub-process': path.join(distRoot, 'core', 'builder', 'worker', 'worker-pools', 'sub-process.js'),
    'builder-script-task': path.join(distRoot, 'core', 'builder', 'worker', 'builder', 'asset-handler', 'script', 'build-script.js'),
    'builder-engine-task': path.join(distRoot, 'core', 'builder', 'worker', 'builder', 'asset-handler', 'script', 'build-engine.js'),
};

async function main() {
    const watch = process.argv.includes('--watch');

    // Remove stale entries and bytecode siblings before rebuilding. Without
    // this, an entry removed from the split map remains loadable from dist.
    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.mkdirSync(bundleDir, { recursive: true });

    const context = await esbuild.context({
        entryPoints: entries,
        outdir: bundleDir,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        sourcemap: false,
        // Keep node_modules external; runtime dependencies remain require-able.
        packages: 'external',
        // Dynamic requires with computed paths must remain runtime requires.
        logLevel: 'info',
        logLimit: 20,
        banner: {
            js: '/* Bundled by workflow/build-bundle.js */',
        },
    });

    if (watch) {
        await context.watch();
        console.log(`[build-bundle] watching... outputs to ${bundleDir}`);
        return;
    }

    await context.rebuild();
    await context.dispose();
    console.log('[build-bundle] done');
}

main().catch((error) => {
    console.error('[build-bundle] failed:', error);
    process.exit(1);
});
