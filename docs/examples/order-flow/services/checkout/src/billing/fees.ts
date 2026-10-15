export const HANDLING_FEE = 5;

export function calculateTotal(subtotal: number) {
  const handlingFee = HANDLING_FEE;
  return subtotal + handlingFee;
}
