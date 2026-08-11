import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';

export interface StartupTraceArgs {
    readonly [key: string]: unknown;
}

export interface StartupTraceSpan {
    end(args?: StartupTraceArgs): void;
}

interface StartupTraceEvent {
    name: string;
    cat: 'pink.startup';
    ph: 'X' | 'i';
    ts: number;
    dur?: number;
    pid: number;
    tid: number;
    args: StartupTraceArgs;
}

function isEnabled(): boolean {
    const value = process.env.PINK_STARTUP_TRACE;
    return value === '1' || value?.toLowerCase() === 'true';
}

function nowUs(): number {
    return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function safeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function sanitizeValue(value: unknown, depth = 0): unknown {
    if (depth >= 2) {
        return '[truncated]';
    }
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value.length > 256 ? `${value.slice(0, 256)}...` : value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 8).map(item => sanitizeValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).slice(0, 20)) {
            result[key] = sanitizeValue((value as Record<string, unknown>)[key], depth + 1);
        }
        return result;
    }
    return String(value);
}

function sanitizeArgs(args: StartupTraceArgs | undefined): StartupTraceArgs | undefined {
    return args ? sanitizeValue(args) as StartupTraceArgs : undefined;
}

class StartupTrace {
    private enabled = isEnabled();
    private readonly traceId = process.env.PINK_STARTUP_TRACE_ID ?? randomUUID();
    private stream: fs.WriteStream | undefined;
    private configured = false;
    private processType = 'cocos-cli';

    configure(processType = 'cocos-cli'): void {
        this.enabled = isEnabled();
        if (!this.enabled || this.configured) {
            return;
        }

        this.processType = processType;

        const directory = process.env.PINK_STARTUP_TRACE_DIR ?? join(tmpdir(), 'pink-startup-trace');
        try {
            fs.mkdirSync(directory, { recursive: true });
            const filename = join(directory, `pink-startup-${safeFilePart(processType)}-${process.pid}.jsonl`);
            this.stream = fs.createWriteStream(filename, { flags: 'a' });
        } catch (error) {
            this.enabled = false;
            console.warn('[StartupTrace] Failed to create trace file; continuing without startup tracing.', error);
            return;
        }
        this.stream.on('error', () => {
            this.enabled = false;
        });
        this.configured = true;
    }

    mark(name: string, args?: StartupTraceArgs): void {
        if (!this.enabled) {
            return;
        }
        this.configure();
        this.write({
            name,
            cat: 'pink.startup',
            ph: 'i',
            ts: nowUs(),
            pid: process.pid,
            tid: process.pid,
            args: {
                traceId: this.traceId,
                processType: this.processType,
                ...sanitizeArgs(args),
            },
        });
    }

    start(name: string, args?: StartupTraceArgs): StartupTraceSpan {
        if (!this.enabled) {
            return { end: () => undefined };
        }
        this.configure();

        const startTime = nowUs();
        const startArgs = sanitizeArgs(args);
        let ended = false;
        return {
            end: (endArgs?: StartupTraceArgs) => {
                if (ended) {
                    return;
                }
                ended = true;
                this.write({
                    name,
                    cat: 'pink.startup',
                    ph: 'X',
                    ts: startTime,
                    dur: Math.max(0, nowUs() - startTime),
                    pid: process.pid,
                    tid: process.pid,
                    args: {
                        traceId: this.traceId,
                        processType: this.processType,
                        ...startArgs,
                        ...sanitizeArgs(endArgs),
                    },
                });
            },
        };
    }

    private write(event: StartupTraceEvent): void {
        this.stream?.write(`${JSON.stringify(event)}\n`);
    }
}

export const startupTrace = new StartupTrace();

export function configureStartupTrace(processType = 'cocos-cli'): void {
    startupTrace.configure(processType);
}

export async function traceStartup<T>(name: string, operation: () => Promise<T>, args?: StartupTraceArgs): Promise<T> {
    const span = startupTrace.start(name, args);
    try {
        const result = await operation();
        span.end({ status: 'ready' });
        return result;
    } catch (error) {
        span.end({
            status: 'error',
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}
