/**
 * Magic Link Authentication — hardened
 *
 * Token layer:
 *   - 32-byte random tokens; only SHA-256 hash stored in DB
 *   - Atomic single-use enforcement (UPDATE … WHERE used_at IS NULL RETURNING *)
 *   - Soft context binding (ip_hash, user_agent logged; mismatches flagged not blocked)
 *   - Sibling token invalidation on successful use
 *
 * Session layer:
 *   - JWT in HTTP-only cookie, embeds sessionId
 *   - Server-side sessions table for rolling expiry + revocation
 *   - Session rotation on every login
 *   - Revoke single or all sessions (instant kill switch)
 *
 * Security logging:
 *   - security_events table: logins, failures, reuse attempts, revocations
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');

// Layer 5: External Effect Verifier — email boundary health events
const { emitProviderEvent, PROVIDER_EVENT_TYPES } = require('./backend/src/email/provider-events');

// Derive a stable secret if JWT_SECRET is not explicitly set
const JWT_SECRET = process.env.JWT_SECRET ||
  crypto.createHash('sha256')
    .update(process.env.POLSIA_API_KEY || 'REDACTED')
    .digest('hex');

const COOKIE_NAME = 'bo_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: SESSION_TTL_MS
};

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a secure 32-byte hex magic link token (raw — for emailing to user).
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a raw token for DB storage. Never store the raw token.
 * Uses SHA-256 — one-way, fast, collision-resistant for this use case.
 */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * SHA-256 hash of an IP or user-agent string for privacy-preserving logging.
 */
