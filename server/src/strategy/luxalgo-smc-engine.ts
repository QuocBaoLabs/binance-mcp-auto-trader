/*
  LuxAlgo Smart Money Concepts [SMC] - TypeScript engine port

  Source attribution:
  - Original Pine Script: Smart Money Concepts [LuxAlgo]
  - Author: LuxAlgo
  - License in the uploaded source: CC BY-NC-SA 4.0

  Scope:
  - This is a calculation engine for bots/servers, not a TradingView drawing layer.
  - It preserves the Pine execution order, pivot confirmation delay, ATR/RMA, crossover/crossunder,
    internal/swing BOS & CHoCH, EQH/EQL, Order Blocks, Premium/Discount zones, and same-timeframe FVG.
  - For exact higher-timeframe FVG parity with `request.security(..., lookahead = barmerge.lookahead_on)`,
    pass `fvgSecurity` values on each candle. Otherwise same-timeframe FVG is used when `fairValueGapsTimeframe` is empty.
*/

export type StructureFilter = 'All' | 'BOS' | 'CHoCH';
export type OrderBlockFilter = 'Atr' | 'Cumulative Mean Range';
export type OrderBlockMitigation = 'Close' | 'High/Low';
export type Bias = 1 | -1;
export type Leg = 1 | 0;
export type StructureTag = 'BOS' | 'CHoCH';
export type Scope = 'internal' | 'swing';

export interface Candle {
  /** Unix time in milliseconds. Keep it identical to TradingView candle open time if you compare outputs. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Optional values that emulate Pine `request.security()` for FVG MTF mode. */
  fvgSecurity?: FvgSecurityValues;
}

export interface FvgSecurityValues {
  lastClose: number;   // close[1] from selected FVG timeframe
  lastOpen: number;    // open[1] from selected FVG timeframe
  lastTime: number;    // time[1] from selected FVG timeframe
  currentHigh: number; // high[0] from selected FVG timeframe
  currentLow: number;  // low[0] from selected FVG timeframe
  currentTime: number; // time[0] from selected FVG timeframe
  last2High: number;   // high[2] from selected FVG timeframe
  last2Low: number;    // low[2] from selected FVG timeframe
  newTimeframe: boolean; // equivalent to `timeframe.change(fairValueGapsTimeframeInput)`
}

export interface SmcSettings {
  showTrend?: boolean;

  showInternals?: boolean;
  showInternalBull?: StructureFilter;
  showInternalBear?: StructureFilter;
  internalFilterConfluence?: boolean;

  showStructure?: boolean;
  showSwingBull?: StructureFilter;
  showSwingBear?: StructureFilter;
  swingsLength?: number;
  showHighLowSwings?: boolean;
  showPremiumDiscountZones?: boolean;

  showInternalOrderBlocks?: boolean;
  internalOrderBlocksSize?: number;
  showSwingOrderBlocks?: boolean;
  swingOrderBlocksSize?: number;
  orderBlockFilter?: OrderBlockFilter;
  orderBlockMitigation?: OrderBlockMitigation;

  showEqualHighsLows?: boolean;
  equalHighsLowsLength?: number;
  equalHighsLowsThreshold?: number;

  showFairValueGaps?: boolean;
  fairValueGapsThreshold?: boolean;
  /** Empty string means chart timeframe, matching the Pine default. */
  fairValueGapsTimeframe?: string;
  fairValueGapsExtend?: number;

  /** Pine uses `ta.atr(200)` in this script. Keep 200 unless you intentionally fork the indicator. */
  atrLength?: number;
}

export interface Alerts {
  internalBullishBOS: boolean;
  internalBearishBOS: boolean;
  internalBullishCHoCH: boolean;
  internalBearishCHoCH: boolean;
  swingBullishBOS: boolean;
  swingBearishBOS: boolean;
  swingBullishCHoCH: boolean;
  swingBearishCHoCH: boolean;
  internalBullishOrderBlock: boolean;
  internalBearishOrderBlock: boolean;
  swingBullishOrderBlock: boolean;
  swingBearishOrderBlock: boolean;
  equalHighs: boolean;
  equalLows: boolean;
  bullishFairValueGap: boolean;
  bearishFairValueGap: boolean;
}

export interface PivotSnapshot {
  currentLevel: number | null;
  lastLevel: number | null;
  crossed: boolean;
  barTime: number | null;
  barIndex: number | null;
}

export interface TrailingExtremesSnapshot {
  top: number | null;
  bottom: number | null;
  barTime: number | null;
  barIndex: number | null;
  lastTopTime: number | null;
  lastBottomTime: number | null;
}

