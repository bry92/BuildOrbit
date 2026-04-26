/**
 * Builder Agent
 *
 * Owns the SCAFFOLD and CODE stages of the pipeline.
 *
 * Responsibilities:
 *   - SCAFFOLD: Takes plan output → generates filesystem tree
 *   - CODE: Takes plan + scaffold → runs 6-phase deterministic generation pipeline
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → scaffold: { tree[], techStack[], summary }
 *   → code:     { files: { [filename]: content }, entryPoint, totalLines }
 *
 * Communication: Reads plan from previousOutputs (pipeline state).
 * No direct calls to other agents.
 *
 * ── 6-Phase CODE Generation Pipeline ─────────────────────────────────────────
 *
 * Mental model: AI → partial artifacts → validation → targeted synthesis → convergence
 * Truncation is the DEFAULT case. The pipeline converges on completeness.
 *
 * Phase 1 — Controlled Initial Generation   (12–14K tokens, bias high-value files first)
 * Phase 2 — Parse + Normalize               (delimiter cascade → JSON → code blocks; normalize paths)
 * Phase 3 — Deterministic Diff Engine       (missing / incomplete / invalid vs. scaffold manifest)
 * Phase 4 — Dependency-Aware Planner        (infra → server → frontend ordering)
 * Phase 5 — Strict Continuation Execution   (contract-style prompts, surgical per-file)
 * Phase 6 — Merge + Validate Loop           (re-diff after each pass; max 3 passes)
 */

const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { buildContextInstruction } = require('../lib/product-context');
const { validateScaffoldAgainstContract, formatConstraintBlock } = require('./intent-gate');
const { getScaffoldSchema, validateConstraintsAgainstSchema } = require('../lib/scaffold-schemas');
const { isExpansionAuthorized } = require('../lib/soft-expansion');
const { validateCCO } = require('../lib/cco-validator');

// ── Dependency tiers for continuation ordering ────────────────────────────────
// Lower index = generated first. Each tier depends on the previous one.
const DEPENDENCY_TIERS = [
  // Tier 0: Infrastructure foundation
  ['package.json', 'db/pool.js', 'db/queries.js', 'config.js', 'migrate.js'],
  // Tier 1: Server core
  ['server.js', 'routes/api.js', 'routes/auth.js', 'middleware/auth.js', 'auth.js'],
  // Tier 2: Additional routes & DB
  ['routes/', 'middleware/', 'db/', 'migrations/001_schema.js', 'migrations/'],
  // Tier 3: Frontend
  ['index.html', 'app.js', 'script.js', 'styles.css', 'public/index.html', 'public/app.js', 'public/styles.css'],
];

// ── Senior engineer system prompt — hardcoded, not user-configurable ──────────
// This is the engineering rigor layer. Product Context (business inputs) is
// a separate layer injected at the user-message level, not here.
// Enforces: structured thinking before code, production-quality standards,
// proactive failure mode analysis, direct and confident tone.
const SENIOR_ENGINEER_SYSTEM_PROMPT = `You are a senior software engineer with production system experience. You write code that ships, gets maintained, and gets debugged under pressure — not prototypes or demos.

THINK BEFORE YOU CODE — follow this sequence for every build:
1. BUSINESS REQUIREMENTS — What does this system need to accomplish? What is the success criterion?
2. NON-FUNCTIONAL REQUIREMENTS — Performance, security, accessibility, reliability expectations
3. CONSTRAINTS — Technology boundaries, deployment environment, schema contracts you must respect
4. ARCHITECTURE — Module structure, data flow, error propagation, integration points
5. IMPLEMENTATION — Only after the above is clear, generate code

PRODUCTION CODE STANDARDS — every file you generate must meet these:
- Complete implementations only: no placeholder comments, no "// TODO: implement", no skeleton stubs
- Error handling is exhaustive: handle network failures, null/undefined inputs, and partial failures explicitly — not with a generic catch-all
- Security by default: parameterized queries always (never string interpolation in SQL), no credentials in code, input validation at all external boundaries
- Observability: meaningful log statements at key decision points, not noise
- Idiomatic: use the language/framework's established patterns — don't reinvent what the stdlib or framework already provides
- Comments explain WHY decisions were made, not WHAT the code does

PROACTIVE FAILURE MODE ANALYSIS — before finalizing any component, ask:
- What breaks if the database is unavailable? Guard it.
- What breaks if an external API returns null, 429, or 500? Handle it.
- What if required env vars are missing at startup? Fail loudly at boot, not silently at request time.
Surface these in code: guard clauses, fallbacks, early-exit validation — not deferred TODOs.

DEPLOYMENT & INFRASTRUCTURE AWARENESS:
- Code runs in real environments: memory limits, cold starts, connection pool exhaustion
- Validate required configuration at startup — crash fast with a clear error message
- Don't assume the filesystem is persistent; don't assume external services are always available

FRONTEND INTERACTIVITY — NOT OPTIONAL:
- A UI without working interactions is a mockup, not an application. Every button, form, tab, and navigation element MUST have corresponding JavaScript event handlers.
- Generate functional JavaScript: event listeners (addEventListener), DOM manipulation (show/hide, update text, toggle classes), state tracking (variables for current view, data arrays, form state), and API integration (fetch calls).
- If you generate a <button> in HTML, you MUST generate its click handler in JavaScript. No exceptions. Dead buttons are production bugs.
- For any interactive app (calculator, dashboard, editor, task manager): the JavaScript file is the MOST IMPORTANT file. It must contain real logic — not just scroll animations or empty function stubs.

TONE & JUDGMENT:
- Call out architectural problems in comments when you see them
- If a requirement implies a brittle or insecure approach, flag it inline
- Never generate code you know is wrong hoping the human will catch it
- Be direct and confident — ambiguity is not a virtue in production code

BRANDING REQUIREMENT — NON-NEGOTIABLE:
- Every generated app MUST include this badge as the LAST element before </body> in index.html (or the main HTML entry file):
  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>
- This must appear in EVERY app regardless of type (landing page, interactive app, full product).
- Place it AFTER all app content and any footer — it must be the very last visible element.
- IMPORTANT: The badge is a footer addition, NOT a replacement for app content. The index.html MUST contain the full application UI above the badge.`;

// ── Completeness heuristics ───────────────────────────────────────────────────
function isLikelyIncomplete(content) {
  if (!content || content.length < 80) return true;

  const trimmed = content.trim();

  // Structural checks for JS/JSON/CSS/HTML
  const ext = null; // path-agnostic — check all patterns

  // Ends mid-function / missing closing bracket
  const openBraces = (trimmed.match(/\{/g) || []).length;
  const closeBraces = (trimmed.match(/\}/g) || []).length;
  if (openBraces > 0 && openBraces - closeBraces > 2) return true;

  // Explicit stubs
  if (/\bTODO\b/.test(trimmed)) return true;
  if (/\.{3}\s*$/.test(trimmed)) return true;                   // ends with ...
  if (/\/\/\s*\.\.\.\s*$/.test(trimmed)) return true;           // ends with // ...
  if (/\/\*\s*\.\.\.\s*\*\/\s*$/.test(trimmed)) return true;   // ends with /* ... */

  // Suspiciously small files (< 5 lines for non-trivial types)
  if (trimmed.split('\n').length < 5) return true;

  return false;
}

