import { calculateTotal } from './fees.ts';
export function previewInvoice(subtotal) {
  return calculateTotal(subtotal);
}
