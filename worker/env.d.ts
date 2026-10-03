/// <reference types="@cloudflare/vitest-pool-workers" />

import type { WorkflowStatusDO } from "./durable-object";

declare global {
    interface Env {
        // Required: bearer token for API and WebSocket auth.
        // Set via `wrangler secret put API_TOKEN` in production.
        API_TOKEN: string;

        // Optional: comma-separated list of allowed CORS origins.
        ALLOWED_ORIGINS?: string;

        // Bindings declared in wrangler.jsonc
        MY_WORKFLOW: Workflow;
        WORKFLOW_STATUS: DurableObjectNamespace<WorkflowStatusDO>;
    }
}

export {};
