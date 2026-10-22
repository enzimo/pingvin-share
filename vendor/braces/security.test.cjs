const assert = require('node:assert/strict');
const test = require('node:test');
const braces = require('../../docs/node_modules/braces');

test('ordinary brace patterns retain expansion and compilation', () => {
  assert.deepEqual(braces.expand('file-{a,b}.txt'), ['file-a.txt', 'file-b.txt']);
  assert.equal(braces.compile('file-{a,b}.txt'), 'file-(a|b).txt');
});

test('all public recursive entry points reject deeply nested patterns', () => {
  const pattern = '{'.repeat(6000) + 'x' + '}'.repeat(6000);
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    assert.throws(() => braces[method](pattern), /security complexity limit/);
  }
  const ast = { nodes: [] }; ast.nodes.push(ast);
  assert.throws(() => braces.compile(ast), /security complexity limit/);
});
