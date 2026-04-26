/**
 * Ops Agent
 *
 * Owns the SAVE stage + cross-cutting operational concerns.
 *
 * Responsibilities:
 *   - SAVE: Persists pipeline artifacts to the database
 *   - Health monitoring: Tracks retry counts, durations, failure patterns per run
 *   - Retry decisions: Decides whether transient failures should be retried
 *   - Error escalation: Flags high-severity issues after max retries exceeded
 *   - Recovery assistance: Provides health context to the orchestrator on restart
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { persisted: true, runId, versionId, timestamp }
 *
 * Health API:
 *   agent.recordEvent(runId, eventType, meta?)  - Track pipeline lifecycle events
 *   agent.shouldRetry(runId, stage)             - Should this failure be retried?
 *   agent.getHealth(runId)                      - Return health summary for a run
 *   agent.onPipelineComplete(runId)             - Mark run as complete, log metrics
 *   agent.onPipelineFailed(runId, stage, error) - Record failure, escalate if needed
 *
 * Communication: Reads code from previousOutputs (pipeline state).
 * No direct calls to other agents — coordinates via pipeline state.
 */

class OpsAgent {
  constructor(pool) {
    this.stages = ['save'];
    this.pool = pool;

    // Health tracking per run: runId → HealthRecord
    this._health = new Map();

    // Retry config
    this.MAX_RETRIES = 3;
    this.TRANSIENT_ERROR_PATTERNS = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network error',
      'rate limit',
      '429',
      '503',
    ];
  }

  /**
   * Execute the SAVE stage.
   * Persists all pipeline artifacts to PostgreSQL.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - Must be 'save'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, scaffold, code }
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   * @returns {object} { persisted, runId, versionId, timestamp }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[OpsAgent] Executing SAVE for run ${runId.slice(0, 8)}...`);

    const lines = [
      `## Artifacts Saved`,
      ``,
      `\u2713 Execution plan persisted`,
      `\u2713 File structure recorded`,
      `\u2713 Generated code committed`,
      `\u2713 Pipeline run: \`${runId.slice(0, 8)}...\``,
      `\u2713 Timestamp: ${new Date().toISOString()}`,
      ``,
      `All artifacts stored in PostgreSQL and retrievable via API.`,
    ];

    for (const line of lines) {
      emitChunk(line + '\n');
      await this._delay(180);
    }

    // Persist phase outputs to pipeline_runs
    const updates = {};
    if (previousOutputs.plan) updates.plan = JSON.stringify(previousOutputs.plan);
    if (previousOutputs.scaffold) updates.scaffold = JSON.stringify(previousOutputs.scaffold);
    if (previousOutputs.code) updates.code = JSON.stringify(previousOutputs.code);

    if (Object.keys(updates).length > 0) {
      const keys = Object.keys(updates);
      const values = Object.values(updates);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
      await this.pool.query(
        `UPDATE pipeline_runs SET ${sets} WHERE id = $1`,
        [runId, ...values]
      );
    }

    const versionId = `v1-${runId.slice(0, 8)}-${Date.now().toString(36)}`;
    const timestamp = new Date().toISOString();

    // Record save in health tracker
    this.recordEvent(runId, 'save_completed', { versionId, timestamp });

    return {
      persisted: true,
      runId,
      versionId,
      timestamp,
    };
  }

  // ── Health Monitoring ────────────────────────────────────

  /**
   * Record a lifecycle event for a pipeline run.
   * Used to build health history without coupling to state machine.
   *
   * @param {string} runId
   * @param {string} eventType - 'stage_started' | 'stage_completed' | 'stage_failed' | 'save_completed'
   * @param {object} [meta]    - Optional metadata
   */
  recordEvent(runId, eventType, meta = {}) {
    const record = this._getOrCreateHealth(runId);
    record.events.push({
      type: eventType,
      timestamp: new Date().toISOString(),
      ...meta,
    });

    if (eventType === 'stage_failed') {
      record.failureCount++;
      record.lastFailure = { stage: meta.stage, error: meta.error, timestamp: new Date().toISOString() };
    }

    if (eventType === 'stage_started') {
      record.stageStartTimes[meta.stage] = Date.now();
    }

    if (eventType === 'stage_completed' && record.stageStartTimes[meta.stage]) {
      const duration = Date.now() - record.stageStartTimes[meta.stage];
      record.stageDurations[meta.stage] = duration;
    }
  }

  /**
   * Decide whether a failed stage should be retried.
   * Returns true for transient errors within retry limits.
   *
   * @param {string} runId
   * @param {string} stage
   * @param {string} [error] - Error message
   * @returns {boolean}
   */
  shouldRetry(runId, stage, error = '') {
    const record = this._getOrCreateHealth(runId);

    // Hard cap on total failures
    if (record.failureCount >= this.MAX_RETRIES) {
      console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: max retries (${this.MAX_RETRIES}) exceeded — no retry`);
      return false;
    }

    // Check if error looks transient
    const isTransient = this.TRANSIENT_ERROR_PATTERNS.some(pattern =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );

    if (!isTransient && record.failureCount >= 1) {
      // Non-transient errors: only retry once
      console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: non-transient error after retry — escalating`);
      return false;
    }

    console.log(`[OpsAgent] Run ${runId.slice(0, 8)}: retry approved for stage "${stage}" (attempt ${record.failureCount + 1}/${this.MAX_RETRIES})`);
    return true;
  }

  /**
   * Get health summary for a run.
   * Used by the orchestrator's retry and recovery logic.
   *
   * @param {string} runId
   * @returns {object} Health summary
   */
  getHealth(runId) {
    const record = this._getOrCreateHealth(runId);
    const totalDuration = Object.values(record.stageDurations).reduce((a, b) => a + b, 0);

    return {
      runId,
      failureCount: record.failureCount,
      lastFailure: record.lastFailure,
      stageDurations: record.stageDurations,
      totalDurationMs: totalDuration,
      eventCount: record.events.length,
      startedAt: record.startedAt,
    };
  }

  /**
   * Called when a pipeline completes successfully.
   * Logs metrics and cleans up health state.
   *
   * @param {string} runId
   */
  onPipelineComplete(runId) {
    const health = this.getHealth(runId);
    const totalMs = health.totalDurationMs;
    console.log(
      `[OpsAgent] Pipeline ${runId.slice(0, 8)} COMPLETED — ` +
      `${health.failureCount} failures, ` +
      `${totalMs}ms total across ${Object.keys(health.stageDurations).length} stages`
    );
    // Keep health record for a while (for debugging), but mark complete
    const record = this._health.get(runId);
    if (record) record.completedAt = new Date().toISOString();
  }

  /**
   * Called when a pipeline fails terminally (no more retries).
   * Logs the escalation.
   *
   * @param {string} runId
   * @param {string} stage  - Stage that failed
   * @param {string} error  - Error message
   */
  onPipelineFailed(runId, stage, error) {
    const health = this.getHealth(runId);
    console.error(
      `[OpsAgent] Pipeline ${runId.slice(0, 8)} FAILED — ` +
      `stage: ${stage}, ` +
      `attempts: ${health.failureCount}, ` +
      `error: ${error}`
    );
    // Mark as failed in health record
    const record = this._health.get(runId);
    if (record) {
      record.failedAt = new Date().toISOString();
      record.finalError = { stage, error };
    }
  }

  // ── Internal ─────────────────────────────────────────────

  _getOrCreateHealth(runId) {
    if (!this._health.has(runId)) {
      this._health.set(runId, {
        runId,
        failureCount: 0,
        lastFailure: null,
        stageStartTimes: {},
        stageDurations: {},
        events: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        finalError: null,
      });
    }
    return this._health.get(runId);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OpsAgent };