export interface OrderBlockSnapshot {
  barHigh: number;
  barLow: number;
  barTime: number;
  barIndex: number;
  bias: Bias;
  scope: Scope;
}

export interface FairValueGapSnapshot {
  top: number;
  bottom: number;
  middle: number;
  bias: Bias;
  leftTime: number;
  rightTime: number;
  detectedIndex: number;
}

export interface ZoneSnapshot {
  premium: { top: number; bottom: number };
  equilibrium: { top: number; bottom: number; level: number };
  discount: { top: number; bottom: number };
}

export type SmcEvent =
  | {
      kind: 'structure';
      scope: Scope;
      direction: 'bullish' | 'bearish';
      tag: StructureTag;
      level: number;
      pivotIndex: number;
      pivotTime: number;
      index: number;
      time: number;
      visible: boolean;
    }
  | {
      kind: 'orderBlockCreated';
      scope: Scope;
      bias: Bias;
      barHigh: number;
      barLow: number;
      barIndex: number;
      barTime: number;
      index: number;
      time: number;
    }
  | {
      kind: 'orderBlockMitigated';
      scope: Scope;
      bias: Bias;
      barHigh: number;
      barLow: number;
      barIndex: number;
      barTime: number;
      index: number;
      time: number;
    }
  | {
      kind: 'equalHighLow';
      type: 'EQH' | 'EQL';
      level: number;
      previousLevel: number;
      pivotIndex: number;
      previousPivotIndex: number;
      index: number;
      time: number;
    }
  | {
      kind: 'swingPoint';
      label: 'HH' | 'HL' | 'LH' | 'LL';
      level: number;
      pivotIndex: number;
      pivotTime: number;
      index: number;
      time: number;
    }
  | {
      kind: 'fairValueGap';
      direction: 'bullish' | 'bearish';
      top: number;
      bottom: number;
      middle: number;
      leftTime: number;
      rightTime: number;
      index: number;
      time: number;
    };

export interface SmcOutput {
  index: number;
  time: number;
  atr200: number | null;
  volatilityMeasure: number | null;
  highVolatilityBar: boolean;
  parsedHigh: number;
  parsedLow: number;
  internalTrend: Bias | 0;
  swingTrend: Bias | 0;
  alerts: Alerts;
  events: SmcEvent[];
  pivots: {
    swingHigh: PivotSnapshot;
    swingLow: PivotSnapshot;
    internalHigh: PivotSnapshot;
    internalLow: PivotSnapshot;
    equalHigh: PivotSnapshot;
    equalLow: PivotSnapshot;
  };
  trailing: TrailingExtremesSnapshot;
  zones: ZoneSnapshot | null;
  internalOrderBlocks: OrderBlockSnapshot[];
  swingOrderBlocks: OrderBlockSnapshot[];
  fairValueGaps: FairValueGapSnapshot[];
}

const BULLISH_LEG: Leg = 1;
const BEARISH_LEG: Leg = 0;
const BULLISH: Bias = 1;
const BEARISH: Bias = -1;
const BOS: StructureTag = 'BOS';
const CHOCH: StructureTag = 'CHoCH';

const DEFAULT_SETTINGS: Required<SmcSettings> = {
  showTrend: false,
  showInternals: true,
  showInternalBull: 'All',
  showInternalBear: 'All',
  internalFilterConfluence: false,
  showStructure: true,
  showSwingBull: 'All',
  showSwingBear: 'All',
  swingsLength: 50,
  showHighLowSwings: true,
  showPremiumDiscountZones: false,
  showInternalOrderBlocks: true,
  internalOrderBlocksSize: 5,
  showSwingOrderBlocks: false,
  swingOrderBlocksSize: 5,
  orderBlockFilter: 'Atr',
  orderBlockMitigation: 'High/Low',
  showEqualHighsLows: true,
  equalHighsLowsLength: 3,
  equalHighsLowsThreshold: 0.1,
  showFairValueGaps: false,
  fairValueGapsThreshold: true,
  fairValueGapsTimeframe: '',
  fairValueGapsExtend: 1,
  atrLength: 200,
};

class PivotState {
  currentLevel: number | null = null;
  previousBarCurrentLevel: number | null = null;
  lastLevel: number | null = null;
  crossed = false;
  barTime: number | null = null;
  barIndex: number | null = null;

  snapshot(): PivotSnapshot {
    return {
      currentLevel: this.currentLevel,
      lastLevel: this.lastLevel,
      crossed: this.crossed,
      barTime: this.barTime,
      barIndex: this.barIndex,
    };
  }
}

