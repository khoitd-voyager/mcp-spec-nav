// Runnable miniature example used by the website walkthrough.
export const HANDLING_FEE = 5;
































export function calculateTotal(subtotal) {
  // Reuse the existing fee calculation.
  // Callers must pass the new option explicitly when needed.
  // The fee is centralized instead of copied per caller.
  const handlingFee = HANDLING_FEE;

  // Keep existing default behavior: add the handling fee.
  return subtotal + handlingFee;
}
