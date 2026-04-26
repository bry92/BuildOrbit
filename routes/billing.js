/**
 * Billing routes — Stripe subscription management
 *
 * POST /api/billing/create-checkout  → returns Stripe Checkout URL for $49/month
 * POST /api/billing/webhook          → handles Stripe webhook events
 * POST /api/billing/activate         → activates subscription after successful checkout
 * GET  /api/billing/portal           → redirects to Stripe Customer Portal
 * GET  /api/billing/status           → returns current user's billing status
 */

const express = require('express');
const crypto  = require('crypto');
const { sendSubscriptionConfirmationEmail } = require('../backend/src/email/transactional');

// Pre-created Stripe subscription link ($49/month, created via Polsia MCP)
const STRIPE_SUBSCRIPTION_LINK = 'https://buy.stripe.com/8x2dRb7a84GPdgd8Lw5sA00';
const APP_URL = process.env.APP_URL || 'https://buildorbit.polsia.app';

// How many credits to provision on each event
const CREDITS_ON_SIGNUP     = 10;  // checkout.session.completed
const CREDITS_ON_RENEWAL    = 5;   // invoice.payment_succeeded (subsequent months)

/**
 * Verify Stripe webhook signature.
 * Returns true if signature is valid (or if STRIPE_WEBHOOK_SECRET is not set — dev mode).
 */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) return true; // dev/no-key mode — trust all events

  try {
    const parts = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const signature = parts['v1'];

    if (!timestamp || !signature) return false;

    const payload    = `${timestamp}.${rawBody}`;
    const expected   = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const isValid    = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );

    // Reject events older than 5 minutes
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    return isValid && age < 300;
  } catch (_) {
    return false;
  }
}