class TrailingExtremesState {
  top: number | null = null;
  bottom: number | null = null;
  barTime: number | null = null;
  barIndex: number | null = null;
  lastTopTime: number | null = null;
  lastBottomTime: number | null = null;

  snapshot(): TrailingExtremesSnapshot {
    return {
      top: this.top,
      bottom: this.bottom,
      barTime: this.barTime,
      barIndex: this.barIndex,
      lastTopTime: this.lastTopTime,
      lastBottomTime: this.lastBottomTime,
    };
  }
}

interface OrderBlockState {
  barHigh: number;
  barLow: number;
  barTime: number;
  barIndex: number;
  bias: Bias;
}

interface FairValueGapState {
  top: number;
  bottom: number;
  middle: number;
  bias: Bias;
  leftTime: number;
  rightTime: number;
  detectedIndex: number;
}

function emptyAlerts(): Alerts {
  return {
    internalBullishBOS: false,
    internalBearishBOS: false,
    internalBullishCHoCH: false,
    internalBearishCHoCH: false,
    swingBullishBOS: false,
    swingBearishBOS: false,
    swingBullishCHoCH: false,
    swingBearishCHoCH: false,
    internalBullishOrderBlock: false,
    internalBearishOrderBlock: false,
    swingBullishOrderBlock: false,
    swingBearishOrderBlock: false,
    equalHighs: false,
    equalLows: false,
    bullishFairValueGap: false,
    bearishFairValueGap: false,
  };
}

function assertFiniteCandle(candle: Candle): void {
  for (const key of ['time', 'open', 'high', 'low', 'close'] as const) {
    if (!Number.isFinite(candle[key])) {
      throw new Error(`Invalid candle: ${key} must be finite. Got ${candle[key]}`);
    }
  }
  if (candle.high < candle.low) {
    throw new Error(`Invalid candle at ${candle.time}: high < low`);
  }
}

function maxInRange(values: number[], fromInclusive: number, toExclusive: number): number | null {
  if (fromInclusive < 0 || toExclusive > values.length || fromInclusive >= toExclusive) return null;
  let max = -Infinity;
  for (let i = fromInclusive; i < toExclusive; i++) max = Math.max(max, values[i]);
  return max;
}

function minInRange(values: number[], fromInclusive: number, toExclusive: number): number | null {
  if (fromInclusive < 0 || toExclusive > values.length || fromInclusive >= toExclusive) return null;
  let min = Infinity;
  for (let i = fromInclusive; i < toExclusive; i++) min = Math.min(min, values[i]);
  return min;
}

function firstIndexOfMax(values: number[], fromInclusive: number, toExclusive: number): number | null {
  if (fromInclusive < 0 || toExclusive > values.length || fromInclusive >= toExclusive) return null;
  let max = -Infinity;
  let index = fromInclusive;
  for (let i = fromInclusive; i < toExclusive; i++) {
    if (values[i] > max) {
      max = values[i];
      index = i;
    }
  }
  return index;
}

function firstIndexOfMin(values: number[], fromInclusive: number, toExclusive: number): number | null {
  if (fromInclusive < 0 || toExclusive > values.length || fromInclusive >= toExclusive) return null;
  let min = Infinity;
  let index = fromInclusive;
  for (let i = fromInclusive; i < toExclusive; i++) {
    if (values[i] < min) {
      min = values[i];
      index = i;
    }
  }
  return index;
}

function includeByFilter(filter: StructureFilter, tag: StructureTag): boolean {
  return filter === 'All' || filter === tag;
}

export class LuxAlgoSmcEngine {
  public readonly settings: Required<SmcSettings>;

  private bars: Candle[] = [];
  private parsedHighs: number[] = [];
  private parsedLows: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private times: number[] = [];
  private trueRanges: number[] = [];

  private atrRma: number | null = null;
  private cumulativeTrueRange = 0;
  private fvgCumulativeAbsDelta = 0;

  private legByCallSite: Record<'swing' | 'internal' | 'equal', Leg> = {
    swing: BEARISH_LEG,
    internal: BEARISH_LEG,
    equal: BEARISH_LEG,
  };

  private swingHigh = new PivotState();
  private swingLow = new PivotState();
  private internalHigh = new PivotState();
  private internalLow = new PivotState();
  private equalHigh = new PivotState();
  private equalLow = new PivotState();
  private trailing = new TrailingExtremesState();

  private swingTrend: Bias | 0 = 0;
  private internalTrend: Bias | 0 = 0;

  private swingOrderBlocks: OrderBlockState[] = [];
  private internalOrderBlocks: OrderBlockState[] = [];
  private fairValueGaps: FairValueGapState[] = [];

  private currentAlerts: Alerts = emptyAlerts();
  private currentEvents: SmcEvent[] = [];