function hashContext(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

/**
 * Sign a session JWT containing userId, email, and sessionId.
 * sessionId links back to the sessions table for revocation checks.
 */
function signSession(userId, email, sessionId) {
  return jwt.sign({ userId, email, sessionId }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verify a session JWT. Returns payload or null.
 */
function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return null;
  }
}

// ── Server-side session management ───────────────────────────────────────────

/**
 * Create a new server-side session record.
 * Returns the sessionId to embed in the JWT.
 *
 * @param {Pool} pool
 * @param {number} userId
 * @param {string} email
 * @param {object} opts
 * @param {string} [opts.ipHash]     - hashed IP
 * @param {string} [opts.userAgent]  - raw UA string (stored truncated)
 */
async function createSession(pool, userId, email, opts = {}) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const ua = opts.userAgent ? String(opts.userAgent).slice(0, 512) : null;

  await pool.query(
    `INSERT INTO sessions (session_id, user_id, email, ip_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, userId, email, opts.ipHash || null, ua, expiresAt]
  );

  return sessionId;
}

/**
 * Look up an active (non-revoked, non-expired) session.
 * Returns the session row or null.
 */
async function getSession(pool, sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT * FROM sessions
     WHERE session_id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}

/**
 * Update last_seen_at and extend expiry (rolling window).
 * Only writes to DB if last_seen_at is > 10 minutes stale to avoid hot-path overhead.
 */
async function touchSession(pool, sessionId) {
  if (!sessionId) return;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  // Conditional update — skip if we recently touched it
  await pool.query(
    `UPDATE sessions
     SET last_seen_at = NOW(), expires_at = $2
     WHERE session_id = $1
       AND revoked_at IS NULL
       AND last_seen_at < $3`,
    [sessionId, expiresAt, tenMinAgo]
  );
}

/**
 * Revoke a single session. Immediate effect — JWT is still valid until its
 * natural expiry, but all middleware session checks will reject it.
 */
async function revokeSession(pool, sessionId) {
  if (!sessionId) return;
  await pool.query(
    `UPDATE sessions SET revoked_at = NOW() WHERE session_id = $1`,
    [sessionId]
  );
}

/**
 * Revoke ALL sessions for a user — instant kill switch.
 * Returns the count of sessions killed.
 */
async function revokeAllSessions(pool, userId) {
  const { rowCount } = await pool.query(
    `UPDATE sessions SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  return rowCount;
}

// ── Security event logging ─────────────────────────────────────────────────────

/**
 * Log a security event.
 *
 * @param {Pool} pool
 * @param {string} eventType  - e.g. 'login_success', 'token_invalid', 'token_reuse_attempt'
 * @param {object} data
 * @param {number}  [data.userId]
 * @param {string}  [data.email]
 * @param {string}  [data.ipHash]
 * @param {string}  [data.userAgent]
 * @param {string}  [data.sessionId]
 * @param {object}  [data.metadata]  - arbitrary JSONB bag
 */
async function logSecurityEvent(pool, eventType, data = {}) {
  try {
    await pool.query(
      `INSERT INTO security_events (event_type, user_id, email, ip_hash, user_agent, session_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventType,
        data.userId || null,
        data.email || null,
        data.ipHash || null,
        data.userAgent ? String(data.userAgent).slice(0, 512) : null,
        data.sessionId || null,
        data.metadata ? JSON.stringify(data.metadata) : null
      ]
    );
  } catch (err) {
    // Never let security logging failure break the auth flow
    console.error('[Auth] logSecurityEvent failed:', err.message);
  }
}

// ── API Token management ──────────────────────────────────────────────────────

/**
 * Parse an expires_in string (e.g. "30d", "7d") into a number of days.
 * Returns a value clamped between 1 and maxDays.
 */
function parseExpiresIn(value, defaultDays = 30, maxDays = 90) {
  if (!value) return defaultDays;
  const match = String(value).match(/^(\d+)(d|h|m)?$/);
  if (!match) return defaultDays;
  const n = parseInt(match[1], 10);
  const unit = match[2] || 'd';
  let days;
  if (unit === 'h') days = n / 24;
  else if (unit === 'm') days = n / (24 * 60);
  else days = n;
  return Math.min(Math.max(1, Math.round(days)), maxDays);
}

/**
 * Generate a raw API token string.
 * Format: `bo_live_<32 hex chars>` (production) or `bo_mock_<32 hex chars>` (mock mode).
 * The prefix makes tokens grep-able and source-distinguishable.
 */
function generateApiToken() {
  const isMock = process.env.MOCK_MODE === 'true';
  const prefix = isMock ? 'bo_mock_' : 'bo_live_';
  const random = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  return `${prefix}${random}`;
}

/**
 * Mint a new API token and store its SHA-256 hash in the api_tokens table.
 * The raw token is returned ONCE and never persisted.
 *
 * Enforces a max of 10 active tokens per user.
 *
 * @param {Pool}   pool
 * @param {number} userId
 * @param {object} opts
 * @param {string} [opts.label]      - optional human-readable label
 * @param {string} [opts.expires_in] - e.g. "30d", "7d" (default 30d, max 90d)
 * @returns {Promise<{ token: string, id: string, label: string|null, expires_at: Date, created_at: Date }>}
 */
async function createApiToken(pool, userId, opts = {}) {
  const { label, expires_in } = opts;
  const expiryDays = parseExpiresIn(expires_in);
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  // Enforce max 10 active tokens per user
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [userId]
  );
  if (parseInt(countRows[0].count, 10) >= 10) {
    const err = new Error('Maximum 10 active tokens allowed per user. Revoke an existing token first.');
    err.code = 'TOKEN_LIMIT_EXCEEDED';
    throw err;
  }

  const rawToken = generateApiToken();
  const tokenHash = hashToken(rawToken);
  const safeLabel = label ? String(label).slice(0, 255) : null;

  const { rows } = await pool.query(
    `INSERT INTO api_tokens (user_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, expires_at, created_at`,
    [userId, tokenHash, safeLabel, expiresAt]
  );

  return { token: rawToken, ...rows[0] };
}

/**
 * Validate a raw `bo_*` API token.
 * Hashes the raw value, looks it up, checks expiry and revocation.
 * Updates last_used_at on successful validation (fire-and-forget).
 *
 * Returns { id, userId } on success, or null on failure.
 *
 * @param {Pool}   pool
 * @param {string} rawToken
 * @returns {Promise<{ id: string, userId: number }|null>}
 */
async function validateApiToken(pool, rawToken) {
  if (!rawToken || !rawToken.startsWith('bo_')) return null;
  const tokenHash = hashToken(rawToken);

  const { rows } = await pool.query(
    `SELECT id, user_id, expires_at, revoked_at
     FROM api_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );

  if (!rows.length) return null;
  const row = rows[0];

  if (row.revoked_at) return null;
  if (new Date(row.expires_at) <= new Date()) return null;

  // Update last_used_at async — don't block the request
  pool.query(
    'UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1',
    [row.id]
  ).catch(err => console.error('[Auth] Failed to update api_token last_used_at:', err.message));

  return { id: row.id, userId: row.user_id };
}

/**
 * List active (non-revoked, non-expired) API tokens for a user.
 * Never returns the raw token — only metadata.
 *
 * @param {Pool}   pool
 * @param {number} userId
 * @returns {Promise<Array>}
 */
async function listApiTokens(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, label, created_at, last_used_at, expires_at
     FROM api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Revoke an API token by id, scoped to the owning userId.
 * Returns true if a row was updated, false if not found / already revoked.
 *
 * @param {Pool}   pool
 * @param {string} tokenId  - UUID
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function revokeApiToken(pool, tokenId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE api_tokens SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId]
  );
  return rowCount > 0;
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Build middleware that validates a session cookie.
 * When pool is provided, also validates the session in the sessions table
 * and applies rolling expiry.
 *
 * HTML routes → redirect to /signup on failure.
 */
function makeRequireAuth(pool) {
  return async function requireAuth(req, res, next) {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return res.redirect('/signup');
    const payload = verifySession(token);
    if (!payload) return res.redirect('/signup');

    // Server-side session check (if sessions table is available)
    if (pool && payload.sessionId) {
      const session = await getSession(pool, payload.sessionId).catch(() => null);
      if (!session) return res.redirect('/signup');
      // Rolling expiry (fire-and-forget)
      touchSession(pool, payload.sessionId).catch(() => {});
    }

    req.user = payload;
    next();
  };
}

/**
 * Build middleware for API endpoints: returns 401 JSON on failure.
 * When pool is provided, validates the session in sessions table.
 *
 * Also accepts Bearer API tokens (bo_live_ / bo_mock_ prefixed).
 * Bearer token takes precedence over session cookie when both are present.
 */
function makeRequireApiAuth(pool) {
  return async function requireApiAuth(req, res, next) {
    // ── Try Bearer API token first ─────────────────────────────────────────
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer bo_')) {
      const rawToken = authHeader.slice(7).trim();
      try {
        const tokenData = await validateApiToken(pool, rawToken);
        if (!tokenData) {
          return res.status(401).json({ success: false, message: 'Invalid or expired API token' });
        }
        req.user = { userId: tokenData.userId, apiTokenId: tokenData.id };
        return next();
      } catch (err) {
        console.error('[Auth] API token validation error:', err.message);
        return res.status(500).json({ success: false, message: 'Token validation failed' });
      }
    }

    // ── Fall back to session cookie ────────────────────────────────────────
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
    const payload = verifySession(token);
    if (!payload) return res.status(401).json({ success: false, message: 'Session expired' });

    // Server-side session check
    if (pool && payload.sessionId) {
      const session = await getSession(pool, payload.sessionId).catch(() => null);
      if (!session) return res.status(401).json({ success: false, message: 'Session revoked' });
      // Rolling expiry (fire-and-forget)
      touchSession(pool, payload.sessionId).catch(() => {});
    }

    req.user = payload;
    next();
  };
}

// Stateless fallbacks (used before pool is available — server.js re-assigns after init)
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.redirect('/signup');
  const payload = verifySession(token);
  if (!payload) return res.redirect('/signup');
  req.user = payload;
  next();
}

function requireApiAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  const payload = verifySession(token);
  if (!payload) return res.status(401).json({ success: false, message: 'Session expired' });
  req.user = payload;
  next();
}

