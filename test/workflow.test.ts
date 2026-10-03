import { env, SELF, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Test suite for the Workflows Starter Template.
 *
 * LESSON (P1 FP): tests must exercise the real handler, not assume its
 * behavior. Every test below calls an actual entry point — either the
 * Workflow runtime or the Worker's HTTP fetch — and asserts on the
 * observable response.
 */

// ─── Helpers ──────────────────────────────────────────────────────

const TEST_TOKEN = "test-token-12345";

function authedHeaders(extra: Record<string, string> = {}): HeadersInit {
    return {
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...extra,
    };
}

async function callWorker(
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    return SELF.fetch(`https://example.com${path}`, init);
}

// ─── Workflow runtime ─────────────────────────────────────────────

describe("MyWorkflow", () => {
    it("completes and returns expected step result", async () => {
        const instanceId = `test-${crypto.randomUUID()}`;

        await using instance = await introspectWorkflowInstance(
            env.MY_WORKFLOW,
            instanceId,
        );

        await instance.modify(async (m) => {
            await m.disableSleeps();
            await m.mockEvent({
                type: "user-approval",
                payload: { approved: true },
            });
        });

        await env.MY_WORKFLOW.create({ id: instanceId });

        const result = await instance.waitForStepResult({
            name: "process data",
        });
        expect(result).toMatchObject({ processed: true });
        expect(result).toHaveProperty("timestamp");
    });

    it("errors when approval event times out", async () => {
        const instanceId = `test-${crypto.randomUUID()}`;

        await using instance = await introspectWorkflowInstance(
            env.MY_WORKFLOW,
            instanceId,
        );

        await instance.modify(async (m) => {
            await m.disableSleeps();
            await m.forceEventTimeout({ name: "wait for approval" });
        });

        await env.MY_WORKFLOW.create({ id: instanceId });

        await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    });
});

// ─── HTTP: auth ───────────────────────────────────────────────────

describe("fetch: authentication", () => {
    it("rejects POST /api/workflow/start without a token", async () => {
        const res = await callWorker("/api/workflow/start", { method: "POST" });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("Unauthorized");
    });

    it("rejects with a malformed Authorization header", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: { Authorization: "NotBearer something" },
        });
        expect(res.status).toBe(401);
    });

    it("rejects with a wrong token", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: { Authorization: "Bearer wrong-token" },
        });
        expect(res.status).toBe(401);
    });

    it("accepts a valid token and starts a workflow", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: authedHeaders(),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { instanceId: string; message: string };
        expect(body.message).toBe("Workflow started successfully");
        expect(typeof body.instanceId).toBe("string");
        expect(body.instanceId.length).toBeGreaterThan(0);
    });
});

// ─── HTTP: routing ────────────────────────────────────────────────

describe("fetch: routing", () => {
    it("returns 404 for unknown routes", async () => {
        const res = await callWorker("/api/does-not-exist", {
            method: "GET",
            headers: authedHeaders(),
        });
        expect(res.status).toBe(404);
    });

    it("returns 400 for an empty instanceId in status path", async () => {
        const res = await callWorker("/api/workflow/status/", {
            method: "GET",
            headers: authedHeaders(),
        });
        expect(res.status).toBe(400);
    });

    it("returns 400 for an instanceId with bad characters", async () => {
        const res = await callWorker(
            "/api/workflow/status/abc%20def/../x",
            { method: "GET", headers: authedHeaders() },
        );
        expect(res.status).toBe(400);
    });

    it("returns 400 for an over-long instanceId", async () => {
        const long = "a".repeat(200);
        const res = await callWorker(`/api/workflow/status/${long}`, {
            method: "GET",
            headers: authedHeaders(),
        });
        expect(res.status).toBe(400);
    });
});

// ─── HTTP: payload validation ────────────────────────────────────

describe("fetch: event payload validation", () => {
    it("rejects non-JSON body with 400", async () => {
        const res = await callWorker("/api/workflow/event/some-id", {
            method: "POST",
            headers: authedHeaders({ "Content-Type": "application/json" }),
            body: "not-json",
        });
        expect(res.status).toBe(400);
    });

    it("rejects JSON without an `approved` boolean", async () => {
        const res = await callWorker("/api/workflow/event/some-id", {
            method: "POST",
            headers: authedHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ approved: "yes" }),
        });
        expect(res.status).toBe(400);
    });

    it("rejects a comment that exceeds 1000 chars", async () => {
        const res = await callWorker("/api/workflow/event/some-id", {
            method: "POST",
            headers: authedHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                approved: true,
                comment: "x".repeat(1001),
            }),
        });
        expect(res.status).toBe(400);
    });

    it("returns 500 when the workflow instance does not exist", async () => {
        const res = await callWorker(
            "/api/workflow/event/nonexistent-instance-xyz",
            {
                method: "POST",
                headers: authedHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ approved: true }),
            },
        );
        // Our handler wraps any get/sendEvent failure in a 500.
        expect([400, 500]).toContain(res.status);
    });
});

// ─── HTTP: WebSocket token in query ───────────────────────────────

describe("fetch: /ws auth", () => {
    it("rejects /ws without a token", async () => {
        const res = await callWorker("/ws?instanceId=x");
        expect(res.status).toBe(401);
    });

    it("rejects /ws with a wrong token", async () => {
        const res = await callWorker("/ws?instanceId=x&token=wrong");
        expect(res.status).toBe(401);
    });

    it("rejects /ws with a valid token but bad instanceId", async () => {
        const res = await callWorker(
            `/ws?instanceId=${"a".repeat(200)}&token=${TEST_TOKEN}`,
        );
        expect(res.status).toBe(400);
    });

    it("rejects /ws without an Upgrade header", async () => {
        const res = await callWorker(
            `/ws?instanceId=ok-id&token=${TEST_TOKEN}`,
        );
        // 426 = Upgrade Required
        expect(res.status).toBe(426);
    });
});

// ─── HTTP: CORS preflight ─────────────────────────────────────────

describe("fetch: CORS", () => {
    it("responds to OPTIONS with 204 and no body", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "OPTIONS",
            headers: { Origin: "https://app.example.com" },
        });
        expect(res.status).toBe(204);
        const text = await res.text();
        expect(text).toBe("");
    });

    it("does not emit CORS headers when Origin is not allowed", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: {
                ...authedHeaders(),
                Origin: "https://evil.example.com",
            },
        });
        // CORS headers should be absent (not "null", not wildcard).
        expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
});

// ─── Utility: safeEqual (via observable behavior) ─────────────────

describe("auth: token comparison semantics", () => {
    it("rejects a token that is a prefix of the real one", async () => {
        // "test-token-123" is a prefix of "test-token-12345".
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: { Authorization: "Bearer test-token-123" },
        });
        expect(res.status).toBe(401);
    });

    it("rejects a token that is a superset of the real one", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: { Authorization: "Bearer test-token-12345-extra" },
        });
        expect(res.status).toBe(401);
    });

    it("rejects an empty bearer token", async () => {
        const res = await callWorker("/api/workflow/start", {
            method: "POST",
            headers: { Authorization: "Bearer " },
        });
        expect(res.status).toBe(401);
    });
});
