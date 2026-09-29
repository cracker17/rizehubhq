import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackSuccessParams, callbackTarget } from './connectorCallback';

test('callback routing: "st_" states finish a storage sign-in, everything else stays with MCP', () => {
  assert.deepEqual(callbackTarget('st_Qk3v9x0aB1cD2eF3gH4iJ5kL6mN7oP8'), { kind: 'storage', path: '/connectors/storage/finish' });
  assert.deepEqual(callbackTarget('Qk3v9x0aB1cD2eF3gH4iJ5kL6mN7oP8qR'), { kind: 'mcp', path: '/connectors/mcp/finish' });
  assert.deepEqual(callbackTarget('xst_abc'), { kind: 'mcp', path: '/connectors/mcp/finish' });
  assert.deepEqual(callbackTarget('ST_abc'), { kind: 'mcp', path: '/connectors/mcp/finish' }, 'case-sensitive, like the worker');
  assert.deepEqual(callbackTarget(''), { kind: 'mcp', path: '/connectors/mcp/finish' });
});

test('callback routing: MCP keeps ?connected= (opens the tool review); storage lands on ?storageConnected=', () => {
  assert.deepEqual(callbackSuccessParams('mcp', 'id1'), { connected: 'id1' });
  assert.deepEqual(callbackSuccessParams('storage', 'id2'), { storageConnected: 'id2' });
});
