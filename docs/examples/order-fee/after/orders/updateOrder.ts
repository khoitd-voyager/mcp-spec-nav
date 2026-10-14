import { calculateTotal } from '../billing/fees.ts';
export function updateOrder(subtotal, waiveHandlingFee = false) {
  return calculateTotal(subtotal, { waiveHandlingFee });
}