  constructor(settings: SmcSettings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    if (this.settings.swingsLength < 1) throw new Error('swingsLength must be >= 1');
    if (this.settings.equalHighsLowsLength < 1) throw new Error('equalHighsLowsLength must be >= 1');
    if (this.settings.atrLength < 1) throw new Error('atrLength must be >= 1');
  }

  /** Process one closed candle. Feed candles in the same order as TradingView displays them. */
  update(candle: Candle): SmcOutput {
    assertFiniteCandle(candle);
    const index = this.bars.length;
    if (index > 0 && candle.time < this.bars[index - 1].time) {
      throw new Error('Candles must be in ascending time order.');
    }

    this.snapshotPreviousBarPivotLevels();
    this.currentAlerts = emptyAlerts();
    this.currentEvents = [];

    this.bars.push(candle);
    this.highs.push(candle.high);
    this.lows.push(candle.low);
    this.times.push(candle.time);

    const tr = this.trueRange(index);
    this.trueRanges.push(tr);
    this.cumulativeTrueRange += tr;
    const atr = this.updateAtr(tr);

    const cumulativeMeanRange = index === 0 ? Infinity : this.cumulativeTrueRange / index;
    const volatilityMeasure = this.settings.orderBlockFilter === 'Atr' ? atr : cumulativeMeanRange;
    const highVolatilityBar = volatilityMeasure !== null && (candle.high - candle.low) >= 2 * volatilityMeasure;
    const parsedHigh = highVolatilityBar ? candle.low : candle.high;
    const parsedLow = highVolatilityBar ? candle.high : candle.low;

    this.parsedHighs.push(parsedHigh);
    this.parsedLows.push(parsedLow);

    let zones: ZoneSnapshot | null = null;
    if (this.settings.showHighLowSwings || this.settings.showPremiumDiscountZones) {
      this.updateTrailingExtremes(candle);
      if (this.settings.showPremiumDiscountZones) zones = this.computePremiumDiscountZones();
    }

    if (this.settings.showFairValueGaps) {
      this.deleteFairValueGaps(candle);
    }

    this.getCurrentStructure(this.settings.swingsLength, false, false, index, atr);
    this.getCurrentStructure(5, false, true, index, atr);

    if (this.settings.showEqualHighsLows) {
      this.getCurrentStructure(this.settings.equalHighsLowsLength, true, false, index, atr);
    }

    if (this.settings.showInternals || this.settings.showInternalOrderBlocks || this.settings.showTrend) {
      this.displayStructure(true, index);
    }

    if (this.settings.showStructure || this.settings.showSwingOrderBlocks || this.settings.showHighLowSwings) {
      this.displayStructure(false, index);
    }

    if (this.settings.showInternalOrderBlocks) {
      this.deleteOrderBlocks(true, candle, index);
    }

    if (this.settings.showSwingOrderBlocks) {
      this.deleteOrderBlocks(false, candle, index);
    }

    if (this.settings.showFairValueGaps) {
      this.drawFairValueGaps(candle, index);
    }

    return {
      index,
      time: candle.time,
      atr200: atr,
      volatilityMeasure: volatilityMeasure === Infinity ? null : volatilityMeasure,
      highVolatilityBar,
      parsedHigh,
      parsedLow,
      internalTrend: this.internalTrend,
      swingTrend: this.swingTrend,
      alerts: { ...this.currentAlerts },
      events: [...this.currentEvents],
      pivots: {
        swingHigh: this.swingHigh.snapshot(),
        swingLow: this.swingLow.snapshot(),
        internalHigh: this.internalHigh.snapshot(),
        internalLow: this.internalLow.snapshot(),
        equalHigh: this.equalHigh.snapshot(),
        equalLow: this.equalLow.snapshot(),
      },
      trailing: this.trailing.snapshot(),
      zones,
      internalOrderBlocks: this.internalOrderBlocks.map((ob) => ({ ...ob, scope: 'internal' as const })),
      swingOrderBlocks: this.swingOrderBlocks.map((ob) => ({ ...ob, scope: 'swing' as const })),
      fairValueGaps: this.fairValueGaps.map((fvg) => ({ ...fvg })),
    };
  }

  /** Convenience helper for historical candles. */
  calculate(candles: Candle[]): SmcOutput[] {
    return candles.map((candle) => this.update(candle));
  }

  private snapshotPreviousBarPivotLevels(): void {
    for (const pivot of [
      this.swingHigh,
      this.swingLow,
      this.internalHigh,
      this.internalLow,
      this.equalHigh,
      this.equalLow,
    ]) {
      pivot.previousBarCurrentLevel = pivot.currentLevel;
    }
  }

