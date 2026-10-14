import { calculateTotal } from '../billing/fees.ts';
export function createOrder(subtotal, waiveHandlingFee = false) {
  return calculateTotal(subtotal, { waiveHandlingFee });
}
