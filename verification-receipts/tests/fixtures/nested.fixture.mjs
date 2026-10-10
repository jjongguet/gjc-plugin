import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
describe('outer',()=>{it('first',()=>assert.equal(1,1));describe('inner',()=>{it('second',()=>assert.equal(2,2));});});
