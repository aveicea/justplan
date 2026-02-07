export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Notion-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Notion API만 허용
  if (!targetUrl.startsWith('https://api.notion.com/')) {
    return res.status(403).json({ error: 'Only Notion API requests are allowed' });
  }

  try {
    const headers = {};
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['notion-version']) headers['Notion-Version'] = req.headers['notion-version'];
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const fetchOptions = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