  private trueRange(index: number): number {
    const current = this.bars[index];
    if (index === 0) return current.high - current.low;
    const prevClose = this.bars[index - 1].close;
    return Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
  }

  /** Pine `ta.atr(length)` is `ta.rma(ta.tr(true), length)`. */
  private updateAtr(tr: number): number | null {
    const length = this.settings.atrLength;
    if (this.atrRma === null) {
      if (this.trueRanges.length < length) return null;
      if (this.trueRanges.length === length) {
        const sum = this.trueRanges.slice(-length).reduce((acc, value) => acc + value, 0);
        this.atrRma = sum / length;
        return this.atrRma;
      }
    }
    this.atrRma = ((this.atrRma as number) * (length - 1) + tr) / length;
    return this.atrRma;
  }

  /**
   * Pine equivalent:
   *   newLegHigh = high[size] > ta.highest(size)
   *   newLegLow  = low[size]  < ta.lowest(size)
   *
   * Important: `ta.highest(size)` is the window from current bar back `size - 1` bars,
   * so the candidate bar is exactly one bar before that window: `index - size`.
   */
  private updateLeg(callSite: 'swing' | 'internal' | 'equal', size: number, index: number): { leg: Leg; change: number } {
    const previousLeg = this.legByCallSite[callSite];
    let nextLeg: Leg = previousLeg;

    if (index >= size) {
      const candidateIndex = index - size;
      const candidateHigh = this.highs[candidateIndex];
      const candidateLow = this.lows[candidateIndex];
      const futureHighest = maxInRange(this.highs, candidateIndex + 1, index + 1);
      const futureLowest = minInRange(this.lows, candidateIndex + 1, index + 1);

      const newLegHigh = futureHighest !== null && candidateHigh > futureHighest;
      const newLegLow = futureLowest !== null && candidateLow < futureLowest;

      if (newLegHigh) nextLeg = BEARISH_LEG;
      else if (newLegLow) nextLeg = BULLISH_LEG;
    }

    this.legByCallSite[callSite] = nextLeg;
    return { leg: nextLeg, change: nextLeg - previousLeg };
  }

  private getCurrentStructure(size: number, equalHighLow: boolean, internal: boolean, index: number, atrMeasure: number | null): void {
    const callSite: 'swing' | 'internal' | 'equal' = equalHighLow ? 'equal' : internal ? 'internal' : 'swing';
    const { change } = this.updateLeg(callSite, size, index);
    if (change === 0 || index < size) return;

    const pivotIndex = index - size;
    const pivotCandle = this.bars[pivotIndex];

    // startOfBullishLeg(currentLeg) => ta.change(leg) == +1 => pivot low
    if (change === 1) {
      const pivot = equalHighLow ? this.equalLow : internal ? this.internalLow : this.swingLow;

      if (
        equalHighLow &&
        pivot.currentLevel !== null &&
        pivot.barIndex !== null &&
        atrMeasure !== null &&
        Math.abs(pivot.currentLevel - pivotCandle.low) < this.settings.equalHighsLowsThreshold * atrMeasure
      ) {
        this.currentAlerts.equalLows = true;
        this.currentEvents.push({
          kind: 'equalHighLow',
          type: 'EQL',
          level: pivotCandle.low,
          previousLevel: pivot.currentLevel,
          pivotIndex,
          previousPivotIndex: pivot.barIndex,
          index,
          time: this.bars[index].time,
        });
      }

      const previousCurrent = pivot.currentLevel;
      pivot.lastLevel = previousCurrent;
      pivot.currentLevel = pivotCandle.low;
      pivot.crossed = false;
      pivot.barTime = pivotCandle.time;
      pivot.barIndex = pivotIndex;

      if (!equalHighLow && !internal) {
        this.trailing.bottom = pivot.currentLevel;
        this.trailing.barTime = pivot.barTime;
        this.trailing.barIndex = pivot.barIndex;
        this.trailing.lastBottomTime = pivot.barTime;

        const label: 'LL' | 'HL' = previousCurrent !== null && pivot.currentLevel < previousCurrent ? 'LL' : 'HL';
        this.currentEvents.push({
          kind: 'swingPoint',
          label,
          level: pivot.currentLevel,
          pivotIndex,
          pivotTime: pivotCandle.time,
          index,
          time: this.bars[index].time,
        });
      }
    }

    // startOfBearishLeg(currentLeg) => ta.change(leg) == -1 => pivot high
    if (change === -1) {
      const pivot = equalHighLow ? this.equalHigh : internal ? this.internalHigh : this.swingHigh;

      if (
        equalHighLow &&
        pivot.currentLevel !== null &&
        pivot.barIndex !== null &&
        atrMeasure !== null &&
        Math.abs(pivot.currentLevel - pivotCandle.high) < this.settings.equalHighsLowsThreshold * atrMeasure
      ) {
        this.currentAlerts.equalHighs = true;
        this.currentEvents.push({
          kind: 'equalHighLow',
          type: 'EQH',
          level: pivotCandle.high,
          previousLevel: pivot.currentLevel,
          pivotIndex,
          previousPivotIndex: pivot.barIndex,
          index,
          time: this.bars[index].time,
        });
      }

      const previousCurrent = pivot.currentLevel;
      pivot.lastLevel = previousCurrent;
      pivot.currentLevel = pivotCandle.high;
      pivot.crossed = false;
      pivot.barTime = pivotCandle.time;
      pivot.barIndex = pivotIndex;

      if (!equalHighLow && !internal) {
        this.trailing.top = pivot.currentLevel;
        this.trailing.barTime = pivot.barTime;
        this.trailing.barIndex = pivot.barIndex;
        this.trailing.lastTopTime = pivot.barTime;

        const label: 'HH' | 'LH' = previousCurrent !== null && pivot.currentLevel > previousCurrent ? 'HH' : 'LH';
        this.currentEvents.push({
          kind: 'swingPoint',
          label,
          level: pivot.currentLevel,
          pivotIndex,
          pivotTime: pivotCandle.time,
          index,
          time: this.bars[index].time,
        });
      }
    }
  }

