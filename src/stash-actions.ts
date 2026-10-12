export type StashAction = 'apply' | 'branch' | 'pop' | 'drop'

// El payload codificado evita interpretar rutas y nombres como código de shell.
// execFileSync pasa todos los argumentos a Git sin interpolarlos en una shell.
export function stashCommand(repo: string, hash: string, action: StashAction, branch = ''): string {
  if (!repo || !/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Repositorio o hash del stash inválido.')
  if (!['apply', 'branch', 'pop', 'drop'].includes(action)) throw new Error('Acción de stash inválida.')
  if (action === 'branch' && !branch.trim()) throw new Error('Escribe un nombre para la nueva rama.')
  const script = `
const { execFileSync } = require('node:child_process');
const repo = ${JSON.stringify(repo)}, hash = ${JSON.stringify(hash)}, action = ${JSON.stringify(action)}, branch = ${JSON.stringify(branch)};
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const ref = () => {
  const entry = git('stash', 'list', '--format=%H %gd').split(/\\r?\\n/).find(line => line.split(' ')[0] === hash);
  if (!entry) throw new Error('El stash ya no existe. Refresca el grafo.');
  return entry.slice(hash.length + 1);
};
try {
  ref();
  if (action === 'branch') {
    git('check-ref-format', '--branch', branch);
    git('checkout', '-b', branch, hash + '^1');
    console.log(git('stash', 'apply', '--index', hash));
    console.log(git('stash', 'drop', ref()));
  } else if (action === 'drop') console.log(git('stash', 'drop', ref()));
  else {
    console.log(git('stash', 'apply', hash));
    if (action === 'pop') console.log(git('stash', 'drop', ref()));
  }
  console.log('Stash: acción completada.');
} catch (error) {
  console.error(error.stderr ? error.stderr.toString() : error.message);
  process.exitCode = 1;
}
`
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(script)))
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
  if (command.length > 4096) throw new Error('El nombre de rama o la ruta son demasiado largos para enviarlos a Orca.')
  return command
}
