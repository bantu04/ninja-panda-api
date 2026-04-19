/* ═══════════════════════════════════════════
   Ninja Panda — US Visa Info API Server
   ═══════════════════════════════════════════ */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { initDB } = require('./db/setup');
const { createAuthRouter } = require('./routes/auth');
const { createCaptchaRouter } = require('./routes/captcha');
const { createCreditsRouter } = require('./routes/credits');

const app = express();
const PORT = process.env.PORT || 3847;

// ── Database ──
const db = initDB();
console.log('✅ Database initialized');

// ── Middleware ──
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for landing page
}));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://ninjapanda.com', 'chrome-extension://*']
    : true,
  methods: ['GET', 'POST'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(limiter);

// Stricter captcha rate limit (prevent abuse)
const captchaLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,               // 10 captcha solves per minute max
  message: { error: 'Captcha rate limit reached. Wait a moment.' },
});

// Body parsing (webhook route needs raw body, so set it up separately)
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' })); // 5mb for base64 captcha images

// ── Static Landing Page ──
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──
app.use('/api/auth', createAuthRouter(db));
app.use('/api/captcha', captchaLimiter, createCaptchaRouter(db));
app.use('/api/payments', createCreditsRouter(db));

// ── Razorpay public key (safe to expose) ──
app.get('/api/payments/razorpay-key', (req, res) => {
  res.json({ key: process.env.RAZORPAY_KEY_ID || '' });
});

// ── Payment Page ──
app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Ninja Panda API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Admin: Quick Stats (protected, dev only) ──
app.get('/api/admin/stats', (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const totalCreditsUsed = db.prepare('SELECT SUM(credits_used) as total FROM usage_logs').get();
  const totalRevenue = db.prepare("SELECT SUM(amount_usd) as total FROM transactions WHERE status = 'completed'").get();

  res.json({
    users: userCount.count,
    creditsUsed: totalCreditsUsed.total || 0,
    revenue: totalRevenue.total || 0,
  });
});

// ── Error Handler ──
app.use((err, req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Catch-all: Serve landing page for non-API routes ──
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n🐼 Ninja Panda — US Visa Info API`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Health: http://localhost:${PORT}/api/health`);
  console.log(`  → Mode: ${process.env.NODE_ENV || 'development'}\n`);
});
