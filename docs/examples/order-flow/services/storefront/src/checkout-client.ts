const CHECKOUT_URL = "http://checkout:3000";

export async function submitOrder(cart: { subtotal: number }) {
  const res = await fetch(`${CHECKOUT_URL}/api/orders`, {
    method: "POST",
    body: JSON.stringify(cart),
  });
  return res.json();
}
