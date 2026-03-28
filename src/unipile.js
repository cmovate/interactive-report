const UNIPILE_DSN     = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;

async function request(endpoint, options = {}) {
  if (!UNIPILE_DSN || !UNIPILE_API_KEY) {
    throw new Error('UNIPILE_DSN and UNIPILE_API_KEY must be set in .env');
  }
  const url = `${UNIPILE_DSN}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-API-KEY':    UNIPILE_API_KEY,
      'Content-Type': 'application/json',
      'accept':       'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unipile ${res.status}: ${text}`);
  }
  return res.json();
}

function resolveIdentifier(input) {
  if (!input) return null;
  if (!input.includes('linkedin.com')) return input;
  const match = input.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : input;
}

async function getAccounts() {
  const data  = await request('/api/v1/accounts');
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  return items.filter(acc => {
    const p = String(acc?.provider || '').toLowerCase();
    return p.includes('linkedin') || p === '';
  });
}

async function searchPeople(accountId, companyName, titles = []) {
  const keywords = titles.length
    ? `${titles.join(' OR ')} "${companyName}"`
    : `"${companyName}"`;
  const data = await request(
    `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`,
    { method: 'POST', body: JSON.stringify({ api: 'classic', category: 'people', keywords, limit: 10 }) }
  );
  return Array.isArray(data?.items) ? data.items : [];
}

async function enrichProfile(accountId, li_profile_url, notify = false) {
  const match      = li_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : li_profile_url;
  const params     = new URLSearchParams({
    account_id:        accountId,
    linkedin_sections: '*',
    notify:            notify ? 'true' : 'false',
  });
  return request(`/api/v1/users/${encodeURIComponent(identifier)}?${params}`);
}

async function viewProfile(accountId, identifier) {
  const params = new URLSearchParams({
    account_id:        accountId,
    linkedin_sections: '*_preview',
    notify:            'true',
  });
  return request(`/api/v1/users/${encodeURIComponent(identifier)}?${params}`);
}

async function getUserPosts(accountId, providerId, limit = 50, isCompany = false) {
  const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
  if (isCompany) params.set('is_company', 'true');
  const data = await request(`/api/v1/users/${encodeURIComponent(providerId)}/posts?${params}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function getUserComments(accountId, providerId, limit = 50) {
  const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
  const data = await request(`/api/v1/users/${encodeURIComponent(providerId)}/comments?${params}`);
  return Array.isArray(data?.items) ? data.items : [];
}

async function likePost(accountId, postSocialId, commentId, asOrganization, reactionType = 'like') {
  const body = { account_id: accountId, post_id: postSocialId, reaction_type: reactionType };
  if (commentId)      body.comment_id      = commentId;
  if (asOrganization) body.as_organization = asOrganization;
  return request('/api/v1/posts/reaction', { method: 'POST', body: JSON.stringify(body) });
}

async function createRelationWebhook(accountId, serverUrl) {
  const data = await request('/api/v1/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      source:      'users',
      name:        `new_relation_${accountId}`,
      request_url: `${serverUrl}/api/webhooks/unipile`,
      account_ids: [accountId],
      events:      ['new_relation'],
      format:      'json',
      headers: [
        { key: 'Content-Type',     value: 'application/json' },
        { key: 'X-Webhook-Secret', value: process.env.WEBHOOK_SECRET || 'elvia-secret' },
      ],
    }),
  });
  return data.webhook_id;
}

async function deleteWebhook(webhookId) {
  try {
    await request(`/api/v1/webhooks/${webhookId}`, { method: 'DELETE' });
  } catch (err) {
    console.warn(`[Unipile] Could not delete webhook ${webhookId}: ${err.message}`);
  }
}

/**
 * Send a LinkedIn connection request.
 * @param {string} accountId   - Unipile account ID
 * @param {string} identifier  - provider_id (ACoXXX) OR LinkedIn profile URL
 * @param {string} [message]   - optional note (leave empty for no-note invite)
 */
async function sendInvitation(accountId, identifier, message = '') {
  const providerId = resolveIdentifier(identifier);
  const body = { account_id: accountId, provider_id: providerId };
  if (message) body.message = message;
  return request('/api/v1/users/invite', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * List pending sent invitations.
 * Returns items with id, provider_id, etc.
 */
async function listSentInvitations(accountId, limit = 100) {
  const params = new URLSearchParams({ account_id: accountId, limit: String(limit) });
  const data = await request(`/api/v1/users/invite/sent?${params}`);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Withdraw (cancel) a pending LinkedIn connection request.
 * Flow:
 *   1. List pending sent invitations
 *   2. Find the one matching the target's provider_id
 *   3. DELETE /api/v1/users/invite/sent/{invitation_id}
 *
 * @param {string} accountId   - Unipile account ID
 * @param {string} identifier  - provider_id (ACoXXX) OR LinkedIn profile URL
 */
async function withdrawInvitation(accountId, identifier) {
  const targetProviderId = resolveIdentifier(identifier);

  const invitations = await listSentInvitations(accountId);

  // Try to match by any provider_id field name
  const inv = invitations.find(i =>
    i.provider_id === targetProviderId ||
    i.invitee_id  === targetProviderId ||
    i.attendee_provider_id === targetProviderId
  );

  if (!inv) {
    console.warn(`[Unipile] withdrawInvitation: no pending invite for ${targetProviderId}. Items: ${JSON.stringify(invitations.slice(0, 3))}`);
    throw new Error(`No pending invitation found for: ${targetProviderId}`);
  }

  const invitationId = inv.id || inv.invitation_id;
  return request(
    `/api/v1/users/invite/sent/${encodeURIComponent(invitationId)}?account_id=${encodeURIComponent(accountId)}`,
    { method: 'DELETE' }
  );
}

async function sendCompanyFollowInvites(accountId, companyPageUrn, memberUrns) {
  if (!memberUrns.length) return;
  const companyIdMatch = companyPageUrn.match(/(\d+)$/);
  if (!companyIdMatch) throw new Error(`Invalid companyPageUrn: ${companyPageUrn}`);
  const companyId = companyIdMatch[1];
  const elements = memberUrns.map(urn => ({
    inviteeMember:         urn,
    genericInvitationType: 'ORGANIZATION',
  }));
  return request('/api/v1/linkedin', {
    method: 'POST',
    body: JSON.stringify({
      account_id:  accountId,
      request_url: 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashInvitations',
      method:      'POST',
      body:        { elements },
      query_params: {
        inviter: `(organizationUrn:urn%3Ali%3Afsd_company%3A${companyId})`,
      },
      headers: { 'x-restli-method': 'batch_create' },
      encoding: false,
    }),
  });
}

module.exports = {
  getAccounts,
  searchPeople,
  enrichProfile,
  viewProfile,
  getUserPosts,
  getUserComments,
  likePost,
  createRelationWebhook,
  deleteWebhook,
  sendInvitation,
  listSentInvitations,
  withdrawInvitation,
  sendCompanyFollowInvites,
};
