const http = require('http');
const https = require('https');
const { URL } = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 4100;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'vimal-global-pc';
const MONGODB_COLLECTION_NAME = process.env.MONGODB_COLLECTION_NAME || 'requests';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const EMAIL_WEBHOOK_URL = process.env.EMAIL_WEBHOOK_URL;

let mongoClient;
let requestsCollection;

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

function sanitizeRequest(request) {
  if (!request) return request;
  const { _id, ...rest } = request;
  return rest;
}

async function connectToMongo() {
  if (!MONGODB_URI) {
    throw new Error('Missing MONGODB_URI environment variable');
  }

  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();

  const db = mongoClient.db(MONGODB_DB_NAME);
  requestsCollection = db.collection(MONGODB_COLLECTION_NAME);
  await requestsCollection.createIndex({ id: 1 }, { unique: true });
}

async function readRequests() {
  const items = await requestsCollection.find({}).sort({ submittedDate: -1 }).toArray();
  return items.map(sanitizeRequest);
}

async function createRequest(payload) {
  const withHistory = normalizeIncomingRequest(payload);
  await requestsCollection.insertOne(withHistory);
  return withHistory;
}

async function updateRequest(id, payload) {
  const current = await requestsCollection.findOne({ id });
  if (!current) return null;

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

  delete updated._id;
  delete updated.historyAction;

  await requestsCollection.updateOne({ id }, { $set: updated });
  return sanitizeRequest(updated);
}

function truncate(value, maxLength = 240) {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function buildAlertMessage(request) {
  const services = Array.isArray(request.services) && request.services.length > 0
    ? request.services.join(', ')
    : 'Custom Request';

  return [
    '🚨 New Vimal Global PC request',
    `ID: ${request.id || 'N/A'}`,
    `Name: ${request.name || 'N/A'}`,
    `Phone: ${request.phone || 'N/A'}`,
    `Email: ${request.email || 'N/A'}`,
    `Contact App: ${request.contactApp || 'N/A'}`,
    `Country: ${request.country || 'N/A'}`,
    `Services: ${services}`,
    `Payment: ${request.paymentStatus || 'N/A'} via ${request.paymentMode || 'N/A'}`,
    `Status: ${request.requestStatus || 'Pending'}`,
    `Submitted: ${request.submittedDate || nowIso()}`,
    `Custom Request: ${truncate(request.customRequest || 'Will share details on chat.')}`,
  ].join('\n');
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const body = JSON.stringify(payload);

    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(new Error(`Webhook request failed with status ${res.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await postJson(telegramUrl, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
  });
}

async function sendEmailWebhookAlert(request) {
  if (!EMAIL_WEBHOOK_URL) return;

  await postJson(EMAIL_WEBHOOK_URL, {
    subject: `New request: ${request.name || request.id || 'Unknown'}`,
    text: buildAlertMessage(request),
    request,
  });
}

async function sendAlerts(request) {
  const message = buildAlertMessage(request);
  const tasks = [];

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    tasks.push(sendTelegramAlert(message));
  }

  if (EMAIL_WEBHOOK_URL) {
    tasks.push(sendEmailWebhookAlert(request));
  }

  if (tasks.length === 0) {
    console.log('No alert channel configured for new requests');
    console.log(message);
    return;
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('Alert delivery failed:', result.reason);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  if (req.url === '/health' && req.method === 'GET') {
    return json(res, 200, { ok: true });
  }

  if (req.url === '/requests' && req.method === 'GET') {
    readRequests()
      .then((requests) => json(res, 200, requests))
      .catch((error) => {
        console.error('Failed to read requests:', error);
        json(res, 500, { ok: false, error: 'Failed to read requests' });
      });
    return;
  }

  if (req.url === '/requests' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const created = await createRequest(payload);
        sendAlerts(created).catch((error) => {
          console.error('Failed to send new request alert:', error);
        });
        json(res, 201, { ok: true, request: created });
      } catch (error) {
        console.error('Failed to create request:', error);
        json(res, 400, { ok: false, error: 'Invalid request payload' });
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
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const id = match[1];
        const updated = await updateRequest(id, payload);

        if (!updated) {
          return json(res, 404, { ok: false, error: 'Request not found' });
        }

        json(res, 200, { ok: true, request: updated });
      } catch (error) {
        console.error('Failed to update request:', error);
        json(res, 400, { ok: false, error: 'Invalid request payload' });
      }
    });
    return;
  }

  json(res, 404, { ok: false, error: 'Not found' });
});

connectToMongo()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Request backend listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start request backend:', error);
    process.exit(1);
  });
