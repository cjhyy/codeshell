import { afterAll, expect } from 'bun:test';
import * as network from './deny-network.mjs';
afterAll(() => { console.log('normal controls network receipt', JSON.stringify(network.stats())); expect(network.stats().denied).toBe(0); network.restore(); });
