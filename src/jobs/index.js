/**
 * src/jobs/index.js
 *
 * pg-boss job queue — replaces all setInterval background processes.
 *
 * Jobs:
 *   process-enrollments   — every 5 min  — send invites/messages per enrollment state
 *   sync-inbox            — every 10 min — pull Unipile threads/messages
 *   withdraw-invites      — daily 03:00  — auto-withdraw old pending invites
 *   enrich-contacts       — nightly 02:00 — update enrichment for stale contacts
 *   compute-scores        — hourly       — recompute engagement scores
 *   publish-scheduled-posts — every 1 min — publish due posts/comments
 *   process-signal        — on-demand    — handle a single Unipile webhook event
 */

const PgBoss = require('pg-boss');
const db = require('../db');

let boss = null;

async function startBoss() {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    // Keep completed jobs for 7 days for visibility
    deleteAfterDays: 7,
    // Retry failed jobs up to 3 times with exponential backoff
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });

  boss.on('error', err => console.error('[Jobs] pg-boss error:', err.message));

  await boss.start();
  console.log('[Jobs] pg-boss started');

  // ── Register job handlers ─────────────────────────────────────────────
  await boss.work('process-enrollments', { teamSize: 1, teamConcurrency: 1 },
    require('./processEnrollments').handler);

  await boss.work('sync-inbox', { teamSize: 1, teamConcurrency: 1 },
    require('./syncInbox').handler);

  await boss.work('withdraw-invites', { teamSize: 1, teamConcurrency: 1 },
    require('./withdrawInvites').handler);

  await boss.work('enrich-contacts', { teamSize: 2, teamConcurrency: 2 },
    require('./enrichContacts').handler);

  await boss.work('compute-scores', { teamSize: 1, teamConcurrency: 1 },
    require('./computeScores').handler);

  await boss.work('publish-scheduled-posts', { teamSize: 1, teamConcurrency: 1 },
    require('./publishScheduledPosts').handler);

  await boss.work('process-signal', { teamSize: 3, teamConcurrency: 3 },
    require('./processSignal').handler);

  // ── Schedule recurring jobs ───────────────────────────────────────────
  await boss.schedule('process-enrollments',   '*/5 * * * *',  {}, { singletonKey: 'process-enrollments' });
  await boss.schedule('sync-inbox',            '*/10 * * * *', {}, { singletonKey: 'sync-inbox' });
  await boss.schedule('withdraw-invites',      '0 3 * * *',    {}, { singletonKey: 'withdraw-invites' });
  await boss.schedule('enrich-contacts',       '0 2 * * *',    {}, { singletonKey: 'enrich-contacts' });
  await boss.schedule('compute-scores',        '0 * * * *',    {}, { singletonKey: 'compute-scores' });
  await boss.schedule('publish-scheduled-posts', '* * * * *',  {}, { singletonKey: 'publish-posts' });

  console.log('[Jobs] All jobs scheduled');
  return boss;
}

/**
 * Enqueue a single signal for processing (called from webhook handler)
 */
async function enqueueSignal(payload, workspaceId) {
  if (!boss) return;
  await boss.send('process-signal', { payload, workspace_id: workspaceId });
}

/**
 * Manually trigger a job run (for admin/testing)
 */
async function triggerJob(jobName, data = {}) {
  if (!boss) throw new Error('Jobs not started');
  return boss.send(jobName, data);
}

function getBoss() { return boss; }

module.exports = { startBoss, enqueueSignal, triggerJob, getBoss };
