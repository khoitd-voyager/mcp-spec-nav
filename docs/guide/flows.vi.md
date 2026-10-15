# Lần theo luồng giữa các service

[English](flows.md) · [Tiếng Việt](flows.vi.md) · [简体中文](flows.zh-CN.md)

← [README](../../README.vi.md) · [Tham khảo tool](tools.vi.md#spec_nav_trace_flow)

`spec_nav_trace_flow` nối các chỗ mà service giao tiếp với nhau, từ source code. Đây là **phân tích tĩnh, không phải distributed tracing lúc chạy**: không chạy hay quan sát gì, và không cần cấu hình.

## Ví dụ

[docs/examples/order-flow](../examples/order-flow/) có ba service: `storefront` gọi HTTP tới `checkout`, `checkout` tính tổng bằng `calculateTotal` rồi phát `order.created` lên Kafka, `invoicing` nhận event đó. `spec_nav_callers` trên `calculateTotal` tìm được một caller trực tiếp là `createOrderHandler`, và ghi rõ lời gọi qua HTTP/RPC/queue không được tính. Lần theo từ handler đó theo cả hai chiều:

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

Output thật, đã rút gọn: bước #2, #3 và #5 chỉ giữ dòng đầu, bỏ id ở bước #4.

## Tool nối những gì

- **HTTP:** lời gọi client → route (method + đường dẫn đầy đủ, qua mount và prefix) → hàm handler.
- **RPC:** NestJS microservices `send` → handler `@MessagePattern`.
- **Event:** NestJS `emit` → `@EventPattern`; `EventEmitter2.emit` → `@OnEvent` (chỉ trong cùng service — vì chạy trong một process); kafkajs `producer.send` → `consumer.subscribe` và handler `run({ eachMessage })`.

Giữa các bước đó, tool đi theo lời gọi hàm trực tiếp trong một service (bước `call`, gắn theo cú pháp và import: cùng file hoặc scope, tên được import, `this.x()`, thuộc tính và biến có khai báo kiểu, kể cả `container.resolve<T>(…)`). Các bước này tách khỏi `spec_nav_callers`; kết quả của `spec_nav_callers` không đổi.

## Framework được hỗ trợ

| | Server và consumer | Client và producer |
|---|---|---|
| HTTP, TypeScript/JavaScript | Express (`express()`, `Router()`, mount bằng `app.use` kể cả `require`, chuỗi `.route()`), Fastify (instance, plugin đăng ký với `prefix`, `route({…})`), koa-router (`prefix`), NestJS (`@Controller` + `@Get`…, `setGlobalPrefix`); route theo file — Next.js `app/**/route.ts` (route group, `[id]`, `[...slug]`) và `pages/api/**`, Medusa `src/api/**/route.ts`, SvelteKit `src/routes/**/+server.ts` | `fetch` (global, node-fetch, undici…), `ofetch`/`$fetch`, axios (`axios.get`, `axios(config)`, instance `axios.create({ baseURL })`, kể cả khi export từ file khác), NestJS `HttpService` |
| HTTP, Python | FastAPI (`FastAPI`, `APIRouter(prefix=…)`, `include_router`, `mount`, `add_api_route`), Flask (`Flask`, `Blueprint(url_prefix=…)`, `register_blueprint`, `add_url_rule`) | requests, httpx (`Client`/`AsyncClient(base_url=…)`, `with … as client`, `self.client`), aiohttp `ClientSession(base_url=…)` |
| RPC | NestJS `@MessagePattern` | `ClientProxy.send` |
| Event | NestJS `@EventPattern`, `@OnEvent`; kafkajs `consumer.subscribe` (topic, danh sách hoặc regex) | `ClientProxy.emit`, `EventEmitter2.emit`/`emitAsync`; kafkajs `producer.send`/`sendBatch` |

## Trạng thái link và confidence

Mỗi bước có dòng gửi, hàm nhận (kèm id để đọc bằng `spec_nav_read_function`), bằng chứng nối hai đầu, confidence và trạng thái:

| Trạng thái | Ý nghĩa | Có đi tiếp? |
|---|---|---|
| `resolved` | Biết rõ khóa và khớp đúng một đích (với event: mọi subscriber). | Có |
| `partial` | Khớp một đích, nhưng một phần khóa là cấu hình: base URL từ biến môi trường, host không có trong repo, router không thấy được mount ở đâu. | Có; `includePartial: false` để dừng |
| `ambiguous` | Nhiều đích cùng khớp và code không chỉ ra đích nào: cùng path ở hai service, cùng pattern RPC hai lần, topic trên nhiều cluster Kafka. | Không — liệt kê ứng viên |
| `unresolved` | URL, topic hoặc pattern được tính lúc chạy (tham số, lời gọi hàm). | Không |
| `unmatched` | Không có gì trong repo nhận nó: host bên ngoài, hoặc service mà host chỉ tới không có route đó. | — |

**Confidence** dựa trên bằng chứng, không phải xác suất. HTTP `high` khi biết method và path, khớp một route và host trong URL xác định được service (tên service trong docker-compose cùng thư mục build, tên thư mục project hoặc tên package, hoặc cổng truyền vào `listen()`/`uvicorn.run`/`app.run`), hoặc hai đầu cùng một service; `medium` khi không có gì xác định service (URL tương đối); hạ một bậc khi một đoạn tính lúc chạy phải khớp với chữ cố định của route hoặc method tính lúc chạy; link `partial` là `low`. Event và RPC `high` khi trong cùng process (EventEmitter2) hoặc producer và consumer cấu hình cùng broker Kafka, `medium` khi trùng topic/pattern nhưng chưa kiểm tra transport, `low` khi khớp qua wildcard hoặc regex.

## Cách resolve khóa và host

Chuỗi được resolve qua literal, template literal và f-string, `+`, hằng số trong cùng file hoặc import (qua re-export và workspace package), thành viên object và enum, hằng của class, `this.x`/`self.x` gán một lần. `process.env.X`, `os.environ[…]`, `os.getenv(…)` được giữ là cấu hình (có ghi giá trị mặc định). Host được ánh xạ qua `docker-compose.yml`/`compose.yml` ở gốc repo (tên service, `container_name`, `hostname`, `build`, cổng publish), thư mục project, tên trong `package.json` và cổng lắng nghe.

## Coverage và gaps

Mỗi kết quả kết thúc bằng coverage: số file đã phân tích, adapter có kết quả, và `gaps` — ngôn ngữ có code trông như HTTP/RPC/queue nhưng chưa có adapter, lời gọi không xác định được receiver, router không rõ mount, route có path tính lúc chạy, lỗi cú pháp. Mỗi truy vấn đọc lại file đã đổi như các tool khác. Mọi thứ chạy local trên checkout; code không rời khỏi máy.

Với repo thật, chạy inventory (`spec_nav_trace_flow` không có điểm bắt đầu) và đọc dòng `gaps`.

## Chưa được lần theo

Link được suy ra, không quan sát lúc chạy, và chỉ với các adapter ở trên. Chưa hỗ trợ: gRPC, GraphQL, WebSocket, queue khác (BullMQ, RabbitMQ, SQS…), Go, Java và ngôn ngữ khác, API client sinh tự động, URL dựng trong hàm wrapper (`request(path)`) hoặc bằng `urljoin`, service discovery và file cấu hình ngoài docker-compose, version route của NestJS, `basePath` của Next.js, route có sẵn của framework nằm trong `node_modules` (ví dụ route `/store/*` mặc định của Medusa). Broker Kafka chỉ biết khi client được tạo trong cùng file. Bước `call` gắn theo cú pháp và import, không qua type checker.

## Benchmark

Đo theo từng link trên repo sinh tự động, không có agent và không có LLM: [bench/README.md](../../bench/README.md#luồng-giữa-các-service-benchflowmjs) · [kết quả](../../bench/results/flow-test.md#tiếng-việt).