  private displayStructure(internal: boolean, index: number): void {
    const candle = this.bars[index];
    const previousClose = index > 0 ? this.bars[index - 1].close : null;

    let bullishBar = true;
    let bearishBar = true;

    if (this.settings.internalFilterConfluence) {
      // This intentionally mirrors the uploaded Pine exactly:
      // bullishBar := high - math.max(close, open) > math.min(close, open - low)
      // bearishBar := high - math.max(close, open) < math.min(close, open - low)
      const left = candle.high - Math.max(candle.close, candle.open);
      const right = Math.min(candle.close, candle.open - candle.low);
      bullishBar = left > right;
      bearishBar = left < right;
    }

    const highPivot = internal ? this.internalHigh : this.swingHigh;
    const lowPivot = internal ? this.internalLow : this.swingLow;

    const bullishExtraCondition = internal
      ? this.internalHigh.currentLevel !== null &&
        this.swingHigh.currentLevel !== null &&
        this.internalHigh.currentLevel !== this.swingHigh.currentLevel &&
        bullishBar
      : true;

    if (this.crossover(candle.close, previousClose, highPivot.currentLevel, highPivot.previousBarCurrentLevel) && !highPivot.crossed && bullishExtraCondition) {
      const tag: StructureTag = (internal ? this.internalTrend : this.swingTrend) === BEARISH ? CHOCH : BOS;

      if (internal) {
        this.currentAlerts.internalBullishCHoCH = tag === CHOCH;
        this.currentAlerts.internalBullishBOS = tag === BOS;
        this.internalTrend = BULLISH;
      } else {
        this.currentAlerts.swingBullishCHoCH = tag === CHOCH;
        this.currentAlerts.swingBullishBOS = tag === BOS;
        this.swingTrend = BULLISH;
      }

      highPivot.crossed = true;

      const visible = internal
        ? this.settings.showInternals && includeByFilter(this.settings.showInternalBull, tag)
        : this.settings.showStructure && includeByFilter(this.settings.showSwingBull, tag);

      this.currentEvents.push({
        kind: 'structure',
        scope: internal ? 'internal' : 'swing',
        direction: 'bullish',
        tag,
        level: highPivot.currentLevel as number,
        pivotIndex: highPivot.barIndex as number,
        pivotTime: highPivot.barTime as number,
        index,
        time: candle.time,
        visible,
      });

      if ((internal && this.settings.showInternalOrderBlocks) || (!internal && this.settings.showSwingOrderBlocks)) {
        this.storeOrderBlock(highPivot, internal, BULLISH, index);
      }
    }

    const bearishExtraCondition = internal
      ? this.internalLow.currentLevel !== null &&
        this.swingLow.currentLevel !== null &&
        this.internalLow.currentLevel !== this.swingLow.currentLevel &&
        bearishBar
      : true;

    if (this.crossunder(candle.close, previousClose, lowPivot.currentLevel, lowPivot.previousBarCurrentLevel) && !lowPivot.crossed && bearishExtraCondition) {
      const tag: StructureTag = (internal ? this.internalTrend : this.swingTrend) === BULLISH ? CHOCH : BOS;

      if (internal) {
        this.currentAlerts.internalBearishCHoCH = tag === CHOCH;
        this.currentAlerts.internalBearishBOS = tag === BOS;
        this.internalTrend = BEARISH;
      } else {
        this.currentAlerts.swingBearishCHoCH = tag === CHOCH;
        this.currentAlerts.swingBearishBOS = tag === BOS;
        this.swingTrend = BEARISH;
      }

      lowPivot.crossed = true;

      const visible = internal
        ? this.settings.showInternals && includeByFilter(this.settings.showInternalBear, tag)
        : this.settings.showStructure && includeByFilter(this.settings.showSwingBear, tag);

      this.currentEvents.push({
        kind: 'structure',
        scope: internal ? 'internal' : 'swing',
        direction: 'bearish',
        tag,
        level: lowPivot.currentLevel as number,
        pivotIndex: lowPivot.barIndex as number,
        pivotTime: lowPivot.barTime as number,
        index,
        time: candle.time,
        visible,
      });

      if ((internal && this.settings.showInternalOrderBlocks) || (!internal && this.settings.showSwingOrderBlocks)) {
        this.storeOrderBlock(lowPivot, internal, BEARISH, index);
      }
    }
  }

