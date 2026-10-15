import test from 'node:test';
import assert from 'node:assert/strict';
import { beginTurnSession, sessionTurns } from '../slow-burn-turns.js';

const user = n => ({ is_user: true, send_date: `2026-10-14T00:00:${n}.000Z`, mes: 'Question.' });
const reply = text => ({ mes: text || 'Answer.' });
const start = chat => ({ slowBurnSessionActive: true, slowBurnTurnSession: beginTurnSession(chat) });
const count = (meta, chat) => sessionTurns(meta, chat).messages.length;

test('new replies count once; regeneration, swipe, continuation and repeated observations do not add turns', () => {
    const chat = [user(1), reply()], meta = start(chat);
    chat.push(user(2), reply());
    assert.equal(count(meta, chat), 1);
    chat[3] = { mes: 'Replacement.', swipe_id: 3, gen_started: 'new start', gen_finished: 'new finish' };
    assert.equal(count(meta, chat), 1);
    chat[3].mes += ' More text.';
    assert.equal(count(meta, chat), 1);
    assert.equal(count(meta, chat), 1);
    chat.push(user(3), reply());
    assert.equal(count(meta, chat), 2);
});

test('deleting old history does not erase progress; removing a session reply does', () => {
    const chat = [user(1), reply(), user(2), reply()], meta = start(chat);
    chat.push(user(3), reply());
    chat.splice(0, 2);
    assert.equal(count(meta, chat), 1);
    chat.pop();
    assert.equal(count(meta, chat), 0);
    chat.push(reply('Recreated current slot.'));
    assert.equal(count(meta, chat), 1);
});

test('branch before activation can progress without reaching the old chat length; persisted reload agrees', () => {
    const chat = [user(1), reply(), user(2), reply(), user(3), reply()], meta = start(chat);
    const branch = JSON.parse(JSON.stringify(chat.slice(0, 2)));
    const copiedMeta = JSON.parse(JSON.stringify(meta));
    branch.push(user(4), reply());
    assert.equal(count(copiedMeta, branch), 1);
    assert.equal(count(meta, chat), 0);
    branch.push(user(5), reply());
    assert.equal(count(copiedMeta, branch), 2);
});

test('pending placeholders and streams are not baseline replies or completed turns', () => {
    const chat = [user(1), { mes: '', gen_started: 'start' }], meta = start(chat);
    assert.equal(count(meta, chat), 0);
    chat[1].mes = 'Partial';
    assert.equal(count(meta, chat), 0);
    chat[1].gen_finished = 'finish';
    assert.equal(count(meta, chat), 1);
});

test('legacy count beyond the current branch is rebased once, not a permanent debt', () => {
    const chat = [user(1), reply()];
    const meta = { slowBurnSessionActive: true, slowBurnSessionStartAssistantCount: 500 };
    assert.equal(sessionTurns(meta, chat).legacyRebased, true);
    assert.equal(count(meta, chat), 0);
    chat.push(user(2), reply());
    assert.equal(count(meta, chat), 1);
    assert.equal(sessionTurns(meta, chat).changed, false);
});

test('migration preserves measurable progress and leaves message content/metadata untouched', () => {
    const chat = [user(1), reply(), user(2), reply()], original = JSON.stringify(chat);
    const meta = { slowBurnSessionActive: true, slowBurnSessionStartAssistantCount: 1 };
    assert.equal(count(meta, chat), 1);
    chat[0].mes = 'Edited user message with unchanged creation date.';
    assert.equal(count(meta, chat), 1);
    chat[0].mes = 'Question.';
    assert.equal(JSON.stringify(chat), original);
    assert.doesNotMatch(JSON.stringify(meta), /Question|Answer/);
});
