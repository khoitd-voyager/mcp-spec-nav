import { calculateTotal } from '../billing/fees.ts';
export function createOrder(subtotal) {
  return calculateTotal(subtotal);
}
