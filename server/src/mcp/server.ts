import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  binanceClient,
  orderExecutor,
  settingsService
} from "../container.js";

function jsonContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

const sideSchema = z.enum(["BUY", "SELL"]);

const server = new McpServer({
  name: "binance-mcp-auto-trader",
  version: "0.1.0"
});

server.registerTool(
  "get_price",
  {
    title: "Lấy giá USD-M Futures",
    description: "Lấy giá ticker mới nhất của Binance USD-M Futures.",
    inputSchema: { symbol: z.string().min(1) }
  },
  async ({ symbol }) => jsonContent(await binanceClient.getPrice(symbol))
);

server.registerTool(
  "get_klines",
  {
    title: "Lấy nến klines",
    description: "Lấy dữ liệu nến của Binance USD-M Futures.",
    inputSchema: {
      symbol: z.string().min(1),
      interval: z.string().default("5m"),
      limit: z.number().int().min(1).max(1500).default(100)
    }
  },
  async ({ symbol, interval, limit }) =>
    jsonContent(await binanceClient.getKlines(symbol, interval, limit))
);

server.registerTool(
  "get_funding_rate",
  {
    title: "Lấy funding rate",
    description: "Lấy lịch sử funding rate của Binance USD-M Futures.",
    inputSchema: {
      symbol: z.string().min(1),
      limit: z.number().int().min(1).max(1000).default(10)
    }
  },
  async ({ symbol, limit }) =>
    jsonContent(await binanceClient.getFundingRate(symbol, limit))
);

server.registerTool(
  "get_open_interest",
  {
    title: "Lấy open interest",
    description: "Lấy open interest hiện tại của Binance USD-M Futures.",
    inputSchema: { symbol: z.string().min(1) }
  },
  async ({ symbol }) => jsonContent(await binanceClient.getOpenInterest(symbol))
);

server.registerTool(
  "get_long_short_ratio",
  {
    title: "Lấy tỷ lệ long/short toàn thị trường",
    description: "Lấy tỷ lệ tài khoản long/short global của Binance Futures.",
    inputSchema: {
      symbol: z.string().min(1),
      period: z.string().default("5m"),
      limit: z.number().int().min(1).max(500).default(30)
    }
  },
  async ({ symbol, period, limit }) =>
    jsonContent(await binanceClient.getLongShortRatio(symbol, period, limit))
);

server.registerTool(
  "get_balance",
  {
    title: "Lấy số dư futures",
    description: "Lấy số dư ví Binance USD-M Futures bằng signed endpoint.",
    inputSchema: {}
  },
  async () => jsonContent(await binanceClient.getBalance())
);

server.registerTool(
  "get_position",
  {
    title: "Lấy vị thế futures",
    description: "Lấy thông tin position risk của Binance USD-M Futures.",
    inputSchema: { symbol: z.string().optional() }
  },
  async ({ symbol }) => jsonContent(await binanceClient.getPosition(symbol))
);

server.registerTool(
  "get_open_orders",
  {
    title: "Lấy lệnh đang mở",
    description: "Lấy danh sách lệnh đang mở của Binance USD-M Futures.",
    inputSchema: { symbol: z.string().optional() }
  },
  async ({ symbol }) => jsonContent(await binanceClient.getOpenOrders(symbol))
);

server.registerTool(
  "create_limit_order",
  {
    title: "Tạo lệnh limit có bảo vệ",
    description:
      "Tạo lệnh vào limit kèm stop loss và take profit bắt buộc. Mặc định bị khóa cho đến khi cấu hình rủi ro cho phép giao dịch.",
    inputSchema: {
      symbol: z.string().min(1),
      side: sideSchema,
      quantity: z.number().positive(),
      price: z.number().positive(),
      stopLossPrice: z.number().positive(),
      takeProfitPrice: z.number().positive(),
      leverage: z.number().int().positive().optional()
    }
  },
  async ({
    symbol,
    side,
    quantity,
    price,
    stopLossPrice,
    takeProfitPrice,
    leverage
  }) =>
    jsonContent(
      await orderExecutor.executeProtectedTrade({
        symbol,
        side,
        quantity,
        entryPrice: price,
        stopLossPrice,
        takeProfitPrice,
        leverage: leverage ?? settingsService.get().maxLeverage,
        source: "mcp"
      })
    )
);

server.registerTool(
  "create_stop_loss_order",
  {
    title: "Tạo lệnh stop loss",
    description:
      "Tạo lệnh STOP_MARKET để đóng vị thế. Mặc định bị khóa cho đến khi cấu hình rủi ro cho phép giao dịch.",
    inputSchema: {
      symbol: z.string().min(1),
      side: sideSchema,
      stopPrice: z.number().positive()
    }
  },
  async ({ symbol, side, stopPrice }) =>
    jsonContent(await orderExecutor.createStopLossOrder(symbol, side, stopPrice))
);

server.registerTool(
  "create_take_profit_order",
  {
    title: "Tạo lệnh take profit",
    description:
      "Tạo lệnh TAKE_PROFIT_MARKET để đóng vị thế. Mặc định bị khóa cho đến khi cấu hình rủi ro cho phép giao dịch.",
    inputSchema: {
      symbol: z.string().min(1),
      side: sideSchema,
      takeProfitPrice: z.number().positive()
    }
  },
  async ({ symbol, side, takeProfitPrice }) =>
    jsonContent(
      await orderExecutor.createTakeProfitOrder(symbol, side, takeProfitPrice)
    )
);

server.registerTool(
  "cancel_order",
  {
    title: "Hủy lệnh",
    description:
      "Hủy một lệnh Binance USD-M Futures. Bị chặn bởi READ_ONLY và danh sách symbol cho phép.",
    inputSchema: {
      symbol: z.string().min(1),
      orderId: z.union([z.string(), z.number()])
    }
  },
  async ({ symbol, orderId }) =>
    jsonContent(await orderExecutor.cancelOrder(symbol, orderId))
);

server.registerTool(
  "close_position",
  {
    title: "Đóng vị thế",
    description:
      "Đóng vị thế đang mở bằng lệnh reduce-only. Bị chặn bởi READ_ONLY và danh sách symbol cho phép.",
    inputSchema: { symbol: z.string().min(1) }
  },
  async ({ symbol }) => jsonContent(await orderExecutor.closePosition(symbol, "mcp"))
);

const transport = new StdioServerTransport();
await server.connect(transport);
