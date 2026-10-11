import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrice, transitionAllowed } from './index.js';
test('prices page copies and color surcharge', () => assert.equal(calculatePrice(3,2,2.5,true,1),21));
test('rejects invalid pricing values', () => assert.throws(() => calculatePrice(0,1,2)));
test('order transitions follow lifecycle', () => { assert.equal(transitionAllowed('PAID','QUEUED'),true); assert.equal(transitionAllowed('COMPLETED','QUEUED'),false); });
