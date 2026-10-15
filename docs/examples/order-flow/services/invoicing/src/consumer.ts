import { Kafka } from "kafkajs";
import { createInvoice } from "./invoices";

const kafka = new Kafka({ clientId: "invoicing", brokers: ["kafka:9092"] });
const consumer = kafka.consumer({ groupId: "invoicing" });

export async function start() {
  await consumer.subscribe({ topic: "order.created" });
  await consumer.run({ eachMessage: handleOrderCreated });
}

async function handleOrderCreated({ message }: { message: { value: Buffer | null } }) {
  const order = JSON.parse(String(message.value));
  await createInvoice(order.id, order.total);
}
