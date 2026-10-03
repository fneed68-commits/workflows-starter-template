// Export the Workflow and Durable Object classes
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

/**
 * Main Worker fetch handler.
 *
 * Routes:
 *  - POST /api/workflow/start       Create new workflow instance
 *  - GET  /api/workflow/status/:id  Get workflow status
 *  - POST /api/workflow/event/:id   Send events to a running workflow
 *  - GET  /ws?instanceId=...&token=...  WebSocket for live updates
 *
 * All /api routes require `Authorization: Bearer <API_TOKEN>`.
 * WebSocket accepts `?token=<API_TOKEN>` (browsers cannot set headers).
 */

// ─── Constants ────────────────────────────────────────────────────
const MAX_BODY_BYTES = 4 * 1024;
const MAX_INSTANCE_ID_LEN = 128;
const BEARER_PREFIX = "Bearer ";

// ─── Helpers ──────────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function getBearerToken(request: Request): string | null {
    const header = request.headers.get("Authorization");
    if (!header || !header.startsWith(BEARER_PREFIX)) return null;
    return header.slice(BEARER_PREFIX.length).trim() || null;
}

function jsonError(
    status: number,
    error: string,
    detail: string | undefined,
    origin: string | null,
    env?: Env,
): Response {
    const body: Record<string, unknown> = { error };
    if (detail) body.detail = detail;
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (env && origin) {
        Object.assign(headers, corsHeaders(origin, env));
    }
    return new Response(JSON.stringify(body), { status, headers });
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
    if (!origin) return {};
    const allowed = (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowed.length === 0) return {};
    if (!allowed.includes(origin) && !allowed.includes("*")) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

function requireAuth(
    request: Request,
    env: Env,
    origin: string | null,
): Response | null {
    const expected = env.API_TOKEN;
    if (!expected) {
        return jsonError(500, "Server auth not configured", undefined, origin);
    }
    const provided = getBearerToken(request);
    if (!provided || !safeEqual(provided, expected)) {
        return jsonError(401, "Unauthorized", undefined, origin);
    }
    return null;
}

function isValidInstanceId(id: string): boolean {
    if (!id || id.length > MAX_INSTANCE_ID_LEN) return false;
    return /^[A-Za-z0-9_\-.:]+$/.test(id);
}

async function readJsonBody<T = unknown>(
    request: Request,
    maxBytes: number,
): Promise<T> {
    const lengthHeader = request.headers.get("Content-Length");
    if (lengthHeader) {
        const len = Number(lengthHeader);
        if (Number.isFinite(len) && len > maxBytes) {
            throw new Error(`Request body exceeds ${maxBytes} bytes`);
        }
    }
    const text = await request.text();
    if (text.length > maxBytes) {
        throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    if (!text) return {} as T;
    return JSON.parse(text) as T;
}

function isApprovalPayload(v: unknown): v is {
    approved: boolean;
    comment?: string;
} {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    if (typeof r.approved !== "boolean") return false;
    if (r.comment !== undefined && typeof r.comment !== "string") return false;
    if (typeof r.comment === "string" && r.comment.length > 1000) return false;
    return true;
}

// ─── Route handlers ───────────────────────────────────────────────

async function handleStart(
    request: Request,
    env: Env,
    origin: string | null,
): Promise<Response> {
    // Drain any body (accepted JSON is ignored for now).
    try {
        await readJsonBody(request, MAX_BODY_BYTES);
    } catch {
        // Empty or malformed body is fine for /start.
    }
    const instance = await env.MY_WORKFLOW.create({
        params: { timestamp: Date.now() },
    });
    const res = Response.json({
        instanceId: instance.id,
        message: "Workflow started successfully",
    });
    if (origin) {
        for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
            res.headers.set(k, v);
        }
    }
    return res;
}

async function handleStatus(
    instanceId: string,
    env: Env,
    origin: string | null,
): Promise<Response> {
    const instance = await env.MY_WORKFLOW.get(instanceId);
    const status = await instance.status();
    const res = Response.json(status);
    if (origin) {
        for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
            res.headers.set(k, v);
        }
    }
    return res;
}

