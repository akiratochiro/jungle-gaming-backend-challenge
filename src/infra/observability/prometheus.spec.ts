import { describe, expect, it } from 'bun:test';
import { Registry } from './prometheus';

describe('Prometheus registry', () => {
  it('renders a counter with HELP/TYPE and label series', async () => {
    const reg = new Registry();
    const c = reg.counter('things_total', 'Things done', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' });
    c.inc({ kind: 'b' }, 3);

    const out = await reg.render();
    expect(out).toContain('# HELP things_total Things done');
    expect(out).toContain('# TYPE things_total counter');
    expect(out).toContain('things_total{kind="a"} 2');
    expect(out).toContain('things_total{kind="b"} 3');
  });

  it('a label-less counter exposes a zero series before any increment', async () => {
    const reg = new Registry();
    reg.counter('replays_total', 'Replays');
    expect(await reg.render()).toContain('replays_total 0');
  });

  it('renders a histogram with cumulative buckets, _sum and _count', async () => {
    const reg = new Registry();
    const h = reg.histogram('lat_seconds', 'Latency', [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.2);
    h.observe(2);

    const out = await reg.render();
    expect(out).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('lat_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('lat_seconds_bucket{le="1"} 2');
    expect(out).toContain('lat_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('lat_seconds_count 3');
    expect(out).toContain('lat_seconds_sum 2.25');
  });

  it('a gauge evaluates its collector at render time', async () => {
    const reg = new Registry();
    let backing = 7;
    const g = reg.gauge('pending', 'Pending items');
    g.collect(() => backing);
    expect(await reg.render()).toContain('pending 7');
    backing = 2;
    expect(await reg.render()).toContain('pending 2');
  });

  it('escapes quotes and backslashes in label values', async () => {
    const reg = new Registry();
    reg.counter('e_total', 'E', ['reason']).inc({ reason: 'a "b" \\ c' });
    expect(await reg.render()).toContain('e_total{reason="a \\"b\\" \\\\ c"} 1');
  });
});
