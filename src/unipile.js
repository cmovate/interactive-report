const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_API_KEY = process.env.UNIPILE_API_KEY;

async function request(endpoint, options = {}) {
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
    throw new Error(`Unipile API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getAccounts() {
  return request('/api/v1/accounts');
}

async function searchPeople(companyUrl, titles = []) {
  const params = new URLSearchParams();
  if (companyUrl) params.set('company_url', companyUrl);
  if (titles.length) params.set('titles', titles.join(','));
  return request(`/api/v1/linkedin/search/people?${params}`);
}

async function getFullProfile(linkedinUrl) {
  const params = new URLSearchParams({ linkedin_url: linkedinUrl });
  return request(`/api/v1/linkedin/profile?${params}`);
}

module.exports = { getAccounts, searchPeople, getFullProfile };
