// Runnable miniature example used by the website walkthrough.
export const HANDLING_FEE = 7;
































export function calculateTotal(subtotal, options = {}) {
  // Reuse the existing fee calculation.
  // Callers must pass the new option explicitly when needed.
  // The fee is centralized instead of copied per caller.
  const handlingFee = options.waiveHandlingFee ? 0 : HANDLING_FEE;

  // Keep existing default behavior: add the handling fee.
  return subtotal + handlingFee;
}