async function handleEvent(
    request: Request,
    instanceId: string,
    env: Env,
    origin: string | null,
): Promise<Response> {
    let body: unknown;
    try {
        body = await readJsonBody(request, MAX_BODY_BYTES);
    } catch (e) {
        return jsonError(
            400,
            "Invalid JSON body",
            e instanceof Error ? e.message : undefined,
            origin,
            env,
        );
    }
    if (!isApprovalPayload(body)) {
        return jsonError(
            400,
            "Invalid payload shape",
            "Expected { approved: boolean, comment?: string }",
            origin,
            env,
        );
    }
    const instance = await env.MY_WORKFLOW.get(instanceId);
    await instance.sendEvent({
        type: "user-approval",
        payload: body,
    });
    const res = Response.json({
        success: true,
        message: "Event sent successfully",
    });
    if (origin) {
        for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
            res.headers.set(k, v);
        }
    }
    return res;
}

async function handleWebSocket(
    request: Request,
    env: Env,
    instanceId: string,
): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const doId = env.WORKFLOW_STATUS.idFromName(instanceId);
    const stub = env.WORKFLOW_STATUS.get(doId);
    return stub.fetch(request);
}

// ─── Main fetch handler ──────────────────────────────────────────

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin");

        // 1. CORS preflight — no auth needed
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin, env),
            });
        }

        // 2. WebSocket route — auth via query param
        if (url.pathname === "/ws") {
            const instanceId = url.searchParams.get("instanceId");
            const token = url.searchParams.get("token");
            const expected = env.API_TOKEN;
            if (!expected) {
                return new Response("Server auth not configured", { status: 500 });
            }
            if (!token || !safeEqual(token, expected)) {
                return new Response("Unauthorized", { status: 401 });
            }
            if (!instanceId || !isValidInstanceId(instanceId)) {
                return new Response("Invalid instanceId", { status: 400 });
            }
            return handleWebSocket(request, env, instanceId);
        }

        // 3. All /api routes require bearer auth
        if (url.pathname.startsWith("/api/")) {
            const authErr = requireAuth(request, env, origin);
            if (authErr) return authErr;
        }

        // 4. POST /api/workflow/start
        if (
            url.pathname === "/api/workflow/start" &&
            request.method === "POST"
        ) {
            try {
                return await handleStart(request, env, origin);
            } catch (err) {
                console.error("workflow.start_failed", {
                    error: err instanceof Error ? err.message : String(err),
                });
                return jsonError(
                    500,
                    "Failed to start workflow",
                    err instanceof Error ? err.message : undefined,
                    origin,
                    env,
                );
            }
        }

        // 5. GET /api/workflow/status/:id
        const statusPrefix = "/api/workflow/status/";
        if (url.pathname.startsWith(statusPrefix) && request.method === "GET") {
            const instanceId = url.pathname.slice(statusPrefix.length);
            if (!isValidInstanceId(instanceId)) {
                return jsonError(400, "Invalid instance ID", undefined, origin, env);
            }
            try {
                return await handleStatus(instanceId, env, origin);
            } catch (err) {
                console.error("workflow.status_failed", {
                    instanceId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return jsonError(
                    500,
                    "Failed to get workflow status",
                    err instanceof Error ? err.message : undefined,
                    origin,
                    env,
                );
            }
        }

        // 6. POST /api/workflow/event/:id
        const eventPrefix = "/api/workflow/event/";
        if (url.pathname.startsWith(eventPrefix) && request.method === "POST") {
            const instanceId = url.pathname.slice(eventPrefix.length);
            if (!isValidInstanceId(instanceId)) {
                return jsonError(400, "Invalid instance ID", undefined, origin, env);
            }
            try {
                return await handleEvent(request, instanceId, env, origin);
            } catch (err) {
                console.error("workflow.event_failed", {
                    instanceId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return jsonError(
                    500,
                    "Failed to send event",
                    err instanceof Error ? err.message : undefined,
                    origin,
                    env,
                );
            }
        }

        // 7. Fallback
        return jsonError(404, "Not Found", undefined, origin, env);
    },
} satisfies ExportedHandler<Env>;
