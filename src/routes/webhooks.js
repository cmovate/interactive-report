/**
 * POST /api/webhooks/unipile
 *
 * Handles Unipile webhook events.
 * Currently: new_relation — someone accepted our LinkedIn connection request.
 *
 * On new_relation:
 *   - Sets invite_approved = true
 *   - Sets invite_approved_at = NOW()  ← enables historical tracking
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
    }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
  }
});

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

  // Find all matching contacts for this account
  const { rows: contacts } = await db.query(
    `SELECT c.id, c.campaign_id, c.first_name, c.last_name
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
    // Set both the flag and the timestamp for historical tracking
    await db.query(
      'UPDATE contacts SET invite_approved = true, invite_approved_at = NOW() WHERE id = $1',
      [contact.id]
    );
    console.log(`[Webhook] Marked contact ${contact.id} (${contact.first_name} ${contact.last_name}) as approved`);
  }
}

module.exports = router;
