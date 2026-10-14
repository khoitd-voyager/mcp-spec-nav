import { calculateTotal } from '../billing/fees.ts';
export function updateOrder(subtotal) {
  return calculateTotal(subtotal);
}
