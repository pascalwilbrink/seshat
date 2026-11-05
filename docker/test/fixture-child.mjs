// Fixture child: argv[2] = mode, argv[3] = marker directory, argv[4] = name.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
const [, , mode, dir, name] = process.argv;
const mark = (what) => appendFileSync(path.join(dir, `${name}.log`), `${what}\n`);
mark(`started port=${process.env.PORT ?? ''}`);
if (mode === 'serve' || mode === 'ignore-term') {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    mark('SIGTERM');
    if (mode === 'serve') process.exit(0);
  });
  process.on('SIGINT', () => {
    mark('SIGINT');
    if (mode === 'serve') process.exit(0);
  });
} else if (mode.startsWith('exit:')) {
  setTimeout(() => process.exit(Number(mode.slice(5))), 200);
}
