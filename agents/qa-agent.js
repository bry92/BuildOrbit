/**
 * QA Agent
 *
 * Owns the VERIFY stage of the pipeline.
 *
 * Responsibilities:
 *   - Runs automated checks: lint, build, tests, sanity validation
 *   - Produces verification report with pass/fail per check
 *   - Can flag issues back to pipeline state for retry via flagIssue()
 *
 * Interface:
 *   agent.execute({ runId, stage, prompt, previousOutputs, emitChunk })
 *   → { checks[], passed: boolean, errors[], warnings[] }
 *
 * Communication: Reads plan + code from previousOutputs (pipeline state).
 * Issues can be flagged via agent.flagIssue(runId, issue) — stored in memory
 * and queryable by the orchestrator / ops agent.
 * No direct calls to other agents.
 */

const { validateCodeAgainstContract } = require('./intent-gate');
const { validateConstraintsAgainstSchema } = require('../lib/scaffold-schemas');
const { auditExpansions } = require('../lib/soft-expansion');

class QAAgent {
  /**
   * @param {import('pg').Pool} [pool] - Optional PostgreSQL pool for ACL violation logging
   */
  constructor(pool = null) {
    this.stages = ['verify'];
    this._pool = pool; // ACL Phase 1: used for constraint_violations inserts
    // In-memory issue tracker: runId → issue[]
    // Ops agent can query this to decide on escalation
    this._issues = new Map();
  }

  /**
   * Execute the VERIFY stage.
   *
   * @param {object} opts
   * @param {string} opts.runId          - Pipeline run UUID
   * @param {string} opts.stage          - Must be 'verify'
   * @param {string} opts.prompt         - User's original prompt
   * @param {object} opts.previousOutputs - { plan, scaffold, code, save }
   * @param {function} opts.emitChunk    - Streaming chunk emitter
   * @returns {object} { checks[], passed, errors[], warnings[] }
   */
  async execute({ runId, stage, prompt, previousOutputs, emitChunk }) {
    console.log(`[QAAgent] Executing VERIFY for run ${runId.slice(0, 8)}...`);
    return this._runChecks(runId, prompt, previousOutputs, emitChunk);
  }

  // ── Core verification logic ──────────────────────────────

