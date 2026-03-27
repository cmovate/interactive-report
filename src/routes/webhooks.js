/**
 * POST /api/webhooks/unipile
 *
 * Receives events from Unipile webhooks.
 * Currently handles:
 *   - new_relation: someone accepted our LinkedIn connection request
 *
 * Unipile payload for new_relation:
 * {
 *   event: "new_relation",
 *   account_id: "...",          <- the Unipile account that sent the invite
 *   account_type: "LINKEDIN",
 *   user_full_name: "...",
 *   user_provider_id: "...",
 *   user_public_identifier: "johndoe",  <- LinkedIn public_identifier
 *   user_profile_url: "https://www.linkedin.com/in/johndoe/",
 *   user_picture_url: "..."
 * }
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Optional webhook secret validation
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'elvia-secret';

router.post('/unipile', async (req, res) => {
  // Validate secret header (Unipile sends it as a custom header we configured)
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Invalid secret, rejecting request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = req.body;
  console.log('[Webhook] Received event:', payload?.event, '| account:', payload?.account_id);

  // Always respond 200 immediately so Unipile doesn't retry
  res.json({ received: true });

  // Process async after responding
  try {
    if (payload?.event === 'new_relation') {
      await handleNewRelation(payload);
    }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
  }
});

async function handleNewRelation(payload) {
  const {
    account_id,
    user_public_identifier,
    user_profile_url,
    user_full_name,
  } = payload;

  if (!account_id) {
    console.warn('[Webhook] new_relation missing account_id');
    return;
  }

  // Build possible URL variants to match against stored li_profile_url
  // Unipile may send: "https://www.linkedin.com/in/johndoe/"
  // We may have stored: "https://www.linkedin.com/in/johndoe" (no trailing slash)
  const identifier = user_public_identifier ||
    (user_profile_url ? user_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] : null);

  if (!identifier) {
    console.warn('[Webhook] new_relation: could not extract LinkedIn identifier from payload');
    return;
  }

  // Find all matching contacts for this account where invite_sent = true
  // Match by public_identifier embedded in li_profile_url
  const { rows: contacts } = await db.query(
    `SELECT c.id, c.campaign_id, c.workspace_id, c.first_name, c.last_name
     FROM contacts c
     INNER JOIN campaigns camp ON camp.id = c.campaign_id
     WHERE camp.account_id = $1
       AND c.invite_sent = true
       AND c.invite_approved = false
       AND c.li_profile_url ILIKE $2`,
    [account_id, `%/${identifier}%`]
  );

  if (!contacts.length) {
    console.log(`[Webhook] new_relation: no matching contact found for identifier="${identifier}" account="${account_id}"`);
    return;
  }

  console.log(`[Webhook] new_relation: found ${contacts.length} contact(s) for "${user_full_name}" (${identifier})`);

  for (const contact of contacts) {
    // Mark invite_approved = true
    await db.query(
      'UPDATE contacts SET invite_approved = true WHERE id = $1',
      [contact.id]
    );
    console.log(`[Webhook] Marked contact ${contact.id} (${contact.first_name} ${contact.last_name}) as invite_approved in campaign ${contact.campaign_id}`);
  }
}

module.exports = router;
