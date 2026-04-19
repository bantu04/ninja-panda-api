/* ═══════════════════════════════════════════
   Credits / Payments Route — Stripe Integration
   ═══════════════════════════════════════════ */

const express = require('express');
const { authMiddleware } = require('../middleware/auth');

const CREDIT_PACKAGES = {
  100: { price: 499, label: '100 Credits' },
  500: { price: 1999, label: '500 Credits' },
  1000: { price: 3499, label: '1000 Credits' },
};

function createCreditsRouter(db) {
  const router = express.Router();

  // ── Get Balance ──
  router.get('/balance', authMiddleware, (req, res) => {
    const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ credits: user.credits });
  });

  // ── Create Stripe Checkout Session ──
  router.post('/create-checkout', authMiddleware, async (req, res) => {
    try {
      const { credits } = req.body;
      const pkg = CREDIT_PACKAGES[credits];
      if (!pkg) {
        return res.status(400).json({ error: 'Invalid credit package' });
      }

      if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('your-stripe')) {
        // Stripe not configured — add credits directly for dev/testing
        db.prepare('UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(credits, req.userId);
        db.prepare(
          'INSERT INTO transactions (user_id, type, credits, amount_usd, status) VALUES (?, ?, ?, ?, ?)'
        ).run(req.userId, 'purchase', credits, pkg.price / 100, 'completed');

        const updated = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.userId);
        return res.json({
          message: `DEV MODE: ${credits} credits added directly`,
          credits: updated.credits,
        });
      }

      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.userId);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: `Assessra - ${pkg.label}` },
              unit_amount: pkg.price,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: process.env.STRIPE_SUCCESS_URL || 'https://assessra.com/success',
        cancel_url: process.env.STRIPE_CANCEL_URL || 'https://assessra.com/cancel',
        customer_email: user.email,
        metadata: { userId: req.userId.toString(), credits: credits.toString() },
      });

      // Record pending transaction
      db.prepare(
        'INSERT INTO transactions (user_id, type, credits, amount_usd, stripe_session_id, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.userId, 'purchase', credits, pkg.price / 100, session.id, 'pending');

      res.json({ checkoutUrl: session.url });
    } catch (err) {
      console.error('Checkout error:', err);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // ── Stripe Webhook ──
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('your-stripe')) {
      return res.status(200).json({ received: true });
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = parseInt(session.metadata.userId, 10);
      const credits = parseInt(session.metadata.credits, 10);

      if (userId && credits) {
        db.prepare('UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(credits, userId);
        db.prepare('UPDATE transactions SET status = ? WHERE stripe_session_id = ?')
          .run('completed', session.id);
        console.log(`Credits added: ${credits} for user ${userId}`);
      }
    }

    res.json({ received: true });
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