  private crossover(currentClose: number, previousClose: number | null, currentLevel: number | null, previousLevel: number | null): boolean {
    return currentLevel !== null && previousClose !== null && previousLevel !== null && currentClose > currentLevel && previousClose <= previousLevel;
  }

  private crossunder(currentClose: number, previousClose: number | null, currentLevel: number | null, previousLevel: number | null): boolean {
    return currentLevel !== null && previousClose !== null && previousLevel !== null && currentClose < currentLevel && previousClose >= previousLevel;
  }

  private storeOrderBlock(pivot: PivotState, internal: boolean, bias: Bias, index: number): void {
    if (pivot.barIndex === null) return;
    const from = pivot.barIndex;
    const to = index; // Pine array.slice(pivot.barIndex, bar_index) excludes current bar.
    const parsedIndex = bias === BEARISH
      ? firstIndexOfMax(this.parsedHighs, from, to)
      : firstIndexOfMin(this.parsedLows, from, to);

    if (parsedIndex === null) return;

    const orderBlock: OrderBlockState = {
      barHigh: this.parsedHighs[parsedIndex],
      barLow: this.parsedLows[parsedIndex],
      barTime: this.times[parsedIndex],
      barIndex: parsedIndex,
      bias,
    };

    const blocks = internal ? this.internalOrderBlocks : this.swingOrderBlocks;
    if (blocks.length >= 100) blocks.pop();
    blocks.unshift(orderBlock);

    this.currentEvents.push({
      kind: 'orderBlockCreated',
      scope: internal ? 'internal' : 'swing',
      bias,
      barHigh: orderBlock.barHigh,
      barLow: orderBlock.barLow,
      barIndex: orderBlock.barIndex,
      barTime: orderBlock.barTime,
      index,
      time: this.bars[index].time,
    });
  }

