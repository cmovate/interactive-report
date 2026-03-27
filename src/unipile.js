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
      'X-API-KEY':   UNIPILE_API_KEY,
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

// Returns all LinkedIn accounts connected to this Unipile DSN
async function getAccounts() {
  const data = await request('/api/v1/accounts');
  const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  return items.filter(acc => {
    const provider = String(acc?.provider || '').toLowerCase();
    return provider.includes('linkedin') || provider === '';
  });
}

// Search people inside a company by job titles
async function searchPeople(accountId, companyName, titles = []) {
  const keywords = titles.length
    ? `${titles.join(' OR ')} "${companyName}"`
    : `"${companyName}"`;
  const data = await request(
    `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ api: 'classic', category: 'people', keywords, limit: 10 }),
    }
  );
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Retrieve full LinkedIn profile.
 * CONFIRMED field mapping from live API:
 *   work_experience[0].position  => title
 *   work_experience[0].company   => company name (plain string)
 *   work_experience[0].company_id => use to build linkedin.com/company/{id}
 *   websites[0]                  => website
 */
async function enrichProfile(accountId, li_profile_url) {
  const match = li_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : li_profile_url;
  const params = new URLSearchParams({
    account_id: accountId,
    linkedin_sections: '*',
    notify: 'false',
  });
  const data = await request(`/api/v1/users/${encodeURIComponent(identifier)}?${params}`);
  return data;
}

/**
 * Create a "new_relation" webhook for a specific account.
 * Called automatically when an account is connected to a workspace.
 *
 * @param {string} accountId  - Unipile account_id
 * @param {string} serverUrl  - Public URL of this server (e.g. https://yourserver.com)
 * @returns {string} webhook_id
 */
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
        { key: 'Content-Type', value: 'application/json' },
        { key: 'X-Webhook-Secret', value: process.env.WEBHOOK_SECRET || 'elvia-secret' },
      ],
    }),
  });
  return data.webhook_id;
}

/**
 * Delete a webhook by ID.
 */
async function deleteWebhook(webhookId) {
  try {
    await request(`/api/v1/webhooks/${webhookId}`, { method: 'DELETE' });
  } catch (err) {
    console.warn(`[Unipile] Could not delete webhook ${webhookId}: ${err.message}`);
  }
}

/**
 * Send a LinkedIn connection request (invitation).
 */
async function sendInvitation(accountId, linkedinUrl, message = '') {
  const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : linkedinUrl;
  const body = { account_id: accountId, provider_id: identifier };
  if (message) body.message = message;
  const data = await request('/api/v1/users/invite', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}

module.exports = { getAccounts, searchPeople, enrichProfile, createRelationWebhook, deleteWebhook, sendInvitation };
