/**
 * Planner Agent
 *
 * Owns the PLAN stage of the pipeline.
 *
 * Responsibilities:
 *   - Takes user prompt → outputs structured task decomposition (JSON)
 *   - Uses GPT-4o-mini for AI-powered planning
 *   - Falls back to deterministic simulation if AI unavailable
 *   - Injects product context when available so subtasks describe the real product
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
 *
 * Communication: Reads from previousOutputs (pipeline state).
 * No direct calls to other agents.
 */

const OpenAI = require('openai');
const { buildContextInstruction } = require('../lib/product-context');
const { formatConstraintBlock } = require('./intent-gate');
const { validatePlanExpansionJustifications } = require('../lib/soft-expansion');

class PlannerAgent {
  constructor() {
    this.stages = ['plan'];
    this.openai = null;
    try {
      if (process.env.OPENAI_API_KEY) {
        this.openai = new OpenAI();
      }
    } catch (e) {
      console.log('[PlannerAgent] OpenAI not available, using simulated mode');
    }
  }

  /**
   * Execute the PLAN stage.
   *
   * @param {object} opts
   * @param {string} opts.runId      - Pipeline run UUID
   * @param {string} opts.stage      - Must be 'plan'
   * @param {string} opts.prompt     - User's original prompt
   * @param {object} opts.previousOutputs - Previous stage outputs (includes _productContext)
   * @param {function} opts.emitChunk - Streaming chunk emitter
   * @returns {object} Plan output: { subtasks[], dependencies{}, estimatedComplexity, rawMarkdown }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[PlannerAgent] Executing PLAN for run ${runId.slice(0, 8)}...`);

    // Extract product context injected by the orchestrator
    const productContext = previousOutputs._productContext || null;
    if (productContext) {
      console.log('[PlannerAgent] Product context detected — will generate accurate plan');
    } else {
      console.log('[PlannerAgent] No product context — plan will use placeholders');
    }

    // Extract Intent Gate constraint contract (immutable — set at Step 0)
    const constraintContract = previousOutputs._constraintContract || null;
    if (constraintContract) {
      console.log(`[PlannerAgent] Constraint contract: ${constraintContract.intent_class} (expansion_lock: ${constraintContract.expansion_lock})`);
      // Phase 4: log when operating under soft expansion
      if (constraintContract.intent_class === 'soft_expansion') {
        const expandableCaps = Object.keys(constraintContract.soft_expansion || {}).join(', ') || 'none';
        console.log(`[PlannerAgent] Phase 4 soft expansion active | base=${constraintContract.base_class} | expansion_candidate=${constraintContract.expansion_candidate} | expandable capabilities: ${expandableCaps}`);
      }
    }

    let planOutput;
    if (this.openai) {
      try {
        planOutput = await this._aiPlan(prompt, emitChunk, productContext, constraintContract);
      } catch (e) {
        console.log('[PlannerAgent] AI plan failed, falling back to simulated mode:', e.message);
      }
    }

    if (!planOutput) {
      planOutput = await this._simulatedPlan(prompt, emitChunk, constraintContract);
    }

    // Post-PLAN validation: check that plan steps don't reference prohibited layers
    if (constraintContract && constraintContract.expansion_lock && planOutput) {
      const violations = this._validatePlanAgainstContract(planOutput, constraintContract);
      if (violations.length > 0) {
        console.warn(`[PlannerAgent] CONSTRAINT_VIOLATION_DETECTED: plan references prohibited layers: ${violations.join('; ')}`);
        // Strip violating subtasks rather than failing — re-run would produce the same result
        planOutput.subtasks = (planOutput.subtasks || []).filter(t => {
          const desc = `${t.title || ''} ${t.description || ''}`.toLowerCase();
          return !this._subtaskViolatesContract(desc, constraintContract);
        });
        // Append warning to rawMarkdown
        planOutput.rawMarkdown = (planOutput.rawMarkdown || '') +
          `\n\n⚠️ **Constraint enforcement:** Removed plan steps that violate ${constraintContract.intent_class} boundaries (${violations.join('; ')}).`;
      }
    }

    // ── Phase 4: Validate expansion justifications ─────────────────────────
    // When operating under soft_expansion, the plan MUST include
    // expansion_justifications for any expanded capabilities it uses.
    // Unauthorized justifications are flagged here (SCAFFOLD will hard-reject them).
    if (constraintContract && constraintContract.intent_class === 'soft_expansion' && planOutput) {
      const expansionViolations = validatePlanExpansionJustifications(planOutput, constraintContract);
      if (expansionViolations.length > 0) {
        console.warn(`[PlannerAgent] Phase 4 expansion justification violations: ${expansionViolations.join('; ')}`);
        // Remove invalid justifications (SCAFFOLD would reject anyway)
        if (planOutput.expansion_justifications) {
          const allowed = new Set(
            Object.entries(constraintContract.soft_expansion || {})
              .filter(([, rule]) => rule && rule.allowed !== false)
              .map(([cap]) => cap)
          );
          planOutput.expansion_justifications = planOutput.expansion_justifications
            .filter(j => j.capability && allowed.has(j.capability));
        }
        planOutput.rawMarkdown = (planOutput.rawMarkdown || '') +
          `\n\n⚠️ **Soft expansion:** Removed ${expansionViolations.length} invalid expansion justification(s).`;
      }

      // Log valid justifications
      const justifiedCaps = (planOutput.expansion_justifications || []).map(j => j.capability).join(', ');
      if (justifiedCaps) {
        console.log(`[PlannerAgent] Phase 4 expansion justifications: ${justifiedCaps}`);
      } else {
        console.log('[PlannerAgent] Phase 4: no soft expansions used (staying with base constraints)');
      }
    }

    return planOutput;
  }

  /**
   * Check if a plan's subtasks reference layers prohibited by the constraint contract.
   * Returns array of violation descriptions.
   */
  _validatePlanAgainstContract(planOutput, contract) {
    if (!contract || !contract.prohibited_layers || contract.prohibited_layers.length === 0) return [];

    const violations = [];
    const subtasks = planOutput.subtasks || [];

    for (const task of subtasks) {
      const desc = `${task.title || ''} ${task.description || ''}`.toLowerCase();
      if (this._subtaskViolatesContract(desc, contract)) {
        violations.push(`Subtask "${task.title}" references prohibited layer`);
      }
    }

    return violations;
  }

