/**
 * Single sink every structured log line goes through. Defaults to stdout;
 * tests swap it to capture and assert on the emitted JSON.
 */
export type LogSink = (line: string) => void;

const STDOUT: LogSink = (line) => {
  process.stdout.write(line);
};

let current: LogSink = STDOUT;

export function emitLogLine(line: string): void {
  current(line);
}

export function setLogSink(sink: LogSink): void {
  current = sink;
}

export function resetLogSink(): void {
  current = STDOUT;
}
