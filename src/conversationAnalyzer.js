/**
 * conversationAnalyzer.js
 *
 * Analyzes a LinkedIn conversation for a contact:
 *   1. Fetches the full chat from Unipile
 *   2. Separates prospect replies from our sent messages
 *   3. Saves per-reply data: text, length, timestamp (up to MAX_REPLY_SLOTS)
 *   4. Sends the full transcript to Claude API for scoring:
 *        - reply_scores[]: 1-10 per prospect message
 *        - overall_score:  1-10 for the whole conversation
 *        - stage:          engaged | cold_reply | meeting_intent |
 *                          meeting_booked | not_interested | ghost
 *   5. Writes everything to the contacts table
 */

const db = require('./db');

const UNIPILE_DSN     = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MAX_REPLY_SLOTS = 10; // columns reply_1..reply_10

// ── Fetch chat messages from Unipile ─────────────────────────────────────────

async function fetchChatMessages(accountId, chatId) {
  if (!chatId) return [];
  const url = `${UNIPILE_DSN}/api/v1/chats/${encodeURIComponent(chatId)}/messages` +
    `?account_id=${encodeURIComponent(accountId)}&limit=100`;
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': UNIPILE_API_KEY,
      'accept':    'application/json',
    },
  });
  if (!res.ok) throw new Error(`Unipile ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}

// ── Score the conversation with Claude ───────────────────────────────────────

async function scoreWithClaude(transcript, prospectMessageCount) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const systemPrompt = `You are an expert B2B sales analyst. You analyze LinkedIn outreach conversations.

You will receive a full conversation transcript and must return a JSON object.
The conversation may be in English or Hebrew — handle both.

Return ONLY valid JSON with these exact keys:
{
  "overall_score": <integer 1-10>,
  "stage": <one of: "no_reply"|"cold_reply"|"engaged"|"meeting_intent"|"meeting_booked"|"not_interested"|"ghost">,
  "reply_scores": [<integer 1-10 per prospect message, in order>],
  "signals": [<array of short English strings describing key signals>],
  "suggested_action": "<one sentence in English>"
}

Scoring guide for overall_score:
  1-2  = clear rejection or no engagement
  3-4  = polite but uninterested
  5-6  = mild interest, non-committal
  7-8  = genuine interest, asking questions or sharing context
  9-10 = strong buying signals or explicit meeting request

For reply_scores: score each prospect message individually (1-10) based on
how much engagement and buying intent it shows.

Do not include any text outside the JSON object.`;

  const userPrompt = `Conversation transcript:

${transcript}

Number of prospect messages to score: ${prospectMessageCount}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ── Main: analyze a contact's conversation ───────────────────────────────────

async function analyzeContact(contactId) {
  // Load contact
  const { rows } = await db.query(
    `SELECT c.id, c.chat_id, c.provider_id, c.first_name, c.last_name,
            camp.account_id
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE c.id = $1`,
    [contactId]
  );
  const contact = rows[0];
  if (!contact) { console.warn(`[Analyzer] Contact ${contactId} not found`); return; }
  if (!contact.chat_id) { console.log(`[Analyzer] Contact ${contactId} has no chat_id, skipping`); return; }

  console.log(`[Analyzer] Analyzing contact ${contactId} (${contact.first_name} ${contact.last_name})`);

  // Fetch messages
  const messages = await fetchChatMessages(contact.account_id, contact.chat_id);
  if (!messages.length) { console.log(`[Analyzer] No messages found for contact ${contactId}`); return; }

  // Sort chronologically
  messages.sort((a, b) => new Date(a.created_at || a.timestamp || 0) - new Date(b.created_at || b.timestamp || 0));

  // Separate prospect messages from ours
  // Unipile marks our messages with is_sender=true or sender_id matching account's provider_id
  const prospectMessages = messages.filter(m => !m.is_sender && m.text?.trim());
  const allMessages      = messages.filter(m => m.text?.trim());

  if (!prospectMessages.length) {
    console.log(`[Analyzer] No prospect messages for contact ${contactId}`);
    return;
  }

  // Build update object for per-reply columns
  const updateFields = {};
  updateFields.reply_count = prospectMessages.length;

  for (let i = 0; i < Math.min(prospectMessages.length, MAX_REPLY_SLOTS); i++) {
    const msg  = prospectMessages[i];
    const text = (msg.text || '').trim();
    const slot = i + 1;
    updateFields[`reply_${slot}_text`]   = text;
    updateFields[`reply_${slot}_length`] = text.length;
    updateFields[`reply_${slot}_at`]     = msg.created_at || msg.timestamp || null;
  }

  // Build transcript for Claude
  const transcript = allMessages.map(m => {
    const who  = m.is_sender ? 'Sender' : 'Prospect';
    const time = m.created_at ? new Date(m.created_at).toISOString().slice(0,16).replace('T',' ') : '';
    return `[${time}] ${who}: ${(m.text||'').trim()}`;
  }).join('\n');

  // Score with Claude
  let analysis = null;
  try {
    analysis = await scoreWithClaude(transcript, prospectMessages.length);
    console.log(`[Analyzer] Contact ${contactId} — score: ${analysis.overall_score} stage: ${analysis.stage}`);
  } catch (err) {
    console.error(`[Analyzer] Claude API error for contact ${contactId}:`, err.message);
    // Still save the raw reply data even if scoring fails
  }

  if (analysis) {
    updateFields.conversation_score   = analysis.overall_score || null;
    updateFields.conversation_stage   = analysis.stage || null;
    updateFields.conversation_signals = JSON.stringify({
      signals:          analysis.signals          || [],
      suggested_action: analysis.suggested_action || '',
      reply_scores:     analysis.reply_scores     || [],
    });

    // Write individual reply scores back
    const replyScores = analysis.reply_scores || [];
    for (let i = 0; i < Math.min(replyScores.length, MAX_REPLY_SLOTS); i++) {
      updateFields[`reply_${i+1}_score`] = replyScores[i] || null;
    }
  }

  updateFields.conversation_analyzed_at = new Date().toISOString();

  // Build parameterized UPDATE
  const keys    = Object.keys(updateFields);
  const setStr  = keys.map((k, i) => `${k} = $${i+2}`).join(', ');
  const values  = [contactId, ...keys.map(k => updateFields[k])];

  await db.query(`UPDATE contacts SET ${setStr} WHERE id = $1`, values);
  console.log(`[Analyzer] Saved analysis for contact ${contactId} (${keys.length} fields updated)`);
}

// Debounced analysis — waits 3 min after last trigger before running,
// so that bursts of incoming messages don't cause redundant API calls.
const debounceTimers = new Map();
const DEBOUNCE_MS = 3 * 60 * 1000;

function scheduleAnalysis(contactId) {
  if (debounceTimers.has(contactId)) clearTimeout(debounceTimers.get(contactId));
  const timer = setTimeout(async () => {
    debounceTimers.delete(contactId);
    try { await analyzeContact(contactId); }
    catch (err) { console.error(`[Analyzer] Unhandled error for contact ${contactId}:`, err.message); }
  }, DEBOUNCE_MS);
  debounceTimers.set(contactId, timer);
  console.log(`[Analyzer] Scheduled analysis for contact ${contactId} in ${DEBOUNCE_MS/60000} min`);
}

module.exports = { analyzeContact, scheduleAnalysis, MAX_REPLY_SLOTS };
