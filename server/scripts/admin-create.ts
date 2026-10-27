/**
 * First-run bootstrap: create an administrator account.
 *
 *   npm run admin:create -- --username chief.admin [--name "Chief Admin"]
 *                           [--grant incident_commander@osu-2026 ...] [--password-stdin]
 *
 * The password is asked for twice on the terminal (not echoed), or read from
 * stdin with --password-stdin (for scripted installs). There is no default
 * password anywhere: without one, nothing is created. The account gets the
 * System Administrator position in scope `*`; `--grant` adds operating
 * positions too (useful on a solo laptop where one person is both).
 */
import { openDb } from '../src/db.ts';
import { loadConfig } from '../src/platform/config.ts';
import { createAdmin, createPlatform } from '../src/platform/platform.ts';
import { POSITIONS, type Position } from '../src/types.ts';

function args(argv: string[]) {
  const out: { username?: string; name?: string; grants: string[]; stdin: boolean } = { grants: [], stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--username') out.username = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--grant') out.grants.push(argv[++i] ?? '');
    else if (a === '--password-stdin') out.stdin = true;
    else if (a === '--help' || a === '-h') {
      console.log('npm run admin:create -- --username <name> [--name "<display name>"] [--grant position@scope] [--password-stdin]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function hidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('No terminal to ask for a password: use --password-stdin.');
  process.stdout.write(prompt);
  return new Promise((done) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          done(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.username) throw new Error('Give --username.');
  const grants = opts.grants.map((g) => {
    const [position, scope] = g.split('@');
    if (!(POSITIONS as readonly string[]).includes(position ?? '') || !scope) throw new Error(`--grant must be position@scope, e.g. incident_commander@osu-2026 (got ${g})`);
    return { position: position as Position, scope };
  });
  let password: string;
  if (opts.stdin) password = await readStdin();
  else {
    password = await hidden('Password (12+ characters): ');
    if ((await hidden('Again: ')) !== password) throw new Error('The two passwords differ; nothing was created.');
  }
  const dbPath = process.env.DB_PATH ?? './data/gameday.db';
  const platform = createPlatform(openDb(dbPath), loadConfig(), { dbPath });
  const { userId } = await createAdmin(platform, { username: opts.username, password, displayName: opts.name }, 'cli');
  for (const g of grants) platform.users.grant({ userId, position: g.position, scope: g.scope, grantedBy: 'bootstrap:cli' });
  console.log(`Created administrator ${opts.username} in ${dbPath}${grants.length ? ` with ${grants.map((g) => `${g.position}@${g.scope}`).join(', ')}` : ''}.`);
  console.log('Next: start the server, sign in, and set up two-factor sign-in when asked.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
