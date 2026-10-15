import { calculateTotal } from "../billing/fees";
import { publishOrderCreated } from "../events";

export async function createOrderHandler(req: any, res: any) {
  const total = calculateTotal(req.body.subtotal);
  const order = { id: crypto.randomUUID(), total };
  await publishOrderCreated(order);
  res.status(201).json(order);
}
