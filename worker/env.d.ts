/// <reference types="@cloudflare/vitest-pool-workers" />

import type { MyWorkflow } from "./workflow";
import type { WorkflowStatusDO } from "./durable-object";

declare global {
    interface Env {
        // Required: bearer token for API and WebSocket auth.
        // Set via `wrangler secret put API_TOKEN` in production.
        API_TOKEN: string;

        // Optional: comma-separated list of allowed CORS origins.
        // If unset, no CORS headers are emitted (same-origin only).
        ALLOWED_ORIGINS?: string;

        // Bindings declared in wrangler.jsonc
        MY_WORKFLOW: Workflow;
        WORKFLOW_STATUS: DurableObjectNamespace<WorkflowStatusDO>;
    }
}

// Make this a module so `declare global` is valid.
export {};
