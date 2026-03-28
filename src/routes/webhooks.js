/**
 * POST /api/webhooks/unipile
 *
 * Handles Unipile webhook events:
 *
 * new_relation  — someone accepted our LinkedIn connection request
 *   → Sets invite_approved = true, invite_approved_at = NOW()
 *   → For 'new' sequence: sets msg_sequence_started_at
 *
 * new_message   — an incoming LinkedIn message was received
 *   → If the sender is a contact we messaged, marks msg_replied = true
 *   → Clears msg_sequence (stops the sequence entirely)
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'elvia-secret';

router.post('/unipile', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Invalid secret, rejecting request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('[Webhook] Received event:', payload?.event, '| account:', payload?.account_id);

  // Always respond 200 immediately so Unipile doesn't retry
  res.json({ received: true });

  try {
    if (payload?.event === 'new_relation') {
      await handleNewRelation(payload);
    } else if (payload?.event === 'new_message') {
      await handleNewMessage(payload);
    }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
  }
});

// ─── new_relation ──────────────────────────────────────────────────────────────

async function handleNewRelation(payload) {
  const { account_id, user_public_identifier, user_profile_url, user_full_name } = payload;

  if (!account_id) {
    console.warn('[Webhook] new_relation missing account_id');
    return;
  }

  const identifier = user_public_identifier ||
    (user_profile_url ? user_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] : null);

  if (!identifier) {
    console.warn('[Webhook] new_relation: could not extract LinkedIn identifier');
    return;
  }

  const { rows: contacts } = await db.query(
    `SELECT c.id, c.campaign_id, c.first_name, c.last_name, c.msg_sequence
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE camp.account_id = $1
       AND c.invite_sent = true
       AND c.invite_approved = false
       AND c.li_profile_url ILIKE $2`,
    [account_id, `%/${identifier}%`]
  );

  if (!contacts.length) {
    console.log(`[Webhook] new_relation: no matching contact for "${identifier}" (account "${account_id}")`);
    return;
  }

  console.log(`[Webhook] new_relation: ${contacts.length} contact(s) for "${user_full_name}" (${identifier})`);

  for (const contact of contacts) {
    await db.query(
      `UPDATE contacts SET
         invite_approved          = true,
         invite_approved_at       = NOW(),
         msg_sequence_started_at  = CASE
           WHEN msg_sequence = 'new' AND msg_sequence_started_at IS NULL THEN NOW()
           ELSE msg_sequence_started_at
         END
       WHERE id = $1`,
      [contact.id]
    );
    console.log(`[Webhook] Marked contact ${contact.id} (${contact.first_name} ${contact.last_name}) as approved`);
  }
}

// ─── new_message (reply detection) ────────────────────────────────────────────

async function handleNewMessage(payload) {
  const { account_id, chat_id, sender_id, is_sender } = payload;

  // Only process incoming messages (not messages we sent)
  // is_sender = true means WE sent it — ignore those
  if (is_sender === true || is_sender === 'true') return;

  if (!account_id || !sender_id) {
    console.warn('[Webhook] new_message: missing account_id or sender_id');
    return;
  }

  // Find contacts where:
  // - They belong to a campaign with this account_id
  // - They have been messaged (msg_sent = true)
  // - They haven't already replied
  // - Their provider_id matches the sender, OR their chat_id matches
  const { rows: contacts } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.msg_sequence, c.msg_step
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE camp.account_id = $1
       AND c.msg_sent = true
       AND c.msg_replied = false
       AND (c.provider_id = $2 OR c.chat_id = $3)`,
    [account_id, sender_id, chat_id || '']
  );

  if (!contacts.length) {
    console.log(`[Webhook] new_message: no matching contact for sender ${sender_id}`);
    return;
  }

  for (const contact of contacts) {
    await db.query(
      `UPDATE contacts SET
         msg_replied    = true,
         msg_replied_at = NOW(),
         msg_sequence   = NULL
       WHERE id = $1`,
      [contact.id]
    );
    console.log(
      `[Webhook] Reply detected — contact ${contact.id} (${contact.first_name} ${contact.last_name})` +
      ` — sequence stopped (was: ${contact.msg_sequence}, step: ${contact.msg_step})`
    );
  }
}

module.exports = router;
