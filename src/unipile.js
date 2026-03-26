const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;
const UNIPILE_ACCOUNT_ID = process.env.UNIPILE_ACCOUNT_ID;

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
// Uses POST /api/v1/linkedin/search?account_id=
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

// Get full LinkedIn profile for enrichment
async function getFullProfile(accountId, linkedinUrl) {
  const identifier = linkedinUrl.split('/in/')[1]?.replace(/\//g, '') || linkedinUrl;
  const data = await request(
    `/api/v1/linkedin/profile?account_id=${encodeURIComponent(accountId)}&identifier=${encodeURIComponent(identifier)}`
  );
  return data;
}

module.exports = { getAccounts, searchPeople, getFullProfile };
