/**
 * conversationQueue.js
 *
 * Lightweight in-memory analysis queue with:
 *  - Debounce per contact (2 min): if a new message arrives before the
 *    timer fires, the timer resets so we analyze after the conversation
 *    has settled, not mid-exchange.
 *  - Max 3 concurrent Claude API calls at once.
 *  - Deduplication: the same contact can only appear once in the queue.
 */

const { analyzeConversation } = require('./conversationAnalyzer');

const DEBOUNCE_MS   = 2 * 60 * 1000; // 2 minutes
const MAX_WORKERS   = 3;
const POLL_MS       = 30 * 1000;     // poll every 30 s

// Map<contactId, { timer, accountId, chatId, campaignId }>
const pending  = new Map();
let   running  = 0;
let   pollTimer = null;

/**
 * Enqueue a contact for conversation analysis.
 * Safe to call on every incoming webhook — deduplicates automatically.
 *
 * @param {number} contactId
 * @param {string} accountId   Unipile account ID
 * @param {string} chatId      Unipile chat ID
 * @param {number} campaignId
 */
function enqueueContact(contactId, accountId, chatId, campaignId) {
  if (!contactId || !accountId || !chatId) return;

  // Reset debounce timer if already queued
  if (pending.has(contactId)) {
    clearTimeout(pending.get(contactId).timer);
  }

  const timer = setTimeout(() => {
    // Move from debounce-pending to ready-to-process
    const entry = pending.get(contactId);
    if (entry) {
      entry.ready = true;
      console.log(`[ConvQueue] Contact ${contactId} ready for analysis`);
    }
  }, DEBOUNCE_MS);

  pending.set(contactId, { timer, accountId, chatId, campaignId, ready: false });
  console.log(`[ConvQueue] Enqueued contact ${contactId} (debounce ${DEBOUNCE_MS / 60000} min)`);
}

async function processNext() {
  if (running >= MAX_WORKERS) return;

  // Find first ready entry
  let targetId = null;
  for (const [id, entry] of pending) {
    if (entry.ready) { targetId = id; break; }
  }
  if (targetId === null) return;

  const entry = pending.get(targetId);
  pending.delete(targetId);

  running++;
  try {
    console.log(`[ConvQueue] Analyzing contact ${targetId} (${running}/${MAX_WORKERS} workers)`);
    await analyzeConversation(targetId, entry.accountId, entry.chatId);
    console.log(`[ConvQueue] Done contact ${targetId}`);
  } catch (err) {
    console.error(`[ConvQueue] Analysis failed for contact ${targetId}: ${err.message}`);
  } finally {
    running--;
  }
}

function start() {
  console.log(`[ConvQueue] Starting — poll ${POLL_MS / 1000}s, max ${MAX_WORKERS} workers, debounce ${DEBOUNCE_MS / 60000} min`);
  pollTimer = setInterval(async () => {
    // Run up to MAX_WORKERS analyses per poll cycle
    for (let i = 0; i < MAX_WORKERS; i++) await processNext();
  }, POLL_MS);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const [, entry] of pending) clearTimeout(entry.timer);
  pending.clear();
}

function status() {
  const total  = pending.size;
  const ready  = [...pending.values()].filter(e => e.ready).length;
  const waiting = total - ready;
  return { total, ready, waiting, running, workers: MAX_WORKERS };
}

module.exports = { enqueueContact, start, stop, status };
