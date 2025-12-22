require('dotenv').config();
const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4008;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.set('trust proxy', true);
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && incomingId.trim()
      ? incomingId.trim()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  req.id = requestId;

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const logEntry = {
      time: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
      service: req.serviceName || null,
    };

    console.log(JSON.stringify(logEntry));
  });

  next();
});

app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN,
    credentials: true,
  }),
);

app.use((req, res, next) => {
  if (req.id) {
    res.setHeader('x-request-id', req.id);
  }
  res.setHeader('x-gateway', 'hhu_87');
  next();
});

app.use('/ui', express.static(path.join(__dirname, 'public')));

// Central authentication middleware (skips public endpoints)
const PUBLIC_PATHS = ['/', '/healthz', '/ui', '/favicon.ico', '/sw.js'];

app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) {
    return next();
  }

  const expectedKey = process.env.API_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      error: 'API gateway is not configured with API_KEY',
      requestId: req.id,
    });
  }

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;
  const apiKeyHeader = req.headers['x-api-key'];
  const providedKey = bearerToken || apiKeyHeader;

  if (providedKey !== expectedKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      requestId: req.id,
    });
  }

  next();
});

// Utility to resolve upstream service URL from environment
function getServiceTarget(serviceName) {
  if (!serviceName) {
    return { envKey: null, target: null };
  }

  const envKey = `SERVICE_${serviceName.toUpperCase()}_URL`;
  const target = process.env[envKey];

  return { envKey, target };
}

function applyServiceAuthHeaders(serviceName, proxyReq) {
  const name = (serviceName || '').toLowerCase();

  if (name === 'serper') {
    const apiKey = process.env.SERPER_API_KEY;
    proxyReq.removeHeader('authorization');
    proxyReq.removeHeader('x-api-key');
    if (apiKey) {
      proxyReq.setHeader('x-api-key', apiKey);
    }
    return;
  }

  if (name === 'ocrspace') {
    const apiKey = process.env.OCRSPACE_API_KEY;
    proxyReq.removeHeader('authorization');
    proxyReq.removeHeader('x-api-key');
    if (apiKey) {
      proxyReq.setHeader('apikey', apiKey);
    }
    return;
  }

  if (name === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    proxyReq.removeHeader('authorization');
    proxyReq.removeHeader('x-api-key');
    if (apiKey) {
      proxyReq.setHeader('authorization', `Bearer ${apiKey}`);
    }
    return;
  }

  if (name === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    proxyReq.removeHeader('authorization');
    proxyReq.removeHeader('x-api-key');
    if (apiKey) {
      proxyReq.setHeader('authorization', `Bearer ${apiKey}`);
    }
  }
}

// Root route: basic info about the gateway and configured services
app.get('/', (req, res) => {
  const services = Object.keys(process.env)
    .filter((key) => key.startsWith('SERVICE_') && key.endsWith('_URL'))
    .map((key) => ({
      name: key.slice('SERVICE_'.length, -'_URL'.length).toLowerCase(),
      url: process.env[key],
    }));

  res.json({
    message: 'hhu_87 API Gateway is running',
    port: PORT,
    services,
  });
});

// Health endpoint (public)
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Dynamic proxy route: /api/:serviceName/* -> SERVICE_<SERVICE_NAME>_URL
app.use('/api/:serviceName', (req, res, next) => {
  const { serviceName } = req.params;
  const { envKey, target } = getServiceTarget(serviceName);

  req.serviceName = serviceName;

  if (!target) {
    return res.status(502).json({
      error: 'Service not configured',
      service: serviceName,
      envKey,
      requestId: req.id,
    });
  }

  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: {
      [`^/api/${serviceName}`]: '',
    },
    onProxyReq(proxyReq, reqProxy, resProxy) {
      applyServiceAuthHeaders(serviceName, proxyReq);
    },
    onError(err, reqProxy, resProxy) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Proxy error',
          error: err.message,
          service: serviceName,
          target,
          requestId: reqProxy.id,
        }),
      );

      if (!resProxy.headersSent) {
        resProxy.writeHead(502, { 'Content-Type': 'application/json' });
      }

      resProxy.end(
        JSON.stringify({
          error: 'Upstream service error',
          service: serviceName,
          requestId: reqProxy.id,
        }),
      );
    },
  })(req, res, next);
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.originalUrl,
    method: req.method,
    requestId: req.id || null,
  });
});

app.use((err, req, res, next) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'Unhandled error',
      error: err && err.message,
      stack: err && err.stack,
      requestId: req && req.id ? req.id : null,
    }),
  );

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    error: 'Internal server error',
    requestId: req && req.id ? req.id : null,
  });
});

app.listen(PORT, () => {
  console.log(`hhu_87 API Gateway listening on port ${PORT}`);
});
