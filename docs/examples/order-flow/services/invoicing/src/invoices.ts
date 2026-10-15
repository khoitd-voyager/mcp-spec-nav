export async function createInvoice(orderId: string, amount: number) {
  return { orderId, amount, status: "issued" };
}
