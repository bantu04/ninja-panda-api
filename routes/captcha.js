/* ═══════════════════════════════════════════
   Captcha Solver Route — Multi-Strategy
   Tier 1: Tesseract.js (local OCR, instant, free)
   Tier 2: Gemini AI (cloud, fast, rate-limited)
   Tier 3: 2Captcha (human/AI, reliable, paid)
   Deducts 1 credit per solve
   ═══════════════════════════════════════════ */

const express = require('express');
const { createWorker } = require('tesseract.js');
const { authMiddleware } = require('../middleware/auth');

// Lazy-loaded dependencies (only initialized if needed)
let GoogleGenerativeAI = null;

// Pre-initialize a Tesseract worker for speed (reused across requests)
let tesseractWorker = null;

async function getTesseractWorker() {
  if (!tesseractWorker) {
    console.log('[CAPTCHA] Initializing Tesseract OCR engine...');
    tesseractWorker = await createWorker('eng');
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: '7', // Single text line
    });
    console.log('[CAPTCHA] Tesseract ready!');
  }
  return tesseractWorker;
}

// Pre-warm Tesseract on server start
getTesseractWorker().catch(() => {});

function createCaptchaRouter(db) {
  const router = express.Router();

  router.post('/solve', authMiddleware, async (req, res) => {
    try {
      const { imageURI } = req.body;
      if (!imageURI) {
        return res.status(400).json({ error: 'imageURI is required' });
      }

      // Check credits
      const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.userId);
      if (!user || user.credits < 1) {
        return res.status(402).json({ error: 'Insufficient credits. Please upgrade.' });
      }

      // Normalize the URI
      const commaIndex = imageURI.indexOf(',');
      let cleanURI = imageURI;
      if (commaIndex !== -1) {
        const prefix = imageURI.substring(0, commaIndex).toLowerCase();
        const data = imageURI.substring(commaIndex);
        cleanURI = prefix + data;
      }

      if (cleanURI.includes('svg')) {
        return res.status(400).json({ 
          error: "SVG images are not supported. Please reload the visa page." 
        });
      }

      const base64Data = cleanURI.split(',')[1];
      const mimeType = cleanURI.split(';')[0].split(':')[1] || 'image/jpeg';

      console.log(`[CAPTCHA] Image received (${mimeType}, ${Math.round(base64Data.length / 1024)}KB)`);

      let captchaText = null;
      let solvedBy = null;

      // ══════════════════════════════════════
      // TIER 1: Tesseract.js (local, instant)
      // ══════════════════════════════════════
      try {
        const startTime = Date.now();
        const worker = await getTesseractWorker();
        
        // Convert base64 to buffer for Tesseract
        const imageBuffer = Buffer.from(base64Data, 'base64');
        const { data } = await worker.recognize(imageBuffer);
        
        let ocrText = data.text.trim().replace(/[\s`#"']/g, '');
        const elapsed = Date.now() - startTime;
        
        console.log(`[CAPTCHA] Tesseract result (${elapsed}ms): "${ocrText}" (confidence: ${data.confidence}%)`);

        // Accept if it looks like a valid captcha (3-8 alphanumeric chars, confidence > 40%)
        if (ocrText.length >= 3 && ocrText.length <= 10 && data.confidence > 40) {
          captchaText = ocrText;
          solvedBy = `tesseract (${elapsed}ms, ${Math.round(data.confidence)}% conf)`;
        } else {
          console.log(`[CAPTCHA] Tesseract result rejected. Falling back to Gemini...`);
        }
      } catch (tessErr) {
        console.log(`[CAPTCHA] Tesseract error: ${tessErr.message}. Falling back to Gemini...`);
      }

      // ══════════════════════════════════════
      // TIER 2: Gemini AI (cloud fallback)
      // ══════════════════════════════════════
      if (!captchaText && process.env.GEMINI_API_KEY) {
        try {
          if (!GoogleGenerativeAI) {
            GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
          }
          const startTime = Date.now();
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

          const result = await model.generateContent([
            'Look at this image. It contains a short string of distorted letters and numbers (usually 4-8 characters). Output ONLY those characters. No other text whatsoever. Example output: xK7m2p',
            { inlineData: { data: base64Data, mimeType: mimeType } }
          ]);
          const response = await result.response;
          let geminiText = response.text().trim().replace(/[`#"'\s]/g, '');
          const elapsed = Date.now() - startTime;

          console.log(`[CAPTCHA] Gemini result (${elapsed}ms): "${geminiText}"`);

          // Validate — reject garbage responses
          const lower = geminiText.toLowerCase();
          const isGarbage = (
            geminiText.length > 12 || geminiText.length === 0 ||
            lower.includes('sorry') || lower.includes('image') ||
            lower.includes('text') || lower.includes('found') ||
            lower.includes('character') || lower.includes('cannot') ||
            lower.includes('unable') || lower.includes('no')
          );

          if (!isGarbage) {
            captchaText = geminiText;
            solvedBy = `gemini (${elapsed}ms)`;
          } else {
            console.log(`[CAPTCHA] Gemini response rejected as garbage.`);
          }
        } catch (geminiErr) {
          console.log(`[CAPTCHA] Gemini error: ${geminiErr.message}`);
        }
      }

      // ══════════════════════════════════════
      // FINAL CHECK
      // ══════════════════════════════════════
      if (!captchaText) {
        return res.status(500).json({ 
          error: 'All solvers failed. The captcha image may be blank or unreadable. Please try again.' 
        });
      }

      console.log(`[CAPTCHA] ✅ SOLVED by ${solvedBy}: "${captchaText}"`);

      // Deduct 1 credit
      db.prepare('UPDATE users SET credits = credits - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.userId);

      // Log usage
      db.prepare(
        'INSERT INTO usage_logs (user_id, action, credits_used, metadata) VALUES (?, ?, ?, ?)'
      ).run(req.userId, 'captcha_solve', 1, JSON.stringify({ 
        text_length: captchaText.length,
        solved_by: solvedBy 
      }));

      const updatedUser = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.userId);

      res.json({
        text: captchaText,
        creditsRemaining: updatedUser.credits,
      });
    } catch (err) {
      console.error('Captcha solve error:', err);
      res.status(500).json({ error: 'Captcha solving failed: ' + err.message });
    }
  });

  return router;
}

module.exports = { createCaptchaRouter };
