import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { StepStatus } from "./durable-object";

/**
 * MyWorkflow — demonstrates:
 *  - Durable step execution (step.do)
 *  - Time-based delays (step.sleep)
 *  - Interactive pausing (step.waitForEvent)
 *  - Data flow between steps
 *  - Progress notifications to a Durable Object for live UI updates
 *
 * @see https://developers.cloudflare.com/workflows
 */

interface ApprovalPayload {
    approved: boolean;
    comment?: string;
}

export class MyWorkflow extends WorkflowEntrypoint<Env, Record<string, unknown>> {
    async run(
        event: WorkflowEvent<Record<string, unknown>>,
        step: WorkflowStep,
    ): Promise<void> {
        const instanceId = event.instanceId;

        // Progress notifier — idempotent by design (safe to re-run on retry).
        // LESSON (n8n `EngineFallbackError`): any failure here must not abort the
        // workflow. Notifications are best-effort; step execution is the priority.
        const notify = async (
            stepName: string,
            status: StepStatus,
        ): Promise<void> => {
            try {
                const doId = this.env.WORKFLOW_STATUS.idFromName(instanceId);
                const stub = this.env.WORKFLOW_STATUS.get(doId);
                await stub.updateStep(stepName, status);
            } catch (err) {
                // LESSON (P1 FP): don't swallow silently — log with context.
                console.warn("workflow.notify_failed", {
                    stepName,
                    status,
                    instanceId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        };

        // ─── Step 1: process data ──────────────────────────────────
        await notify("process data", "running");
        const result = await step.do("process data", async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return { processed: true, timestamp: Date.now() };
        });
        await notify("process data", "completed");

        // ─── Step 2: sleep ─────────────────────────────────────────
        await notify("wait 2 seconds", "running");
        await step.sleep("wait 2 seconds", "2 seconds");
        await notify("wait 2 seconds", "completed");

        // ─── Step 3: wait for approval event ───────────────────────
        await notify("wait for approval", "waiting");
        let approval: { payload: ApprovalPayload };
        try {
            approval = await step.waitForEvent<ApprovalPayload>(
                "wait for approval",
                { type: "user-approval", timeout: "60 minutes" },
            );
        } catch (err) {
            // Timeout or step failure: mark the step errored, then rethrow
            // so the workflow terminates with an "errored" status (the
            // public API and the test suite both expect this).
            await notify("wait for approval", "error");
            console.error("workflow.approval_failed", {
                instanceId,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
        await notify("wait for approval", "completed");

        // ─── Step 4: final ─────────────────────────────────────────
        await notify("final", "running");
        await step.do("final", async () => {
            console.log("workflow.results", {
                instanceId,
                processed: result,
                approval: approval.payload,
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        await notify("final", "completed");
    }
}
