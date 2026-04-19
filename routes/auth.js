/* ═══════════════════════════════════════════
   Auth Routes — Register, Login, Profile
   ═══════════════════════════════════════════ */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');

function createAuthRouter(db) {
  const router = express.Router();

  // ── Register ──
  router.post('/register', async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email and password are required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // Check if email exists
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const freeCredits = parseInt(process.env.FREE_CREDITS || '10', 10);

      const result = db.prepare(
        'INSERT INTO users (name, email, password_hash, credits) VALUES (?, ?, ?, ?)'
      ).run(name.trim(), email.toLowerCase().trim(), passwordHash, freeCredits);

      const token = jwt.sign({ userId: result.lastInsertRowid }, process.env.JWT_SECRET, { expiresIn: '30d' });

      res.status(201).json({
        token,
        user: {
          id: result.lastInsertRowid,
          name: name.trim(),
          email: email.toLowerCase().trim(),
          credits: freeCredits,
          plan: 'free',
        },
      });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // ── Login ──
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

      res.json({
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          credits: user.credits,
          plan: user.plan,
        },
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ── Get Profile ──
  router.get('/me', authMiddleware, (req, res) => {
    try {
      const user = db.prepare('SELECT id, name, email, credits, plan, created_at FROM users WHERE id = ?').get(req.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user });
    } catch (err) {
      console.error('Profile error:', err);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
