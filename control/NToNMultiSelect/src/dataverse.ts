import { QueryConfigError } from "./fetchQuery";
import { Strings } from "./strings";

/** Error raised for any non-successful Dataverse Web API response. */
export class DataverseError extends Error {
    public readonly status: number;
    public readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = "DataverseError";
        this.status = status;
        this.code = code;
    }
}

/** The request didn't get an answer in time. */
export class TimeoutError extends Error {
    constructor() {
        super("The request timed out.");
        this.name = "TimeoutError";
    }
}

export interface CollectionPage<T> {
    value: T[];
    nextLink: string | null;
}

interface ODataCollection<T> {
    value?: T[];
    "@odata.nextLink"?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
    maxPageSize?: number;
    /** More Prefer header preferences, e.g. which annotations to include. */
    prefer?: string[];
    signal?: AbortSignal;
}

/** A fully read response (the body is read while the timeout still applies). */
interface Reply {
    status: number;
    statusText: string;
    retryAfter: string | null;
    body: string;
}

/**
 * Time allowed for a whole request, body included. Writes get a little more than Dataverse's own 2-minute limit for
 * synchronous plug-ins, so a slow plug-in can finish instead of being abandoned halfway.
 */
const READ_TIMEOUT_MS = 120_000;
const WRITE_TIMEOUT_MS = 130_000;
/** Retries for throttling (429), gateway errors (502-504) and dropped connections. */
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];
/** The longest Retry-After pause that is honoured; a longer one is capped at this. */
const MAX_PAUSE_HONOURED_MS = 5 * 60_000;
/** The longest a single request waits for a pause to end; past that it fails with "server busy" instead. */
const MAX_WAIT_PER_REQUEST_MS = 60_000;

/**
 * When Dataverse throttles a user (service protection limits), it answers 429 with a Retry-After header and asks
 * clients to stop sending until then. This pause is shared by every instance of this control on the page, so four
 * parallel writes don't keep hammering the server while one of them waits. (The rest of the app isn't paused.)
 */
let pausedUntil = 0;

/** Ends a throttling pause (Retry-After) recorded earlier. */
export function resetThrottle(): void {
    pausedUntil = 0;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            signal?.removeEventListener("abort", cancel);
            resolve();
        }
        function cancel(): void {
            clearTimeout(timer);
            reject(abortError());
        }
        signal?.addEventListener("abort", cancel);
    });
let sleep: Sleep = realSleep;

/** Replaces the timer used for retry pauses; called without an argument, restores the real one. */
export function setSleep(fn?: Sleep): void {
    sleep = fn ?? realSleep;
}

/**
 * Minimal Dataverse Web API client. The control talks to the API directly (same origin, the user's own session)
 * because the PCF webAPI object has no associate/disassociate operations.
 *
 * Retries: a request turned away with 429 (honouring Retry-After), 502, 503 or 504, or one whose connection failed,
 * is tried again up to 3 times. Reads that time out are tried once more. A write that timed out is not resent,
 * because it may still finish on the server; it is reported as failed and the control re-reads the selection.
 * Resending the other failures is safe: an associate that turns out to exist already is detected as a duplicate
 * (see RelatedData.associate), and removing a link that is already gone counts as done.
 */
export class DataverseClient {
    /** e.g. https://contoso.crm.dynamics.com/api/data/v9.2 */
    public readonly apiUrl: string;
    private readonly fetchImpl: FetchLike;

    constructor(clientUrl: string, fetchImpl?: FetchLike) {
        this.apiUrl = clientUrl.replace(/\/+$/, "") + "/api/data/v9.2";
        this.fetchImpl = fetchImpl ?? ((input, init) => window.fetch(input, init));
    }

