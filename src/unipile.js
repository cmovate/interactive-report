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
      'X-API-KEY': UNIPILE_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json',
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
      body: JSON.stringify({
        api: 'classic',
        category: 'people',
        keywords,
        limit: 10,
      }),
    }
  );
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Retrieve full LinkedIn profile using GET /api/v1/users/{identifier}
 * with linkedin_sections=* to fetch ALL sections.
 *
 * identifier is extracted from li_profile_url:
 *   https://www.linkedin.com/in/johndoe  →  johndoe
 *
 * @param {string} accountId   - Unipile account_id to perform the request from
 * @param {string} li_profile_url - Full LinkedIn profile URL
 */
async function enrichProfile(accountId, li_profile_url) {
  // Extract public_identifier from URL
  // Handles: linkedin.com/in/johndoe, linkedin.com/in/johndoe/, /in/johndoe
  const match = li_profile_url.match(/linkedin\.com\/in\/([^/?#]+)/);
  const identifier = match ? match[1] : li_profile_url;

  const params = new URLSearchParams({
    account_id: accountId,
    linkedin_sections: '*',   // all sections, full data
    notify: 'false',          // do NOT notify the profile owner of a visit
  });

  const data = await request(`/api/v1/users/${encodeURIComponent(identifier)}?${params}`);
  return data;
}

module.exports = { getAccounts, searchPeople, enrichProfile };
