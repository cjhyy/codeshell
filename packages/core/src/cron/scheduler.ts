/**
 * Back-compat shim. The cron scheduler moved to `automation/scheduler.ts`
 * (see docs/automation-plan-2026-05-31.md). This re-export keeps existing
 * `../cron/scheduler.js` importers working. New code should import from
 * `../automation/scheduler.js`.
 */
export * from "../automation/scheduler.js";