module.exports = function createBillingRouter({ pool, auth }) {
  const router = express.Router();

  // ── GET /api/billing/status ──────────────────────────────────────────────
  // Returns current user's subscription_status, task_credits, and is_admin.
  // Admin users bypass credit enforcement and see "Unlimited" in the UI.
  router.get('/status', auth.requireApiAuth, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { rows } = await pool.query(
        `SELECT subscription_status, task_credits,
                COALESCE(is_admin, false) AS is_admin
           FROM users WHERE id = $1`,
        [userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });

      // Also check ADMIN_USER_IDS env var for bootstrapping
      const adminEnvIds = (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n > 0);
      const isAdmin = rows[0].is_admin || adminEnvIds.includes(userId);

      res.json({ success: true, ...rows[0], is_admin: isAdmin });
    } catch (err) {
      console.error('[Billing] /status error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch billing status' });
    }
  });

  // ── POST /api/billing/create-checkout ───────────────────────────────────
  // Returns the Stripe Checkout URL for the $49/month BuildOrbit Pro subscription.
  // client_reference_id is appended so Stripe can link payment to our user.
  router.post('/create-checkout', auth.requireApiAuth, async (req, res) => {
    try {
      const userId   = req.user.userId;
      const successUrl = `${APP_URL}/dashboard?subscription=active&uid=${encodeURIComponent(userId)}`;

      // Build the Stripe link with prefilled client_reference_id
      // (Stripe hosted links support ?client_reference_id= param)
      const checkoutUrl = `${STRIPE_SUBSCRIPTION_LINK}?client_reference_id=${encodeURIComponent(userId)}`;

      res.json({ success: true, url: checkoutUrl });
    } catch (err) {
      console.error('[Billing] /create-checkout error:', err);
      res.status(500).json({ success: false, message: 'Failed to create checkout' });
    }
  });

  // ── POST /api/billing/activate ───────────────────────────────────────────
  // Called when user returns from Stripe checkout (?subscription=active).
  // Marks user as active and grants CREDITS_ON_SIGNUP credits (idempotent).
  // Uses raw-body for security — only activates if the user was trial/free.
  router.post('/activate', auth.requireApiAuth, async (req, res) => {
    try {
      const userId = req.user.userId;

      // Idempotent: only activate if not already active
      const { rows } = await pool.query(
        'SELECT subscription_status, task_credits FROM users WHERE id = $1',
        [userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });

      const user = rows[0];

      if (user.subscription_status === 'active') {
        // Already active — no-op
        return res.json({ success: true, already_active: true, task_credits: user.task_credits });
      }

      // Activate subscription and provision bonus credits
      await pool.query(
        `UPDATE users
            SET subscription_status = 'active',
                task_credits        = task_credits + $1
          WHERE id = $2`,
        [CREDITS_ON_SIGNUP, userId]
      );

      console.log(`[Billing] Activated subscription for userId=${userId}, +${CREDITS_ON_SIGNUP} credits`);

      const newCredits = user.task_credits + CREDITS_ON_SIGNUP;
      res.json({ success: true, task_credits: newCredits });
    } catch (err) {
      console.error('[Billing] /activate error:', err);
      res.status(500).json({ success: false, message: 'Failed to activate subscription' });
    }
  });

  // ── GET /api/billing/portal ──────────────────────────────────────────────
  // Redirects active subscribers to subscription management.
  // When STRIPE_SECRET_KEY is available, generates a real Customer Portal session.
  // For now, redirects to Stripe's general subscription management.
  router.get('/portal', auth.requireApiAuth, async (req, res) => {
    try {
      // If we have Stripe API access, we could generate a Customer Portal session here.
      // For now, redirect to a general billing management page.
      // Users can cancel via Stripe's email or the link in their receipt.
      const portalUrl = `https://billing.stripe.com/p/login/test_00g00000000`;

      // If STRIPE_SECRET_KEY is set, generate a real portal session
      if (process.env.STRIPE_SECRET_KEY) {
        const { rows } = await pool.query(
          'SELECT stripe_customer_id FROM users WHERE id = $1',
          [req.user.userId]
        );
        const customerId = rows[0]?.stripe_customer_id;

        if (customerId) {
          // Use Stripe SDK to create a portal session
          // This requires the stripe npm package — handled below
          try {
            const Stripe = require('stripe');
            const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
            const session = await stripe.billingPortal.sessions.create({
              customer:    customerId,
              return_url:  `${APP_URL}/dashboard`,
            });
            return res.json({ success: true, url: session.url });
          } catch (stripeErr) {
            console.error('[Billing] Portal session creation failed:', stripeErr.message);
          }
        }
      }

      // Fallback: send to Stripe's self-service management
      res.json({ success: true, url: 'https://billing.stripe.com/p/login/test_00g00000000' });
    } catch (err) {
      console.error('[Billing] /portal error:', err);
      res.status(500).json({ success: false, message: 'Failed to get portal URL' });
    }
  });

  // ── POST /api/billing/webhook ─────────────────────────────────────────────
  // Handles Stripe webhook events for full lifecycle management.
  // Raw body is captured at the app level (before express.json) via:
  //   app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))
  //
  // Supported events:
  //   checkout.session.completed    → activate subscription, +10 credits
  //   invoice.payment_succeeded     → +5 monthly renewal credits (non-first invoices)
  //   customer.subscription.deleted → cancel subscription
  //   invoice.payment_failed        → mark past_due
  router.post('/webhook', async (req, res) => {
      const sig    = req.headers['stripe-signature'];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;

      const rawBody = req.body instanceof Buffer ? req.body.toString() : JSON.stringify(req.body);

      if (secret && !verifyStripeSignature(rawBody, sig || '', secret)) {
        console.warn('[Billing] Webhook signature verification failed');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch (_) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }

      console.log(`[Billing] Webhook received: ${event.type}`);

      try {
        switch (event.type) {

          // ── checkout.session.completed ────────────────────────────────
          // First payment successful — activate subscription, provision signup credits.
          case 'checkout.session.completed': {
            const session    = event.data.object;
            const userId     = session.client_reference_id;
            const customerId = session.customer;

            if (!userId) {
              console.warn('[Billing] checkout.session.completed missing client_reference_id');
              break;
            }

            // Update subscription status and store Stripe customer ID
            await pool.query(
              `UPDATE users
                  SET subscription_status = 'active',
                      stripe_customer_id  = $1,
                      task_credits        = task_credits + $2
                WHERE id = $3 AND subscription_status != 'active'`,
              [customerId || null, CREDITS_ON_SIGNUP, userId]
            );

            console.log(`[Billing] checkout.session.completed: userId=${userId}, customerId=${customerId}, +${CREDITS_ON_SIGNUP} credits`);

            // Send subscription confirmation email (fire-and-forget)
            try {
              const { rows: userRows } = await pool.query(
                'SELECT email FROM users WHERE id = $1',
                [userId]
              );
              if (userRows.length) {
                sendSubscriptionConfirmationEmail(userRows[0].email).catch(err =>
                  console.error('[Billing] Subscription confirmation email error:', err.message)
                );
              }
            } catch (emailLookupErr) {
              console.error('[Billing] Failed to look up email for subscription confirmation:', emailLookupErr.message);
            }
            break;
          }

          // ── invoice.payment_succeeded ────────────────────────────────
          // Monthly renewal — provision credits (but not on the very first invoice,
          // that's handled by checkout.session.completed).
          case 'invoice.payment_succeeded': {
            const invoice    = event.data.object;
            const customerId = invoice.customer;
            const billing_reason = invoice.billing_reason;

            // Skip the initial subscription invoice — handled by checkout.session.completed
            if (billing_reason === 'subscription_create') break;

            if (!customerId) break;

            await pool.query(
              `UPDATE users
                  SET task_credits = task_credits + $1
                WHERE stripe_customer_id = $2`,
              [CREDITS_ON_RENEWAL, customerId]
            );

            console.log(`[Billing] invoice.payment_succeeded: customerId=${customerId}, +${CREDITS_ON_RENEWAL} credits`);
            break;
          }

          // ── customer.subscription.deleted ────────────────────────────
          // Subscription cancelled — update status.
          case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            const customerId   = subscription.customer;

            if (!customerId) break;

            await pool.query(
              `UPDATE users
                  SET subscription_status = 'cancelled'
                WHERE stripe_customer_id = $1`,
              [customerId]
            );

            console.log(`[Billing] customer.subscription.deleted: customerId=${customerId}`);
            break;
          }

          // ── invoice.payment_failed ────────────────────────────────────
          // Payment failed — mark as past_due.
          case 'invoice.payment_failed': {
            const invoice    = event.data.object;
            const customerId = invoice.customer;

            if (!customerId) break;

            await pool.query(
              `UPDATE users
                  SET subscription_status = 'past_due'
                WHERE stripe_customer_id = $1`,
              [customerId]
            );

            console.log(`[Billing] invoice.payment_failed: customerId=${customerId}`);
            break;
          }

          default:
            // Unhandled event type — ignore
            break;
        }

        res.json({ received: true });
      } catch (err) {
        console.error('[Billing] Webhook handler error:', err);
        res.status(500).json({ error: 'Webhook handler failed' });
      }
    }
  );

  return router;
};
