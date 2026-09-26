// Runs the API server (watch mode) and the Vite dev server side by side.
import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['--watch', 'server/index.ts'], { stdio: 'inherit', env: { ...process.env, FIPS_UI_DEV: '1' } }),
  spawn('npm', ['--prefix', 'web', 'run', 'dev', '--', '--host', process.env.FIPS_UI_DEV_HOST ?? '127.0.0.1'], { stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) stop(); });
