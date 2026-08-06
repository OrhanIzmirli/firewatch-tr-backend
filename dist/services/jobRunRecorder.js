"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordJobRun = recordJobRun;
exports.pruneJobRuns = pruneJobRuns;
const database_1 = __importDefault(require("../config/database"));
/**
 * Records what a background job did, so that "is the pipeline alive" can be
 * answered without guessing from how much data appeared.
 *
 * The clustering transaction once rolled back on every round for three and a
 * half hours. Externally that looked exactly like a quiet FIRMS feed: counts
 * stopped moving, and nothing said whether the job had run at all. Recording
 * the run separates the two questions.
 *
 * EVERY WRITE HERE IS OUTSIDE THE CALLER'S TRANSACTION, on its own pool
 * connection. That is the whole point: a job that rolls back must not roll
 * back the evidence that it failed.
 *
 * Failures to record are swallowed. Observability must never be the reason a
 * working job reports an error — this is a witness, not a participant.
 */
async function recordJobRun(job, startedAt, status, stats = {}, error) {
    const message = error === undefined || error === null
        ? null
        : // Message only. This is served over HTTP by the health endpoint, and
            // a stack trace there leaks paths for no diagnostic gain.
            String(error.message ?? error).slice(0, 500);
    try {
        await database_1.default.query(`INSERT INTO job_runs (job, started_at, status, stats, error)
       VALUES ($1, $2, $3, $4::jsonb, $5)`, [job, startedAt, status, JSON.stringify(stats), message]);
    }
    catch (recordError) {
        const code = recordError.code;
        // 42P01 = table missing, i.e. migration 006 is not applied yet. That is a
        // normal state during a staged rollout, not something to shout about on
        // every run.
        if (code !== '42P01') {
            console.error('job_runs insert failed (job continues regardless):', recordError.message);
        }
    }
}
/** Keeps the table to a fortnight. Called from the same place as the detection prune. */
async function pruneJobRuns() {
    try {
        const result = await database_1.default.query(`DELETE FROM job_runs WHERE finished_at < NOW() - INTERVAL '14 days'`);
        return result.rowCount ?? 0;
    }
    catch {
        return 0;
    }
}
