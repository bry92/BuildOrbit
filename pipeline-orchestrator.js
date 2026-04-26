/**
 * Pipeline Orchestrator Service (v3 — Intervention-Aware)
 *
 * Owns the full lifecycle of a pipeline run:
 *   1. Picks up queued jobs
 *   2. Routes each stage to the appropriate agent (Planner, Builder, QA, Ops)
 *   3. Enforces stage contracts (typed input/output validation)
 *   4. Fires events through the event bus on every transition
 *   5. Handles failures gracefully (log, mark failed, stop)
 *   6. Supports retry: re-enqueue a failed run — it picks up where it left off
 *   7. Fault-tolerant: on process restart, recovers in-flight runs from the event log
 *   8. Mid-run intervention: pause/resume, instruction injection, agent overrides
 *
 * Agent routing (via AgentRegistry):
 *   plan              → PlannerAgent
 *   scaffold, code    → BuilderAgent
 *   save              → OpsAgent
 *   verify            → QAAgent
 *
 * Agents communicate ONLY through pipeline state (previousOutputs from event log).
 * No direct agent-to-agent calls. Each agent receives its stage input from
 * the orchestrator, which reads previousOutputs from the DB.
 *
 * Backward compatible: if no agentRegistry is provided, falls back to
 * the legacy PipelineExecutor for all stages.
 *
 * Intervention Controls:
 *   pause(runId)                     — request pause after current stage completes
 *   resume(runId)                    — resume a paused run
 *   inject(runId, message)           — inject instruction for next stage
 *   override(runId, agent, prompt)   — override next invocation of an agent
 *   getRunConfig(runId)              — get stored run configuration
 */

const { STAGES } = require('./state-machine');
const { BUS_EVENTS } = require('./event-bus');
const { buildStageInput, validateStageOutput, ContractValidationError, validateScaffoldManifest, validateCodeAgainstScaffold } = require('./stage-contracts');
const { CostTracker } = require('./cost-tracker');
const { AGENT_FOR_STAGE } = require('./trace-store');
const { RunTrace } = require('./lib/run-trace');
const { formatProductContext, loadProductContextFromEnv } = require('./lib/product-context');
const { classify: classifyIntent, validateScaffoldAgainstContract, validateCodeAgainstContract, formatConstraintBlock } = require('./agents/intent-gate');
const constraintLearner = require('./lib/constraint-learner');
const { validateCCO, computeCCOHash, verifyCCOHash } = require('./lib/cco-validator');
const analytics = require('./lib/analytics');
const {
  sendPipelineCompleteEmail,
  sendCreditWarningEmail,
} = require('./backend/src/email/transactional');
const OpenAI = require('openai');

// Map agent stage name → agent key for override lookups
const STAGE_TO_AGENT = {
  plan:     'planner',
  scaffold: 'builder',
  code:     'builder',
  save:     'ops',
  verify:   'qa',
};