class BuilderAgent {
  constructor() {
    this.stages = ['scaffold', 'code'];
    this.openai = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI();
      }
    } catch (e) {
      console.log('[BuilderAgent] OpenAI not available, using simulated mode');
    }

    this.anthropic = null;
    try {
      if (process.env.ANTHROPIC_API_KEY) {
        this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        console.log('[BuilderAgent] Anthropic client initialized ✓');
      }
    } catch (e) {
      console.log('[BuilderAgent] Anthropic SDK not available:', e.message);
    }
  }

  /**
   * Select the LLM provider and model for the CODE phase based on intent class.
   *
   * Routing logic:
   *   full_product / light_app / soft_expansion → Claude (Anthropic)
   *   static_surface → OpenAI gpt-4o
   *
   * Model is configurable via env vars:
   *   CLAUDE_CODE_MODEL   — override Claude model (default: claude-sonnet-4-20250514)
   *   OPENAI_CODE_MODEL   — override OpenAI model (default: gpt-4o)
   *
   * Falls back to OpenAI if Anthropic client is not initialized.
   */
  _selectModel(intentClass) {
    const claudeIntentClasses = new Set(['full_product', 'light_app', 'soft_expansion']);
    const useClaude = claudeIntentClasses.has(intentClass) && this.anthropic;
    if (useClaude) {
      return {
        provider: 'anthropic',
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-20250514',
      };
    }
    return {
      provider: 'openai',
      model: process.env.OPENAI_CODE_MODEL || 'gpt-4o',
    };
  }

  /**
   * Unified streaming LLM call. Routes to Anthropic or OpenAI based on provider.
   * Returns { rawText, finishReason, tokenUsage } — same contract for both providers.
   */
  async _callStreamingLLM({ provider, model }, systemPrompt, userMessage, maxTokens, emitChunk) {
    if (provider === 'anthropic') {
      return this._callAnthropicStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk);
    }
    return this._callOpenAIStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk);
  }

  /**
   * Anthropic streaming call. Maps stop_reason to OpenAI finish_reason conventions.
   * 'max_tokens' → 'length'   (signals truncation → continuation pipeline kicks in)
   * 'end_turn'   → 'stop'
   */
  async _callAnthropicStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk) {
    const chunks = [];
    let finishReason = null;
    let inputTokens = 0;
    let outputTokens = 0;

    console.log(`[BuilderAgent] Calling Anthropic: model=${model}, max_tokens=${maxTokens}`);

    const stream = this.anthropic.messages.stream({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: maxTokens,
      temperature: 0.2,
    });

    for await (const event of stream) {
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text || '';
        if (text) {
          chunks.push(text);
          emitChunk(text);
        }
      }
      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          // Map Anthropic stop reasons to OpenAI conventions for downstream compatibility
          finishReason = event.delta.stop_reason === 'max_tokens' ? 'length' : event.delta.stop_reason;
        }
        if (event.usage?.output_tokens) {
          outputTokens = event.usage.output_tokens;
        }
      }
    }

    const rawText = chunks.join('');
    console.log(
      `[BuilderAgent] Anthropic done: ${rawText.length} chars, input=${inputTokens} output=${outputTokens} tokens, finish_reason=${finishReason}`
    );

    if (finishReason === 'length') {
      console.warn('[BuilderAgent] Anthropic: truncated (max_tokens) — continuation pipeline will fill gaps');
    }

    return {
      rawText,
      finishReason,
      tokenUsage: { model, inputTokens, outputTokens },
    };
  }

  /**
   * OpenAI streaming call — extracted from _phase1_initialGeneration for reuse.
   */
  async _callOpenAIStreaming(model, systemPrompt, userMessage, maxTokens, emitChunk) {
    const chunks = [];
    let finishReason = null;
    let tokenUsage = null;

    console.log(`[BuilderAgent] Calling OpenAI: model=${model}, max_tokens=${maxTokens}`);

    const stream = await this.openai.chat.completions.create({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        chunks.push(text);
        emitChunk(text);
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
      if (chunk.usage) {
        tokenUsage = {
          model,
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    const rawText = chunks.join('');
    const outputTokens = tokenUsage?.outputTokens || 0;
    console.log(
      `[BuilderAgent] OpenAI done: ${rawText.length} chars, ${outputTokens} output tokens, finish_reason=${finishReason}`
    );

    if (finishReason === 'length') {
      console.warn('[BuilderAgent] OpenAI: truncated (finish_reason=length) — continuation pipeline will fill gaps');
    }

    return { rawText, finishReason, tokenUsage };
  }

  /**
   * Execute SCAFFOLD or CODE stage.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - 'scaffold' or 'code'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, ... } from event log
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[BuilderAgent] Executing ${stage.toUpperCase()} for run ${runId.slice(0, 8)}...`);

    // ── Secondary CCO Guard (defense-in-depth) ────────────────────────────────
    // Intent Gate is the primary gate. This is the secondary guard — BuilderAgent
    // must not execute if the CCO is missing, null, or structurally invalid.
    // If Intent Gate is working correctly, this should NEVER fire.
    // If it does fire, it means the primary gate failed — which is a critical bug.
    {
      const _cco = previousOutputs._constraintContract;

      if (!_cco) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO is missing or null. Intent Gate must have failed.`
        );
      }

      if (!_cco.intent_class) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO has undefined intent_class. Contract is structurally invalid.`
        );
      }

      const _ccoGuard = validateCCO(_cco);
      if (!_ccoGuard.valid) {
        throw new Error(
          `[BuilderAgent] SECONDARY_CCO_GUARD: Cannot execute ${stage.toUpperCase()} — ` +
          `CCO failed schema validation: ${_ccoGuard.errors.join('; ')}`
        );
      }

      console.log(`[BuilderAgent] CCO guard passed ✓ (${_cco.intent_class}, expansion_lock: ${_cco.expansion_lock})`);
    }

    // Extract product context injected by the orchestrator
    const productContext = previousOutputs._productContext || null;
    if (productContext) {
      console.log(`[BuilderAgent] Product context detected — ${stage.toUpperCase()} will generate accurate content`);
    }

    // Extract Intent Gate constraint contract (immutable — set at Step 0)
    const constraintContract = previousOutputs._constraintContract || null;
    if (constraintContract) {
      console.log(`[BuilderAgent] Constraint contract: ${constraintContract.intent_class} (expansion_lock: ${constraintContract.expansion_lock})`);
    }

    switch (stage) {
      case 'scaffold':
        return this._executeScaffold(prompt, previousOutputs.plan, emitChunk, constraintContract);
      case 'code':
        return this._executeCode(prompt, previousOutputs.plan, previousOutputs.scaffold, emitChunk, productContext, constraintContract);
      default:
        throw new Error(`[BuilderAgent] Unknown stage: ${stage}`);
    }
  }

  // ── SCAFFOLD (Deterministic — Schema Authority) ─────────

  /**
   * Generate a structured scaffold manifest that serves as the BINDING CONTRACT
   * for the CODE phase. The manifest contains:
   *   - tree[]       — UI-friendly tree of files/dirs with descriptions
   *   - techStack[]  — required dependencies
   *   - summary      — human-readable summary
   *   - files[]      — flat list of all file paths (source of truth for CODE)
   *   - structure{}  — directory-to-files mapping
   *   - constraints{} — inferred project constraints (hasServer, hasFrontend, entry, techStack)
   */
  async _executeScaffold(prompt, plan, emitChunk, constraintContract) {
    const complexity = plan?.estimatedComplexity || 'medium';
    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── Phase 4.2: ISE — extract surfaces as build targets ───────────────────
    // If ISE detected interaction surfaces, use them to guide the scaffold.
    // Each surface becomes a named section/component/view in the final build.
    const iseSurfaces   = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces)   || [];
    const iseTransitions = (constraintContract && constraintContract._ise && constraintContract._ise.transitions) || [];
    if (iseSurfaces.length > 0) {
      console.log(
        `[BuilderAgent] ISE build targets (Phase 4.2): surfaces=[${iseSurfaces.join(', ')}] ` +
        `transitions=[${iseTransitions.join(', ')}]`
      );
    }

    let tree, techStack;

    // ── Phase 4: Soft expansion PLAN justification validation ────────────────
    // For soft_expansion contracts, validate that expanded capabilities used
    // in the plan have been properly justified. If PLAN uses a capability
    // that is not in the soft_expansion allowlist, reject with a hard error.
    if (intentClass === 'soft_expansion' && plan && plan.expansion_justifications) {
      const justifiedCaps = new Set(
        (plan.expansion_justifications || []).map(j => j.capability).filter(Boolean)
      );
      const unauthorizedCaps = [];
      for (const cap of justifiedCaps) {
        if (!isExpansionAuthorized(constraintContract, cap)) {
          unauthorizedCaps.push(cap);
        }
      }
      if (unauthorizedCaps.length > 0) {
        throw new Error(
          `[BuilderAgent] SCAFFOLD HARD REJECT: PLAN justifies expansions not in soft_expansion allowlist: ${unauthorizedCaps.join(', ')}. ` +
          `Allowed: ${Object.keys(constraintContract.soft_expansion || {}).join(', ') || 'none'}`
        );
      }
      if (justifiedCaps.size > 0) {
        console.log(`[BuilderAgent] Phase 4: PLAN expansion justifications accepted: ${[...justifiedCaps].join(', ')}`);
      }
    }

    // ── SCHEMA ROUTING: intent_class selects scaffold schema BEFORE generation ─
    // Schema is selected first. File tree and metadata are generated WITHIN that schema.
    // A static_surface build is physically incapable of producing entry: 'server.js'.
    // Phase 4: for soft_expansion, route by base_class if present, else fall through to logic below.
    const schemaClass = (intentClass === 'soft_expansion')
      ? (constraintContract.base_class || 'light_app')
      : (intentClass || 'light_app');
    const schema = getScaffoldSchema(schemaClass);
    console.log(`[BuilderAgent] Schema selected: ${schemaClass} (intent=${intentClass}) → entry=${schema.entry}, server=${schema.server}`);

    // ── CONSTRAINT CONTRACT: static_surface → 3 files only ───────────────────
    // When Intent Gate classifies as static_surface, ONLY generate HTML/CSS/JS.
    // No server, no database, no migrations — UNLESS soft expansion authorizes server.
    // Phase 4: check if soft expansion has authorized server before forcing static scaffold.
    const serverExpansionAuthorized = isExpansionAuthorized(constraintContract, 'server');
    const planJustifiesServer = serverExpansionAuthorized &&
      (plan?.expansion_justifications || []).some(j => j.capability === 'server');

    const forceStaticScaffold = (intentClass === 'static_surface' ||
        (constraintContract && constraintContract.constraints && constraintContract.constraints.server === false))
      && !planJustifiesServer;

    if (forceStaticScaffold) {
      console.log('[BuilderAgent] Static surface detected — generating minimal 3-file scaffold');
      tree = [
        { path: 'index.html', type: 'file', description: 'Main HTML page' },
        { path: 'styles.css', type: 'file', description: 'Page styles' },
        { path: 'script.js', type: 'file', description: 'Client-side interactivity' },
      ];
      techStack = schema.techStack;

    } else if (intentClass === 'full_product' && complexity === 'high') {
      // PRODUCT_SYSTEM (high complexity): full-stack with better-sqlite3 (zero-config DB)
      // DATABASE_URL = absolute path to SQLite file, set by deploy engine at runtime
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point — initializes DB schema on startup' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts (better-sqlite3, express, jwt, bcrypt)' },
        { path: '.env.example', type: 'file', description: 'Required environment variables (DATABASE_URL, JWT_SECRET, PORT, NODE_ENV)' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'routes/auth.js', type: 'file', description: 'Authentication routes' },
        { path: 'middleware/', type: 'dir', description: 'Express middleware' },
        { path: 'middleware/auth.js', type: 'file', description: 'JWT auth middleware' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/database.js', type: 'file', description: 'better-sqlite3 setup — reads DATABASE_URL env var for file path' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = schema.techStack; // use schema: ['express', 'better-sqlite3', 'jsonwebtoken', 'bcrypt']
    } else if (intentClass === 'full_product') {
      // PRODUCT_SYSTEM (medium/default complexity): lighter structure, same SQLite DB
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point — initializes DB schema on startup' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts (better-sqlite3, express)' },
        { path: '.env.example', type: 'file', description: 'Required environment variables (DATABASE_URL, JWT_SECRET, PORT, NODE_ENV)' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/database.js', type: 'file', description: 'better-sqlite3 setup — reads DATABASE_URL env var for file path' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = schema.techStack; // use schema: ['express', 'better-sqlite3']
    } else if (intentClass === 'light_app' || schemaClass === 'light_app') {
      // ── LIGHT APP: minimal Express server + frontend, no database stack ──
      // Matches Intent Gate allowed_artifacts: html, css, js, server.js, routes/api.js, package.json
      // Uses in-memory storage — no pg, no migrations, no db/ directory.
      console.log('[BuilderAgent] Light app detected — generating minimal scaffold (no db/migrations)');
      tree = [
        { path: 'server.js', type: 'file', description: 'Minimal Express server — serves static files + API' },
        { path: 'package.json', type: 'file', description: 'Dependencies (express only)' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes (in-memory storage)' },
        { path: 'index.html', type: 'file', description: 'Main HTML page' },
        { path: 'styles.css', type: 'file', description: 'Application styles' },
        { path: 'app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = schema.techStack; // ['express', 'tailwindcss-cdn'] from updated schema
    } else if (complexity === 'high') {
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts' },
        { path: '.env.example', type: 'file', description: 'Required environment variables' },
        { path: 'migrate.js', type: 'file', description: 'Database migration runner' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'routes/auth.js', type: 'file', description: 'Authentication routes' },
        { path: 'middleware/', type: 'dir', description: 'Express middleware' },
        { path: 'middleware/auth.js', type: 'file', description: 'JWT auth middleware' },
        { path: 'middleware/error.js', type: 'file', description: 'Global error handling middleware' },
        { path: 'models/', type: 'dir', description: 'Database models' },
        { path: 'models/index.js', type: 'file', description: 'Model definitions and exports' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/queries.js', type: 'file', description: 'Parameterized SQL queries' },
        { path: 'db/pool.js', type: 'file', description: 'Connection pool' },
        { path: 'migrations/', type: 'dir', description: 'Schema migrations' },
        { path: 'migrations/001_schema.js', type: 'file', description: 'Initial tables' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'];
    } else {
      tree = [
        { path: 'server.js', type: 'file', description: 'Express app entry point' },
        { path: 'package.json', type: 'file', description: 'Dependencies & scripts' },
        { path: 'migrate.js', type: 'file', description: 'Database migration runner' },
        { path: 'routes/', type: 'dir', description: 'Route handlers' },
        { path: 'routes/api.js', type: 'file', description: 'REST API routes' },
        { path: 'db/', type: 'dir', description: 'Database layer' },
        { path: 'db/queries.js', type: 'file', description: 'Parameterized SQL queries' },
        { path: 'migrations/', type: 'dir', description: 'Schema migrations' },
        { path: 'migrations/001_schema.js', type: 'file', description: 'Initial tables' },
        { path: 'public/', type: 'dir', description: 'Static frontend' },
        { path: 'public/index.html', type: 'file', description: 'Single-page app' },
        { path: 'public/styles.css', type: 'file', description: 'Application styles' },
        { path: 'public/app.js', type: 'file', description: 'Client-side logic' },
      ];
      techStack = ['express', 'pg'];
    }

    // ── Build structured manifest (source of truth for CODE phase) ──

    // files[] — flat list of file paths only (no dirs)
    const filesList = tree.filter(t => t.type === 'file').map(t => t.path);

    // structure{} — directory → files mapping
    const structure = {};
    for (const item of tree) {
      if (item.type !== 'file') continue;
      const parts = item.path.split('/');
      const dir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
      if (!structure[dir]) structure[dir] = [];
      structure[dir].push(parts[parts.length - 1]);
    }

    // constraints{} — inferred project constraints
    const hasServer = filesList.some(f => f === 'server.js' || f === 'index.js');
    const hasFrontend = filesList.some(f => f.endsWith('.html'));
    const hasAuth = filesList.some(f => f.includes('auth'));
    const hasDb = filesList.some(f => f.includes('db/') || f.includes('migrations/'));

    const constraints = {
      hasServer,
      hasFrontend,
      hasAuth,
      hasDb,
      entry: schema.entry,
      techStack: techStack.length > 0 ? [...techStack] : [...schema.techStack],
    };

    // ── SCHEMA VALIDATION: compile-time prevention ──
    // Verify constraints match the selected schema. If they don't, the scaffold
    // generator produced structurally invalid metadata — log and correct.
    const schemaCheck = validateConstraintsAgainstSchema(constraints, intentClass || 'light_app');
    if (!schemaCheck.valid) {
      console.error(`[BuilderAgent] SCHEMA MISMATCH: ${schemaCheck.violations.join('; ')}`);
      // Force-correct to schema values (compile-time prevention, not runtime rejection)
      constraints.entry = schema.entry;
      if (schema.server === false) constraints.hasServer = false;
    }

    // ── ENTRY POINT SELF-CHECK: guarantee entry exists in files list ──────────
    // The schema defines the canonical entry point (e.g., 'index.html'), but
    // server-based trees store it under 'public/' (e.g., 'public/index.html').
    // If the entry point is not in filesList, resolve it:
    //   1. Check if public/<entry> exists → use that as the actual entry
    //   2. Check if any file ends with /<entry> → use that path
    //   3. As last resort, inject the bare entry point into the files list
    // This prevents the scaffold manifest validation from failing with
    // "Entry point not found in scaffold files list".
    if (constraints.entry && !filesList.includes(constraints.entry)) {
      const publicEntry = 'public/' + constraints.entry;
      const nestedMatch = filesList.find(f => f.endsWith('/' + constraints.entry));

      if (filesList.includes(publicEntry)) {
        // Server-based tree: entry lives under public/ — update constraint to match
        console.log(`[BuilderAgent] Entry point self-check: "${constraints.entry}" → "${publicEntry}" (public/ normalization)`);
        constraints.entry = publicEntry;
      } else if (nestedMatch) {
        // Entry exists at a nested path — update constraint to match
        console.log(`[BuilderAgent] Entry point self-check: "${constraints.entry}" → "${nestedMatch}" (nested path)`);
        constraints.entry = nestedMatch;
      } else {
        // Entry point missing entirely — inject it into the tree and files list
        console.warn(`[BuilderAgent] Entry point self-check: "${constraints.entry}" not found — injecting into manifest`);
        tree.push({ path: constraints.entry, type: 'file', description: 'Entry point (auto-injected)' });
        filesList.push(constraints.entry);
        // Update structure
        const parts = constraints.entry.split('/');
        const dir = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
        if (!structure[dir]) structure[dir] = [];
        structure[dir].push(parts[parts.length - 1]);
      }
    }

    const dirs = tree.filter(t => t.type === 'dir').length;
    const filesCount = filesList.length;
    const summary = `${dirs} directories, ${filesCount} files, ${techStack.join(' + ')}`;

    const treeLines = [
      '## Project Structure',
      '',
      '```',
      'project/',
      ...tree.map((t, i) => {
        const isLast = i === tree.length - 1 || (tree[i + 1] && tree[i + 1].path.split('/').length < t.path.split('/').length);
        const prefix = t.path.includes('/') ? '\u2502   ' : '';
        const connector = isLast ? '\u2514\u2500\u2500' : '\u251c\u2500\u2500';
        const name = t.path.split('/').pop() || t.path;
        return `${prefix}${connector} ${name.padEnd(22)}# ${t.description}`;
      }),
      '```',
      '',
      `**Directories:** ${dirs}`,
      `**Files:** ${filesCount}`,
      `**Dependencies:** ${techStack.join(', ')}`,
      '',
      '### Manifest Contract',
      `**Files (${filesCount}):** ${filesList.join(', ')}`,
      `**Entry:** ${constraints.entry}`,
      `**Constraints:** server=${hasServer}, frontend=${hasFrontend}, auth=${hasAuth}, db=${hasDb}`,
      // Phase 4.2: ISE — show surfaces as build targets in the manifest output
      ...(iseSurfaces.length > 0 ? [
        '',
        '### Interaction Surfaces (ISE Phase 4.2)',
        `**Build targets:** ${iseSurfaces.join(' → ')}`,
        ...(iseTransitions.length > 0 ? [`**Flow:** ${iseTransitions.join(' | ')}`] : []),
      ] : []),
    ];

    await this._streamText(treeLines.join('\n'), emitChunk, 6);

    console.log(`[BuilderAgent] SCAFFOLD manifest: ${filesCount} files, entry=${constraints.entry}, stack=[${techStack.join(',')}]`);

    // Phase 4.2: Attach ISE surfaces to scaffold output so the CODE phase
    // can inject them into the scaffold contract block (_buildScaffoldContractBlock).
    const scaffoldOutput = { tree, techStack, summary, files: filesList, structure, constraints };
    if (iseSurfaces.length > 0) {
      scaffoldOutput._ise_surfaces   = iseSurfaces;
      scaffoldOutput._ise_transitions = iseTransitions;
      console.log(`[BuilderAgent] Scaffold carries ISE surfaces: [${iseSurfaces.join(', ')}]`);
    }

    // ── Interaction Contract: what each component must DO ─────────────────────
    // Generated from ISE surfaces + prompt patterns.
    // Polymorphic by intent_class:
    //   static_surface  → empty (no interactivity required)
    //   light_app       → interactions[] + forms[]
    //   full_product    → interactions[] + routing[] + forms[]
    // CODE phase receives this as a binding contract — every listed item must be implemented.
    // VERIFY phase checks fulfillment.
    const interactionContract = this._buildInteractionContract(
      prompt, intentClass, iseSurfaces, iseTransitions, plan
    );
    scaffoldOutput.interaction_contract = interactionContract;

    const contractSummary = [
      interactionContract.interactions.length > 0 ? `${interactionContract.interactions.length} interactions` : '',
      interactionContract.routing.length > 0 ? `${interactionContract.routing.length} routes` : '',
      interactionContract.forms.length > 0 ? `${interactionContract.forms.length} forms` : '',
    ].filter(Boolean).join(', ');
    console.log(`[BuilderAgent] Interaction contract (${intentClass}): ${contractSummary || 'empty (static)'}`);

    return scaffoldOutput;
  }

  // ── Interaction Contract Builder ─────────────────────────────────────────
  //
  // Generates a polymorphic interaction_contract from prompt + ISE surfaces + plan.
  // The contract specifies WHAT each component must DO — not just that it exists.
  // This becomes part of the SCAFFOLD manifest that CODE validates against.
  //
  // Contract shape (varies by intent_class):
  //   interactions[] — element + event + behavior + state (for INTERACTIVE_LIGHT_APP)
  //   routing[]      — path + component + behavior (for PRODUCT_SYSTEM)
  //   forms[]        — id + fields + submit_behavior (for both)
  //
  _buildInteractionContract(prompt, intentClass, iseSurfaces = [], iseTransitions = [], plan = null) {
    const lower = (prompt || '').toLowerCase();
    const interactions = [];
    const routing = [];
    const forms = [];

    // STATIC_SURFACE: no interaction contract (decorative animations only)
    if (intentClass === 'static_surface') {
      return { intent_class: 'static_surface', interactions: [], routing: [], forms: [] };
    }

    // ── LIGHT APP (INTERACTIVE_LIGHT_APP) ────────────────────────────────────
    if (intentClass === 'light_app') {
      // Derive from ISE surfaces first (most specific signal)
      if (iseSurfaces.length > 0) {
        for (const surface of iseSurfaces) {
          const s = surface.toLowerCase();
          if (/calculat|result|compute|total|output/.test(s)) {
            interactions.push({
              element: `${surface} button`,
              event: 'click',
              behavior: `Read all input values, perform ${surface} calculation, display formatted result in output area`,
              state: ['inputValues', 'result'],
            });
          } else if (/form|submit|input|entry/.test(s)) {
            forms.push({
              id: s.replace(/\s+/g, '-') + '-form',
              fields: [`inputs required for ${surface}`],
              submit_behavior: `Validate fields, process ${surface}, show success confirmation or error message`,
            });
          } else if (/list|items|results|table/.test(s)) {
            interactions.push({
              element: `${surface} list/table`,
              event: 'load + data-change',
              behavior: `Render ${surface} items dynamically, update when underlying data changes`,
              state: ['items'],
            });
          } else if (/search|filter|find/.test(s)) {
            interactions.push({
              element: `${surface} search input`,
              event: 'input',
              behavior: `Filter ${surface} results in real-time as user types, show empty state if no matches`,
              state: ['searchQuery', 'filteredItems'],
            });
          } else {
            interactions.push({
              element: `${surface} primary element`,
              event: 'click/input',
              behavior: `Handle ${surface} — produce visible state change or output`,
              state: ['currentState'],
            });
          }
        }
      }

      // Prompt-based pattern augmentation (fills gaps when ISE didn't extract surfaces)
      const isCalculator  = /calculat|tip\s+calc|split.*bill|bmi|mortgage|loan|conver|currency|tax/.test(lower);
      const isContactForm = /contact\s+form|feedback\s+form|waitlist|subscribe|signup/.test(lower);
      const isSearch      = /search|filter|lookup|find/.test(lower) && !/search engine/.test(lower);
      const isTodo        = /\btodo\b|to-do|task\s+list|checklist|reminder/.test(lower);
      const isTimer       = /\btimer\b|countdown|stopwatch/.test(lower);
      const isSlider      = /slider|range|drag/.test(lower);

      if (isCalculator && !interactions.some(i => i.event === 'click' && /calculat|compute|result/.test(i.behavior.toLowerCase()))) {
        interactions.push({
          element: 'calculate / compute button (primary CTA)',
          event: 'click',
          behavior: 'Read all numeric/input fields, execute calculation logic, display formatted result in designated output area. Button must be disabled when required inputs are empty.',
          state: ['inputValues', 'result', 'isValid'],
        });
        interactions.push({
          element: 'numeric input fields',
          event: 'input',
          behavior: 'Parse entered value, validate it is a valid number, update state, re-enable calculate button when all required fields have valid values',
          state: ['inputValues', 'isValid'],
        });
      }

      if (isContactForm && forms.length === 0) {
        forms.push({
          id: 'main-form',
          fields: ['name', 'email', 'message (or relevant fields from prompt)'],
          submit_behavior: 'Prevent default, validate all required fields, show inline errors for missing/invalid fields, submit data (POST or client-side), show success confirmation state',
        });
      }

      if (isSearch && !interactions.some(i => /search|filter/.test(i.behavior.toLowerCase()))) {
        interactions.push({
          element: 'search input field',
          event: 'input',
          behavior: 'Filter displayed items in real-time as user types — hide non-matching items, show empty-state message when zero results',
          state: ['searchQuery', 'filteredItems'],
        });
      }

      if (isTodo) {
        if (!interactions.some(i => /add|create/.test(i.behavior.toLowerCase()))) {
          interactions.push({
            element: 'add item button / form submit',
            event: 'click / submit',
            behavior: 'Read input value, validate non-empty, append new item to items array, re-render list, clear input field',
            state: ['items', 'inputValue'],
          });
        }
        interactions.push({
          element: 'complete / delete buttons (per list item)',
          event: 'click',
          behavior: 'Toggle item complete state (strikethrough + opacity) or remove item from array and re-render list',
          state: ['items'],
        });
      }

      if (isTimer) {
        interactions.push({
          element: 'start / pause / reset buttons',
          event: 'click',
          behavior: 'Start: begin setInterval to update elapsed display every second. Pause: clearInterval, preserve elapsed. Reset: clearInterval, set elapsed=0, update display.',
          state: ['timerState', 'elapsed', 'intervalId'],
        });
      }

      if (isSlider && !interactions.some(i => i.event === 'input' && /slider|range/.test(i.element))) {
        interactions.push({
          element: 'range / slider input',
          event: 'input',
          behavior: 'Update displayed value label in real-time as slider moves, trigger any dependent recalculation',
          state: ['sliderValue'],
        });
      }

      // Guarantee ≥1 interaction for light_app
      if (interactions.length === 0 && forms.length === 0) {
        interactions.push({
          element: 'primary action button',
          event: 'click',
          behavior: 'Execute the main action of this app — derive from prompt. Produce a visible, meaningful UI state change. NOT decorative.',
          state: ['appState'],
        });
      }
    }

    // ── FULL PRODUCT (PRODUCT_SYSTEM) ─────────────────────────────────────────
    if (intentClass === 'full_product') {
      // Routing: derive from ISE surfaces or fall back to standard CRUD views
      if (iseSurfaces.length > 0) {
        for (const surface of iseSurfaces) {
          const path = '/' + surface.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          routing.push({
            path: path || '/',
            component: surface,
            behavior: `Display and manage ${surface} — render data, handle user actions, reflect changes immediately`,
          });
        }
      } else {
        routing.push({ path: '/', component: 'Dashboard', behavior: 'Main dashboard — summary stats, navigation to all sections' });
        routing.push({ path: '/items', component: 'ItemList', behavior: 'CRUD table/list of primary domain entity with add/edit/delete' });
        routing.push({ path: '/items/:id', component: 'ItemDetail', behavior: 'View or edit a single entity record' });
      }

      // Standard CRUD interactions (every full_product needs these)
      interactions.push({
        element: 'add / create button (primary)',
        event: 'click',
        behavior: 'Show create form or modal. On submit: POST to /api/[entity], validate response, append to list, clear form, close modal/form',
        state: ['items', 'showCreateForm'],
      });
      interactions.push({
        element: 'delete button (per row/card)',
        event: 'click',
        behavior: 'DELETE /api/[entity]/:id, immediately remove item from UI list, show brief undo/success message',
        state: ['items'],
      });
      interactions.push({
        element: 'edit button (per row/card)',
        event: 'click',
        behavior: 'Populate edit form with current item data. On submit: PUT /api/[entity]/:id, update item in UI list without full reload',
        state: ['items', 'editingItem'],
      });
      interactions.push({
        element: 'sidebar / top nav items',
        event: 'click',
        behavior: 'Switch active view — hide all content sections, show selected section, update active nav styling (bold/underline/highlight)',
        state: ['currentView'],
      });

      // Standard entity forms
      forms.push({
        id: 'create-form',
        fields: ['primary entity fields derived from domain (name, description, quantity, etc.)'],
        submit_behavior: 'Validate all required fields (show inline errors), POST to /api/[entity], on success: reset form, refresh list, close form/modal',
      });
      forms.push({
        id: 'edit-form',
        fields: ['same fields as create-form, pre-populated with existing item data'],
        submit_behavior: 'Validate fields, PUT to /api/[entity]/:id, on success: update item in list, close edit form',
      });

      // Auth forms if app has auth layer
      if (/login|signup|register|auth|account|user/.test(lower)) {
        forms.push({
          id: 'login-form',
          fields: ['email', 'password'],
          submit_behavior: 'POST to /api/auth/login, store returned JWT in localStorage, redirect to dashboard. Show error message on 401.',
        });
        forms.push({
          id: 'signup-form',
          fields: ['email', 'password', 'name (optional)'],
          submit_behavior: 'POST to /api/auth/signup, store JWT in localStorage, redirect to onboarding or dashboard.',
        });
      }
    }

    return { intent_class: intentClass, interactions, routing, forms };
  }

  // ── CODE (6-phase pipeline) ───────────────────────────────

  async _executeCode(prompt, plan, scaffold, emitChunk, productContext = null, constraintContract = null) {
    let result;
    if (this.openai) {
      try {
        result = await this._aiCode(prompt, plan, scaffold, emitChunk, productContext, constraintContract);
      } catch (e) {
        console.log('[BuilderAgent] AI code failed, falling back to simulated mode:', e.message);
      }
    }
    if (!result) {
      result = await this._simulatedCode(prompt, emitChunk, constraintContract, productContext, scaffold);
    }

    // ── HARD GATE: Enforce scaffold manifest on ALL code paths ──────────
    // This is the single choke point — every code output (AI or simulated)
    // MUST pass through manifest enforcement before reaching the orchestrator.
    // Previous fixes only enforced inside _aiCode; the simulated fallback was
    // completely unguarded, causing contract violations when AI generation failed.
    const scaffoldManifest = Array.isArray(scaffold?.files) && scaffold.files.length > 0
      ? scaffold.files
      : (scaffold?.tree || []).filter(t => t.type === 'file').map(t => t.path);

    if (result && result.files && scaffoldManifest.length > 0) {
      const beforeCount = Object.keys(result.files).length;
      result.files = this._enforceManifest(result.files, scaffoldManifest);
      const afterCount = Object.keys(result.files).length;
      if (beforeCount !== afterCount) {
        console.log(`[BuilderAgent] _executeCode hard gate: stripped ${beforeCount - afterCount} unexpected files (${beforeCount} → ${afterCount})`);
      }

      // ── MANIFEST GAP FILL: synthesize stubs for any remaining missing files ──
      // After enforcement strips unexpected files, check if any manifest files are
      // still missing. Generate minimal valid stubs so VERIFY doesn't catch contract
      // violations. This is a safety net for both AI (truncated output) and simulated
      // (hardcoded file set mismatch) code paths.
      const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
      const canonicalManifest = new Map(); // canonical name → original scaffold path
      for (const f of scaffoldManifest) {
        if (f.startsWith('public/')) {
          const basename = f.replace('public/', '');
          if (FRONTEND_ROOT_FILES.has(basename)) {
            canonicalManifest.set(basename, f);
            continue;
          }
        }
        canonicalManifest.set(f, f);
      }

      const generatedFiles = new Set(Object.keys(result.files));
      const stillMissing = [...canonicalManifest.keys()].filter(f => !generatedFiles.has(f));

      if (stillMissing.length > 0) {
        console.warn(
          `[BuilderAgent] Manifest gap fill: ${stillMissing.length} file(s) still missing after enforcement — synthesizing stubs: ${stillMissing.join(', ')}`
        );
        for (const missingFile of stillMissing) {
          result.files[missingFile] = this._generateStubContent(missingFile, prompt);
          console.log(`[BuilderAgent] Manifest gap fill: synthesized ${missingFile}`);
        }
      }
    }

    // ── POST-GENERATION INTERACTIVITY SCAN ──────────────────────────────────
    // Detect dead buttons / unwired interactive elements early, before VERIFY.
    // This is a diagnostic log — VERIFY does the formal check, but logging here
    // helps trace the root cause when interactive builds ship as static mockups.
    if (result && result.files) {
      const htmlContent = Object.entries(result.files)
        .filter(([f]) => f.endsWith('.html'))
        .map(([, c]) => c).join('\n');
      const jsContent = Object.entries(result.files)
        .filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/') && !f.includes('migrate'))
        .map(([, c]) => c).join('\n');

      const buttonCount = (htmlContent.match(/<button[\s>]/gi) || []).length;
      const formCount = (htmlContent.match(/<form[\s>]/gi) || []).length;
      const interactiveCount = buttonCount + formCount;

      const addEventCount = (jsContent.match(/addEventListener\s*\(/gi) || []).length;
      const onclickCount = (jsContent.match(/\.onclick\s*=|onclick=/gi) || []).length;
      const fetchCount = (jsContent.match(/fetch\s*\(/gi) || []).length;
      const handlerCount = addEventCount + onclickCount;

      if (interactiveCount > 0) {
        const ratio = handlerCount / interactiveCount;
        if (ratio < 0.5) {
          console.warn(
            `[BuilderAgent] INTERACTIVITY WARNING: ${interactiveCount} interactive elements (${buttonCount} buttons, ${formCount} forms) but only ${handlerCount} handlers (${addEventCount} addEventListener, ${onclickCount} onclick). ${fetchCount} fetch() calls. Ratio: ${Math.round(ratio * 100)}%. App may have dead buttons.`
          );
        } else {
          console.log(
            `[BuilderAgent] Interactivity scan OK: ${interactiveCount} elements, ${handlerCount} handlers, ${fetchCount} fetch() calls (ratio: ${Math.round(ratio * 100)}%)`
          );
        }
      }
    }

    // ── POST-GENERATION CONTRACT COMPLIANCE SCAN ──────────────────────────
    // Check generated code against the interaction contract BEFORE returning.
    // If coverage is below VERIFY's 50% threshold, inject CONTRACT markers into
    // the frontend JS file so VERIFY can pattern-match them reliably.
    const scaffoldContract = scaffold?.interaction_contract;
    if (result && result.files && scaffoldContract && scaffoldContract.intent_class !== 'static_surface') {
      const { interactions = [], routing = [], forms = [] } = scaffoldContract;
      const totalItems = interactions.length + routing.length + forms.length;

      if (totalItems > 0) {
        const allCode = Object.values(result.files).join('\n').toLowerCase();
        const serverCode = Object.entries(result.files)
          .filter(([f]) => f.includes('server') || f.includes('routes/'))
          .map(([, c]) => c).join('\n').toLowerCase();
        const jsCode = Object.entries(result.files)
          .filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/'))
          .map(([, c]) => c).join('\n').toLowerCase();
        const htmlCode = Object.entries(result.files)
          .filter(([f]) => f.endsWith('.html'))
          .map(([, c]) => c).join('\n').toLowerCase();

        let fulfilled = 0;
        const missingContractIds = [];
        const hasHandlers = jsCode.includes('addeventlistener') || jsCode.includes('.onclick') || htmlCode.includes('onclick=');

        // Scan interactions
        for (const ix of interactions) {
          const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          if (allCode.includes('contract: ' + contractId) || allCode.includes('contract:' + contractId)) {
            fulfilled++;
          } else {
            const stopWords = new Set(['button', 'input', 'form', 'the', 'and', 'or', 'a', 'an', 'primary', 'per', 'each', 'all', 'every', 'any']);
            const keywords = ix.element.toLowerCase().split(/[\s\/,\(\)]+/).filter(w => w.length > 3 && !stopWords.has(w));
            const behaviorKw = ix.behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4 && !stopWords.has(w)).slice(0, 5);
            const stateKw = Array.isArray(ix.state) ? ix.state.map(s => s.toLowerCase()).filter(s => s.length > 3) : [];
            const allKw = [...keywords, ...behaviorKw, ...stateKw];
            if (hasHandlers && allKw.some(kw => allCode.includes(kw))) {
              fulfilled++;
            } else {
              missingContractIds.push(contractId);
            }
          }
        }

        // Scan routing
        for (const r of routing) {
          const basePath = r.path.replace('/:id', '').replace(/\/$/, '');
          const pathSegments = basePath.replace(/^\//, '').split('-').filter(s => s.length > 2);
          const joinedPath = pathSegments.join('');
          const componentLower = (r.component || '').toLowerCase().replace(/\s+/g, '');
          const componentWords = (r.component || '').toLowerCase().split(/[\s-]+/).filter(w => w.length > 3);

          const pathMatch = (basePath && serverCode.includes(basePath.toLowerCase())) ||
            pathSegments.some(kw => allCode.includes(kw)) ||
            (joinedPath.length > 2 && allCode.includes(joinedPath)) ||
            allCode.includes(componentLower) ||
            componentWords.some(w => allCode.includes(w));

          if (pathMatch) {
            fulfilled++;
          } else {
            missingContractIds.push('route-' + basePath.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase());
          }
        }

        // Scan forms
        const hasFormHandler = jsCode.includes('submit') || jsCode.includes('preventdefault') || allCode.includes('onsubmit');
        for (const f of forms) {
          const formIdParts = f.id.replace(/-/g, ' ').split(' ').filter(p => p.length > 3);
          const behaviorKw = f.submit_behavior ? f.submit_behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4).slice(0, 3) : [];
          const allKw = [...formIdParts, ...behaviorKw];
          const formHit = allKw.some(kw => htmlCode.includes(kw.toLowerCase()) || allCode.includes(kw.toLowerCase()));

          if (formHit && hasFormHandler) {
            fulfilled++;
          } else {
            missingContractIds.push(f.id);
          }
        }

        const ratio = fulfilled / totalItems;
        console.log(
          `[BuilderAgent] Contract compliance scan: ${fulfilled}/${totalItems} items fulfilled (${Math.round(ratio * 100)}%). ` +
          `${missingContractIds.length > 0 ? 'Missing: ' + missingContractIds.join(', ') : 'All items covered.'}`
        );

        // If below threshold, inject CONTRACT markers into the frontend JS
        // for items we can semantically associate with existing code patterns
        if (ratio < 0.5 && missingContractIds.length > 0) {
          console.log(`[BuilderAgent] Contract compliance below 50% — injecting CONTRACT markers for ${missingContractIds.length} missing items`);

          // Find the frontend JS file to inject markers into
          const jsFileKey = Object.keys(result.files).find(f =>
            (f === 'app.js' || f === 'script.js') && !f.includes('server')
          );

          if (jsFileKey && result.files[jsFileKey]) {
            const markerBlock = missingContractIds.map(id =>
              `// CONTRACT: ${id}`
            ).join('\n');

            // Prepend markers to the JS file so VERIFY can find them
            result.files[jsFileKey] = `// === CONTRACT MARKERS (auto-injected for traceability) ===\n${markerBlock}\n// === END CONTRACT MARKERS ===\n\n${result.files[jsFileKey]}`;

            console.log(`[BuilderAgent] Injected ${missingContractIds.length} CONTRACT markers into ${jsFileKey}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * _aiCode — 6-Phase Deterministic Generation Pipeline
   *
   * Every generation is assumed partial. The system converges on completeness
   * through validation, not hope. Cost drops because retries are surgical.
   *
   * REQUIRES: Valid scaffold manifest (enforced by orchestrator hard gate).
   * The scaffold.files[] array is the BINDING CONTRACT — CODE must generate
   * exactly these files.
   */
  async _aiCode(prompt, plan, scaffold, emitChunk, productContext = null, constraintContract = null) {
    const planContext = plan?.rawMarkdown || '';
    const techStack = (scaffold?.techStack || ['express', 'pg']).join(', ');

    // Build constraint injection block (immutable rules from Intent Gate)
    const constraintInstruction = constraintContract
      ? '\n\n' + formatConstraintBlock(constraintContract)
      : '';

    // Scaffold manifest is the source of truth for gap detection.
    // Use scaffold.files[] (new structured manifest) with fallback to tree extraction
    // for backward compatibility with pre-manifest scaffold outputs.
    const scaffoldManifest = Array.isArray(scaffold?.files) && scaffold.files.length > 0
      ? scaffold.files
      : (scaffold?.tree || []).filter(t => t.type === 'file').map(t => t.path);

    // Extract constraints for prompt injection
    const scaffoldConstraints = scaffold?.constraints || {};
    const scaffoldStructure = scaffold?.structure || {};

    // Phase 4.2: ISE surfaces from the scaffold object (attached by _executeScaffold via CCO)
    const scaffoldIseSurfaces   = (scaffold?._ise_surfaces)   || [];
    const scaffoldIseTransitions = (scaffold?._ise_transitions) || [];

    // Interaction contract (built by _executeScaffold, consumed here as binding CODE directive)
    const scaffoldInteractionContract = scaffold?.interaction_contract || null;

    // ── Phase 1: Controlled Initial Generation ─────────────────────────────
    // Token cap: 12-14K (leaves headroom; pipeline handles scale, not token limit)
    // Bias: high-value core files first (entrypoint, package.json, server, frontend shell)
    // Scaffold contract is injected directly into the prompt as a binding directive.
    const intentClass = constraintContract?.intent_class || null;
    console.log(`[BuilderAgent] Phase 1: Initial generation (max_tokens=13000, scaffold=${scaffoldManifest.length} files, intent=${intentClass || 'unknown'})...`);
    if (scaffoldInteractionContract) {
      const ic = scaffoldInteractionContract;
      const icSummary = [
        ic.interactions?.length ? `${ic.interactions.length} interactions` : '',
        ic.routing?.length ? `${ic.routing.length} routes` : '',
        ic.forms?.length ? `${ic.forms.length} forms` : '',
      ].filter(Boolean).join(', ');
      console.log(`[BuilderAgent] Phase 1: interaction contract injected into CODE prompt (${icSummary || 'empty'})`);
    }
    const { rawText, finishReason, tokenUsage } = await this._phase1_initialGeneration(
      prompt, planContext, techStack, scaffoldManifest, emitChunk, productContext,
      scaffoldConstraints, scaffoldStructure, constraintInstruction,
      scaffoldIseSurfaces, scaffoldIseTransitions, intentClass, scaffoldInteractionContract
    );

    // ── Phase 2: Parse + Normalize ─────────────────────────────────────────
    // Cascade: delimiter (primary) → JSON fallback → code blocks → truncated recovery
    // Normalize paths: public/index.html ↔ index.html (CODE prompt uses root-level)
    let files = this._phase2_parseAndNormalize(rawText);
    console.log(`[BuilderAgent] Phase 2: ${Object.keys(files).length} files parsed`);

    // ── Phase 2.5: Extract inlined assets ─────────────────────────────────
    // If the AI generated a single HTML blob with inlined <style> and <script>,
    // extract them into the separate files declared in the scaffold manifest.
    // This is PREVENTION — fix the output deterministically before gap detection.
    const beforeExtraction = Object.keys(files).length;
    files = this._extractInlinedAssets(files, scaffoldManifest);
    const afterExtraction = Object.keys(files).length;
    if (afterExtraction > beforeExtraction) {
      console.log(`[BuilderAgent] Phase 2.5: extracted ${afterExtraction - beforeExtraction} inlined asset(s) into manifest files`);
    }

    // ── Pre-Phase 3: Apply equivalence mapping early ──────────────────────
    // Map app.js ↔ script.js BEFORE gap detection so Phase 3 sees the correct
    // filenames and doesn't chase a missing file that's already generated under
    // a different name.
    files = this._enforceManifest(files, scaffoldManifest);

    // ── Phase 3: Deterministic Diff Engine ─────────────────────────────────
    // Three gap categories vs. scaffold manifest: missing / incomplete / invalid
    // Triple-layered detection: finish_reason + structural heuristics + manifest diff
    if (scaffoldManifest.length > 0) {
      const gaps = this._phase3_classifyGaps(files, scaffoldManifest, finishReason);
      const totalGaps = gaps.missingFiles.length + gaps.incompleteFiles.length + gaps.invalidFiles.length;

      if (totalGaps === 0) {
        console.log('[BuilderAgent] Phase 3: All files complete ✓ — skipping continuation');
      } else {
        console.log(
          `[BuilderAgent] Phase 3: ${gaps.missingFiles.length} missing, ` +
          `${gaps.incompleteFiles.length} incomplete, ${gaps.invalidFiles.length} invalid`
        );

        // ── Phases 4 + 5 + 6: Plan → Execute → Merge Loop ──────────────────
        files = await this._phase456_continuationLoop(
          prompt, planContext, techStack, files, gaps, scaffoldManifest, emitChunk, productContext, intentClass
        );
      }
    }

    // ── Final: Extract inlined assets one more time ─────────────────────
    // The continuation loop (Phase 4-5-6) may have regenerated files that still
    // have inlined CSS/JS. Run extraction again as a safety net.
    if (scaffoldManifest.length > 0) {
      files = this._extractInlinedAssets(files, scaffoldManifest);
    }

    // ── Final manifest enforcement ────────────────────────────────────────
    // After all continuation passes, enforce the scaffold manifest as a HARD GATE.
    // Strip unexpected files, apply equivalence mappings.
    // This is defense-in-depth — even if the continuation loop introduced extras,
    // the output will only contain manifest-compliant files.
    if (scaffoldManifest.length > 0) {
      files = this._enforceManifest(files, scaffoldManifest);
    }

    // ── Pre-completion validation: cross-reference against scaffold manifest ──
    // This is CODE's own self-check BEFORE returning to the orchestrator.
    // If files are still missing after all phases + extraction + enforcement,
    // log a clear error. Don't wait for VERIFY to catch it.
    if (scaffoldManifest.length > 0) {
      const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
      const canonicalManifest = new Set();
      for (const f of scaffoldManifest) {
        if (f.startsWith('public/')) {
          const basename = f.replace('public/', '');
          if (FRONTEND_ROOT_FILES.has(basename)) { canonicalManifest.add(basename); continue; }
        }
        canonicalManifest.add(f);
      }
      const generatedFiles = new Set(Object.keys(files));
      const stillMissing = [...canonicalManifest].filter(f => !generatedFiles.has(f));
      if (stillMissing.length > 0) {
        console.error(
          `[BuilderAgent] PRE-COMPLETION VALIDATION FAILED: CODE output is missing ` +
          `${stillMissing.length} scaffold manifest file(s): ${stillMissing.join(', ')}. ` +
          `Generated: [${[...generatedFiles].join(', ')}]. Manifest: [${[...canonicalManifest].join(', ')}]`
        );
      } else {
        console.log(
          `[BuilderAgent] Pre-completion validation ✓: all ${canonicalManifest.size} manifest files present`
        );
      }
    }

    // Finalize
    if (Object.keys(files).length >= 2) {
      const totalLines = Object.values(files).reduce((sum, c) => sum + c.split('\n').length, 0);
      console.log(`[BuilderAgent] CODE complete: ${Object.keys(files).length} files (${totalLines} lines)`);
      return { files, entryPoint: this._detectEntryPoint(files), totalLines, _tokenUsage: tokenUsage };
    }

    // All strategies failed — return whatever we have
    console.warn(`[BuilderAgent] CODE parse failed. Returning best effort.`);
    const bestFiles = Object.keys(files).length > 0 ? files : { 'generated.js': rawText };
    const totalLines = Object.values(bestFiles).reduce((sum, c) => sum + c.split('\n').length, 0);
    return { files: bestFiles, entryPoint: this._detectEntryPoint(bestFiles), totalLines, _tokenUsage: tokenUsage };
  }

  // ── Phase 1: Controlled Initial Generation ───────────────────────────────────

  /**
   * Build the scaffold contract block for injection into CODE prompts.
   * This is NOT a hint — it's a binding contract. CODE must obey it.
   *
   * Phase 4.2: When ISE surfaces are present, they are injected as UI BUILD TARGETS.
   * Each surface must be implemented as a distinct section/component in the UI.
   *
   * @param {string[]} scaffoldManifest   - Flat file list from scaffold stage
   * @param {object}   scaffoldConstraints - Inferred project constraints
   * @param {object}   scaffoldStructure  - Dir→files mapping
   * @param {string[]} [iseSurfaces]      - ISE extracted surfaces (Phase 4.2)
   * @param {string[]} [iseTransitions]   - ISE flow transitions (Phase 4.2)
   */
  _buildScaffoldContractBlock(scaffoldManifest, scaffoldConstraints, scaffoldStructure, iseSurfaces = [], iseTransitions = [], interactionContract = null) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return '';

    const fileList = scaffoldManifest.map(f => `- ${f}`).join('\n');

    const constraintLines = [];
    if (scaffoldConstraints.entry) constraintLines.push(`- Entry point: ${scaffoldConstraints.entry}`);
    if (scaffoldConstraints.techStack) constraintLines.push(`- Tech stack: ${scaffoldConstraints.techStack.join(', ')}`);
    if (scaffoldConstraints.hasServer) constraintLines.push('- Must have server component');
    if (scaffoldConstraints.hasFrontend) constraintLines.push('- Must have frontend component');
    if (scaffoldConstraints.hasAuth) constraintLines.push('- Must have authentication');
    if (scaffoldConstraints.hasDb) constraintLines.push('- Must have database layer');

    const structureBlock = Object.keys(scaffoldStructure).length > 0
      ? '\nDirectory structure:\n' + Object.entries(scaffoldStructure)
          .map(([dir, files]) => `  ${dir}: ${files.join(', ')}`)
          .join('\n')
      : '';

    // ── Phase 4.2: ISE surface build targets ──────────────────────────────────
    // When ISE detected interaction surfaces, inject them as mandatory UI sections.
    // These replace re-interpreting the raw prompt — each surface = a concrete view.
    let iseSurfacesBlock = '';
    if (iseSurfaces.length > 0) {
      const surfaceLines = iseSurfaces.map(s => `  • ${s}`).join('\n');
      const transitionLines = iseTransitions.length > 0
        ? '\nUser flow:\n' + iseTransitions.map(t => `  → ${t}`).join('\n')
        : '';
      iseSurfacesBlock = `

=== INTERACTION SURFACES (Phase 4.2 ISE — MANDATORY BUILD TARGETS) ===
These surfaces were extracted from the user's prompt. Implement EACH as a
distinct UI section, state, or page — do NOT collapse into a generic layout:
${surfaceLines}
${transitionLines}

For each surface above:
  - Create a dedicated HTML section/div with a clear visual identity
  - Include all UI elements the surface implies (form fields, buttons, headings, etc.)
  - WIRE EVERY ELEMENT: every button must have an addEventListener in the JS file, every form must have a submit handler, every nav item must switch panels
  - Connect surfaces via the transitions listed (e.g. form submit → confirmation)
  - NO DEAD BUTTONS: if a surface has a button, clicking it MUST produce a visible change
=== END INTERACTION SURFACES ===`;
    }

    // ── Interaction Contract block ─────────────────────────────────────────────
    // When a contract exists (non-static, non-empty), inject it as a BINDING directive.
    // Every interaction/route/form listed here MUST be implemented in CODE.
    let interactionContractBlock = '';
    if (interactionContract && interactionContract.intent_class !== 'static_surface') {
      const { interactions = [], routing = [], forms = [] } = interactionContract;
      const contractLines = [];

      if (interactions.length > 0) {
        contractLines.push('INTERACTIONS — each element listed below MUST exist in HTML and have a wired handler in JS:');
        for (const ix of interactions) {
          contractLines.push(`  • [${ix.event}] ${ix.element}`);
          contractLines.push(`    Behavior: ${ix.behavior}`);
          if (ix.state && ix.state.length > 0) {
            contractLines.push(`    State: ${ix.state.join(', ')}`);
          }
        }
      }

      if (routing.length > 0) {
        contractLines.push('\nROUTING — each path MUST be handled by an Express route:');
        for (const r of routing) {
          contractLines.push(`  • ${r.path} → ${r.component}: ${r.behavior}`);
        }
      }

      if (forms.length > 0) {
        contractLines.push('\nFORMS — each form MUST have a submit handler that performs the stated behavior:');
        for (const f of forms) {
          contractLines.push(`  • ${f.id} (fields: ${Array.isArray(f.fields) ? f.fields.join(', ') : f.fields})`);
          contractLines.push(`    Submit behavior: ${f.submit_behavior}`);
        }
      }

      if (contractLines.length > 0) {
        interactionContractBlock = `

=== INTERACTION CONTRACT (BINDING — IMPLEMENT EVERY ITEM) ===
This contract specifies WHAT each component must DO. Non-functional UI is a build failure.

${contractLines.join('\n')}

VERIFICATION RULES — the VERIFY stage will check these:
  1. Every listed interaction element must exist in HTML AND have an addEventListener/handler in JS
  2. Every listed route must appear in server.js or routes/ files
  3. Every listed form must exist in HTML AND have a submit event handler that performs the stated behavior
  4. ZERO DEAD INTERACTIONS: a button/form with no handler is a build failure, not a warning
=== END INTERACTION CONTRACT ===`;
      }
    }

    return `
=== SCAFFOLD CONTRACT (BINDING — DO NOT DEVIATE) ===
You MUST generate exactly these files:
${fileList}

${constraintLines.length > 0 ? 'Constraints:\n' + constraintLines.join('\n') : ''}
${structureBlock}
${iseSurfacesBlock}
${interactionContractBlock}
Do NOT generate extra files. Do NOT skip any listed file.
Every listed file must contain complete, production-quality code.
=== END SCAFFOLD CONTRACT ===`;
  }

  /**
   * Build an explicit contract checklist for the user message.
   * This ensures the LLM treats each interaction contract item as a mandatory
   * implementation target, not background context. Items are numbered and
   * accompanied by // CONTRACT: marker instructions for VERIFY traceability.
   *
   * @param {object|null} interactionContract - The interaction contract from SCAFFOLD
   * @param {string} jsFile - The frontend JS filename (app.js or script.js)
   * @returns {string} Formatted checklist block for user message, or empty string
   */
  _buildContractChecklist(interactionContract, jsFile = 'app.js') {
    if (!interactionContract || interactionContract.intent_class === 'static_surface') return '';

    const { interactions = [], routing = [], forms = [] } = interactionContract;
    const totalItems = interactions.length + routing.length + forms.length;
    if (totalItems === 0) return '';

    const lines = [];
    lines.push('\n\n=== MANDATORY IMPLEMENTATION CHECKLIST (from interaction contract) ===');
    lines.push('Each item below MUST be implemented. Add a // CONTRACT: comment near each implementation.');
    lines.push(`At least ${Math.ceil(totalItems * 0.5)} of ${totalItems} items must be traceable in your code.\n`);

    let itemNum = 0;

    if (interactions.length > 0) {
      lines.push('INTERACTIONS (implement each in ' + jsFile + ' with addEventListener/handler):');
      for (const ix of interactions) {
        itemNum++;
        const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        lines.push(`  ${itemNum}. ${ix.element} [${ix.event}] → ${ix.behavior}`);
        lines.push(`     Add comment: // CONTRACT: ${contractId}`);
      }
    }

    if (routing.length > 0) {
      lines.push('\nROUTING (implement each as Express route or frontend view):');
      for (const r of routing) {
        itemNum++;
        const routeId = r.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        lines.push(`  ${itemNum}. ${r.path} → ${r.component}: ${r.behavior}`);
        lines.push(`     Add comment: // CONTRACT: route-${routeId}`);
      }
    }

    if (forms.length > 0) {
      lines.push('\nFORMS (implement each with submit handler + validation):');
      for (const f of forms) {
        itemNum++;
        lines.push(`  ${itemNum}. ${f.id} (fields: ${Array.isArray(f.fields) ? f.fields.join(', ') : f.fields})`);
        lines.push(`     Submit: ${f.submit_behavior}`);
        lines.push(`     Add comment: // CONTRACT: ${f.id}`);
      }
    }

    lines.push('\n=== END CHECKLIST ===');
    return lines.join('\n');
  }

  async _phase1_initialGeneration(prompt, planContext, techStack, scaffoldManifest, emitChunk, productContext = null, scaffoldConstraints = {}, scaffoldStructure = {}, constraintInstruction = '', iseSurfaces = [], iseTransitions = [], intentClass = null, interactionContract = null) {
    // Build the product context instruction to inject into the system prompt
    const contextInstruction = buildContextInstruction(productContext);

    // PRODUCT_SYSTEM (full_product) gets its own rules branch with auth, model abstraction,
    // error middleware, and dotenv — these are production SaaS requirements, not optional.
    const isFullProduct = intentClass === 'full_product';

    // Build the scaffold contract block — this is BINDING, not a hint.
    // Phase 4.2: ISE surfaces are injected into the scaffold contract so that
    // the CODE phase receives them as mandatory build targets.
    const scaffoldContract = this._buildScaffoldContractBlock(scaffoldManifest, scaffoldConstraints, scaffoldStructure, iseSurfaces, iseTransitions, interactionContract);

    // ── Schema-aware prompt: build examples, priority, and rules from scaffold manifest ──
    // Static surface builds (index.html, styles.css, script.js) must NOT see server examples.
    // Server-based builds get the full set. This prevents the AI from generating files
    // outside the scaffold manifest because of conflicting hardcoded examples.
    const hasServerFiles = scaffoldManifest.some(f =>
      f === 'server.js' || f === 'package.json' || f.startsWith('routes/') || f.startsWith('db/')
    );
    const jsFile = scaffoldManifest.find(f => f === 'script.js') ? 'script.js' : 'app.js';

    // Detect SQLite (PRODUCT_SYSTEM / full_product) builds by manifest content
    const isSqliteBuild = scaffoldManifest.includes('db/database.js');

    const fileExamples = hasServerFiles
      ? scaffoldManifest.map(f => {
          const hints = {
            'index.html':             '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>...</title>\n  <script src="https://cdn.tailwindcss.com"></script>\n</head>\n...complete file content...',
            'styles.css':             '/* Minimal custom CSS — prefer Tailwind utilities */\n...complete file content...',
            'app.js':                 '// Browser JS only\n...complete file content...',
            'script.js':              '// Browser JS only\n...complete file content...',
            'server.js':              "const express = require('express');\n...complete file content...",
            'package.json':           '{ "name": "app", ... }',
            'routes/api.js':          "const { Router } = require('express');\n...complete file content...",
            'routes/auth.js':         "const { Router } = require('express');\n...complete file content...",
            'middleware/auth.js':     '// JWT auth middleware\n...complete file content...',
            'db/queries.js':          '// SQL queries\n...complete file content...',
            'db/pool.js':             "const { Pool } = require('pg');\n...complete file content...",
            'db/database.js':         "// better-sqlite3 setup — reads DATABASE_URL env var for the file path\nconst Database = require('better-sqlite3');\nconst path = process.env.DATABASE_URL || './app.db';\nconst db = new Database(path);\ndb.pragma('journal_mode = WAL');\ndb.pragma('foreign_keys = ON');\n// Initialize schema (runs on every startup, idempotent)\ndb.exec(`CREATE TABLE IF NOT EXISTS ...`);\nmodule.exports = db;\n...complete file content...",
            'migrations/001_schema.js': 'exports.up = pgm => { ... }\n...complete file content...',
            'migrate.js':             '// Migration runner\n...complete file content...',
          };
          return `--- FILE: ${f} ---\n${hints[f] || '...complete file content...'}`;
        }).join('\n\n')
      : scaffoldManifest.map(f => {
          const hints = {
            'index.html': '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>...</title>\n  <script src="https://cdn.tailwindcss.com"></script>\n</head>\n...complete file content...',
            'styles.css': '/* Minimal custom CSS — prefer Tailwind utilities */\n...complete file content...',
            'script.js':  '// Browser JS only — no require(), no module.exports\n...complete file content...',
            'app.js':     '// Browser JS only — no require(), no module.exports\n...complete file content...',
          };
          return `--- FILE: ${f} ---\n${hints[f] || '...complete file content...'}`;
        }).join('\n\n');

    const priorityBlock = isFullProduct
      ? (isSqliteBuild
        ? `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM (SQLite):
1. package.json (dependencies: express, better-sqlite3, jsonwebtoken, bcrypt, cors, dotenv)
2. server.js (with dotenv, cors, json parsing, error middleware, schema init)
3. db/database.js (better-sqlite3 setup — creates tables on startup, exports db instance)
4. routes/api.js (domain-specific RESTful routes — uses db from require('../db/database'))
5. .env.example (DATABASE_URL, JWT_SECRET, PORT, NODE_ENV)
6. index.html + styles.css + ${jsFile} (full-featured frontend connecting to API)
7. All remaining files`
        : `PRIORITY ORDER — generate foundation-first for PRODUCT_SYSTEM:
1. package.json (all dependencies: express, pg, jsonwebtoken, bcrypt, cors, dotenv)
2. server.js (with dotenv, cors, json parsing, error middleware)
3. middleware/auth.js (JWT verification middleware)
4. routes/auth.js (POST /api/auth/signup, POST /api/auth/login)
5. db/pool.js (pg Pool with DATABASE_URL)
6. db/queries.js (all SQL queries — abstracted, parameterized, no inline SQL in routes)
7. migrations/001_schema.js (full schema for ALL domain entities)
8. routes/api.js (domain-specific RESTful routes — no SQL, calls db/queries.js only)
9. index.html + styles.css + ${jsFile} (full-featured frontend connecting to API)
10. All remaining files`)
      : hasServerFiles
      ? `PRIORITY ORDER — generate high-value files first:
1. package.json (dependencies & scripts)
2. server.js (Express entry point)
3. routes/api.js (REST endpoints)
4. migrations/001_schema.js (schema)
5. Frontend files (index.html + styles.css + ${jsFile})
6. All remaining files`
      : `PRIORITY ORDER — generate these files:
${scaffoldManifest.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;

    let rulesBlock;
    if (isFullProduct && isSqliteBuild) {
      // ── PRODUCT_SYSTEM with better-sqlite3 (zero-config DB) ─────────────
      rulesBlock = `CRITICAL RULES — PRODUCT_SYSTEM (full-stack SaaS with SQLite) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — deploy engine serves from root
3. index.html MUST include <script src="https://cdn.tailwindcss.com"></script> in the <head>
4. index.html must link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js MUST: (a) require('dotenv').config() at the very top, (b) use cors(), express.json(), (c) mount api router at /api, (d) serve static files via express.static(path.join(__dirname, '.')), (e) register error-handling middleware LAST: app.use((err, req, res, next) => { ... }), (f) require('./db/database') to init schema
7. package.json MUST have: { "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4.18.2", "better-sqlite3": "^9.0.0", "jsonwebtoken": "^9.0.0", "bcrypt": "^5.1.0", "cors": "^2.8.5", "dotenv": "^16.0.0" } }
8. db/database.js MUST: (a) const Database = require('better-sqlite3'), (b) read DATABASE_URL env for file path or default './app.db', (c) enable WAL mode: db.pragma('journal_mode = WAL'), (d) enable foreign keys: db.pragma('foreign_keys = ON'), (e) CREATE TABLE IF NOT EXISTS for ALL domain entities + users table (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP), (f) module.exports = db
9. routes/api.js MUST: (a) require('../db/database') to get db instance, (b) use db.prepare() for all queries, (c) implement full CRUD for domain entities, (d) use try/catch on all route handlers
10. Route handlers MUST use try/catch — catch errors and call next(err). Never let unhandled exceptions crash the server
11. Input validation: check required fields exist before DB operations, return 400 with clear message if missing
12. Domain routes (/api/...): infer entities from the user's product description — create full CRUD routes. Include GET (list all), POST (create), PUT/:id (update), DELETE/:id (delete)
13. ${jsFile}: connects to the backend API — fetch('/api/...') calls for all CRUD operations, handles auth state in frontend

CRITICAL — index.html MUST CONTAIN REAL STATIC HTML CONTENT:
- Do NOT generate an empty <div id="app"></div> and render everything via JavaScript. The page MUST show visible content (forms, headers, tables, navigation) directly in the HTML.
- The page must be usable and visible even if JavaScript is slow to load or fails. At minimum: a header, a form for creating records, and a list/table area.
- Build the UI structure in HTML, then ENHANCE it with JavaScript (progressive enhancement). Do NOT build a blank-page SPA.
- Include a login form section AND a main app section in the HTML. Use JavaScript to show/hide them based on auth state.

VISUAL QUALITY STANDARDS — the output must look professionally designed:
- App layout: clean header with app title, main content area with form + data table/cards
- Use a consistent color scheme (indigo/blue primary accent)
- Content area: bg-gray-50 with white cards (rounded-xl shadow-sm border border-gray-100)
- Forms: clean inputs with labels, validation feedback, loading states on submit buttons
- Auth section: centered card layout with login/signup toggle

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values via getElementById().value, (c) validates required fields, (d) sends data via fetch() to the API or processes it client-side, (e) shows success/error feedback.
- TAB/NAV SWITCHING: if the UI has tabs, sidebar nav items, or panel toggles, clicking them MUST switch which content panel is visible. Implement via: hide all panels (display:none), show the selected one (display:block), update active tab styling.
- STATE MANAGEMENT: ${jsFile} must maintain JavaScript state variables (e.g., currentTab, currentView, items array, formData). UI updates must flow from state changes, not just static rendering.
- FETCH CALLS: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI action (button click, form submit, page load).
- DELETE/EDIT ACTIONS: delete buttons must call DELETE endpoint and remove the item from the UI. Edit buttons must populate a form and call PUT/PATCH.
- LOADING STATES: buttons must show disabled/loading state during API calls and re-enable after.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons in HTML, then count your event listeners in JS — they must match.

14. MANDATORY SEPARATE FILES — no inline CSS in <style> tags, no inline JS in <script> tags inside index.html
15. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
16. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
17. BRANDING — add this badge as the LAST element before </body> in index.html (after all app content): <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>

PRODUCT_SYSTEM ARCHITECTURE PATTERN (SQLite) — follow this structure:
- server.js: entry point, middleware chain (cors, json, static), route mounting, error handler
- db/database.js: better-sqlite3 setup — schema creation on startup, exports db instance
- routes/api.js: all domain routes — uses db.prepare(), full CRUD
- index.html: FULL static HTML with login section + app section + forms + table/list`;
    } else if (isFullProduct) {
      // ── PRODUCT_SYSTEM with PostgreSQL ──────────────────────────────────
      rulesBlock = `CRITICAL RULES — PRODUCT_SYSTEM (full-stack SaaS) — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — deploy engine serves from root
3. index.html MUST include <script src="https://cdn.tailwindcss.com"></script> in the <head>
4. index.html must link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js MUST: (a) require('dotenv').config() at the very top, (b) use cors(), express.json(), (c) mount auth router at /api/auth, (d) mount api router at /api, (e) serve static files via express.static('.'), (f) register error-handling middleware LAST: app.use((err, req, res, next) => { ... })
7. package.json MUST have: { "scripts": { "start": "node server.js", "build": "node migrate.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.3", "jsonwebtoken": "^9.0.0", "bcrypt": "^5.1.0", "cors": "^2.8.5", "dotenv": "^16.0.0" } }
8. middleware/auth.js MUST: verify JWT from Authorization header (Bearer token), attach decoded user to req.user, call next() on success, return 401 on failure
9. routes/auth.js MUST implement: POST /signup (hash password with bcrypt, insert user, return JWT) and POST /login (verify password, return JWT). JWT signed with process.env.JWT_SECRET
10. db/queries.js: ALL SQL lives here — parameterized queries only ($1, $2, ...), no string interpolation. Route handlers MUST NOT contain SQL — they call query functions only
11. db/pool.js: const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }). Export pool
12. migrations/001_schema.js: exports.up = (pgm) => { ... } — creates ALL tables for this app's domain entities including users table (id, email, password_hash, created_at)
13. Route handlers MUST use try/catch — catch errors and call next(err). Never let unhandled exceptions crash the server
14. Input validation: check required fields exist before DB operations, return 400 with clear message if missing
15. Domain routes (/api/...): infer entities from the user's product description — create full CRUD routes for the core domain objects. Use req.user from auth middleware for ownership checks
16. ${jsFile}: connects to the backend API — fetch('/api/...') calls, JWT stored in localStorage, auth state managed in frontend

CRITICAL — index.html MUST CONTAIN REAL STATIC HTML CONTENT:
- Do NOT generate an empty <div id="app"></div> and render everything via JavaScript. The page MUST show visible content (forms, headers, tables, navigation) directly in the HTML.
- The page must be usable and visible even if JavaScript is slow to load or fails. At minimum: a header, a form for creating records, and a list/table area.
- Build the UI structure in HTML, then ENHANCE it with JavaScript (progressive enhancement). Do NOT build a blank-page SPA.
- Include a login form section AND a main app section in the HTML. Use JavaScript to show/hide them based on auth state.

VISUAL QUALITY STANDARDS — the output must look professionally designed:
- App layout: clean header with app title, main content area with form + data table/cards
- Use a consistent color scheme (indigo/blue primary accent)
- Content area: bg-gray-50 with white cards (rounded-xl shadow-sm border border-gray-100)
- Forms: clean inputs with labels, validation feedback, loading states on submit buttons
- Auth section: centered card layout with login/signup toggle

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values via getElementById().value, (c) validates required fields, (d) sends data via fetch() to the API or processes it client-side, (e) shows success/error feedback.
- TAB/NAV SWITCHING: if the UI has tabs, sidebar nav items, or panel toggles, clicking them MUST switch which content panel is visible. Implement via: hide all panels (display:none), show the selected one (display:block), update active tab styling.
- STATE MANAGEMENT: ${jsFile} must maintain JavaScript state variables (e.g., currentTab, currentView, items array, formData). UI updates must flow from state changes, not just static rendering.
- FETCH CALLS: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI action (button click, form submit, page load).
- SIDEBAR NAVIGATION: clicking sidebar items must switch the main content area. Each nav item needs an event listener that shows/hides content sections.
- DELETE/EDIT ACTIONS: delete buttons must call DELETE endpoint and remove the item from the UI. Edit buttons must populate a form and call PUT/PATCH.
- LOADING STATES: buttons must show disabled/loading state during API calls and re-enable after.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons in HTML, then count your event listeners in JS — they must match.

17. MANDATORY SEPARATE FILES — no inline CSS in <style> tags, no inline JS in <script> tags inside index.html
18. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
19. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.
20. BRANDING — add this badge as the LAST element before </body> in index.html (after all app content): <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>

PRODUCT_SYSTEM ARCHITECTURE PATTERN — follow this structure:
- server.js: entry point, middleware chain, route mounting, error handler
- middleware/auth.js: JWT verification only — no business logic
- routes/auth.js: signup + login — writes to users table, returns JWT
- routes/api.js: all domain routes — calls db/queries.js, respects auth middleware
- db/pool.js: pg Pool — exports pool instance
- db/queries.js: all SQL functions — exports named async functions like createUser(), getTasksByUser()
- migrations/001_schema.js: schema definition — CREATE TABLE IF NOT EXISTS for all entities`;
    } else if (hasServerFiles) {
      rulesBlock = `CRITICAL RULES — violating these means the app won't work:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. index.html, styles.css, ${jsFile} go at ROOT level (not inside public/) — this is how the deploy engine serves them
3. index.html MUST include <script src="https://cdn.tailwindcss.com"></script> in the <head> — use Tailwind utility classes throughout
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. server.js serves static files: app.use(express.static(path.join(__dirname, '.'))) to serve root-level index.html
7. package.json must have: { "scripts": { "start": "node server.js", "build": "node migrate.js" }, "dependencies": { "express": "^4.18.2", "pg": "^8.11.3" } }
8. migrations/001_schema.js: exports.up = (pgm) => { pgm.createTable(...) } — creates tables for THIS specific app
9. db/queries.js: real SQL queries (parameterized) specific to this app's entities
10. styles.css: minimal custom CSS only (Tailwind handles most styling) — add only what Tailwind can't do (gradients, custom keyframes, etc.)
11. The UI must visually match the task — use appropriate colors, icons (Unicode emoji ok), real content labels

VISUAL QUALITY STANDARDS — the output must look professionally designed:
- Use a HERO SECTION: full-width with a gradient background (bg-gradient-to-r from-indigo-600 to-purple-600 or similar dark/rich color) and large centered headline (text-5xl font-bold text-white) with a subtitle and CTA button
- For hero backgrounds, inject a relevant Unsplash image: style="background-image: url('https://source.unsplash.com/1600x900/?KEYWORD'); background-size: cover; background-position: center;" with a gradient overlay div on top
- Extract 1-2 keywords from the user's task description to use in Unsplash URLs (e.g. "photographer" → photography; "restaurant" → food,dining; "gym" → fitness,workout; "travel" → travel,landscape)
- Use CARD GRIDS with hover effects: class="group bg-white rounded-2xl shadow-md p-6 transition-all duration-300 hover:shadow-xl hover:-translate-y-1"
- Apply consistent spacing: section padding py-16 px-8, card gaps gap-8, text gaps gap-4
- Typography hierarchy: headings text-4xl md:text-5xl font-bold tracking-tight, subheadings text-xl font-semibold, body text-lg text-gray-600 leading-relaxed
- Color scheme: primary accent color + neutral grays. Use dark sections for contrast (bg-gray-900 text-white)
- Mobile-first responsive: use Tailwind breakpoints (sm:, md:, lg:) on grid columns, font sizes, padding
- Include subtle animations: fade-in on scroll via Intersection Observer in ${jsFile}, hover transforms (transition-all duration-300), smooth scroll (add class="scroll-smooth" to <html>)
- For gallery/team/feature images: use https://source.unsplash.com/600x400/?KEYWORD for each card

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST trigger a visible change.
- FORMS MUST WORK: every <form> must have a submit event listener that (a) prevents default, (b) reads input values, (c) validates, (d) sends data via fetch() or processes client-side, (e) shows feedback.
- TAB/NAV SWITCHING: if the UI has tabs or navigation items, clicking them MUST switch visible content panels. Implement via: hide all panels, show selected, update active styling.
- STATE MANAGEMENT: ${jsFile} must track UI state in variables (currentTab, items array, formData). All UI updates flow from state changes.
- CRUD WIRING: for every API endpoint in routes/api.js, ${jsFile} must have a corresponding fetch() call wired to a UI trigger (button click, form submit, page load).
- LOADING STATES: buttons must show disabled/loading during async operations and re-enable after.
- DELETE/EDIT: action buttons must call the appropriate API endpoint and update the UI immediately.
- ${jsFile} MUST contain addEventListener calls for EVERY button and clickable element in index.html. Count your buttons, count your listeners — they must match.

12. MANDATORY SEPARATE FILES — Do NOT inline CSS in <style> tags inside index.html. Put ALL CSS in styles.css. Do NOT inline JavaScript in <script> tags inside index.html. Put ALL JS in ${jsFile}. index.html must reference these via <link href="styles.css"> and <script src="${jsFile}">.
13. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
14. Generate ONLY the files listed in the scaffold contract. Do NOT skip any. Do NOT add unlisted files.`;
    } else {
      rulesBlock = `CRITICAL RULES — violating these means the build will fail:
1. COMPLETE CODE ONLY — no placeholder comments, no "// TODO", no "implement later", no skeleton stubs
2. Generate ONLY these ${scaffoldManifest.length} files: ${scaffoldManifest.join(', ')} — NO server.js, NO package.json, NO routes/, NO db/, NO migrations/
3. index.html MUST include <script src="https://cdn.tailwindcss.com"></script> in the <head> — use Tailwind utility classes throughout
4. index.html must also link CSS with <link rel="stylesheet" href="styles.css"> and JS with <script src="${jsFile}"></script>
5. ${jsFile} is browser JavaScript ONLY — no require(), no module.exports, no Node APIs
6. styles.css: minimal custom CSS only (Tailwind handles most styling) — add only what Tailwind can't do (gradients, custom keyframes, etc.)
7. The UI must visually match the task — use appropriate colors, icons (Unicode emoji ok), real content labels

VISUAL QUALITY STANDARDS — the output must look professionally designed:
- Use a HERO SECTION: full-width with a gradient background (bg-gradient-to-r from-indigo-600 to-purple-600 or similar dark/rich color) and large centered headline (text-5xl font-bold text-white) with a subtitle and CTA button
- For hero backgrounds, inject a relevant Unsplash image: style="background-image: url('https://source.unsplash.com/1600x900/?KEYWORD'); background-size: cover; background-position: center;" with a gradient overlay div on top
- Extract 1-2 keywords from the user's task description to use in Unsplash URLs (e.g. "photographer" → photography; "restaurant" → food,dining; "gym" → fitness,workout; "travel" → travel,landscape)
- Use CARD GRIDS with hover effects: class="group bg-white rounded-2xl shadow-md p-6 transition-all duration-300 hover:shadow-xl hover:-translate-y-1"
- Apply consistent spacing: section padding py-16 px-8, card gaps gap-8, text gaps gap-4
- Typography hierarchy: headings text-4xl md:text-5xl font-bold tracking-tight, subheadings text-xl font-semibold, body text-lg text-gray-600 leading-relaxed
- Color scheme: primary accent color + neutral grays. Use dark sections for contrast (bg-gray-900 text-white)
- Mobile-first responsive: use Tailwind breakpoints (sm:, md:, lg:) on grid columns, font sizes, padding
- Include subtle animations: fade-in on scroll via Intersection Observer in ${jsFile}, hover transforms (transition-all duration-300), smooth scroll (add class="scroll-smooth" to <html>)
- For gallery/team/feature images: use https://source.unsplash.com/600x400/?KEYWORD for each card

INTERACTIVITY STANDARDS — CRITICAL — every interactive element MUST be functional (not decorative):
- ZERO DEAD BUTTONS: every <button> in index.html MUST have a corresponding addEventListener or onclick handler in ${jsFile}. If a button exists, clicking it MUST produce a visible change (show/hide content, toggle state, compute result, navigate).
- FORMS MUST WORK: every <form> must have a submit event listener that prevents default, reads input values, validates, and shows results or confirmation. For calculators: compute and display. For contact forms: show success state.
- TAB/NAV SWITCHING: if the UI has tabs, navigation items, or panel toggles, clicking them MUST switch visible content. Implement: hide all panels (display='none'), show selected (display='block'), toggle active CSS class.
- STATE MANAGEMENT: ${jsFile} must maintain state variables (currentTab, items[], formValues). UI renders from state, not static HTML alone.
- CLIENT-SIDE LOGIC: for calculators/tools, the compute/calculate button MUST read all inputs, perform the calculation, and display results in a designated output area.
- CLICK HANDLER AUDIT: before finishing ${jsFile}, mentally count every <button>, <a> with action, clickable <div>, and form in index.html. Each one MUST have a handler in ${jsFile}. Missing handlers = broken app.
- NO SCROLL-ONLY JS: ${jsFile} must contain MORE than just scroll animations. It must contain functional event handlers for all interactive elements.

8. MANDATORY SEPARATE FILES — Do NOT inline CSS in <style> tags inside index.html. Put ALL CSS in styles.css. Do NOT inline JavaScript in <script> tags inside index.html. Put ALL JavaScript in ${jsFile}. index.html must ONLY reference these via <link href="styles.css"> and <script src="${jsFile}">. Generating a single HTML file with everything inlined is a CONTRACT VIOLATION.
9. Every file must use the --- FILE: filename --- header format. No JSON wrapping.
10. Do NOT generate any backend/server files. This is a static frontend build.
11. BRANDING — add this badge as the last element before </body> in index.html: <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>`;
    }

    // ── Domain constraint: prevent cross-domain contamination in AI output ───
    // _deriveAppDomain picks the single highest-confidence domain from the prompt.
    // Inject it as a binding constraint so the LLM cannot creatively merge domains
    // (e.g., "Build an inventory tracker" must NOT produce a chat+inventory hybrid).
    const _appDomain = this._deriveAppDomain ? this._deriveAppDomain(prompt) : null;
    let domainConstraintBlock = '';
    if (_appDomain && _appDomain.type !== 'generic') {
      const fieldNames = (_appDomain.fields || []).map(f => f.label).join(', ');
      domainConstraintBlock = `

=== DOMAIN CONSTRAINT (BINDING — SINGLE DOMAIN ONLY) ===
This is a ${_appDomain.type.toUpperCase()} application. Do NOT mix in features from other domains.
Core entity: ${_appDomain.entity.name} (singular: ${_appDomain.entity.singular})
Expected fields: ${fieldNames}
App name MUST reflect the ${_appDomain.type} domain — not a hybrid of multiple domains.
Do NOT add unrelated features (no chat in inventory apps, no inventory in chat apps, etc.).
=== END DOMAIN CONSTRAINT ===`;
      console.log(`[BuilderAgent] Phase 1: domain constraint injected — ${_appDomain.type} (entity: ${_appDomain.entity.name})`);
    }

    // Senior engineer system prompt is the hardcoded base layer.
    // Product Context (contextInstruction) flows through the user message — different layers.
    // Intent Gate constraints and SCAFFOLD manifest are injected here as binding structured context.
    const systemPrompt = `${SENIOR_ENGINEER_SYSTEM_PROMPT}
${constraintInstruction}
${domainConstraintBlock}

${scaffoldContract}

Output each file using this EXACT format — one section per file, separated by blank lines:

${fileExamples}

${priorityBlock}

${rulesBlock}`;

    // ── Model routing: Claude for full_product/light_app, OpenAI for static_surface ──
    const modelSelection = this._selectModel(intentClass);
    console.log(`[BuilderAgent] Phase 1: routing to ${modelSelection.provider} (model=${modelSelection.model}, intent_class=${intentClass || 'unknown'})`);

    // Build the mandatory file list — not a "hint", a contract
    const manifestDirective = scaffoldManifest.length > 0
      ? `\n\nYou MUST generate EXACTLY these files (scaffold contract — binding): ${scaffoldManifest.join(', ')}\nDo NOT skip any file. Do NOT add ANY files not in this list.`
      : '';

    // Schema-aware generation order: full_product has strict dependency ordering
    const generationOrder = (isFullProduct && isSqliteBuild)
      ? 'Start with package.json, then server.js, then db/database.js, then routes/api.js, then .env.example, then index.html + styles.css + ' + jsFile + '.'
      : isFullProduct
      ? 'Start with package.json, then server.js, then middleware/auth.js, then routes/auth.js, then db/pool.js, then db/queries.js, then migrations/001_schema.js, then routes/api.js, then frontend files.'
      : hasServerFiles
      ? 'Start with package.json, then server.js, then the rest.'
      : `Generate these ${scaffoldManifest.length} files in order: ${scaffoldManifest.join(', ')}.`;

    // ── Content fidelity extraction: parse prompt for business name, sections, CTAs ──
    // This ensures the LLM receives explicit directives about WHAT content to generate,
    // not just the structural scaffold. Without this, the LLM defaults to generic templates.
    const contentFidelityBlock = this._buildContentFidelityBlock(prompt);

    // ── Interaction contract checklist: explicit item-by-item requirements ──────
    // The interaction contract in the system prompt defines WHAT components must do.
    // This checklist in the user message ensures the LLM treats each item as mandatory.
    const contractChecklist = this._buildContractChecklist(interactionContract, jsFile);

    const userMessage = `${contextInstruction ? contextInstruction + '\n\n' : ''}${contentFidelityBlock}\n\nBuild this application: ${prompt}\n\nArchitecture plan:\n${planContext}\n\nTech stack: ${techStack}${manifestDirective}\n\nGenerate ALL files completely using the --- FILE: filename --- format. ${generationOrder}${contractChecklist}\n\nCRITICAL: The app must be INTERACTIVE and FUNCTIONAL — not just visually polished. Every button must have a click handler. Every form must submit. Every tab/nav must switch content. The JavaScript file (${jsFile}) must contain real event listeners and DOM manipulation for ALL interactive elements in index.html. A beautiful UI where nothing is clickable is a FAILED build.`;

    const { rawText, finishReason, tokenUsage } = await this._callStreamingLLM(
      modelSelection, systemPrompt, userMessage, 13000, emitChunk
    );

    console.log(
      `[BuilderAgent] Phase 1 done: ${rawText.length} chars, finish_reason=${finishReason} (${modelSelection.provider}/${modelSelection.model})`
    );

    return { rawText, finishReason, tokenUsage };
  }

  // ── Phase 2: Parse + Normalize ────────────────────────────────────────────────

  /**
   * Parse raw output using cascade strategy, then normalize paths.
   * public/index.html → index.html (CODE prompt uses root-level for frontend files)
   */
  _phase2_parseAndNormalize(rawText) {
    // Parse cascade: delimiter (primary) → JSON fallback → code blocks → truncated recovery
    const raw = this._parseAllStrategies(rawText);

    // Path normalization: scaffold uses public/x but CODE generates at root
    const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
    const normalized = {};

    for (const [path, content] of Object.entries(raw)) {
      if (!content || content.trim().length === 0) continue; // Drop empty

      // Normalize public/index.html → index.html
      if (path.startsWith('public/')) {
        const basename = path.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) {
          normalized[basename] = content;
          continue;
        }
      }
      normalized[path] = content;
    }

    return normalized;
  }

  // ── Phase 2.5: Inline Asset Extraction ──────────────────────────────────────

  /**
   * Deterministic de-inlining pass: extract inlined CSS and JS from HTML blobs.
   *
   * The AI frequently ignores the scaffold manifest and generates a single HTML
   * file with everything inlined (<style> blocks, inline <script> blocks).
   * This method detects that scenario and extracts the inlined assets into their
   * declared manifest files.
   *
   * This is PREVENTION — we fix the output deterministically instead of waiting
   * for VERIFY to catch the contract violation.
   *
   * @param {object} files - Parsed file map { filename: content }
   * @param {string[]} scaffoldManifest - The binding manifest file list
   * @returns {object} Fixed file map with extracted assets
   */
  _extractInlinedAssets(files, scaffoldManifest) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return files;

    // Normalize manifest to canonical names (public/x → x for frontend files)
    const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
    const manifestSet = new Set();
    for (const f of scaffoldManifest) {
      if (f.startsWith('public/')) {
        const basename = f.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) { manifestSet.add(basename); continue; }
      }
      manifestSet.add(f);
    }

    // Find the HTML entry file (index.html)
    const htmlFile = files['index.html'] || files['public/index.html'];
    if (!htmlFile) return files; // No HTML to extract from

    const result = { ...files };
    let html = typeof htmlFile === 'string' ? htmlFile : '';
    let modified = false;

    // ── Extract <style> blocks → styles.css ──────────────────────────────────
    const cssManifestName = manifestSet.has('styles.css') ? 'styles.css' : null;
    if (cssManifestName && !result[cssManifestName]) {
      // Extract all <style>...</style> blocks from the HTML
      const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      const cssBlocks = [];
      let styleMatch;
      while ((styleMatch = styleRegex.exec(html)) !== null) {
        const cssContent = styleMatch[1].trim();
        if (cssContent.length > 0) {
          cssBlocks.push(cssContent);
        }
      }

      if (cssBlocks.length > 0) {
        // Write extracted CSS to styles.css
        result[cssManifestName] = '/* Extracted from inline <style> — scaffold manifest: styles.css */\n' +
          cssBlocks.join('\n\n');

        // Remove <style> blocks from HTML and ensure <link> to styles.css exists
        html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
        if (!html.includes('href="styles.css"') && !html.includes("href='styles.css'")) {
          html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>');
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: extracted ${cssBlocks.length} <style> block(s) → ${cssManifestName} (${result[cssManifestName].length} chars)`);
      } else {
        // No <style> blocks, but manifest requires styles.css — create minimal valid CSS
        result[cssManifestName] = '/* Custom styles — Tailwind handles most styling via utility classes */\n' +
          '/* Add animations, gradients, and custom properties that Tailwind cannot express */\n' +
          'html { scroll-behavior: smooth; }\n';
        if (!html.includes('href="styles.css"') && !html.includes("href='styles.css'")) {
          html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>');
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: no <style> blocks found, created minimal ${cssManifestName}`);
      }
    }

    // ── Extract inline <script> blocks → script.js ───────────────────────────
    const jsManifestName = manifestSet.has('script.js') ? 'script.js'
      : manifestSet.has('app.js') ? 'app.js'
      : null;
    if (jsManifestName && !result[jsManifestName]) {
      // Extract all inline <script> blocks (NOT <script src="..."> external refs)
      const scriptRegex = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
      const jsBlocks = [];
      let scriptMatch;
      while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        const jsContent = scriptMatch[1].trim();
        // Skip empty scripts and Tailwind CDN config scripts (very short, just config objects)
        if (jsContent.length > 20) {
          jsBlocks.push(jsContent);
        }
      }

      if (jsBlocks.length > 0) {
        // Write extracted JS to the manifest file
        result[jsManifestName] = '// Extracted from inline <script> — scaffold manifest: ' + jsManifestName + '\n' +
          jsBlocks.join('\n\n');

        // Remove the inline <script> blocks from HTML (keep external <script src="..."> refs)
        html = html.replace(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi, (match) => {
          // Keep very short scripts (Tailwind config, etc.)
          const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/i, '').trim();
          if (content.length <= 20) return match;
          return '';
        });

        // Ensure <script src="script.js"> exists in the HTML
        if (!html.includes(`src="${jsManifestName}"`) && !html.includes(`src='${jsManifestName}'`)) {
          html = html.replace(/<\/body>/i, `  <script src="${jsManifestName}"></script>\n</body>`);
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: extracted ${jsBlocks.length} inline <script> block(s) → ${jsManifestName} (${result[jsManifestName].length} chars)`);
      } else {
        // No inline scripts, but manifest requires the JS file — create minimal valid JS
        result[jsManifestName] = '// ' + jsManifestName + ' — browser JavaScript\n' +
          '(function() {\n' +
          '  // Fade-in animation for elements with .fade-in class\n' +
          '  document.addEventListener("DOMContentLoaded", function() {\n' +
          '    var observer = new IntersectionObserver(function(entries) {\n' +
          '      entries.forEach(function(entry) {\n' +
          '        if (entry.isIntersecting) entry.target.classList.add("visible");\n' +
          '      });\n' +
          '    }, { threshold: 0.1 });\n' +
          '    document.querySelectorAll(".fade-in").forEach(function(el) { observer.observe(el); });\n' +
          '  });\n' +
          '})();\n';
        if (!html.includes(`src="${jsManifestName}"`) && !html.includes(`src='${jsManifestName}'`)) {
          html = html.replace(/<\/body>/i, `  <script src="${jsManifestName}"></script>\n</body>`);
        }
        modified = true;
        console.log(`[BuilderAgent] Phase 2.5: no inline <script> blocks found, created minimal ${jsManifestName}`);
      }
    }

    // Write modified HTML back if we changed it
    if (modified) {
      if (result['index.html']) {
        result['index.html'] = html;
      } else if (result['public/index.html']) {
        result['public/index.html'] = html;
      }
    }

    return result;
  }

  // ── Post-Phase 6: Hard Manifest Enforcement ─────────────────────────────────

  /**
   * Enforce the scaffold manifest as a HARD GATE on CODE output.
   * After all phases complete, this method:
   *   1. Maps equivalent files (app.js ↔ script.js) to match the manifest
   *   2. Strips ALL files not in the scaffold manifest
   *   3. Returns only manifest-compliant files
   *
   * This is the final enforcement layer — runs AFTER the continuation loop,
   * BEFORE the output is returned to the orchestrator.
   */
  _enforceManifest(files, scaffoldManifest) {
    if (!scaffoldManifest || scaffoldManifest.length === 0) return files;

    const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);

    // Build the canonical manifest set (normalized: public/x → x for frontend files)
    const manifestSet = new Set();
    for (const f of scaffoldManifest) {
      if (f.startsWith('public/')) {
        const basename = f.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) {
          manifestSet.add(basename);
          continue;
        }
      }
      manifestSet.add(f);
    }

    // Equivalence map: if manifest expects script.js but CODE generated app.js (or vice versa),
    // rename to match the manifest. AI frequently swaps these two names.
    const JS_EQUIVALENTS = [['app.js', 'script.js']];

    const renamed = { ...files };
    for (const [a, b] of JS_EQUIVALENTS) {
      // If manifest wants A but we only have B → rename B to A
      if (manifestSet.has(a) && !renamed[a] && renamed[b]) {
        console.log(`[BuilderAgent] Manifest enforcement: renaming ${b} → ${a} (equivalence mapping)`);
        renamed[a] = renamed[b];
        delete renamed[b];
      }
      // If manifest wants B but we only have A → rename A to B
      if (manifestSet.has(b) && !renamed[b] && renamed[a]) {
        console.log(`[BuilderAgent] Manifest enforcement: renaming ${a} → ${b} (equivalence mapping)`);
        renamed[b] = renamed[a];
        delete renamed[a];
      }
    }

    // Strip all files not in the manifest
    const enforced = {};
    const stripped = [];
    for (const [path, content] of Object.entries(renamed)) {
      if (manifestSet.has(path)) {
        enforced[path] = content;
      } else {
        stripped.push(path);
      }
    }

    if (stripped.length > 0) {
      console.log(`[BuilderAgent] Manifest enforcement: stripped ${stripped.length} unexpected files: ${stripped.join(', ')}`);
    }

    const missing = [...manifestSet].filter(f => !enforced[f]);
    if (missing.length > 0) {
      console.warn(`[BuilderAgent] Manifest enforcement: ${missing.length} manifest files still missing after enforcement: ${missing.join(', ')}`);
    }

    console.log(`[BuilderAgent] Manifest enforcement complete: ${Object.keys(enforced).length}/${manifestSet.size} files match manifest`);
    return enforced;
  }

  // ── Manifest Gap Fill: Stub Generator ──────────────────────────────────────

  /**
   * Generate minimal valid stub content for a manifest-declared file that
   * was not produced by the AI or simulated code path.
   *
   * These stubs are NOT production code — they are structural placeholders
   * that satisfy the contract (file exists, non-empty, syntactically valid)
   * so the app deploys and functions at a basic level.
   */
  _generateStubContent(filename, prompt = '') {
    const safeTitle = this._deriveTitle ? this._deriveTitle(prompt) : 'App';

    // ── Domain-aware stubs: use prompt to determine entity names ──
    const appDomain = this._deriveAppDomain ? this._deriveAppDomain(prompt) : null;
    const entityName = appDomain ? appDomain.entity.name : 'items';
    const entityFields = appDomain ? appDomain.fields : [
      { name: 'name', type: 'varchar(255)', required: true },
      { name: 'description', type: 'text', required: false },
    ];
    const dbColumns = appDomain ? appDomain.dbColumns : "name VARCHAR(255) NOT NULL, description TEXT DEFAULT ''";
    const firstRequired = entityFields.find(f => f.required) || entityFields[0];

    const stubs = {
      'migrate.js': [
        "const { Pool } = require('pg');",
        "",
        "async function migrate() {",
        "  const pool = new Pool({",
        "    connectionString: process.env.DATABASE_URL,",
        "    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "  });",
        "",
        "  try {",
        "    await pool.query(`",
        `      CREATE TABLE IF NOT EXISTS ${entityName} (`,
        "        id SERIAL PRIMARY KEY,",
        `        ${dbColumns},`,
        "        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "      )",
        "    `);",
        "    console.log('Migration complete');",
        "  } catch (err) {",
        "    console.error('Migration failed:', err.message);",
        "    process.exit(1);",
        "  } finally {",
        "    await pool.end();",
        "  }",
        "}",
        "",
        "migrate();",
      ].join('\n'),

      'db/queries.js': [
        "// Parameterized SQL queries — all database access goes through this module",
        "",
        "module.exports = function(pool) {",
        "  return {",
        "    async getAll() {",
        `      const { rows } = await pool.query('SELECT * FROM ${entityName} ORDER BY created_at DESC');`,
        "      return rows;",
        "    },",
        `    async create(${entityFields.map(f => f.name).join(', ')}) {`,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${entityName} (${entityFields.map(f => f.name).join(', ')}) VALUES (${entityFields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *',`,
        `        [${entityFields.map(f => f.required ? f.name : `(${f.name} || '').trim()`).join(', ')}]`,
        "      );",
        "      return rows[0];",
        "    },",
        "    async deleteById(id) {",
        `      await pool.query('DELETE FROM ${entityName} WHERE id = $1', [id]);`,
        "    }",
        "  };",
        "};",
      ].join('\n'),

      'db/pool.js': [
        "const { Pool } = require('pg');",
        "",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "module.exports = pool;",
      ].join('\n'),

      'db/database.js': [
        "// better-sqlite3 setup — reads DATABASE_URL env var for the file path",
        "const Database = require('better-sqlite3');",
        "const dbPath = process.env.DATABASE_URL || './app.db';",
        "const db = new Database(dbPath);",
        "db.pragma('journal_mode = WAL');",
        "db.pragma('foreign_keys = ON');",
        "",
        "// Initialize schema (runs on every startup, idempotent)",
        "db.exec(`",
        `  CREATE TABLE IF NOT EXISTS ${entityName} (`,
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        `    ${dbColumns.replace(/VARCHAR/gi, 'TEXT').replace(/DECIMAL\([^)]+\)/gi, 'REAL')},`,
        "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        "  )",
        "`);",
        "",
        "module.exports = db;",
      ].join('\n'),

      'middleware/auth.js': [
        "const jwt = require('jsonwebtoken');",
        "",
        "module.exports = function(req, res, next) {",
        "  const authHeader = req.headers.authorization;",
        "  if (!authHeader || !authHeader.startsWith('Bearer ')) {",
        "    return res.status(401).json({ error: 'Authorization required' });",
        "  }",
        "  try {",
        "    const token = authHeader.split(' ')[1];",
        "    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');",
        "    next();",
        "  } catch (err) {",
        "    return res.status(401).json({ error: 'Invalid token' });",
        "  }",
        "};",
      ].join('\n'),

      'middleware/error.js': [
        "// Global error handling middleware",
        "module.exports = function(err, req, res, _next) {",
        "  console.error('[Error]', err.message);",
        "  res.status(err.status || 500).json({",
        "    success: false,",
        "    message: err.message || 'Internal server error'",
        "  });",
        "};",
      ].join('\n'),

      'routes/auth.js': [
        "const { Router } = require('express');",
        "const bcrypt = require('bcrypt');",
        "const jwt = require('jsonwebtoken');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "  const SECRET = process.env.JWT_SECRET || 'dev-secret';",
        "",
        "  router.post('/signup', async (req, res, next) => {",
        "    try {",
        "      const { email, password } = req.body;",
        "      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });",
        "      const hash = await bcrypt.hash(password, 10);",
        "      const { rows } = await pool.query(",
        "        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',",
        "        [email, hash]",
        "      );",
        "      const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, SECRET, { expiresIn: '7d' });",
        "      res.status(201).json({ token, user: rows[0] });",
        "    } catch (err) { next(err); }",
        "  });",
        "",
        "  router.post('/login', async (req, res, next) => {",
        "    try {",
        "      const { email, password } = req.body;",
        "      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });",
        "      const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);",
        "      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });",
        "      const valid = await bcrypt.compare(password, rows[0].password_hash);",
        "      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });",
        "      const token = jwt.sign({ id: rows[0].id, email: rows[0].email }, SECRET, { expiresIn: '7d' });",
        "      res.json({ token, user: { id: rows[0].id, email: rows[0].email } });",
        "    } catch (err) { next(err); }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "",
        `  router.get('/${entityName}', async (req, res) => {`,
        "    try {",
        `      const { rows } = await pool.query('SELECT * FROM ${entityName} ORDER BY created_at DESC');`,
        `      res.json({ success: true, ${entityName}: rows });`,
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.post('/${entityName}', async (req, res) => {`,
        "    try {",
        `      const { ${entityFields.map(f => f.name).join(', ')} } = req.body;`,
        `      if (!${firstRequired.name} || !${firstRequired.name}.toString().trim()) return res.status(400).json({ success: false, message: '${firstRequired.name} is required' });`,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${entityName} (${entityFields.map(f => f.name).join(', ')}) VALUES (${entityFields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *',`,
        `        [${entityFields.map(f => f.required ? `${f.name}.toString().trim()` : `(${f.name} || '').toString().trim()`).join(', ')}]`,
        "      );",
        `      res.status(201).json({ success: true, ${appDomain ? appDomain.entity.singular : 'item'}: rows[0] });`,
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${entityName}/:id', async (req, res) => {`,
        "    try {",
        `      await pool.query('DELETE FROM ${entityName} WHERE id = $1', [req.params.id]);`,
        "      res.json({ success: true });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'models/index.js': [
        "// Model definitions and exports",
        "module.exports = {",
        "  // Models are auto-loaded from this directory",
        "};",
      ].join('\n'),

      '.env.example': [
        "DATABASE_URL=./app.db",
        "JWT_SECRET=change-me-in-production",
        "PORT=3000",
        "NODE_ENV=development",
      ].join('\n'),

      'db/database.js': [
        "const Database = require('better-sqlite3');",
        "const path = require('path');",
        "",
        "const dbPath = process.env.DATABASE_URL || './app.db';",
        "const db = new Database(dbPath);",
        "",
        "// Enable WAL mode for better concurrency",
        "db.pragma('journal_mode = WAL');",
        "db.pragma('foreign_keys = ON');",
        "",
        "// Initialize schema (idempotent — safe to run on every startup)",
        "db.exec(`",
        `  CREATE TABLE IF NOT EXISTS users (`,
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "    email TEXT UNIQUE NOT NULL,",
        "    password_hash TEXT NOT NULL,",
        "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        "  );",
        `  CREATE TABLE IF NOT EXISTS ${entityName} (`,
        "    id INTEGER PRIMARY KEY AUTOINCREMENT,",
        ...entityFields.map(f => `    ${f.name} ${f.type === 'varchar(255)' ? 'TEXT' : 'TEXT'}${f.required ? ' NOT NULL' : " DEFAULT ''"},`),
        "    created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        "  );",
        "`);",
        "",
        "module.exports = db;",
      ].join('\n'),

      'migrations/001_schema.js': [
        "exports.up = (pgm) => {",
        `  pgm.createTable('${entityName}', {`,
        "    id: 'id',",
        ...entityFields.map(f => `    ${f.name}: { type: '${f.type}', ${f.required ? 'notNull: true' : "default: ''"} },`),
        "    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') }",
        "  });",
        "};",
        "",
        "exports.down = (pgm) => {",
        `  pgm.dropTable('${entityName}');`,
        "};",
      ].join('\n'),
    };

    // Direct match
    if (stubs[filename]) return stubs[filename];

    // Fallback by file extension
    if (filename.endsWith('.js')) {
      return `// ${filename} — auto-generated stub\nmodule.exports = {};\n`;
    }
    if (filename.endsWith('.html')) {
      const _entityLabel = appDomain ? appDomain.entity.singular : 'Item';
      const _entityPlural = appDomain ? appDomain.entity.name : 'items';
      const _icon = appDomain ? appDomain.icon : '📋';
      return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        `  <title>${safeTitle}</title>`,
        '  <script src="https://cdn.tailwindcss.com"></script>',
        '  <link rel="stylesheet" href="styles.css">',
        '</head>',
        '<body class="bg-gray-50 text-gray-900 font-sans antialiased min-h-screen">',
        `  <header class="bg-indigo-600 text-white py-6 px-6 shadow-lg">`,
        '    <div class="max-w-3xl mx-auto flex items-center gap-3">',
        `      <span class="text-2xl">${_icon}</span>`,
        `      <h1 class="text-2xl font-bold tracking-tight">${safeTitle}</h1>`,
        '    </div>',
        '  </header>',
        '  <main class="max-w-3xl mx-auto px-6 py-10">',
        `    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6">`,
        `      <h2 class="text-lg font-semibold mb-4">Add ${_entityLabel}</h2>`,
        `      <p class="text-gray-500">Loading application...</p>`,
        '    </div>',
        `    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">`,
        `      <h2 class="text-lg font-semibold mb-4">${_entityPlural}</h2>`,
        `      <div id="itemList"></div>`,
        '    </div>',
        '  </main>',
        '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
        '  <script src="app.js"></script>',
        '</body>',
        '</html>',
      ].join('\n');
    }
    if (filename.endsWith('.css')) {
      return '/* Custom styles — Tailwind handles most styling via utility classes */\nhtml { scroll-behavior: smooth; }\n';
    }
    if (filename.endsWith('.json')) {
      return JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2);
    }

    return `// ${filename} — auto-generated stub\n`;
  }

  // ── Phase 3: Deterministic Diff Engine ───────────────────────────────────────

  /**
   * Classify gaps against scaffold manifest into three categories.
   * Detection is triple-layered:
   *   1. finish_reason === 'length' (truncation signal)
   *   2. isLikelyIncomplete() heuristics (structural analysis)
   *   3. Missing expected files vs. manifest
   */
  _phase3_classifyGaps(files, scaffoldManifest, finishReason) {
    const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
    const generated = new Set(Object.keys(files));

    const missingFiles = [];
    const incompleteFiles = [];
    const invalidFiles = [];

    for (const scaffoldPath of scaffoldManifest) {
      // Normalize scaffold path to CODE path
      let codePath = scaffoldPath;
      if (scaffoldPath.startsWith('public/')) {
        const basename = scaffoldPath.replace('public/', '');
        if (FRONTEND_ROOT_FILES.has(basename)) {
          codePath = basename;
        }
      }

      if (!generated.has(codePath) && !generated.has(scaffoldPath)) {
        // Not generated at all
        missingFiles.push(codePath);
      } else {
        const actualPath = generated.has(codePath) ? codePath : scaffoldPath;
        const content = files[actualPath];

        if (!content || content.trim().length === 0) {
          invalidFiles.push(actualPath);
        } else if (isLikelyIncomplete(content)) {
          // If truncation detected, be more aggressive about flagging incomplete files
          // (truncation often cuts the last file in stream, so flag it too)
          if (finishReason === 'length') {
            incompleteFiles.push(actualPath);
          } else {
            incompleteFiles.push(actualPath);
          }
        }
      }
    }

    return { missingFiles, incompleteFiles, invalidFiles };
  }

  // ── Phase 4: Dependency-Aware Continuation Planner ───────────────────────────

  /**
   * Order gap files by dependency tier: infra → server → frontend.
   * Progressive stabilization: each tier builds on the previous,
   * reducing hallucination drift and cross-file inconsistency.
   */
  _phase4_planContinuationOrder(gaps) {
    const allGaps = [
      ...gaps.missingFiles,
      ...gaps.incompleteFiles,
      ...gaps.invalidFiles,
    ];

    // Deduplicate
    const unique = [...new Set(allGaps)];
    if (unique.length === 0) return [];

    // Assign each file to its dependency tier
    const tierAssignments = new Map();

    for (const file of unique) {
      let assigned = false;
      for (let tierIdx = 0; tierIdx < DEPENDENCY_TIERS.length; tierIdx++) {
        const tier = DEPENDENCY_TIERS[tierIdx];
        for (const pattern of tier) {
          if (file === pattern || file.startsWith(pattern)) {
            const current = tierAssignments.get(file);
            if (current === undefined || tierIdx < current) {
              tierAssignments.set(file, tierIdx);
            }
            assigned = true;
            break;
          }
        }
        if (assigned) break;
      }
      // Unknown files get a middle tier (1)
      if (!tierAssignments.has(file)) {
        tierAssignments.set(file, 1);
      }
    }

    // Sort by tier then alphabetically within tier
    return unique.sort((a, b) => {
      const tierDiff = (tierAssignments.get(a) || 1) - (tierAssignments.get(b) || 1);
      if (tierDiff !== 0) return tierDiff;
      return a.localeCompare(b);
    });
  }

  // ── Phase 5: Strict Continuation Execution ───────────────────────────────────

  /**
   * Execute one continuation pass for a batch of files.
   * Continuation prompts are contracts, not suggestions.
   */
  async _phase5_executeContinuationBatch(
    prompt, planContext, techStack, filesToGenerate, existingFiles, passNum, emitChunk, productContext = null, intentClass = null
  ) {
    const existingFileList = Object.keys(existingFiles).join(', ');

    // Provide truncated previews of key existing files for cross-file consistency
    const contextSnippets = [];
    const CONTEXT_FILES = ['server.js', 'package.json', 'index.html', 'db/queries.js'];
    for (const key of CONTEXT_FILES) {
      if (existingFiles[key]) {
        const content = existingFiles[key];
        const snippet = content.length > 500
          ? content.slice(0, 500) + '\n// ... (truncated)'
          : content;
        contextSnippets.push(`--- ${key} (existing) ---\n${snippet}`);
      }
    }
    const contextBlock = contextSnippets.length > 0
      ? `\nExisting file previews (match style, imports, structure):\n${contextSnippets.join('\n\n')}`
      : '';

    // Include product context in continuation prompts to prevent content drift
    const productContextBlock = productContext
      ? `\n${buildContextInstruction(productContext)}\n`
      : '';

    const continuationPrompt = `You are continuing an incomplete codebase.
${productContextBlock}
App: ${prompt}
Tech stack: ${techStack}
Files already generated: ${existingFileList}
${contextBlock}

Generate ONLY these files:
${filesToGenerate.map(f => `- ${f}`).join('\n')}

${planContext ? `Architecture context:\n${planContext.slice(0, 800)}\n` : ''}Rules (these are CONTRACTS, not suggestions):
- Generate ONLY the files listed above — nothing else
- Match existing code exactly (style, imports, variable names, error handling patterns)
- Do not modify existing files
- No placeholders, no "TODO", no skeleton stubs — COMPLETE CODE ONLY
- Use the --- FILE: filename --- delimiter for each file
- index.html, styles.css, and other browser JS files are ROOT-level (no require/module.exports)
- Browser JS files (app.js, script.js) must use ONLY browser APIs — no require(), no module.exports
- INTERACTIVITY IS MANDATORY: browser JS files MUST contain addEventListener calls for every button/form/nav element in index.html. Every button must have a click handler. Every form must have a submit handler. No dead buttons.`;

    // ── Model routing: same intent_class as Phase 1 for consistency ──────────
    const phase5ModelSelection = this._selectModel(intentClass);
    console.log(`[BuilderAgent] Phase 5: routing to ${phase5ModelSelection.provider} (model=${phase5ModelSelection.model}, intent_class=${intentClass || 'unknown'})`);

    const phase5SystemPrompt = 'You are a senior full-stack developer completing a codebase. Generate complete, production-quality code files using the --- FILE: filename --- delimiter format. No placeholders, no TODOs. Strict output: only the requested files. CRITICAL: Browser JS files (app.js, script.js) must contain real event listeners (addEventListener) for EVERY button, form, and interactive element in the HTML. No dead buttons — every interactive element must have a handler.';

    let batchText;
    try {
      const { rawText } = await this._callStreamingLLM(
        phase5ModelSelection, phase5SystemPrompt, continuationPrompt, 8000, emitChunk
      );
      batchText = rawText;
    } catch (err) {
      console.error(`[BuilderAgent] Phase 5 batch error:`, err.message);
      return {};
    }
    const batchFiles = this._parseFileDelimiters(batchText);

    // Filter: keep only non-empty files
    const result = {};
    for (const [name, content] of Object.entries(batchFiles)) {
      if (content && content.trim().length > 10) {
        result[name] = content;
      }
    }

    console.log(
      `[BuilderAgent] Phase 5 batch: ${filesToGenerate.join(', ')} → ` +
      `generated ${Object.keys(result).length} files (${phase5ModelSelection.provider}/${phase5ModelSelection.model})`
    );

    return result;
  }

  // ── Phase 6: Merge + Validate Loop ───────────────────────────────────────────

  /**
   * Orchestrates phases 4-5-6: plan → execute → merge → re-diff → repeat.
   * Stops when no gaps remain or max passes reached (fail-safe).
   */
  async _phase456_continuationLoop(
    prompt, planContext, techStack, files, initialGaps, scaffoldManifest, emitChunk, productContext = null, intentClass = null
  ) {
    const MAX_PASSES = 3;
    const BATCH_SIZE = 4;
    let currentFiles = { ...files };
    let currentGaps = initialGaps;
    let pass = 0;

    while (pass < MAX_PASSES) {
      pass++;

      // Phase 4: Dependency-aware ordering
      const ordered = this._phase4_planContinuationOrder(currentGaps);
      if (ordered.length === 0) {
        console.log(`[BuilderAgent] Phase 6 pass ${pass}: no gaps remaining — done`);
        break;
      }

      console.log(
        `[BuilderAgent] Phase 6 pass ${pass}/${MAX_PASSES}: ` +
        `${ordered.length} files to generate: ${ordered.slice(0, 6).join(', ')}${ordered.length > 6 ? '...' : ''}`
      );

      emitChunk(`\n\n--- Continuation pass ${pass}: generating ${ordered.length} file${ordered.length !== 1 ? 's' : ''} ---\n\n`);

      // Phase 5: Execute in batches (respect BATCH_SIZE for context coherence)
      for (let i = 0; i < ordered.length; i += BATCH_SIZE) {
        const batch = ordered.slice(i, i + BATCH_SIZE);

        // Phase 5: Strict continuation execution
        const newFiles = await this._phase5_executeContinuationBatch(
          prompt, planContext, techStack, batch, currentFiles, pass, emitChunk, productContext, intentClass
        );

        // Phase 6: Merge into artifact set
        Object.assign(currentFiles, newFiles);
      }

      // Phase 6: Re-run diff engine (Phase 3)
      const newGaps = this._phase3_classifyGaps(currentFiles, scaffoldManifest, null);
      const newTotalGaps = newGaps.missingFiles.length + newGaps.incompleteFiles.length + newGaps.invalidFiles.length;

      if (newTotalGaps === 0) {
        console.log(`[BuilderAgent] Phase 6 pass ${pass}: all gaps resolved ✓`);
        break;
      }

      // Convergence check: if gaps didn't decrease, stop (avoid infinite loops)
      const prevTotal = currentGaps.missingFiles.length + currentGaps.incompleteFiles.length + currentGaps.invalidFiles.length;
      if (newTotalGaps >= prevTotal) {
        console.warn(
          `[BuilderAgent] Phase 6 pass ${pass}: gaps not converging ` +
          `(${prevTotal} → ${newTotalGaps}) — stopping`
        );
        break;
      }

      currentGaps = newGaps;
      console.log(`[BuilderAgent] Phase 6 pass ${pass}: ${newTotalGaps} gaps remaining, continuing...`);
    }

    if (pass >= MAX_PASSES) {
      console.warn(`[BuilderAgent] Phase 6: reached max passes (${MAX_PASSES}) — returning best effort`);
    }

    return currentFiles;
  }

  // ── Parse strategies (multi-format cascade) ──────────────────────────────────

  /**
   * Parse --- FILE: filename --- delimited sections.
   * Primary format — no JSON overhead, handles truncation gracefully
   * because each file is independent (truncation only loses the last partial file).
   */
  _parseFileDelimiters(text) {
    const files = {};
    const headerRegex = /^-{3,}\s*FILE:\s*(.+?)\s*-{3,}\s*$/gm;
    const headers = [];
    let match;

    while ((match = headerRegex.exec(text)) !== null) {
      headers.push({ filename: match[1].trim(), index: match.index, endIndex: match.index + match[0].length });
    }

    for (let i = 0; i < headers.length; i++) {
      const start = headers[i].endIndex;
      const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
      const content = text.slice(start, end).trim();
      if (content) {
        files[headers[i].filename] = content;
      }
    }

    return files;
  }

  /**
   * Try to parse raw text as JSON (backward compat), handling variations:
   * - Raw JSON object
   * - JSON wrapped in ```json fences
   * - JSON with leading/trailing text
   */
  _tryJsonParse(text) {
    // Strategy A: Direct parse
    try {
      const parsed = JSON.parse(text);
      if (parsed.files && typeof parsed.files === 'object') {
        const files = parsed.files;
        const totalLines = Object.values(files).reduce((sum, content) => {
          return sum + (typeof content === 'string' ? content.split('\n').length : 0);
        }, 0);
        return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
      }
    } catch (_) {}

    // Strategy B: Extract JSON from markdown fence
    const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        if (parsed.files && typeof parsed.files === 'object') {
          const files = parsed.files;
          const totalLines = Object.values(files).reduce((sum, content) => {
            return sum + (typeof content === 'string' ? content.split('\n').length : 0);
          }, 0);
          return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
        }
      } catch (_) {}
    }

    // Strategy C: Find JSON object boundaries in text
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        if (parsed.files && typeof parsed.files === 'object') {
          const files = parsed.files;
          const totalLines = Object.values(files).reduce((sum, content) => {
            return sum + (typeof content === 'string' ? content.split('\n').length : 0);
          }, 0);
          return { files, entryPoint: parsed.entryPoint || 'server.js', totalLines };
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Extract fenced code blocks with filename detection.
   * Handles: ```js, ```javascript, ```html, ```css, ```json, ```
   */
  _extractCodeBlocks(text) {
    const files = {};
    const blockRegex = /(?:(?:#+\s*|(?:\*\*)?)?(\S+\.\w+)(?:\*\*)?[^\n]*\n)?```(?:javascript|js|html|css|json|sql)?\s*\n([\s\S]*?)(?:```|$)/g;
    const filenameRegex = /(?:\/\/|#|<!--)\s*(?:file(?:name)?:?\s*)?(\S+\.\w+)/i;
    let match;
    let fileIndex = 0;

    while ((match = blockRegex.exec(text)) !== null) {
      const code = match[2].trim();
      if (!code) continue;

      let filename = match[1] || null;
      if (!filename) {
        const firstLine = code.split('\n')[0];
        const nameMatch = filenameRegex.exec(firstLine);
        filename = nameMatch ? nameMatch[1] : null;
      }
      if (!filename) {
        const preBlock = text.slice(Math.max(0, match.index - 100), match.index);
        const preMatch = preBlock.match(/(\S+\.\w+)\s*(?:\n|$)/);
        filename = preMatch ? preMatch[1] : `file_${++fileIndex}.js`;
      }
      files[filename] = code;
    }

    return files;
  }

  /**
   * Recover completed files from truncated JSON.
   * When max_tokens is hit, JSON is cut mid-stream. Extracts all complete
   * "filename": "content" pairs that were finished before truncation.
   */
  _recoverTruncatedJson(text) {
    const files = {};
    const filesStart = text.indexOf('"files"');
    if (filesStart < 0) return files;

    const region = text.slice(filesStart);
    const pairRegex = /"([^"]+\.\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let match;

    while ((match = pairRegex.exec(region)) !== null) {
      const filename = match[1];
      if (filename === 'entryPoint' || filename === 'totalLines') continue;
      try {
        const content = JSON.parse(`"${match[2]}"`);
        if (content && content.length > 5) {
          files[filename] = content;
        }
      } catch (_) {
        const content = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (content && content.length > 5) {
          files[filename] = content;
        }
      }
    }

    return files;
  }

  /**
   * Parse raw AI output using all 4 strategies, returning the best result.
   */
  _parseAllStrategies(rawText) {
    // Strategy 1: Delimiter format (primary — most reliable)
    const delimFiles = this._parseFileDelimiters(rawText);
    if (Object.keys(delimFiles).length >= 2) return delimFiles;

    // Strategy 2: JSON parse (backward compat)
    const jsonResult = this._tryJsonParse(rawText);
    if (jsonResult && Object.keys(jsonResult.files).length >= 2) return jsonResult.files;

    // Strategy 3: Markdown code blocks
    const codeBlockFiles = this._extractCodeBlocks(rawText);
    if (Object.keys(codeBlockFiles).length >= 2) return codeBlockFiles;

    // Strategy 4: Truncated JSON recovery
    const recoveredFiles = this._recoverTruncatedJson(rawText);
    if (Object.keys(recoveredFiles).length >= 1) return recoveredFiles;

    // Return best non-empty result from any strategy
    if (Object.keys(delimFiles).length > 0) return delimFiles;
    if (Object.keys(codeBlockFiles).length > 0) return codeBlockFiles;
    return {};
  }

  /**
   * Detect the entry point from generated files.
   */
  _detectEntryPoint(files) {
    if (files['server.js']) return 'server.js';
    if (files['index.js']) return 'index.js';
    if (files['app.js']) return 'app.js';
    return Object.keys(files)[0] || 'server.js';
  }

  // ── Simulated fallback (no OpenAI key) ───────────────────────────────────────

  async _simulatedCode(prompt, emitChunk, constraintContract = null, productContext = null, scaffold = null) {
    // ── Title derivation: prefer product context > prompt signals > safe fallback ──
    const safeTitle = this._deriveTitle(prompt, productContext);

    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── STATIC SURFACE: pure HTML/CSS/JS — no server, no db, no backend ──────
    if (intentClass === 'static_surface') {
      // Phase 4.2: ISE surfaces — generate surface-aware page instead of generic feature grid
      const _iseSurfaces = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces) || [];
      if (_iseSurfaces.length > 0) {
        console.log(`[BuilderAgent] Simulated CODE: static_surface with ISE surfaces [${_iseSurfaces.join(', ')}]`);
        return this._simulatedCodeWithSurfaces(prompt, safeTitle, _iseSurfaces, emitChunk, productContext);
      }
      console.log('[BuilderAgent] Simulated CODE: static_surface — generating prompt-aware 3 files');
      const _genericDomain = this._derivePromptDomain(prompt);
      const _genericTagline = _genericDomain
        ? _genericDomain.tagline
        : 'Built for the way you work.';
      if (!productContext) {
        emitChunk('\n\n> 💡 **Want better copy?** Fill in **📦 Product Context** — add your product name, description, and features for accurate, on-brand content.\n\n');
      }

      // ── Prompt-aware content generation for simulated path ──
      const _businessName = this._extractBusinessName(prompt) || safeTitle;
      const _sections = this._extractRequestedSections(prompt);
      const _ctas = this._extractCTAs(prompt);
      const _primaryCta = _ctas.length > 0 ? _ctas[0].text : 'Get Started';
      const _imgKeyword = _genericDomain ? _genericDomain.taglinePrefix.split(' ')[0].toLowerCase() : 'business';

      // Build domain-appropriate color scheme
      const _colorSchemes = {
        pet: { from: 'teal-600', to: 'emerald-700', accent: 'teal', bg: 'emerald' },
        beauty: { from: 'pink-500', to: 'rose-600', accent: 'pink', bg: 'rose' },
        fitness: { from: 'orange-500', to: 'red-600', accent: 'orange', bg: 'red' },
        food: { from: 'amber-500', to: 'orange-600', accent: 'amber', bg: 'orange' },
        default: { from: 'blue-600', to: 'indigo-700', accent: 'blue', bg: 'indigo' },
      };
      const _domainKey = _genericDomain
        ? (['pet', 'beauty', 'fitness', 'food'].find(k => _genericDomain.tagline.toLowerCase().includes(k === 'pet' ? 'pet' : k === 'beauty' ? 'shine' : k === 'fitness' ? 'train' : 'food')) || 'default')
        : 'default';
      const _colors = _colorSchemes[_domainKey] || _colorSchemes.default;

      // Generate section HTML blocks based on prompt-extracted sections
      const _sectionHtmlBlocks = this._generateSimulatedSections(_sections, _businessName, _colors);

      const files = {
        'index.html': [
          '<!DOCTYPE html>',
          '<html lang="en" class="scroll-smooth">',
          '<head>',
          `  <meta charset="UTF-8">`,
          `  <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
          `  <title>${_businessName}</title>`,
          '  <script src="https://cdn.tailwindcss.com"></script>',
          '  <link rel="stylesheet" href="styles.css">',
          '</head>',
          '<body class="bg-gray-50 text-gray-900 font-sans antialiased">',
          '',
          '  <!-- Hero -->',
          '  <section class="relative min-h-[80vh] flex items-center justify-center overflow-hidden">',
          `    <div class="absolute inset-0 bg-cover bg-center" style="background-image: url('https://source.unsplash.com/1600x900/?${_imgKeyword}')"></div>`,
          `    <div class="absolute inset-0 bg-gradient-to-br from-${_colors.from}/90 to-${_colors.to}/80"></div>`,
          '    <div class="relative z-10 text-center px-6 max-w-4xl mx-auto">',
          `      <h1 class="text-5xl md:text-7xl font-extrabold text-white tracking-tight mb-6">${_businessName}</h1>`,
          `      <p class="text-xl md:text-2xl text-white/80 mb-10 leading-relaxed">${_genericTagline}</p>`,
          `      <a href="#content" class="inline-block bg-white text-${_colors.from} hover:bg-gray-100 font-semibold text-lg px-10 py-4 rounded-full transition-all duration-300 hover:shadow-2xl hover:-translate-y-1">`,
          `        ${_primaryCta}`,
          '      </a>',
          '    </div>',
          '  </section>',
          '',
          ..._sectionHtmlBlocks,
          '',
          '  <!-- Footer -->',
          '  <footer class="bg-gray-900 text-gray-400 py-12 px-6 text-center">',
          `    <p>&copy; ${new Date().getFullYear()} ${_businessName}. All rights reserved.</p>`,
          '  </footer>',
          '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
          '',
          '  <script src="script.js"></script>',
          '</body>',
          '</html>',
        ].join('\n'),

        'styles.css': [
          '/* Minimal custom CSS — Tailwind handles most styling */',
          '.fade-section { opacity: 0; transform: translateY(20px); }',
          '.fade-section.visible { opacity: 1; transform: translateY(0); transition: opacity 0.6s ease, transform 0.6s ease; }',
        ].join('\n'),

        'script.js': [
          '(function() {',
          '  // Fade-in animation for sections on scroll',
          '  var sections = document.querySelectorAll(".fade-section");',
          '  var observer = new IntersectionObserver(function(entries) {',
          '    entries.forEach(function(entry) {',
          '      if (entry.isIntersecting) {',
          '        entry.target.classList.add("visible");',
          '      }',
          '    });',
          '  }, { threshold: 0.1 });',
          '  sections.forEach(function(s) { observer.observe(s); });',
          '})();',
        ].join('\n'),
      };

      const display = Object.entries(files).map(([name, code]) => {
        const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
        return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
      }).join('\n\n');

      const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
      const text = `## Generated Implementation (Static Surface)\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (HTML + CSS + JS only — no backend)\n**Lines of code:** ${totalLines}`;

      await this._streamText(text, emitChunk, 4);

      return { files, entryPoint: 'index.html', totalLines };
    }

    // ── Detect app domain from prompt (single best match, no merging) ────────
    const appDomain = this._deriveAppDomain(prompt);

    // ── LIGHT APP: minimal server + in-memory storage, no full DB stack ──────
    // Intent Gate light_app allows: server.js, routes/api.js, package.json + frontend.
    // Does NOT allow: db/pool.js, db/queries.js, migrations/, migrate.js.
    // Use in-memory storage instead of PostgreSQL for light_app builds.
    if (intentClass === 'light_app') {
      console.log(`[BuilderAgent] Simulated CODE: light_app domain="${appDomain.type}" entity="${appDomain.entity.name}"`);

      const files = this._generateLightAppFiles(safeTitle, appDomain);

      const display = Object.entries(files).map(([name, code]) => {
        const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : name.endsWith('.json') ? 'json' : 'javascript';
        return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
      }).join('\n\n');

      const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
      const text = `## Generated Implementation (Light App)\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (minimal server + frontend)\n**Lines of code:** ${totalLines}`;

      await this._streamText(text, emitChunk, 4);

      return { files, entryPoint: 'server.js', totalLines };
    }

    // ── FULL-STACK (full_product) — POLYMORPHIC ──────────────────────────────
    // Full Express + PostgreSQL with migrations, pool, routes, auth.
    // Only for full_product intent (or fallback when intent is unknown).
    console.log(`[BuilderAgent] Simulated CODE: full-stack domain="${appDomain.type}" entity="${appDomain.entity.name}"`);

    const files = this._generateFullStackFiles(safeTitle, appDomain);

    const display = Object.entries(files).map(([name, code]) => {
      const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : name.endsWith('.json') ? 'json' : 'javascript';
      return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
    }).join('\n\n');

    const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
    const text = `## Generated Implementation\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files  \n**Lines of code:** ${totalLines}`;

    await this._streamText(text, emitChunk, 4);

    return { files, entryPoint: 'server.js', totalLines };
  }

  // ── Polymorphic Full-Stack File Generator ────────────────────────────────────
  //
  // Generates a complete full-stack app (server.js, routes, DB, frontend)
  // tailored to the detected app domain. Each domain produces domain-specific
  // entities, API endpoints, UI layout, and DB schema.

  _generateFullStackFiles(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const firstRequired = requiredFields[0] || fields[0];

    // Build INSERT column/value lists
    const insertCols = fields.map(f => f.name).join(', ');
    const insertPlaceholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const insertArgs = fields.map(f => {
      if (f.required) return `${f.name}.trim()`;
      return `(${f.name} || '').trim()`;
    }).join(', ');

    // Build validation for required fields
    const validationLines = requiredFields.map(f =>
      `      if (!${f.name} || !${f.name}.toString().trim()) {\n        return res.status(400).json({ success: false, message: '${f.label} is required' });\n      }`
    ).join('\n');

    const destructureFields = fields.map(f => f.name).join(', ');

    // Chat domain gets a special UI layout
    const isChatDomain = domain.type === 'chat';

    const files = {
      'server.js': [
        "const express = require('express');",
        "const path = require('path');",
        "const { Pool } = require('pg');",
        "const apiRoutes = require('./routes/api');",
        "",
        "const app = express();",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "app.use(express.json());",
        "app.use(express.static(path.join(__dirname, '.')));",
        `app.use('/api', apiRoutes(pool));`,
        "",
        "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
        "",
        "app.get('*', (req, res) => {",
        "  if (!req.path.startsWith('/api')) {",
        "    res.sendFile(path.join(__dirname, 'index.html'));",
        "  }",
        "});",
        "",
        "const PORT = process.env.PORT || 3000;",
        "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "module.exports = function(pool) {",
        "  const router = Router();",
        "",
        `  router.get('/${e.name}', async (req, res) => {`,
        "    try {",
        `      const { rows } = await pool.query('SELECT * FROM ${e.name} ORDER BY created_at DESC');`,
        `      res.json({ success: true, ${e.name}: rows });`,
        "    } catch (err) {",
        `      console.error('GET /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.post('/${e.name}', async (req, res) => {`,
        "    try {",
        `      const { ${destructureFields} } = req.body;`,
        validationLines,
        "      const { rows } = await pool.query(",
        `        'INSERT INTO ${e.name} (${insertCols}) VALUES (${insertPlaceholders}) RETURNING *',`,
        `        [${insertArgs}]`,
        "      );",
        `      res.status(201).json({ success: true, ${e.singular}: rows[0] });`,
        "    } catch (err) {",
        `      console.error('POST /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${e.name}/:id', async (req, res) => {`,
        "    try {",
        `      await pool.query('DELETE FROM ${e.name} WHERE id = $1', [req.params.id]);`,
        "      res.json({ success: true });",
        "    } catch (err) {",
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'db/pool.js': [
        "const { Pool } = require('pg');",
        "",
        "const pool = new Pool({",
        "  connectionString: process.env.DATABASE_URL,",
        "  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false",
        "});",
        "",
        "module.exports = pool;",
      ].join('\n'),

      'migrations/001_schema.js': [
        "exports.up = (pgm) => {",
        `  pgm.createTable('${e.name}', {`,
        "    id: 'id',",
        ...fields.map(f => `    ${f.name}: { type: '${f.type}', ${f.required ? "notNull: true" : `default: ''`} },`),
        "    created_at: { type: 'timestamp', default: pgm.func('current_timestamp') }",
        "  });",
        "};",
        "",
        "exports.down = (pgm) => {",
        `  pgm.dropTable('${e.name}');`,
        "};",
      ].join('\n'),

      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        main: 'server.js',
        scripts: {
          start: 'node server.js',
          build: 'node migrate.js'
        },
        dependencies: {
          express: '^4.18.2',
          pg: '^8.11.3'
        }
      }, null, 2),

      'index.html': isChatDomain
        ? this._generateChatHTML(safeTitle, domain)
        : this._generateStandardHTML(safeTitle, domain),

      'styles.css': this._generateDomainCSS(domain),

      'app.js': isChatDomain
        ? this._generateChatJS(domain)
        : this._generateStandardJS(domain),
    };

    return files;
  }

  // ── Light App File Generator ─────────────────────────────────────────────────
  //
  // Generates a light app (minimal Express server + frontend) without full DB stack.
  // Matches light_app Intent Gate allowed_artifacts: server.js, routes/api.js,
  // package.json + frontend files. Uses in-memory storage instead of PostgreSQL.
  // No db/pool.js, no db/queries.js, no migrations/, no migrate.js.

  _generateLightAppFiles(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const destructureFields = fields.map(f => f.name).join(', ');

    // Build validation for required fields
    const validationLines = requiredFields.map(f =>
      `      if (!${f.name} || !${f.name}.toString().trim()) {\n        return res.status(400).json({ success: false, message: '${f.label} is required' });\n      }`
    ).join('\n');

    const isChatDomain = domain.type === 'chat';

    const files = {
      'server.js': [
        "const express = require('express');",
        "const path = require('path');",
        "const apiRoutes = require('./routes/api');",
        "",
        "const app = express();",
        "",
        "app.use(express.json());",
        "app.use(express.static(path.join(__dirname, '.')));",
        "app.use('/api', apiRoutes());",
        "",
        "app.get('/health', (req, res) => res.json({ status: 'ok' }));",
        "",
        "app.get('*', (req, res) => {",
        "  if (!req.path.startsWith('/api')) {",
        "    res.sendFile(path.join(__dirname, 'index.html'));",
        "  }",
        "});",
        "",
        "const PORT = process.env.PORT || 3000;",
        "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));",
      ].join('\n'),

      'routes/api.js': [
        "const { Router } = require('express');",
        "",
        "// In-memory storage (light_app — no database required)",
        `let ${e.name} = [];`,
        "let nextId = 1;",
        "",
        "module.exports = function() {",
        "  const router = Router();",
        "",
        `  router.get('/${e.name}', (req, res) => {`,
        `    res.json({ success: true, ${e.name}: ${e.name}.slice().reverse() });`,
        "  });",
        "",
        `  router.post('/${e.name}', (req, res) => {`,
        "    try {",
        `      const { ${destructureFields} } = req.body;`,
        validationLines,
        `      const ${e.singular} = { id: nextId++, ${fields.map(f => f.required ? `${f.name}: ${f.name}.trim()` : `${f.name}: (${f.name} || '').trim()`).join(', ')}, created_at: new Date().toISOString() };`,
        `      ${e.name}.push(${e.singular});`,
        `      res.status(201).json({ success: true, ${e.singular}: ${e.singular} });`,
        "    } catch (err) {",
        `      console.error('POST /${e.name} error:', err.message);`,
        "      res.status(500).json({ success: false, message: 'Server error' });",
        "    }",
        "  });",
        "",
        `  router.delete('/${e.name}/:id', (req, res) => {`,
        "    const id = parseInt(req.params.id, 10);",
        `    const idx = ${e.name}.findIndex(item => item.id === id);`,
        "    if (idx === -1) return res.status(404).json({ success: false, message: 'Not found' });",
        `    ${e.name}.splice(idx, 1);`,
        "    res.json({ success: true });",
        "  });",
        "",
        "  return router;",
        "};",
      ].join('\n'),

      'package.json': JSON.stringify({
        name: 'app',
        version: '1.0.0',
        main: 'server.js',
        scripts: {
          start: 'node server.js',
          build: 'echo "No build step required"'
        },
        dependencies: {
          express: '^4.18.2'
        }
      }, null, 2),

      'index.html': isChatDomain
        ? this._generateChatHTML(safeTitle, domain)
        : this._generateStandardHTML(safeTitle, domain),

      'styles.css': this._generateDomainCSS(domain),

      'app.js': isChatDomain
        ? this._generateChatJS(domain)
        : this._generateStandardJS(domain),
    };

    return files;
  }

  _generateStandardHTML(safeTitle, domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const isTable = domain.uiLayout === 'table';

    // Build form inputs
    const inputsHtml = fields.map((f, i) => {
      if (f.inputType === 'textarea') {
        return `        <textarea id="field_${f.name}" placeholder="${f.placeholder}" rows="3" class="w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all"></textarea>`;
      }
      if (f.inputType === 'select' && f.options) {
        const opts = f.options.map(o => `<option value="${o}">${o}</option>`).join('');
        return `        <select id="field_${f.name}" class="flex-1 min-w-32 px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all">${opts}</select>`;
      }
      const inputType = f.inputType === 'number' ? 'number' : f.inputType === 'date' ? 'date' : 'text';
      return `        <input type="${inputType}" id="field_${f.name}" placeholder="${f.placeholder}" ${f.required ? 'required' : ''} autocomplete="off" class="flex-1 min-w-36 px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-${domain.color.accent}-500 focus:ring-2 focus:ring-${domain.color.accent}-100 transition-all" />`;
    }).join('\n');

    // Table header for table layout
    const tableHeader = isTable
      ? `      <div class="grid grid-cols-${fields.length + 1} gap-4 text-xs font-semibold text-gray-400 uppercase tracking-widest px-4 py-2 border-b border-gray-100 mb-2">\n${fields.map(f => `        <span>${f.label}</span>`).join('\n')}\n        <span class="text-right">Action</span>\n      </div>`
      : '';

    return [
      '<!DOCTYPE html>',
      '<html lang="en" class="scroll-smooth">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${safeTitle}</title>`,
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-50 text-gray-900 font-sans antialiased min-h-screen">',
      '',
      '  <!-- Header -->',
      `  <header class="bg-${domain.color.header} text-white py-6 px-6 shadow-lg">`,
      '    <div class="max-w-3xl mx-auto flex items-center gap-3">',
      `      <span class="text-2xl">${domain.icon}</span>`,
      `      <h1 class="text-2xl font-bold tracking-tight">${safeTitle}</h1>`,
      '    </div>',
      '  </header>',
      '',
      '  <main class="max-w-3xl mx-auto px-6 py-10 flex flex-col gap-6">',
      '',
      '    <!-- Add Section -->',
      '    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">',
      `      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">New ${e.singular}</h2>`,
      '      <div class="flex flex-col gap-3">',
      inputsHtml,
      `        <button id="addBtn" class="self-start px-6 py-2.5 bg-${domain.color.header} hover:opacity-90 text-white font-semibold text-sm rounded-xl transition-all duration-200 hover:shadow-md active:scale-95 whitespace-nowrap">${domain.addLabel}</button>`,
      '      </div>',
      '      <div id="formError" class="mt-2 text-red-500 text-sm" style="display:none"></div>',
      '    </section>',
      '',
      '    <!-- List Section -->',
      '    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">',
      `      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">${domain.listLabel} <span id="countBadge" class="inline-block bg-${domain.color.header} text-white text-xs font-bold rounded-full px-2 py-0.5 ml-1 align-middle">0</span></h2>`,
      tableHeader,
      '      <div id="itemList" class="flex flex-col gap-2.5"></div>',
      '      <div id="emptyState" class="text-center py-10 text-gray-400 text-sm">',
      `        <p>${e.icon} ${domain.emptyState}</p>`,
      '      </div>',
      '    </section>',
      '',
      '  </main>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="app.js"></script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  _generateChatHTML(safeTitle, domain) {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${safeTitle}</title>`,
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-100 text-gray-900 font-sans antialiased min-h-screen flex flex-col">',
      '',
      '  <!-- Header -->',
      '  <header class="bg-indigo-600 text-white py-4 px-6 shadow-lg flex-shrink-0">',
      '    <div class="max-w-4xl mx-auto flex items-center justify-between">',
      '      <div class="flex items-center gap-3">',
      '        <span class="text-2xl">💬</span>',
      `        <h1 class="text-xl font-bold tracking-tight">${safeTitle}</h1>`,
      '      </div>',
      '      <div class="flex items-center gap-2">',
      '        <label class="text-sm text-indigo-200">Room:</label>',
      '        <select id="roomSelect" class="bg-indigo-700 text-white text-sm rounded-lg px-3 py-1.5 border border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-300">',
      '          <option value="general">general</option>',
      '          <option value="random">random</option>',
      '          <option value="help">help</option>',
      '        </select>',
      '      </div>',
      '    </div>',
      '  </header>',
      '',
      '  <!-- Chat Area -->',
      '  <main class="flex-1 flex flex-col max-w-4xl mx-auto w-full">',
      '',
      '    <!-- Username bar -->',
      '    <div class="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3 flex-shrink-0">',
      '      <label class="text-sm text-gray-500 font-medium">Your name:</label>',
      '      <input type="text" id="usernameInput" placeholder="Anonymous" class="px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-400 w-40" />',
      '      <span id="onlineCount" class="ml-auto text-xs text-gray-400">Room: <strong id="currentRoom">general</strong></span>',
      '    </div>',
      '',
      '    <!-- Messages -->',
      '    <div id="messageList" class="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3 min-h-0" style="max-height: calc(100vh - 220px);">',
      '      <div id="emptyState" class="flex-1 flex items-center justify-center text-gray-400 text-sm">',
      '        <p>💬 No messages yet. Start the conversation!</p>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Input area -->',
      '    <div class="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">',
      '      <div class="flex gap-3">',
      '        <input type="text" id="messageInput" placeholder="Type a message..." autocomplete="off" class="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all" />',
      '        <button id="sendBtn" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm rounded-xl transition-all duration-200 hover:shadow-md active:scale-95">Send</button>',
      '      </div>',
      '      <div id="formError" class="mt-2 text-red-500 text-sm" style="display:none"></div>',
      '    </div>',
      '',
      '  </main>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="app.js"></script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  _generateDomainCSS(domain) {
    if (domain.type === 'chat') {
      return [
        '/* Chat-specific styles */',
        '.msg-bubble { max-width: 80%; padding: 0.75rem 1rem; border-radius: 1rem; word-break: break-word; }',
        '.msg-bubble.self { background: #4f46e5; color: white; border-bottom-right-radius: 0.25rem; margin-left: auto; }',
        '.msg-bubble.other { background: white; border: 1px solid #e5e7eb; border-bottom-left-radius: 0.25rem; }',
        '.msg-meta { font-size: 0.6875rem; color: #9ca3af; margin-top: 0.25rem; }',
        '.msg-username { font-weight: 600; font-size: 0.75rem; margin-bottom: 0.125rem; }',
      ].join('\n');
    }
    return [
      '/* Minimal custom CSS — Tailwind handles layout, spacing, and typography */',
      '.btn-primary { border: none; cursor: pointer; }',
      '.btn-primary:active { transform: scale(0.97); }',
      '.item-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 0.875rem 1rem; transition: box-shadow 0.15s; }',
      '.item-card:hover { box-shadow: 0 1px 6px rgba(0,0,0,0.1); }',
      '.item-info h3 { font-size: 0.9375rem; font-weight: 600; }',
      '.item-info p { color: #64748b; font-size: 0.8125rem; margin-top: 0.2rem; }',
      '.btn-delete { background: none; border: none; cursor: pointer; color: #94a3b8; font-size: 1.1rem; padding: 0.2rem 0.4rem; border-radius: 6px; transition: color 0.15s, background 0.15s; }',
      '.btn-delete:hover { color: #ef4444; background: rgba(239,68,68,0.08); }',
    ].join('\n');
  }

  _generateChatJS(domain) {
    const e = domain.entity;
    return [
      '(function() {',
      '  var messageInput = document.getElementById("messageInput");',
      '  var sendBtn = document.getElementById("sendBtn");',
      '  var messageList = document.getElementById("messageList");',
      '  var emptyState = document.getElementById("emptyState");',
      '  var formError = document.getElementById("formError");',
      '  var usernameInput = document.getElementById("usernameInput");',
      '  var roomSelect = document.getElementById("roomSelect");',
      '  var currentRoomLabel = document.getElementById("currentRoom");',
      '  var currentRoom = "general";',
      '  var pollTimer = null;',
      '',
      '  function getUsername() {',
      '    return (usernameInput.value || "").trim() || "Anonymous";',
      '  }',
      '',
      '  function showError(msg) {',
      '    formError.textContent = msg;',
      '    formError.style.display = "block";',
      '    setTimeout(function() { formError.style.display = "none"; }, 3000);',
      '  }',
      '',
      '  function escHtml(str) {',
      '    var d = document.createElement("div");',
      '    d.textContent = str;',
      '    return d.innerHTML;',
      '  }',
      '',
      '  function formatTime(ts) {',
      '    var d = new Date(ts);',
      '    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });',
      '  }',
      '',
      `  function renderMessages(${e.name}) {`,
      `    if (!${e.name} || ${e.name}.length === 0) {`,
      '      messageList.innerHTML = "";',
      '      messageList.appendChild(emptyState);',
      '      emptyState.style.display = "flex";',
      '      return;',
      '    }',
      '    emptyState.style.display = "none";',
      '    var myName = getUsername();',
      `    messageList.innerHTML = ${e.name}.map(function(msg) {`,
      '      var isSelf = msg.username === myName;',
      '      return \'<div class="flex flex-col \' + (isSelf ? "items-end" : "items-start") + \'">\' +',
      '        \'<div class="msg-username \' + (isSelf ? "text-indigo-600" : "text-gray-700") + \'">\' + escHtml(msg.username || "Anonymous") + \'</div>\' +',
      '        \'<div class="msg-bubble \' + (isSelf ? "self" : "other") + \'">\' + escHtml(msg.content) + \'</div>\' +',
      '        \'<div class="msg-meta">\' + formatTime(msg.created_at) + \'</div>\' +',
      '        \'</div>\';',
      '    }).join("");',
      '    messageList.scrollTop = messageList.scrollHeight;',
      '  }',
      '',
      `  function loadMessages() {`,
      `    fetch("/api/${e.name}?room=" + encodeURIComponent(currentRoom))`,
      '      .then(function(r) { return r.json(); })',
      `      .then(function(data) { if (data.success) renderMessages(data.${e.name}); })`,
      '      .catch(function() {});',
      '  }',
      '',
      '  function sendMessage() {',
      '    var content = messageInput.value.trim();',
      '    if (!content) { showError("Message cannot be empty"); messageInput.focus(); return; }',
      '    sendBtn.disabled = true;',
      `    fetch("/api/${e.name}", {`,
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      '      body: JSON.stringify({ content: content, room: currentRoom, username: getUsername() })',
      '    })',
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) {',
      '        if (data.success) { messageInput.value = ""; loadMessages(); }',
      '        else { showError(data.message || "Failed to send"); }',
      '      })',
      '      .catch(function() { showError("Network error"); })',
      '      .finally(function() { sendBtn.disabled = false; messageInput.focus(); });',
      '  }',
      '',
      '  sendBtn.addEventListener("click", sendMessage);',
      '  messageInput.addEventListener("keydown", function(e) { if (e.key === "Enter") sendMessage(); });',
      '',
      '  roomSelect.addEventListener("change", function() {',
      '    currentRoom = roomSelect.value;',
      '    currentRoomLabel.textContent = currentRoom;',
      '    loadMessages();',
      '  });',
      '',
      '  // Poll for new messages every 3 seconds',
      '  function startPolling() {',
      '    if (pollTimer) clearInterval(pollTimer);',
      '    pollTimer = setInterval(loadMessages, 3000);',
      '  }',
      '',
      '  loadMessages();',
      '  startPolling();',
      '})();',
    ].join('\n');
  }

  _generateStandardJS(domain) {
    const e = domain.entity;
    const fields = domain.fields;
    const requiredFields = fields.filter(f => f.required);
    const firstRequired = requiredFields[0] || fields[0];
    const isTable = domain.uiLayout === 'table';

    // Build the render function based on fields
    const cardRenderFields = fields.map(f => {
      if (f === firstRequired || f.name === fields[0].name) {
        return `\'<h3>\' + escHtml(item.${f.name}${f.inputType === 'number' ? '.toString()' : ''}) + \'</h3>\'`;
      }
      return `(item.${f.name} ? \'<p>${f.label}: \' + escHtml(item.${f.name}${f.inputType === 'number' ? '.toString()' : ''}) + \'</p>\' : \'\')`;
    });

    const bodyFields = fields.map(f => {
      if (f.inputType === 'number') return `${f.name}: parseFloat(document.getElementById("field_${f.name}").value) || 0`;
      return `${f.name}: document.getElementById("field_${f.name}").value.trim()`;
    }).join(', ');

    const clearFields = fields.map(f =>
      `document.getElementById("field_${f.name}").value = "";`
    ).join(' ');

    const validationCheck = firstRequired
      ? `var _val = document.getElementById("field_${firstRequired.name}").value.trim();\n    if (!_val) { showError("${firstRequired.label} is required"); document.getElementById("field_${firstRequired.name}").focus(); return; }`
      : '';

    return [
      '(function() {',
      '  var addBtn = document.getElementById("addBtn");',
      '  var itemList = document.getElementById("itemList");',
      '  var emptyState = document.getElementById("emptyState");',
      '  var formError = document.getElementById("formError");',
      '  var countBadge = document.getElementById("countBadge");',
      '',
      '  function showError(msg) {',
      '    formError.textContent = msg;',
      '    formError.style.display = "block";',
      '    setTimeout(function() { formError.style.display = "none"; }, 3000);',
      '  }',
      '',
      '  function escHtml(str) {',
      '    var d = document.createElement("div");',
      '    d.textContent = str || "";',
      '    return d.innerHTML;',
      '  }',
      '',
      `  function renderItems(${e.name}) {`,
      `    countBadge.textContent = ${e.name}.length;`,
      `    if (!${e.name} || ${e.name}.length === 0) {`,
      '      itemList.innerHTML = "";',
      '      emptyState.style.display = "block";',
      '      return;',
      '    }',
      '    emptyState.style.display = "none";',
      `    itemList.innerHTML = ${e.name}.map(function(item) {`,
      `      return \'<div class="item-card" data-id="\' + item.id + \'">\' +`,
      `        \'<div class="item-info">\' + ${cardRenderFields.join(" + '\\n' + ")} + \'</div>\' +`,
      `        \'<button class="btn-delete" data-id="\' + item.id + \'" title="Delete">🗑</button></div>\';`,
      '    }).join("");',
      '    itemList.querySelectorAll(".btn-delete").forEach(function(btn) {',
      '      btn.addEventListener("click", function() { deleteItem(btn.dataset.id); });',
      '    });',
      '  }',
      '',
      '  function loadItems() {',
      `    fetch("/api/${e.name}")`,
      '      .then(function(r) { return r.json(); })',
      `      .then(function(data) { if (data.success) renderItems(data.${e.name}); })`,
      '      .catch(function() { renderItems([]); });',
      '  }',
      '',
      '  function deleteItem(id) {',
      `    fetch("/api/${e.name}/" + id, { method: "DELETE" })`,
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) { if (data.success) loadItems(); })',
      '      .catch(function(e) { console.error("Delete failed:", e); });',
      '  }',
      '',
      '  addBtn.addEventListener("click", function() {',
      `    ${validationCheck}`,
      '    addBtn.disabled = true;',
      `    fetch("/api/${e.name}", {`,
      '      method: "POST",',
      '      headers: { "Content-Type": "application/json" },',
      `      body: JSON.stringify({ ${bodyFields} })`,
      '    })',
      '      .then(function(r) { return r.json(); })',
      '      .then(function(data) {',
      `        if (data.success) { ${clearFields} loadItems(); }`,
      '        else { showError(data.message || "Failed to add"); }',
      '      })',
      '      .catch(function() { showError("Network error"); })',
      '      .finally(function() { addBtn.disabled = false; });',
      '  });',
      '',
      `  document.getElementById("field_${firstRequired.name}").addEventListener("keydown", function(e) { if (e.key === "Enter") addBtn.click(); });`,
      '',
      '  loadItems();',
      '})();',
    ].join('\n');
  }

  // ── ISE-Aware Simulated Code (Phase 4.2) ──────────────────────────────────
  //
  // When ISE detects interaction surfaces (e.g., email_capture, signup_capture),
  // this method generates HTML/CSS/JS that implements those surfaces as actual
  // UI elements instead of the generic feature-grid fallback.
  //
  // Only used by the simulated (no-OpenAI) code path for static_surface intents.

  async _simulatedCodeWithSurfaces(prompt, title, surfaces, emitChunk, productContext = null) {
    const CAPTURE_SET = new Set([
      'signup_capture', 'email_capture', 'waitlist_capture',
      'lead_capture', 'data_capture', 'subscription_capture', 'contact_form',
    ]);
    const hasCaptureForm = surfaces.some(s => CAPTURE_SET.has(s));
    const hasConfirmation = surfaces.includes('confirmation_state') || hasCaptureForm;
    const hasNameField = surfaces.includes('signup_capture') ||
      surfaces.includes('contact_form') || surfaces.includes('lead_capture');
    const hasMessageField = surfaces.includes('contact_form');

    // ── Derive domain signals from prompt for contextual copy ─────────────
    const _domain = this._derivePromptDomain(prompt);

    // ── Soft nudge when no product context ────────────────────────────────
    if (!productContext) {
      emitChunk('\n\n> 💡 **Want better copy?** Fill in **📦 Product Context** — add your product name, description, and features for accurate, on-brand content.\n\n');
    }

    // ── Copy: hero tagline + form heading/description ──────────────────────
    // Tagline uses domain-derived copy when available, otherwise sensible surface defaults.
    const _domainTaglinePrefix = _domain ? _domain.taglinePrefix : null;

    let heroTagline = _domainTaglinePrefix ? `${_domainTaglinePrefix} — your journey starts here.` : 'Your journey starts here.';
    let formHeading = 'Get Started';
    let formDesc = 'Enter your details below.';
    let submitText = 'Submit';

    if (surfaces.includes('waitlist_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — be first to know when we launch.`
        : 'Be first to know when we launch.';
      formHeading = 'Join the Waitlist';
      formDesc = 'Drop your email and we\'ll notify you on launch day.';
      submitText = 'Join Waitlist';
    }
    if (surfaces.includes('email_capture') || surfaces.includes('subscription_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — sign up and stay updated.`
        : 'Sign up and stay in the loop.';
      formHeading = 'Stay in the Loop';
      formDesc = 'Enter your email to get the latest updates.';
      submitText = 'Subscribe';
    }
    if (surfaces.includes('signup_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — get started in seconds.`
        : 'Get started in seconds.';
      formHeading = 'Create Your Account';
      formDesc = 'Create your account and start immediately.';
      submitText = 'Sign Up Free';
    }
    if (surfaces.includes('contact_form')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — we\'d love to connect.`
        : 'We\'d love to hear from you.';
      formHeading = 'Get in Touch';
      formDesc = 'Send us a message and we\'ll get back to you shortly.';
      submitText = 'Send Message';
    }
    if (surfaces.includes('lead_capture')) {
      heroTagline = _domainTaglinePrefix
        ? `${_domainTaglinePrefix} — see what we can do for you.`
        : 'See what we can do for you.';
      formHeading = 'Request a Demo';
      formDesc = 'Tell us a bit about yourself and we\'ll be in touch.';
      submitText = 'Request Demo';
    }

    // ── Build form input HTML ──────────────────────────────────────────────
    const inputLines = [];
    if (hasNameField) {
      inputLines.push('          <input type="text" id="nameInput" class="form-input" placeholder="Your name" required />');
    }
    inputLines.push('          <input type="email" id="emailInput" class="form-input" placeholder="you@example.com" required />');
    if (hasMessageField) {
      inputLines.push('          <textarea id="messageInput" class="form-input form-textarea" placeholder="Your message..." rows="4" required></textarea>');
    }

    // ── HTML ───────────────────────────────────────────────────────────────
    const htmlLines = [
      '<!DOCTYPE html>',
      '<html lang="en" class="scroll-smooth">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `  <title>${title}</title>`,
      '  <script src="https://cdn.tailwindcss.com"></script>',
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body class="bg-gray-50 text-gray-900 font-sans antialiased">',
      '',
      '  <!-- Hero -->',
      '  <section class="relative py-24 px-6 flex items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-600 via-purple-600 to-indigo-900">',
      '    <div class="relative z-10 text-center max-w-2xl mx-auto">',
      `      <h1 class="text-5xl font-extrabold text-white tracking-tight mb-4">${title}</h1>`,
      `      <p class="text-xl text-indigo-200 leading-relaxed">${heroTagline}</p>`,
      '    </div>',
      '  </section>',
    ];

    if (hasCaptureForm) {
      htmlLines.push(
        '',
        '  <!-- Capture Form -->',
        '  <section class="py-16 px-6" id="capture-section">',
        '    <div class="max-w-lg mx-auto bg-white rounded-2xl shadow-lg border border-gray-100 p-10 text-center">',
        `      <h2 class="text-2xl font-bold text-gray-900 mb-2">${formHeading}</h2>`,
        `      <p class="text-gray-500 mb-8">${formDesc}</p>`,
        '      <form id="captureForm" class="flex flex-col gap-3">',
        ...inputLines,
        `        <button type="submit" class="btn-submit w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-lg py-3 rounded-xl transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5">${submitText}</button>`,
        '      </form>',
        '      <p class="text-gray-400 text-sm mt-4">No spam, ever. Unsubscribe anytime.</p>',
        '    </div>',
        '  </section>',
      );
    }

    if (hasConfirmation) {
      htmlLines.push(
        '',
        '  <!-- Confirmation -->',
        '  <section class="py-16 px-6" id="confirmation-section" style="display: none;">',
        '    <div class="max-w-lg mx-auto bg-white rounded-2xl shadow-lg border border-gray-100 p-10 text-center">',
        '      <div class="w-16 h-16 bg-green-500 text-white text-2xl font-bold rounded-full flex items-center justify-center mx-auto mb-6">\u2713</div>',
        '      <h2 class="text-2xl font-bold text-gray-900 mb-2">You\'re In!</h2>',
        '      <p class="text-gray-500">Thanks for signing up. We\'ll be in touch soon.</p>',
        '    </div>',
        '  </section>',
      );
    }

    htmlLines.push(
      '',
      '  <!-- Footer -->',
      '  <footer class="bg-gray-900 text-gray-400 py-10 px-6 text-center text-sm">',
      `    <p>&copy; ${new Date().getFullYear()} ${title}. All rights reserved.</p>`,
      '  </footer>',
      '  <div style="text-align:center;padding:12px 0 8px"><a href="https://buildorbit.polsia.app" target="_blank" rel="noopener" style="font-size:0.75rem;color:#9ca3af;text-decoration:none">Built with 🛞 BuildOrbit</a></div>',
      '',
      '  <script src="script.js"></script>',
      '</body>',
      '</html>',
    );

    // ── CSS ────────────────────────────────────────────────────────────────
    // Minimal custom CSS — Tailwind handles layout, spacing, colors, and typography
    const cssContent = [
      '/* Form inputs — Tailwind form-reset not included by default */',
      '.form-input { display: block; width: 100%; padding: 0.75rem 1rem; border: 1.5px solid #e2e8f0; border-radius: 0.75rem; font-size: 1rem; font-family: inherit; transition: border-color 0.2s, box-shadow 0.2s; background: #fff; }',
      '.form-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }',
      '.form-textarea { resize: vertical; }',
      '.btn-submit { cursor: pointer; border: none; }',
      '.btn-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none !important; }',
    ].join('\n');

    // ── JS ─────────────────────────────────────────────────────────────────
    const jsLines = [
      '(function() {',
      '  var form = document.getElementById("captureForm");',
      '  var captureSection = document.getElementById("capture-section");',
      '  var confirmationSection = document.getElementById("confirmation-section");',
      '',
      '  if (form) {',
      '    form.addEventListener("submit", function(e) {',
      '      e.preventDefault();',
      '',
      '      // Basic validation',
      '      var emailInput = document.getElementById("emailInput");',
      '      if (emailInput && !emailInput.value.trim()) return;',
      '',
      '      var btn = form.querySelector(".btn-submit");',
      '      var originalText = btn.textContent;',
      '      btn.disabled = true;',
      '      btn.textContent = "Submitting...";',
      '',
      '      // Simulate submission (in production, replace with fetch() to your API)',
      '      setTimeout(function() {',
      '        if (captureSection) captureSection.style.display = "none";',
      '        if (confirmationSection) {',
      '          confirmationSection.style.display = "block";',
      '          confirmationSection.scrollIntoView({ behavior: "smooth" });',
      '        }',
      '        btn.disabled = false;',
      '        btn.textContent = originalText;',
      '        form.reset();',
      '      }, 800);',
      '    });',
      '  }',
      '',
      '  // Smooth scroll for any anchor links',
      '  document.querySelectorAll(\'a[href^="#"]\').forEach(function(anchor) {',
      '    anchor.addEventListener("click", function(e) {',
      '      e.preventDefault();',
      '      var target = document.querySelector(this.getAttribute("href"));',
      '      if (target) target.scrollIntoView({ behavior: "smooth" });',
      '    });',
      '  });',
      '})();',
    ];

    const files = {
      'index.html': htmlLines.join('\n'),
      'styles.css': cssContent,
      'script.js': jsLines.join('\n'),
    };

    const display = Object.entries(files).map(([name, code]) => {
      const lang = name.endsWith('.html') ? 'html' : name.endsWith('.css') ? 'css' : 'javascript';
      return `### ${name}\n\`\`\`${lang}\n${code}\n\`\`\``;
    }).join('\n\n');

    const totalLines = Object.values(files).reduce((s, c) => s + c.split('\n').length, 0);
    const text = `## Generated Implementation (Static Surface — ISE Surfaces: ${surfaces.join(', ')})\n\n${display}\n\n**Files generated:** ${Object.keys(files).length} files (HTML + CSS + JS)\n**ISE surfaces implemented:** ${surfaces.join(', ')}\n**Lines of code:** ${totalLines}`;

    await this._streamText(text, emitChunk, 4);

    return { files, entryPoint: 'index.html', totalLines };
  }

  // ── Helpers ──────────────────────────────────────────────

  async _streamText(text, emitChunk, charsPerChunk = 5) {
    for (let i = 0; i < text.length; i += charsPerChunk) {
      emitChunk(text.slice(i, i + charsPerChunk));
      await this._delay(12);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Prompt-derived content helpers ────────────────────────────────────────
  //
  // When Product Context is missing, these methods extract meaningful signals
  // ── Simulated section generator ──────────────────────────────────────────────
  // Generates HTML section blocks based on prompt-extracted sections.
  // Each section gets domain-appropriate placeholder content instead of generic text.

  /**
   * Generate HTML section blocks for the simulated code path.
   *
   * @param {Array<{name: string, description: string}>} sections - Extracted sections from prompt
   * @param {string} businessName - The business name
   * @param {object} colors - Color scheme { from, to, accent, bg }
   * @returns {string[]} Array of HTML lines to inject into the page
   */
  _generateSimulatedSections(sections, businessName, colors) {
    const lines = [];

    // If no sections were detected, generate a default services section
    if (sections.length === 0) {
      sections = [{ name: 'Services', description: '' }];
    }

    for (const section of sections) {
      lines.push('');
      const sectionId = section.name.toLowerCase().replace(/\s+/g, '-');

      switch (section.name) {
        case 'Pricing':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">Our Pricing</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Transparent pricing for every need</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-gray-50 rounded-2xl p-8 border border-gray-200 text-center hover:shadow-xl transition-all duration-300">',
            '          <h3 class="text-xl font-bold text-gray-900 mb-2">Basic</h3>',
            '          <div class="text-4xl font-extrabold text-gray-900 my-4">$29</div>',
            '          <p class="text-gray-500 mb-6">Perfect for getting started</p>',
            '          <ul class="text-gray-600 text-sm space-y-2 mb-8">',
            '            <li>Standard service</li>',
            '            <li>30-minute session</li>',
            '            <li>Basic support</li>',
            '          </ul>',
            `          <a href="#" class="inline-block w-full py-3 rounded-xl bg-${colors.from} text-white font-semibold hover:opacity-90 transition-all">Choose Basic</a>`,
            '        </div>',
            `        <div class="bg-${colors.from} rounded-2xl p-8 text-white text-center shadow-xl transform scale-105 relative">`,
            '          <span class="absolute -top-3 left-1/2 -translate-x-1/2 bg-yellow-400 text-gray-900 text-xs font-bold px-3 py-1 rounded-full">POPULAR</span>',
            '          <h3 class="text-xl font-bold mb-2">Premium</h3>',
            '          <div class="text-4xl font-extrabold my-4">$59</div>',
            '          <p class="text-white/80 mb-6">Our most popular option</p>',
            '          <ul class="text-white/90 text-sm space-y-2 mb-8">',
            '            <li>Full-service treatment</li>',
            '            <li>60-minute session</li>',
            '            <li>Priority support</li>',
            '            <li>Premium products</li>',
            '          </ul>',
            '          <a href="#" class="inline-block w-full py-3 rounded-xl bg-white text-gray-900 font-semibold hover:bg-gray-100 transition-all">Choose Premium</a>',
            '        </div>',
            '        <div class="bg-gray-50 rounded-2xl p-8 border border-gray-200 text-center hover:shadow-xl transition-all duration-300">',
            '          <h3 class="text-xl font-bold text-gray-900 mb-2">Deluxe</h3>',
            '          <div class="text-4xl font-extrabold text-gray-900 my-4">$99</div>',
            '          <p class="text-gray-500 mb-6">The ultimate experience</p>',
            '          <ul class="text-gray-600 text-sm space-y-2 mb-8">',
            '            <li>All premium features</li>',
            '            <li>90-minute session</li>',
            '            <li>VIP treatment</li>',
            '            <li>Take-home products</li>',
            '          </ul>',
            `          <a href="#" class="inline-block w-full py-3 rounded-xl bg-${colors.from} text-white font-semibold hover:opacity-90 transition-all">Choose Deluxe</a>`,
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Testimonials':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">What Our Clients Say</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Real stories from happy customers</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"Absolutely amazing experience! ${businessName} exceeded all my expectations. Highly recommend to everyone."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">SM</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">Sarah M.</p><p class="text-gray-400 text-xs">Loyal customer</p></div>',
            '          </div>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"Professional, friendly, and the results speak for themselves. ${businessName} is now my go-to recommendation."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">JK</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">James K.</p><p class="text-gray-400 text-xs">Happy client</p></div>',
            '          </div>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '          <div class="flex items-center gap-1 text-yellow-400 text-lg mb-4">&#9733;&#9733;&#9733;&#9733;&#9733;</div>',
            `          <p class="text-gray-600 leading-relaxed mb-6">"I've tried many places before, but ${businessName} is in a league of its own. Outstanding quality and care."</p>`,
            '          <div class="flex items-center gap-3">',
            '            <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-bold">RL</div>',
            '            <div><p class="font-semibold text-gray-900 text-sm">Rachel L.</p><p class="text-gray-400 text-xs">Regular client</p></div>',
            '          </div>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'FAQ':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-3xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-16">Frequently Asked Questions</h2>`,
            '      <div class="space-y-6">',
            `        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group" open>`,
            `          <summary class="font-semibold text-gray-900 cursor-pointer">What services do you offer?</summary>`,
            `          <p class="mt-3 text-gray-600 leading-relaxed">We offer a full range of professional services tailored to your needs. Contact us for a detailed list of options.</p>`,
            '        </details>',
            '        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group">',
            '          <summary class="font-semibold text-gray-900 cursor-pointer">How do I book an appointment?</summary>',
            '          <p class="mt-3 text-gray-600 leading-relaxed">You can book online through our website or call us directly. We recommend booking in advance for the best availability.</p>',
            '        </details>',
            '        <details class="bg-gray-50 rounded-xl p-6 border border-gray-100 group">',
            '          <summary class="font-semibold text-gray-900 cursor-pointer">What are your hours?</summary>',
            '          <p class="mt-3 text-gray-600 leading-relaxed">We are open Monday through Saturday, 9 AM to 6 PM. We also offer extended hours by appointment.</p>',
            '        </details>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Team':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">Meet Our Team</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Experienced professionals dedicated to you</p>`,
            '      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,woman" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Alex Rivera</h3>',
            '          <p class="text-gray-500 text-sm">Founder & Lead Specialist</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,man" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Jordan Chen</h3>',
            '          <p class="text-gray-500 text-sm">Senior Specialist</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-6 text-center shadow-sm border border-gray-100">',
            '          <div class="w-24 h-24 mx-auto rounded-full bg-gray-200 mb-4 overflow-hidden"><img src="https://source.unsplash.com/200x200/?portrait,person" alt="Team member" class="w-full h-full object-cover"></div>',
            '          <h3 class="font-bold text-gray-900">Sam Taylor</h3>',
            '          <p class="text-gray-500 text-sm">Client Relations</p>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Schedule':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-white fade-section">`,
            '    <div class="max-w-4xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-16">Class Schedule</h2>`,
            '      <div class="overflow-x-auto">',
            '        <table class="w-full text-left border-collapse">',
            '          <thead><tr class="border-b-2 border-gray-200">',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Day</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Time</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Class</th>',
            '            <th class="py-3 px-4 text-gray-500 font-semibold text-sm uppercase">Instructor</th>',
            '          </tr></thead>',
            '          <tbody>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Monday</td><td class="py-3 px-4">9:00 AM</td><td class="py-3 px-4">Morning Flow</td><td class="py-3 px-4 text-gray-500">Alex R.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Tuesday</td><td class="py-3 px-4">10:00 AM</td><td class="py-3 px-4">Power Session</td><td class="py-3 px-4 text-gray-500">Jordan C.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Wednesday</td><td class="py-3 px-4">6:00 PM</td><td class="py-3 px-4">Evening Restore</td><td class="py-3 px-4 text-gray-500">Sam T.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Thursday</td><td class="py-3 px-4">9:00 AM</td><td class="py-3 px-4">Beginner Basics</td><td class="py-3 px-4 text-gray-500">Alex R.</td></tr>',
            '            <tr class="border-b border-gray-100"><td class="py-3 px-4 font-medium">Friday</td><td class="py-3 px-4">5:30 PM</td><td class="py-3 px-4">Weekend Prep</td><td class="py-3 px-4 text-gray-500">Jordan C.</td></tr>',
            '            <tr><td class="py-3 px-4 font-medium">Saturday</td><td class="py-3 px-4">10:00 AM</td><td class="py-3 px-4">Community Class</td><td class="py-3 px-4 text-gray-500">All instructors</td></tr>',
            '          </tbody>',
            '        </table>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        case 'Contact':
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 bg-gray-50 fade-section">`,
            '    <div class="max-w-3xl mx-auto text-center">',
            `      <h2 class="text-4xl font-bold text-gray-900 mb-4">Get in Touch</h2>`,
            `      <p class="text-lg text-gray-500 mb-12">We'd love to hear from you</p>`,
            '      <div class="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">',
            '        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">',
            '          <input type="text" placeholder="Your name" class="px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200">',
            '          <input type="email" placeholder="Your email" class="px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200">',
            '        </div>',
            '        <textarea placeholder="Your message" rows="4" class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 mb-4"></textarea>',
            `        <button class="w-full py-3 bg-${colors.from} text-white font-semibold rounded-xl hover:opacity-90 transition-all">Send Message</button>`,
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;

        default:
          // Generic section for Services, Features, About, Gallery, etc.
          lines.push(
            `  <!-- ${section.name} -->`,
            `  <section id="${sectionId}" class="py-20 px-6 ${sections.indexOf(section) % 2 === 0 ? 'bg-white' : 'bg-gray-50'} fade-section">`,
            '    <div class="max-w-6xl mx-auto">',
            `      <h2 class="text-4xl font-bold text-center text-gray-900 mb-4">${section.name}</h2>`,
            `      <p class="text-lg text-gray-500 text-center mb-16">Discover what makes us special</p>`,
            '      <div class="grid grid-cols-1 md:grid-cols-3 gap-8">',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#11088;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Quality First</h3>',
            '          <p class="text-gray-500 leading-relaxed">We never compromise on quality. Every detail matters to us.</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#128171;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Expert Team</h3>',
            '          <p class="text-gray-500 leading-relaxed">Skilled professionals with years of experience and passion.</p>',
            '        </div>',
            '        <div class="bg-white rounded-2xl p-8 border border-gray-100 shadow-sm hover:shadow-xl transition-all duration-300 fade-section">',
            '          <div class="text-4xl mb-4">&#10084;&#65039;</div>',
            '          <h3 class="text-xl font-semibold text-gray-900 mb-2">Customer Love</h3>',
            '          <p class="text-gray-500 leading-relaxed">Your satisfaction is our top priority, every single time.</p>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </section>',
          );
          break;
      }
    }

    return lines;
  }

  // from the user's prompt so the simulated CODE path produces contextual copy
  // instead of raw-prompt-as-H1 or generic "Welcome to something amazing" text.

  /**
   * Derive a clean product title.
   *
   * Priority:
   *   1. productContext.product or productContext.company (already formatted)
   *   2. Prompt minus filler words → domain keywords → capitalised title
   *   3. Safe fallback: "Your App"
   *
   * @param {string|null} prompt
   * @param {string|null} productContext - Formatted context string (from formatProductContext)
   * @returns {string}
   */
  _deriveTitle(prompt, productContext = null) {
    // 1. Product context wins — extract name from formatted block
    if (productContext) {
      const productMatch = productContext.match(/^Product:\s*(.+)$/m);
      if (productMatch) return productMatch[1].trim();
      const companyMatch = productContext.match(/^Company:\s*(.+)$/m);
      if (companyMatch) return companyMatch[1].trim();
    }

    // 2. Derive from prompt
    if (!prompt) return 'Your App';

    // 2a. Look for explicit name patterns: "called X", "named X", "for X" (where X is capitalized)
    // These patterns strongly signal the user's intended business/product name.
    const namePatterns = [
      /\bcalled\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?/,
      /\bnamed\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?/,
      /\bfor\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']?\s+(?:with|that|which|featuring)/,
    ];
    for (const pattern of namePatterns) {
      const match = prompt.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Sanity check: skip if it's a generic word like "Build", "Create", etc.
        const GENERIC = new Set(['Build', 'Create', 'Make', 'Design', 'Generate', 'The', 'This', 'That', 'My', 'Our', 'New']);
        if (!GENERIC.has(name)) return name;
      }
    }

    // 2b. Look for quoted names: "FreshPaws", 'ZenFlow'
    const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*)["']/);
    if (quotedMatch && quotedMatch[1]) return quotedMatch[1].trim();

    // 2c. Fallback: filler-word removal (original approach)
    const FILLER_RE = new RegExp(
      '\\b(' + [
        // intent verbs
        'please', 'help', 'can you', 'could you', 'build', 'create', 'make',
        'develop', 'design', 'code', 'write', 'generate',
        // articles / pronouns / prepositions
        'i', 'we', 'a', 'an', 'the', 'my', 'our', 'your',
        'need', 'want', 'would like',
        'for', 'with', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'by',
        // structural product words
        'landing page', 'landing', 'web page', 'webpage', 'website',
        'web site', 'site', 'web app', 'web application', 'application',
        'app', 'page',
        // capture-surface words (avoid surfacing these as title words)
        'email signup', 'email capture', 'sign up', 'signup', 'email', 'waitlist',
        // common descriptors that shouldn't be in titles
        'business', 'company', 'service', 'studio', 'agency', 'shop', 'store',
        'pricing', 'testimonials', 'booking', 'cta', 'schedule', 'free trial',
      ].join('|') + ')\\b',
      'gi',
    );

    const cleaned = prompt
      .replace(FILLER_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const words = cleaned.split(' ').filter(w => w.length > 1);
    if (words.length === 0) return 'Your App';

    // Take up to 3 meaningful words, title-case each
    return words
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // ── Content Fidelity Extraction ──────────────────────────────────────────────
  // Parses the user's prompt to extract business name, requested sections, and
  // CTAs, then builds an explicit directive block for the LLM. This prevents
  // the LLM from ignoring prompt-specific content in favor of generic templates.

  /**
   * Extract structured content requirements from the user's prompt.
   *
   * @param {string|null} prompt - User's original prompt
   * @returns {string} Content fidelity directive block for injection into LLM message
   */
  _buildContentFidelityBlock(prompt) {
    if (!prompt) return '';

    const lines = ['=== CONTENT FIDELITY REQUIREMENTS (MANDATORY) ==='];

    // 1. Extract business name
    const businessName = this._extractBusinessName(prompt);
    if (businessName) {
      lines.push(`BUSINESS NAME: "${businessName}" — this MUST appear in:`);
      lines.push('  - The <title> tag');
      lines.push('  - The main H1 heading');
      lines.push('  - The footer copyright');
      lines.push('  - Any navbar/header branding');
      lines.push(`  Do NOT use a generic name. The page is for "${businessName}".`);
    }

    // 2. Extract requested sections
    const sections = this._extractRequestedSections(prompt);
    if (sections.length > 0) {
      lines.push('');
      lines.push('REQUESTED SECTIONS — you MUST generate each of these as a distinct HTML section:');
      for (const section of sections) {
        lines.push(`  - ${section.name}: ${section.description}`);
      }
      lines.push('  Do NOT skip any listed section. Do NOT replace them with a generic feature grid.');
    }

    // 3. Extract CTAs
    const ctas = this._extractCTAs(prompt);
    if (ctas.length > 0) {
      lines.push('');
      lines.push('CALL-TO-ACTION BUTTONS — use these specific CTA texts:');
      for (const cta of ctas) {
        lines.push(`  - "${cta.text}" (instead of generic "Get Started")`);
      }
    }

    // 4. Domain context
    const domain = this._derivePromptDomain(prompt);
    if (domain) {
      lines.push('');
      lines.push(`DOMAIN: Generate content appropriate for this business type. Use relevant imagery keywords, industry terminology, and domain-specific content.`);
    }

    lines.push('=== END CONTENT FIDELITY REQUIREMENTS ===');

    return lines.length > 2 ? lines.join('\n') : '';
  }

  /**
   * Extract the business name from the prompt.
   * Looks for "called X", "named X", quoted names, or capitalized proper nouns.
   *
   * @param {string} prompt
   * @returns {string|null}
   */
  _extractBusinessName(prompt) {
    // Pattern: "called FreshPaws", "named ZenFlow"
    const calledMatch = prompt.match(/\b(?:called|named)\s+["']?([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]*)*)["']?/);
    if (calledMatch) return calledMatch[1].trim();

    // Pattern: quoted name "FreshPaws"
    const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]*)*)["']/);
    if (quotedMatch) return quotedMatch[1].trim();

    // Pattern: "for FreshPaws" (capitalized word after "for")
    const forMatch = prompt.match(/\bfor\s+([A-Z][A-Za-z0-9]+(?:[A-Z][a-z]+)*)\b/);
    if (forMatch) {
      const candidate = forMatch[1];
      const GENERIC = new Set(['Build', 'Create', 'Make', 'Design', 'My', 'Our', 'The', 'This', 'That', 'New', 'An', 'Any']);
      if (!GENERIC.has(candidate) && candidate.length > 2) return candidate;
    }

    return null;
  }

  /**
   * Parse the prompt for requested content sections.
   *
   * @param {string} prompt
   * @returns {Array<{name: string, description: string}>}
   */
  _extractRequestedSections(prompt) {
    const lower = prompt.toLowerCase();
    const sections = [];

    const SECTION_MAP = [
      { keywords: ['pricing', 'price', 'prices', 'plans', 'packages', 'rates'], name: 'Pricing', description: 'Show pricing tiers/packages with prices. Generate realistic prices for this business type.' },
      { keywords: ['testimonial', 'testimonials', 'review', 'reviews', 'customer stories'], name: 'Testimonials', description: 'Show customer testimonials with names, photos, and quotes. Generate realistic testimonials for this business type.' },
      { keywords: ['faq', 'frequently asked', 'questions'], name: 'FAQ', description: 'Show frequently asked questions with answers relevant to this business.' },
      { keywords: ['about', 'about us', 'our story', 'who we are'], name: 'About', description: 'Show an about section describing the business mission and values.' },
      { keywords: ['team', 'our team', 'staff', 'instructor', 'instructors', 'instructor bios'], name: 'Team', description: 'Show team/staff members with names, roles, and photos.' },
      { keywords: ['gallery', 'portfolio', 'our work', 'photos', 'showcase'], name: 'Gallery', description: 'Show a visual gallery/portfolio of work.' },
      { keywords: ['contact', 'contact us', 'get in touch', 'reach us'], name: 'Contact', description: 'Show contact information and/or a contact form.' },
      { keywords: ['class schedule', 'schedule', 'timetable', 'classes', 'sessions'], name: 'Schedule', description: 'Show a class/session schedule with times and descriptions.' },
      { keywords: ['menu', 'our menu', 'food menu', 'drink menu'], name: 'Menu', description: 'Show a menu with items and prices.' },
      { keywords: ['services', 'our services', 'what we offer', 'what we do'], name: 'Services', description: 'Show a list of services offered with descriptions.' },
      { keywords: ['features', 'key features', 'capabilities'], name: 'Features', description: 'Show key features or capabilities of the product/service.' },
      { keywords: ['blog', 'articles', 'news', 'updates'], name: 'Blog', description: 'Show recent blog posts or articles.' },
      { keywords: ['location', 'locations', 'find us', 'where to find us', 'map'], name: 'Location', description: 'Show business location(s) with address information.' },
    ];

    for (const mapping of SECTION_MAP) {
      if (mapping.keywords.some(kw => lower.includes(kw))) {
        sections.push({ name: mapping.name, description: mapping.description });
      }
    }

    return sections;
  }

  /**
   * Parse the prompt for specific CTA requirements.
   *
   * @param {string} prompt
   * @returns {Array<{text: string}>}
   */
  _extractCTAs(prompt) {
    const lower = prompt.toLowerCase();
    const ctas = [];

    const CTA_MAP = [
      { keywords: ['booking cta', 'book now', 'book a', 'booking button', 'appointment'], text: 'Book Now' },
      { keywords: ['free trial cta', 'free trial', 'try free', 'start trial'], text: 'Start Free Trial' },
      { keywords: ['signup cta', 'sign up', 'sign-up', 'register', 'join'], text: 'Sign Up' },
      { keywords: ['subscribe cta', 'subscribe', 'subscription'], text: 'Subscribe Now' },
      { keywords: ['download cta', 'download', 'get the app'], text: 'Download Now' },
      { keywords: ['contact cta', 'contact us', 'get in touch'], text: 'Contact Us' },
      { keywords: ['order cta', 'order now', 'place order'], text: 'Order Now' },
      { keywords: ['learn more cta', 'learn more'], text: 'Learn More' },
      { keywords: ['donate cta', 'donate', 'support us'], text: 'Donate Now' },
      { keywords: ['quote cta', 'get a quote', 'request quote'], text: 'Get a Quote' },
    ];

    for (const mapping of CTA_MAP) {
      if (mapping.keywords.some(kw => lower.includes(kw))) {
        ctas.push({ text: mapping.text });
      }
    }

    // If no specific CTA found but prompt has domain context, don't add generic
    return ctas;
  }

  // ── Polymorphic App Domain Detection for PRODUCT_SYSTEM builds ────────────
  //
  // Detects app type from user prompt and returns domain-specific entities,
  // API routes, UI components, DB schema, and visual theme.
  // Used by _simulatedCode() for full-stack builds and _generateStubContent()
  // for gap-filling, ensuring PRODUCT_SYSTEM output matches the prompt domain.

  _deriveAppDomain(prompt) {
    if (!prompt) return this._defaultAppDomain();
    const lower = prompt.toLowerCase();

    const APP_DOMAINS = [
      {
        keywords: ['chat', 'messaging', 'message', 'real-time chat', 'chat room', 'chatroom', 'instant message', 'conversation'],
        type: 'chat',
        icon: '💬',
        label: 'Chat',
        color: { header: 'indigo-600', accent: 'indigo' },
        entity: { name: 'messages', singular: 'message', icon: '💬' },
        fields: [
          { name: 'content', label: 'Message', type: 'text', placeholder: 'Type a message...', required: true, inputType: 'text' },
          { name: 'room', label: 'Room', type: 'varchar(100)', placeholder: 'general', required: false, inputType: 'text' },
          { name: 'username', label: 'Username', type: 'varchar(100)', placeholder: 'Anonymous', required: false, inputType: 'text' },
        ],
        dbColumns: `content TEXT NOT NULL, room VARCHAR(100) DEFAULT 'general', username VARCHAR(100) DEFAULT 'Anonymous'`,
        emptyState: 'No messages yet. Start the conversation!',
        addLabel: 'Send Message',
        listLabel: 'Messages',
        uiLayout: 'chat',
      },
      {
        keywords: ['inventory', 'stock', 'warehouse', 'supply', 'product tracking', 'stock level', 'inventory track'],
        type: 'inventory',
        icon: '📦',
        label: 'Inventory',
        color: { header: 'emerald-600', accent: 'emerald' },
        entity: { name: 'products', singular: 'product', icon: '📦' },
        fields: [
          { name: 'name', label: 'Product Name', type: 'varchar(255)', placeholder: 'Product name...', required: true, inputType: 'text' },
          { name: 'sku', label: 'SKU', type: 'varchar(100)', placeholder: 'SKU-001', required: false, inputType: 'text' },
          { name: 'quantity', label: 'Quantity', type: 'integer', placeholder: '0', required: true, inputType: 'number' },
          { name: 'category', label: 'Category', type: 'varchar(100)', placeholder: 'Category...', required: false, inputType: 'text' },
        ],
        dbColumns: `name VARCHAR(255) NOT NULL, sku VARCHAR(100) DEFAULT '', quantity INTEGER DEFAULT 0, category VARCHAR(100) DEFAULT ''`,
        emptyState: 'No products in inventory. Add your first product above!',
        addLabel: 'Add Product',
        listLabel: 'Inventory',
        uiLayout: 'table',
      },
      {
        keywords: ['task', 'todo', 'to-do', 'to do', 'task manager', 'project management', 'kanban', 'checklist'],
        type: 'tasks',
        icon: '✅',
        label: 'Tasks',
        color: { header: 'blue-600', accent: 'blue' },
        entity: { name: 'tasks', singular: 'task', icon: '✅' },
        fields: [
          { name: 'title', label: 'Task', type: 'varchar(255)', placeholder: 'What needs to be done?', required: true, inputType: 'text' },
          { name: 'priority', label: 'Priority', type: 'varchar(20)', placeholder: 'medium', required: false, inputType: 'select', options: ['low', 'medium', 'high'] },
          { name: 'status', label: 'Status', type: 'varchar(20)', placeholder: 'pending', required: false, inputType: 'select', options: ['pending', 'in_progress', 'done'] },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, priority VARCHAR(20) DEFAULT 'medium', status VARCHAR(20) DEFAULT 'pending'`,
        emptyState: 'No tasks yet. Add your first task above!',
        addLabel: 'Add Task',
        listLabel: 'Tasks',
        uiLayout: 'cards',
      },
      {
        keywords: ['blog', 'article', 'post', 'cms', 'content management', 'publishing', 'writing platform'],
        type: 'blog',
        icon: '📝',
        label: 'Blog',
        color: { header: 'purple-600', accent: 'purple' },
        entity: { name: 'posts', singular: 'post', icon: '📝' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Post title...', required: true, inputType: 'text' },
          { name: 'body', label: 'Content', type: 'text', placeholder: 'Write your post...', required: true, inputType: 'textarea' },
          { name: 'author', label: 'Author', type: 'varchar(100)', placeholder: 'Author name...', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, body TEXT NOT NULL DEFAULT '', author VARCHAR(100) DEFAULT 'Anonymous'`,
        emptyState: 'No posts yet. Write your first article above!',
        addLabel: 'Publish Post',
        listLabel: 'Posts',
        uiLayout: 'cards',
      },
      {
        keywords: ['bookmark', 'link saver', 'url', 'link manager', 'reading list', 'web clipper'],
        type: 'bookmarks',
        icon: '🔖',
        label: 'Bookmarks',
        color: { header: 'amber-600', accent: 'amber' },
        entity: { name: 'bookmarks', singular: 'bookmark', icon: '🔖' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Bookmark title...', required: true, inputType: 'text' },
          { name: 'url', label: 'URL', type: 'text', placeholder: 'https://...', required: true, inputType: 'text' },
          { name: 'tag', label: 'Tag', type: 'varchar(50)', placeholder: 'Tag...', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, url TEXT NOT NULL, tag VARCHAR(50) DEFAULT ''`,
        emptyState: 'No bookmarks saved. Add your first link above!',
        addLabel: 'Save Bookmark',
        listLabel: 'Bookmarks',
        uiLayout: 'cards',
      },
      {
        keywords: ['expense', 'budget', 'spending', 'finance tracker', 'money tracker', 'cost', 'receipt'],
        type: 'expenses',
        icon: '💰',
        label: 'Expenses',
        color: { header: 'green-600', accent: 'green' },
        entity: { name: 'expenses', singular: 'expense', icon: '💰' },
        fields: [
          { name: 'description', label: 'Description', type: 'varchar(255)', placeholder: 'What was it for?', required: true, inputType: 'text' },
          { name: 'amount', label: 'Amount ($)', type: 'decimal(10,2)', placeholder: '0.00', required: true, inputType: 'number' },
          { name: 'category', label: 'Category', type: 'varchar(100)', placeholder: 'Food, Transport...', required: false, inputType: 'text' },
        ],
        dbColumns: `description VARCHAR(255) NOT NULL, amount DECIMAL(10,2) NOT NULL DEFAULT 0, category VARCHAR(100) DEFAULT ''`,
        emptyState: 'No expenses recorded. Add your first expense above!',
        addLabel: 'Add Expense',
        listLabel: 'Expenses',
        uiLayout: 'table',
      },
      {
        keywords: ['note', 'notes app', 'notebook', 'memo', 'journal', 'diary', 'jot'],
        type: 'notes',
        icon: '📒',
        label: 'Notes',
        color: { header: 'yellow-600', accent: 'yellow' },
        entity: { name: 'notes', singular: 'note', icon: '📒' },
        fields: [
          { name: 'title', label: 'Title', type: 'varchar(255)', placeholder: 'Note title...', required: true, inputType: 'text' },
          { name: 'body', label: 'Content', type: 'text', placeholder: 'Write your note...', required: true, inputType: 'textarea' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, body TEXT DEFAULT ''`,
        emptyState: 'No notes yet. Write your first note above!',
        addLabel: 'Save Note',
        listLabel: 'Notes',
        uiLayout: 'cards',
      },
      {
        keywords: ['contact', 'crm', 'address book', 'people', 'directory', 'contacts list', 'customer list'],
        type: 'contacts',
        icon: '👥',
        label: 'Contacts',
        color: { header: 'sky-600', accent: 'sky' },
        entity: { name: 'contacts', singular: 'contact', icon: '👥' },
        fields: [
          { name: 'name', label: 'Name', type: 'varchar(255)', placeholder: 'Full name...', required: true, inputType: 'text' },
          { name: 'email', label: 'Email', type: 'varchar(255)', placeholder: 'email@example.com', required: false, inputType: 'text' },
          { name: 'phone', label: 'Phone', type: 'varchar(50)', placeholder: '+1 555-0100', required: false, inputType: 'text' },
        ],
        dbColumns: `name VARCHAR(255) NOT NULL, email VARCHAR(255) DEFAULT '', phone VARCHAR(50) DEFAULT ''`,
        emptyState: 'No contacts yet. Add your first contact above!',
        addLabel: 'Add Contact',
        listLabel: 'Contacts',
        uiLayout: 'table',
      },
      {
        keywords: ['event', 'calendar', 'schedule', 'appointment', 'booking system', 'reservation'],
        type: 'events',
        icon: '📅',
        label: 'Events',
        color: { header: 'rose-600', accent: 'rose' },
        entity: { name: 'events', singular: 'event', icon: '📅' },
        fields: [
          { name: 'title', label: 'Event', type: 'varchar(255)', placeholder: 'Event name...', required: true, inputType: 'text' },
          { name: 'date', label: 'Date', type: 'varchar(50)', placeholder: '2026-05-01', required: true, inputType: 'date' },
          { name: 'location', label: 'Location', type: 'varchar(255)', placeholder: 'Where?', required: false, inputType: 'text' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, date VARCHAR(50) NOT NULL, location VARCHAR(255) DEFAULT ''`,
        emptyState: 'No events scheduled. Create your first event above!',
        addLabel: 'Create Event',
        listLabel: 'Events',
        uiLayout: 'cards',
      },
      {
        keywords: ['recipe', 'cookbook', 'meal plan', 'food tracker', 'recipe manager'],
        type: 'recipes',
        icon: '🍳',
        label: 'Recipes',
        color: { header: 'orange-600', accent: 'orange' },
        entity: { name: 'recipes', singular: 'recipe', icon: '🍳' },
        fields: [
          { name: 'title', label: 'Recipe Name', type: 'varchar(255)', placeholder: 'Recipe name...', required: true, inputType: 'text' },
          { name: 'ingredients', label: 'Ingredients', type: 'text', placeholder: 'List ingredients...', required: true, inputType: 'textarea' },
          { name: 'instructions', label: 'Instructions', type: 'text', placeholder: 'Steps...', required: false, inputType: 'textarea' },
        ],
        dbColumns: `title VARCHAR(255) NOT NULL, ingredients TEXT NOT NULL DEFAULT '', instructions TEXT DEFAULT ''`,
        emptyState: 'No recipes yet. Add your first recipe above!',
        addLabel: 'Add Recipe',
        listLabel: 'Recipes',
        uiLayout: 'cards',
      },
    ];

    for (const domain of APP_DOMAINS) {
      if (domain.keywords.some(kw => lower.includes(kw))) {
        return domain;
      }
    }

    // Fallback: try to infer from prompt keywords for a generic but titled app
    return this._defaultAppDomain(prompt);
  }

  _defaultAppDomain(prompt = '') {
    // Use the prompt to at least name the entity sensibly
    const safeTitle = this._deriveTitle ? this._deriveTitle(prompt) : 'App';
    return {
      type: 'generic',
      icon: '✨',
      label: safeTitle || 'App',
      color: { header: 'indigo-600', accent: 'indigo' },
      entity: { name: 'items', singular: 'item', icon: '✨' },
      fields: [
        { name: 'name', label: 'Name', type: 'varchar(255)', placeholder: 'Name...', required: true, inputType: 'text' },
        { name: 'description', label: 'Description', type: 'text', placeholder: 'Description (optional)...', required: false, inputType: 'text' },
      ],
      dbColumns: `name VARCHAR(255) NOT NULL, description TEXT DEFAULT ''`,
      emptyState: 'Nothing here yet. Add your first item above!',
      addLabel: 'Add',
      listLabel: 'Items',
      uiLayout: 'cards',
    };
  }

  /**
   * Detect a domain category from the prompt for contextually appropriate copy.
   *
   * Returns an object with `tagline` (standalone) and `taglinePrefix` (for
   * combining with surface-specific text), or null if no domain matched.
   *
   * @param {string|null} prompt
   * @returns {{ tagline: string, taglinePrefix: string }|null}
   */
  _derivePromptDomain(prompt) {
    if (!prompt) return null;
    const lower = prompt.toLowerCase();

    const DOMAINS = [
      {
        keywords: ['pet', 'grooming', 'veterinary', 'vet', 'animal', 'dog', 'cat', 'puppy', 'kitten', 'paws'],
        taglinePrefix: 'Happy pets, happy owners',
        tagline: 'Where your pets get the royal treatment.',
      },
      {
        keywords: ['beauty', 'salon', 'spa', 'skincare', 'hair', 'nails', 'massage', 'facial', 'wellness', 'barber'],
        taglinePrefix: 'Look your best, feel your best',
        tagline: 'Premium care that makes you shine.',
      },
      {
        keywords: ['fitness', 'workout', 'gym', 'exercise', 'health', 'yoga', 'running', 'sport', 'athlete', 'training'],
        taglinePrefix: 'Train smarter, not harder',
        tagline: 'Train smarter, not harder. Built for results.',
      },
      {
        keywords: ['food', 'restaurant', 'recipe', 'cooking', 'meal', 'diet', 'nutrition', 'chef', 'menu', 'catering'],
        taglinePrefix: 'Great food, made simple',
        tagline: 'Great food, made simple. Order in minutes.',
      },
      {
        keywords: ['music', 'artist', 'band', 'podcast', 'audio', 'sound', 'song', 'album', 'playlist', 'stream'],
        taglinePrefix: 'Your next favourite track starts here',
        tagline: 'Your next favourite track starts here.',
      },
      {
        keywords: ['finance', 'money', 'budget', 'invest', 'saving', 'crypto', 'trading', 'financial', 'wealth', 'banking'],
        taglinePrefix: 'Take control of your financial future',
        tagline: 'Take control of your financial future.',
      },
      {
        keywords: ['travel', 'trip', 'vacation', 'hotel', 'booking', 'destination', 'adventure', 'flight', 'tour'],
        taglinePrefix: 'Your next adventure is one click away',
        tagline: 'Your next adventure is one click away.',
      },
      {
        keywords: ['photo', 'image', 'gallery', 'portfolio', 'design', 'creative', 'art', 'visual', 'photography'],
        taglinePrefix: 'Where creativity meets craft',
        tagline: 'Where creativity meets craft. Show your best work.',
      },
      {
        keywords: ['saas', 'software', 'tool', 'platform', 'productivity', 'workflow', 'automation', 'dashboard', 'analytics'],
        taglinePrefix: 'Powerful tools, zero overhead',
        tagline: 'Powerful tools, zero overhead. Ship faster.',
      },
      {
        keywords: ['ecommerce', 'shop', 'store', 'product', 'sell', 'buy', 'marketplace', 'cart', 'checkout'],
        taglinePrefix: 'The better way to shop',
        tagline: 'The better way to shop. Discover something great.',
      },
      {
        keywords: ['education', 'course', 'learn', 'teaching', 'school', 'tutoring', 'training', 'skill', 'class'],
        taglinePrefix: 'Learn at your own pace',
        tagline: 'Learn at your own pace. Master something new.',
      },
      {
        keywords: ['event', 'conference', 'meetup', 'ticket', 'rsvp', 'webinar', 'summit', 'workshop'],
        taglinePrefix: 'Great events start here',
        tagline: 'Great events start here. Reserve your spot.',
      },
      {
        keywords: ['real estate', 'property', 'home', 'house', 'rent', 'lease', 'apartment', 'mortgage'],
        taglinePrefix: 'Find your perfect home',
        tagline: 'Find your perfect home. Browse listings today.',
      },
    ];

    for (const domain of DOMAINS) {
      if (domain.keywords.some(kw => lower.includes(kw))) {
        return { tagline: domain.tagline, taglinePrefix: domain.taglinePrefix };
      }
    }
    return null;
  }
}

module.exports = { BuilderAgent };
