import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createQQImageReferences} from '../src/qq-image-references.js';

const source = {account:'42', key:'group:456', media:{kind:'image', file:'a'.repeat(32)},
  context:{key:'group:456', messageId:'123'}, index:1};

test('image handles are stable and scoped to the observed account, source and image', () => {
  const refs = createQQImageReferences();
  const ref = refs.remember(source);
  assert.equal(refs.remember(source), ref);
  assert.notEqual(refs.remember({...source,index:2}), ref);
  assert.notEqual(refs.remember({...source,key:'group:789'}), ref);
  assert.equal(refs.resolve(ref, {account:'43',key:source.key}), null);
  assert.equal(refs.resolve(ref, {account:'42',key:'group:789'}), null);
  assert.equal(refs.resolve(source.media.file, {account:'42',key:source.key}), null);
  const resolved = refs.resolve(ref, source);
  resolved.media.file = 'mutated';
  assert.equal(refs.resolve(ref, source).media.file, source.media.file);
  assert.match(ref, /^qqimg:[0-9a-f-]{36}$/);
  assert.ok(!ref.includes(source.media.file));
});

test('expired, evicted and cleared handles fail closed', () => {
  let time = 100;
  const refs = createQQImageReferences({maxEntries:2,ttlMs:10,now:() => time});
  const first = refs.remember(source);
  refs.remember({...source,index:2});
  refs.remember({...source,index:3});
  assert.equal(refs.resolve(first, source), null);
  const latest = refs.remember({...source,index:3});
  time += 10;
  assert.equal(refs.resolve(latest, source), null);
  const fresh = refs.remember(source);
  refs.clear();
  assert.equal(refs.resolve(fresh, source), null);
});
