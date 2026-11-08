'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spokenEmail, spellEmail } = require('../bin/spoken-email.js');

test('addresses said out loud are read by code; a spelled run wins; the last one said wins', () => {
  // the 2026-11-01 call, word for word: the model turned this into alexriveras@gmail.com and the invite bounced
  assert.strictEqual(spokenEmail('The address is igani lubitz at g mail dot com, a l e x r i v e r a at g mail dot com.').email, 'alexrivera@gmail.com');
  assert.strictEqual(spokenEmail('dana at acme dot co.').email, 'dana@acme.co');
  assert.strictEqual(spokenEmail('send it to d a n a dot c o l e at acme dot co dot il please').email, 'dana.cole@acme.co.il');
  assert.strictEqual(spokenEmail('j o h n 1 2 at hot mail dot com').email, 'john12@hotmail.com');
  assert.strictEqual(spokenEmail('e l o n underscore r at gmail dot com and thanks').email, 'elon_r@gmail.com');
  assert.strictEqual(spokenEmail("it's john.smith@example.com.").email, 'john.smith@example.com');
  assert.strictEqual(spokenEmail('no address here'), null);
  assert.strictEqual(spokenEmail('meet at four'), null);
});

test('spelled back letter by letter', () => {
  assert.strictEqual(spellEmail('alexrivera@gmail.com'), 'a, l, e, x, r, i, v, e, r, a at gmail dot com');
  assert.strictEqual(spellEmail('dana.c@acme.co.il'), 'd, a, n, a, dot, c at acme dot co dot il');
});
