// Every test run gets throwaway homes so nothing can touch the real ~/.tminus, ~/.claude or ~/.codex.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tminus-test-'));
process.env.TMINUS_HOME = join(root, 'tminus');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.CODEX_HOME = join(root, 'codex');
process.env.TMINUS_TEST_ROOT = root;
delete process.env.NO_COLOR;
