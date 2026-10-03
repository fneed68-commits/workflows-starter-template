import { DurableObject } from "cloudflare:workers";

/**
 * WorkflowStatusDO — Durable Object for workflow state and WebSocket fanout.
 *
 * Responsibilities:
 *  - Accept WebSocket connections using the hibernation API
 *  - Track step statuses for one workflow instance
 *  - Broadcast updates to all connected clients
 *  - Expose an RPC `updateStep` called by the workflow
 */

export type StepStatus = "pending" | "running" | "waiting" | "completed" | "error";
export type WorkflowStatus = "running" | "completed" | "error";

// Canonical step order — kept in sync with MyWorkflow.run().
const STEP_NAMES = [
    "process data",
    "wait 2 seconds",
    "wait for approval",
    "final",
] as const;

interface StateSnapshot {
    stepStatuses: Record<string, StepStatus>;
    currentStep: string | null;
    workflowStatus: WorkflowStatus;
}

export class WorkflowStatusDO extends DurableObject {
    private stepStatuses: Map<string, StepStatus>;
    private currentStep: string | null;
    private workflowStatus: WorkflowStatus;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.stepStatuses = new Map();
        this.currentStep = null;
        this.workflowStatus = "running";

        // Restore state from storage (survives hibernation / eviction).
        ctx.blockConcurrencyWhile(async () => {
            const snapshot = await ctx.storage.get<StateSnapshot>("state");
            if (snapshot) {
                this.stepStatuses = new Map(
                    Object.entries(snapshot.stepStatuses ?? {}) as [string, StepStatus][],
                );
                this.currentStep = snapshot.currentStep ?? null;
                this.workflowStatus = snapshot.workflowStatus ?? "running";
            } else {
                for (const name of STEP_NAMES) {
                    this.stepStatuses.set(name, "pending");
                }
            }
        });
    }

    // ─── HTTP / WebSocket ─────────────────────────────────────────

    async fetch(request: Request): Promise<Response> {
        const upgrade = request.headers.get("Upgrade");
        if (upgrade?.toLowerCase() !== "websocket") {
            return new Response("Expected WebSocket", { status: 400 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Hibernation API: DO can hibernate while sockets stay open.
        this.ctx.acceptWebSocket(server);

        // Send the current state immediately.
        try {
            server.send(JSON.stringify(this.getStateMessage()));
        } catch {
            // A brand-new socket should be writable; if not, drop it.
            server.close(1011, "init-send-failed");
        }

        return new Response(null, { status: 101, webSocket: client });
    }

    // ─── RPC (called by the workflow) ─────────────────────────────

    async updateStep(stepName: string, status: StepStatus): Promise<void> {
        if (!STEP_NAMES.includes(stepName as (typeof STEP_NAMES)[number])) {
            console.warn("workflow.unknown_step", { stepName });
            return;
        }

        this.stepStatuses.set(stepName, status);

        if (status === "running" || status === "waiting") {
            this.currentStep = stepName;
        } else if (status === "completed" && this.currentStep === stepName) {
            this.currentStep = null;
        }

        const allCompleted = [...this.stepStatuses.values()].every(
            (s) => s === "completed",
        );
        const anyErrored = [...this.stepStatuses.values()].some(
            (s) => s === "error",
        );

        if (anyErrored) {
            this.workflowStatus = "error";
            this.currentStep = null;
        } else if (allCompleted) {
            this.workflowStatus = "completed";
            this.currentStep = null;
        }

        // LESSON (nodejs-pool): atomic write. One put = one transaction.
        await this.ctx.storage.put<StateSnapshot>("state", {
            stepStatuses: Object.fromEntries(this.stepStatuses) as Record<string, StepStatus>,
            currentStep: this.currentStep,
            workflowStatus: this.workflowStatus,
        });

        this.broadcast(this.getStateMessage());
    }

    // ─── WebSocket event handlers (hibernation API) ───────────────

    async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
        // Echo current state on any client message (heartbeat-friendly).
        try {
            ws.send(JSON.stringify(this.getStateMessage()));
        } catch {
            // Client may have disconnected between checks.
        }
    }

    async webSocketClose(
        _ws: WebSocket,
        _code: number,
        _reason: string,
        _wasClean: boolean,
    ): Promise<void> {
        // Cloudflare closes the socket automatically after this handler.
        // Calling ws.close() here would be redundant (and may warn).
    }

    async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
        // LESSON (all previous audits): never swallow errors silently.
        console.error("workflow.ws_error", {
            error: error instanceof Error ? error.message : String(error),
        });
        // The runtime closes the faulty socket after this handler returns.
    }

    // ─── Helpers ──────────────────────────────────────────────────

    private broadcast(message: object): void {
        const json = JSON.stringify(message);
        for (const socket of this.ctx.getWebSockets()) {
            try {
                socket.send(json);
            } catch (err) {
                // A client that vanished mid-send: log once, keep going.
                console.warn("workflow.ws_broadcast_failed", {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    private getStateMessage(): object {
        return {
            type: "workflow_update",
            currentStep: this.currentStep,
            stepStatuses: Object.fromEntries(this.stepStatuses),
            workflowStatus: this.workflowStatus,
            timestamp: Date.now(),
        };
    }
}
