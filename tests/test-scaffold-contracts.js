const { validateScaffoldManifest, validateCodeAgainstScaffold, ContractValidationError, buildStageInput } = require('../stage-contracts');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

const validScaffold = {
  tree: [],
  techStack: ['express', 'pg'],
  summary: 'test',
  files: ['server.js', 'package.json', 'routes/api.js'],
  structure: { '/': ['server.js', 'package.json'], '/routes': ['api.js'] },
  constraints: { hasServer: true, hasFrontend: false, entry: 'server.js', techStack: ['express', 'pg'] }
};

console.log('\n=== Scaffold Manifest Validation ===');

test('Valid scaffold manifest passes', () => {
  validateScaffoldManifest(validScaffold);
});

test('Empty files[] is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, files: [] });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Missing constraints is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: null });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Missing entry in constraints is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: { ...validScaffold.constraints, entry: '' } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('Entry point not in files list is rejected', () => {
  try {
    validateScaffoldManifest({ ...validScaffold, constraints: { ...validScaffold.constraints, entry: 'nonexistent.js' } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.violations.some(v => v.includes('not found')), 'should mention entry not found');
  }
});

console.log('\n=== CODE Input Hard Gate ===');

test('CODE blocked without scaffold', () => {
  try {
    buildStageInput('code', 'test', { plan: { subtasks: [] } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations[0].includes('SCAFFOLD manifest missing'), 'wrong message');
  }
});

test('CODE blocked with empty scaffold.files', () => {
  try {
    buildStageInput('code', 'test', { plan: {}, scaffold: { files: [] } });
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
  }
});

test('CODE passes with valid scaffold', () => {
  buildStageInput('code', 'test', { plan: {}, scaffold: validScaffold });
});

console.log('\n=== Post-CODE Validation Against Scaffold ===');

test('All files present = valid', () => {
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'routes/api.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid, 'should be valid');
  assert(result.missingFiles.length === 0, 'no missing files');
});

test('Missing file detected', () => {
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid === false, 'should be invalid');
  assert(result.missingFiles.includes('routes/api.js'), 'should report missing file');
});

test('Frontend path normalization: public/x matches x', () => {
  const scaffold = { ...validScaffold, files: ['server.js', 'public/index.html', 'public/styles.css'] };
  const codeOutput = { files: { 'server.js': 'code', 'index.html': 'code', 'styles.css': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.valid, 'should be valid with normalized paths — missing: ' + result.missingFiles.join(','));
});

test('Reverse normalization: x matches public/x', () => {
  const scaffold = { ...validScaffold, files: ['server.js', 'index.html', 'styles.css'] };
  const codeOutput = { files: { 'server.js': 'code', 'public/index.html': 'code', 'public/styles.css': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.valid, 'should be valid with reverse normalized paths — missing: ' + result.missingFiles.join(','));
});

test('Entry point missing from CODE output detected', () => {
  const codeOutput = { files: { 'package.json': 'code', 'routes/api.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, validScaffold);
  assert(result.valid === false, 'should be invalid');
  assert(result.errors.some(e => e.includes('Entry point')), 'should mention entry point');
});

test('Entry point public/index.html normalizes to index.html in CODE output', () => {
  const scaffold = {
    ...validScaffold,
    files: ['server.js', 'package.json', 'public/index.html', 'public/styles.css', 'public/app.js'],
    constraints: { ...validScaffold.constraints, entry: 'public/index.html' }
  };
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'index.html': 'code', 'styles.css': 'code', 'app.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(!result.errors.some(e => e.includes('Entry point')), 'should NOT report entry point missing when public/index.html matches index.html — errors: ' + result.errors.join('; '));
});

test('PRODUCT_SYSTEM scaffold with migrate.js and db/queries.js detects missing files', () => {
  const scaffold = {
    ...validScaffold,
    files: ['server.js', 'package.json', 'migrate.js', 'routes/api.js', 'db/queries.js', 'migrations/001_schema.js', 'public/index.html', 'public/styles.css', 'public/app.js'],
    constraints: { ...validScaffold.constraints, entry: 'public/index.html' }
  };
  const codeOutput = { files: { 'server.js': 'code', 'package.json': 'code', 'routes/api.js': 'code', 'migrations/001_schema.js': 'code', 'index.html': 'code', 'styles.css': 'code', 'app.js': 'code' }, entryPoint: 'server.js' };
  const result = validateCodeAgainstScaffold(codeOutput, scaffold);
  assert(result.missingFiles.includes('migrate.js'), 'should detect missing migrate.js');
  assert(result.missingFiles.includes('db/queries.js'), 'should detect missing db/queries.js');
  assert(!result.errors.some(e => e.includes('Entry point')), 'should NOT report entry point missing — errors: ' + result.errors.join('; '));
});

console.log('\n=== Builder Agent Scaffold Contract Block ===');

test('Builder agent generates scaffold contract block', () => {
  const { BuilderAgent } = require('../agents/builder-agent');
  const agent = new BuilderAgent();

  const block = agent._buildScaffoldContractBlock(
    ['server.js', 'package.json'],
    { hasServer: true, hasFrontend: true, entry: 'server.js', techStack: ['express', 'pg'] },
    { '/': ['server.js', 'package.json'] }
  );
  assert(block.includes('SCAFFOLD CONTRACT'), 'should contain contract header');
  assert(block.includes('server.js'), 'should list files');
  assert(block.includes('DO NOT DEVIATE'), 'should be binding language');
  assert(block.includes('Entry point: server.js'), 'should mention entry');
});

test('Builder agent scaffold output includes manifest fields', async () => {
  const { BuilderAgent } = require('../agents/builder-agent');
  const agent = new BuilderAgent();

  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  const plan = { estimatedComplexity: 'medium' };

  const result = await agent._executeScaffold('test app', plan, emitChunk);

  // Verify new manifest fields exist
  assert(Array.isArray(result.files), 'should have files array');
  assert(result.files.length > 0, 'files should not be empty');
  assert(typeof result.structure === 'object', 'should have structure object');
  assert(Object.keys(result.structure).length > 0, 'structure should not be empty');
  assert(typeof result.constraints === 'object', 'should have constraints object');
  assert(result.constraints.hasServer === true, 'should detect server');
  assert(result.constraints.entry === 'server.js', 'entry should be server.js');
  assert(Array.isArray(result.constraints.techStack), 'techStack should be array');

  // Verify backward-compatible fields still exist
  assert(Array.isArray(result.tree), 'should have tree array');
  assert(Array.isArray(result.techStack), 'should have techStack array');
  assert(typeof result.summary === 'string', 'should have summary string');

  // Verify manifest passes deep validation
  validateScaffoldManifest(result);
});

console.log('\n=== PRODUCT_SYSTEM (full_product) Schema Validation ===');

// Full valid full_product scaffold — includes all required_files
const validFullProduct = {
  tree: [],
  techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'],
  summary: 'SaaS app',
  files: [
    'server.js', 'package.json', '.env.example', 'migrate.js',
    'routes/api.js', 'routes/auth.js',
    'middleware/auth.js', 'middleware/error.js',
    'models/index.js',
    'db/queries.js', 'db/pool.js',
    'migrations/001_schema.js',
    'public/index.html', 'public/styles.css', 'public/app.js',
  ],
  structure: {
    '/': ['server.js', 'package.json', '.env.example', 'migrate.js'],
    '/routes': ['api.js', 'auth.js'],
    '/middleware': ['auth.js', 'error.js'],
    '/models': ['index.js'],
    '/db': ['queries.js', 'pool.js'],
    '/migrations': ['001_schema.js'],
    '/public': ['index.html', 'styles.css', 'app.js'],
  },
  constraints: {
    hasServer: true,
    hasFrontend: true,
    hasAuth: true,
    hasDb: true,
    entry: 'server.js',
    techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'dotenv'],
  },
};

test('PRODUCT_SYSTEM scaffold with all required files passes', () => {
  validateScaffoldManifest(validFullProduct, 'full_product');
});

test('PRODUCT_SYSTEM scaffold missing server.js is rejected', () => {
  // Remove server.js — violates both entry-point check AND required_files
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== 'server.js'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type: ' + e.name);
  }
});

test('PRODUCT_SYSTEM scaffold missing package.json is rejected', () => {
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== 'package.json'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations.some(v => v.includes('package.json')), 'should mention package.json');
  }
});