  /**
   * Check if a subtask description references prohibited layers.
   */
  _subtaskViolatesContract(descLower, contract) {
    if (contract.constraints.server === false) {
      if (/\b(express|server|endpoint|route|api|middleware|backend)\b/.test(descLower)) return true;
    }
    if (contract.constraints.db === false) {
      if (/\b(database|schema|migration|postgresql|sql|table|queries)\b/.test(descLower)) return true;
    }
    if (contract.constraints.auth === false) {
      if (/\b(auth|login|signup|jwt|bcrypt|session|password)\b/.test(descLower)) return true;
    }
    return false;
  }

  // ── AI-powered plan ──────────────────────────────────────

  async _aiPlan(prompt, emitChunk, productContext, constraintContract) {
    // Build the context instruction block
    const contextInstruction = buildContextInstruction(productContext);

    // Build the constraint contract block (injected as immutable rules)
    const constraintInstruction = constraintContract
      ? '\n\n' + formatConstraintBlock(constraintContract)
      : '';

    // Phase 4: add expansion justification requirement for soft_expansion contracts
    const isSoftExpansion = constraintContract && constraintContract.intent_class === 'soft_expansion';
    const softExpansionInstruction = isSoftExpansion
      ? `\n\nSOFT EXPANSION RULES (MANDATORY for this plan):
The constraint contract is in SOFT EXPANSION mode (base: ${constraintContract.base_class}, candidate: ${constraintContract.expansion_candidate}).
If you need any of the available soft expansion capabilities listed above, you MUST include them in expansion_justifications[].
If you do NOT need any of those capabilities, omit expansion_justifications entirely (or use an empty array).
Format for each justification: { "capability": "server", "reason": "...", "scope": "single endpoint: POST /api/..." }
SCAFFOLD will REJECT the plan if you use an expanded capability without a justification.`
      : '';

    const systemPrompt = `You are a technical architect. Given a user's project description, create a structured execution plan.

${contextInstruction}${constraintInstruction}${softExpansionInstruction}

Your response MUST be valid JSON with this exact structure:
{
  "subtasks": [
    { "id": 1, "title": "...", "description": "...", "estimatedHours": 1 },
    ...
  ],
  "dependencies": {
    "2": [1],
    "3": [1, 2]
  },
  "estimatedComplexity": "low|medium|high",
  "rawMarkdown": "## Plan\\n\\nHuman-readable markdown plan...",
  "expansion_justifications": []
}

Rules:
- subtasks: 4-8 concrete, actionable tasks. Each has id, title, description, estimatedHours.
- dependencies: map of subtask id → array of prerequisite subtask ids. Omit if no deps.
- estimatedComplexity: "low" (CRUD app), "medium" (multi-entity with auth), "high" (real-time/complex)
- rawMarkdown: Full plan in markdown with ## headers, numbered steps, file list, architecture note. Under 300 words. Use the actual product name/description from the context above — never generic placeholders.
- expansion_justifications: array of { capability, reason, scope } — ONLY include if using soft expansion capabilities. Omit or set to [] otherwise.

Return ONLY the JSON object, no markdown fences.`;

    const MODEL = 'gpt-4o-mini';
    const chunks = [];
    let tokenUsage = null;

    const stream = await this.openai.chat.completions.create({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        chunks.push(text);
        emitChunk(text);
      }
      // Final chunk carries usage when stream_options.include_usage = true
      if (chunk.usage) {
        tokenUsage = {
          model: MODEL,
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
        };
      }
    }

    const rawText = chunks.join('');

    try {
      const parsed = JSON.parse(rawText);
      const output = {
        subtasks:    parsed.subtasks    || [],
        dependencies: parsed.dependencies || {},
        estimatedComplexity: parsed.estimatedComplexity || 'medium',
        rawMarkdown: parsed.rawMarkdown || rawText,
        _tokenUsage: tokenUsage,
      };
      // Phase 4: carry expansion_justifications if present
      if (parsed.expansion_justifications && Array.isArray(parsed.expansion_justifications)) {
        output.expansion_justifications = parsed.expansion_justifications;
      }
      return output;
    } catch (parseErr) {
      console.log('[PlannerAgent] Non-JSON response, wrapping as markdown');
      return {
        subtasks: [
          { id: 1, title: 'Implement feature', description: prompt, estimatedHours: 2 }
        ],
        dependencies: {},
        estimatedComplexity: 'medium',
        rawMarkdown: rawText,
        _tokenUsage: tokenUsage,
      };
    }
  }

