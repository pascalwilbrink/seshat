/**
 * Generates an argon2id hash for ADMIN_PASSWORD_HASH.
 * The password is read from the terminal without echo, or from stdin when piped. It is never taken from
 * the command line. Only the hash goes to stdout; prompts go to stderr.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { MAX_PASSWORD_LENGTH, MIN_NEW_PASSWORD_LENGTH, hashPassword } from '../src/auth/password-hash.js';

async function readPiped(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

function promptHidden(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    console.error('Do not pass the password as an argument. Run without arguments and type it when prompted, or pipe it on stdin.');
    process.exit(1);
  }
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('Admin password: ');
    if (password !== (await promptHidden('Repeat password: '))) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_NEW_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    console.error(`The password must be ${MIN_NEW_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
}

main().catch(() => {
  console.error('Could not generate a hash.');
  process.exit(1);
});
