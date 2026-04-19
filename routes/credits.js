/* ═══════════════════════════════════════════
   Credits / Payments Route — Razorpay Integration
   ═══════════════════════════════════════════ */

const express = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../middleware/auth');

const CREDIT_PACKAGES = {
  100: { priceINR: 399, priceUSD: 4.99, label: '100 Credits' },
  500: { priceINR: 1599, priceUSD: 19.99, label: '500 Credits' },
  1000: { priceINR: 2799, priceUSD: 34.99, label: '1000 Credits' },
};

function createCreditsRouter(db) {
  const router = express.Router();

  // ── Get Balance ──
  router.get('/balance', authMiddleware, (req, res) => {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ credits: user.credits });
  });

  // ── Create Razorpay Order ──
  router.post('/create-checkout', authMiddleware, async (req, res) => {
    try {
      const { credits } = req.body;
      const pkg = CREDIT_PACKAGES[credits];
      if (!pkg) {
        return res.status(400).json({ error: 'Invalid credit package' });
      }

      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return res.status(503).json({ 
          error: 'Payment system is being set up. Please try again later.' 
        });
      }

      const Razorpay = require('razorpay');
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });

      const order = await razorpay.orders.create({
        amount: pkg.priceINR * 100, // Razorpay expects paise
        currency: 'INR',
        receipt: `np_${req.userId}_${Date.now()}`,
        notes: {
          userId: req.userId.toString(),
          credits: credits.toString(),
          package: pkg.label,
        },
      });

      // Record pending transaction
      db.prepare(
        'INSERT INTO transactions (user_id, type, credits, amount_usd, stripe_session_id, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.userId, 'purchase', credits, pkg.priceUSD, order.id, 'pending');

      // Return order details + payment page URL
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3847}`;
      res.json({ 
        checkoutUrl: `${baseUrl}/pay?orderId=${order.id}&credits=${credits}&userId=${req.userId}`,
        orderId: order.id,
        amount: pkg.priceINR,
        currency: 'INR',
      });
    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
    }
  });

  // ── Verify Payment (called after Razorpay checkout completes) ──
  router.post('/verify-payment', async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Missing payment verification data' });
      }

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        console.error('[PAYMENT] Signature mismatch!');
        return res.status(400).json({ error: 'Payment verification failed' });
      }

      // Find the pending transaction by order ID
      const txn = db.prepare(
        "SELECT * FROM transactions WHERE stripe_session_id = ? AND status = 'pending'"
      ).get(razorpay_order_id);

      if (!txn) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      // Add credits to user
      db.prepare('UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(txn.credits, txn.user_id);

      // Mark transaction as completed
      db.prepare('UPDATE transactions SET status = ? WHERE stripe_session_id = ?')
        .run('completed', razorpay_order_id);

      const updatedUser = db.prepare('SELECT credits FROM users WHERE id = ?').get(txn.user_id);

      console.log(`[PAYMENT] ✅ ${txn.credits} credits added to user ${txn.user_id} (Order: ${razorpay_order_id})`);

      res.json({ 
        success: true, 
        credits: updatedUser.credits,
        message: `${txn.credits} credits added successfully!`
      });
    } catch (err) {
      console.error('Payment verification error:', err);
      res.status(500).json({ error: 'Payment verification failed' });
    }
  });

  // ── Razorpay Webhook (backup verification) ──
  router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) return res.status(200).json({ received: true });

      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');

      const receivedSignature = req.headers['x-razorpay-signature'];
      if (expectedSignature !== receivedSignature) {
        console.error('[WEBHOOK] Signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (event.event === 'payment.captured') {
        const payment = event.payload.payment.entity;
        const orderId = payment.order_id;

        const txn = db.prepare(
          "SELECT * FROM transactions WHERE stripe_session_id = ? AND status = 'pending'"
        ).get(orderId);

        if (txn) {
          db.prepare('UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(txn.credits, txn.user_id);
          db.prepare('UPDATE transactions SET status = ? WHERE stripe_session_id = ?')
            .run('completed', orderId);
          console.log(`[WEBHOOK] ✅ ${txn.credits} credits added to user ${txn.user_id}`);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  // ── Transaction History ──
  router.get('/history', authMiddleware, (req, res) => {
    const transactions = db.prepare(
      'SELECT type, credits, amount_usd, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.userId);
    res.json({ transactions });
  });

  return router;
}

module.exports = { createCreditsRouter };
