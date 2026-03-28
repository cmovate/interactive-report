/**
 * conversationAnalyzer.js
 *
 * Analyzes a full LinkedIn conversation thread and produces:
 *   - stage       : no_reply | cold_reply | engaged | meeting_intent | meeting_booked | not_interested | ghost
 *   - score       : 1-10 probability of converting to a meeting
 *   - signals     : [{type: 'positive'|'negative', text: '...'}]
 *   - suggested_action : what the sender should do next
 *   - exchange_depth   : total number of messages in the thread
 *   - prospect_msgs    : how many messages the prospect sent
 *   - summary     : one-sentence summary
 *
 * Everything is written in English regardless of conversation language.
 */

const db          = require('./db');
const { getChatMessages } = require('./unipile');

const UNIPILE_ACCOUNT_ID = process.env.DEFAULT_ACCOUNT_ID; // fallback
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const MODEL              = 'claude-sonnet-4-20250514';

/**
 * Build a compact, timestamped transcript from Unipile chat messages.
 * Format: "[Day N — YYYY-MM-DD] Sender: message text"
 */
function buildTranscript(messages, contactName) {
  if (!messages || !messages.length) return '(no messages)';

  const sorted = [...messages].sort((a, b) =>
    new Date(a.created_at || a.timestamp || 0) - new Date(b.created_at || b.timestamp || 0)
  );

  const first = new Date(sorted[0].created_at || sorted[0].timestamp || Date.now());

  return sorted.map(m => {
    const ts      = new Date(m.created_at || m.timestamp || Date.now());
    const dayN    = Math.floor((ts - first) / 86400000) + 1;
    const dateStr = ts.toISOString().slice(0, 10);
    const sender  = m.is_sender ? 'You' : (contactName || 'Prospect');
    const text    = (m.text || m.body || m.content || '').replace(/\n+/g, ' ').trim();
    return `[Day ${dayN} — ${dateStr}] ${sender}: ${text}`;
  }).join('\n');
}

/**
 * Call the Anthropic API and parse the JSON response.
 */
async function callClaude(transcript, contactName) {
  const systemPrompt = `You are an expert B2B sales analyst evaluating LinkedIn outreach conversations.
Always respond ONLY with valid JSON — no preamble, no markdown fences.
All text fields must be in English regardless of the conversation language.`;

  const userPrompt = `Analyze this LinkedIn outreach conversation with ${contactName || 'the prospect'}.

Full conversation transcript:
${transcript}

Respond with this exact JSON structure:
{
  "stage": "<one of: no_reply | cold_reply | engaged | meeting_intent | meeting_booked | not_interested | ghost>",
  "score": <integer 1-10>,
  "signals": [
    { "type": "positive" | "negative", "text": "<specific signal observed>" }
  ],
  "suggested_action": "<concrete next step the sender should take>",
  "exchange_depth": <total number of messages in the thread>,
  "prospect_msgs": <number of messages sent by the prospect>,
  "summary": "<one sentence describing the conversation quality and status>"
}

Stage definitions:
- no_reply: prospect has not responded at all
- cold_reply: replied politely but showed no real interest (e.g. "thanks, not now")
- engaged: showing genuine interest, asking questions, sharing context
- meeting_intent: clear or implied desire to meet/talk
- meeting_booked: explicitly confirmed a meeting or call
- not_interested: clear rejection
- ghost: was previously engaged but has gone silent (2+ days no reply after engagement)

Score guide:
1-3: Very unlikely to convert (rejection, ghost, cold reply)
4-5: Uncertain / neutral
6-7: Moderate interest
8-9: High interest / meeting intent
10: Meeting already confirmed`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text}`);
  }

  const data = await res.json();
  const raw  = data.content?.[0]?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Main entry point.
 * Fetches the full chat thread, analyzes it, and writes results to the DB.
 *
 * @param {number} contactId
 * @param {string} accountId   Unipile account ID
 * @param {string} chatId      Unipile chat ID
 */
async function analyzeConversation(contactId, accountId, chatId) {
  // 1. Load contact name from DB
  const { rows: contactRows } = await db.query(
    'SELECT first_name, last_name FROM contacts WHERE id = $1',
    [contactId]
  );
  if (!contactRows.length) throw new Error(`Contact ${contactId} not found`);
  const contact = contactRows[0];
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');

  // 2. Fetch full chat history from Unipile
  let messages = [];
  try {
    messages = await getChatMessages(accountId, chatId);
  } catch (err) {
    console.warn(`[ConvAnalyzer] Could not fetch messages for chat ${chatId}: ${err.message}`);
  }

  // 3. Build transcript
  const transcript = buildTranscript(messages, name);

  // 4. Call Claude
  const result = await callClaude(transcript, name);

  // 5. Validate stage
  const VALID_STAGES = ['no_reply','cold_reply','engaged','meeting_intent','meeting_booked','not_interested','ghost'];
  const stage = VALID_STAGES.includes(result.stage) ? result.stage : 'cold_reply';
  const score = Math.min(10, Math.max(1, parseInt(result.score) || 5));

  // 6. Save to DB
  await db.query(`
    UPDATE contacts SET
      conversation_stage      = $1,
      conversation_score      = $2,
      conversation_signals    = $3,
      conversation_analyzed_at = NOW()
    WHERE id = $4
  `, [
    stage,
    score,
    JSON.stringify({
      signals:          result.signals          || [],
      suggested_action: result.suggested_action || '',
      exchange_depth:   result.exchange_depth   || messages.length,
      prospect_msgs:    result.prospect_msgs    || 0,
      summary:          result.summary          || '',
    }),
    contactId,
  ]);

  console.log(`[ConvAnalyzer] contact=${contactId} stage=${stage} score=${score} exchange_depth=${result.exchange_depth}`);
  return { contactId, stage, score };
}

module.exports = { analyzeConversation };
