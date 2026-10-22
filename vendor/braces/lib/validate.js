'use strict';

// Bound parser/AST recursion before entering upstream's recursive operations.
module.exports = (input) => {
  if (typeof input === 'string') {
    if (input.length > 65536 || (input.match(/[({\[]/g) || []).length > 128) {
      throw new RangeError('Brace pattern exceeds the security complexity limit');
    }
    return;
  }
  const queue = [[input, 0]];
  const visited = new Set();
  let count = 0;
  while (queue.length) {
    const [node, depth] = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (depth > 128 || ++count > 10000 || visited.has(node)) {
      throw new RangeError('Brace AST exceeds the security complexity limit');
    }
    visited.add(node);
    if (Array.isArray(node.nodes)) {
      for (const child of node.nodes) queue.push([child, depth + 1]);
    }
  }
};