test('PRODUCT_SYSTEM scaffold missing .env.example is rejected', () => {
  const scaffold = {
    ...validFullProduct,
    files: validFullProduct.files.filter(f => f !== '.env.example'),
  };
  try {
    validateScaffoldManifest(scaffold, 'full_product');
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.name === 'ContractValidationError', 'wrong error type');
    assert(e.violations.some(v => v.includes('.env.example')), 'should mention .env.example');
  }
});

test('full_product schema has required_files defined', () => {
  const { SCAFFOLD_SCHEMAS } = require('../lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(Array.isArray(schema.required_files), 'required_files should be array');
  assert(schema.required_files.includes('server.js'), 'should require server.js');
  assert(schema.required_files.includes('package.json'), 'should require package.json');
  assert(schema.required_files.includes('.env.example'), 'should require .env.example');
});

test('full_product schema directories include models', () => {
  const { SCAFFOLD_SCHEMAS } = require('../lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(schema.directories.includes('models'), 'models should be in directories');
});

test('full_product schema techStack includes dotenv', () => {
  const { SCAFFOLD_SCHEMAS } = require('../lib/scaffold-schemas');
  const schema = SCAFFOLD_SCHEMAS.full_product;
  assert(schema.techStack.includes('dotenv'), 'dotenv should be in techStack');
});

test('Builder agent high-complexity scaffold includes required PRODUCT_SYSTEM files', async () => {
  const { BuilderAgent } = require('../agents/builder-agent');
  const agent = new BuilderAgent();

  const chunks = [];
  const emitChunk = (c) => chunks.push(c);
  // Force high complexity to get the full_product tree
  const plan = { estimatedComplexity: 'high' };

  const result = await agent._executeScaffold('SaaS app with user auth and dashboard', plan, emitChunk);

  assert(result.files.includes('server.js'), 'missing server.js');
  assert(result.files.includes('package.json'), 'missing package.json');
  assert(result.files.includes('.env.example'), 'missing .env.example');
  assert(result.files.includes('middleware/auth.js'), 'missing middleware/auth.js');
  assert(result.files.includes('middleware/error.js'), 'missing middleware/error.js');
  assert(result.files.includes('models/index.js'), 'missing models/index.js');
  assert(result.files.includes('migrations/001_schema.js'), 'missing migrations/001_schema.js');
  assert(result.constraints.techStack.includes('dotenv'), 'techStack missing dotenv');
  // Validate it passes the full manifest validation as a full_product schema
  validateScaffoldManifest(result, 'full_product');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
