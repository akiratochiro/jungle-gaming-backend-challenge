/**
 * Minimal, dependency-free Prometheus metrics — counters, gauges and
 * histograms rendered in the text exposition format (v0.0.4). The metric set is
 * small and fixed, so a full client library is not warranted (see
 * ARCHITECTURE.md §Observability).
 */

export type Labels = Record<string, string>;

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const entries = Object.entries(labels);
  if (extra) entries.push(extra);
  if (entries.length === 0) return '';
  return (
    '{' +
    entries
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
      .join(',') +
    '}'
  );
}

interface Metric {
  render(): Promise<string> | string;
  reset(): void;
}

export class Counter implements Metric {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: string[] = [],
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = seriesKey(labels);
    const cur = this.series.get(key);
    if (cur) cur.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private value = 0;
  private collector?: () => number | Promise<number>;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(v: number): void {
    this.value = v;
  }
  inc(v = 1): void {
    this.value += v;
  }
  dec(v = 1): void {
    this.value -= v;
  }
  /** Register a callback evaluated at scrape time (e.g. a COUNT query). */
  collect(fn: () => number | Promise<number>): void {
    this.collector = fn;
  }

  reset(): void {
    this.value = 0;
  }

  async render(): Promise<string> {
    let v = this.value;
    if (this.collector) {
      try {
        v = await this.collector();
      } catch {
        v = Number.NaN;
      }
    }
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${v}`].join('\n');
  }
}

export class Histogram implements Metric {
  private readonly buckets: number[];
  private readonly series = new Map<
    string,
    { labels: Labels; cumulative: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
    private readonly labelNames: string[] = [],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = seriesKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, cumulative: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.cumulative[i]! += 1;
    }
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(entry.labels, ['le', String(this.buckets[i])])} ${entry.cumulative[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels(entry.labels, ['le', '+Inf'])} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string): Gauge {
    return this.add(new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets: number[], labelNames: string[] = []): Histogram {
    return this.add(new Histogram(name, help, buckets, labelNames));
  }

  reset(): void {
    for (const m of this.metrics) m.reset();
  }

  async render(): Promise<string> {
    const blocks = await Promise.all(this.metrics.map((m) => m.render()));
    return blocks.join('\n\n') + '\n';
  }

  private add<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
}
