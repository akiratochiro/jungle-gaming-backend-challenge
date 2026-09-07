import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

type Child = ReturnType<typeof Bun.spawn>;

interface Instance {
  proc: Child;
  port: number;
  baseUrl: string;
  log: string[];
}

export interface Cluster {
  /** One base URL per running instance. */
  baseUrls: string[];
  /** Round-robin instance selector: `pick(i)` === `baseUrls[i % size]`. */
  pick(i: number): string;
  dumpLogs(): void;
  stop(): Promise<void>;
}

/** Reserve `n` distinct free TCP ports (held open together, then released). */
async function reservePorts(n: number): Promise<number[]> {
  const servers: net.Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const { srv, port } = await new Promise<{ srv: net.Server; port: number }>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve({ srv: s, port: (s.address() as net.AddressInfo).port }));
    });
    servers.push(srv);
    ports.push(port);
  }
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

async function pump(stream: ReadableStream<Uint8Array> | undefined | null, sink: string[]): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.trim()) continue;
        sink.push(line);
        if (sink.length > 400) sink.shift();
      }
    }
  } catch {
    /* stream closed on shutdown */
  }
}

async function waitForReady(baseUrl: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error(`instance ${baseUrl} not ready within ${timeoutMs}ms`);
}

async function stopInstance(inst: Instance): Promise<void> {
  try {
    inst.proc.kill(); // SIGTERM → Nest shutdown hooks
    await Promise.race([
      inst.proc.exited,
      sleep(5_000).then(() => inst.proc.kill(9)),
    ]);
    await inst.proc.exited;
  } catch {
    /* already gone */
  }
}

/**
 * Boots `size` **separate OS processes** of the application (`bun run
 * src/main.ts`), each on its own port, each with its own Nest app / MikroORM
 * pool / EntityManager, all sharing only the same `DATABASE_URL` and LocalStack.
 * Background workers are disabled in the spawned instances so the test isolates
 * the HTTP write path (workers have their own tests).
 */
export async function startCluster(
  size = 3,
  extraEnv: Record<string, string> = {},
): Promise<Cluster> {
  const ports = await reservePorts(size);
  const instances: Instance[] = ports.map((port) => {
    const log: string[] = [];
    const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        SQS_CONSUMER_ENABLED: 'false',
        OUTBOX_RELAY_ENABLED: 'false',
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void pump(proc.stdout as ReadableStream<Uint8Array>, log);
    void pump(proc.stderr as ReadableStream<Uint8Array>, log);
    return { proc, port, baseUrl: `http://127.0.0.1:${port}`, log };
  });

  const cluster: Cluster = {
    baseUrls: instances.map((i) => i.baseUrl),
    pick: (i: number) => instances[Math.abs(i) % instances.length]!.baseUrl,
    dumpLogs: () =>
      instances.forEach((i, idx) =>
        console.error(`\n─── instance ${idx} (:${i.port}) ───\n${i.log.slice(-60).join('\n')}`),
      ),
    stop: async () => {
      await Promise.all(instances.map(stopInstance));
    },
  };

  try {
    await Promise.all(instances.map((i) => waitForReady(i.baseUrl)));
  } catch (e) {
    cluster.dumpLogs();
    await cluster.stop();
    throw e;
  }
  return cluster;
}
