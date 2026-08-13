'use strict';

import { accessSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { promises as fsPromises } from 'fs';
import { dirname, normalize, resolve } from 'path';
import { LocalAssetFileSystemProvider } from './local-provider';
import {
    IAssetDeleteOptions,
    IAssetFileStat,
    IAssetFileSystemProvider,
    IAssetOperationContext,
    IAssetOperationKind,
    IAssetOperationOrigin,
    IAssetRenameOptions,
    IAssetWriteFileOptions,
} from './provider';

/** 仅缓存不超过 2 KB 的 UTF-8 文本，避免大文件长期占用内存。 */
const MAX_FILE_UTF8_CACHE_BYTES = 2 * 1024;

const { access, mkdir, readFile, writeFile } = fsPromises;

interface FileUtf8CacheState {
    /** 同步和异步读取共享的文本缓存。 */
    files: Map<string, string>;
    /** 进行中的异步读取，用于合并同一文件的并发 I/O。 */
    pendingReads: Map<string, Promise<string>>;
    /** 写入或清理缓存时递增，避免旧异步读取覆盖最新缓存。 */
    generation: number;
}

type FileSystemGlobal = typeof globalThis & {
    __filesystem_cache_utf8__?: FileUtf8CacheState;
};

/**
 * 缓存必须存放在 globalThis 上。@cocos/asset-db 与 cocos-cli 会被编译为不同模块，
 * 使用模块局部变量会各自创建缓存，无法在同一个 JavaScript 全局环境中共享结果。
 */
const fileUtf8CacheState = (globalThis as FileSystemGlobal).__filesystem_cache_utf8__ ??= {
    files: new Map<string, string>(),
    pendingReads: new Map<string, Promise<string>>(),
    generation: 0,
};

/**
 * 将相对路径转换为绝对路径，确保同一文件只对应一个缓存键。
 *
 * 注意：相对路径会基于调用时的 process.cwd() 解析。如果进程运行期间修改了工作目录，
 * 同一个相对路径字符串可能指向不同文件并产生不同缓存键，因此调用方应优先传入绝对路径。
 */
function getCacheKey(path: string): string {
    return resolve(path);
}

/** 根据 UTF-8 实际字节数更新缓存；超过限制时删除已有缓存。 */
function updateFileUtf8Cache(cacheKey: string, content: string): void {
    if (Buffer.byteLength(content, 'utf8') <= MAX_FILE_UTF8_CACHE_BYTES) {
        fileUtf8CacheState.files.set(cacheKey, content);
    } else {
        fileUtf8CacheState.files.delete(cacheKey);
    }
}

/**
 * 以 UTF-8 文本同步读取文件，并缓存读取结果。
 * 仅不超过 2 KB 的文件会进入缓存。
 * 外部程序修改文件后，需要先调用 clearFileUtf8Cache 使缓存失效。
 */
export function readFileUtf8Sync(path: string): string {
    const cacheKey = getCacheKey(path);
    const cachedContent = fileUtf8CacheState.files.get(cacheKey);
    if (cachedContent !== undefined) {
        return cachedContent;
    }

    const content = readFileSync(path, 'utf8');
    updateFileUtf8Cache(cacheKey, content);
    return content;
}

/** 同步读取并解析 JSON 文件，复用 UTF-8 文本缓存。 */
export function readJSONSync<T = any>(path: string): T {
    return JSON.parse(readFileUtf8Sync(path)) as T;
}

export interface OutputJSONOptions {
    spaces?: string | number;
    replacer?: (this: unknown, key: string, value: unknown) => unknown;
    EOL?: string;
}

/** 同步序列化 JSON，自动创建父目录并更新 UTF-8 文本缓存。 */
export function outputJSONSync(path: string, data: unknown, options: OutputJSONOptions = {}): void {
    const content = JSON.stringify(data, options.replacer, options.spaces) + (options.EOL ?? '\n');
    mkdirSync(dirname(path), { recursive: true });
    writeFileUtf8Sync(path, content);
}

/** 使用异步 access 判断路径是否存在。 */
export async function pathExistsAsync(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** 使用同步 access 判断路径是否存在。 */
export function pathExistsSync(path: string): boolean {
    try {
        accessSync(path);
        return true;
    } catch {
        return false;
    }
}

/** 异步读取并解析 JSON 文件，复用 UTF-8 文本缓存。 */
export async function readJSONAsync<T = any>(path: string): Promise<T> {
    return JSON.parse(await readFileUtf8Async(path)) as T;
}

/** 异步序列化 JSON，自动创建父目录并更新 UTF-8 文本缓存。 */
export async function outputJSONAsync(path: string, data: unknown, options: OutputJSONOptions = {}): Promise<void> {
    const content = JSON.stringify(data, options.replacer, options.spaces) + (options.EOL ?? '\n');
    await mkdir(dirname(path), { recursive: true });
    await writeFileUtf8Async(path, content);
}

/** 以 UTF-8 文本同步写入文件，并在写入成功后更新缓存。 */
export function writeFileUtf8Sync(path: string, content: string): void {
    writeFileSync(path, content, 'utf8');
    fileUtf8CacheState.generation++;
    updateFileUtf8Cache(getCacheKey(path), content);
}

/**
 * 以 UTF-8 文本异步读取文件，并缓存读取结果。
 * 仅不超过 2 KB 的文件会进入缓存。
 * 同一路径的并发读取会共享同一个 Promise。
 */
export async function readFileUtf8Async(path: string): Promise<string> {
    const cacheKey = getCacheKey(path);
    const cachedContent = fileUtf8CacheState.files.get(cacheKey);
    if (cachedContent !== undefined) {
        return cachedContent;
    }

    const pendingRead = fileUtf8CacheState.pendingReads.get(cacheKey);
    if (pendingRead) {
        return pendingRead;
    }

    const readGeneration = fileUtf8CacheState.generation;
    const read = readFile(path, 'utf8').then(content => {
        if (readGeneration === fileUtf8CacheState.generation) {
            updateFileUtf8Cache(cacheKey, content);
        }
        return content;
    }).finally(() => {
        if (fileUtf8CacheState.pendingReads.get(cacheKey) === read) {
            fileUtf8CacheState.pendingReads.delete(cacheKey);
        }
    });
    fileUtf8CacheState.pendingReads.set(cacheKey, read);
    return read;
}

/** 以 UTF-8 文本异步写入文件，并在写入成功后更新缓存。 */
export async function writeFileUtf8Async(path: string, content: string): Promise<void> {
    await writeFile(path, content, 'utf8');
    fileUtf8CacheState.generation++;
    updateFileUtf8Cache(getCacheKey(path), content);
}

/**
 * 清理 UTF-8 文件缓存。
 * 传入路径时只清理对应文件；省略路径时清理全部缓存。
 */
export function clearFileUtf8Cache(path?: string): void {
    fileUtf8CacheState.generation++;
    if (path === undefined) {
        fileUtf8CacheState.files.clear();
        fileUtf8CacheState.pendingReads.clear();
        return;
    }

    const cacheKey = getCacheKey(path);
    fileUtf8CacheState.files.delete(cacheKey);
    fileUtf8CacheState.pendingReads.delete(cacheKey);
}

const localProvider = new LocalAssetFileSystemProvider();
let provider: IAssetFileSystemProvider = localProvider;
const operationContexts = new Map<string, IAssetOperationContext>();
const OPERATION_CONTEXT_TTL = 30 * 1000;

function normalizeOperationPath(path: string) {
    return normalize(path);
}

function pruneOperationContexts(now = Date.now()) {
    for (const [path, context] of operationContexts) {
        if (now - context.timestamp > OPERATION_CONTEXT_TTL) {
            operationContexts.delete(path);
        }
    }
}

function rememberOperationContext(context?: IAssetOperationContext) {
    if (!context) {
        return;
    }
    pruneOperationContexts(context.timestamp);
    for (const path of context.paths) {
        operationContexts.set(normalizeOperationPath(path), context);
    }
}

function createWatcherOperationContext(path: string, kind: IAssetOperationKind, source = path): IAssetOperationContext {
    const timestamp = Date.now();
    return {
        opId: `asset-watcher-${timestamp}-${Math.random().toString(16).slice(2)}`,
        kind,
        origin: 'watcher',
        source,
        paths: [path],
        timestamp,
    };
}

export function getFileSystemProvider() {
    return provider;
}

export function setFileSystemProvider(nextProvider: IAssetFileSystemProvider) {
    provider = nextProvider;
}

export function resetFileSystemProvider() {
    provider = localProvider;
}

export function resetOperationContexts() {
    operationContexts.clear();
}

export function peekOperationContext(path: string) {
    pruneOperationContexts();
    return operationContexts.get(normalizeOperationPath(path));
}

export function takeOperationContext(path: string) {
    pruneOperationContexts();
    const key = normalizeOperationPath(path);
    const context = operationContexts.get(key);
    operationContexts.delete(key);
    return context;
}

export function resolveOperationContext(path: string, kind: IAssetOperationKind, source = path) {
    return takeOperationContext(path) || createWatcherOperationContext(path, kind, source);
}

function resolveProviderMethod<K extends keyof IAssetFileSystemProvider>(name: K): NonNullable<IAssetFileSystemProvider[K]> {
    const method = provider[name] || localProvider[name];
    if (!method) {
        throw new Error(`asset filesystem provider method "${String(name)}" is not implemented`);
    }
    return method as NonNullable<IAssetFileSystemProvider[K]>;
}

function getMethodOwner<K extends keyof IAssetFileSystemProvider>(name: K) {
    return provider[name] ? provider : localProvider;
}

export function fsExists(path: string): boolean {
    return localProvider.exists(path);
}

export async function fsStat(path: string): Promise<IAssetFileStat> {
    return await Promise.resolve(localProvider.stat(path));
}

export async function fsReadFile(path: string, encoding?: BufferEncoding) {
    const readFile = resolveProviderMethod('readFile');
    return await Promise.resolve(readFile.call(getMethodOwner('readFile'), path, encoding));
}

export async function fsWriteFile(path: string, content: Buffer | string | Uint8Array, options?: IAssetWriteFileOptions) {
    rememberOperationContext(options?.context);
    const writeFile = resolveProviderMethod('writeFile');
    await Promise.resolve(writeFile.call(getMethodOwner('writeFile'), path, content, options));
    fileUtf8CacheState.generation++;
    if (typeof content === 'string') {
        updateFileUtf8Cache(getCacheKey(path), content);
    } else {
        fileUtf8CacheState.files.delete(getCacheKey(path));
    }
}

export async function fsCreateDirectory(path: string) {
    const createDirectory = resolveProviderMethod('createDirectory');
    await Promise.resolve(createDirectory.call(getMethodOwner('createDirectory'), path));
}

export async function fsDelete(path: string, options?: IAssetDeleteOptions) {
    rememberOperationContext(options?.context);
    const deleteFile = resolveProviderMethod('delete');
    await Promise.resolve(deleteFile.call(getMethodOwner('delete'), path, options));
    clearFileUtf8Cache(path);
}

export async function fsRename(oldPath: string, newPath: string, options?: IAssetRenameOptions) {
    rememberOperationContext(options?.context);
    const rename = resolveProviderMethod('rename');
    await Promise.resolve(rename.call(getMethodOwner('rename'), oldPath, newPath, options));
    clearFileUtf8Cache(oldPath);
    clearFileUtf8Cache(newPath);
}

export async function fsCopy(sourcePath: string, destinationPath: string, options?: IAssetRenameOptions) {
    rememberOperationContext(options?.context);
    const copy = resolveProviderMethod('copy');
    await Promise.resolve(copy.call(getMethodOwner('copy'), sourcePath, destinationPath, options));
    clearFileUtf8Cache(destinationPath);
}

export type {
    IAssetDeleteOptions,
    IAssetFileStat,
    IAssetFileSystemProvider,
    IAssetOperationContext,
    IAssetOperationKind,
    IAssetOperationOrigin,
    IAssetRenameOptions,
    IAssetWriteFileOptions,
};
