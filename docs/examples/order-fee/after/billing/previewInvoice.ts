import { calculateTotal } from './fees.ts';
export function previewInvoice(subtotal, waiveHandlingFee = false) {
  return calculateTotal(subtotal, { waiveHandlingFee });
}
