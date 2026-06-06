'use strict';

// Pure-logic invariants for the marker-scoped injector. Run: node test/injector.test.js
const assert = require('assert');
const inj = require('../src/injector.js');

// Simulate Claude's webview file already carrying a NONSTOP block.
const nonstopBlock =
  '// >>> Claude Code Nonstop (injected) v0.2.3 >>>\n' +
  'window.__NONSTOP_CONFIG__ = {};\n(function(){/*nonstop*/})();\n' +
  '// <<< Claude Code Nonstop (injected) <<<';
const base = 'console.log("claude original");\n\n' + nonstopBlock + '\n';

// 1) Inject ours — must keep nonstop intact, exactly one of ours.
const v1 = inj.inject(base, '0.0.1', '(function(){/*agentville*/})();');
assert(v1.includes('Claude Code Nonstop (injected)'), 'nonstop block survived');
assert(inj.hasValidInjection(v1, '0.0.1'), 'our block valid');
assert.strictEqual(inj.findBlocks(v1).length, 1, 'exactly one agentville block');

// 2) Idempotent — re-injecting same version+body is a byte-for-byte no-op.
assert.strictEqual(inj.inject(v1, '0.0.1', '(function(){/*agentville*/})();'), v1, 'idempotent re-inject');

// 3) Version/body bump replaces our block (no dupes), nonstop still intact.
const v3 = inj.inject(v1, '0.0.2', '(function(){/*agentville v2*/})();');
assert.strictEqual(inj.findBlocks(v3).length, 1, 'still one block after bump');
assert(inj.hasValidInjection(v3, '0.0.2'), 'bumped block valid');
assert(v3.includes('Claude Code Nonstop (injected)'), 'nonstop survived bump');

// 4) stripAllBlocks removes ONLY ours — nonstop + original code remain.
const stripped = inj.stripAllBlocks(v3);
assert.strictEqual(inj.findBlocks(stripped).length, 0, 'our blocks gone');
assert(stripped.includes('Claude Code Nonstop (injected)'), 'nonstop NOT stripped');
assert(stripped.includes('claude original'), 'original code intact');

console.log('✅ injector coexistence + idempotency: all 4 invariants pass');
