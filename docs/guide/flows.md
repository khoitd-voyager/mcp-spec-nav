# Trace flows across services

[English](flows.md) · [Tiếng Việt](flows.vi.md) · [简体中文](flows.zh-CN.md)

← [README](../../README.md) · [Tool reference](tools.md#spec_nav_trace_flow)

`spec_nav_trace_flow` joins the places where services talk to each other, from source code. It is **static analysis, not runtime tracing**: nothing is executed or observed, and nothing needs configuring.

## Example

[docs/examples/order-flow](../examples/order-flow/) has three services: `storefront` posts to `checkout` over HTTP, `checkout` computes the total with `calculateTotal` and publishes `order.created` to Kafka, and `invoicing` consumes it. `spec_nav_callers` on `calculateTotal` finds one direct caller, `createOrderHandler`, and notes that calls through HTTP/RPC/queues are not counted. Tracing from that handler in both directions:

```json
{ "file": "services/checkout/src/handlers/createOrder.ts", "name": "createOrderHandler", "direction": "both" }
```

```text
steps: 5 (5 resolved) — this page 1-5 — COMPLETE
gaps: none found among the supported adapters.

#1  d1 ↑ HTTP  POST http://checkout:3000/api/orders → POST /api/orders   [resolved · high]
    from  services/storefront/src/checkout-client.ts:3  submitOrder  (service services/storefront)
          id: services/storefront/src/checkout-client.ts::submitOrder@d438fa09
    at    services/storefront/src/checkout-client.ts:4  const res = await fetch(`${CHECKOUT_URL}/api/orders`, {
    to    services/checkout/src/handlers/createOrder.ts:4  createOrderHandler  (service services/checkout)
          id: services/checkout/src/handlers/createOrder.ts::createOrderHandler@7845c7c5
    evidence: fetch POST "http://checkout:3000/api/orders" (services/storefront/src/checkout-client.ts:4); CHECKOUT_URL = "http://checkout:3000" (services/storefront/src/checkout-client.ts:1); host "checkout:3000" → services/checkout: docker-compose service "checkout" builds services/checkout (docker-compose.yml:5); matches POST /api/orders; route POST "/" — express (services/checkout/src/routes/orders.ts:5); mounted at "/api/orders" on app (services/checkout/src/app.ts:6)
#2  d1 ↓ call  createOrderHandler → calculateTotal   [resolved · high]
#3  d1 ↓ call  createOrderHandler → publishOrderCreated   [resolved · high]
#4  d2 ↓ EVENT event order.created → event order.created (kafka)   [resolved · medium]
    from  services/checkout/src/events.ts:6  publishOrderCreated  (service services/checkout)
    at    services/checkout/src/events.ts:7  await producer.send({ topic: "order.created", messages: [{ value: JSON.stringify(order) }] });
    to    services/invoicing/src/consumer.ts:12  handleOrderCreated  (service services/invoicing)
    evidence: kafkajs produce to topic order.created (services/checkout/src/events.ts:7); brokers kafka:9092; one Kafka broker configuration in the repo; kafkajs consumer of order.created (services/invoicing/src/consumer.ts:8); consumer group "invoicing"; brokers kafka:9092
#5  d3 ↓ call  handleOrderCreated → createInvoice   [resolved · high]
```

Real output, trimmed: steps #2, #3 and #5 are shown by their first line, and ids are removed from #4.

## What it links

- **HTTP:** client call → route (method + full path, through mounts and prefixes) → handler function.
- **RPC:** NestJS microservices `send` → `@MessagePattern` handler.
- **Events:** NestJS `emit` → `@EventPattern`; `EventEmitter2.emit` → `@OnEvent` (same service only — it is in-process); kafkajs `producer.send` → `consumer.subscribe` and its `run({ eachMessage })` handler.

Between those it follows direct calls inside a service (`call` steps, bound by syntax and imports: same file or scope, imported names, `this.x()`, properties and variables with a declared type, including `container.resolve<T>(…)`). They are kept apart from `spec_nav_callers`, whose results do not change.

## Supported frameworks

| | Servers and consumers | Clients and producers |
|---|---|---|
| HTTP, TypeScript/JavaScript | Express (`express()`, `Router()`, `app.use` mounts including `require`, `.route()` chains), Fastify (instances, plugins registered with a `prefix`, `route({…})`), koa-router (`prefix`), NestJS (`@Controller` + `@Get`…, `setGlobalPrefix`); file-based routes — Next.js `app/**/route.ts` (route groups, `[id]`, `[...slug]`) and `pages/api/**`, Medusa `src/api/**/route.ts`, SvelteKit `src/routes/**/+server.ts` | `fetch` (global, node-fetch, undici…), `ofetch`/`$fetch`, axios (`axios.get`, `axios(config)`, `axios.create({ baseURL })` instances, also when exported from another file), NestJS `HttpService` |
| HTTP, Python | FastAPI (`FastAPI`, `APIRouter(prefix=…)`, `include_router`, `mount`, `add_api_route`), Flask (`Flask`, `Blueprint(url_prefix=…)`, `register_blueprint`, `add_url_rule`) | requests, httpx (`Client`/`AsyncClient(base_url=…)`, `with … as client`, `self.client`), aiohttp `ClientSession(base_url=…)` |
| RPC | NestJS `@MessagePattern` | `ClientProxy.send` |
| Events | NestJS `@EventPattern`, `@OnEvent`; kafkajs `consumer.subscribe` (topic, list or regex) | `ClientProxy.emit`, `EventEmitter2.emit`/`emitAsync`; kafkajs `producer.send`/`sendBatch` |

## Link status and confidence

Each step has the sending line, the receiving function (with an id for `spec_nav_read_function`), the evidence that joins them, a confidence and a status:

| Status | Meaning | Followed? |
|---|---|---|
| `resolved` | The key is known and one target matches (every subscriber, for an event). | Yes |
| `partial` | One target matches, but part of the key is configuration: an environment-variable base URL, a host not in the repo, a router whose mount point is not visible. | Yes; `includePartial: false` stops there |
| `ambiguous` | Several targets match and nothing in the code picks one: the same path in two services, the same RPC pattern twice, a topic on several Kafka clusters. | No — candidates are listed |
| `unresolved` | The URL, topic or pattern is computed (a parameter, a function call). | No |
| `unmatched` | Nothing in the repo receives it: an external host, or the service the host names has no such route. | — |

**Confidence** is earned from evidence; it is not a probability. HTTP is `high` when method and path are known, one route matches and the URL's host pins the service (a docker-compose service name and its build directory, a project directory or package name, or a port passed to `listen()`/`uvicorn.run`/`app.run`) or both sides are in the same service; `medium` when nothing pins the service (a relative URL); one level lower when a computed segment had to match fixed route text or the method is computed; `partial` links are `low`. Events and RPC are `high` within one process (EventEmitter2) or when producer and consumer are configured with the same Kafka brokers, `medium` on an equal topic or pattern with the transport unchecked, `low` through a wildcard or regex subscription.

## How keys and hosts are resolved

Strings are resolved through literals, template literals and f-strings, `+`, constants in the same file or imported (through re-exports and workspace packages), object and enum members, class constants and `this.x`/`self.x` assigned once. `process.env.X`, `os.environ[…]` and `os.getenv(…)` stay configuration (their defaults are noted). Hosts are mapped through `docker-compose.yml`/`compose.yml` at the root (service names, `container_name`, `hostname`, `build`, published ports), project directories, `package.json` names and listening ports.

## Coverage and gaps

Every result ends with coverage: files analysed, adapters with findings, and `gaps` — languages with HTTP/RPC/queue-looking code but no adapter, calls whose receiver could not be identified, routers whose mount point is unknown, computed route paths, syntax errors. Each query re-reads changed files, like the other tools. Everything runs locally on the checkout; no code leaves the machine.

On a real repository, run the inventory (`spec_nav_trace_flow` with no start) and read its `gaps` line.

## Not traced

Links are inferred, never observed, and only for the adapters above. Not traced: gRPC, GraphQL, WebSockets, other queues (BullMQ, RabbitMQ, SQS…), Go, Java and other languages, generated API clients, URLs built inside wrapper functions (`request(path)`) or with `urljoin`, service discovery and configuration files other than docker-compose, NestJS route versions, Next.js `basePath`, framework routes that live in `node_modules` (e.g. Medusa's built-in `/store/*` routes). Kafka brokers are only known when the client is created in the same file. `call` steps are bound by syntax and imports, not type-checked.

## Benchmark

Measured link by link on generated repositories, with no agent and no LLM: [bench/README.md](../../bench/README.md#cross-service-flows-benchflowmjs) · [results](../../bench/results/flow-test.md#english).
