'use strict';

// This file runs once inside Electron so all files use the same V8 snapshot.
const fs = require('fs');
const Module = require('module');
const path = require('path');
const { app } = require('electron');
const bytenode = require('bytenode');

// Electron places its own switches before the application arguments. The
// manifest is intentionally the final argument to keep this stable across
// Electron versions.
const manifestFile = process.argv[process.argv.length - 1];

async function main() {
    if (!manifestFile) throw new Error('Missing bytecode file manifest.');
    const files = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8').replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
        const bytecode = bytenode.compileCode(Module.wrap(source));
        fs.writeFileSync(path.join(path.dirname(file), `${path.basename(file, '.js')}.jsc`), bytecode);
    }
}

app.whenReady().then(async () => {
    try {
        await main();
        app.quit();
    } catch (error) {
        console.error('[build-bytenode-worker] failed:', error);
        app.exit(1);
    }
});
