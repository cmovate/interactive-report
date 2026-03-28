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

async function sendInvitation(accountId, linkedinUrl, message = '') {
  const match      = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : linkedinUrl;
  const body       = { account_id: accountId, provider_id: identifier };
  if (message) body.message = message;
  return request('/api/v1/users/invite', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Withdraw (cancel) a pending LinkedIn connection request.
 */
async function withdrawInvitation(accountId, linkedinUrl) {
  const match      = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : linkedinUrl;
  return request(
    `/api/v1/users/invite?account_id=${encodeURIComponent(accountId)}&provider_id=${encodeURIComponent(identifier)}`,
    { method: 'DELETE' }
  );
}

/**
 * Get all 1-to-1 chats between our account and a specific attendee.
 * Uses the attendee's LinkedIn provider_id (ACoXXX format).
 * Returns an array of chat objects, or empty array if no chats exist.
 *
 * @param {string} accountId   - Unipile account ID
 * @param {string} providerId  - LinkedIn provider_id of the contact (ACoXXX)
 */
async function getChatsByAttendee(accountId, providerId) {
  const params = new URLSearchParams({ account_id: accountId });
  const data = await request(
    `/api/v1/attendees/${encodeURIComponent(providerId)}/chats?${params}`
  );
  return Array.isArray(data?.items) ? data.items : [];
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
  withdrawInvitation,
  getChatsByAttendee,
  sendCompanyFollowInvites,
};
