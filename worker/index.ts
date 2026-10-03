// Export the Workflow and Durable Object classes
export { MyWorkflow } from "./workflow";
export { WorkflowStatusDO } from "./durable-object";

/**
 * Main Worker fetch handler
 *
 * Handles API routes and WebSocket upgrade requests for workflow management:
 * - POST /api/workflow/start - Create new workflow instance
 * - GET /api/workflow/status/:id - Get workflow status
 * - POST /api/workflow/event/:id - Send events to workflow
 * - GET /ws - WebSocket connection for real-time updates
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// API: Start a new workflow instance
		if (url.pathname === "/api/workflow/start" && request.method === "POST") {
			try {
				const instance = await env.MY_WORKFLOW.create({
					params: {
						timestamp: Date.now(),
					},
				});

				return Response.json({
					instanceId: instance.id,
					message: "Workflow started successfully",
				});
			} catch {
				return Response.json(
					{ error: "Failed to start workflow" },
					{ status: 500 },
				);
			}
		}

		// API: Get workflow status
		if (url.pathname.startsWith("/api/workflow/status/")) {
			const instanceId = url.pathname.split("/").pop();
			if (!instanceId) {
				return Response.json(
					{ error: "Instance ID required" },
					{ status: 400 },
				);
			}

			try {
				const instance = await env.MY_WORKFLOW.get(instanceId);
				const status = await instance.status();
				return Response.json(status);
			} catch {
				return Response.json(
					{ error: "Failed to get workflow status" },
					{ status: 500 },
				);
			}
		}

		// API: Send event to workflow instance
		if (
			url.pathname.startsWith("/api/workflow/event/") &&
			request.method === "POST"
		) {
			const instanceId = url.pathname.split("/").pop();
			if (!instanceId) {
				return Response.json(
					{ error: "Instance ID required" },
					{ status: 400 },
				);
			}

			try {
				const body = (await request.json()) as {
					approved: boolean;
					comment?: string;
				};
				const instance = await env.MY_WORKFLOW.get(instanceId);

				await instance.sendEvent({
					type: "user-approval",
					payload: body,
				});

				return Response.json({
					success: true,
					message: "Event sent successfully",
				});
			} catch {
				return Response.json(
					{ error: "Failed to send event" },
					{ status: 500 },
				);
			}
		}

		// WebSocket: Connect to workflow status updates
		if (url.pathname === "/ws") {
			const instanceId = url.searchParams.get("instanceId");
			if (!instanceId) {
				return new Response("instanceId query parameter required", {
					status: 400,
				});
			}

			const upgradeHeader = request.headers.get("Upgrade");
			if (upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}

			try {
				const doId = env.WORKFLOW_STATUS.idFromName(instanceId);
				const stub = env.WORKFLOW_STATUS.get(doId);
				return stub.fetch(request);
			} catch {
				return new Response("Failed to establish WebSocket connection", {
					status: 500,
				});
			}
		}

		return Response.json({ error: "Not Found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// ─── Route handlers ───────────────────────────────────────────────

async function handleStart(
    request: Request,
    env: Env,
    origin: string | null,
): Promise<Response> {
    const instance = await env.MY_WORKFLOW.create({
        params: { timestamp: Date.now() },
    });
    const res = Response.json({
        instanceId: instance.id,
        message: "Workflow started successfully",
    });
    if (env && origin) {
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
    for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
        res.headers.set(k, v);
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
        return jsonError(400, "Invalid JSON body", 
            e instanceof Error ? e.message : undefined, origin, env);
    }
    if (!isApprovalPayload(body)) {
        return jsonError(400, "Invalid payload shape",
            "Expected { approved: boolean, comment?: string }", origin, env);
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
    for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
        res.headers.set(k, v);
    }
    return res;
}

async function handleWebSocket(
    request: Request,
    env: Env,
    instanceId: string,
): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
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

        // 1. CORS preflight — always respond, no auth needed
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin, env),
            });
        }

        // 2. WebSocket route — auth via query param (browsers can't set headers)
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
                // LESSON (P1): explicit logging, no swallowed errors
                console.error("workflow.start_failed", {
                    error: err instanceof Error ? err.message : String(err),
                });
                return jsonError(500, "Failed to start workflow",
                    err instanceof Error ? err.message : undefined,
                    origin, env);
            }
        }

        // 5. GET /api/workflow/status/:id
        // LESSON (URL parsing): strict prefix match, not pathname.split
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
                return jsonError(500, "Failed to get workflow status",
                    err instanceof Error ? err.message : undefined,
                    origin, env);
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
                return jsonError(500, "Failed to send event",
                    err instanceof Error ? err.message : undefined,
                    origin, env);
            }
        }

        // 7. Fallback
        return jsonError(404, "Not Found", undefined, origin, env);
    },
} satisfies ExportedHandler<Env>;
