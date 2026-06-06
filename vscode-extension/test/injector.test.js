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

// 5) IN-PLACE: re-injecting an UNCHANGED block must be byte-for-byte identical
//    even when a foreign block sits AFTER it (i.e. ours is NOT at end-of-file).
//    The old append-to-end behaviour would have shoved ours past nonstop here,
//    flagging the file as "changed" and triggering the infinite reload war.
{
  const ourBlock = inj.buildBlock('0.0.1', '(function(){/*agentville*/})();');
  const oursThenForeign =
    'console.log("orig");\n\n' + ourBlock + '\n\n' + nonstopBlock + '\n';
  assert.strictEqual(inj.findBlocks(oursThenForeign).length, 1, 'one block in fixture');
  const reinjected = inj.inject(oursThenForeign, '0.0.1', '(function(){/*agentville*/})();');
  assert.strictEqual(reinjected, oursThenForeign, 're-inject of unchanged block is a byte-for-byte no-op');
  // And the symmetric case: foreign block BEFORE ours (ours already at end).
  const foreignThenOurs = 'console.log("orig");\n\n' + nonstopBlock + '\n\n' + ourBlock + '\n';
  assert.strictEqual(
    inj.inject(foreignThenOurs, '0.0.1', '(function(){/*agentville*/})();'),
    foreignThenOurs,
    're-inject no-op with foreign block before ours',
  );
}

// 6) IN-PLACE update: a version/body change rewrites our block where it sits,
//    without moving the foreign block that follows it.
{
  const ourBlock = inj.buildBlock('0.0.1', '(function(){/*agentville*/})();');
  const oursThenForeign =
    'console.log("orig");\n\n' + ourBlock + '\n\n' + nonstopBlock + '\n';
  const bumped = inj.inject(oursThenForeign, '0.0.2', '(function(){/*agentville v2*/})();');
  assert.strictEqual(inj.findBlocks(bumped).length, 1, 'still one block after in-place bump');
  assert(inj.hasValidInjection(bumped, '0.0.2'), 'bumped block valid');
  assert(bumped.includes('agentville v2'), 'new body present');
  assert(!bumped.includes('/*agentville*/'), 'old body replaced');
  // Foreign block untouched AND still positioned after ours (no reorder).
  assert(bumped.includes(nonstopBlock), 'nonstop block byte-identical');
  assert(
    bumped.indexOf('Agentville Launcher') < bumped.indexOf('Claude Code Nonstop'),
    'ordering preserved: ours stays before nonstop',
  );
  // Everything before our block (the original code) is untouched.
  assert(bumped.startsWith('console.log("orig");\n\n'), 'leading content untouched');
}

console.log('✅ injector coexistence + idempotency + in-place: all 6 invariants pass');