// ── Polsia email proxy helper ─────────────────────────────────────────────────

/**
 * Send email via Polsia email proxy (fallback when POSTMARK_SERVER_TOKEN is missing).
 * Follows the same proxy pattern as the AI proxy (polsia.com/ai/openai/v1).
 * Never throws — returns { sent, reason }.
 */
function sendViaPolsiaProxy(to, subject, html, apiKey) {
  const payload = JSON.stringify({
    to,
    subject,
    html_body: html,
    text_body: `${subject}\n\nhttps://buildorbit.polsia.app`,
    from: 'noreply@buildorbit.polsia.app',
    tag: 'transactional',
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'polsia.com',
        port:     443,
        path:     '/email/send',
        method:   'POST',
        headers:  {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch (_) { parsed = { raw: body }; }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            const msgId = parsed.messageId || parsed.MessageID || parsed.id || 'proxy-ok';
            console.log(`[Polsia Email Proxy SUCCESS] to=${to} subject="${subject}" msgId=${msgId}`);
            resolve({ sent: true, messageId: msgId });
          } else {
            console.error(`[Polsia Email Proxy REJECTED] to=${to} subject="${subject}" status=${res.statusCode}`, parsed);
            resolve({ sent: false, reason: 'proxy_error', statusCode: res.statusCode, response: parsed });
          }
        });
      }
    );

    req.on('error', (err) => {
      console.error(`[Polsia Email Proxy UNAVAILABLE] to=${to}:`, err.message);
      resolve({ sent: false, reason: 'proxy_network_error', error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// ── Email delivery ─────────────────────────────────────────────────────────────

/**
 * Send magic link email via Postmark REST API using raw HTTPS.
 *
 * DIAGNOSTIC NOTE (2026-04-17):
 * - POSTMARK_SERVER_TOKEN must be set on Render to send emails
 * - When token is missing, returns { sent: false, reason: "no_token" }
 * - Success is defined by Postmark returning a MessageID — NOT local execution
 *
 * @returns {Promise<{sent: boolean, messageId?: string, reason?: string, response?: object}>}
 */
async function sendMagicLinkEmail(email, token, deviceContext = {}, pool = null, runId = null) {
  const appUrl = 'https://buildorbit.polsia.app';
  const verifyUrl = `${appUrl}/auth/verify?token=${token}`;
  const serverToken = process.env.POSTMARK_SERVER_TOKEN;

  console.log('[Auth] Attempting magic link send to:', email);

  const { browser, location } = deviceContext;

  const deviceRows = [];
  if (location) deviceRows.push(`<tr><td style="padding:4px 0;font-size:0.83rem;color:#8888a0;">${escapeHtml(location)}</td></tr>`);
  if (browser)  deviceRows.push(`<tr><td style="padding:4px 0;font-size:0.83rem;color:#8888a0;">${escapeHtml(browser)}</td></tr>`);

  const deviceSection = deviceRows.length > 0 ? `
      <table cellpadding="0" cellspacing="0" style="background:#0a0a0f;border:1px solid #2a2a3a;border-radius:8px;padding:14px 18px;margin:24px 0;width:100%;">
        <tr><td style="padding-bottom:8px;font-size:0.72rem;color:#555570;text-transform:uppercase;letter-spacing:0.8px;">Request originated from</td></tr>
        ${deviceRows.join('\n        ')}
      </table>` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:40px auto;padding:0 16px;">
    <tr><td style="background:#12121a;border:1px solid #2a2a3a;border-radius:12px;padding:40px 36px;">
      <p style="margin:0 0 8px;font-size:0.85rem;color:#00e5a0;letter-spacing:1px;text-transform:uppercase;font-weight:600;">BuildOrbit</p>
      <h1 style="margin:0 0 16px;font-size:1.5rem;color:#e8e8f0;font-weight:700;">Sign in to BuildOrbit</h1>
      <p style="margin:0 0 28px;font-size:0.95rem;color:#8888a0;line-height:1.6;">
        Click the button below to sign in. This link expires in <strong style="color:#e8e8f0;">15 minutes</strong> and can only be used once.
      </p>
      <a href="${verifyUrl}" style="display:inline-block;background:#00e5a0;color:#0a0a0f;text-decoration:none;font-weight:700;font-size:0.95rem;padding:14px 32px;border-radius:8px;letter-spacing:-0.2px;">Sign in to BuildOrbit →</a>
      <p style="margin:28px 0 0;font-size:0.8rem;color:#555570;line-height:1.6;">Or copy this link:<br><a href="${verifyUrl}" style="color:#00e5a0;word-break:break-all;">${verifyUrl}</a></p>
      ${deviceSection}
      <hr style="margin:28px 0;border:none;border-top:1px solid #2a2a3a;">
      <p style="margin:0;font-size:0.78rem;color:#555570;">If this wasn't you, ignore this email — no account has been created or modified.</p>
    </td></tr>
  </table>
</body>
</html>`;

  // ── Diagnostic guard — token must be present ─────────────────────────────
  if (!serverToken) {
    // Fallback: try Polsia email proxy (same pattern as AI proxy at polsia.com/ai/openai/v1)
    const polsiaKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;
    if (polsiaKey) {
      console.log('[Auth] No POSTMARK_SERVER_TOKEN — trying Polsia email proxy for magic link to:', email);
      return sendViaPolsiaProxy(email, 'Your BuildOrbit magic link', html, polsiaKey);
    }
    console.error('[Auth] EMAIL_SEND_FAILED — no email transport available. Magic link:', verifyUrl);
    return { sent: false, reason: 'no_transport' };
  }

  // ── Hook 2: EMAIL_PROVIDER_CHECKED — pre-send config validation ─────────────
  // Confirms provider is still ready immediately before making the network call.
  if (pool) {
    await emitProviderEvent(pool, PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_CHECKED, {
      provider:      'postmark',
      operation:     'magic_link_send',
      status:        'checked',
      message_id:    null,
      error_code:    null,
      error_message: null,
      config_valid:  true,
      mock_mode:     false,
    }, runId);
  }

  // Build the JSON payload that Postmark expects
  const postmarkPayload = JSON.stringify({
    From: 'noreply@buildorbit.polsia.app',
    To: email,
    Subject: 'Your BuildOrbit magic link',
    HtmlBody: html,
    TextBody: `Sign in: ${verifyUrl}`,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.postmark.com',
      port: 443,
      path: '/v1/email',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': serverToken,
        'Content-Length': Buffer.byteLength(postmarkPayload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        // Log raw response — this is the critical diagnostic signal
        let rawResponse = {};
        try { rawResponse = JSON.parse(body); } catch (_) { rawResponse = { raw: body }; }

        if (res.statusCode === 200 || res.statusCode === 201) {
          // Validate external acknowledgment — MessageID is the only proof of acceptance
          if (rawResponse.MessageID) {
            console.log('[Postmark SUCCESS]', JSON.stringify(rawResponse));
            // Hook 3a: EMAIL_PROVIDER_ACCEPTED — external ack received
            if (pool) {
              emitProviderEvent(pool, PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_ACCEPTED, {
                provider:      'postmark',
                operation:     'magic_link_send',
                status:        'accepted',
                message_id:    rawResponse.MessageID,
                error_code:    null,
                error_message: null,
                config_valid:  true,
                mock_mode:     false,
              }, runId).catch(() => {});
            }
            resolve({ sent: true, messageId: rawResponse.MessageID, response: rawResponse });
          } else {
            console.error('[Postmark REJECTED] No MessageID in response:', JSON.stringify(rawResponse));
            // Hook 3b: EMAIL_PROVIDER_REJECTED — 2xx but no MessageID (malformed acceptance)
            if (pool) {
              emitProviderEvent(pool, PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_REJECTED, {
                provider:      'postmark',
                operation:     'magic_link_send',
                status:        'rejected',
                message_id:    null,
                error_code:    rawResponse.ErrorCode || null,
                error_message: 'No MessageID in 2xx response',
                config_valid:  true,
                mock_mode:     false,
              }, runId).catch(() => {});
            }
            resolve({ sent: false, reason: 'provider_rejected', response: rawResponse, statusCode: res.statusCode });
          }
        } else {
          console.error('[Postmark FAILURE]', JSON.stringify({
            message: `HTTP ${res.statusCode}`,
            statusCode: res.statusCode,
            errorCode: rawResponse.ErrorCode,
            body: rawResponse
          }));
          // Hook 3c: EMAIL_PROVIDER_REJECTED — provider returned explicit HTTP error
          if (pool) {
            emitProviderEvent(pool, PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_REJECTED, {
              provider:      'postmark',
              operation:     'magic_link_send',
              status:        'rejected',
              message_id:    null,
              error_code:    rawResponse.ErrorCode || null,
              error_message: rawResponse.Message || `HTTP ${res.statusCode}`,
              config_valid:  true,
              mock_mode:     false,
            }, runId).catch(() => {});
          }
          resolve({ sent: false, reason: 'http_error', statusCode: res.statusCode, errorCode: rawResponse.ErrorCode, response: rawResponse });
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Postmark FAILURE]', JSON.stringify({
        message: err.message,
        statusCode: err.statusCode,
        errorCode: err.errorCode,
        body: err.body
      }));
      // Hook 4: EMAIL_PROVIDER_UNAVAILABLE — network failure, timeout, DNS error
      if (pool) {
        emitProviderEvent(pool, PROVIDER_EVENT_TYPES.EMAIL_PROVIDER_UNAVAILABLE, {
          provider:      'postmark',
          operation:     'magic_link_send',
          status:        'unavailable',
          message_id:    null,
          error_code:    err.errorCode || null,
          error_message: err.message || 'Network error reaching Postmark',
          config_valid:  true,
          mock_mode:     false,
        }, runId).catch(() => {});
      }
      resolve({ sent: false, reason: 'network_error', error: err.message, errorCode: err.errorCode });
    });

    req.write(postmarkPayload);
    req.end();
  });
}

/** Minimal HTML escaping for user-supplied strings rendered in email HTML. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  // Token
  generateToken,
  hashToken,
  hashContext,
  // JWT
  signSession,
  verifySession,
  // Session management
  createSession,
  getSession,
  touchSession,
  revokeSession,
  revokeAllSessions,
  // Security logging
  logSecurityEvent,
  // API tokens (bo_live_ / bo_mock_ prefixed Bearer tokens for CLI/headless access)
  generateApiToken,
  createApiToken,
  validateApiToken,
  listApiTokens,
  revokeApiToken,
  // Middleware factories (pool-aware)
  makeRequireAuth,
  makeRequireApiAuth,
  // Stateless fallback middleware (backward compat — server.js replaces with pool-aware versions)
  requireAuth,
  requireApiAuth,
  // Email
  sendMagicLinkEmail,
  // Constants
  COOKIE_NAME,
  COOKIE_OPTIONS
};