    public async get<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
        const headers: Record<string, string> = this.baseHeaders();
        const prefer = [...(options.maxPageSize ? [`odata.maxpagesize=${options.maxPageSize}`] : []), ...(options.prefer ?? [])];
        if (prefer.length) {
            headers.Prefer = prefer.join(",");
        }
        const reply = await this.request(this.resolve(pathOrUrl), { method: "GET", headers }, options.signal);
        return (reply.body ? JSON.parse(reply.body) : {}) as T;
    }

    /** Reads one page of a collection; pass the returned nextLink (with the same page size) to continue. */
    public async getPage<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<CollectionPage<T>> {
        const body = await this.get<ODataCollection<T>>(pathOrUrl, options);
        return {
            value: body.value ?? [],
            nextLink: body["@odata.nextLink"] ?? null,
        };
    }

    /** Reads every page of a collection (follows @odata.nextLink with the same page size). */
    public async getAll<T>(path: string, options: RequestOptions = {}): Promise<T[]> {
        const all: T[] = [];
        let next: string | null = path;
        while (next) {
            const page: CollectionPage<T> = await this.getPage<T>(next, options);
            all.push(...page.value);
            next = page.nextLink;
        }
        return all;
    }

    public async send(method: "POST" | "DELETE" | "PATCH", path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<void> {
        const headers = { ...this.baseHeaders(), ...extraHeaders };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json; charset=utf-8";
        }
        await this.request(this.resolve(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    }

    /** One logical request: waits out any throttling pause, then tries up to MAX_RETRIES + 1 times. */
    private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Reply> {
        const isRead = (init.method ?? "GET") === "GET";
        let timeouts = 0;
        for (let attempt = 0; ; attempt++) {
            const wait = pausedUntil - Date.now();
            if (wait > MAX_WAIT_PER_REQUEST_MS) {
                // Still throttled for a long while: report "server busy" now rather than queueing behind the pause.
                throw new DataverseError(429, "", "The server asked to pause requests.");
            }
            if (wait > 0) await sleep(wait, signal);
            throwIfAborted(signal);

            let reply: Reply | null = null;
            let failure: unknown = null;
            try {
                reply = await this.fetchWithTimeout(url, init, isRead ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS, signal);
            } catch (error) {
                failure = error;
            }
            if (reply && reply.status < 400) {
                return reply;
            }
            if (signal?.aborted) {
                throw failure ?? abortError();
            }

            let retryable: boolean;
            if (failure instanceof TimeoutError) {
                timeouts++;
                retryable = isRead && timeouts === 1;
            } else if (failure) {
                retryable = isNetworkError(failure);
            } else {
                retryable = isRetryableStatus(reply!.status);
            }
            if (!retryable || attempt >= MAX_RETRIES) {
                throw failure ?? toError(reply!);
            }
            let delay = BACKOFF_MS[attempt] + Math.floor(Math.random() * 250);
            if (reply?.status === 429) {
                const retryAfter = retryAfterMs(reply.retryAfter);
                if (retryAfter !== null) delay = retryAfter;
                pausedUntil = Math.max(pausedUntil, Date.now() + delay);
                continue; // the wait happens at the top of the loop, where a very long pause fails fast
            }
            await sleep(delay, signal);
        }
    }

    /** Sends the request and reads the whole body, all within the timeout and cancellable by the caller. */
    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const forwardAbort = (): void => controller.abort();
        signal?.addEventListener("abort", forwardAbort);
        try {
            const response = await this.fetchImpl(url, { ...init, credentials: "same-origin", signal: controller.signal });
            const body = await response.text();
            return { status: response.status, statusText: response.statusText, retryAfter: response.headers.get("Retry-After"), body };
        } catch (error) {
            if (timedOut) throw new TimeoutError();
            throw error;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", forwardAbort);
        }
    }

    private resolve(pathOrUrl: string): string {
        return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.apiUrl}/${pathOrUrl.replace(/^\/+/, "")}`;
    }

    private baseHeaders(): Record<string, string> {
        return {
            Accept: "application/json",
            "OData-MaxVersion": "4.0",
            "OData-Version": "4.0",
        };
    }
}

function isRetryableStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Retry-After in seconds or as an HTTP date; null when missing or unreadable. */
function retryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_PAUSE_HONOURED_MS) : null;
}

function abortError(): Error {
    const error = new Error("The request was cancelled.");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError();
}

/** fetch() rejects with a TypeError when the connection fails (offline, DNS, dropped connection). */
export function isNetworkError(error: unknown): boolean {
    return error instanceof TypeError;
}

function toError(reply: Reply): DataverseError {
    let code = "";
    let message = `${reply.status} ${reply.statusText}`.trim();
    try {
        if (reply.body) {
            const parsed = JSON.parse(reply.body) as { error?: { code?: string; message?: string } };
            if (parsed.error) {
                code = parsed.error.code ?? "";
                message = parsed.error.message || message;
            }
        }
    } catch {
        // Non-JSON error body: keep the status text.
    }
    return new DataverseError(reply.status, code, message);
}

/** Escapes a value for use inside a single-quoted OData string literal. */
export function odataString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** True when the error means the record pair is already associated (duplicate intersect row). */
export function isAlreadyAssociated(error: unknown): boolean {
    if (!(error instanceof DataverseError)) {
        return false;
    }
    const code = error.code.toLowerCase();
    return code === "0x80040237" || /already exists|duplicate|cannot insert duplicate key/i.test(error.message);
}

/**
 * True when a request failed only because a record (or the link) doesn't exist. A 404 about the URL itself
 * ("Resource not found for the segment ...", i.e. a navigation property that no longer exists) is a real error.
 */
export function isNotFound(error: unknown): boolean {
    if (!(error instanceof DataverseError) || error.status !== 404) return false;
    const code = error.code.toLowerCase();
    return (code === "" || code === "0x80040217") && !/not found for the segment/i.test(error.message);
}

/** 401 (signed out), 403 or the "missing privilege" code: retrying won't help, so the rest of a batch is dropped. */
export function isPermissionError(error: unknown): boolean {
    if (!(error instanceof DataverseError)) return false;
    return error.status === 401 || error.status === 403 || error.code.toLowerCase() === "0x80040220";
}

// Service protection limits: number of requests, execution time, concurrent requests.
const THROTTLING_CODES = ["0x80072322", "0x80072321", "0x80072326"];
// Queries Dataverse refused or throttled because they cost too much (leading wildcards, scans, computed columns).
const QUERY_TOO_EXPENSIVE_CODES = ["0x80048573", "0x80048574", "0x80048575", "0x80048644", "0x80048544", "0x80048744", "0x80048745"];

/** The server is overloaded or throttling this user (after the client's own retries). */
export function isServerBusy(error: unknown): boolean {
    return error instanceof DataverseError && (error.status === 429 || THROTTLING_CODES.includes(error.code.toLowerCase()));
}

/**
 * Turns any error into a sentence for the user. `operation` decides the wording of permission errors ("see" for
 * reads, "change" for link writes, "update" for writes to the record itself). For permission errors the missing
 * privilege (e.g. prvAppendToContact) is added in brackets so an administrator can act on it.
 */
export function friendlyError(error: unknown, t: Strings, operation: "read" | "change" | "update" = "change"): string {
    if (error instanceof QueryConfigError) {
        return error.describe(t);
    }
    if (error instanceof TimeoutError) {
        return t.timedOut;
    }
    if (isNetworkError(error)) {
        return t.cannotReachServer;
    }
    if (error instanceof DataverseError) {
        const code = error.code.toLowerCase();
        if (error.status === 401) {
            return t.sessionExpired;
        }
        if (isPermissionError(error)) {
            const privilege = /\bprv\w+/i.exec(error.message)?.[0];
            const text = operation === "read" ? t.noPermissionRead : operation === "update" ? t.noPermissionUpdate : t.noPermissionChange;
            return privilege ? `${text} (${privilege})` : text;
        }
        if (isServerBusy(error)) {
            return t.serverBusy;
        }
        if (QUERY_TOO_EXPENSIVE_CODES.includes(code)) {
            return t.searchTooSlow;
        }
        return error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
