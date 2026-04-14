const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'requests.json');
const PORT = process.env.PORT || 4100;

function readRequests() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeRequests(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIncomingRequest(payload) {
  return {
    ...payload,
    submittedDate: payload.submittedDate || nowIso(),
    paymentScreenshot: payload.paymentScreenshot || '',
    paymentScreenshotDataUrl: payload.paymentScreenshotDataUrl || '',
    history: [
      {
        action: 'Request submitted',
        at: nowIso(),
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  if (req.url === '/requests' && req.method === 'GET') {
    return json(res, 200, readRequests());
  }

  if (req.url === '/requests' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const requests = readRequests();
        const withHistory = normalizeIncomingRequest(payload);
        requests.unshift(withHistory);
        writeRequests(requests);
        json(res, 201, { ok: true, request: withHistory });
      } catch (error) {
        json(res, 400, { ok: false, error: 'Invalid JSON payload' });
      }
    });
    return;
  }

  const match = req.url && req.url.match(/^\/requests\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = match[1];
        const requests = readRequests();
        const index = requests.findIndex((item) => item.id === id);

        if (index === -1) {
          return json(res, 404, { ok: false, error: 'Request not found' });
        }

        const current = requests[index];
        const updated = {
          ...current,
          ...payload,
          history: [
            ...(current.history || []),
            {
              action: payload.historyAction || `Status changed to ${payload.requestStatus ?? current.requestStatus}`,
              at: nowIso(),
            },
          ],
        };

        delete updated.historyAction;
        requests[index] = updated;
        writeRequests(requests);
        json(res, 200, { ok: true, request: updated });
      } catch (error) {
        json(res, 400, { ok: false, error: 'Invalid JSON payload' });
      }
    });
    return;
  }

  json(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Request backend listening on port ${PORT}`);
});
