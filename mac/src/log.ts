export function log(scope: string, message: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${scope}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}