  private deleteOrderBlocks(internal: boolean, candle: Candle, index: number): void {
    const blocks = internal ? this.internalOrderBlocks : this.swingOrderBlocks;
    const bearishMitigationSource = this.settings.orderBlockMitigation === 'Close' ? candle.close : candle.high;
    const bullishMitigationSource = this.settings.orderBlockMitigation === 'Close' ? candle.close : candle.low;

    // Iterate backwards to avoid skipping adjacent mitigated blocks after removal.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      let crossed = false;

      if (bearishMitigationSource > block.barHigh && block.bias === BEARISH) {
        crossed = true;
        if (internal) this.currentAlerts.internalBearishOrderBlock = true;
        else this.currentAlerts.swingBearishOrderBlock = true;
      } else if (bullishMitigationSource < block.barLow && block.bias === BULLISH) {
        crossed = true;
        if (internal) this.currentAlerts.internalBullishOrderBlock = true;
        else this.currentAlerts.swingBullishOrderBlock = true;
      }

      if (crossed) {
        const [removed] = blocks.splice(i, 1);
        this.currentEvents.push({
          kind: 'orderBlockMitigated',
          scope: internal ? 'internal' : 'swing',
          bias: removed.bias,
          barHigh: removed.barHigh,
          barLow: removed.barLow,
          barIndex: removed.barIndex,
          barTime: removed.barTime,
          index,
          time: candle.time,
        });
      }
    }
  }

  private updateTrailingExtremes(candle: Candle): void {
    if (this.trailing.top !== null) {
      if (candle.high >= this.trailing.top) {
        this.trailing.top = candle.high;
        this.trailing.lastTopTime = candle.time;
      }
    }

    if (this.trailing.bottom !== null) {
      if (candle.low <= this.trailing.bottom) {
        this.trailing.bottom = candle.low;
        this.trailing.lastBottomTime = candle.time;
      }
    }
  }

  private computePremiumDiscountZones(): ZoneSnapshot | null {
    const top = this.trailing.top;
    const bottom = this.trailing.bottom;
    if (top === null || bottom === null) return null;

    const equilibriumLevel = (top + bottom) / 2;
    return {
      premium: {
        top,
        bottom: 0.95 * top + 0.05 * bottom,
      },
      equilibrium: {
        top: 0.525 * top + 0.475 * bottom,
        bottom: 0.525 * bottom + 0.475 * top,
        level: equilibriumLevel,
      },
      discount: {
        top: 0.95 * bottom + 0.05 * top,
        bottom,
      },
    };
  }

  private deleteFairValueGaps(candle: Candle): void {
    for (let i = this.fairValueGaps.length - 1; i >= 0; i--) {
      const fvg = this.fairValueGaps[i];
      if ((candle.low < fvg.bottom && fvg.bias === BULLISH) || (candle.high > fvg.top && fvg.bias === BEARISH)) {
        this.fairValueGaps.splice(i, 1);
      }
    }
  }

  private drawFairValueGaps(candle: Candle, index: number): void {
    const security = this.resolveFvgSecurity(candle, index);
    if (!security) return;

    const barDeltaPercent = security.lastOpen === 0 ? 0 : (security.lastClose - security.lastOpen) / (security.lastOpen * 100);
    if (security.newTimeframe) this.fvgCumulativeAbsDelta += Math.abs(barDeltaPercent);
    const threshold = this.settings.fairValueGapsThreshold
      ? (index === 0 ? Infinity : (this.fvgCumulativeAbsDelta / index) * 2)
      : 0;

    const bullishFairValueGap =
      security.currentLow > security.last2High &&
      security.lastClose > security.last2High &&
      barDeltaPercent > threshold &&
      security.newTimeframe;

    const bearishFairValueGap =
      security.currentHigh < security.last2Low &&
      security.lastClose < security.last2Low &&
      -barDeltaPercent > threshold &&
      security.newTimeframe;

    if (bullishFairValueGap) {
      this.currentAlerts.bullishFairValueGap = true;
      const top = security.currentLow;
      const bottom = security.last2High;
      this.unshiftFairValueGap(top, bottom, BULLISH, security.lastTime, security.currentTime, index, candle.time, 'bullish');
    }

    if (bearishFairValueGap) {
      this.currentAlerts.bearishFairValueGap = true;
      const top = security.currentHigh;
      const bottom = security.last2Low;
      this.unshiftFairValueGap(top, bottom, BEARISH, security.lastTime, security.currentTime, index, candle.time, 'bearish');
    }
  }

  private resolveFvgSecurity(candle: Candle, index: number): FvgSecurityValues | null {
    if (candle.fvgSecurity) return candle.fvgSecurity;

    // Pine default timeframe input is empty string, meaning chart timeframe.
    // For non-empty FVG timeframe, pass candle.fvgSecurity to emulate request.security lookahead_on exactly.
    if (this.settings.fairValueGapsTimeframe !== '') return null;
    if (index < 2) return null;

    return {
      lastClose: this.bars[index - 1].close,
      lastOpen: this.bars[index - 1].open,
      lastTime: this.bars[index - 1].time,
      currentHigh: this.bars[index].high,
      currentLow: this.bars[index].low,
      currentTime: this.bars[index].time,
      last2High: this.bars[index - 2].high,
      last2Low: this.bars[index - 2].low,
      newTimeframe: true,
    };
  }

  private unshiftFairValueGap(
    top: number,
    bottom: number,
    bias: Bias,
    leftTime: number,
    rightTime: number,
    index: number,
    time: number,
    direction: 'bullish' | 'bearish',
  ): void {
    const middle = (top + bottom) / 2;
    const fvg: FairValueGapState = {
      top,
      bottom,
      middle,
      bias,
      leftTime,
      rightTime,
      detectedIndex: index,
    };
    this.fairValueGaps.unshift(fvg);
    this.currentEvents.push({
      kind: 'fairValueGap',
      direction,
      top,
      bottom,
      middle,
      leftTime,
      rightTime,
      index,
      time,
    });
  }
}

export function calculateLuxAlgoSmc(candles: Candle[], settings: SmcSettings = {}): SmcOutput[] {
  return new LuxAlgoSmcEngine(settings).calculate(candles);
}
