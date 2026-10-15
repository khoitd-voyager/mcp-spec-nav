import { Kafka } from "kafkajs";

const kafka = new Kafka({ clientId: "checkout", brokers: ["kafka:9092"] });
const producer = kafka.producer();

export async function publishOrderCreated(order: { id: string; total: number }) {
  await producer.send({ topic: "order.created", messages: [{ value: JSON.stringify(order) }] });
}
