import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// The fixture is plain JavaScript valid as TypeScript; importing via a data URL
// avoids requiring a TypeScript loader or dependencies for this mini example.
const source = await readFile(new URL('./after/billing/fees.ts', import.meta.url), 'utf8');
const { calculateTotal } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const feeURL = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
async function loadCaller(path, name) {
  const callerSource = await readFile(new URL('./after/' + path, import.meta.url), 'utf8');
  const runnable = callerSource.replace(/from '[^']+fees\.ts'/, 'from ' + JSON.stringify(feeURL));
  return (await import('data:text/javascript;base64,' + Buffer.from(runnable).toString('base64')))[name];
}
const createOrder = await loadCaller('checkout/createOrder.ts', 'createOrder');
const previewInvoice = await loadCaller('billing/previewInvoice.ts', 'previewInvoice');
const updateOrder = await loadCaller('orders/updateOrder.ts', 'updateOrder');
test('default callers pay the new centralized fee', () => assert.equal(calculateTotal(100), 107));
test('false keeps the fee', () => assert.equal(calculateTotal(50, { waiveHandlingFee: false }), 57));
test('zero subtotal still uses the centralized fee', () => assert.equal(calculateTotal(0), 7));
test('createOrder forwards the waiver', () => assert.equal(createOrder(100, true), 100));
test('previewInvoice forwards the waiver', () => assert.equal(previewInvoice(100, true), 100));
test('updateOrder forwards the waiver', () => assert.equal(updateOrder(100, true), 100));
