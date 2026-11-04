import test from 'node:test';
import assert from 'node:assert/strict';
import {LeaseGuard,leaseRevoked} from './lease-guard.mjs';

test('a transient renewal failure keeps a valid lease, then stops before the database lease expires',()=>{
  const guard=new LeaseGuard();
  assert.equal(guard.confirm(1000,1500),true);
  assert.equal(guard.mustStop(Error('fetch failed'),21000),false);
  assert.equal(guard.current(75999),true);
  assert.equal(guard.mustStop(Error('fetch failed'),76000),true);
});

test('an acknowledged renewal extends the safe window from request start, not response time',()=>{
  const guard=new LeaseGuard();
  guard.confirm(1000,1500);
  assert.equal(guard.confirm(41000,51000),true);
  assert.equal(guard.current(115999),true);
  assert.equal(guard.current(116000),false);
  assert.equal(guard.confirm(120000,200000),false);
});

test('an explicit revocation stops immediately even with time remaining',()=>{
  const guard=new LeaseGuard();
  guard.confirm(1000,1500);
  assert.equal(leaseRevoked(Error('WORKER_LEASE_LOST')),true);
  assert.equal(guard.mustStop(Error('WORKER_LEASE_LOST'),2000),true);
  assert.equal(guard.mustStop(Error('fetch failed'),2000),false);
});