  // ── Simulated plan (no AI) ───────────────────────────────

  async _simulatedPlan(prompt, emitChunk, constraintContract) {
    const intentClass = constraintContract ? constraintContract.intent_class : null;

    // ── Static Surface: pure HTML/CSS/JS, no backend ──────
    if (intentClass === 'static_surface') {
      // Phase 4.2: ISE surfaces — generate surface-aware plan instead of generic steps
      const _iseSurfaces = (constraintContract && constraintContract._ise && constraintContract._ise.surfaces) || [];

      if (_iseSurfaces.length > 0) {
        const surfaceList = _iseSurfaces.join(', ');
        const captureSurfaces = _iseSurfaces.filter(s => s !== 'confirmation_state');
        const primarySurface = captureSurfaces[0] || 'capture';
        const hasConfirmation = _iseSurfaces.includes('confirmation_state');

        const subtasks = [
          { id: 1, title: 'Design page layout with interaction surfaces', description: `Plan HTML structure with dedicated sections for: ${surfaceList}`, estimatedHours: 0.5 },
          { id: 2, title: `Build ${primarySurface.replace(/_/g, ' ')} form`, description: `Implement ${captureSurfaces.join(' + ')} as a functional HTML form with input validation`, estimatedHours: 1 },
          { id: 3, title: 'Style with CSS', description: 'Responsive CSS with modern design for form elements, inputs, buttons, and confirmation state', estimatedHours: 1 },
          { id: 4, title: 'Add form handling and state transitions', description: `JavaScript for form submission, validation, and ${hasConfirmation ? 'capture-to-confirmation state transition' : 'interaction feedback'}`, estimatedHours: 1 },
        ];

        const rawMarkdown = [
          `## Execution Plan`,
          ``,
          `### Task: ${prompt}`,
          ``,
          `**Intent:** Static surface with interaction surfaces — pure HTML/CSS/JS`,
          `**ISE Surfaces:** ${_iseSurfaces.join(' \u2192 ')}`,
          ``,
          `**Steps:**`,
          ...subtasks.map((t, i) => `${i + 1}. **${t.title}** \u2014 ${t.description}`),
          ``,
          `**Architecture:** Static HTML + CSS + Vanilla JS (with form handling)`,
          `**Files:** 3 files (index.html, styles.css, script.js)`,
          `**Complexity:** Low — static page with capture form(s)`,
        ].join('\n');

        await this._streamText(rawMarkdown, emitChunk, 8);

        return {
          subtasks,
          dependencies: { '3': [2], '4': [2, 3] },
          estimatedComplexity: 'low',
          rawMarkdown,
        };
      }

      const subtasks = [
        { id: 1, title: 'Design page layout', description: 'Plan HTML structure and visual sections', estimatedHours: 0.5 },
        { id: 2, title: 'Write HTML markup', description: 'Semantic HTML5 with proper structure (index.html)', estimatedHours: 1 },
        { id: 3, title: 'Style with CSS', description: 'Responsive CSS with modern design (styles.css)', estimatedHours: 1.5 },
        { id: 4, title: 'Add interactivity', description: 'Vanilla JavaScript for smooth interactions (script.js)', estimatedHours: 1 },
      ];

      const rawMarkdown = [
        `## Execution Plan`,
        ``,
        `### Task: ${prompt}`,
        ``,
        `**Intent:** Static surface — pure HTML/CSS/JS (no backend, no database)`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**Architecture:** Static HTML + CSS + Vanilla JS`,
        `**Files:** 3 files (index.html, styles.css, script.js)`,
        `**Complexity:** Low — static page with no backend required`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: { '3': [2], '4': [2, 3] },
        estimatedComplexity: 'low',
        rawMarkdown,
      };
    }

    // ── Light App: server + frontend, no auth, optional db ──────
    if (intentClass === 'light_app') {
      const subtasks = [
        { id: 1, title: 'Parse requirements', description: 'Identify core functionality and data model', estimatedHours: 0.5 },
        { id: 2, title: 'Set up Express server', description: 'Lightweight Express.js with json + static middleware', estimatedHours: 0.5 },
        { id: 3, title: 'Implement API endpoints', description: 'Minimal REST endpoints for core functionality', estimatedHours: 1.5 },
        { id: 4, title: 'Build frontend', description: 'Responsive UI with form handling and fetch calls', estimatedHours: 2 },
        { id: 5, title: 'Add error handling', description: 'Input validation and user feedback', estimatedHours: 0.5 },
      ];

      const rawMarkdown = [
        `## Execution Plan`,
        ``,
        `### Task: ${prompt}`,
        ``,
        `**Intent:** Light app — server + frontend, no authentication`,
        ``,
        `**Steps:**`,
        ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
        ``,
        `**Architecture:** Express.js + Vanilla JS (no auth, minimal backend)`,
        `**Complexity:** Medium — interactive app with clean separation`,
      ].join('\n');

      await this._streamText(rawMarkdown, emitChunk, 8);

      return {
        subtasks,
        dependencies: { '3': [2], '4': [3], '5': [3, 4] },
        estimatedComplexity: 'medium',
        rawMarkdown,
      };
    }

    // ── Full Product: full-stack with auth, db, the works ──────
    const subtasks = [
      { id: 1, title: 'Parse requirements', description: 'Identify core entities and relationships', estimatedHours: 0.5 },
      { id: 2, title: 'Design database schema', description: 'PostgreSQL tables with proper constraints and indexes', estimatedHours: 1 },
      { id: 3, title: 'Set up Express server', description: 'Express.js with middleware stack (json, cors, static)', estimatedHours: 0.5 },
      { id: 4, title: 'Implement API endpoints', description: 'RESTful CRUD endpoints with input validation', estimatedHours: 2 },
      { id: 5, title: 'Build frontend', description: 'Responsive UI with form handling and fetch calls', estimatedHours: 2 },
      { id: 6, title: 'Add error handling', description: 'Proper error responses, validation, edge cases', estimatedHours: 1 },
      { id: 7, title: 'Integration testing', description: 'End-to-end data flow verification', estimatedHours: 1 },
    ];

    const rawMarkdown = [
      `## Execution Plan`,
      ``,
      `### Task: ${prompt}`,
      ``,
      `**Analysis:** Decomposing requirements into executable steps.`,
      ``,
      `**Steps:**`,
      ...subtasks.map((t, i) => `${i + 1}. **${t.title}** — ${t.description}`),
      ``,
      `**Architecture:** Express.js + PostgreSQL + Vanilla JS`,
      `**Files:** 8 files across 4 directories`,
      `**Complexity:** Medium — standard CRUD with clean separation`,
    ].join('\n');

    await this._streamText(rawMarkdown, emitChunk, 8);

    return {
      subtasks,
      dependencies: { '3': [1, 2], '4': [3], '5': [4], '6': [4, 5], '7': [6] },
      estimatedComplexity: 'medium',
      rawMarkdown,
    };
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
}

module.exports = { PlannerAgent };
