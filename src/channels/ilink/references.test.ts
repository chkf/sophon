import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { partialQuote } from './references.js';
import { platformId } from './api.js';

test('partial quote indexes count substring occurrences; MD5 disambiguates observed end variants',()=>{
  const text='begin one end then begin two end end';
  assert.equal(partialQuote(text,{start:'begin',end:'end',startindex:1,endindex:1,quotemd5:''}),'begin two end');
  const selected='begin two end end';
  assert.equal(partialQuote(text,{start:'begin',end:'end',startindex:1,endindex:1,quotemd5:createHash('md5').update(selected).digest('hex')}),selected);
  assert.equal(partialQuote(text,{start:'begin',end:'end',startindex:1,endindex:1,quotemd5:'0'.repeat(32)}),undefined);
  assert.equal(partialQuote(text,{start:'begin',end:'end',startindex:99,endindex:1,quotemd5:''}),undefined);
  assert.equal(platformId(9007199254740992),undefined);assert.equal(platformId('18446744073709551615'),'18446744073709551615');
});