  async _runChecks(runId, prompt, artifacts, emitChunk) {
    const plan = artifacts.plan || {};
    const code = artifacts.code || {};
    const scaffold = artifacts.scaffold || {};

    const checks = [];
    const errors = [];
    const warnings = [];

    // Check 1: Plan completeness
    const hasSubtasks = Array.isArray(plan.subtasks) && plan.subtasks.length > 0;
    checks.push({ name: 'Plan has subtasks', passed: hasSubtasks });
    if (!hasSubtasks) warnings.push('Plan has no subtasks defined');

    // Check 2: Scaffold defines files
    const hasTree = Array.isArray(scaffold.tree) && scaffold.tree.length > 0;
    checks.push({ name: 'Scaffold defines file tree', passed: hasTree });
    if (!hasTree) warnings.push('Scaffold has no file tree');

    // Check 3: Code files generated
    const hasFiles = code.files && typeof code.files === 'object' && Object.keys(code.files).length > 0;
    checks.push({ name: 'Code files generated', passed: hasFiles });
    if (!hasFiles) errors.push('No code files were generated');

    // Check 4: Entry point exists in generated files
    const entryPointExists = hasFiles && code.entryPoint && code.files[code.entryPoint];
    checks.push({ name: 'Entry point file exists', passed: !!entryPointExists });
    if (!entryPointExists) {
      warnings.push(`Entry point "${code.entryPoint || 'unknown'}" not found in generated files`);
    }

    // Intent-class-aware checks: skip backend checks for static_surface
    const constraintContract = artifacts._constraintContract || null;
    const intentClass = constraintContract ? constraintContract.intent_class : null;
    const isStaticSurface = intentClass === 'static_surface';
    const isLightApp = intentClass === 'light_app';
    const codeText = hasFiles ? Object.values(code.files).join('\n') : '';

    // Check 5: Database integration (skip for static_surface and light_app — no DB expected)
    // light_app uses in-memory storage, not PostgreSQL. DB check only for full_product/unknown.
    if (!isStaticSurface && !isLightApp) {
      const hasDatabase = codeText.includes('CREATE TABLE') || codeText.includes('pool.query') || codeText.includes('Pool');
      checks.push({ name: 'Database integration present', passed: hasDatabase });
      if (!hasDatabase) warnings.push('No database queries detected in generated code');
    }

    // Check 6: Error handling present (skip for static_surface — client-side only)
    if (!isStaticSurface) {
      const hasErrorHandling = codeText.includes('catch') || codeText.includes('status(4') || codeText.includes('status(5');
      checks.push({ name: 'Error handling present', passed: hasErrorHandling });
      if (!hasErrorHandling) warnings.push('No error handling patterns detected');
    }

    // Check 7: Express server present (skip for static_surface — no server expected)
    // light_app allows Express but with minimal server — check still applies.
    if (!isStaticSurface) {
      const hasExpress = codeText.includes("require('express')") || codeText.includes('express()');
      checks.push({ name: 'Express.js server detected', passed: hasExpress });
      if (!hasExpress) warnings.push('Express.js not detected in generated code');
    }

    // Check 5a (static_surface only): Verify scaffold metadata matches schema
    if (isStaticSurface && scaffold.constraints) {
      const schemaCheck = validateConstraintsAgainstSchema(scaffold.constraints, intentClass);
      checks.push({ name: 'Scaffold metadata matches schema', passed: schemaCheck.valid });
      if (!schemaCheck.valid) {
        errors.push(`Schema mismatch: ${schemaCheck.violations.join('; ')}`);
      }
    }

    // Check 8: Content accuracy — only runs when product context was provided.
    // Verifies generated content references the actual product, not a hallucination.
    const productContext = artifacts._productContext || null;
    if (productContext) {
      // Parse key terms from the formatted context block
      const contextLines = productContext.split('\n');
      const companyLine = contextLines.find(l => l.startsWith('Company:'));
      const productLine = contextLines.find(l => l.startsWith('Product:'));
      const companyName = companyLine ? companyLine.replace('Company:', '').trim() : null;
      const productName = productLine ? productLine.replace('Product:', '').trim() : null;

      // Build list of expected terms (first significant word of each)
      const expectedTerms = [];
      if (companyName) expectedTerms.push(companyName.split(/\s+/)[0]);
      if (productName) expectedTerms.push(productName.split(/\s+/)[0]);

      const codeTextLower = codeText.toLowerCase();
      const matchedTerms = expectedTerms.filter(t => codeTextLower.includes(t.toLowerCase()));
      const contentIsAccurate = expectedTerms.length === 0 || matchedTerms.length > 0;

      checks.push({ name: 'Content matches product context', passed: contentIsAccurate });
      if (!contentIsAccurate) {
        warnings.push(
          `Generated content may not match the product context. ` +
          `Expected references to: ${expectedTerms.join(', ')}. ` +
          `Possible hallucination — check that copy, pricing, and features match the actual product.`
        );
      }
    }

    // ── Prompt-to-output content verification ──────────────────────────
    // Extracts explicit requirements from the original user prompt (business name,
    // requested sections, specific CTAs) and verifies they appear in the generated code.
    // This catches the critical gap where output is structurally valid but completely
    // ignores what the user actually asked for.
    const promptRequirements = this._extractPromptRequirements(prompt);
    if (promptRequirements && promptRequirements.hasRequirements) {
      const contentMismatches = [];
      const codeTextLower = codeText.toLowerCase();

      // Business/brand name must appear in the output
      if (promptRequirements.businessName) {
        const nameInOutput = codeTextLower.includes(promptRequirements.businessName.toLowerCase());
        if (!nameInOutput) {
          contentMismatches.push(`Business name "${promptRequirements.businessName}" not found in output`);
        }
      }

      // Explicitly requested sections must have matching content
      for (const section of promptRequirements.sections) {
        const sectionFound = section.searchTerms.some(term => codeTextLower.includes(term));
        if (!sectionFound) {
          contentMismatches.push(`Requested "${section.label}" section not found in output`);
        }
      }

      // Specific CTA requirements must be reflected (not generic "Get Started")
      for (const cta of promptRequirements.ctas) {
        const ctaFound = cta.searchTerms.some(term => codeTextLower.includes(term));
        if (!ctaFound) {
          contentMismatches.push(`Requested "${cta.label}" CTA not found — output may use generic CTA instead`);
        }
      }

      const contentPassed = contentMismatches.length === 0;
      checks.push({ name: 'Content matches user prompt', passed: contentPassed });
      if (!contentPassed) {
        const detail = contentMismatches.join('; ');
        errors.push(`Prompt-to-output content mismatch: ${detail}`);
        this.flagIssue(runId, {
          severity: 'error',
          message: `CONTENT_MISMATCH: ${detail}`,
          stage: 'verify',
          run_event: 'CONTENT_MISMATCH_DETECTED',
          requirements: promptRequirements,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Check: No obvious fake/placeholder content (runs always)
    const hasFakePlaceholders = codeText.includes('[PRODUCT_NAME]') ||
      codeText.includes('[COMPANY_NAME]') ||
      codeText.includes('[PRODUCT_DESCRIPTION]') ||
      codeText.includes('[FEATURE_');
    if (hasFakePlaceholders) {
      checks.push({ name: 'No unfilled placeholders in output', passed: false });
      warnings.push('Output contains unfilled placeholders ([PRODUCT_NAME], etc.) — product context was not provided');
    }

    // Check: Intent Gate constraint contract compliance
    // Ensures generated output respects the scope boundaries set at Step 0.
    // (constraintContract already extracted above for intent-class-aware checks)
    if (constraintContract) {
      try {
        // Layer 1: validateCodeAgainstContract (db/server/auth file checks)
        const contractCheck = validateCodeAgainstContract(code, constraintContract);
        const checkName = `Intent Gate compliance (${constraintContract.intent_class})`;
        checks.push({ name: checkName, passed: contractCheck.valid });

        if (!contractCheck.valid) {
          const violationSummary = `CONSTRAINT_VIOLATION_DETECTED: ${contractCheck.violations.join('; ')}`;
          errors.push(violationSummary);
          this.flagIssue(runId, {
            severity: 'error',
            message: violationSummary,
            stage: 'verify',
            run_event: 'CONSTRAINT_VIOLATION_DETECTED',
            intent_class: constraintContract.intent_class,
            violations: contractCheck.violations,
            timestamp: new Date().toISOString(),
          });
        }

        // Layer 2: Explicit prohibited_layers check against file paths
        if (constraintContract.prohibited_layers && constraintContract.prohibited_layers.length > 0 && hasFiles) {
          const fileKeys = Object.keys(code.files);
          const prohibitedViolations = [];

          for (const layer of constraintContract.prohibited_layers) {
            const layerLower = layer.toLowerCase();
            const violatingFiles = fileKeys.filter(f => {
              const fLower = f.toLowerCase();
              return fLower.includes(layerLower) || fLower.startsWith(layerLower + '/');
            });
            if (violatingFiles.length > 0) {
              prohibitedViolations.push(`prohibited layer "${layer}": ${violatingFiles.join(', ')}`);
            }
          }

          const prohibitedPassed = prohibitedViolations.length === 0;
          checks.push({ name: 'No files in prohibited layers', passed: prohibitedPassed });
          if (!prohibitedPassed) {
            const msg = `Files exist in prohibited layers: ${prohibitedViolations.join('; ')}`;
            errors.push(msg);
            this.flagIssue(runId, {
              severity: 'error',
              message: msg,
              stage: 'verify',
              run_event: 'CONSTRAINT_VIOLATION_DETECTED',
              intent_class: constraintContract.intent_class,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Layer 3: allowed_artifacts check — all generated files should match allowed types
        if (constraintContract.allowed_artifacts && constraintContract.allowed_artifacts.length > 0 && hasFiles) {
          const fileKeys = Object.keys(code.files);
          const allowedExts = new Set(constraintContract.allowed_artifacts.map(a => {
            // Normalize: 'html' → '.html', 'server.js' → 'server.js'
            return a.includes('.') ? a : '.' + a;
          }));
          const allowedNames = new Set(constraintContract.allowed_artifacts.filter(a => a.includes('.')));

          const disallowedFiles = fileKeys.filter(f => {
            // Check by name match
            if (allowedNames.has(f)) return false;
            // Check by extension
            const ext = '.' + f.split('.').pop();
            if (allowedExts.has(ext)) return false;
            // Check by path prefix (e.g., 'routes' matches 'routes/api.js')
            for (const allowed of constraintContract.allowed_artifacts) {
              if (f.startsWith(allowed + '/') || f === allowed) return false;
            }
            return true;
          });

          const artifactsPassed = disallowedFiles.length === 0;
          checks.push({ name: 'All files within allowed artifacts', passed: artifactsPassed });
          if (!artifactsPassed) {
            const msg = `Files outside allowed artifacts (${constraintContract.allowed_artifacts.join(', ')}): ${disallowedFiles.join(', ')}`;
            warnings.push(msg);
          }
        }
        // ACL Phase 1: Detect violations and persist to constraint_violations table.
        // Violations are informational — they do NOT cause the run to fail.
        // The enforcement checks above already prevent prohibited files from reaching deploy.
        // Here we log what the system caught (over_scoped) or where it may have been
        // too restrictive (under_scoped) so ACL Phase 2 can learn from the patterns.
        if (this._pool) {
          await this._logAclViolations(runId, code, constraintContract);
        }

        // ── Phase 4: Expansion Audit ──────────────────────────────────────────
        // For soft_expansion contracts, audit whether expansions were actually used.
        // Violations:
        //   unnecessary_expansion (0.6)  — expansion justified but not used in code
        //   expansion_scope_exceeded (0.9) — expansion used beyond stated scope
        // Both violation types are fed to Phase 2 learning (weights update).
        if (constraintContract.intent_class === 'soft_expansion') {
          await this._auditSoftExpansions(runId, plan, code, constraintContract, checks);
        }

      } catch (contractErr) {
        // Non-fatal — constraint check error shouldn't block verify
        console.warn('[QAAgent] Constraint check error (non-fatal):', contractErr.message);
      }
    }

    // ── Check: Interactive elements are wired ──────────────────────────────
    // Count interactive HTML elements (buttons, forms, nav items with handlers)
    // and compare against event listener count in JavaScript files.
    // This catches the #1 product-killing bug: beautiful UI with zero interactivity.
    if (hasFiles) {
      const htmlFiles = Object.entries(code.files).filter(([f]) => f.endsWith('.html'));
      const jsFiles = Object.entries(code.files).filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/') && !f.includes('migrate') && !f.includes('package'));

      let interactiveElementCount = 0;
      let eventHandlerCount = 0;

      // Count interactive elements in HTML
      for (const [, content] of htmlFiles) {
        // Count buttons (but not type="submit" inside forms, those are counted with forms)
        const buttonMatches = content.match(/<button[\s>]/gi) || [];
        interactiveElementCount += buttonMatches.length;

        // Count forms
        const formMatches = content.match(/<form[\s>]/gi) || [];
        interactiveElementCount += formMatches.length;

        // Count nav items that look clickable (a with href="#", onclick, data-tab, etc.)
        const navLinkMatches = content.match(/<a\s[^>]*href=["']#/gi) || [];
        interactiveElementCount += navLinkMatches.length;

        // Count elements with onclick in HTML
        const onclickMatches = content.match(/onclick=/gi) || [];
        eventHandlerCount += onclickMatches.length;
      }

      // Count event listeners in JS files
      for (const [, content] of jsFiles) {
        // addEventListener calls
        const addEventMatches = content.match(/addEventListener\s*\(/gi) || [];
        eventHandlerCount += addEventMatches.length;

        // .onclick = assignments
        const onclickAssignMatches = content.match(/\.onclick\s*=/gi) || [];
        eventHandlerCount += onclickAssignMatches.length;

        // jQuery-style .on( or .click( (if used)
        const jqClickMatches = content.match(/\.on\s*\(['"]click/gi) || [];
        eventHandlerCount += jqClickMatches.length;
        const jqSubmitMatches = content.match(/\.on\s*\(['"]submit/gi) || [];
        eventHandlerCount += jqSubmitMatches.length;

        // fetch() calls indicate API wiring (functional JS)
        const fetchMatches = content.match(/fetch\s*\(/gi) || [];
        eventHandlerCount += Math.min(fetchMatches.length, 3); // Cap at 3 to avoid over-counting
      }

      // Only check if there are interactive elements to wire
      if (interactiveElementCount > 0) {
        // At least 50% of interactive elements should have handlers
        const ratio = eventHandlerCount / interactiveElementCount;
        const interactivityPassed = ratio >= 0.5;

        checks.push({
          name: 'Interactive elements are wired',
          passed: interactivityPassed
        });

        if (!interactivityPassed) {
          const msg = `DEAD_BUTTONS_DETECTED: Found ${interactiveElementCount} interactive elements (buttons, forms, nav) but only ${eventHandlerCount} event handlers in JS. ${Math.round((1 - ratio) * 100)}% of interactive elements have no wired behavior.`;
          warnings.push(msg);
          this.flagIssue(runId, {
            severity: 'warning',
            message: msg,
            stage: 'verify',
            run_event: 'DEAD_BUTTONS_DETECTED',
            interactiveElements: interactiveElementCount,
            eventHandlers: eventHandlerCount,
            ratio: Math.round(ratio * 100) + '%',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // ── Check: Interaction contract fulfilled ──────────────────────────────
    // If SCAFFOLD produced an interaction_contract, verify CODE implements every item.
    // Polymorphic: checks interactions[], routing[], and forms[] based on what the contract has.
    // Non-static builds without any contract items skip this check (nothing to verify).
    const interactionContract = scaffold.interaction_contract;
    if (interactionContract && interactionContract.intent_class !== 'static_surface' && hasFiles) {
      const { interactions = [], routing = [], forms = [] } = interactionContract;
      const totalContractItems = interactions.length + routing.length + forms.length;

      if (totalContractItems > 0) {
        const allCodeLower = Object.values(code.files).join('\n').toLowerCase();
        const htmlContent  = Object.entries(code.files).filter(([f]) => f.endsWith('.html')).map(([, c]) => c).join('\n').toLowerCase();
        const jsContent    = Object.entries(code.files).filter(([f]) => f.endsWith('.js') && !f.includes('server') && !f.includes('routes/') && !f.includes('db/') && !f.includes('middleware/')).map(([, c]) => c).join('\n').toLowerCase();
        const serverContent = Object.entries(code.files).filter(([f]) => f.includes('server') || f.includes('routes/')).map(([, c]) => c).join('\n').toLowerCase();

        let fulfilledItems = 0;

        // Check interactions: need an addEventListener/handler AND some keyword match
        // Also check for CONTRACT: markers as direct evidence of implementation.
        const hasHandlers = jsContent.includes('addeventlistener') || jsContent.includes('.onclick') || jsContent.includes('onclick=') || htmlContent.includes('onclick=');
        for (const ix of interactions) {
          // Strategy 1: CONTRACT marker in code (most reliable — CODE phase tags these)
          const contractId = ix.element.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
          if (allCodeLower.includes('contract:') && allCodeLower.includes(contractId)) {
            fulfilledItems++;
            continue;
          }

          // Strategy 2: keyword matching (original approach, enhanced)
          const stopWords = new Set(['button', 'input', 'form', 'the', 'and', 'or', 'a', 'an', 'primary', 'per', 'each', 'all', 'every', 'any']);
          const elementKeywords = ix.element.toLowerCase().split(/[\s\/,\(\)]+/).filter(w => w.length > 3 && !stopWords.has(w));
          const behaviorKeywords = ix.behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4 && !stopWords.has(w)).slice(0, 5);

          // Also extract state variable names as keywords (strong signal of implementation)
          const stateKeywords = Array.isArray(ix.state) ? ix.state.map(s => s.toLowerCase()).filter(s => s.length > 3) : [];

          const combinedKeywords = [...elementKeywords, ...behaviorKeywords, ...stateKeywords];
          const keywordHit = combinedKeywords.some(kw => allCodeLower.includes(kw));

          if (hasHandlers && keywordHit) {
            fulfilledItems++;
          } else if (hasHandlers && interactions.length === 1) {
            // Single interaction: if handlers exist and JS is non-trivial, count it
            fulfilledItems += jsContent.split('addeventlistener').length > 2 ? 1 : 0;
          }
        }

        // Check routing: paths or their semantic equivalents must appear in code.
        // Routing contracts may use ISE-derived view paths (/sign-up, /dashboard)
        // while CODE generates API routes (/api/auth/signup, /api/tasks).
        // We check: (1) exact path in server code, (2) path segments in all code,
        // (3) component/behavior keywords in all code, (4) CONTRACT markers.
        for (const route of routing) {
          const basePath = route.path.replace('/:id', '').replace(/\/$/, '');
          let routeFulfilled = false;

          // Strategy 1: exact path in server code (original check)
          if (basePath && serverContent.includes(basePath.toLowerCase())) {
            routeFulfilled = true;
          } else if (basePath === '' || basePath === '/') {
            if (serverContent.includes('app.get') || serverContent.includes('router.get')) routeFulfilled = true;
          }

          // Strategy 2: path segments as keywords in ALL code (catches /sign-up → "signup" in server, "sign" in frontend)
          if (!routeFulfilled && basePath) {
            const pathSegments = basePath.replace(/^\//, '').split('-').filter(s => s.length > 2);
            // Also try joined form: /sign-up → "signup"
            const joinedPath = pathSegments.join('');
            const pathKeywords = [...pathSegments, joinedPath].filter(k => k.length > 2);
            routeFulfilled = pathKeywords.some(kw => allCodeLower.includes(kw));
          }

          // Strategy 3: component name or behavior keywords in all code
          if (!routeFulfilled && route.component) {
            const componentLower = route.component.toLowerCase().replace(/\s+/g, '');
            const componentWords = route.component.toLowerCase().split(/[\s-]+/).filter(w => w.length > 3);
            routeFulfilled = allCodeLower.includes(componentLower) ||
              componentWords.some(w => allCodeLower.includes(w));
          }

          // Strategy 4: CONTRACT marker in code
          if (!routeFulfilled) {
            const markerPath = basePath || '/';
            routeFulfilled = allCodeLower.includes(`contract:`) && allCodeLower.includes(markerPath.toLowerCase().replace(/[^a-z0-9]/g, ''));
          }

          if (routeFulfilled) fulfilledItems++;
        }

        // Check forms: form IDs, field names, or CONTRACT markers must appear in code
        for (const f of forms) {
          // Strategy 1: CONTRACT marker
          const formContractId = f.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (allCodeLower.includes('contract:') && allCodeLower.includes(formContractId)) {
            fulfilledItems++;
            continue;
          }

          // Strategy 2: keyword matching in HTML + JS (enhanced)
          const formIdParts = f.id.replace(/-/g, ' ').split(' ').filter(p => p.length > 3);
          const fieldKeywords = Array.isArray(f.fields) ? f.fields.flatMap(fld => fld.split(/[\s,]+/)).filter(w => w.length > 3) : [];
          // Also check submit_behavior for action keywords (POST, fetch, validate, etc.)
          const behaviorKeywords = f.submit_behavior ? f.submit_behavior.toLowerCase().split(/[\s\/,\.]+/).filter(w => w.length > 4).slice(0, 3) : [];
          const allFormKeywords = [...formIdParts, ...fieldKeywords, ...behaviorKeywords];

          const formHit = allFormKeywords.some(kw => htmlContent.includes(kw.toLowerCase()) || allCodeLower.includes(kw.toLowerCase()));
          const hasFormHandler = jsContent.includes('submit') || jsContent.includes('preventdefault') || allCodeLower.includes('onsubmit');
          if (formHit && hasFormHandler) fulfilledItems++;
        }

        const ratio = fulfilledItems / totalContractItems;
        const contractPassed = ratio >= 0.5; // ≥50% fulfilled

        checks.push({
          name: 'Interaction contract fulfilled',
          passed: contractPassed,
        });

        if (!contractPassed) {
          const msg = `INTERACTION_CONTRACT_UNFULFILLED: ${fulfilledItems}/${totalContractItems} contract items implemented (${Math.round(ratio * 100)}%). Listed interactions, routes, or forms may be missing or unimplemented.`;
          warnings.push(msg);
          this.flagIssue(runId, {
            severity: 'warning',
            message: msg,
            stage: 'verify',
            run_event: 'INTERACTION_CONTRACT_UNFULFILLED',
            contractItems: totalContractItems,
            fulfilledItems,
            ratio: Math.round(ratio * 100) + '%',
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Stream results
    emitChunk('## Verification Results\n\n');
    await this._delay(400);

    for (const check of checks) {
      const icon = check.passed ? '\u2713' : '\u2717';
      emitChunk(`${icon} ${check.name}\n`);
      await this._delay(350);
    }

    const passedCount = checks.filter(c => c.passed).length;
    const total = checks.length;
    // passed = ALL checks green. No partial pass.
    const passed = passedCount === total;

    await this._delay(300);
    if (passed) {
      emitChunk(`\n**Result: ALL CHECKS PASSED** \u2014 ${passedCount}/${total} checks passed.`);
    } else if (passedCount === 0) {
      emitChunk(`\n**Result: FAILED** \u2014 0/${total} checks passed.`);
    } else {
      emitChunk(`\n**Result: PARTIAL \u2014 ${passedCount}/${total} checks passed.** Some checks need attention.`);
    }

    if (warnings.length > 0) {
      emitChunk(`\n**Warnings:** ${warnings.join(', ')}`);
    }
    if (errors.length > 0) {
      emitChunk(`\n**Errors:** ${errors.join(', ')}`);
    }
    emitChunk('\n');

    // Flag any errors as issues in the issue tracker
    if (errors.length > 0) {
      for (const err of errors) {
        this.flagIssue(runId, { severity: 'error', message: err, stage: 'verify', timestamp: new Date().toISOString() });
      }
    }

    return { checks, passed, errors, warnings };
  }

  // ── Issue tracking ───────────────────────────────────────

  /**
   * Flag an issue back to pipeline state.
   * Stored in memory — queryable by ops agent for escalation decisions.
   *
   * @param {string} runId  - Pipeline run UUID
   * @param {object} issue  - { severity, message, stage, timestamp }
   */
  flagIssue(runId, issue) {
    const issues = this._issues.get(runId) || [];
    issues.push(issue);
    this._issues.set(runId, issues);
    console.log(`[QAAgent] Issue flagged for ${runId.slice(0, 8)}...: [${issue.severity}] ${issue.message}`);
  }

  /**
   * Get all issues flagged for a run.
   *
   * @param {string} runId
   * @returns {object[]}
   */
  getIssues(runId) {
    return this._issues.get(runId) || [];
  }

  /**
   * Clear issues for a run (called on successful retry).
   */
  clearIssues(runId) {
    this._issues.delete(runId);
  }

  // ── ACL Phase 1: Violation Logging ───────────────────────

  /**
   * Detect constraint violations from generated artifacts and persist to DB.
   *
   * Violations are INFORMATIONAL — they never fail the run.
   * The enforcement layer (orchestrator scaffold/code gates, VERIFY contract checks)
   * already prevents prohibited artifacts from shipping. This method captures what
   * the enforcement layer caught so ACL Phase 2 can learn from patterns.
   *
   * Violation types:
   *   over_scoped  — output includes something the contract prohibits
   *   under_scoped — output is missing something that would have benefited the task
   *                  (detected only for full_product where all layers are expected)
   *
   * @param {string} runId           - Pipeline run UUID
   * @param {object} code            - CODE stage output ({ files: { [path]: content } })
   * @param {object} contract        - Constraint Contract from Intent Gate
   */
  async _logAclViolations(runId, code, contract) {
    if (!contract || contract.intent_class === 'full_product') {
      // full_product has no prohibited layers — nothing to flag as over_scoped.
      // under_scoped for full_product would require semantic analysis; skip for Phase 1.
      return;
    }

    const fileKeys = Object.keys((code && code.files) ? code.files : {});
    const violations = [];

    // ── Over-scoped detection ──────────────────────────────────────────────
    // Check each constrained layer: if constraint says false but files exist → over_scoped

    // server layer
    if (contract.constraints.server === false) {
      const serverFiles = fileKeys.filter(f =>
        f === 'server.js' || f.startsWith('routes/') || f.startsWith('middleware/')
      );
      if (serverFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'server',
          severity: this._calcSeverity(serverFiles.length),
        });
      }
    }

    // db layer
    if (contract.constraints.db === false) {
      const dbFiles = fileKeys.filter(f =>
        f.includes('db/') || f.includes('migrations/') ||
        f === 'migrate.js' || f.endsWith('queries.js') || f.endsWith('pool.js')
      );
      if (dbFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'db',
          severity: this._calcSeverity(dbFiles.length),
        });
      }
    }

    // auth layer
    if (contract.constraints.auth === false) {
      const authFiles = fileKeys.filter(f =>
        f.toLowerCase().includes('auth') || f.includes('jwt') || f.includes('bcrypt')
      );
      if (authFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'auth',
          severity: this._calcSeverity(authFiles.length),
        });
      }
    }

    // api layer
    if (contract.constraints.api === false) {
      const apiFiles = fileKeys.filter(f =>
        f.startsWith('routes/') || f.startsWith('api/') ||
        f.includes('/api.js') || f.includes('/routes.js')
      );
      if (apiFiles.length > 0) {
        violations.push({
          violation_type: 'over_scoped',
          violated_layer: 'api',
          severity: this._calcSeverity(apiFiles.length),
        });
      }
    }

    if (violations.length === 0) {
      // Clean run — no violations for this contract class
      return;
    }

    // Persist each violation (non-fatal — wrapped in try/catch)
    try {
      for (const v of violations) {
        await this._pool.query(
          `INSERT INTO constraint_violations (run_id, violation_type, violated_layer, severity)
           VALUES ($1, $2, $3, $4)`,
          [runId, v.violation_type, v.violated_layer, v.severity]
        );
        console.log(
          `[QAAgent] ACL violation logged: ${v.violation_type} | layer=${v.violated_layer} | severity=${v.severity} | run=${runId.slice(0, 8)}`
        );
      }
    } catch (dbErr) {
      // Non-fatal — ACL logging must never block the verify result
      console.warn('[QAAgent] ACL violation logging failed (non-fatal):', dbErr.message);
    }
  }

  /**
   * Compute severity (0–1) from the number of violating files.
   * 1–3 files → minor (0.3), 4–7 → moderate (0.6), 8+ → critical (0.9)
   *
   * @param {number} fileCount
   * @returns {number}
   */
  _calcSeverity(fileCount) {
    if (fileCount <= 3) return 0.3;
    if (fileCount <= 7) return 0.6;
    return 0.9;
  }

  // ── Phase 4: Soft Expansion Audit ────────────────────────

  /**
   * Audit soft expansion usage for a soft_expansion contract.
   *
   * Checks each authorized soft_expansion capability:
   *   - Used but not justified → should have been caught by SCAFFOLD (log only)
   *   - Justified but not used → unnecessary_expansion violation (severity 0.6)
   *   - Used beyond stated scope → expansion_scope_exceeded violation (severity 0.9)
   *
   * Violations are persisted to constraint_violations for Phase 2 learning.
   * Also logged as run events via flagIssue() for orchestrator observability.
   *
   * @param {string} runId
   * @param {object} plan              - PLAN stage output (may have expansion_justifications)
   * @param {object} code              - CODE stage output ({ files: {...} })
   * @param {object} contract          - Soft expansion constraint contract
   * @param {Array}  checks            - Mutated: expansion audit results added here
   */
  async _auditSoftExpansions(runId, plan, code, contract, checks) {
    try {
      const { audits, violations } = auditExpansions(plan, code, contract);

      if (audits.length === 0) return;  // No soft expansion capabilities to audit

      // Add audit results as VERIFY checks
      for (const audit of audits) {
        const { capability, justified, used, scopeExceeded } = audit;

        let checkName, passed;
        if (scopeExceeded) {
          checkName = `Soft expansion "${capability}" within scope`;
          passed = false;
        } else if (justified && !used) {
          checkName = `Soft expansion "${capability}" actually used`;
          passed = false;
        } else if (used && !justified) {
          // Should have been caught at SCAFFOLD — log as warning
          checkName = `Soft expansion "${capability}" justified by PLAN`;
          passed = false;
        } else {
          // Clean path: either used+justified or not used+not justified
          checkName = `Soft expansion "${capability}" (${used ? 'used + justified' : 'not needed'})`;
          passed = true;
        }
        checks.push({ name: checkName, passed });
      }

      // Persist violations to constraint_violations for Phase 2 learning
      if (violations.length > 0 && this._pool) {
        try {
          for (const v of violations) {
            await this._pool.query(
              `INSERT INTO constraint_violations (run_id, violation_type, violated_layer, severity)
               VALUES ($1, $2, $3, $4)`,
              [runId, v.type, v.capability, v.severity]
            );
            console.log(
              `[QAAgent] Phase 4 expansion violation logged: ${v.type} | capability=${v.capability} | severity=${v.severity} | run=${runId.slice(0, 8)}`
            );
            // Flag as issue for orchestrator observability
            this.flagIssue(runId, {
              severity:  v.severity >= 0.9 ? 'error' : 'warning',
              message:   v.message,
              stage:     'verify',
              run_event: v.type === 'expansion_scope_exceeded' ? 'EXPANSION_SCOPE_EXCEEDED' : 'EXPANSION_UNNECESSARY',
              capability: v.capability,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (dbErr) {
          // Non-fatal — logging must never block verify
          console.warn('[QAAgent] Phase 4 expansion violation logging failed (non-fatal):', dbErr.message);
        }
      }

      const cleanAudits  = audits.filter(a => !a.scopeExceeded && !(a.justified && !a.used));
      const violAudits   = audits.filter(a => a.scopeExceeded || (a.justified && !a.used));
      console.log(
        `[QAAgent] Phase 4 expansion audit: ${cleanAudits.length} clean, ${violAudits.length} violation(s) | run=${runId.slice(0, 8)}`
      );

    } catch (auditErr) {
      // Non-fatal — expansion audit must never block pipeline completion
      console.warn('[QAAgent] Phase 4 expansion audit failed (non-fatal):', auditErr.message);
    }
  }

  // ── Prompt Requirement Extraction ─────────────────────────

  /**
   * Extracts verifiable content requirements from the original user prompt.
   *
   * Returns structured requirements:
   *   - businessName:  Proper noun from "called X" / "named X" / quoted name
   *   - sections[]:    Explicitly requested sections (pricing, testimonials, etc.)
   *   - ctas[]:        Specific CTA types requested (booking, signup, etc.)
   *   - hasRequirements: true if any extractable requirements found
   *
   * Deterministic — no LLM calls. Pattern-matching only.
   *
   * @param {string} prompt - Original user prompt
   * @returns {object|null}
   */
  _extractPromptRequirements(prompt) {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) return null;

    const promptLower = prompt.toLowerCase();
    const requirements = {
      businessName: null,
      sections: [],
      ctas: [],
      hasRequirements: false,
    };

    // ── Extract business/brand name ──────────────────────────
    // Pattern 1: "called X" or "named X" (most explicit)
    // Subsequent words must start with uppercase to avoid capturing "FreshPaws with pricing"
    const calledMatch = prompt.match(/(?:called|named)\s+["']?([A-Z][A-Za-z0-9]+(?:[\s-][A-Z][A-Za-z0-9]+)*)["']?/);
    if (calledMatch) {
      requirements.businessName = calledMatch[1].trim();
    } else {
      // Pattern 2: Quoted proper name: "FreshPaws" or 'FreshPaws'
      const quotedMatch = prompt.match(/["']([A-Z][A-Za-z0-9]+(?:[\s-][A-Za-z0-9]+)*)["']/);
      if (quotedMatch) {
        const candidate = quotedMatch[1].trim();
        const skipWords = new Set(['Build', 'Create', 'Make', 'Design', 'Landing', 'Page', 'Website', 'App', 'The', 'Home', 'About']);
        if (!skipWords.has(candidate)) {
          requirements.businessName = candidate;
        }
      }
    }

    // ── Extract requested sections ───────────────────────────
    // Each entry: triggers (what we look for in the prompt) → searchTerms (what we look for in the output)
    const SECTION_MAP = [
      {
        label: 'pricing',
        triggers: ['pricing', 'price list', 'pricing section', 'pricing table', 'pricing page'],
        searchTerms: ['pricing', 'price', 'per month', '/mo', '/year', 'plan'],
      },
      {
        label: 'testimonials',
        triggers: ['testimonial', 'testimonials', 'customer reviews', 'reviews section', 'social proof'],
        searchTerms: ['testimonial', 'review', 'customer', 'said'],
      },
      {
        label: 'features',
        triggers: ['features', 'feature section', 'key features', 'feature list'],
        searchTerms: ['feature', 'benefit', 'capability'],
      },
      {
        label: 'about',
        triggers: ['about us', 'about section', 'our story', 'about page'],
        searchTerms: ['about', 'our story', 'who we are', 'our mission'],
      },
      {
        label: 'contact',
        triggers: ['contact form', 'contact section', 'contact us', 'contact page', 'contact info'],
        searchTerms: ['contact', 'email', 'phone', 'address', 'reach us', 'get in touch'],
      },
      {
        label: 'FAQ',
        triggers: ['faq', 'frequently asked', 'questions section'],
        searchTerms: ['faq', 'frequently', 'question', 'answer'],
      },
      {
        label: 'team',
        triggers: ['team section', 'our team', 'meet the team', 'team members'],
        searchTerms: ['team', 'member', 'founder', 'staff'],
      },
      {
        label: 'gallery',
        triggers: ['gallery', 'portfolio', 'showcase', 'photo gallery'],
        searchTerms: ['gallery', 'portfolio', 'showcase'],
      },
      {
        label: 'services',
        triggers: ['services section', 'our services', 'services page', 'service list'],
        searchTerms: ['service', 'offering', 'what we do', 'we offer'],
      },
    ];

    for (const section of SECTION_MAP) {
      if (section.triggers.some(t => promptLower.includes(t))) {
        requirements.sections.push(section);
      }
    }

    // ── Extract CTA requirements ─────────────────────────────
    // Only matches explicit CTA/button requests (not just topic mentions)
    const CTA_MAP = [
      {
        label: 'booking',
        triggers: ['booking cta', 'booking button', 'book now', 'booking call to action', 'book appointment', 'book a'],
        searchTerms: ['book', 'booking', 'reserve', 'appointment', 'schedule'],
      },
      {
        label: 'sign up',
        triggers: ['signup cta', 'sign up cta', 'signup button', 'sign up button', 'registration cta'],
        searchTerms: ['sign up', 'signup', 'register', 'create account', 'join'],
      },
      {
        label: 'subscribe',
        triggers: ['subscribe cta', 'subscribe button', 'subscription cta', 'newsletter signup'],
        searchTerms: ['subscribe', 'subscription', 'newsletter'],
      },
      {
        label: 'download',
        triggers: ['download cta', 'download button', 'download call to action'],
        searchTerms: ['download', 'get the app', 'install'],
      },
      {
        label: 'purchase',
        triggers: ['buy cta', 'purchase cta', 'buy now button', 'buy button', 'purchase button', 'shop now'],
        searchTerms: ['buy', 'purchase', 'order', 'add to cart', 'shop now'],
      },
      {
        label: 'demo',
        triggers: ['demo cta', 'demo button', 'free trial cta', 'try it cta', 'start trial'],
        searchTerms: ['demo', 'free trial', 'try', 'start trial'],
      },
      {
        label: 'contact',
        triggers: ['contact cta', 'contact button', 'get in touch cta', 'reach out cta', 'inquire cta'],
        searchTerms: ['contact', 'get in touch', 'reach out', 'inquire', 'request'],
      },
    ];

    for (const cta of CTA_MAP) {
      if (cta.triggers.some(t => promptLower.includes(t))) {
        requirements.ctas.push(cta);
      }
    }

    requirements.hasRequirements = !!(
      requirements.businessName ||
      requirements.sections.length > 0 ||
      requirements.ctas.length > 0
    );

    return requirements;
  }

  // ── Helpers ──────────────────────────────────────────────

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { QAAgent };
