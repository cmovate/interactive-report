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

/** All LinkedIn accounts connected to Unipile */
async function getAccounts() {
  const data  = await request('/api/v1/accounts');
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  return items.filter(acc => {
    const p = String(acc?.provider || '').toLowerCase();
    return p.includes('linkedin') || p === '';
  });
}

/** Search people inside a company by job titles */
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

/**
 * Retrieve full LinkedIn profile.
 * When notify=true, LinkedIn notifies the profile owner that someone viewed their profile.
 * This is the mechanism used for the "View profile" engagement action.
 *
 * CONFIRMED field mapping:
 *   work_experience[0].position  => title
 *   work_experience[0].company   => company name (plain string)
 *   work_experience[0].company_id => linkedin.com/company/{id}
 *   websites[0]                  => website
 *   member_urn                   => urn:li:fsd_profile:XXX
 */
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

/**
 * View a LinkedIn profile — triggers a "profile view" notification to the contact.
 * Uses enrichProfile with notify=true.
 * Returns the profile data (can be used for enrichment too).
 */
async function viewProfile(accountId, identifier) {
  const params = new URLSearchParams({
    account_id:        accountId,
    linkedin_sections: 'profile', // minimal — we only need the view, not full data
    notify:            'true',
  });
  return request(`/api/v1/users/${encodeURIComponent(identifier)}?${params}`);
}

/** Create a "new_relation" webhook for a specific account */
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

/** Delete a Unipile webhook */
async function deleteWebhook(webhookId) {
  try {
    await request(`/api/v1/webhooks/${webhookId}`, { method: 'DELETE' });
  } catch (err) {
    console.warn(`[Unipile] Could not delete webhook ${webhookId}: ${err.message}`);
  }
}

/** Send a LinkedIn connection request */
async function sendInvitation(accountId, linkedinUrl, message = '') {
  const match      = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : linkedinUrl;
  const body       = { account_id: accountId, provider_id: identifier };
  if (message) body.message = message;
  return request('/api/v1/users/invite', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Invite connections to follow the company LinkedIn page.
 * @param {string}   accountId      - Unipile account
 * @param {string}   companyPageUrn - e.g. "urn:li:fsd_company:38114588"
 * @param {string[]} memberUrns     - "urn:li:fsd_profile:XXX" strings
 */
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
  createRelationWebhook,
  deleteWebhook,
  sendInvitation,
  sendCompanyFollowInvites,
};
