# Cách dùng `luxalgo_smc_engine.ts`

File TypeScript này là bản port logic của LuxAlgo Smart Money Concepts sang engine chạy server/bot. Nó không vẽ label/box như TradingView, mà trả về `events`, `alerts`, `orderBlocks`, `fairValueGaps`, `zones`, `trend` sau mỗi nến.

## Ví dụ dùng nhanh

```ts
import { LuxAlgoSmcEngine, Candle } from './luxalgo-smc-engine';

const engine = new LuxAlgoSmcEngine({
  showInternals: true,
  showStructure: true,
  showInternalOrderBlocks: true,
  showSwingOrderBlocks: false,
  showEqualHighsLows: true,
  showFairValueGaps: false,
});

const candles: Candle[] = [
  // time phải là thời gian mở nến, milliseconds
  // { time: 1710000000000, open: 100, high: 105, low: 98, close: 103 },
];

for (const candle of candles) {
  const out = engine.update(candle);

  if (out.alerts.internalBullishBOS) {
    console.log('Internal Bullish BOS', out.time);
  }

  for (const event of out.events) {
    if (event.kind === 'structure') {
      console.log(event.scope, event.direction, event.tag, event.level);
    }
  }
}
```

## Để không bị lệch TradingView

1. Chỉ feed nến đã đóng nếu bạn so với chart lịch sử. TradingView realtime có thể thay đổi khi nến chưa đóng.
2. `time` nên là thời gian mở nến giống TradingView/Binance kline open time.
3. Cần warm-up đủ dữ liệu, vì Pine dùng `ta.atr(200)`. EQH/EQL dùng ATR nên trước khi ATR đủ 200 nến có thể chưa khớp tín hiệu.
4. Pivot của code này xác nhận trễ đúng theo Pine: swing mặc định trễ `50` nến, internal trễ `5` nến, EQH/EQL trễ `3` nến.
5. Nếu bật FVG timeframe khác chart timeframe, hãy truyền `fvgSecurity` cho mỗi candle để mô phỏng `request.security(..., lookahead_on)`. Nếu không truyền, engine chỉ chạy FVG cùng timeframe.
6. Nếu xuất CSV từ TradingView để đối chiếu, nhớ dùng cùng sàn, cùng symbol, cùng khung thời gian và cùng timezone hiển thị.

## Output quan trọng cho bot

- `out.alerts.*`: tương đương `alertcondition()` trong Pine.
- `out.events`: danh sách sự kiện xảy ra ở nến hiện tại, gồm BOS/CHoCH, OB tạo/mất, EQH/EQL, FVG.
- `out.internalOrderBlocks` và `out.swingOrderBlocks`: các OB còn hiệu lực.
- `out.internalTrend` và `out.swingTrend`: bias cấu trúc hiện tại, `1` là bullish, `-1` là bearish, `0` là chưa xác định.
