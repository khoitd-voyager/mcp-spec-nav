# 跨服务追踪调用链

[English](flows.md) · [Tiếng Việt](flows.vi.md) · [简体中文](flows.zh-CN.md)

← [README](../../README.zh-CN.md) · [工具参考](tools.zh-CN.md#spec_nav_trace_flow)

`spec_nav_trace_flow` 从源代码中连接各服务之间相互通信的位置。这是**静态分析，而不是运行时分布式追踪**：不执行、不观测任何东西，也无需配置。

## 示例

[docs/examples/order-flow](../examples/order-flow/) 包含三个服务：`storefront` 通过 HTTP 调用 `checkout`，`checkout` 用 `calculateTotal` 计算总额并向 Kafka 发布 `order.created`，`invoicing` 消费该事件。对 `calculateTotal` 调用 `spec_nav_callers` 只找到一个直接调用方 `createOrderHandler`，并说明经 HTTP/RPC/队列的调用不计入。从该 handler 双向追踪：

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

真实输出，已删减：步骤 #2、#3、#5 只保留第一行，#4 去掉了 id。

## 连接哪些内容

- **HTTP：** 客户端调用 → 路由（method + 完整路径，经过挂载和前缀）→ handler 函数。
- **RPC：** NestJS 微服务 `send` → `@MessagePattern` handler。
- **事件：** NestJS `emit` → `@EventPattern`；`EventEmitter2.emit` → `@OnEvent`（仅限同一服务——它在进程内）；kafkajs `producer.send` → `consumer.subscribe` 及其 `run({ eachMessage })` handler。

在这些步骤之间，它会跟随服务内部的直接函数调用（`call` 步骤，按语法和 import 绑定：同一文件或作用域、导入的名称、`this.x()`、声明了类型的属性和变量，包括 `container.resolve<T>(…)`）。这些步骤与 `spec_nav_callers` 分开，后者的结果不变。

## 受支持的框架

| | 服务端与消费者 | 客户端与生产者 |
|---|---|---|
| HTTP，TypeScript/JavaScript | Express（`express()`、`Router()`、包括 `require` 在内的 `app.use` 挂载、`.route()` 链）、Fastify（实例、带 `prefix` 注册的插件、`route({…})`）、koa-router（`prefix`）、NestJS（`@Controller` + `@Get`…、`setGlobalPrefix`）；基于文件的路由——Next.js `app/**/route.ts`（路由组、`[id]`、`[...slug]`）与 `pages/api/**`、Medusa `src/api/**/route.ts`、SvelteKit `src/routes/**/+server.ts` | `fetch`（全局、node-fetch、undici…）、`ofetch`/`$fetch`、axios（`axios.get`、`axios(config)`、`axios.create({ baseURL })` 实例，包括从其他文件导出的实例）、NestJS `HttpService` |
| HTTP，Python | FastAPI（`FastAPI`、`APIRouter(prefix=…)`、`include_router`、`mount`、`add_api_route`）、Flask（`Flask`、`Blueprint(url_prefix=…)`、`register_blueprint`、`add_url_rule`） | requests、httpx（`Client`/`AsyncClient(base_url=…)`、`with … as client`、`self.client`）、aiohttp `ClientSession(base_url=…)` |
| RPC | NestJS `@MessagePattern` | `ClientProxy.send` |
| 事件 | NestJS `@EventPattern`、`@OnEvent`；kafkajs `consumer.subscribe`（topic、列表或正则） | `ClientProxy.emit`、`EventEmitter2.emit`/`emitAsync`；kafkajs `producer.send`/`sendBatch` |

## 连接状态与置信度

每个步骤包含发送所在行、接收函数（附 id，可用 `spec_nav_read_function` 读取）、连接两端的证据、置信度和状态：

| 状态 | 含义 | 是否继续追踪 |
|---|---|---|
| `resolved` | 键已知且恰好匹配一个目标（事件则为所有订阅者）。 | 是 |
| `partial` | 匹配一个目标，但键的一部分来自配置：来自环境变量的 base URL、不在仓库中的主机、看不到挂载位置的路由器。 | 是；`includePartial: false` 可在此停止 |
| `ambiguous` | 多个目标匹配，且代码无法确定是哪一个：两个服务中相同的路径、出现两次的 RPC pattern、位于多个 Kafka 集群上的 topic。 | 否——列出候选 |
| `unresolved` | URL、topic 或 pattern 在运行时计算（参数、函数调用）。 | 否 |
| `unmatched` | 仓库中没有任何代码接收它：外部主机，或主机所指向的服务没有该路由。 | — |

**置信度**来自证据，不是概率。HTTP 为 `high`：method 与路径已知、恰好匹配一个路由，并且 URL 的主机确定了服务（docker-compose 服务名及其 build 目录、项目目录或包名、传给 `listen()`/`uvicorn.run`/`app.run` 的端口），或两端位于同一服务；`medium`：没有任何信息确定服务（相对 URL）；当运行时计算的片段需匹配路由中的固定文本，或 method 为运行时计算时降低一级；`partial` 连接为 `low`。事件与 RPC 在同一进程内（EventEmitter2）或生产者与消费者配置了相同 Kafka broker 时为 `high`，topic/pattern 相同但未检查传输配置时为 `medium`，通过通配符或正则订阅匹配时为 `low`。

## 键与主机的解析方式

字符串可通过字面量、模板字符串与 f-string、`+`、同一文件或导入的常量（经 re-export 和 workspace 包）、对象与枚举成员、类常量以及只赋值一次的 `this.x`/`self.x` 解析。`process.env.X`、`os.environ[…]`、`os.getenv(…)` 保留为配置（会注明默认值）。主机通过仓库根目录的 `docker-compose.yml`/`compose.yml`（服务名、`container_name`、`hostname`、`build`、发布端口）、项目目录、`package.json` 名称和监听端口进行映射。

## 覆盖率与 gaps

每个结果都以覆盖率结尾：分析的文件数、有发现的适配器，以及 `gaps`——有 HTTP/RPC/队列形态代码却没有适配器的语言、无法识别接收者的调用、挂载位置未知的路由器、路径在运行时计算的路由、语法错误。与其他工具一样，每次查询都会重新读取已修改的文件。一切都在本地副本上运行；代码不会离开本机。

在真实仓库上，请运行 inventory（不带起点调用 `spec_nav_trace_flow`）并查看其 `gaps` 行。

## 不追踪的内容

连接是推断出来的，而非观测，并且只针对上面列出的适配器。不追踪：gRPC、GraphQL、WebSocket、其他队列（BullMQ、RabbitMQ、SQS…）、Go、Java 等其他语言、自动生成的 API 客户端、在封装函数（`request(path)`）中或用 `urljoin` 构建的 URL、docker-compose 之外的服务发现与配置文件、NestJS 路由版本、Next.js `basePath`、位于 `node_modules` 中的框架内置路由（例如 Medusa 默认的 `/store/*` 路由）。只有在同一文件中创建客户端时才能知道 Kafka broker。`call` 步骤按语法和 import 绑定，未经类型检查。

## 基准测试

在自动生成的仓库上逐条连接测量，不涉及代理和 LLM：[bench/README.md](../../bench/README.md#跨服务调用链benchflowmjs) · [结果](../../bench/results/flow-test.md#简体中文)。
