import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAuxiliarySceneReports as body } from '../scene-body.js';

test('comparison excludes arbitrary nested tags, attributes and tag contents', () => {
    assert.equal(body('Before.<phone x="a > b"><phone>nested</phone><other>data</other></phone>After.'), 'Before.After.');
    assert.equal(body("Before.<CUSTOM x='>'>data</custom>After."), 'Before.After.');
    assert.equal(body('Before.<기록>data</기록><x:state>data</x:state>After.'), 'Before.After.');
});

test('void/self-closing tags and comments do not swallow subsequent narrative', () => {
    assert.equal(body('Before.<trigger/><br><img src="x"><!-- hidden -->After.'), 'Before.After.');
    assert.equal(body('Before.<!-- incomplete'), 'Before.');
    assert.equal(body('Before.</orphan>After.'), 'Before.After.');
});

test('unclosed containers exclude their remainder, while ordinary comparisons stay literal', () => {
    assert.equal(body('Before.<data>unfinished'), 'Before.');
    assert.equal(body('Before.<data><data>nested</data>unfinished'), 'Before.');
    assert.equal(body('2 < 3 and 5 > 4'), '2 < 3 and 5 > 4');
    assert.equal(body('Before.\n\n<data>hidden</data>\nAfter.'), body('Before.\nAfter.'));
    assert.notEqual(body('Before.<data>x</data>After.'), body('Before.<data>y</data>Changed.'));
});
