# Local braces security patch

This directory vendors MIT-licensed `micromatch/braces` 3.0.3 because the current
npm release has an unpatched stack-exhaustion advisory. Version
`3.0.4-enzimo.1` identifies this local patch, not an upstream release.

The entry points bound pattern length, opening delimiters, AST depth, AST size,
and cycles before calling the original recursive parser/compiler. Very complex
documentation-build glob patterns now fail with a controlled `RangeError`.
Ordinary brace patterns retain the upstream implementation. The documentation
package uses this copy through an npm override; the application image does not
include documentation tooling.

Run `node --test vendor/braces/security.test.cjs` from the repository root.
Replace this copy with an upstream fixed release when one becomes available.
The original copyright and license are preserved in LICENSE.