class PipelineOrchestrator {
  /**
   * @param {object} opts
   * @param {import('./state-machine').PipelineStateMachine}  opts.stateMachine
   * @param {import('./pipeline').PipelineExecutor}           opts.executor       - Legacy fallback executor
   * @param {import('./event-bus').PipelineEventBus}          opts.eventBus
   * @param {import('pg').Pool}                               opts.pool
   * @param {import('./agents/index').AgentRegistry}          [opts.agentRegistry] - Optional: routes stages to agents
   * @param {CostTracker}                                     [opts.costTracker]   - Optional: per-run economics tracking
   */
  constructor({ stateMachine, executor, eventBus, pool, agentRegistry = null, artifactStore = null, costTracker = null, traceStore = null, deployEngine = null }) {
    this.stateMachine = stateMachine;
    this.executor = executor;
    this.eventBus = eventBus;
    this.pool = pool;
    this.agentRegistry = agentRegistry;
    this.artifactStore = artifactStore;
    this.costTracker = costTracker || new CostTracker();
    this.traceStore = traceStore; // Optional: captures per-stage decision traces
    this.runTrace = new RunTrace(pool); // Decision-level causal DAG per run
    this.deployEngine = deployEngine; // Optional: triggers auto-deploy after pipeline completes
    this._healingOpenAI = null; // Lazy-initialized for self-healing LLM calls

    this.queue = [];
    this.processing = false;
    this.activeRuns = new Map(); // runId → RunContext
    this.concurrency = 1;

    // Wire up the event bus: stage_completed triggers the next stage
    this.eventBus.on(BUS_EVENTS.STAGE_COMPLETED, (event) => {
      this._onStageCompleted(event);
    });

    if (agentRegistry) {
      console.log('[Orchestrator] Agent routing enabled:', agentRegistry.getStatus().stageMapping);
    } else {
      console.log('[Orchestrator] Running in legacy executor mode (no agentRegistry)');
    }
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Enqueue a new pipeline run for execution.
   *
   * @param {string} runId
   * @param {string} prompt
   * @param {{ budgetCap?: number, budgetWarning?: number }} [budgetOpts]
   * @param {object} [runConfig] - Optional: { modelConfig, constraints }
   */
  enqueue(runId, prompt, budgetOpts = {}, runConfig = {}) {
    this.queue.push({ runId, prompt, budgetOpts, runConfig });
    // Initialize cost tracking immediately so budget is available before first stage
    this.costTracker.initRun(runId, budgetOpts);
    console.log(`[Orchestrator] Enqueued run ${runId.slice(0, 8)}... (queue: ${this.queue.length})`);
    this._processNext();
  }

  /**
   * Retry a failed pipeline run. Re-enqueues it.
   * The state machine + idempotency keys ensure completed stages are skipped.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string, nextStage?: string }}
   */
  async retry(runId) {
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Pipeline run not found' };
    }

    if (run.state !== 'failed') {
      return { success: false, message: `Cannot retry: pipeline is in state "${run.state}", expected "failed"` };
    }

    // Find the stage that needs re-execution
    const events = await this.stateMachine.getEvents(runId);
    let failedStage = null;

    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === 'failed') {
        failedStage = events[i].stage;
        break;
      }
    }

    if (!failedStage) {
      return { success: false, message: 'Could not determine which stage failed' };
    }

    // Clear QA issues from previous attempt (clean slate for retry)
    if (this.agentRegistry) {
      this.agentRegistry.qa.clearIssues(runId);
    }

    // Reload run config for retry
    const runConfig = run.run_config || {};

    this.enqueue(runId, run.prompt, {}, runConfig);

    return {
      success: true,
      message: `Retry enqueued. Will resume from "${failedStage}" stage.`,
      nextStage: failedStage,
    };
  }

  /**
   * Abort a running pipeline.
   */
  abort(runId) {
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.aborted = true;
      ctx.resumed = true; // Wake up any pause-wait loop
      console.log(`[Orchestrator] Abort requested for ${runId.slice(0, 8)}...`);
      return true;
    }
    return false;
  }

  /**
   * Request pause after the current stage completes.
   * If between stages, pauses immediately.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string }}
   */
  pause(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      return { success: false, message: 'Run is not active' };
    }
    if (ctx.pauseRequested || ctx.paused) {
      return { success: false, message: 'Run is already pausing or paused' };
    }
    ctx.pauseRequested = true;
    console.log(`[Orchestrator] Pause requested for ${runId.slice(0, 8)}...`);
    return { success: true, message: 'Pause requested — will hold after current stage completes' };
  }

  /**
   * Resume a paused pipeline run.
   *
   * @param {string} runId
   * @returns {{ success: boolean, message: string }}
   */
  resume(runId) {
    const ctx = this.activeRuns.get(runId);
    if (!ctx) {
      // Run might have been paused across a restart — re-enqueue from DB
      return this._resumeFromDb(runId);
    }
    if (!ctx.paused) {
      return { success: false, message: 'Run is not paused' };
    }
    ctx.paused = false;
    ctx.resumed = true; // Wake the wait loop
    console.log(`[Orchestrator] Resume signal sent for ${runId.slice(0, 8)}...`);
    return { success: true, message: 'Resume signal sent' };
  }

  /**
   * Inject an instruction directive for the next stage execution.
   * The message is prepended to the next agent's prompt.
   *
   * @param {string} runId
   * @param {string} message
   * @returns {{ success: boolean, message: string }}
   */
  async inject(runId, message) {
    if (!message || !message.trim()) {
      return { success: false, message: 'Instruction message is required' };
    }

    // Verify run exists
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }

    // Log to interventions table
    await this.pool.query(
      `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'instruction_injected', $2)`,
      [runId, JSON.stringify({ message: message.trim(), timestamp: new Date().toISOString() })]
    );

    // Store in active run context if running
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.pendingInjections.push(message.trim());
    }

    // Emit SSE event so UI can show the injection
    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'instruction_injected',
      payload: JSON.stringify({ message: message.trim() }),
      created_at: new Date().toISOString()
    });

    console.log(`[Orchestrator] Instruction injected for ${runId.slice(0, 8)}...: ${message.slice(0, 80)}`);
    return { success: true, message: 'Instruction injected — will apply to next stage' };
  }

  /**
   * Set a one-shot agent override for the next invocation.
   * The override applies once then reverts to default.
   *
   * @param {string} runId
   * @param {string} agent  - Agent name (planner, builder, ops, qa)
   * @param {string} prompt - Custom prompt to replace agent's default
   * @returns {{ success: boolean, message: string }}
   */
  async override(runId, agent, prompt) {
    if (!agent || !prompt || !prompt.trim()) {
      return { success: false, message: 'Agent name and prompt are required' };
    }

    const validAgents = ['planner', 'builder', 'ops', 'qa'];
    if (!validAgents.includes(agent.toLowerCase())) {
      return { success: false, message: `Invalid agent. Must be one of: ${validAgents.join(', ')}` };
    }

    // Verify run exists
    const run = await this.executor.getRun(runId);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }

    const agentKey = agent.toLowerCase();

    // Log to interventions table
    await this.pool.query(
      `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'agent_overridden', $2)`,
      [runId, JSON.stringify({ agent: agentKey, prompt: prompt.trim(), scope: 'one_shot', timestamp: new Date().toISOString() })]
    );

    // Store in active run context
    const ctx = this.activeRuns.get(runId);
    if (ctx) {
      ctx.agentOverrides[agentKey] = prompt.trim();
    }

    // Emit SSE event
    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: '_system',
      status: 'agent_overridden',
      payload: JSON.stringify({ agent: agentKey, scope: 'one_shot' }),
      created_at: new Date().toISOString()
    });

    console.log(`[Orchestrator] Agent override set for ${agentKey} on run ${runId.slice(0, 8)}...`);
    return { success: true, message: `Override set for ${agentKey} — applies on next invocation` };
  }

  /**
   * Get run configuration (stored at run creation time).
   *
   * @param {string} runId
   */
  async getRunConfig(runId) {
    const { rows } = await this.pool.query(
      'SELECT run_config FROM pipeline_runs WHERE id = $1',
      [runId]
    );
    if (!rows[0]) return null;
    return rows[0].run_config || {};
  }

  /**
   * Get all interventions for a run (audit log).
   */
  async getInterventions(runId) {
    const { rows } = await this.pool.query(
      `SELECT id, type, payload, created_at FROM pipeline_interventions WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    return rows;
  }

  /**
   * Recover in-flight pipelines after a process restart.
   * Scans for runs in *_running or paused states and re-enqueues them.
   */
  async recover() {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, prompt, state, run_config FROM pipeline_runs
         WHERE state LIKE '%_running' OR state = 'queued' OR state = 'paused'
         ORDER BY created_at ASC`
      );

      if (rows.length === 0) {
        console.log('[Orchestrator] Recovery: no in-flight pipelines found');
        return;
      }

      console.log(`[Orchestrator] Recovery: found ${rows.length} in-flight pipeline(s)`);

      for (const run of rows) {
        if (run.state === 'paused') {
          // Paused runs stay paused on restart — they'll resume when user clicks resume
          console.log(`[Orchestrator] Recovery: run ${run.id.slice(0, 8)}... is paused — waiting for resume`);
          // Register it in activeRuns so resume() can find it
          const ctx = this._createRunContext(run.run_config || {});
          ctx.paused = true;
          ctx.pausedAt = null; // afterStage not known from just state
          this.activeRuns.set(run.id, ctx);
          // Re-enqueue so orchestrator can enter wait loop
          this.queue.push({ runId: run.id, prompt: run.prompt, budgetOpts: {}, runConfig: run.run_config || {}, resumePaused: true });
          this._processNext();
          continue;
        }

        if (run.state.endsWith('_running')) {
          const stage = run.state.replace('_running', '');
          try {
            await this.stateMachine.transition(run.id, stage, 'failed', null, 'Process restarted — auto-recovering');
            console.log(`[Orchestrator] Recovery: marked ${stage} as failed for ${run.id.slice(0, 8)}...`);
          } catch (e) {
            console.log(`[Orchestrator] Recovery: could not transition ${run.id.slice(0, 8)}...: ${e.message}`);
          }
        }

        this.enqueue(run.id, run.prompt, {}, run.run_config || {});
      }
    } catch (err) {
      console.error('[Orchestrator] Recovery failed:', err.message);
    }
  }

  /**
   * Get orchestrator status (includes agent registry info).
   */
  getStatus() {
    const status = {
      queued: this.queue.length,
      processing: this.processing,
      activeRuns: Array.from(this.activeRuns.keys()),
      pausedRuns: Array.from(this.activeRuns.entries())
        .filter(([, ctx]) => ctx.paused)
        .map(([id]) => id),
    };

    if (this.agentRegistry) {
      status.agents = this.agentRegistry.getStatus();
    }

    return status;
  }

  // ── Internal Execution ─────────────────────────────────

  _createRunContext(runConfig = {}) {
    return {
      aborted: false,
      pauseRequested: false,
      paused: false,
      resumed: false,
      pausedAfterStage: null,
      pendingInjections: [],
      agentOverrides: {},
      runConfig: runConfig || {},
    };
  }

  async _processNext() {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const job = this.queue.shift();

    console.log(`[Orchestrator] Starting run ${job.runId.slice(0, 8)}...`);

    // Reuse existing ctx if recovering a paused run
    let ctx = this.activeRuns.get(job.runId);
    if (!ctx) {
      ctx = this._createRunContext(job.runConfig);
      this.activeRuns.set(job.runId, ctx);
    }

    try {
      await this._executeRun(job.runId, job.prompt, ctx);
    } catch (err) {
      console.error(`[Orchestrator] Run ${job.runId.slice(0, 8)}... crashed:`, err.message);
    } finally {
      // Only clean up if the run is truly done (not paused waiting for resume)
      if (!ctx.paused) {
        try {
          await this.costTracker.persistRunCosts(job.runId, this.pool);
          this.costTracker.clearRun(job.runId);
        } catch (costErr) {
          console.warn('[Orchestrator] Cost persist error (non-fatal):', costErr.message);
        }

        this.activeRuns.delete(job.runId);
      }

      this.processing = false;

      if (this.queue.length > 0) {
        setImmediate(() => this._processNext());
      }
    }
  }

  /**
   * Execute a pipeline run through all 5 stages.
   *
   * Each stage:
   *   1. Validate input contract
   *   2. Transition → {stage}_running
   *   3. Dispatch to agent (or legacy executor)
   *   4. Validate output contract
   *   5. Transition → {stage}_complete
   *   6. Check for pause request — if set, enter pause-wait loop
   */
  async _executeRun(runId, prompt, ctx) {
    const ops = this.agentRegistry ? this.agentRegistry.ops : null;

    // Track pipeline start time for duration analytics
    if (!ctx._pipelineStartMs) ctx._pipelineStartMs = Date.now();

    // If this is a paused run being re-entered after resume, skip the wait
    // The ctx.paused will be true if we're re-entering; wait for resume signal
    if (ctx.paused) {
      console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... is paused — waiting for resume`);
      await this._waitForResume(runId, ctx);
      if (ctx.aborted) return;

      // Restore DB state if run is still 'paused' in DB (recovery scenario)
      try {
        const currentState = await this.stateMachine.getState(runId);
        if (currentState === 'paused') {
          const events = await this.stateMachine.getEvents(runId);
          let afterStage = null;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].status === 'completed' && events[i].stage !== '_system') {
              afterStage = events[i].stage;
              break;
            }
          }
          if (afterStage) {
            await this.stateMachine.resumeRun(runId, afterStage);
            // Log resume
            await this.pool.query(
              `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
              [runId, JSON.stringify({ after_stage: afterStage, source: 'recovery_resume' })]
            ).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[Orchestrator] Could not restore state after recovery resume:', e.message);
      }
    }

    // ── STEP 0: INTENT GATE — classify task and lock constraints ─────────────
    // Run once at pipeline start. Constraint contract is immutable after this.
    // PLAN, SCAFFOLD, CODE, and VERIFY all receive it via previousOutputs._constraintContract.
    if (!ctx.constraintContract) {
      let rawContract;
      try {
        rawContract = await classifyIntent(prompt, this.pool, runId);
      } catch (classifyErr) {
        const msg = `INTENT_GATE_FAILED: classify() threw: ${classifyErr.message}`;
        console.error(`[Orchestrator] ${msg}`);
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'failed',
          payload: { error: msg },
          created_at: new Date().toISOString(),
        });
        // Persist failure to DB so SSE endpoint detects terminal state
        await this.pool.query(
          `UPDATE pipeline_runs SET status = 'failed', error = $2 WHERE id = $1`,
          [runId, msg]
        ).catch(e => console.error('[Orchestrator] Failed to persist intent gate failure:', e.message));
        // HARD INVARIANT: Pipeline MUST NOT proceed without a locked constraint contract
        this.eventBus.pipelineFailed(runId, '_intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, '_intent_gate', msg);
        return;
      }

      // HARD INVARIANT: If classify returns null/undefined, ABORT. No fallback. No graceful degradation.
      if (!rawContract || !rawContract.intent_class) {
        const msg = 'INTENT_GATE_FAILED: classify() returned null/invalid contract — aborting run';
        console.error(`[Orchestrator] ${msg}`);
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'failed',
          payload: { error: msg },
          created_at: new Date().toISOString(),
        });
        // Persist failure to DB so SSE endpoint detects terminal state
        await this.pool.query(
          `UPDATE pipeline_runs SET status = 'failed', error = $2 WHERE id = $1`,
          [runId, msg]
        ).catch(e => console.error('[Orchestrator] Failed to persist intent gate failure:', e.message));
        this.eventBus.pipelineFailed(runId, '_intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, '_intent_gate', msg);
        return;
      }

      // ── Phase 4: Rejection check (entropy too high) ─────────────────────────
      // If Phase 4 entropy modeling determined the classification is near-uniform,
      // the contract carries _rejected=true. Fail the pipeline with a user-facing
      // clarification request rather than attempting a likely-incorrect run.
      if (rawContract._rejected) {
        const clarificationMsg = rawContract._rejection_reason ||
          'Classification too uncertain — please clarify your request.';
        const msg = `INTENT_GATE_REJECTED: ${clarificationMsg}`;
        console.warn(`[Orchestrator] Phase 4 rejection: entropy=${rawContract._entropy?.toFixed(4)} | ${clarificationMsg}`);
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'rejected',
          payload: {
            run_event: 'INTENT_TOO_AMBIGUOUS',
            error: msg,
            entropy: rawContract._entropy,
            candidates: rawContract._candidates,
            clarification_required: true,
          },
          created_at: new Date().toISOString(),
        });
        // Persist failure to DB so SSE endpoint detects terminal state
        await this.pool.query(
          `UPDATE pipeline_runs SET status = 'failed', error = $2 WHERE id = $1`,
          [runId, msg]
        ).catch(e => console.error('[Orchestrator] Failed to persist intent gate rejection:', e.message));
        this.eventBus.pipelineFailed(runId, '_intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, '_intent_gate', msg);
        return;
      }

      // ── CCO HARD SCHEMA VALIDATION — Intent Gate exit gate ──────────────────
      // Runs BEFORE freeze. Every required field must be present and valid.
      // Any failure is a hard rejection — pipeline stops. No defaults, no repair.
      const _ccoValidation = validateCCO(rawContract);
      if (!_ccoValidation.valid) {
        const msg = `CCO_SCHEMA_INVALID: Contract failed schema validation at Intent Gate exit — ${_ccoValidation.errors.join('; ')}`;
        console.error(`[Orchestrator] ${msg}`);
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'failed',
          payload: {
            run_event: 'CCO_SCHEMA_INVALID',
            error: msg,
            validation_errors: _ccoValidation.errors,
          },
          created_at: new Date().toISOString(),
        });
        // Persist failure to DB so SSE endpoint detects terminal state
        await this.pool.query(
          `UPDATE pipeline_runs SET status = 'failed', error = $2 WHERE id = $1`,
          [runId, msg]
        ).catch(e => console.error('[Orchestrator] Failed to persist CCO validation failure:', e.message));
        this.eventBus.pipelineFailed(runId, '_intent_gate', msg);
        if (ops) ops.onPipelineFailed(runId, '_intent_gate', msg);
        return;
      }

      // Freeze the contract — immutable from this point. No agent can modify it.
      ctx.constraintContract = Object.freeze(rawContract);

      // Compute and store CCO hash immediately after freeze.
      // This hash is verified at every phase transition to detect mutations.
      ctx.ccoHash = computeCCOHash(ctx.constraintContract);
      console.log(`[Orchestrator] CCO hash computed at Intent Gate exit: ${ctx.ccoHash.slice(0, 16)}...`);

      // ── Write intent_class to pipeline_runs (fire-and-forget) ────────────
      // Normalises internal intent-gate names to canonical public-facing values.
      // Single source of truth: written once here, read by all downstream consumers.
      {
        const _icMap = {
          static_surface: 'STATIC_SURFACE',
          light_app:      'INTERACTIVE_LIGHT_APP',
          soft_expansion: 'INTERACTIVE_LIGHT_APP',
          full_product:   'PRODUCT_SYSTEM',
        };
        const _canonicalIntentClass = _icMap[ctx.constraintContract.intent_class] || null;
        if (_canonicalIntentClass && this.pool) {
          this.pool.query(
            'UPDATE pipeline_runs SET intent_class = $1 WHERE id = $2',
            [_canonicalIntentClass, runId]
          ).catch(icErr => {
            console.warn('[Orchestrator] intent_class write failed (non-fatal):', icErr.message);
          });
        }
      }

      // ── Analytics: PIPELINE_STARTED (fire-and-forget) ────────────────────
      ;(async () => {
        try {
          const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
          const userId = userRow.rows[0]?.user_id || null;
          await analytics.emitEvent(this.pool, 'PIPELINE_STARTED', userId, {
            run_id:       runId,
            intent_class: ctx.constraintContract.intent_class || null,
          });
        } catch (_) {}
      })();

      // ── Run Trace: emit INTENT_GATE decision nodes ─────────────────────────
      // Non-fatal — trace failures must never block pipeline execution.
      this.runTrace.emitIntentGateNodes(runId, ctx.constraintContract).catch(traceErr => {
        console.warn('[Orchestrator] RunTrace INTENT_GATE nodes failed (non-fatal):', traceErr.message);
      });

      // ── Phase 4.2: ISE — emit surface extraction event (if surfaces detected) ──
      // ISE ran inside classify() and attached _ise to the contract before freeze.
      // Here we emit an observable event so pipeline consumers can see the surfaces.
      // This is fire-and-observe — never blocks the pipeline.
      const _iseOutput = ctx.constraintContract._ise;
      if (_iseOutput && Array.isArray(_iseOutput.surfaces) && _iseOutput.surfaces.length > 0) {
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'ise_extracted',
          payload: {
            run_event:         'ISE_SURFACES_EXTRACTED',
            surfaces:          _iseOutput.surfaces,
            transitions:       _iseOutput.transitions,
            interaction_verbs: _iseOutput.interaction_verbs,
          },
          created_at: new Date().toISOString(),
        });
        console.log(
          `[Orchestrator] ISE_SURFACES_EXTRACTED: surfaces=[${_iseOutput.surfaces.join(', ')}] ` +
          `transitions=[${_iseOutput.transitions.join(', ')}]`
        );
      }

      const _isSoftExpansion = ctx.constraintContract.intent_class === 'soft_expansion';
      console.log(
        `[Orchestrator] Intent Gate → ${ctx.constraintContract.intent_class} | ` +
        `budget: ${ctx.constraintContract.complexity_budget} | ` +
        `expansion_lock: ${ctx.constraintContract.expansion_lock}` +
        (_isSoftExpansion
          ? ` | Phase 4 SOFT_EXPANSION (base=${ctx.constraintContract.base_class}, candidate=${ctx.constraintContract.expansion_candidate})`
          : '')
      );

      // Log CONSTRAINT_PREDICTED run event (Phase 4: includes entropy/candidates/committed)
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage: '_intent_gate',
        status: 'classified',
        payload: {
          run_event: 'CONSTRAINT_PREDICTED',
          intent_class: ctx.constraintContract.intent_class,
          complexity_budget: ctx.constraintContract.complexity_budget,
          expansion_lock: ctx.constraintContract.expansion_lock,
          constraints: ctx.constraintContract.constraints,
          // Phase 4 metadata
          entropy:    ctx.constraintContract._entropy    ?? null,
          committed:  ctx.constraintContract._committed  ?? true,
          candidates: ctx.constraintContract._candidates ?? null,
          ...(ctx.constraintContract.intent_class === 'soft_expansion' ? {
            base_class:          ctx.constraintContract.base_class,
            expansion_candidate: ctx.constraintContract.expansion_candidate,
            soft_expansion:      ctx.constraintContract.soft_expansion,
          } : {}),
        },
        created_at: new Date().toISOString(),
      });

      // Phase 4: emit SOFT_EXPANSION_ACTIVATED event if applicable
      if (_isSoftExpansion) {
        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: '_intent_gate',
          status: 'soft_expansion_activated',
          payload: {
            run_event:           'SOFT_EXPANSION_ACTIVATED',
            base_class:          ctx.constraintContract.base_class,
            expansion_candidate: ctx.constraintContract.expansion_candidate,
            entropy:             ctx.constraintContract._entropy,
            soft_expansion:      ctx.constraintContract.soft_expansion,
          },
          created_at: new Date().toISOString(),
        });
        console.log(`[Orchestrator] Phase 4 SOFT_EXPANSION_ACTIVATED | entropy=${ctx.constraintContract._entropy?.toFixed(4)} | base=${ctx.constraintContract.base_class}`);
      }

      // ACL Phase 1: persist prediction to DB (observation only — no learning yet)
      // Confidence heuristic: full_product / static_surface are strong signals (0.9);
      // light_app is the default fallback class so it carries lower confidence (0.7).
      // Phase 4: for soft_expansion contracts, confidence = top candidate probability.
      const _phase4Candidates = ctx.constraintContract._candidates || null;
      const _phase4Entropy    = ctx.constraintContract._entropy    ?? null;
      const _phase4Committed  = ctx.constraintContract._committed  ?? true;
      const _aclConfidenceMap = { full_product: 0.9, static_surface: 0.9, light_app: 0.7, soft_expansion: 0.5 };
      // For committed single-class, use the top candidate probability if available
      const _topCandidateProb = _phase4Candidates ? _phase4Candidates[0]?.probability : null;
      const _aclConfidence    = _topCandidateProb ?? (_aclConfidenceMap[ctx.constraintContract.intent_class] || 0.8);

      try {
        // Phase 4: INSERT includes entropy, candidates, committed columns (added by migration 010)
        await this.pool.query(
          `INSERT INTO constraint_predictions (run_id, task_type, predicted_constraints, confidence, entropy, candidates, committed)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            runId,
            ctx.constraintContract.task_type,
            JSON.stringify(ctx.constraintContract.constraints),
            _aclConfidence,
            _phase4Entropy,
            _phase4Candidates ? JSON.stringify(_phase4Candidates) : null,
            _phase4Committed,
          ]
        );
        // Capture weight adjustments that influenced this classification (Phase 2 explainability).
        // If classify() applied bias shaping, the contract carries a weight_adjustments field.
        const _weightAdjustments = ctx.constraintContract.weight_adjustments || null;
        const _aclAdjustmentsApplied = _weightAdjustments
          ? JSON.stringify({
              weight_adjustments: _weightAdjustments,
              weights_consulted:  true,
              sample_counts: Object.entries(_weightAdjustments).reduce((acc, [k, v]) => {
                acc[k] = v.sample_count || null;
                return acc;
              }, {}),
            })
          : null;

        await this.pool.query(
          `INSERT INTO constraint_decisions_log
             (run_id, input_text, classified_task_type, final_constraints, adjustments_applied)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            runId,
            prompt,
            ctx.constraintContract.intent_class,
            JSON.stringify(ctx.constraintContract),
            _aclAdjustmentsApplied,
          ]
        );
        console.log(
          `[Orchestrator] ACL logged: prediction + decisions_log for run ${runId.slice(0, 8)} ` +
          `(${ctx.constraintContract.intent_class}, confidence=${_aclConfidence.toFixed(3)}` +
          `${_phase4Entropy ? `, entropy=${_phase4Entropy.toFixed(4)}` : ''}` +
          `${_weightAdjustments ? ', bias-adjusted' : ''}` +
          `${_isSoftExpansion ? ', soft_expansion' : ''})`
        );
      } catch (aclErr) {
        // Non-fatal — ACL logging must never block the pipeline
        // Graceful fallback: try legacy INSERT (without Phase 4 columns) in case migration 010 hasn't run
        console.warn('[Orchestrator] ACL prediction logging failed, trying legacy INSERT:', aclErr.message);
        try {
          await this.pool.query(
            `INSERT INTO constraint_predictions (run_id, task_type, predicted_constraints, confidence)
             VALUES ($1, $2, $3, $4)`,
            [runId, ctx.constraintContract.task_type, JSON.stringify(ctx.constraintContract.constraints), _aclConfidence]
          );
        } catch (legacyErr) {
          console.warn('[Orchestrator] ACL prediction legacy INSERT also failed (non-fatal):', legacyErr.message);
        }
      }
    } else {
      console.log(`[Orchestrator] Intent Gate → reusing cached contract: ${ctx.constraintContract.intent_class}`);
      // Recompute hash for resumed runs (ccoHash may not be set from a previous session).
      // This initializes the baseline so phase transition checks work correctly.
      if (!ctx.ccoHash) {
        ctx.ccoHash = computeCCOHash(ctx.constraintContract);
        console.log(`[Orchestrator] CCO hash initialized for resumed run: ${ctx.ccoHash.slice(0, 16)}...`);
      }
    }

    for (const stage of STAGES) {
      if (ctx.aborted) {
        console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... aborted`);
        return;
      }

      // Skip already-completed stages (idempotent retry support)
      const alreadyDone = await this.stateMachine.isStageCompleted(runId, stage);
      if (alreadyDone) {
        console.log(`[Orchestrator] Stage "${stage}" already completed, skipping`);
        continue;
      }

      try {
        // 1. Check budget BEFORE executing (hard cap = stop, soft = warn)
        try {
          const budget = this.costTracker.checkBudget(runId);
          if (budget.exceeded) {
            const msg = `Budget cap exceeded: $${budget.totalCost.toFixed(6)} >= $${budget.budgetCap} (hard cap)`;
            console.warn(`[Orchestrator] ${msg} for run ${runId.slice(0, 8)}...`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId, stage, status: 'budget_exceeded',
              payload: { totalCost: budget.totalCost, budgetCap: budget.budgetCap },
              created_at: new Date().toISOString()
            });
            await this.stateMachine.transition(runId, stage, 'failed', null, msg).catch(() => {});
            this.eventBus.pipelineFailed(runId, stage, msg);
            if (ops) ops.onPipelineFailed(runId, stage, msg);
            return;
          }
          if (budget.shouldWarn) {
            const msg = `Budget warning: $${budget.totalCost.toFixed(6)} >= $${budget.budgetWarning} (soft threshold)`;
            console.warn(`[Orchestrator] ${msg} for run ${runId.slice(0, 8)}...`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId, stage, status: 'budget_warning',
              payload: { totalCost: budget.totalCost, budgetWarning: budget.budgetWarning },
              created_at: new Date().toISOString()
            });
          }
        } catch (budgetErr) {
          console.warn('[Orchestrator] Budget check error (non-fatal):', budgetErr.message);
        }

        // 2. Gather previous outputs for contract validation + agent input
        const previousOutputs = await this.executor.getPreviousOutputs(runId);
        previousOutputs._runId = runId;

        // Attach run config so agents can use model overrides / constraints
        previousOutputs._runConfig = ctx.runConfig || {};

        // Attach formatted product context so agents generate accurate content.
        // Priority: per-run context (in runConfig) > global env fallback > null.
        {
          const rawCtx = (ctx.runConfig && ctx.runConfig.productContext) || loadProductContextFromEnv();
          previousOutputs._productContext = rawCtx ? formatProductContext(rawCtx) : null;
        }

        // Attach Intent Gate constraint contract (immutable — set at Step 0).
        // All agents read this but CANNOT modify it.
        previousOutputs._constraintContract = ctx.constraintContract || null;

        // ── Phase transition: verify CCO hash (immutability check) ──────────
        // Any mutation of the CCO between phases would change the hash.
        // Hard gate: if hash doesn't match, stop the pipeline.
        if (ctx.constraintContract && ctx.ccoHash) {
          const _hashCheck = verifyCCOHash(ctx.constraintContract, ctx.ccoHash);
          if (!_hashCheck.valid) {
            const msg = `CCO_MUTATION_DETECTED at phase transition → ${stage}: ${_hashCheck.error}`;
            console.error(`[Orchestrator] CRITICAL: ${msg}`);
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage,
              status: 'failed',
              payload: {
                run_event: 'CCO_MUTATION_DETECTED',
                error: msg,
                expected_hash: ctx.ccoHash.slice(0, 16),
              },
              created_at: new Date().toISOString(),
            });
            this.eventBus.pipelineFailed(runId, stage, msg);
            if (ops) ops.onPipelineFailed(runId, stage, msg);
            return;
          }
        }

        // 3. Validate stage input contract
        buildStageInput(stage, prompt, previousOutputs);

        // 4. Record start with ops agent
        if (ops) ops.recordEvent(runId, 'stage_started', { stage });

        // 5. Transition → stage_running
        await this.stateMachine.transition(runId, stage, 'started');
        this.eventBus.stageStarted(runId, stage);

        // 6. Build emitChunk — broadcasts live chunks to SSE subscribers
        // Also captures reasoning for trace store (non-fatal)
        const _traceChunks = [];
        const _sseEmit = (content) => {
          this.stateMachine.emit(`run:${runId}`, {
            run_id: runId,
            stage,
            status: 'output',
            payload: { content },
            created_at: new Date().toISOString()
          });
        };
        const emitChunk = (content) => {
          _traceChunks.push(content);
          _sseEmit(content);
        };

        // 7. Consume any pending injections — prepend to prompt for this stage
        const effectivePrompt = this._applyInjections(runId, prompt, ctx);

        // 8. Dispatch to agent (or legacy executor fallback)
        const _stageStartMs = Date.now();
        const rawOutput = await this._dispatchStage(runId, stage, effectivePrompt, previousOutputs, emitChunk, ctx);
        const _stageLatencyMs = Date.now() - _stageStartMs;

        // 9. Extract token usage from agent output (non-fatal)
        try {
          if (rawOutput && rawOutput._tokenUsage) {
            const { model, inputTokens, outputTokens } = rawOutput._tokenUsage;
            this.costTracker.recordTokens(runId, stage, model, inputTokens, outputTokens);
            const costs = this.costTracker.getRunCosts(runId);
            if (costs) {
              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId, stage, status: 'cost_update',
                payload: { stageCost: rawOutput._tokenUsage, totalCostUsd: costs.totalCostUsd },
                created_at: new Date().toISOString()
              });
            }
          }
        } catch (costErr) {
          console.warn('[Orchestrator] Token recording error (non-fatal):', costErr.message);
        }

        // 10. Validate output contract
        const outputForValidation = rawOutput ? { ...rawOutput } : rawOutput;
        if (outputForValidation) delete outputForValidation._tokenUsage;

        let validatedOutput;
        try {
          validatedOutput = validateStageOutput(stage, outputForValidation);
        } catch (contractErr) {
          // HARD GATE for scaffold: output contract failure is fatal, not a warning.
          // Other stages get soft treatment for backward compatibility.
          if (stage === 'scaffold') {
            throw contractErr;
          }
          console.warn(`[Orchestrator] Output contract warning for "${stage}":`, contractErr.message);
          validatedOutput = outputForValidation;
        }

        // 10a. SCAFFOLD HARD GATE — deep manifest validation.
        // If scaffold output doesn't contain a valid manifest (files[], structure{}, constraints{}),
        // the pipeline STOPS. CODE cannot proceed without a binding contract.
        if (stage === 'scaffold' && validatedOutput) {
          try {
            const scaffoldIntentClass = ctx.constraintContract ? ctx.constraintContract.intent_class : null;
            validateScaffoldManifest(validatedOutput, scaffoldIntentClass);
            console.log(`[Orchestrator] Scaffold manifest validated ✓ (${validatedOutput.files.length} files, entry: ${validatedOutput.constraints.entry}, schema: ${scaffoldIntentClass || 'default'})`);
          } catch (manifestErr) {
            console.error(`[Orchestrator] SCAFFOLD HARD GATE — manifest validation failed:`, manifestErr.message);

            // Emit SSE event so UI can show the failure reason
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage: 'scaffold',
              status: 'manifest_invalid',
              payload: {
                error: manifestErr.message,
                violations: manifestErr.violations || [],
              },
              created_at: new Date().toISOString()
            });

            throw manifestErr; // Pipeline stops here
          }

          // 10a-2. INTENT GATE SCAFFOLD CHECK — ensure scaffold respects constraint contract.
          // If expansion_lock=true and scaffold includes prohibited layers → REJECT.
          if (ctx.constraintContract) {
            const contractCheck = validateScaffoldAgainstContract(validatedOutput, ctx.constraintContract);
            if (!contractCheck.valid) {
              const violationMsg = `CONSTRAINT_VIOLATION_DETECTED: scaffold violates Intent Gate (${ctx.constraintContract.intent_class}): ${contractCheck.violations.join('; ')}`;
              console.error(`[Orchestrator] ${violationMsg}`);

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'scaffold',
                status: 'constraint_violation',
                payload: {
                  intent_class: ctx.constraintContract.intent_class,
                  violations: contractCheck.violations,
                  run_event: 'CONSTRAINT_VIOLATION_DETECTED',
                },
                created_at: new Date().toISOString(),
              });

              throw new ContractValidationError('scaffold', 'intent_gate_constraints', contractCheck.violations);
            }
            console.log(`[Orchestrator] Intent Gate scaffold check ✓ (${ctx.constraintContract.intent_class})`);
          }
        }

        // 10b. POST-CODE ENFORCEMENT + VALIDATION — enforce scaffold manifest on CODE output.
        // Defense-in-depth: even if the agent's internal enforcement failed or was bypassed
        // (e.g., simulated fallback, AI error), the orchestrator strips unexpected files
        // and only fails on MISSING files (which indicate CODE genuinely failed).
        if (stage === 'code' && validatedOutput && validatedOutput.files) {
          const scaffoldData = await this.executor.getPreviousOutputs(runId);
          if (scaffoldData.scaffold && scaffoldData.scaffold.files) {
            // ── STEP 1: STRIP unexpected files before validation ──────────
            // This prevents contract violations from extra hallucinated files.
            // The agent should have already done this, but we enforce here as a hard gate.
            const scaffoldFileList = scaffoldData.scaffold.files;
            const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);
            const JS_EQUIVALENTS = [['app.js', 'script.js']];

            // Build canonical manifest set (same normalization as builder-agent)
            const manifestSet = new Set();
            for (const f of scaffoldFileList) {
              if (f.startsWith('public/')) {
                const basename = f.replace('public/', '');
                if (FRONTEND_ROOT_FILES.has(basename)) {
                  manifestSet.add(basename);
                  continue;
                }
              }
              manifestSet.add(f);
            }

            // Apply JS equivalence mapping (app.js ↔ script.js)
            for (const [a, b] of JS_EQUIVALENTS) {
              if (manifestSet.has(a) && !validatedOutput.files[a] && validatedOutput.files[b]) {
                console.log(`[Orchestrator] Manifest enforcement: renaming ${b} → ${a}`);
                validatedOutput.files[a] = validatedOutput.files[b];
                delete validatedOutput.files[b];
              }
              if (manifestSet.has(b) && !validatedOutput.files[b] && validatedOutput.files[a]) {
                console.log(`[Orchestrator] Manifest enforcement: renaming ${a} → ${b}`);
                validatedOutput.files[b] = validatedOutput.files[a];
                delete validatedOutput.files[a];
              }
            }

            // Strip unexpected files
            const codeFileKeys = Object.keys(validatedOutput.files);
            const strippedFiles = [];
            for (const key of codeFileKeys) {
              let isExpected = manifestSet.has(key);
              // Normalize: public/x → x
              if (!isExpected && key.startsWith('public/')) {
                const basename = key.replace('public/', '');
                if (FRONTEND_ROOT_FILES.has(basename)) {
                  isExpected = manifestSet.has(basename);
                }
              }
              // Reverse: x → public/x
              if (!isExpected && FRONTEND_ROOT_FILES.has(key)) {
                isExpected = manifestSet.has('public/' + key);
              }
              if (!isExpected) {
                strippedFiles.push(key);
                delete validatedOutput.files[key];
              }
            }

            if (strippedFiles.length > 0) {
              console.log(`[Orchestrator] Manifest enforcement: stripped ${strippedFiles.length} unexpected files: ${strippedFiles.join(', ')}`);
            }

            // ── STEP 2: VALIDATE remaining files against scaffold ─────────
            const codeCheck = validateCodeAgainstScaffold(validatedOutput, scaffoldData.scaffold);

            if (!codeCheck.valid) {
              // After stripping, only MISSING files should cause failures
              // (unexpected files were already stripped above)
              console.error(
                `[Orchestrator] POST-CODE VALIDATION FAILED — ` +
                `${codeCheck.missingFiles.length} missing: ` +
                codeCheck.errors.join('; ')
              );

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'code',
                status: 'scaffold_mismatch',
                payload: {
                  missingFiles: codeCheck.missingFiles,
                  unexpectedFiles: [],
                  errors: codeCheck.errors,
                },
                created_at: new Date().toISOString()
              });

              throw new ContractValidationError('code', 'scaffold_match', codeCheck.errors);
            }

            console.log(
              `[Orchestrator] Post-CODE scaffold validation passed ✓ ` +
              `(${Object.keys(validatedOutput.files).length} files match scaffold` +
              `${strippedFiles.length > 0 ? `, ${strippedFiles.length} stripped` : ''})`
            );
          }

          // 10b-2. INTENT GATE CODE CHECK — ensure generated code respects constraint contract.
          if (ctx.constraintContract) {
            const contractCodeCheck = validateCodeAgainstContract(validatedOutput, ctx.constraintContract);
            if (!contractCodeCheck.valid) {
              const violationMsg = `CONSTRAINT_VIOLATION_DETECTED: code violates Intent Gate (${ctx.constraintContract.intent_class}): ${contractCodeCheck.violations.join('; ')}`;
              console.error(`[Orchestrator] ${violationMsg}`);

              this.stateMachine.emit(`run:${runId}`, {
                run_id: runId,
                stage: 'code',
                status: 'constraint_violation',
                payload: {
                  intent_class: ctx.constraintContract.intent_class,
                  violations: contractCodeCheck.violations,
                  run_event: 'CONSTRAINT_VIOLATION_DETECTED',
                },
                created_at: new Date().toISOString(),
              });

              // Warn but don't hard-fail code stage — QA will catch this as an error
              console.warn(`[Orchestrator] Code constraint violation logged — QA will flag`);
            } else {
              console.log(`[Orchestrator] Intent Gate code check ✓ (${ctx.constraintContract.intent_class})`);
            }
          }
        }

        // 10c. Phase 4: Emit expansion events based on stage output
        // For soft_expansion contracts, emit EXPANSION_JUSTIFIED after PLAN completes.
        if (ctx.constraintContract && ctx.constraintContract.intent_class === 'soft_expansion') {
          try {
            if (stage === 'plan' && validatedOutput && validatedOutput.expansion_justifications) {
              const justifications = validatedOutput.expansion_justifications;
              if (justifications.length > 0) {
                for (const j of justifications) {
                  this.stateMachine.emit(`run:${runId}`, {
                    run_id: runId,
                    stage: 'plan',
                    status: 'expansion_justified',
                    payload: {
                      run_event:  'EXPANSION_JUSTIFIED',
                      capability: j.capability,
                      reason:     j.reason,
                      scope:      j.scope,
                    },
                    created_at: new Date().toISOString(),
                  });
                }
                console.log(`[Orchestrator] Phase 4 EXPANSION_JUSTIFIED: ${justifications.map(j => j.capability).join(', ')}`);
              } else {
                console.log('[Orchestrator] Phase 4: PLAN used no soft expansions — staying with base constraints');
              }
            }
          } catch (expansionEventErr) {
            // Non-fatal
            console.warn('[Orchestrator] Phase 4 expansion event emission failed (non-fatal):', expansionEventErr.message);
          }
        }

        // 11a. Capture decision trace (non-fatal — never blocks the pipeline)
        if (this.traceStore) {
          try {
            const tokenCostData = rawOutput?._tokenUsage || null;
            await this.traceStore.addTrace(runId, stage, {
              agentName: AGENT_FOR_STAGE[stage] || 'Unknown',
              promptSent: effectivePrompt,
              reasoning: _traceChunks.join(''),
              actionTaken: stage,
              outputPayload: validatedOutput,
              latencyMs: _stageLatencyMs,
              tokenCost: tokenCostData,
            });
          } catch (traceErr) {
            console.warn(`[Orchestrator] Trace capture failed for "${stage}" (non-fatal):`, traceErr.message);
          }
        }

        // 11a-2. Emit decision-level causal DAG nodes (non-fatal — never blocks the pipeline)
        try {
          const _cco = ctx.constraintContract || null;
          switch (stage) {
            case 'plan':
              await this.runTrace.emitPlanNodes(runId, validatedOutput, _cco);
              break;
            case 'scaffold':
              await this.runTrace.emitScaffoldNodes(runId, validatedOutput, _cco);
              break;
            case 'code':
              await this.runTrace.emitCodeNodes(runId, validatedOutput, _cco);
              break;
            case 'verify':
              await this.runTrace.emitVerifyNodes(runId, validatedOutput, _cco);
              break;
          }
        } catch (nodeErr) {
          console.warn(`[Orchestrator] RunTrace node emission for "${stage}" failed (non-fatal):`, nodeErr.message);
        }

        // 11b. Persist stage artifact
        if (this.artifactStore) {
          try {
            await this.artifactStore.writeStageArtifact(runId, stage, validatedOutput);
          } catch (artifactErr) {
            console.warn(`[Orchestrator] Artifact write failed for "${stage}":`, artifactErr.message);
          }
        }

        // 11c. Write live preview after CODE stage so iframe shows app during VERIFY
        if (stage === 'code' && this.deployEngine && validatedOutput && validatedOutput.files) {
          this.deployEngine.writePreview(runId, validatedOutput, prompt).catch(err => {
            console.warn(`[Orchestrator] Preview write error (non-fatal): ${err.message}`);
          });
        }

        // 11d. Phase 4: Emit expansion audit events after VERIFY stage completes.
        // QAAgent flags EXPANSION_UNNECESSARY and EXPANSION_SCOPE_EXCEEDED via flagIssue().
        // Here we capture those and emit them as pipeline SSE events for observability.
        if (stage === 'verify' && ctx.constraintContract && ctx.constraintContract.intent_class === 'soft_expansion') {
          try {
            const qaAgent = this.agentRegistry && this.agentRegistry.getAgent
              ? this.agentRegistry.getAgent('verify')
              : null;
            if (qaAgent && typeof qaAgent.getIssues === 'function') {
              const qaIssues = qaAgent.getIssues(runId) || [];
              const expansionIssues = qaIssues.filter(i =>
                i.run_event === 'EXPANSION_UNNECESSARY' || i.run_event === 'EXPANSION_SCOPE_EXCEEDED'
              );
              for (const issue of expansionIssues) {
                this.stateMachine.emit(`run:${runId}`, {
                  run_id: runId,
                  stage: 'verify',
                  status: 'expansion_violation',
                  payload: {
                    run_event:  issue.run_event,
                    capability: issue.capability,
                    message:    issue.message,
                    severity:   issue.severity,
                  },
                  created_at: new Date().toISOString(),
                });
              }
              if (expansionIssues.length > 0) {
                console.log(`[Orchestrator] Phase 4: ${expansionIssues.length} expansion audit event(s) emitted (${expansionIssues.map(i => i.run_event).join(', ')})`);
              }
            }
          } catch (expansionAuditErr) {
            // Non-fatal
            console.warn('[Orchestrator] Phase 4 expansion audit event emission failed (non-fatal):', expansionAuditErr.message);
          }
        }

        // 12. Record completion with ops agent
        if (ops) ops.recordEvent(runId, 'stage_completed', { stage });

        // Capture verify output for analytics (used in PIPELINE_COMPLETED below)
        if (stage === 'verify') ctx._verifyOutput = validatedOutput;

        // 12a. Emit verify_report from orchestrator for ALL verify executors.
        // This ensures the frontend receives structured check data via SSE
        // regardless of which executor ran the verify stage (QA Agent, legacy, etc.).
        if (stage === 'verify' && validatedOutput && Array.isArray(validatedOutput.checks)) {
          try {
            const passedCount = validatedOutput.checks.filter(c => c.passed).length;
            const totalChecks = validatedOutput.checks.length;
            this.stateMachine.emit(`run:${runId}`, {
              run_id: runId,
              stage: 'verify',
              status: 'verify_report',
              payload: JSON.stringify({
                checks: validatedOutput.checks,
                sectionReport: validatedOutput.sectionReport || [],
                passed: passedCount === totalChecks,
                passedCount,
                totalChecks,
                errors: validatedOutput.errors || [],
                warnings: validatedOutput.warnings || [],
              }),
              created_at: new Date().toISOString(),
            });
            console.log(`[Orchestrator] verify_report emitted: ${passedCount}/${totalChecks} checks passed`);
          } catch (_) { /* non-fatal */ }
        }

        // 12b. Self-healing: if VERIFY has failed checks, auto-diagnose + retry CODE phase
        if (stage === 'verify' && validatedOutput && Array.isArray(validatedOutput.checks)) {
          const _failedChecks = validatedOutput.checks.filter(c => !c.passed);
          if (_failedChecks.length > 0) {
            console.log(`[Orchestrator] Self-heal triggered: ${_failedChecks.length} failed check(s) for run ${runId.slice(0, 8)}`);
            try {
              const healResult = await this._runSelfHeal(
                runId, effectivePrompt, ctx, validatedOutput, previousOutputs, emitChunk
              );
              if (healResult.healed) {
                validatedOutput = healResult.verifyOutput;
                ctx._verifyOutput = validatedOutput; // keep analytics capture in sync
                // Re-emit verify_report with the healed results so UI shows final state
                try {
                  const _hPassedCount = validatedOutput.checks.filter(c => c.passed).length;
                  const _hTotalChecks = validatedOutput.checks.length;
                  this.stateMachine.emit(`run:${runId}`, {
                    run_id: runId,
                    stage: 'verify',
                    status: 'verify_report',
                    payload: JSON.stringify({
                      checks: validatedOutput.checks,
                      sectionReport: validatedOutput.sectionReport || [],
                      passed: _hPassedCount === _hTotalChecks,
                      passedCount: _hPassedCount,
                      totalChecks: _hTotalChecks,
                      errors: validatedOutput.errors || [],
                      warnings: validatedOutput.warnings || [],
                      selfHealed: true,
                      selfHealRetryNum: healResult.retryNum,
                    }),
                    created_at: new Date().toISOString(),
                  });
                } catch (_) { /* non-fatal */ }
              }
            } catch (healErr) {
              console.warn(`[Orchestrator] Self-heal: unexpected error (non-fatal):`, healErr.message);
            }
          }
        }

        // 13. Transition → stage_complete
        await this.stateMachine.transition(runId, stage, 'completed', validatedOutput);
        this.eventBus.stageCompleted(runId, stage, validatedOutput);

        // 14. Check for pause request AFTER stage completes
        if (ctx.pauseRequested && !ctx.aborted) {
          ctx.pauseRequested = false;
          await this._doPause(runId, stage, ctx);
          if (ctx.aborted) return;
        }

      } catch (err) {
        const errorMsg = err instanceof ContractValidationError
          ? `Contract violation: ${err.violations.join('; ')}`
          : err.message;

        console.error(`[Orchestrator] Stage "${stage}" failed for ${runId.slice(0, 8)}...:`, errorMsg);

        if (ops) ops.recordEvent(runId, 'stage_failed', { stage, error: errorMsg });

        try {
          await this.stateMachine.transition(runId, stage, 'failed', null, errorMsg);
        } catch (transErr) {
          console.error(`[Orchestrator] Failed to record failure:`, transErr.message);
        }

        this.eventBus.stageFailed(runId, stage, errorMsg);
        this.eventBus.pipelineFailed(runId, stage, errorMsg);

        if (ops) ops.onPipelineFailed(runId, stage, errorMsg);

        // ── Analytics: PIPELINE_FAILED (fire-and-forget) ──────────────────
        ;(async () => {
          try {
            const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
            const userId = userRow.rows[0]?.user_id || null;
            await analytics.emitEvent(this.pool, 'PIPELINE_FAILED', userId, {
              run_id:      runId,
              failed_phase: stage || 'unknown',
              error_type:  err instanceof ContractValidationError ? 'contract_violation' : 'execution_error',
              duration_ms: ctx._pipelineStartMs ? (Date.now() - ctx._pipelineStartMs) : null,
            });
          } catch (_) {}
        })();

        return;
      }
    }

    // All stages completed successfully
    console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... completed all stages`);

    // ── ACL Phase 2 + CDK Phase 3: Constraint Learning & Stability Control ───
    // Non-blocking: learning engine failure MUST NOT fail the pipeline.
    //
    // Phase 2: Reads constraint_violations → computes raw weight deltas
    // CDK Phase 3: Governs raw deltas via coupling matrix + envelope clamping
    //              + drift detection + anti-collapse freeze guard
    // Persistence: CDK-governed weights stored in constraint_feedback_weights
    // Events: CDK_WEIGHTS_GOVERNED / CDK_DRIFT_DETECTED / CDK_CONSTRAINT_FROZEN
    //         captured and stored in run_events via ops.recordEvent
    if (ctx.constraintContract) {
      try {
        const _taskType = ctx.constraintContract.task_type;

        // Capture CDK events for run_events persistence (in addition to SSE streaming)
        const _cdkEvents = [];

        const _emitFn = (payload) => {
          // 1. SSE stream (real-time) — same as Phase 2 path
          this.stateMachine.emit(`run:${runId}`, {
            run_id:     runId,
            stage:      '_acl_learner',
            status:     'weight_update',
            payload,
            created_at: new Date().toISOString(),
          });

          // 2. Capture CDK events for DB persistence
          if (payload && payload.run_event && payload.run_event.startsWith('CDK_')) {
            _cdkEvents.push(payload);
          }
        };

        const learnerResult = await constraintLearner.learn(runId, _taskType, this.pool, _emitFn);

        if (!learnerResult.skipped && learnerResult.updates.length > 0) {
          console.log(
            `[Orchestrator] ACL learning: ${learnerResult.updates.length} weight update(s) committed ` +
            `for task_type=${_taskType} (cdk_applied=${learnerResult.cdkApplied}) ` +
            `(run ${runId.slice(0, 8)})`
          );
        }

        // Persist CDK events to pipeline_events for observability.
        // NOTE: Uses pipeline_events (FK → pipeline_runs) NOT run_events (FK → runs).
        // The runId here is a pipeline_runs.id — inserting into run_events caused
        // FK violations on every run because the ID doesn't exist in the runs table.
        if (_cdkEvents.length > 0 && this.pool) {
          let persisted = 0;
          for (const cdkEvt of _cdkEvents) {
            try {
              await this.pool.query(
                `INSERT INTO pipeline_events (run_id, stage, status, payload)
                      VALUES ($1, $2, $3, $4)`,
                [runId, 'CDK', cdkEvt.run_event, JSON.stringify(cdkEvt.payload || cdkEvt)]
              );
              persisted++;
            } catch (evtErr) {
              console.warn(`[Orchestrator] CDK pipeline_events insert failed (non-fatal): ${evtErr.message}`);
            }
          }
          if (persisted > 0) {
            console.log(`[Orchestrator] CDK: ${persisted}/${_cdkEvents.length} event(s) stored for run ${runId.slice(0, 8)}`);
          }
        }

      } catch (learnerErr) {
        // Non-fatal — ACL learning must never block pipeline completion
        console.warn('[Orchestrator] ACL learning step failed (non-fatal):', learnerErr.message);
      }
    }

    // ── Run Trace Integrity Check ─────────────────────────────────────────────
    // Validates the causal DAG: every node has a parent (except root), no orphans,
    // no dangling parent refs. On failure: pipeline_runs.non_explainable = true.
    // Non-fatal — integrity failure never changes the run completion status.
    try {
      await this.runTrace.checkIntegrity(runId);
    } catch (integrityErr) {
      console.warn('[Orchestrator] RunTrace integrity check threw (non-fatal):', integrityErr.message);
    } finally {
      this.runTrace.clearRun(runId);
    }

    this.eventBus.pipelineCompleted(runId);

    if (ops) ops.onPipelineComplete(runId);

    // ── Analytics: PIPELINE_COMPLETED (fire-and-forget) ───────────────────
    ;(async () => {
      try {
        const userRow = await this.pool.query('SELECT user_id FROM pipeline_runs WHERE id = $1', [runId]);
        const userId = userRow.rows[0]?.user_id || null;
        const verifyChecks = Array.isArray(ctx._verifyOutput?.checks) ? ctx._verifyOutput.checks : [];
        await analytics.emitEvent(this.pool, 'PIPELINE_COMPLETED', userId, {
          run_id:       runId,
          intent_class: ctx.constraintContract?.intent_class || null,
          pass_count:   verifyChecks.filter(c => c.passed).length,
          fail_count:   verifyChecks.filter(c => !c.passed).length,
          duration_ms:  ctx._pipelineStartMs ? (Date.now() - ctx._pipelineStartMs) : null,
        });
      } catch (_) {}
    })();

    // ── Credit decrement + transactional email notifications (fire-and-forget) ──
    // Deducts 1 credit per completed run, sends credit warning when ≤2 remain,
    // and notifies the user their build is ready.
    // Non-blocking — email failures never affect pipeline status.
    ;(async () => {
      try {
        const runRow = await this.pool.query(
          'SELECT user_id, prompt FROM pipeline_runs WHERE id = $1',
          [runId]
        );
        const userId = runRow.rows[0]?.user_id;
        const prompt = runRow.rows[0]?.prompt || '';
        if (!userId) return;

        // Decrement 1 credit (floor at 0 — never go negative)
        const creditResult = await this.pool.query(
          `UPDATE users
              SET task_credits = GREATEST(task_credits - 1, 0)
            WHERE id = $1
            RETURNING email, task_credits`,
          [userId]
        );
        const userEmail   = creditResult.rows[0]?.email;
        const newCredits  = creditResult.rows[0]?.task_credits ?? null;

        if (!userEmail) return;

        // Pipeline complete notification (include live URL if deployed)
        sendPipelineCompleteEmail(userEmail, { prompt, runId, liveUrl: ctx._liveUrl || null }).catch(err =>
          console.error('[Orchestrator] Pipeline complete email error (non-fatal):', err.message)
        );

        // Credit warning when ≤ 2 remain
        if (newCredits !== null && newCredits <= 2) {
          sendCreditWarningEmail(userEmail, newCredits).catch(err =>
            console.error('[Orchestrator] Credit warning email error (non-fatal):', err.message)
          );
        }

        console.log(`[Orchestrator] Post-run: userId=${userId} credits now ${newCredits}`);
      } catch (postRunErr) {
        console.error('[Orchestrator] Post-run notifications error (non-fatal):', postRunErr.message);
      }
    })();

    // ── DEPLOY Phase ──────────────────────────────────────────────────────────
    // STATIC_SURFACE → static file deploy at /live/{runId}/
    // PRODUCT_SYSTEM (full_product) → Node.js process deploy at /app/{runId}/
    // Other intent classes: deploy only if autoDeploy flag is set in runConfig.
    // Runs synchronously here so the completion email can include the live URL.
    // All deploy failures are non-fatal — errors never affect pipeline status.
    const _deployIntentClass = ctx.constraintContract?.intent_class;
    const _shouldDeploy = this.deployEngine && (
      _deployIntentClass === 'static_surface' ||
      _deployIntentClass === 'full_product' ||
      (ctx.runConfig && ctx.runConfig.autoDeploy)
    );

    if (_shouldDeploy) {
      console.log(`[Orchestrator] DEPLOY phase triggered for run ${runId.slice(0, 8)} (intent=${_deployIntentClass || 'runConfig.autoDeploy'})...`);
      try {
        const deployResult = await this.deployEngine.deploy(runId, prompt);
        if (deployResult.success && deployResult.url) {
          ctx._liveUrl = deployResult.url;
          console.log(`[Orchestrator] DEPLOY complete → ${deployResult.url} (run ${runId.slice(0, 8)})`);
          // NOTE: deploy events (deploy_started, deploy_uploading, deploy_complete)
          // are now persisted to pipeline_events by DeployEngine._emit() directly.
          // No need to duplicate the INSERT here — idempotency keys prevent conflicts.
        }
      } catch (deployErr) {
        console.warn(`[Orchestrator] DEPLOY error (non-fatal): ${deployErr.message}`);
      }
    }
  }

  /**
   * Enter the pause-wait loop.
   * Blocks (async) until ctx.resumed or ctx.aborted is set.
   */
  async _doPause(runId, afterStage, ctx) {
    ctx.paused = true;
    ctx.pausedAfterStage = afterStage;

    // Transition DB state to 'paused'
    try {
      await this.stateMachine.pauseRun(runId, afterStage);
    } catch (e) {
      console.warn(`[Orchestrator] Could not set paused state: ${e.message}`);
    }

    // Log to interventions table
    try {
      await this.pool.query(
        `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'paused', $2)`,
        [runId, JSON.stringify({ after_stage: afterStage })]
      );
    } catch (e) {
      console.warn('[Orchestrator] Could not log pause intervention:', e.message);
    }

    console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... paused after ${afterStage}`);

    // Wait for resume or abort
    await this._waitForResume(runId, ctx);

    if (!ctx.aborted) {
      ctx.paused = false;

      // Restore DB state to {afterStage}_complete so loop continues
      try {
        await this.stateMachine.resumeRun(runId, afterStage);
      } catch (e) {
        console.warn(`[Orchestrator] Could not restore state on resume: ${e.message}`);
      }

      // Log to interventions table
      try {
        await this.pool.query(
          `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
          [runId, JSON.stringify({ after_stage: afterStage })]
        );
      } catch (e) {
        console.warn('[Orchestrator] Could not log resume intervention:', e.message);
      }

      console.log(`[Orchestrator] Run ${runId.slice(0, 8)}... resumed after ${afterStage}`);
    }
  }

  /**
   * Poll until ctx.resumed or ctx.aborted.
   * Uses 250ms intervals. No timeout — paused runs wait indefinitely.
   */
  _waitForResume(runId, ctx) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (ctx.resumed || ctx.aborted) {
          clearInterval(check);
          ctx.resumed = false; // Reset for next potential pause
          resolve();
        }
      }, 250);
    });
  }

  /**
   * Apply pending injections to the prompt.
   * Clears injections after consuming them.
   */
  _applyInjections(runId, prompt, ctx) {
    if (!ctx.pendingInjections || ctx.pendingInjections.length === 0) {
      return prompt;
    }

    const injections = ctx.pendingInjections.splice(0); // consume all
    const prefix = injections
      .map(msg => `[HUMAN DIRECTIVE]: ${msg}`)
      .join('\n');

    console.log(`[Orchestrator] Applying ${injections.length} injection(s) to run ${runId.slice(0, 8)}...`);
    return `${prefix}\n\n${prompt}`;
  }

  /**
   * Resume a paused run that was restarted (not in activeRuns memory).
   * Re-enqueues from DB with the paused ctx state.
   */
  async _resumeFromDb(runId) {
    const run = await this.executor.getRun(runId).catch(() => null);
    if (!run) {
      return { success: false, message: 'Run not found' };
    }
    if (run.state !== 'paused') {
      return { success: false, message: `Run is not paused (state: ${run.state})` };
    }

    // Find what stage was last completed
    const events = await this.stateMachine.getEvents(runId);
    let afterStage = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].status === 'completed' && events[i].stage !== '_system') {
        afterStage = events[i].stage;
        break;
      }
    }

    if (!afterStage) {
      return { success: false, message: 'Could not determine last completed stage' };
    }

    // Restore DB state so orchestrator loop works
    try {
      await this.stateMachine.resumeRun(runId, afterStage);
    } catch (e) {
      console.warn('[Orchestrator] Could not restore state for DB resume:', e.message);
    }

    // Log resume
    try {
      await this.pool.query(
        `INSERT INTO pipeline_interventions (run_id, type, payload) VALUES ($1, 'resumed', $2)`,
        [runId, JSON.stringify({ after_stage: afterStage, source: 'db_resume' })]
      );
    } catch (e) { /* non-fatal */ }

    this.enqueue(runId, run.prompt, {}, run.run_config || {});

    return { success: true, message: `Run resumed from after "${afterStage}" stage` };
  }

  /**
   * Dispatch a stage to the appropriate agent.
   * Checks for agent overrides and applies them (one-shot).
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} prompt      - Effective prompt (may have injections prepended)
   * @param {object} previousOutputs
   * @param {function} emitChunk
   * @param {object} ctx         - Run context (for agent overrides)
   * @returns {object} Raw stage output
   */
  async _dispatchStage(runId, stage, prompt, previousOutputs, emitChunk, ctx) {
    const agentKey = STAGE_TO_AGENT[stage];
    const hasOverride = ctx && ctx.agentOverrides && ctx.agentOverrides[agentKey];

    if (hasOverride) {
      const overridePrompt = ctx.agentOverrides[agentKey];
      delete ctx.agentOverrides[agentKey]; // one-shot: consume and clear
      console.log(`[Orchestrator] Applying agent override for ${agentKey} on stage "${stage}"`);
      // Prepend override to prompt — agent sees it as a directive
      prompt = `[AGENT OVERRIDE — use this as your primary instruction]: ${overridePrompt}\n\nOriginal context: ${prompt}`;
    }

    if (this.agentRegistry && this.agentRegistry.hasAgent(stage)) {
      const agent = this.agentRegistry.getAgent(stage);
      console.log(`[Orchestrator] Dispatching "${stage}" → ${agent.constructor.name}`);
      return agent.execute({ runId, stage, prompt, previousOutputs, emitChunk });
    }

    // Legacy fallback — single executor handles all stages
    console.log(`[Orchestrator] Dispatching "${stage}" → PipelineExecutor (legacy fallback)`);
    return this.executor.executeStage(runId, stage, prompt);
  }

  // ── Self-Healing Loop ───────────────────────────────────

  /**
   * Build the diagnosis prompt for the healing LLM call.
   * Includes failed check names, verify output, generated code sample, scaffold, and CCO.
   */
  _buildHealingDiagnosisPrompt(failedChecks, verifyOutput, codeOutput, scaffoldOutput, cco) {
    const failedCheckLines = failedChecks.map(c =>
      `- **${c.name}**: ${c.description || 'No description'} (category: ${c.category || 'unknown'})`
    ).join('\n');

    // Include a sample of generated code (first 5 files, 1500 chars each)
    const codeSnippet = (codeOutput && codeOutput.files)
      ? Object.entries(codeOutput.files)
          .slice(0, 5)
          .map(([filename, content]) => `\n--- ${filename} ---\n${(content || '').slice(0, 1500)}`)
          .join('\n')
      : 'No code output available';

    const scaffoldFiles = (scaffoldOutput && scaffoldOutput.files)
      ? scaffoldOutput.files.join(', ')
      : 'Not available';

    const intentClass = cco ? cco.intent_class : 'unknown';
    const taskType = cco ? (cco.task_type || cco.intent_class) : 'unknown';

    return `You are reviewing code generated by a build pipeline that failed automated verification checks.

## Failed VERIFY Checks
${failedCheckLines}

## Constraint Contract
- Intent class: ${intentClass}
- Task type: ${taskType}

## Scaffold Manifest (Required Files)
${scaffoldFiles}

## Generated Code (sample — first 5 files)
${codeSnippet}

## Your Task
Analyze WHY each check failed and provide SPECIFIC, ACTIONABLE fix instructions for the code generation agent. Be concise.

For each failed check:
1. State what's likely wrong in the current code
2. Provide the specific fix needed

Format as a numbered list. Do not include preamble.`;
  }

  /**
   * Call the healing LLM (OpenAI) to diagnose VERIFY failures.
   * Returns a string with specific fix instructions.
   */
  async _callHealingLLM(diagnosisPrompt) {
    if (!this._healingOpenAI) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not set — cannot call healing LLM');
      }
      this._healingOpenAI = new OpenAI();
    }

    const response = await this._healingOpenAI.chat.completions.create({
      model: process.env.SELF_HEAL_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a code reviewer diagnosing why generated code failed quality checks. Provide specific, actionable fix instructions only.',
        },
        {
          role: 'user',
          content: diagnosisPrompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content || 'Unable to generate diagnosis — retry with general improvements.';
  }

  /**
   * Self-healing retry loop.
   *
   * When VERIFY has failed checks, calls Claude/LLM to diagnose the failures,
   * then re-runs CODE → SAVE → VERIFY with the diagnosis appended to the prompt.
   * Max 2 retries (3 total attempts including the original).
   *
   * @param {string}   runId
   * @param {string}   basePrompt       - Effective prompt for this run (original + any injections)
   * @param {object}   ctx              - Run context
   * @param {object}   verifyOutput     - Failed VERIFY output { checks, passed, errors, warnings }
   * @param {object}   previousOutputs  - Previous stage outputs (plan, scaffold, code, save, _constraintContract, etc.)
   * @param {function} emitChunk        - SSE emitter
   * @returns {{ healed: boolean, verifyOutput?: object, retryNum?: number, diagnoses?: object[] }}
   */
  async _runSelfHeal(runId, basePrompt, ctx, verifyOutput, previousOutputs, emitChunk) {
    const MAX_RETRIES = 2;
    const runShort = runId.slice(0, 8);

    ctx._selfHealRetryCount = ctx._selfHealRetryCount || 0;

    const allDiagnoses = [];

    while (ctx._selfHealRetryCount < MAX_RETRIES) {
      ctx._selfHealRetryCount++;
      const retryNum = ctx._selfHealRetryCount;
      const failedChecks = verifyOutput.checks.filter(c => !c.passed);

      console.log(`[Orchestrator] Self-heal: attempt ${retryNum}/${MAX_RETRIES} for run ${runShort} (${failedChecks.length} failed check(s): ${failedChecks.map(c => c.name).join(', ')})`);

      // ── Emit retry-start SSE event for UI ─────────────────────────────────
      this.stateMachine.emit(`run:${runId}`, {
        run_id: runId,
        stage: 'verify',
        status: 'self_heal_retry_start',
        payload: {
          retryNum,
          maxRetries: MAX_RETRIES + 1, // total attempts = 1 original + MAX_RETRIES
          failedChecks: failedChecks.map(c => c.name),
          message: `VERIFY failed — auto-retrying CODE phase (attempt ${retryNum + 1}/${MAX_RETRIES + 1})`,
        },
        created_at: new Date().toISOString(),
      });

      // ── Step 1: Call LLM to diagnose the failure ───────────────────────────
      let diagnosis = null;
      try {
        const diagnosisPrompt = this._buildHealingDiagnosisPrompt(
          failedChecks,
          verifyOutput,
          previousOutputs.code,
          previousOutputs.scaffold,
          ctx.constraintContract
        );
        diagnosis = await this._callHealingLLM(diagnosisPrompt);
        console.log(`[Orchestrator] Self-heal diagnosis (attempt ${retryNum}): ${diagnosis.slice(0, 300)}...`);
      } catch (diagErr) {
        console.warn(`[Orchestrator] Self-heal: LLM diagnosis failed (attempt ${retryNum}, non-fatal):`, diagErr.message);
        // Fallback: generic fix instructions based on check names
        diagnosis = `The following verification checks failed — fix each:\n${failedChecks.map((c, i) => `${i + 1}. ${c.name}: Ensure this requirement is fully implemented. Check that all interactive elements have working event handlers, all required content sections are present, and no placeholder text ([YOUR TEXT HERE], Lorem ipsum) remains in the output.`).join('\n')}`;
      }

      allDiagnoses.push({
        retryNum,
        diagnosis: diagnosis.slice(0, 2000),
        failedChecks: failedChecks.map(c => c.name),
      });

      // ── Log code_retry event to pipeline_events ────────────────────────────
      try {
        await this.pool.query(
          `INSERT INTO pipeline_events (run_id, stage, status, payload) VALUES ($1, $2, $3, $4)`,
          [
            runId,
            `code_retry_${retryNum}`,
            'code_retry',
            JSON.stringify({
              retryNum,
              failedChecks: failedChecks.map(c => ({ name: c.name, description: c.description })),
              diagnosis: diagnosis.slice(0, 2000),
            }),
          ]
        );
      } catch (logErr) {
        console.warn(`[Orchestrator] Self-heal: pipeline_events code_retry log failed (non-fatal):`, logErr.message);
      }

      // ── Step 2: Re-run CODE with diagnosis appended to prompt ─────────────
      let newCodeOutput;
      try {
        const healPrompt = `${basePrompt}\n\n[SELF-HEAL INSTRUCTIONS — Fix these specific issues detected by VERIFY on the previous attempt]:\n${diagnosis}`;

        // Build previousOutputs for CODE retry — keep plan/scaffold/CCO, clear old code/save/verify
        const retryPreviousOutputs = {
          ...previousOutputs,
          code: undefined,
          save: undefined,
          verify: undefined,
        };

        // Emit retry output with a prefix so the user can see it in the terminal
        const retryEmit = (content) => emitChunk(`[Retry ${retryNum}] ${content}`);

        newCodeOutput = await this._dispatchStage(runId, 'code', healPrompt, retryPreviousOutputs, retryEmit, ctx);

        if (!newCodeOutput || !newCodeOutput.files || Object.keys(newCodeOutput.files).length === 0) {
          throw new Error('CODE retry produced no files');
        }

        // ── Manifest enforcement (defense in depth — mirrors main loop) ──────
        if (previousOutputs.scaffold && previousOutputs.scaffold.files) {
          const scaffoldFileList = previousOutputs.scaffold.files;
          const FRONTEND_ROOT_FILES = new Set(['index.html', 'styles.css', 'app.js', 'script.js']);

          const manifestSet = new Set();
          for (const f of scaffoldFileList) {
            if (f.startsWith('public/')) {
              const basename = f.replace('public/', '');
              if (FRONTEND_ROOT_FILES.has(basename)) {
                manifestSet.add(basename);
                continue;
              }
            }
            manifestSet.add(f);
          }

          const codeFileKeys = Object.keys(newCodeOutput.files);
          const stripped = [];
          for (const key of codeFileKeys) {
            let expected = manifestSet.has(key);
            if (!expected && key.startsWith('public/')) {
              const b = key.replace('public/', '');
              if (FRONTEND_ROOT_FILES.has(b)) expected = manifestSet.has(b);
            }
            if (!expected && FRONTEND_ROOT_FILES.has(key)) expected = manifestSet.has('public/' + key);
            if (!expected) {
              stripped.push(key);
              delete newCodeOutput.files[key];
            }
          }
          if (stripped.length > 0) {
            console.log(`[Orchestrator] Self-heal: stripped ${stripped.length} unexpected file(s): ${stripped.join(', ')}`);
          }
        }

        console.log(`[Orchestrator] Self-heal: CODE retry ${retryNum} produced ${Object.keys(newCodeOutput.files).length} file(s)`);
      } catch (codeErr) {
        console.warn(`[Orchestrator] Self-heal: CODE retry ${retryNum} failed (stopping):`, codeErr.message);
        break;
      }

      // ── Write preview for retry (non-fatal) ──────────────────────────────
      if (this.deployEngine && newCodeOutput && newCodeOutput.files) {
        this.deployEngine.writePreview(runId, newCodeOutput, basePrompt).catch(() => {});
      }

      // ── Step 3: Re-run SAVE with new code ─────────────────────────────────
      let newSaveOutput;
      try {
        const savePreviousOutputs = {
          ...previousOutputs,
          code: newCodeOutput,
          save: undefined,
          verify: undefined,
        };
        newSaveOutput = await this._dispatchStage(runId, 'save', basePrompt, savePreviousOutputs, () => {}, ctx);
      } catch (saveErr) {
        console.warn(`[Orchestrator] Self-heal: SAVE retry ${retryNum} failed (non-fatal, continuing to VERIFY):`, saveErr.message);
        newSaveOutput = { persisted: true, runId, versionId: `retry_${retryNum}`, timestamp: new Date().toISOString() };
      }

      // ── Step 4: Re-run VERIFY with new code ──────────────────────────────
      let newVerifyOutput;
      try {
        const verifyPreviousOutputs = {
          ...previousOutputs,
          code: newCodeOutput,
          save: newSaveOutput,
          verify: undefined,
        };
        // Use retryEmit (not silent () => {}) so retry VERIFY results are visible
        // in the terminal. Previously, the silent emitter caused a contradiction:
        // terminal showed original ✗ marks while the overall status showed "passed"
        // after a successful self-heal.
        const verifyRetryEmit = (content) => emitChunk(`[Retry ${retryNum} VERIFY] ${content}`);
        newVerifyOutput = await this._dispatchStage(runId, 'verify', basePrompt, verifyPreviousOutputs, verifyRetryEmit, ctx);

        if (!newVerifyOutput || !Array.isArray(newVerifyOutput.checks)) {
          throw new Error('VERIFY retry produced invalid output (missing checks array)');
        }
      } catch (verifyErr) {
        console.warn(`[Orchestrator] Self-heal: VERIFY retry ${retryNum} failed:`, verifyErr.message);
        break;
      }

      // ── Log retry VERIFY result ────────────────────────────────────────────
      try {
        const passedCount = newVerifyOutput.checks.filter(c => c.passed).length;
        const totalChecks = newVerifyOutput.checks.length;
        await this.pool.query(
          `INSERT INTO pipeline_events (run_id, stage, status, payload) VALUES ($1, $2, $3, $4)`,
          [
            runId,
            `verify_retry_${retryNum}`,
            'verify_retry',
            JSON.stringify({
              retryNum,
              passedCount,
              totalChecks,
              passed: passedCount === totalChecks,
              checks: newVerifyOutput.checks.map(c => ({ name: c.name, passed: c.passed })),
            }),
          ]
        );
      } catch (logErr) {
        console.warn(`[Orchestrator] Self-heal: verify_retry log failed (non-fatal):`, logErr.message);
      }

      const newFailedChecks = newVerifyOutput.checks.filter(c => !c.passed);

      if (newFailedChecks.length === 0) {
        // ── SUCCESS ──────────────────────────────────────────────────────────
        console.log(`[Orchestrator] Self-heal: SUCCEEDED on retry ${retryNum} for run ${runShort} ✓`);

        this.stateMachine.emit(`run:${runId}`, {
          run_id: runId,
          stage: 'verify',
          status: 'self_heal_succeeded',
          payload: {
            retryNum,
            message: `✓ Fixed on retry`,
            diagnoses: allDiagnoses,
          },
          created_at: new Date().toISOString(),
        });

        return { healed: true, retryNum, verifyOutput: newVerifyOutput };
      }

      // Still failing — update state for next iteration
      console.log(`[Orchestrator] Self-heal: attempt ${retryNum} still has ${newFailedChecks.length} failed check(s): ${newFailedChecks.map(c => c.name).join(', ')}`);
      verifyOutput = newVerifyOutput;
      previousOutputs = { ...previousOutputs, code: newCodeOutput, save: newSaveOutput };
    }

    // ── All retries exhausted ──────────────────────────────────────────────
    console.log(`[Orchestrator] Self-heal: EXHAUSTED for run ${runShort} after ${ctx._selfHealRetryCount} retry attempt(s)`);

    this.stateMachine.emit(`run:${runId}`, {
      run_id: runId,
      stage: 'verify',
      status: 'self_heal_exhausted',
      payload: {
        retriesAttempted: ctx._selfHealRetryCount,
        diagnoses: allDiagnoses,
        message: 'Auto-retry exhausted — all attempts failed',
      },
      created_at: new Date().toISOString(),
    });

    return { healed: false, diagnoses: allDiagnoses };
  }

  // ── Event Bus Handler ──────────────────────────────────

  /**
   * Callback when a stage completes.
   * Logs transition for observability.
   */
  _onStageCompleted(event) {
    const { runId, stage } = event;
    const stageIdx = STAGES.indexOf(stage);
    if (stageIdx >= 0 && stageIdx < STAGES.length - 1) {
      const nextStage = STAGES[stageIdx + 1];
      const nextAgent = this.agentRegistry && this.agentRegistry.hasAgent(nextStage)
        ? this.agentRegistry.getAgent(nextStage).constructor.name
        : 'PipelineExecutor';
      console.log(`[Orchestrator] Event bus: ${stage} → ${nextStage} (${nextAgent}) for ${(runId || '').slice(0, 8)}...`);
    }
  }
}

module.exports = { PipelineOrchestrator };
